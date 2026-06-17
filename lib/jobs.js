const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  buildAppendPrompt,
  buildOutlinePrompt,
  buildVerifyPrompt,
  buildWritePrompt,
  loadStyleBible,
} = require('./prompts');
const { fetchOgImage } = require('./collect');

const OUTLINE_ROLES = new Set(['cover', 'context', 'body', 'insight', 'ending']);
const fsp = fs.promises;
const MAX_DIRECT_OG_IMAGES = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const YT_FRAME_TIMEOUT_MS = 240000;
const FACE_DETECT_TIMEOUT_MS = 60000;
const COVER_FACE_MIN_AREA = 0.015;
const FRAME_HASH_TIMEOUT_MS = 30000;
// aHash 해밍거리 ≤ 이 값이면 "사실상 같은 화면" (정적 인터뷰 미드샷 실측 0~6, 다른 장면 12+)
const FRAME_DUPE_HAMMING_MAX = 10;
const FRAME_ALT_OFFSETS = [45, -45, 90, -90, 150, -150];
const COVER_CANDIDATE_FRAME_COUNT = 6;
const COVER_CANDIDATE_START_RATIO = 0.1;
const COVER_CANDIDATE_END_RATIO = 0.9;
const SWIFT_BIN_PATH = '/usr/bin/swift';

