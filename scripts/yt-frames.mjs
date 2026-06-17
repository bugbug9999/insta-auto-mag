#!/usr/bin/env node
// 유튜브 영상에서 타임스탬프별 프레임을 추출한다.
// 사용: node scripts/yt-frames.mjs <유튜브URL> <outDir> <ts1,ts2,...>  → stdout JSON {frames:[{ts, path, width, height}]}
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const videoUrl = process.argv[2];
const outDir = process.argv[3];
const tsArg = process.argv[4] || '';

if (!videoUrl || !/youtube\.com|youtu\.be/.test(videoUrl) || !outDir) {
  console.error('사용법: node scripts/yt-frames.mjs <유튜브URL> <outDir> <ts1,ts2,...>');
  process.exit(2);
}

const parseVideoId = (input) => {
  try {
    const url = new URL(input);
    if (url.hostname === 'youtu.be') {
      return url.pathname.split('/').filter(Boolean)[0] || null;
    }
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const parts = url.pathname.split('/').filter(Boolean);
    const marker = parts.findIndex((part) => ['embed', 'shorts', 'live', 'v'].includes(part));
    if (marker >= 0 && parts[marker + 1]) return parts[marker + 1];
  } catch (error) {
    return null;
  }
  return null;
};

const parseTimestampList = (input) => input
  .split(',')
  .map((part) => part.trim())
  .filter(Boolean)
  .map((raw) => ({ raw, ts: Number(raw) }))
  .filter(({ ts }) => Number.isFinite(ts) && ts >= 0);

const run = (command, args, { timeout = 0 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let finished = false;
  let timer = null;
  let timedOut = false;

  const finalize = (result) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    resolve(result);
  };

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('error', (error) => {
    if (timer) clearTimeout(timer);
    reject(error);
  });
  child.on('close', (code, signal) => {
    finalize({ code, signal, stdout, stderr, timedOut });
  });

  if (timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
  }
});

const videoId = parseVideoId(videoUrl);
if (!videoId) {
  console.error('유튜브 videoId를 찾을 수 없습니다');
  process.exit(2);
}

const timestamps = parseTimestampList(tsArg);
await fs.mkdir(outDir, { recursive: true });

const cachePath = path.join(os.tmpdir(), `${videoId}.mp4`);
try {
  await fs.access(cachePath);
} catch (error) {
  let downloadResult;
  try {
    downloadResult = await run('yt-dlp', [
      '-f', 'bv*[ext=mp4][height<=720]/b[ext=mp4][height<=720]',
      '--no-playlist',
      '-o', cachePath,
      videoUrl,
    ], { timeout: 180000 });
  } catch (runError) {
    console.error(runError.message || 'yt-dlp 실행 실패');
    process.exit(3);
  }

  if (downloadResult.code !== 0) {
    const reason = downloadResult.timedOut
      ? '영상 다운로드 타임아웃(180초)'
      : (downloadResult.stderr.trim() || downloadResult.stdout.trim() || '영상 다운로드 실패');
    console.error(reason);
    process.exit(3);
  }
}

const frames = [];
for (const { raw, ts } of timestamps) {
  const safeName = raw.replace(/[^\d.]/g, '').replace(/\./g, '_') || String(ts).replace(/\./g, '_');
  const framePath = path.join(outDir, `frame_${safeName}.jpg`);
  let result;
  try {
    result = await run('ffmpeg', [
      '-loglevel', 'error',
      '-y',
      '-ss', String(ts),
      '-i', cachePath,
      '-frames:v', '1',
      '-q:v', '3',
      framePath,
    ], { timeout: 30000 });
  } catch (error) {
    continue;
  }

  if (result.code !== 0) continue;

  try {
    const stat = await fs.stat(framePath);
    if (!stat.size) continue;
  } catch (error) {
    continue;
  }

  frames.push({ ts, path: framePath, width: 0, height: 0 });
}

process.stdout.write(JSON.stringify({ frames }));
