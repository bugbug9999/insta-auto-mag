const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');

const { buildAugmentPrompt } = require('./prompts');
const { getDomain, htmlToText, sanitize } = require('./utils');

const fsp = fs.promises;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIN_PHOTO_BYTES = 8 * 1024; // 이보다 작은 이미지는 로고/아이콘으로 간주
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

function createCollector({ store, callClaude }) {
  async function collectForPost(post, options = {}) {
    const updateProgress = typeof options.updateProgress === 'function' ? options.updateProgress : async () => {};
    const paths = store.getPostPaths(post.id);
    const sources = await store.listSources();
    const matchedSourceIds = new Set(Array.isArray(post.sources) ? post.sources : []);
    const imageUrls = [];
    const sourceUrls = [];
    let title = post.title || '';
    let body = post.body || '';
    let transcriptSegments = Array.isArray(post.transcriptSegments) ? post.transcriptSegments : [];
    let fetchFailed = false;

    if (post.inputType === 'url') {
      await updateProgress('URL에서 본문 추출 중...');
      try {
        const result = await collectFromURL(post.input);
        title = result.title || title;
        body = result.body || body;
        transcriptSegments = normalizeTranscriptSegments(result.transcriptSegments);
        imageUrls.push(...result.images);
        sourceUrls.push(result.url);
        const matches = await touchSourcesForUrl(result.url, sources, store);
        matches.forEach((sourceId) => matchedSourceIds.add(sourceId));
      } catch (error) {
        fetchFailed = true;
      }
    }

    const needsAugment =
      post.inputType === 'topic' ||
      fetchFailed ||
      !body ||
      body.trim().length < 120;

    if (needsAugment) {
      await updateProgress('관련 기사 보강검색 중...');
      const registeredDomains = pickRegisteredDomains(post.input, sources);
      const settings = await store.getSettings();
      const augment = await callClaude(buildAugmentPrompt({
        topic: title || post.input,
        registeredDomains,
      }), {
        allowWebSearch: true,
        cliPath: settings.claudePath || undefined,
        apiKey: options.apiKey,
      });

      const articles = Array.isArray(augment.articles)
        ? augment.articles.filter((item) => item && typeof item.url === 'string' && item.url.trim())
        : [];

      if (!articles.length && (post.inputType === 'topic' || fetchFailed)) {
        throw new Error('소재 부족');
      }

      let firstBodyFilled = Boolean(body && body.trim());
      for (const article of articles.slice(0, 5)) {
        await updateProgress(`보강 기사 수집 중: ${article.title || article.url}`);
        try {
          const result = await collectFromURL(article.url);
          sourceUrls.push(result.url);
          imageUrls.push(...result.images);
          const matches = await touchSourcesForUrl(result.url, sources, store);
          matches.forEach((sourceId) => matchedSourceIds.add(sourceId));

          if (!title && result.title) {
            title = result.title;
          }
          if (!firstBodyFilled && result.body) {
            body = result.body;
            firstBodyFilled = true;
          }
        } catch (error) {
          continue;
        }
      }
    }

    if (!body && title) {
      body = title;
    }

    const normalizedImageUrls = uniqueUrls(imageUrls).slice(0, MAX_IMAGES);
    const downloads = await downloadImages(normalizedImageUrls, paths.assetsDir);
    const imageCandidates = downloads.map((item) => ({
      url: item.url,
      localPath: item.localPath,
      selected: false,
      width: item.width,
      height: item.height,
    }));

    const updated = await store.updatePost(post.id, {
      title: title || trimTitle(post.input),
      body,
      transcriptSegments,
      sources: Array.from(matchedSourceIds),
      sourceUrls: uniqueUrls(sourceUrls),
      imageCandidates,
    });

    return updated;
  }

  async function traceUrl(url) {
    return collectFromURL(url);
  }

  async function collectFromURL(url) {
    const hostname = new URL(url).hostname;
    const isInstagram = /(^|\.)instagram\.com$/i.test(hostname);
    const isThreads = /(^|\.)threads\.(com|net)$/i.test(hostname);
    const isMeta = isInstagram || isThreads;

    // X/트위터: 본체는 봇 차단(503) — 공식 syndication API(키 불필요, 검증됨)로 우회
    if (/(^|\.)(twitter\.com|x\.com)$/i.test(hostname)) {
      return collectFromTweet(url);
    }

    // 인스타그램: 로그인 세션이 있으면 캐러셀 전체 미디어+캡션 전문 (실패 시 아래 og 경로로 폴백)
    if (isInstagram) {
      const auth = await fetchInstagramAuthenticated(url);
      if (auth) {
        const mediaImages = auth.media.map((m) => m.imageUrl).filter(Boolean);
        const videoCount = auth.media.filter((m) => m.type === 'video').length;
        return {
          url,
          title: `@${auth.username} 인스타 포스트`,
          body: auth.caption || '',
          ogImage: mediaImages[0] || null,
          ogDescription: auth.caption || '',
          images: mediaImages.slice(0, MAX_IMAGES),
          outboundLinks: extractOutboundLinks('', auth.caption || ''),
          mediaSummary: `이미지 ${auth.mediaCount - videoCount}장${videoCount ? `, 영상 ${videoCount}개` : ''} (캐러셀 ${auth.mediaCount}칸, 로그인 세션으로 전수 확인)`,
          media: auth.media,
          inputType: 'url',
          isInstagram: true,
          isThreads: false,
          authenticated: true,
        };
      }
    }

    // 네이버 블로그: 데스크톱 페이지는 빈 프레임 — 모바일 페이지가 og+본문을 준다(검증됨)
    let fetchTarget = url;
    let extraHeaders;
    if (/^blog\.naver\.com$/i.test(hostname)) {
      fetchTarget = url.replace('//blog.naver.com', '//m.blog.naver.com');
      extraHeaders = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' };
    }
    const isYouTube = /(^|\.)(youtube\.com|youtu\.be)$/i.test(hostname);

    const response = await fetchText(fetchTarget, {
      headers: isMeta ? { 'user-agent': 'facebookexternalhit/1.1' } : extraHeaders,
    });
    const contentType = String(response.contentType || '').toLowerCase();

    if (!contentType.includes('text/html')) {
      throw new Error('비HTML 응답은 수집할 수 없습니다');
    }

    const html = response.text;
    if (isMeta) {
      const title = extractMeta(html, 'og:title') || extractTitleTag(html) || '';
      const image = absoluteUrl(response.url, extractMeta(html, 'og:image'));
      // 스레드는 og:description에 캡션 전문이 들어온다
      const description = extractMeta(html, 'og:description') || title;
      return {
        url: response.url,
        title,
        body: isThreads ? description : title,
        ogImage: image,
        ogDescription: description,
        images: image ? [image] : [],
        outboundLinks: extractOutboundLinks(html, description),
        inputType: 'url',
        isInstagram,
        isThreads,
      };
    }

    const title = extractMeta(html, 'og:title') || extractTitleTag(html) || '';
    const ogImage = absoluteUrl(response.url, extractMeta(html, 'og:image'));
    const ogDescription = extractMeta(html, 'og:description') || '';

    // 유튜브: 영상 설명(임베디드 shortDescription) + 자막 전문(yt-dlp, 있으면) — 둘 다 소재로
    if (isYouTube) {
      const shortDesc = extractYouTubeDescription(html);
      const description = shortDesc || ogDescription || title;
      const transcript = await fetchYouTubeTranscript(url);
      const transcriptSegments = normalizeTranscriptSegments(transcript && transcript.segments);
      const body = transcript
        ? `${description}\n\n--- 영상 스크립트(자막 추출, ${transcript.lang}) ---\n${transcript.text}`
        : description;
      return {
        url: response.url,
        title,
        body,
        ogImage,
        ogDescription: description,
        images: ogImage ? [ogImage] : [],
        outboundLinks: extractOutboundLinks('', description),
        mediaSummary: transcript
          ? `유튜브 영상 1개 — 자막 스크립트 ${transcript.text.length}자 추출됨(${transcript.lang})`
          : '유튜브 영상 1개 — 자막 없음(설명란 텍스트만)',
        inputType: 'url',
        isInstagram: false,
        isThreads: false,
        isYouTube: true,
        transcript: Boolean(transcript),
        transcriptSegments,
      };
    }

    const body = extractArticleBody(html) || ogDescription || title;
    const images = [ogImage].concat(extractImageUrls(html, response.url)).filter(Boolean);

    return {
      url: response.url,
      title,
      body,
      ogImage,
      ogDescription,
      images: uniqueUrls(images).slice(0, MAX_IMAGES),
      outboundLinks: extractOutboundLinks(html, body),
      inputType: 'url',
      isInstagram: false,
      isThreads: false,
    };
  }

  // 유튜브 자막 전문 추출.
  // 1순위: 브라우저 방식(scripts/yt-transcript.mjs — 유튜브 자체 '스크립트 패널'을 DOM에서 읽음,
  //        확장프로그램과 같은 원리라 IP 레이트리밋(429)에 면역)
  // 2순위: yt-dlp(android 클라이언트), 언어별 순차. 전부 실패 시 null(설명란만) — 성공 위장 금지.
  async function fetchYouTubeTranscript(url) {
    const browserResult = await fetchYouTubeTranscriptViaBrowser(url);
    if (browserResult) {
      return browserResult;
    }
    return fetchYouTubeTranscriptViaYtdlp(url);
  }

  async function fetchYouTubeTranscriptViaBrowser(url) {
    const script = path.join(__dirname, '..', 'scripts', 'yt-transcript.mjs');
    if (!fs.existsSync(script)) {
      return null;
    }
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script, url], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SUDO_ASKPASS: '', SSH_ASKPASS: '', DISPLAY: '' },
      });
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 75000);
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(out);
          resolve(data && data.text ? {
            text: data.text,
            lang: data.lang,
            segments: normalizeTranscriptSegments(data.segments),
          } : null);
        } catch (error) {
          resolve(null);
        }
      });
    });
  }

  async function fetchYouTubeTranscriptViaYtdlp(url) {
    const ytdlp = process.env.YTDLP_PATH || '/opt/homebrew/bin/yt-dlp';
    if (!fs.existsSync(ytdlp)) {
      return null;
    }
    // 언어별 순차 시도 — yt-dlp는 자막 1개 실패(429 등) 시 나머지 언어를 건너뛰고 중단하므로(실측)
    // ko(한국어 원본/자동) → ko-en(영어→한국어 자동번역) → en(영어) 순서로 따로 시도, 먼저 성공한 것 채택.
    const LANGS = [
      ['ko', 'ko'],
      ['ko-en', '영어→한국어 자동번역'],
      ['en', 'en'],
    ];
    for (const [code, label] of LANGS) {
      const tmpBase = path.join('/tmp', `cmag-yt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await new Promise((resolve) => {
        const child = spawn(ytdlp, [
          '--skip-download', '--write-subs', '--write-auto-subs',
          '--sub-langs', code, '--sub-format', 'json3',
          '--extractor-args', 'youtube:player_client=android',
          '--no-warnings', '-o', tmpBase, url,
        ], {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, SUDO_ASKPASS: '', SSH_ASKPASS: '' },
        });
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 45000);
        child.on('error', () => { clearTimeout(timer); resolve(); });
        child.on('close', () => { clearTimeout(timer); resolve(); });
      });
      try {
        const dir = path.dirname(tmpBase);
        const prefix = path.basename(tmpBase);
        const files = (await fsp.readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.json3'));
        if (!files.length) {
          continue;
        }
        const data = JSON.parse(await fsp.readFile(path.join(dir, files[0]), 'utf8'));
        await Promise.all(files.map((f) => fsp.unlink(path.join(dir, f)).catch(() => {})));
        // json3 events에서 텍스트와 타임스탬프 segments를 함께 추출 (프레임 매칭용)
        const segments = [];
        const text = (data.events || [])
          .filter((ev) => ev.segs)
          .map((ev) => {
            const joined = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
            if (joined && Number.isFinite(ev.tStartMs) && segments.length < 400) {
              segments.push({ t: Math.max(0, Math.floor(ev.tStartMs / 1000)), text: joined });
            }
            return joined;
          })
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 12000);
        if (text) {
          return { text, lang: label, segments };
        }
      } catch (error) {
        /* 다음 언어 시도 */
      }
    }
    return null;
  }

  // 인스타그램: 로그인 세션(dongsaeng 프로필)으로 캐러셀 전체 미디어+캡션 전문 시도 → 실패 시 og 폴백
  async function fetchInstagramAuthenticated(url) {
    const script = path.join(__dirname, '..', 'scripts', 'ig-fetch.mjs');
    if (!fs.existsSync(script)) {
      return null;
    }
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script, url], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SUDO_ASKPASS: '', SSH_ASKPASS: '', DISPLAY: '' },
      });
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60000);
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(out);
          resolve(data && Array.isArray(data.media) ? data : null);
        } catch (error) {
          resolve(null);
        }
      });
    });
  }

  // X/트위터 — cdn.syndication.twimg.com (공식, 키 불필요). /status/<id>만 지원.
  async function collectFromTweet(url) {
    const match = url.match(/\/status(?:es)?\/(\d+)/);
    if (!match) {
      throw new Error('X(트위터)는 개별 트윗 URL(/status/...)만 분석할 수 있습니다');
    }
    const response = await fetchText(`https://cdn.syndication.twimg.com/tweet-result?id=${match[1]}&token=a`, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    let tweet;
    try {
      tweet = JSON.parse(response.text);
    } catch (error) {
      throw new Error('트윗 데이터를 파싱할 수 없습니다');
    }
    if (!tweet || typeof tweet.text !== 'string') {
      throw new Error('트윗을 가져올 수 없습니다 (삭제/비공개일 수 있음)');
    }
    const user = tweet.user || {};
    const media = Array.isArray(tweet.mediaDetails) ? tweet.mediaDetails : [];
    const images = media
      .map((item) => item.media_url_https || (item.video_info ? item.media_url_https : null))
      .filter(Boolean);
    const entityUrls = ((tweet.entities || {}).urls || [])
      .map((item) => item.expanded_url)
      .filter(Boolean);
    const hasVideo = media.some((item) => item.type === 'video' || item.type === 'animated_gif');
    return {
      url,
      title: `@${user.screen_name || 'unknown'} (${user.name || 'X'})의 트윗`,
      body: tweet.text + (hasVideo ? '\n\n(이 트윗에는 영상이 첨부되어 있음)' : ''),
      ogImage: images[0] || null,
      ogDescription: tweet.text,
      images: images.slice(0, MAX_IMAGES),
      outboundLinks: Array.from(new Set(entityUrls.concat(extractOutboundLinks('', tweet.text)))).slice(0, 10),
      inputType: 'url',
      isInstagram: false,
      isThreads: false,
      isTwitter: true,
    };
  }

  // 유튜브 임베디드 JSON에서 영상 설명 전문 추출
  function extractYouTubeDescription(html) {
    const match = (html || '').match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    if (!match) {
      return '';
    }
    try {
      return JSON.parse(`"${match[1]}"`).slice(0, 3000);
    } catch (error) {
      return '';
    }
  }

  // 포스트/본문 안의 외부 원문 링크 추출 (메타 패밀리/CDN/인프라 도메인 제외)
  function extractOutboundLinks(html, captionText) {
    const EXCLUDE = /(^|\.)(threads\.(com|net)|instagram\.com|facebook\.com|fb\.com|cdninstagram\.com|fbcdn\.net|meta\.com|twitter\.com|x\.com|t\.co|twimg\.com|w3\.org|schema\.org|gstatic\.com|googletagmanager\.com|google-analytics\.com|googleapis\.com)$/i;
    const URL_PATTERN = /https?:\/\/[^\s"'<>\\)\]]+/g;

    const cleanUrl = (raw) => {
      const normalized = raw.replace(/&amp;/g, '&').replace(/\\\//g, '/').replace(/[.,;!?]+$/, '');
      let parsed;
      try {
        parsed = new URL(normalized);
      } catch (error) {
        return null;
      }
      if (!/^https?:$/.test(parsed.protocol) || EXCLUDE.test(parsed.hostname)) {
        return null;
      }
      if (/\.(js|css|png|jpg|jpeg|webp|gif|svg|ico|woff2?)([?#]|$)/i.test(parsed.pathname)) {
        return null;
      }
      return parsed.href;
    };

    // 1순위: 캡션 텍스트에 직접 등장한 링크 (가장 신뢰)
    const found = new Set();
    for (const raw of (captionText || '').match(URL_PATTERN) || []) {
      const href = cleanUrl(raw);
      if (href) {
        found.add(href);
      }
    }

    // 2순위: HTML 임베디드에서 2회 이상 반복된 링크만 (스레드는 실제 첨부 링크를 JSON에 반복 수록)
    if (found.size < 10) {
      const counts = new Map();
      for (const raw of (html || '').match(URL_PATTERN) || []) {
        const href = cleanUrl(raw);
        if (href) {
          counts.set(href, (counts.get(href) || 0) + 1);
        }
      }
      for (const [href, count] of counts) {
        if (count >= 2 && !found.has(href)) {
          found.add(href);
          if (found.size >= 10) {
            break;
          }
        }
      }
    }
    return Array.from(found).slice(0, 10);
  }

  return {
    collectForPost,
    collectFromURL,
    downloadImages,
    traceUrl,
  };
}

async function fetchText(url, options = {}, redirectCount = 0) {
  const response = await requestUrl(url, {
    headers: options.headers,
    maxBytes: 3 * 1024 * 1024,
    timeoutMs: options.timeoutMs,
  });

  if (isRedirect(response.statusCode)) {
    if (redirectCount >= MAX_REDIRECTS || !response.headers.location) {
      throw new Error('URL redirect limit exceeded');
    }
    const nextUrl = absoluteUrl(url, response.headers.location);
    return fetchText(nextUrl, options, redirectCount + 1);
  }

  if (response.statusCode >= 400) {
    throw new Error(`URL fetch 실패: ${response.statusCode}`);
  }

  return {
    ...response,
    text: response.body.toString('utf8'),
    url,
  };
}

async function fetchOgImage(url) {
  try {
    const response = await fetchText(url, { timeoutMs: 10000 });
    const contentType = String(response.contentType || '').toLowerCase();
    if (!contentType.includes('text/html')) {
      return null;
    }
    return absoluteUrl(response.url, extractMeta(response.text, 'og:image')) || null;
  } catch (error) {
    return null;
  }
}

async function downloadImages(urls, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const results = [];
  let index = 0;

  for (const url of urls.slice(0, MAX_IMAGES)) {
    index += 1;
    try {
      const file = await downloadImage(url, destDir, index);
      results.push(file);
    } catch (error) {
      results.push({
        url,
        localPath: null,
        width: 0,
        height: 0,
      });
    }
  }

  return results;
}

async function downloadImage(url, destDir, index, redirectCount = 0) {
  const response = await requestUrl(url, { maxBytes: MAX_IMAGE_BYTES });

  if (isRedirect(response.statusCode)) {
    if (redirectCount >= MAX_REDIRECTS || !response.headers.location) {
      throw new Error('Image redirect limit exceeded');
    }
    const nextUrl = absoluteUrl(url, response.headers.location);
    return downloadImage(nextUrl, destDir, index, redirectCount + 1);
  }

  if (response.statusCode >= 400) {
    throw new Error(`Image fetch failed: ${response.statusCode}`);
  }

  const contentType = String(response.contentType || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error('Not an image');
  }
  // 벡터/아이콘/애니GIF는 make_card(PIL)가 못 쓰거나 사이트 로고일 확률이 높다 — 사진만 통과.
  if (/svg|x-icon|vnd\.microsoft\.icon|gif/.test(contentType)) {
    throw new Error('Non-photographic image type');
  }
  // og:image 로고/스프라이트가 URL 필터를 빠져나오는 경우 — 초소형 파일은 로고로 간주해 거른다.
  if (response.body && response.body.length < MIN_PHOTO_BYTES) {
    throw new Error('Image too small (likely a logo)');
  }

  const extension = inferImageExtension(contentType, url);
  const fileName = `img_${String(index).padStart(2, '0')}.${extension}`;
  const targetPath = path.join(destDir, sanitize(fileName, fileName));
  await fsp.writeFile(targetPath, response.body);

  const relative = `assets/${path.basename(targetPath)}`;
  return {
    url,
    localPath: relative,
    width: 0,
    height: 0,
  };
}

function requestUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const request = client.request(
      parsed,
      {
        method: 'GET',
        headers: options.headers || {},
      },
      (response) => {
        const chunks = [];
        let size = 0;

        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > (options.maxBytes || MAX_IMAGE_BYTES)) {
            response.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            contentType: response.headers['content-type'] || '',
            body: Buffer.concat(chunks),
          });
        });

        response.on('error', reject);
      }
    );

    request.setTimeout(options.timeoutMs || FETCH_TIMEOUT_MS, () => {
      request.destroy(new Error('URL 응답 시간 초과'));
    });

    request.on('error', reject);
    request.end();
  });
}

function extractMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return decodeHtml(match[1]);
    }
  }

  return '';
}

function extractTitleTag(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1].trim()) : '';
}

function extractArticleBody(html) {
  const containers = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]+class=["'][^"']*(article-body|articleBody|entry-content|story-body|post-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of containers) {
    const match = html.match(pattern);
    const bodyHtml = match ? match[match.length - 1] : '';
    const paragraphs = extractParagraphs(bodyHtml);
    if (paragraphs.length) {
      return paragraphs.join('\n\n').trim();
    }
  }

  const paragraphs = extractParagraphs(html);
  return paragraphs.join('\n\n').trim();
}

function extractParagraphs(html) {
  const matches = Array.from(html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi));
  return matches
    .map((match) => htmlToText(match[1]))
    .map((text) => text.trim())
    .filter((text) => text.length >= 20)
    .slice(0, 24);
}

// 사이트 크롬(로고/스프라이트/파비콘/아이콘)·벡터는 본문 사진으로 부적합 — URL 단계에서 거른다.
const CHROME_URL_RE = /(logo|sprite|favicon|icon|avatar|placeholder|tracking|pixel|spinner|loader|badge|chrome\/)/i;
const NON_PHOTO_EXT_RE = /\.(svg|ico|gif)([?#]|$)/i;

function isLikelyChromeImage(url) {
  if (typeof url !== 'string' || !url) {
    return true;
  }
  if (NON_PHOTO_EXT_RE.test(url) || CHROME_URL_RE.test(url)) {
    return true;
  }
  if (/^data:/i.test(url)) {
    return true;
  }
  return false;
}

function extractImageUrls(html, baseUrl) {
  const matches = Array.from(html.matchAll(/<img\b[^>]+src=["']([^"']+)["'][^>]*>/gi));
  return matches
    .map((match) => absoluteUrl(baseUrl, match[1]))
    .filter(Boolean)
    .filter((url) => !isLikelyChromeImage(url))
    .slice(0, MAX_IMAGES);
}

async function touchSourcesForUrl(url, sources, store) {
  const domain = getDomain(url);
  if (!domain || !store || typeof store.updateSource !== 'function') {
    return [];
  }

  const matches = sources.filter((source) => matchesDomain(domain, source.domain));
  const now = new Date().toISOString();
  await Promise.all(matches.map((source) => sourceUpdate(store, source, now)));
  return matches.map((source) => source.id);
}

async function sourceUpdate(store, source, now) {
  if (!source || !source.id) {
    return;
  }
  await store.updateSource(source.id, {
    useCount: (source.useCount || 0) + 1,
    lastUsedAt: now,
  });
}

function pickRegisteredDomains(topic, sources) {
  const tokens = String(topic || '')
    .toLowerCase()
    .split(/[\s,/]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);

  const matched = sources.filter((source) => {
    const haystack = [source.name, source.domain].concat(source.tags || []).join(' ').toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });

  const selected = (matched.length ? matched : sources)
    .slice()
    .sort((left, right) => (right.useCount || 0) - (left.useCount || 0));

  return uniqueUrls(selected.map((source) => source.domain).filter(Boolean)).slice(0, 8);
}

function matchesDomain(domain, candidate) {
  if (!domain || !candidate) {
    return false;
  }
  return domain === candidate || domain.endsWith(`.${candidate}`);
}

function uniqueUrls(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}

function normalizeTranscriptSegments(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const t = Number(item.t);
      if (!Number.isFinite(t) || t < 0 || typeof item.text !== 'string') {
        return null;
      }
      return {
        t,
        text: item.text,
      };
    })
    .filter(Boolean)
    .slice(0, 400);
}

function inferImageExtension(contentType, sourceUrl) {
  if (contentType.includes('png')) {
    return 'png';
  }
  if (contentType.includes('webp')) {
    return 'webp';
  }
  if (contentType.includes('gif')) {
    return 'gif';
  }
  if (contentType.includes('jpeg') || contentType.includes('jpg')) {
    return 'jpg';
  }

  try {
    const ext = path.extname(new URL(sourceUrl).pathname).replace('.', '').toLowerCase();
    if (ext) {
      return ext;
    }
  } catch (error) {
    return 'jpg';
  }

  return 'jpg';
}

function absoluteUrl(baseUrl, value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch (error) {
    return '';
  }
}

function trimTitle(value) {
  return String(value || '').trim().slice(0, 80);
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function isRedirect(statusCode) {
  return statusCode >= 300 && statusCode < 400;
}

module.exports = {
  createCollector,
  fetchOgImage,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
};