function createJobManager({ store, collector, renderer, callClaude }) {
  const locks = new Map();
  const updateStage = createStageUpdater(store);

  async function recoverInterruptedJobs() {
    const posts = await store.listPosts();
    await Promise.all(
      posts
        .filter((post) => post.job || ['collecting', 'writing', 'rendering', 'verifying'].includes(post.status))
        .map((post) =>
          store.updatePost(post.id, {
            status: 'error',
            error: '이전 작업이 중단되었습니다',
            resumeStage: post.job ? post.job.stage : post.status,
            failedStage: post.job ? post.job.stage : post.status,
            job: null,
          })
        )
    );
  }

  async function startGenerateJob(postId, options = {}) {
    if (locks.has(postId)) {
      throw createHttpError(409, '이미 생성이 진행 중입니다');
    }

    const post = await store.getPost(postId);
    if (!post) {
      throw createHttpError(404, 'Post not found.');
    }

    const fromStage = normalizeStage(options.fromStage || post.resumeStage || 'collecting');
    const apiKey = typeof options.apiKey === 'string' ? options.apiKey : '';
    locks.set(postId, true);

    Promise.resolve()
      .then(() => runGenerateJob(postId, fromStage, apiKey))
      .catch(() => {})
      .finally(() => {
        locks.delete(postId);
      });

    return { status: fromStage };
  }

  function hasJob(postId) {
    return locks.has(postId);
  }

  async function runGenerateJob(postId, fromStage, apiKey) {
    let activeStage = fromStage;
    const startedAt = new Date().toISOString();

    try {
      let post = await store.getPost(postId);
      if (!post) {
        throw createStageError(activeStage, 'Post not found.');
      }

      if (activeStage === 'collecting') {
        await updateStage(postId, 'collecting', '소재를 수집하는 중...', startedAt);
        try {
          post = await collector.collectForPost(post, {
            updateProgress: (message) => updateStage(postId, 'collecting', message, startedAt),
            apiKey,
          });
        } catch (error) {
          if (!canSkipCollectFailure(post)) {
            throw error;
          }
          await updateStage(postId, 'collecting', '본문이 확보되어 집필 단계로 넘어갑니다...', startedAt);
          post = await store.getPost(postId);
          if (!post) {
            throw createStageError('collecting', 'Post not found.');
          }
        }
        activeStage = 'writing';
      }

      if (activeStage === 'writing') {
        await updateStage(
          postId,
          'writing',
          hasTraceAngle(post) ? '아웃라인 설계 중...' : '슬라이드 텍스트를 작성하는 중...',
          startedAt
        );
        post = await writeSlides(post, {
          updateProgress: (message) => updateStage(postId, 'writing', message, startedAt),
          apiKey,
        });
        activeStage = 'rendering';
      }

      if (activeStage === 'rendering') {
        await updateStage(postId, 'rendering', '슬라이드를 렌더링하는 중...', startedAt);
        const renderResult = await renderer.renderSlides(post);
        if (renderResult.failed.length) {
          throw createStageError('rendering', renderResult.failed[0].error);
        }
        post = renderResult.post;
        activeStage = hasTraceAngle(post) ? 'verifying' : activeStage;
      }

      if (activeStage === 'verifying' && hasTraceAngle(post)) {
        await updateStage(postId, 'verifying', '슬라이드를 검수하는 중...', startedAt);
        post = await verifySlides(post, {
          updateProgress: (message) => updateStage(postId, 'verifying', message, startedAt),
          apiKey,
        });
      }

      await store.updatePost(postId, {
        status: 'draft',
        error: '',
        resumeStage: null,
        failedStage: null,
        job: null,
      });
    } catch (error) {
      await store.updatePost(postId, {
        status: 'error',
        error: error.message,
        resumeStage: normalizeStage(error.resumeStage || activeStage),
        failedStage: normalizeStage(error.failedStage || activeStage),
        job: null,
      });
    }
  }

  async function writeSlides(post, options = {}) {
    const updateProgress = typeof options.updateProgress === 'function' ? options.updateProgress : async () => {};
    const settings = await store.getSettings();
    const tonePreset = settings.tonePresets.find((preset) => preset.id === post.tone)
      || settings.tonePresets[0]
      || null;
    const allSources = await store.listSources();
    const matchedSources = allSources.filter((source) => post.sources.includes(source.id));
    const styleBible = loadStyleBible();
    const traceMode = hasTraceAngle(post);
    let outline = Array.isArray(post.outline) ? post.outline : [];
    let sourceNames = [];
    let resolvedFormat = null;
    let resolvedPostType = null;
    let directPhotoAssignments = new Map();
    let result;

    if (traceMode) {
      await updateProgress('아웃라인 설계 중...');
      const outlined = await callClaude(buildOutlinePrompt({
        angle: post.angle,
        items: post.traceItems,
        body: post.body,
        title: post.title,
        segments: post.transcriptSegments,
        direction: post.direction,
      }), {
        allowWebSearch: false,
        cliPath: settings.claudePath || undefined,
        apiKey: options.apiKey,
      });

      outline = normalizeOutline(outlined && outlined.outline, post.traceItems);
      sourceNames = resolveSourceNames({
        sourceNames: outlined && outlined.sourceNames,
        outline,
        items: post.traceItems,
      });
      resolvedFormat = normalizePostFormat(outlined && outlined.format);
      resolvedPostType = normalizePostType(outlined && outlined.postType);
      post = await store.updatePost(post.id, {
        outline,
        format: resolvedFormat,
        postType: resolvedPostType || post.postType,
      });

      const sourced = await sourceTraceImages({
        post,
        outline,
        updateProgress,
        store,
      });
      post = sourced.post;
      directPhotoAssignments = sourced.photoAssignments;

      await updateProgress('슬라이드 카피 집필 중...');
      result = await callClaude(buildWritePrompt({
        title: post.title,
        body: post.body,
        inputType: post.inputType,
        tone: tonePreset,
        sources: matchedSources,
        imageCandidates: post.imageCandidates,
        items: post.traceItems,
        outline,
        styleBible,
        angle: post.angle,
        sourceNames,
        format: resolvedFormat,
        direction: post.direction,
      }), {
        allowWebSearch: false,
        cliPath: settings.claudePath || undefined,
        apiKey: options.apiKey,
      });
    } else {
      result = await callClaude(buildWritePrompt({
        title: post.title,
        body: post.body,
        inputType: post.inputType,
        tone: tonePreset,
        sources: matchedSources,
        imageCandidates: post.imageCandidates,
        styleBible,
        direction: post.direction,
      }), {
        allowWebSearch: false,
        cliPath: settings.claudePath || undefined,
        apiKey: options.apiKey,
      });
    }

    if (!Array.isArray(result.slides) || !result.slides.length) {
      throw createStageError('writing', 'AI 응답을 해석할 수 없습니다');
    }

    let slides = mapSlidesFromResult(post, result.slides, store);
    slides = applyDirectPhotoAssignments(slides, directPhotoAssignments);
    slides = distinctifyBodyPhotos(slides, post.imageCandidates);
    const selected = new Set(slides.map((slide) => slide.photo).filter(Boolean));
    const imageCandidates = post.imageCandidates.map((candidate) => ({
      ...candidate,
      selected: Boolean(candidate.localPath && selected.has(candidate.localPath)),
    }));

    const cover = slides[0];
    const nextTitle =
      post.title
      || (cover && cover.text && typeof cover.text.headline === 'string'
        ? cover.text.headline.replace(/\n/g, ' ').trim()
        : '')
      || post.input.slice(0, 80);
    const postType = resolvedPostType || normalizePostType(result.postType) || 'brief';
    const caption = traceMode
      ? ensureCaptionSourceLine(
        typeof result.caption === 'string' ? result.caption : '',
        sourceNames.length ? sourceNames : resolveSourceNames({ outline, items: post.traceItems })
      )
      : typeof result.caption === 'string'
        ? result.caption
        : '';

    return store.updatePost(post.id, {
      title: nextTitle,
      postType,
      slides,
      imageCandidates,
      caption,
      hashtags: traceMode ? '' : (typeof result.hashtags === 'string' ? result.hashtags : ''),
      outline: traceMode ? outline : post.outline,
    });
  }

  async function verifySlides(post, options = {}) {
    const updateProgress = typeof options.updateProgress === 'function' ? options.updateProgress : async () => {};
    const settings = await store.getSettings();
    let current = post;
    let finalVerify = null;

    for (let round = 1; round <= 2; round += 1) {
      await updateProgress(`슬라이드를 검수하는 중... (${round}/2)`);
      const verified = await callVerifyWithRetry(current, settings, round, updateProgress, options.apiKey);
      if (!verified) {
        // 검수 콜 실패는 비차단 — 진행문구로만 알리고 draft로 보낸다 (stderr 직접 쓰기 금지: EPIPE 규칙)
        await updateProgress('검수 응답 실패 — 검수 없이 초안으로 진행합니다');
        return current;
      }

      let results = normalizeVerifyResults(verified.results, current.slides);
      finalVerify = { round, results };
      current = await store.updatePost(current.id, { verify: finalVerify });

      const failedSlides = results.filter((item) => !item.ok);
      if (!failedSlides.length) {
        return clearVerifyFailures(store, current, finalVerify);
      }

      if (round >= 2) {
        break;
      }

      const fixableSlides = failedSlides.filter((item) => item.fix);
      if (!fixableSlides.length) {
        break;
      }

      await updateProgress(buildVerifyRetryMessage(fixableSlides, round, describeVerifyIssues(failedSlides)));
      current = await applyVerificationFixes(store, current, fixableSlides);

      const renderResult = await renderer.renderSlides(current, {
        slideIds: fixableSlides.map((item) => current.slides[item.slideIndex]?.id).filter(Boolean),
      });
      current = renderResult.post;

      if (renderResult.failed.length) {
        const failedById = new Map(renderResult.failed.map((item) => [item.slideId, item.error]));
        results = mergeRenderFailuresIntoResults(current, results, failedById);
        finalVerify = { round, results };
        current = await store.updatePost(current.id, { verify: finalVerify });
      }
    }

    if (!finalVerify) {
      return current;
    }

    return markVerifyFailures(store, current, finalVerify);
  }

  async function callVerifyWithRetry(post, settings, round, updateProgress, apiKey) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await callClaude(buildVerifyPrompt({
          slides: post.slides,
          items: post.traceItems,
          outline: post.outline || [],
          format: post.format || null,
        }), {
          allowWebSearch: false,
          cliPath: settings.claudePath || undefined,
          apiKey,
        });
      } catch (error) {
        if (attempt >= 2) {
          return null;
        }
        await updateProgress(`검수 응답 재시도 중 (${round}/2, ${attempt}/1)...`);
      }
    }
    return null;
  }

  async function startAppendJob(postId, options = {}) {
    if (locks.has(postId)) {
      throw createHttpError(409, '이미 생성이 진행 중입니다');
    }

    const post = await store.getPost(postId);
    if (!post) {
      throw createHttpError(404, 'Post not found.');
    }
    if (!Array.isArray(post.slides) || !post.slides.length) {
      throw createHttpError(409, '슬라이드가 있는 포스트에서만 추가할 수 있습니다');
    }

    const instruction = typeof options.instruction === 'string' ? options.instruction.trim() : '';
    if (!instruction) {
      throw createHttpError(400, '추가 지시 문장이 필요합니다');
    }

    const apiKey = typeof options.apiKey === 'string' ? options.apiKey : '';
    locks.set(postId, true);

    Promise.resolve()
      .then(() => runAppendJob(postId, instruction, apiKey))
      .catch(() => {})
      .finally(() => {
        locks.delete(postId);
      });

    return { status: 'writing' };
  }

  async function runAppendJob(postId, instruction, apiKey) {
    const startedAt = new Date().toISOString();

    try {
      let post = await store.getPost(postId);
      if (!post) {
        throw createStageError('writing', 'Post not found.');
      }

      const settings = await store.getSettings();
      const tonePreset = settings.tonePresets.find((preset) => preset.id === post.tone)
        || settings.tonePresets[0]
        || null;

      await updateStage(postId, 'writing', '추가 슬라이드 집필 중...', startedAt);
      const result = await callClaude(buildAppendPrompt({
        title: post.title,
        body: post.body,
        tone: tonePreset,
        imageCandidates: post.imageCandidates,
        slides: post.slides,
        styleBible: loadStyleBible(),
        angle: post.angle,
        instruction,
      }), {
        allowWebSearch: false,
        cliPath: settings.claudePath || undefined,
        apiKey,
      });

      if (!Array.isArray(result.slides) || !result.slides.length) {
        throw createStageError('writing', 'AI 응답을 해석할 수 없습니다');
      }

      const newSlides = result.slides.slice(0, 3).map((slide) => ({
        id: store.generateId('slide'),
        type: 'body',
        order: 0,
        text: {
          subtitle: typeof slide.subtitle === 'string' ? slide.subtitle : '',
          paragraphs: Array.isArray(slide.paragraphs)
            ? slide.paragraphs.filter((item) => typeof item === 'string')
            : [],
        },
        photo: resolvePhotoFromIndex(slide.photo, post.imageCandidates),
        imagePath: null,
        dirty: true,
        overflow: false,
        verifyFailed: false,
      }));

      const slides = post.slides.slice();
      const endingIndex = slides.findIndex((slide) => slide.type === 'ending');
      const requested = Number(result.insertAfter);
      let insertAt = Number.isInteger(requested) && requested >= 1 && requested <= slides.length
        ? requested
        : slides.length;
      if (endingIndex !== -1 && insertAt > endingIndex) {
        insertAt = endingIndex;
      }
      if (insertAt < 1) {
        insertAt = 1;
      }
      slides.splice(insertAt, 0, ...newSlides);
      slides.forEach((slide, index) => {
        slide.order = index;
      });

      const selected = new Set(slides.map((slide) => slide.photo).filter(Boolean));
      const imageCandidates = post.imageCandidates.map((candidate) => ({
        ...candidate,
        selected: Boolean(candidate.localPath && selected.has(candidate.localPath)),
      }));

      post = await store.updatePost(postId, { slides, imageCandidates });

      await updateStage(postId, 'rendering', '추가 슬라이드 렌더링 중...', startedAt);
      const newIds = new Set(newSlides.map((slide) => slide.id));
      const renderResult = await renderer.renderSlides(post, {
        slideIds: post.slides.filter((slide) => newIds.has(slide.id)).map((slide) => slide.id),
      });
      if (renderResult.failed.length) {
        throw createStageError('rendering', renderResult.failed[0].error);
      }

      await store.updatePost(postId, {
        status: 'draft',
        error: '',
        resumeStage: null,
        failedStage: null,
        job: null,
      });
    } catch (error) {
      // 추가 실패 시 재시도가 전체 재집필로 번지지 않게 resume은 rendering으로 고정
      await store.updatePost(postId, {
        status: 'error',
        error: error.message,
        resumeStage: 'rendering',
        failedStage: normalizeStage(error.failedStage || 'writing'),
        job: null,
      });
    }
  }

  return {
    recoverInterruptedJobs,
    startGenerateJob,
    startAppendJob,
    hasJob,
  };
}

