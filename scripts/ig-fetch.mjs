#!/usr/bin/env node
// 인스타그램 포스트의 캐러셀 전체 미디어를 dongsaeng 로그인 세션으로 가져온다.
// 사용: node scripts/ig-fetch.mjs <포스트URL>  → stdout에 JSON 한 덩어리
// dongsaeng(~/dongsaeng)의 playwright + 영구 프로필(로그인 세션)을 재사용한다.
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const DONGSAENG = path.join(os.homedir(), 'dongsaeng');
const require = createRequire(path.join(DONGSAENG, 'package.json'));
const { chromium } = require('playwright');

const postUrl = process.argv[2];
const match = postUrl && postUrl.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel)\/([A-Za-z0-9_-]+)/);
if (!match) {
  console.error('인스타그램 포스트 URL이 아닙니다');
  process.exit(2);
}
const shortcode = match[1];

const context = await chromium.launchPersistentContext(path.join(DONGSAENG, 'profile'), {
  headless: true,
  args: ['--disable-blink-features=AutomationControlled'],
});
try {
  // 포스트 페이지가 스스로 부르는 내부 API/GraphQL 응답을 가로채 미디어 데이터를 얻는다
  const page = await context.newPage();
  let item = null;

  const findMedia = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 24) return null;
    if ((node.carousel_media || node.image_versions2) && node.code === shortcode) return node;
    for (const key of Object.keys(node)) {
      const found = findMedia(node[key], depth + 1);
      if (found) return found;
    }
    return null;
  };

  page.on('response', async (res) => {
    if (item) return;
    const url = res.url();
    if (!/instagram\.com\/.*(graphql|api\/v1\/)/.test(url)) return;
    try {
      const json = await res.json();
      const found = findMedia(json);
      if (found) item = found;
    } catch (error) { /* JSON 아닌 응답 무시 */ }
  });

  await page.goto(`https://www.instagram.com/p/${shortcode}/`, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  // networkidle 실패해도 응답은 이미 수집됐을 수 있음 — 짧게 더 대기
  for (let i = 0; i < 3 && !item; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!item) {
    // 주 경로: 미디어 데이터는 초기 HTML의 <script type="application/json"> 임베디드 JSON에 있다 (실측)
    const html = await page.content();
    const blocks = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g) || [];
    for (const block of blocks) {
      if (!block.includes('image_versions2')) continue;
      const inner = block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
      try {
        const found = findMedia(JSON.parse(inner));
        if (found) { item = found; break; }
      } catch (error) { /* skip */ }
    }
  }

  if (!item) {
    console.error('미디어 데이터를 찾을 수 없습니다 (로그인 만료 또는 비공개)');
    process.exit(4);
  }

  const pickImage = (m) => {
    const c = m.image_versions2?.candidates;
    return c && c.length ? { url: c[0].url, width: c[0].width, height: c[0].height } : null;
  };
  const toMedia = (m) => {
    const isVideo = m.media_type === 2 || !!m.video_versions;
    const img = pickImage(m);
    return {
      type: isVideo ? 'video' : 'image',
      imageUrl: img ? img.url : null,
      videoUrl: isVideo && m.video_versions && m.video_versions.length ? m.video_versions[0].url : null,
      width: img ? img.width : null,
      height: img ? img.height : null,
    };
  };

  const media = item.carousel_media ? item.carousel_media.map(toMedia) : [toMedia(item)];
  const caption = item.caption?.text || '';
  const username = item.user?.username || '';
  process.stdout.write(JSON.stringify({ shortcode, username, caption, mediaCount: media.length, media }));
} finally {
  await context.close();
}
