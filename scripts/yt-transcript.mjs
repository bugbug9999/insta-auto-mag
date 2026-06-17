#!/usr/bin/env node
// 유튜브 자막을 "브라우저 안에서" 추출 — AI 확장프로그램과 같은 방식.
// 페이지 자신의 captionTracks(pot 토큰 포함 서명된 URL)를 페이지 컨텍스트에서 fetch하므로
// 서버측 익명 호출과 달리 429/빈응답에 안 걸린다.
// 사용: node scripts/yt-transcript.mjs <유튜브URL>  → stdout JSON {lang, text, source}
// segments:[{t,text}]가 추가로 포함될 수 있다.
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const DONGSAENG = path.join(os.homedir(), 'dongsaeng');
const require = createRequire(path.join(DONGSAENG, 'package.json'));
const { chromium } = require('playwright');

const videoUrl = process.argv[2];
if (!videoUrl || !/youtube\.com|youtu\.be/.test(videoUrl)) {
  console.error('유튜브 URL이 아닙니다');
  process.exit(2);
}

const context = await chromium.launchPersistentContext(path.join(DONGSAENG, 'profile'), {
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--mute-audio'],
});
try {
  const page = await context.newPage();

  // 플레이어가 자막을 실제 요청할 때 붙이는 서명(pot) 포함 URL을 가로챈다 — 확장프로그램과 같은 원리
  let capturedUrl = null;
  let capturedBody = null;
  // 스크립트 패널이 부르는 내부 API(get_transcript) 응답도 가로챈다 —
  // 유튜브가 패널 DOM을 A/B(modern_transcript_view)로 바꿔 innerText가 비는 경우의 주 경로.
  let transcriptJson = null;
  page.on('response', async (res) => {
    const url = res.url();
    if (!transcriptJson && url.includes('/youtubei/v1/get_transcript')) {
      try {
        const json = await res.json();
        if (json) transcriptJson = json;
      } catch (error) { /* ignore */ }
      return;
    }
    if (capturedBody || !url.includes('/api/timedtext')) return;
    try {
      const body = await res.text();
      if (body) {
        capturedUrl = url;
        capturedBody = body;
      }
    } catch (error) { /* ignore */ }
  });

  await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('#description', { timeout: 15000 }).catch(() => {});

  // 유튜브 자체 '스크립트 표시' 패널 사용 (확장프로그램들이 쓰는 그 경로) —
  // 재생·코덱·로그인 불필요. 설명란 펼침 → 스크립트 버튼 클릭 → 세그먼트 DOM 추출.
  await page.locator('#description tp-yt-paper-button#expand, #expand').first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  const transcriptButton = page.locator('ytd-video-description-transcript-section-renderer button').first();
  if (!(await transcriptButton.count())) {
    console.error('자막 추출 실패: 이 영상엔 스크립트 패널이 없음 (자막 없는 영상)');
    process.exit(3);
  }
  await transcriptButton.click({ timeout: 5000 }).catch(() => {});
  // get_transcript 응답 또는 구형 DOM 세그먼트 중 먼저 오는 쪽을 기다린다
  for (let i = 0; i < 30 && !transcriptJson; i += 1) {
    if (await page.locator('ytd-transcript-segment-renderer').count()) break;
    await page.waitForTimeout(500);
  }

  // 주 경로: get_transcript JSON에서 segments 직접 추출 (DOM A/B 변경에 면역)
  if (transcriptJson) {
    const segRenderers = [];
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 30) return;
      if (node.transcriptSegmentRenderer) segRenderers.push(node.transcriptSegmentRenderer);
      for (const key of Object.keys(node)) walk(node[key], depth + 1);
    };
    walk(transcriptJson);
    const segments = [];
    const textParts = [];
    for (const seg of segRenderers) {
      const text = (seg.snippet?.runs || []).map((r) => r.text || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      textParts.push(text);
      const startMs = Number(seg.startMs);
      if (Number.isFinite(startMs) && segments.length < 400) {
        segments.push({ t: Math.max(0, Math.floor(startMs / 1000)), text });
      }
    }
    const fullText = textParts.join(' ').replace(/\s+/g, ' ').trim();
    if (fullText.length > 50) {
      process.stdout.write(JSON.stringify({
        lang: '원어(스크립트 패널)',
        text: fullText.slice(0, 12000),
        source: 'transcript-api',
        segments,
      }));
      process.exit(0);
    }
  }

  // 패널 innerText에서 타임스탬프/접근성 줄을 걸러 본문만 추출 (DOM 컴포넌트명 변경에 강함)
  // 타임스탬프 줄은 버리지 않고 다음 본문 줄과 짝지어 segments로도 보존한다.
  const panel = await page.evaluate(() => {
    const parseTimestamp = (value) => {
      const parts = value.split(':').map((part) => Number(part));
      if (!parts.every(Number.isFinite)) return null;
      if (parts.length === 2) return (parts[0] * 60) + parts[1];
      if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
      return null;
    };

    const panels = Array.from(document.querySelectorAll('ytd-engagement-panel-section-list-renderer'));
    const tp = panels.find((p) => (p.getAttribute('target-id') || '').includes('transcript') || p.innerText.includes('스크립트'));
    if (!tp) return { text: '', segments: [] };

    const lines = tp.innerText.split('\n');
    const segments = [];
    const textLines = [];
    let pendingTimestamp = null;

    for (const line of lines) {
      const t = line.trim();
      if (!t || t === '스크립트' || t === '스크립트 검색' || t === 'Transcript') continue;
      if (/^\d+(분|초|시간)( \d+(분|초))?$/.test(t)) continue; // 18초, 1분 2초
      if (/^\d+:\d{2}(:\d{2})?$/.test(t)) {                    // 0:18, 1:02:33
        pendingTimestamp = parseTimestamp(t);
        continue;
      }
      textLines.push(t);
      if (pendingTimestamp !== null && segments.length < 400) {
        segments.push({ t: pendingTimestamp, text: t });
      }
      pendingTimestamp = null;
    }

    return { text: textLines.join(' '), segments };
  });

  if (panel.text && panel.text.length > 50) {
    process.stdout.write(JSON.stringify({
      lang: '원어(스크립트 패널)',
      text: panel.text.replace(/\s+/g, ' ').slice(0, 12000),
      source: 'transcript-panel',
      segments: panel.segments.slice(0, 400),
    }));
    process.exit(0);
  }

  if (!capturedBody) {
    console.error('자막 추출 실패: 스크립트 패널이 비어 있음');
    process.exit(3);
  }

  const parseEvents = (raw) => {
    try {
      const data = JSON.parse(raw);
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
        .trim();
      return { text, segments };
    } catch (error) {
      return { text: '', segments: [] };
    }
  };

  const langMatch = capturedUrl.match(/[?&]lang=([a-zA-Z-]+)/);
  let lang = langMatch ? langMatch[1] : 'unknown';
  let { text, segments } = parseEvents(capturedBody);

  // 한국어가 아니면, 가로챈 서명 URL에 tlang=ko를 붙여 페이지 컨텍스트에서 번역본 재요청
  if (text && !lang.startsWith('ko')) {
    const koUrl = `${capturedUrl}${capturedUrl.includes('tlang=') ? '' : '&tlang=ko'}`;
    const koText = await page.evaluate(async (u) => {
      try {
        const res = await fetch(u, { credentials: 'include' });
        if (!res.ok) return '';
        return await res.text();
      } catch (error) {
        return '';
      }
    }, koUrl);
    const parsed = parseEvents(koText);
    if (parsed.text) {
      text = parsed.text;
      segments = parsed.segments;
      lang = `${lang}→한국어 자동번역`;
    }
  }

  if (!text) {
    console.error('자막 추출 실패: 빈 자막');
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({ lang, text: text.slice(0, 12000), source: 'browser', segments }));
} finally {
  await context.close();
}