function createStageUpdater(store) {
  return async function updateStage(postId, stage, progress, startedAt) {
    return store.updatePost(postId, {
      status: stage,
      error: '',
      failedStage: null,
      resumeStage: stage,
      job: {
        stage,
        progress,
        startedAt,
      },
    });
  };
}

function hasTraceAngle(post) {
  return Boolean(post && post.angle && Array.isArray(post.traceItems) && post.traceItems.length);
}

function canSkipCollectFailure(post) {
  return Boolean(
    hasTraceAngle(post)
    && post.inputType === 'url'
    && typeof post.body === 'string'
    && post.body.trim().length >= 300
  );
}

function normalizePostType(value) {
  if (value === 'essay') {
    return 'essay';
  }
  if (value === 'brief') {
    return 'brief';
  }
  return null;
}

function normalizePostFormat(value) {
  if (
    value === 'news'
    || value === 'quote'
    || value === 'listicle'
    || value === 'detective'
    || value === 'profile'
    || value === 'learning'
  ) {
    return value;
  }
  return null;
}

function mapSlidesFromResult(post, slidesInput, store) {
  return slidesInput.map((slide, index) => {
    const previous = post.slides[index];
    const type = slide.type === 'ending' ? 'ending' : slide.type === 'cover' ? 'cover' : 'body';
    const photo = resolvePhotoFromIndex(slide.photo, post.imageCandidates);
    if (type === 'body') {
      return {
        id: previous ? previous.id : store.generateId('slide'),
        type,
        order: index,
        text: {
          subtitle: typeof slide.subtitle === 'string' ? slide.subtitle : '',
          paragraphs: Array.isArray(slide.paragraphs)
            ? slide.paragraphs.filter((item) => typeof item === 'string')
            : [],
        },
        photo,
        imagePath: previous ? previous.imagePath : null,
        dirty: true,
        overflow: false,
        verifyFailed: false,
      };
    }

    return {
      id: previous ? previous.id : store.generateId('slide'),
      type,
      order: index,
      text: {
        headline: typeof slide.headline === 'string' ? slide.headline : '',
        kicker: typeof slide.kicker === 'string' ? slide.kicker : null,
        paragraphs: [],
        subtitle: null,
        closing: typeof slide.closing === 'string' ? slide.closing : null,
      },
      photo,
      imagePath: previous ? previous.imagePath : null,
      dirty: true,
      overflow: false,
      verifyFailed: false,
    };
  });
}

function normalizeOutline(values, items) {
  if (!Array.isArray(values)) {
    return [];
  }

  const validRefs = new Set((Array.isArray(items) ? items : []).map((item) => item.ref));
  return values.map((item, index) => {
    const role = typeof item?.role === 'string' && OUTLINE_ROLES.has(item.role.trim())
      ? item.role.trim()
      : inferRole(item && item.type, index);
    const type = normalizeSlideType(item && item.type, role, index);
    return {
      slideIndex: Number.isInteger(item && item.slideIndex) && item.slideIndex >= 0 ? item.slideIndex : index,
      type,
      role,
      message: typeof item?.message === 'string' ? item.message : '',
      itemRefs: uniqueStrings(Array.isArray(item?.itemRefs) ? item.itemRefs : [])
        .filter((ref) => validRefs.has(ref)),
      frameTs: normalizeFrameTs(item && item.frameTs),
    };
  });
}

async function sourceTraceImages({ post, outline, updateProgress, store }) {
  if (!Array.isArray(outline) || !outline.length || post.inputType !== 'url') {
    return { post, photoAssignments: new Map() };
  }

  if (isYouTubeUrl(post.input) && hasTranscriptSegments(post.transcriptSegments)) {
    await updateProgress('원본 장면 프레임 추출 중...');
    if (!(await hasCommand('yt-dlp')) || !(await hasCommand('ffmpeg'))) {
      return { post, photoAssignments: new Map() };
    }
    try {
      return await sourceYouTubeFrames({ post, outline, store });
    } catch (error) {
      await updateProgress('원본 장면 프레임 추출 실패 — 기존 이미지로 계속합니다');
      return { post, photoAssignments: new Map() };
    }
  }

  await updateProgress('원문 이미지 수집 중...');
  try {
    return await sourceOutlineOgImages({ post, outline, store });
  } catch (error) {
    await updateProgress('원문 이미지 수집 실패 — 기존 이미지로 계속합니다');
    return { post, photoAssignments: new Map() };
  }
}

