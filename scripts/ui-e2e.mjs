#!/usr/bin/env node
// UI 클릭스루 e2e: 대시보드 URL 입력 → 소스탭 자동분석 → CTA → 앵글 → 선택 → 카드 생성 확인
// 스크린샷을 /tmp/uiqa_*.png 로 남긴다 (비주얼 QA 게이트용)
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const DONGSAENG = path.join(os.homedir(), 'dongsaeng');
const require = createRequire(path.join(DONGSAENG, 'package.json'));
const { chromium } = require('playwright');

const URL = process.argv[2] || 'https://www.youtube.com/watch?v=D_1j5dVWNYI';
const BOARD = 'http://127.0.0.1:3080';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const shot = (name) => page.screenshot({ path: `/tmp/uiqa_${name}.png`, fullPage: false });

try {
  // 1. 대시보드 — URL 입력하면 소스탭으로 리다이렉트되는지
  await page.goto(BOARD, { waitUntil: 'networkidle' });
  await shot('01_dashboard');

  const dashInput = page.locator('textarea, input[type="text"]').first();
  await dashInput.fill(URL);
  await page.waitForTimeout(400);
  await shot('02_dashboard_url_detected');

  // 생성 버튼 클릭 → 소스탭 전환 + 자동 분석 기대
  const goButton = page.locator('button', { hasText: /생성|분석|소스/ }).first();
  await goButton.click();
  await page.waitForTimeout(1500);
  await shot('03_after_submit');

  // 2. 분석 완료 대기 (최대 7분) — trace-cta 등장이 완료 신호
  await page.waitForSelector('.trace-cta', { timeout: 420000 });
  await shot('04_analysis_done');

  // 3. CTA 클릭 → 앵글 로딩
  await page.click('[data-action="open-trace-angle-panel"]');
  await page.waitForTimeout(1200);
  await shot('05_angle_loading');

  // 4. 앵글 카드 등장 대기 (최대 4분)
  await page.waitForSelector('[data-action="create-angle-post"]', { timeout: 240000 });
  await page.locator('.trace-angle-grid').first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await shot('06_angle_cards');

  // 5. 첫 앵글 선택 → 대시보드 카드 생성
  await page.click('[data-action="create-angle-post"]');
  await page.waitForTimeout(2500);
  await shot('07_post_created');

  console.log('UI_E2E_OK');
} catch (error) {
  await shot('99_failure');
  console.error('UI_E2E_FAIL:', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
