const { spawn } = require('child_process');
const { extractJSON } = require('./utils');

// CLI fallback 경로 — 환경변수로 덮어쓸 수 있음(CLAUDE_CLI). 공유 배포의 기본 경로는 표준 `claude`.
const DEFAULT_CLAUDE_CLI = process.env.CLAUDE_CLI || 'claude';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = process.env.CAROUSEL_MODEL || 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 8000;

// 키가 있으면 Anthropic API(사용자 토큰), 없으면 로컬 Claude CLI(오너 구독) — 로컬 개발 호환.
async function callClaude(prompt, options = {}) {
  const apiKey = resolveApiKey(options);
  if (apiKey) {
    return callClaudeApi(prompt, { ...options, apiKey });
  }
  return callClaudeCli(prompt, options);
}

function resolveApiKey(options) {
  const fromOptions = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (fromOptions) {
    return fromOptions;
  }
  const fromEnv = typeof process.env.ANTHROPIC_API_KEY === 'string' ? process.env.ANTHROPIC_API_KEY.trim() : '';
  return fromEnv || '';
}

// --- Anthropic Messages API 경로 (요청마다 사용자 키) ---
async function callClaudeApi(prompt, options) {
  const apiKey = options.apiKey;
  const model = (typeof options.model === 'string' && options.model.trim()) || DEFAULT_MODEL;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 180000;
  const maxTokens = Number.isInteger(options.maxTokens) ? options.maxTokens : DEFAULT_MAX_TOKENS;

  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (options.allowWebSearch) {
    // 서버 사이드 웹 검색 도구 — Anthropic이 검색을 대신 수행하고 최종 답을 한 번에 반환.
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error && error.name === 'AbortError') {
      throw new Error(`AI 응답 타임아웃 (${Math.round(timeoutMs / 1000)}초 초과)`);
    }
    const netError = new Error('Anthropic API에 연결할 수 없습니다');
    netError.code = 'api_unreachable';
    throw netError;
  }
  clearTimeout(timer);

  if (!response.ok) {
    const detail = await safeReadText(response);
    // 키 문제는 UI가 재입력을 유도하도록 별도 코드.
    if (response.status === 401 || response.status === 403) {
      const keyError = new Error('Anthropic API 키가 유효하지 않습니다');
      keyError.code = 'invalid_api_key';
      throw keyError;
    }
    if (response.status === 429) {
      const rateError = new Error('API 사용량 한도/크레딧 초과입니다 (429)');
      rateError.code = 'api_rate_limited';
      throw rateError;
    }
    throw new Error(`Anthropic API ${response.status}: ${detail.slice(0, 300)}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('AI 응답을 해석할 수 없습니다');
  }

  const text = extractTextFromMessage(payload);
  const json = extractJSON(text);
  if (!json) {
    throw new Error('AI 응답을 해석할 수 없습니다');
  }
  return json;
}

function extractTextFromMessage(payload) {
  const content = payload && Array.isArray(payload.content) ? payload.content : [];
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (error) {
    return '';
  }
}

// --- 로컬 Claude CLI 경로 (fallback, 오너 구독) ---
async function callClaudeCli(prompt, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await runClaude(prompt, options);
    } catch (error) {
      lastError = error;
      if (error && error.code === 'cli_unavailable') {
        break;
      }
    }
  }
  throw lastError;
}

function runClaude(prompt, options) {
  const cliPath = process.env.CLAUDE_CLI || options.cliPath || DEFAULT_CLAUDE_CLI;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 180000;
  const args = ['-p', prompt, '--output-format', 'text', '--no-session-persistence'];

  if (options.allowWebSearch) {
    args.push('--allowedTools', 'WebSearch,WebFetch');
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const child = spawn(cliPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SUDO_ASKPASS: '',
        SSH_ASKPASS: '',
        DISPLAY: '',
      },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error && error.code === 'ENOENT') {
        const unavailable = new Error('Claude CLI에 연결할 수 없습니다');
        unavailable.code = 'cli_unavailable';
        reject(unavailable);
        return;
      }
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error('AI 응답 타임아웃 (180초 초과)'));
        return;
      }

      if (signal === 'SIGKILL' && code === null) {
        reject(new Error('AI 응답 타임아웃 (180초 초과)'));
        return;
      }

      if (code !== 0) {
        reject(new Error(`claude exit ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      const json = extractJSON(stdout);
      if (!json) {
        reject(new Error('AI 응답을 해석할 수 없습니다'));
        return;
      }

      resolve(json);
    });
  });
}

module.exports = {
  callClaude,
  DEFAULT_CLAUDE_CLI,
  DEFAULT_MODEL,
};