async function sourceYouTubeFrames({ post, outline, store }) {
  const requestedEntries = [];
  const allFrameRequests = new Map();
  const coverFrameUrls = [];
  const existingByUrl = new Map();
  let coverSlideIndex = null;

  for (const candidate of Array.isArray(post.imageCandidates) ? post.imageCandidates : []) {
    if (typeof candidate?.url === 'string' && candidate.url.trim() && typeof candidate?.localPath === 'string' && candidate.localPath.trim()) {
      existingByUrl.set(candidate.url.trim(), candidate);
    }
  }

  let endingSlideIndex = null;
  let endingHasFrame = false;
  for (const entry of Array.isArray(outline) ? outline : []) {
    if (!entry) {
      continue;
    }
    const frameTs = normalizeFrameTs(entry.frameTs);
    if (entry.type === 'ending' && Number.isInteger(entry.slideIndex)) {
      endingSlideIndex = entry.slideIndex;
      endingHasFrame = frameTs !== null;
    }
    const isCover = isCoverOutlineEntry(entry);
    if (isCover && coverSlideIndex === null && Number.isInteger(entry.slideIndex)) {
      coverSlideIndex = entry.slideIndex;
    }
    if (frameTs === null) {
      continue;
    }
    const requestedEntry = {
      slideIndex: Number.isInteger(entry.slideIndex) ? entry.slideIndex : 0,
      ts: frameTs,
      url: buildFrameUrl(frameTs),
    };
    requestedEntries.push(requestedEntry);
    if (isCover) {
      coverFrameUrls.push(requestedEntry.url);
    }
    const existingRequest = allFrameRequests.get(requestedEntry.url) || {
      ts: requestedEntry.ts,
      url: requestedEntry.url,
      isCoverCandidate: false,
    };
    existingRequest.ts = requestedEntry.ts;
    allFrameRequests.set(requestedEntry.url, existingRequest);
  }

  // 엔딩에 frameTs가 없으면 마지막 자막 시점 프레임으로 폴백 (엔딩 빈 카드 방지)
  if (endingSlideIndex !== null && !endingHasFrame) {
    const fallbackTs = resolveEndingFallbackTs(post.transcriptSegments);
    if (fallbackTs !== null) {
      const url = buildFrameUrl(fallbackTs);
      requestedEntries.push({ slideIndex: endingSlideIndex, ts: fallbackTs, url });
      const existingRequest = allFrameRequests.get(url) || { ts: fallbackTs, url, isCoverCandidate: false };
      existingRequest.ts = fallbackTs;
      allFrameRequests.set(url, existingRequest);
    }
  }

  // 커버 슬라이드가 없으면 후보 추출 자체를 스킵 (불필요한 ffmpeg 작업 방지 — 리뷰 결함2)
  const coverCandidateTimestamps = coverSlideIndex !== null
    ? buildCoverCandidateFrameTs(post.transcriptSegments)
    : [];
  const coverCandidateUrls = [];
  for (const ts of coverCandidateTimestamps) {
    const url = buildFrameUrl(ts);
    coverCandidateUrls.push(url);
    const existingRequest = allFrameRequests.get(url) || {
      ts,
      url,
      isCoverCandidate: false,
    };
    existingRequest.ts = ts;
    existingRequest.isCoverCandidate = true;
    allFrameRequests.set(url, existingRequest);
  }

  if (!allFrameRequests.size) {
    return { post, photoAssignments: new Map() };
  }

  const photoAssignments = new Map();
  const missingTs = [];
  const seenTs = new Set();

  for (const entry of requestedEntries) {
    const existing = existingByUrl.get(entry.url);
    if (existing && existing.localPath) {
      photoAssignments.set(entry.slideIndex, existing.localPath);
    }
  }

  for (const request of allFrameRequests.values()) {
    const existing = existingByUrl.get(request.url);
    if (existing && existing.localPath) {
      continue;
    }
    if (seenTs.has(request.ts)) {
      continue;
    }
    seenTs.add(request.ts);
    missingTs.push(request.ts);
  }

  let nextPost = post;
  if (missingTs.length) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'carousel-yt-frames-'));
    try {
      const extracted = await runJsonScript(
        path.join(__dirname, '..', 'scripts', 'yt-frames.mjs'),
        [post.input, tempDir, missingTs.map((ts) => String(ts)).join(',')],
        YT_FRAME_TIMEOUT_MS
      );
      const { assetsDir } = store.getPostPaths(post.id);
      await fsp.mkdir(assetsDir, { recursive: true });

      const additions = [];
      for (const frame of Array.isArray(extracted?.frames) ? extracted.frames : []) {
        const ts = normalizeFrameTs(frame && frame.ts);
        const sourcePath = typeof frame?.path === 'string' ? frame.path : '';
        if (ts === null || !sourcePath) {
          continue;
        }
        const baseName = path.basename(sourcePath) || `frame_${sanitizeFrameTs(ts)}.jpg`;
        const targetPath = path.join(assetsDir, baseName);
        await moveFile(sourcePath, targetPath);
        const request = allFrameRequests.get(buildFrameUrl(ts));
        additions.push({
          url: buildFrameUrl(ts),
          localPath: `assets/${path.basename(targetPath)}`,
          label: buildFrameCandidateLabel(ts, Boolean(request && request.isCoverCandidate)),
          selected: false,
          width: normalizeDimension(frame && frame.width),
          height: normalizeDimension(frame && frame.height),
        });
      }

      if (additions.length) {
        const merged = mergeImageCandidates(post.imageCandidates, additions);
        nextPost = await store.updatePost(post.id, { imageCandidates: merged });
        for (const candidate of merged) {
          if (candidate.localPath) {
            existingByUrl.set(candidate.url, candidate);
          }
        }
      }
    } finally {
      await cleanupDirectory(tempDir);
    }
  }

  for (const entry of requestedEntries) {
    const candidate = existingByUrl.get(entry.url) || findImageCandidateByUrl(nextPost.imageCandidates, entry.url);
    if (candidate && candidate.localPath) {
      photoAssignments.set(entry.slideIndex, candidate.localPath);
    }
  }

  if (coverSlideIndex !== null) {
    const postDir = store.getPostPaths(post.id).postDir;
    const faceDetectionTargets = resolveLocalImagePathsForUrls(
      nextPost.imageCandidates,
      postDir,
      coverFrameUrls.concat(coverCandidateUrls)
    );
    const faceAreas = await detectFaceAreas(faceDetectionTargets.map((target) => target.absolutePath));
    let bestFace = null;

    for (const target of faceDetectionTargets) {
      const maxArea = faceAreas.get(target.absolutePath);
      if (typeof maxArea !== 'number') {
        continue;
      }
      if (!bestFace || maxArea > bestFace.maxArea) {
        bestFace = {
          localPath: target.localPath,
          maxArea,
        };
      }
    }

    if (bestFace && bestFace.maxArea >= COVER_FACE_MIN_AREA) {
      photoAssignments.set(coverSlideIndex, bestFace.localPath);
    }
  }

  try {
    nextPost = await dedupeBodyFrames({ post: nextPost, outline, photoAssignments, store });
  } catch (error) {
    // 중복 제거는 품질 보강 — 실패해도 기존 배정으로 진행 (비차단)
  }

  try {
    nextPost = await rejectDocumentBodyFrames({ post: nextPost, outline, photoAssignments, store });
  } catch (error) {
    // 문서/텍스트 프레임 거부는 품질 보강 — 실패해도 기존 배정으로 진행 (비차단)
  }

  return {
    post: nextPost,
    photoAssignments,
  };
}

// 토킹헤드+화면공유형 분석 영상은 프레임 추출이 읽을 수 없는 문서 스크린샷(S-1 표·텍스트 벽)을
// 집는다. 문서로 분류된 body 프레임을 이미 추출된 비문서 후보(얼굴 프레임 등)로 교체한다. (재추출 X)
async function rejectDocumentBodyFrames({ post, outline, photoAssignments, store }) {
  const bodyIndices = [];
  for (const entry of Array.isArray(outline) ? outline : []) {
    if (!entry || entry.type !== 'body' || !Number.isInteger(entry.slideIndex)) {
      continue;
    }
    if (photoAssignments.has(entry.slideIndex)) {
      bodyIndices.push(entry.slideIndex);
    }
  }
  if (!bodyIndices.length) {
    return post;
  }

  const { postDir } = store.getPostPaths(post.id);
  const toAbs = (lp) => (path.isAbsolute(lp) ? lp : path.join(postDir, lp));
  const candidates = (post.imageCandidates || []).filter((c) => c && c.localPath);
  if (!candidates.length) {
    return post;
  }
  const absByLocal = new Map(candidates.map((c) => [c.localPath, toAbs(c.localPath)]));
  const docMap = await classifyFrameDocuments(Array.from(absByLocal.values()));
  if (!docMap.size) {
    return post;
  }
  const isDoc = (localPath) => {
    const abs = absByLocal.get(localPath);
    return abs ? docMap.get(abs) === true : false;
  };

  const used = new Set(photoAssignments.values());
  const cleanPool = candidates.map((c) => c.localPath).filter((lp) => !isDoc(lp));

  for (const slideIndex of bodyIndices) {
    const current = photoAssignments.get(slideIndex);
    if (!current || !isDoc(current)) {
      continue;
    }
    let pick = cleanPool.find((lp) => !used.has(lp));
    if (!pick) {
      pick = cleanPool.find((lp) => lp !== current);
    }
    if (pick) {
      photoAssignments.set(slideIndex, pick);
      used.add(pick);
    }
    // 비문서 후보가 없으면 그대로 둔다(플레이스홀더보다 나음, 비차단)
  }
  return post;
}

async function classifyFrameDocuments(imagePaths) {
  const targets = (Array.isArray(imagePaths) ? imagePaths : []).filter((p) => typeof p === 'string' && p);
  if (!targets.length) {
    return new Map();
  }
  return new Promise((resolve) => {
    const child = spawn('python3', [path.join(__dirname, '..', 'scripts', 'frame-quality.py')].concat(targets), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let finished = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), FRAME_HASH_TIMEOUT_MS);
    const finalize = (value) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(value instanceof Map ? value : new Map());
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => finalize(new Map()));
    child.on('close', (code) => {
      if (code !== 0) {
        finalize(new Map());
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const map = new Map();
        for (const [key, value] of Object.entries(parsed)) {
          map.set(key, Boolean(value && value.doc === true));
        }
        finalize(map);
      } catch (error) {
        finalize(new Map());
      }
    });
  });
}

// body 슬라이드에 배정된 프레임이 시각적으로 사실상 같은 화면이면(정적 인터뷰 미드샷 반복)
// ±45/90/150초 대안 프레임을 추출해 덜 비슷한 것으로 교체한다. (TASK-004)
async function dedupeBodyFrames({ post, outline, photoAssignments, store }) {
  const bodyEntries = [];
  for (const entry of Array.isArray(outline) ? outline : []) {
    if (!entry || entry.type !== 'body' || !Number.isInteger(entry.slideIndex)) {
      continue;
    }
    if (!photoAssignments.has(entry.slideIndex)) {
      continue;
    }
    bodyEntries.push({
      slideIndex: entry.slideIndex,
      ts: normalizeFrameTs(entry.frameTs),
    });
  }
  if (bodyEntries.length < 2) {
    return post;
  }

  const { postDir } = store.getPostPaths(post.id);
  const toAbs = (localPath) => (path.isAbsolute(localPath) ? localPath : path.join(postDir, localPath));
  const assignedPaths = bodyEntries.map((entry) => toAbs(photoAssignments.get(entry.slideIndex)));
  const hashes = await computeFrameHashes(Array.from(new Set(assignedPaths)));
  if (!hashes.size) {
    return post;
  }

  const keptHashes = [];
  const dupes = [];
  for (const entry of bodyEntries) {
    const hash = hashes.get(toAbs(photoAssignments.get(entry.slideIndex)));
    if (!hash) {
      continue;
    }
    if (keptHashes.some((kept) => hammingHex(kept, hash) <= FRAME_DUPE_HAMMING_MAX)) {
      dupes.push(entry);
    } else {
      keptHashes.push(hash);
    }
  }
  if (!dupes.length) {
    return post;
  }

  const maxTs = resolveEndingFallbackTs(post.transcriptSegments);
  const altRequests = new Map();
  for (const entry of dupes) {
    if (entry.ts === null) {
      continue;
    }
    for (const offset of FRAME_ALT_OFFSETS) {
      const altTs = roundGeneratedFrameTs(entry.ts + offset);
      if (altTs === null || altTs < 0 || (maxTs !== null && altTs > maxTs)) {
        continue;
      }
      const url = buildFrameUrl(altTs);
      if (!findImageCandidateByUrl(post.imageCandidates, url) && !altRequests.has(url)) {
        altRequests.set(url, altTs);
      }
    }
  }

  let nextPost = post;
  if (altRequests.size) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'carousel-yt-alt-'));
    try {
      const extracted = await runJsonScript(
        path.join(__dirname, '..', 'scripts', 'yt-frames.mjs'),
        [post.input, tempDir, Array.from(altRequests.values()).map(String).join(',')],
        YT_FRAME_TIMEOUT_MS
      );
      const { assetsDir } = store.getPostPaths(post.id);
      await fsp.mkdir(assetsDir, { recursive: true });
      const additions = [];
      for (const frame of Array.isArray(extracted?.frames) ? extracted.frames : []) {
        const ts = normalizeFrameTs(frame && frame.ts);
        const sourcePath = typeof frame?.path === 'string' ? frame.path : '';
        if (ts === null || !sourcePath) {
          continue;
        }
        const baseName = path.basename(sourcePath) || `frame_${sanitizeFrameTs(ts)}.jpg`;
        const targetPath = path.join(assetsDir, baseName);
        await moveFile(sourcePath, targetPath);
        additions.push({
          url: buildFrameUrl(ts),
          localPath: `assets/${path.basename(targetPath)}`,
          label: buildFrameCandidateLabel(ts, false),
          selected: false,
          width: normalizeDimension(frame && frame.width),
          height: normalizeDimension(frame && frame.height),
        });
      }
      if (additions.length) {
        nextPost = await store.updatePost(post.id, {
          imageCandidates: mergeImageCandidates(post.imageCandidates, additions),
        });
      }
    } finally {
      await cleanupDirectory(tempDir);
    }
  }

  const altPaths = [];
  const altLocalByUrl = new Map();
  for (const url of altRequests.keys()) {
    const candidate = findImageCandidateByUrl(nextPost.imageCandidates, url);
    if (candidate && candidate.localPath) {
      altLocalByUrl.set(url, candidate.localPath);
      altPaths.push(toAbs(candidate.localPath));
    }
  }
  const altHashes = await computeFrameHashes(altPaths);

  for (const entry of dupes) {
    if (entry.ts === null) {
      continue;
    }
    let best = null;
    for (const offset of FRAME_ALT_OFFSETS) {
      const altTs = roundGeneratedFrameTs(entry.ts + offset);
      if (altTs === null) {
        continue;
      }
      const localPath = altLocalByUrl.get(buildFrameUrl(altTs));
      if (!localPath) {
        continue;
      }
      const hash = altHashes.get(toAbs(localPath));
      if (!hash) {
        continue;
      }
      const minDistance = keptHashes.length
        ? Math.min(...keptHashes.map((kept) => hammingHex(kept, hash)))
        : Infinity;
      if (minDistance > FRAME_DUPE_HAMMING_MAX && (!best || minDistance > best.minDistance)) {
        best = { localPath, hash, minDistance };
      }
    }
    if (best) {
      photoAssignments.set(entry.slideIndex, best.localPath);
      keptHashes.push(best.hash);
    }
    // 대안도 전부 비슷하면(원샷 인터뷰) 원래 프레임 유지 — 교체 안 함
  }

  return nextPost;
}

async function computeFrameHashes(imagePaths) {
  const targets = (Array.isArray(imagePaths) ? imagePaths : []).filter((p) => typeof p === 'string' && p);
  if (!targets.length) {
    return new Map();
  }
  return new Promise((resolve) => {
    const child = spawn('python3', [path.join(__dirname, '..', 'scripts', 'frame-hash.py')].concat(targets), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let finished = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, FRAME_HASH_TIMEOUT_MS);
    const finalize = (value) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(value instanceof Map ? value : new Map());
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => finalize(new Map()));
    child.on('close', (code) => {
      if (code !== 0) {
        finalize(new Map());
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const map = new Map();
        for (const [key, value] of Object.entries(parsed || {})) {
          if (typeof value === 'string' && value) {
            map.set(key, value);
          }
        }
        finalize(map);
      } catch (error) {
        finalize(new Map());
      }
    });
  });
}

function hammingHex(a, b) {
  let distance = 0;
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  while (diff) {
    distance += Number(diff & 1n);
    diff >>= 1n;
  }
  return distance;
}

async function sourceOutlineOgImages({ post, outline, store }) {
  const itemByRef = new Map(
    (Array.isArray(post.traceItems) ? post.traceItems : []).map((item) => [item.ref, item])
  );
  const originCache = new Map();
  const downloadRequests = [];
  let fetchCount = 0;

  for (const entry of Array.isArray(outline) ? outline : []) {
    if (!entry) {
      continue;
    }
    const firstRef = Array.isArray(entry.itemRefs) ? entry.itemRefs.find((ref) => typeof ref === 'string' && ref.trim()) : null;
    if (!firstRef) {
      continue;
    }

    const item = itemByRef.get(firstRef);
    const originUrl = typeof item?.origin?.url === 'string' && item.origin.url.trim() ? item.origin.url.trim() : '';
    if (!originUrl) {
      continue;
    }

    if (!originCache.has(originUrl)) {
      if (fetchCount >= MAX_DIRECT_OG_IMAGES) {
        originCache.set(originUrl, null);
      } else {
        fetchCount += 1;
        originCache.set(originUrl, await fetchOgImage(originUrl));
      }
    }

    const ogUrl = originCache.get(originUrl);
    if (!ogUrl) {
      continue;
    }

    downloadRequests.push({
      slideIndex: Number.isInteger(entry.slideIndex) ? entry.slideIndex : 0,
      ogUrl,
      label: truncateLabel(item?.desc || '', 40),
    });
  }

  if (!downloadRequests.length) {
    return { post, photoAssignments: new Map() };
  }

  const existingByUrl = new Map();
  for (const candidate of Array.isArray(post.imageCandidates) ? post.imageCandidates : []) {
    if (typeof candidate?.url === 'string' && candidate.url.trim() && typeof candidate?.localPath === 'string' && candidate.localPath.trim()) {
      existingByUrl.set(candidate.url.trim(), candidate);
    }
  }

  const photoAssignments = new Map();
  const downloadUrls = [];
  const labelByUrl = new Map();
  const queued = new Set();

  for (const request of downloadRequests) {
    const existing = existingByUrl.get(request.ogUrl);
    if (existing && existing.localPath) {
      photoAssignments.set(request.slideIndex, existing.localPath);
      continue;
    }
    if (!queued.has(request.ogUrl)) {
      queued.add(request.ogUrl);
      downloadUrls.push(request.ogUrl);
      labelByUrl.set(request.ogUrl, request.label);
    }
  }

  let nextPost = post;
  if (downloadUrls.length) {
    const { assetsDir } = store.getPostPaths(post.id);
    const startIndex = getNextImageDownloadIndex(post.imageCandidates);
    const downloads = await downloadImagesLike(downloadUrls, assetsDir, startIndex);
    const additions = downloads
      .filter((item) => item.localPath)
      .map((item) => ({
        url: item.url,
        localPath: item.localPath,
        label: labelByUrl.get(item.url) || '',
        selected: false,
        width: item.width,
        height: item.height,
      }));

    if (additions.length) {
      const merged = mergeImageCandidates(post.imageCandidates, additions);
      nextPost = await store.updatePost(post.id, { imageCandidates: merged });
      for (const candidate of merged) {
        if (candidate.localPath) {
          existingByUrl.set(candidate.url, candidate);
        }
      }
    }
  }

  for (const request of downloadRequests) {
    const candidate = existingByUrl.get(request.ogUrl) || findImageCandidateByUrl(nextPost.imageCandidates, request.ogUrl);
    if (candidate && candidate.localPath) {
      photoAssignments.set(request.slideIndex, candidate.localPath);
    }
  }

  return {
    post: nextPost,
    photoAssignments,
  };
}

function applyDirectPhotoAssignments(slides, photoAssignments) {
  if (!(photoAssignments instanceof Map) || !photoAssignments.size) {
    return slides;
  }

  return slides.map((slide, index) => {
    if (!slide || !photoAssignments.has(index)) {
      return slide;
    }
    return {
      ...slide,
      photo: photoAssignments.get(index) || slide.photo,
    };
  });
}

// 본문/커버 슬라이드가 같은 사진을 반복하지 않도록 후보 풀에서 서로 다른 이미지를 배분한다.
// 단일 출처 기사는 og:image 한 장으로 전 슬라이드가 덮이는 문제(applyDirectPhotoAssignments)를
// 여기서 바로잡는다. 후보가 슬라이드보다 적으면 가장 적게 쓰인 사진을 재사용한다.
function distinctifyBodyPhotos(slides, imageCandidates) {
  const pool = [];
  const inPool = new Set();
  for (const candidate of Array.isArray(imageCandidates) ? imageCandidates : []) {
    const localPath = candidate && typeof candidate.localPath === 'string' ? candidate.localPath.trim() : '';
    if (localPath && !inPool.has(localPath)) {
      inPool.add(localPath);
      pool.push(localPath);
    }
  }
  if (pool.length <= 1) {
    return slides;
  }

  const usedCount = new Map();
  const bump = (localPath) => usedCount.set(localPath, (usedCount.get(localPath) || 0) + 1);
  const nextImage = () => {
    for (const localPath of pool) {
      if (!usedCount.has(localPath)) {
        return localPath;
      }
    }
    let best = pool[0];
    let bestCount = usedCount.get(pool[0]) || 0;
    for (const localPath of pool) {
      const count = usedCount.get(localPath) || 0;
      if (count < bestCount) {
        bestCount = count;
        best = localPath;
      }
    }
    return best;
  };

  return slides.map((slide) => {
    if (!slide || slide.type === 'ending') {
      return slide;
    }
    const current = typeof slide.photo === 'string' ? slide.photo.trim() : '';
    // 이미 풀에 있는 서로 다른 사진이면 그대로 유지(라이터/내용 매칭 존중).
    if (current && inPool.has(current) && !usedCount.has(current)) {
      bump(current);
      return slide;
    }
    // null·중복·풀 밖 경로면 안 쓰인 사진으로 재배정.
    const assigned = nextImage();
    bump(assigned);
    return { ...slide, photo: assigned };
  });
}

function normalizeVerifyResults(values, slides) {
  const rawMap = new Map();
  if (Array.isArray(values)) {
    for (const item of values) {
      if (!Number.isInteger(item && item.slideIndex) || item.slideIndex < 0 || item.slideIndex >= slides.length) {
        continue;
      }
      rawMap.set(item.slideIndex, {
        slideIndex: item.slideIndex,
        ok: Boolean(item.ok),
        issues: uniqueStrings(Array.isArray(item.issues) ? item.issues : []),
        fix: normalizeVerifyFix(item.fix, slides[item.slideIndex].type),
      });
    }
  }

  return slides.map((slide, index) => {
    const current = rawMap.get(index) || {
      slideIndex: index,
      ok: !slide.overflow,
      issues: [],
      fix: null,
    };
    const issues = current.issues.slice();
    if (slide.overflow && !issues.includes('오버플로')) {
      issues.push('오버플로');
    }
    if (!current.ok && !issues.length) {
      issues.push('검수에서 수정이 필요하다고 판단했습니다');
    }
    return {
      slideIndex: index,
      ok: current.ok && !slide.overflow && issues.length === 0,
      issues,
      fix: current.ok && !slide.overflow && issues.length === 0 ? null : current.fix,
    };
  });
}

function normalizeVerifyFix(value, type) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  if (type === 'body') {
    return {
      subtitle: typeof value.subtitle === 'string' ? value.subtitle : '',
      paragraphs: Array.isArray(value.paragraphs)
        ? value.paragraphs.filter((item) => typeof item === 'string')
        : [],
    };
  }

  if (type === 'ending') {
    return {
      headline: typeof value.headline === 'string' ? value.headline : '',
      closing: typeof value.closing === 'string' ? value.closing : null,
    };
  }

  return {
    headline: typeof value.headline === 'string' ? value.headline : '',
    kicker: typeof value.kicker === 'string' ? value.kicker : null,
  };
}

async function applyVerificationFixes(store, post, failedSlides) {
  const fixMap = new Map(failedSlides.map((item) => [item.slideIndex, item.fix]));
  const slides = post.slides.map((slide, index) => {
    if (!fixMap.has(index)) {
      return slide;
    }

    return {
      ...slide,
      text: applyFixToSlideText(slide, fixMap.get(index)),
      dirty: true,
      overflow: false,
      verifyFailed: false,
    };
  });

  return store.updatePost(post.id, { slides });
}

function applyFixToSlideText(slide, fix) {
  if (slide.type === 'body') {
    return {
      ...slide.text,
      subtitle: typeof fix.subtitle === 'string' ? fix.subtitle : slide.text.subtitle,
      paragraphs: Array.isArray(fix.paragraphs) ? fix.paragraphs : slide.text.paragraphs,
    };
  }

  if (slide.type === 'ending') {
    return {
      ...slide.text,
      headline: typeof fix.headline === 'string' ? fix.headline : slide.text.headline,
      closing: typeof fix.closing === 'string' ? fix.closing : slide.text.closing,
    };
  }

  return {
    ...slide.text,
    headline: typeof fix.headline === 'string' ? fix.headline : slide.text.headline,
    kicker: typeof fix.kicker === 'string' ? fix.kicker : slide.text.kicker,
  };
}

async function clearVerifyFailures(store, post, verify) {
  const slides = post.slides.map((slide) => ({
    ...slide,
    verifyFailed: false,
  }));
  return store.updatePost(post.id, {
    slides,
    verify,
  });
}

async function markVerifyFailures(store, post, verify) {
  const failedIndexes = new Set(verify.results.filter((item) => !item.ok).map((item) => item.slideIndex));
  const slides = post.slides.map((slide, index) => ({
    ...slide,
    verifyFailed: failedIndexes.has(index),
  }));
  return store.updatePost(post.id, {
    slides,
    verify,
  });
}

function mergeRenderFailuresIntoResults(post, results, failedById) {
  return results.map((item) => {
    const slide = post.slides[item.slideIndex];
    if (!slide || !failedById.has(slide.id)) {
      return item;
    }
    return {
      ...item,
      ok: false,
      issues: uniqueStrings(item.issues.concat(`렌더 실패: ${failedById.get(slide.id)}`)),
    };
  });
}

function buildVerifyRetryMessage(results, round, issueLabel) {
  const slideNumbers = results.map((item) => item.slideIndex + 1).join(', ');
  return `슬라이드 ${slideNumbers} 재집필 중 (검수 ${round}/2)${issueLabel ? ` — ${issueLabel}` : ''}`;
}

function describeVerifyIssues(results) {
  const labels = [];
  if (results.some((item) => item.issues.includes('오버플로'))) {
    labels.push('오버플로');
  }
  if (results.some((item) => item.issues.some((issue) => issue !== '오버플로'))) {
    labels.push('근거 불일치');
  }
  return labels.join('·');
}

function resolveSourceNames({ sourceNames = [], outline = [], items = [] }) {
  const explicit = uniqueStrings(sourceNames);
  if (explicit.length) {
    return explicit;
  }

  const refSet = new Set();
  for (const entry of Array.isArray(outline) ? outline : []) {
    for (const ref of Array.isArray(entry?.itemRefs) ? entry.itemRefs : []) {
      if (typeof ref === 'string' && ref.trim()) {
        refSet.add(ref.trim());
      }
    }
  }

  const names = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!refSet.has(item?.ref)) {
      continue;
    }
    if (typeof item?.origin?.name === 'string' && item.origin.name.trim()) {
      names.push(item.origin.name.trim());
    }
  }
  return uniqueStrings(names);
}

function ensureCaptionSourceLine(caption, sourceNames) {
  const normalizedCaption = typeof caption === 'string' ? caption.replace(/\s+$/, '') : '';
  if (/(^|\n)\s*출처\s*:/m.test(normalizedCaption)) {
    return normalizedCaption;
  }

  const names = uniqueStrings(sourceNames);
  const line = `출처: ${names.length ? names.join(', ') : '없음'}`;
  return normalizedCaption ? `${normalizedCaption}\n\n${line}` : line;
}

function normalizeSlideType(type, role, index) {
  if (type === 'cover' || role === 'cover' || index === 0) {
    return 'cover';
  }
  if (type === 'ending' || role === 'ending') {
    return 'ending';
  }
  return 'body';
}

function inferRole(type, index) {
  if (type === 'cover' || index === 0) {
    return 'cover';
  }
  if (type === 'ending') {
    return 'ending';
  }
  return index === 1 ? 'context' : 'body';
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function normalizeFrameTs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function resolvePhotoFromIndex(photoIndex, imageCandidates) {
  if (photoIndex === null || photoIndex === undefined) {
    return null;
  }

  if (Number.isInteger(photoIndex) && imageCandidates[photoIndex]) {
    return imageCandidates[photoIndex].localPath || null;
  }

  if (typeof photoIndex === 'string' && photoIndex.trim()) {
    return photoIndex.trim();
  }

  return null;
}

function hasTranscriptSegments(segments) {
  return Array.isArray(segments) && segments.some((segment) => normalizeFrameTs(segment && segment.t) !== null);
}

function isCoverOutlineEntry(entry) {
  return Boolean(entry && (entry.type === 'cover' || entry.role === 'cover'));
}

function resolveEndingFallbackTs(segments) {
  // 마지막 자막 세그먼트 시점 = 영상 마무리 장면 (엔딩 카드용)
  let maxTs = null;
  for (const segment of Array.isArray(segments) ? segments : []) {
    const ts = normalizeFrameTs(segment && segment.t);
    if (ts !== null && (maxTs === null || ts > maxTs)) {
      maxTs = ts;
    }
  }
  return maxTs !== null && maxTs > 0 ? maxTs : null;
}

function buildCoverCandidateFrameTs(segments) {
  let maxTs = null;

  for (const segment of Array.isArray(segments) ? segments : []) {
    const ts = normalizeFrameTs(segment && segment.t);
    if (ts === null) {
      continue;
    }
    if (maxTs === null || ts > maxTs) {
      maxTs = ts;
    }
  }

  if (maxTs === null || maxTs <= 0) {
    return [];
  }

  const values = [];
  const seen = new Set();
  for (let index = 0; index < COVER_CANDIDATE_FRAME_COUNT; index += 1) {
    const ratio = COVER_CANDIDATE_FRAME_COUNT <= 1
      ? COVER_CANDIDATE_START_RATIO
      : COVER_CANDIDATE_START_RATIO
        + (((COVER_CANDIDATE_END_RATIO - COVER_CANDIDATE_START_RATIO) * index) / (COVER_CANDIDATE_FRAME_COUNT - 1));
    const ts = roundGeneratedFrameTs(maxTs * ratio);
    if (ts === null || seen.has(ts)) {
      continue;
    }
    seen.add(ts);
    values.push(ts);
  }
  return values;
}

function isYouTubeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  try {
    const hostname = new URL(value).hostname;
    return /(^|\.)(youtube\.com|youtu\.be)$/i.test(hostname);
  } catch (error) {
    return false;
  }
}

function buildFrameUrl(ts) {
  return `frame://${String(ts)}`;
}

function roundGeneratedFrameTs(value) {
  const ts = normalizeFrameTs(value);
  if (ts === null) {
    return null;
  }
  return Number(ts.toFixed(3));
}

function buildFrameCandidateLabel(ts, isCoverCandidate) {
  return `영상 ${formatTimestampLabel(ts)} 장면${isCoverCandidate ? ' (커버후보)' : ''}`;
}

function sanitizeFrameTs(ts) {
  return String(ts).replace(/[^\d.]/g, '').replace(/\./g, '_');
}

function formatTimestampLabel(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function truncateLabel(value, limit) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return '';
  }
  return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeDimension(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function findImageCandidateByUrl(imageCandidates, url) {
  for (const candidate of Array.isArray(imageCandidates) ? imageCandidates : []) {
    if (candidate && candidate.url === url) {
      return candidate;
    }
  }
  return null;
}

function mergeImageCandidates(existing, additions) {
  const result = Array.isArray(existing)
    ? existing.map((candidate) => ({ ...candidate }))
    : [];
  const byUrl = new Map();
  const byLocalPath = new Map();

  for (const candidate of result) {
    if (typeof candidate?.url === 'string' && candidate.url.trim()) {
      byUrl.set(candidate.url.trim(), candidate);
    }
    if (typeof candidate?.localPath === 'string' && candidate.localPath.trim()) {
      byLocalPath.set(candidate.localPath.trim(), candidate);
    }
  }

  for (const addition of Array.isArray(additions) ? additions : []) {
    if (!addition || typeof addition !== 'object') {
      continue;
    }

    const byUrlCandidate = typeof addition.url === 'string' && addition.url.trim()
      ? byUrl.get(addition.url.trim())
      : null;
    const byLocalPathCandidate = typeof addition.localPath === 'string' && addition.localPath.trim()
      ? byLocalPath.get(addition.localPath.trim())
      : null;
    const current = byUrlCandidate || byLocalPathCandidate;

    if (current) {
      if (!current.label && addition.label) {
        current.label = addition.label;
      }
      if (!current.localPath && addition.localPath) {
        current.localPath = addition.localPath;
      }
      if (!current.width && addition.width) {
        current.width = addition.width;
      }
      if (!current.height && addition.height) {
        current.height = addition.height;
      }
      continue;
    }

    const next = {
      url: typeof addition.url === 'string' ? addition.url : '',
      localPath: typeof addition.localPath === 'string' && addition.localPath.trim() ? addition.localPath.trim() : null,
      label: typeof addition.label === 'string' ? addition.label : '',
      selected: Boolean(addition.selected),
      width: normalizeDimension(addition.width),
      height: normalizeDimension(addition.height),
    };
    result.push(next);
    if (next.url) {
      byUrl.set(next.url, next);
    }
    if (next.localPath) {
      byLocalPath.set(next.localPath, next);
    }
  }

  return result;
}

async function hasCommand(command) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-lc', `command -v ${command} >/dev/null 2>&1`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function resolveLocalImagePathsForUrls(imageCandidates, postDir, urls) {
  const result = [];
  const seen = new Set();

  for (const url of Array.isArray(urls) ? urls : []) {
    if (typeof url !== 'string' || !url) {
      continue;
    }
    const candidate = findImageCandidateByUrl(imageCandidates, url);
    if (!candidate || typeof candidate.localPath !== 'string' || !candidate.localPath.trim()) {
      continue;
    }
    const localPath = candidate.localPath.trim();
    const absolutePath = path.isAbsolute(localPath) ? localPath : path.join(postDir, localPath);
    if (seen.has(absolutePath)) {
      continue;
    }
    seen.add(absolutePath);
    result.push({
      url,
      localPath,
      absolutePath,
    });
  }

  return result;
}

async function detectFaceAreas(imagePaths) {
  if (!Array.isArray(imagePaths) || !imagePaths.length) {
    return new Map();
  }

  if (!(await hasExecutableFile(SWIFT_BIN_PATH))) {
    return new Map();
  }

  return new Promise((resolve) => {
    const child = spawn(SWIFT_BIN_PATH, [path.join(__dirname, '..', 'scripts', 'face-detect.swift')].concat(imagePaths), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let finished = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FACE_DETECT_TIMEOUT_MS);

    const finalize = (value) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(value instanceof Map ? value : new Map());
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => finalize(new Map()));
    child.on('close', (code) => {
      if (code !== 0 || timedOut) {
        finalize(new Map());
        return;
      }
      finalize(parseFaceDetectionOutput(stdout));
    });
  });
}

async function hasExecutableFile(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    await fsp.access(filePath, fs.constants.X_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function parseFaceDetectionOutput(stdout) {
  const result = new Map();

  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.path !== 'string' || !parsed.path) {
        continue;
      }
      result.set(parsed.path, normalizeFaceArea(parsed.maxArea));
    } catch (error) {
      continue; // 한 줄 파싱 실패가 전체 감지 결과를 버리지 않게 (리뷰 결함1)
    }
  }

  return result;
}

function normalizeFaceArea(value) {
  const area = Number(value);
  return Number.isFinite(area) && area >= 0 ? area : 0;
}

async function runJsonScript(scriptPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath].concat(args), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finalize = (handler) => (value) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      handler(value);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', finalize(reject));
    child.on('close', finalize((code) => {
      if (code !== 0) {
        reject(new Error(timedOut ? '타임아웃' : (stderr.trim() || stdout.trim() || '실행 실패')));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    }));
  });
}

async function cleanupDirectory(targetPath) {
  if (!targetPath) {
    return;
  }
  try {
    await fsp.rm(targetPath, { recursive: true, force: true });
  } catch (error) {
    // ignore cleanup failures
  }
}

async function moveFile(sourcePath, targetPath) {
  try {
    await fsp.rename(sourcePath, targetPath);
  } catch (error) {
    if (error && error.code !== 'EXDEV') {
      throw error;
    }
    await fsp.copyFile(sourcePath, targetPath);
    await fsp.unlink(sourcePath).catch(() => {});
  }
}

function getNextImageDownloadIndex(imageCandidates) {
  return (Array.isArray(imageCandidates) ? imageCandidates.length : 0) + 1;
}

async function downloadImagesLike(urls, destDir, startIndex) {
  await fsp.mkdir(destDir, { recursive: true });
  const results = [];
  let offset = 0;

  for (const url of Array.isArray(urls) ? urls : []) {
    offset += 1;
    try {
      const file = await downloadImageLike(url, destDir, startIndex + offset - 1);
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

async function downloadImageLike(url, destDir, index, redirectCount = 0) {
  const response = await requestUrl(url, { maxBytes: MAX_IMAGE_BYTES });

  if (isRedirect(response.statusCode)) {
    if (redirectCount >= MAX_REDIRECTS || !response.headers.location) {
      throw new Error('Image redirect limit exceeded');
    }
    const nextUrl = absoluteUrl(url, response.headers.location);
    return downloadImageLike(nextUrl, destDir, index, redirectCount + 1);
  }

  if (response.statusCode >= 400) {
    throw new Error(`Image fetch failed: ${response.statusCode}`);
  }

  const contentType = String(response.contentType || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error('Not an image');
  }

  const extension = inferImageExtension(contentType, url);
  const fileName = `img_${String(index).padStart(2, '0')}.${extension}`;
  const targetPath = path.join(destDir, fileName);
  await fsp.writeFile(targetPath, response.body);

  return {
    url,
    localPath: `assets/${path.basename(targetPath)}`,
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

    request.setTimeout(options.timeoutMs || 15000, () => {
      request.destroy(new Error('Request timeout'));
    });
    request.on('error', reject);
    request.end();
  });
}

function isRedirect(statusCode) {
  return statusCode >= 300 && statusCode < 400;
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

function createStageError(stage, message) {
  const error = new Error(message);
  error.failedStage = stage;
  error.resumeStage = stage;
  return error;
}

function normalizeStage(value) {
  if (value === 'collecting' || value === 'writing' || value === 'rendering' || value === 'verifying') {
    return value;
  }
  return 'collecting';
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = {
  createJobManager,
};
