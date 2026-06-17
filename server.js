const http = require('http');
const fs = require('fs');
const path = require('path');

const { createStore } = require('./lib/store');
const { createApi } = require('./lib/api');

// 로컬은 127.0.0.1 유지, 컨테이너 호스트는 HOST=0.0.0.0 + 주입된 PORT를 env로 받음.
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3080;
const JSON_BODY_LIMIT = 12 * 1024 * 1024;

const projectRoot = __dirname;
const publicDir = path.join(projectRoot, 'public');
const dataDir = path.join(projectRoot, 'data');

async function main() {
  const store = createStore(dataDir);
  await store.bootstrap();

  const api = createApi({ store });

  const routes = [
    route('GET', '/api/settings', api.getSettings),
    route('PUT', '/api/settings', api.putSettings),

    route('GET', '/api/sources', api.listSources),
    route('POST', '/api/sources', api.createSource),
    route('POST', '/api/sources/trace', api.traceSource),
    route('POST', '/api/angles', api.proposeAngles),
    route('POST', '/api/threads/generate', api.generateThread),
    route('GET', '/api/sources/:id', api.getSource),
    route('PATCH', '/api/sources/:id', api.patchSource),
    route('DELETE', '/api/sources/:id', api.deleteSource),

    route('GET', '/api/posts', api.listPosts),
    route('POST', '/api/posts', api.createPost),
    route('GET', '/api/posts/:id', api.getPost),
    route('PATCH', '/api/posts/:id', api.patchPost),
    route('DELETE', '/api/posts/:id', api.deletePost),
    route('POST', '/api/posts/:id/generate', api.generatePost),
    route('POST', '/api/posts/:id/append-slides', api.appendSlides),
    route('POST', '/api/posts/:id/render', api.renderPost),
    route('POST', '/api/posts/:id/export', api.exportPost),
    route('POST', '/api/posts/:id/assets', api.uploadPostAsset),
  ];

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith('/api/')) {
        await handleApiRequest({ req, res, routes, url, pathname });
        return;
      }

      if (pathname.startsWith('/data/posts/')) {
        const served = await servePostAsset({ req, res, store, pathname });
        if (served) {
          return;
        }
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        await servePublicFile({ req, res, pathname });
        return;
      }

      sendJson(res, 405, {
        error: {
          code: 'method_not_allowed',
          message: 'Method not allowed.',
        },
      });
    } catch (error) {
      handleServerError(res, error);
    }
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(`Server listening at http://${HOST}:${PORT}\n`);
  });
}

function route(method, pattern, handler) {
  const keys = [];
  const escaped = pattern
    .split('/')
    .map((segment) => {
      if (!segment) {
        return '';
      }
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');

  return {
    method,
    regex: new RegExp(`^${escaped}$`),
    keys,
    handler,
  };
}

async function handleApiRequest(context) {
  const { req, res, routes, url, pathname } = context;
  const match = matchRoute(routes, req.method || 'GET', pathname);

  if (!match) {
    sendJson(res, 404, {
      error: {
        code: 'not_found',
        message: 'API route not found.',
      },
    });
    return;
  }

  const body = shouldReadJsonBody(req.method) ? await readJsonBody(req) : undefined;
  // 사용자별 Anthropic API 키 — 요청 헤더로만 받고 서버에 저장·로그하지 않는다.
  const apiKeyHeader = req.headers['x-anthropic-key'];
  const apiKey = typeof apiKeyHeader === 'string' ? apiKeyHeader.trim() : '';
  const result = await match.handler({
    method: req.method || 'GET',
    path: pathname,
    params: match.params,
    query: Object.fromEntries(url.searchParams.entries()),
    body,
    apiKey,
  });

  if (result.status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, result.status || 200, result.body);
}

function matchRoute(routes, method, pathname) {
  for (const candidate of routes) {
    if (candidate.method !== method) {
      continue;
    }

    const found = pathname.match(candidate.regex);
    if (!found) {
      continue;
    }

    const params = {};
    candidate.keys.forEach((key, index) => {
      params[key] = found[index + 1];
    });

    return {
      handler: candidate.handler,
      params,
    };
  }

  return null;
}

function shouldReadJsonBody(method) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;

    req.on('data', (chunk) => {
      if (finished) {
        return;
      }
      size += chunk.length;
      if (size > JSON_BODY_LIMIT) {
        finished = true;
        const error = createHttpError(413, 'payload_too_large', 'Request body is too large.');
        req.resume();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (finished) {
        return;
      }
      finished = true;
      if (!chunks.length) {
        resolve({});
        return;
      }

      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch (error) {
        reject(createHttpError(400, 'invalid_json', 'Request body must be valid JSON.'));
      }
    });

    req.on('error', (error) => {
      if (finished) {
        return;
      }
      finished = true;
      reject(error);
    });
  });
}

async function servePostAsset(context) {
  const { req, res, store, pathname } = context;
  const match = pathname.match(/^\/data\/posts\/([a-z0-9][a-z0-9_-]{0,127})\/(slides|assets)\/([^/]+)$/i);
  if (!match) {
    sendJson(res, 404, {
      error: {
        code: 'not_found',
        message: 'Asset not found.',
      },
    });
    return true;
  }

  const postId = match[1];
  const bucket = match[2];
  const fileName = match[3];
  const paths = store.getPostPaths(postId);
  const baseDir = bucket === 'slides' ? paths.slidesDir : paths.assetsDir;
  const resolved = path.join(baseDir, fileName);

  if (path.basename(resolved) !== fileName) {
    sendJson(res, 400, {
      error: {
        code: 'bad_request',
        message: 'Invalid asset path.',
      },
    });
    return true;
  }

  return serveFile(req, res, resolved, {
    rootDir: baseDir,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
  });
}

async function servePublicFile(context) {
  const { req, res, pathname } = context;
  const targetPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(publicDir, targetPath);

  if (isInside(filePath, publicDir) && (await isRegularFile(filePath))) {
    await serveFile(req, res, filePath, { rootDir: publicDir });
    return;
  }

  if (path.extname(targetPath)) {
    sendJson(res, 404, {
      error: {
        code: 'not_found',
        message: 'Static file not found.',
      },
    });
    return;
  }

  const indexPath = path.join(publicDir, 'index.html');
  if (await isRegularFile(indexPath)) {
    await serveFile(req, res, indexPath, {
      rootDir: publicDir,
      contentType: 'text/html; charset=utf-8',
    });
    return;
  }

  sendJson(res, 404, {
    error: {
      code: 'not_found',
      message: 'Static file not found.',
    },
  });
}

async function serveFile(req, res, filePath, options) {
  const rootDir = options && options.rootDir;
  if (rootDir && !isInside(filePath, rootDir) && filePath !== rootDir) {
    sendJson(res, 403, {
      error: {
        code: 'forbidden',
        message: 'Forbidden.',
      },
    });
    return true;
  }

  if (!(await isRegularFile(filePath))) {
    sendJson(res, 404, {
      error: {
        code: 'not_found',
        message: 'File not found.',
      },
    });
    return true;
  }

  const stat = await fs.promises.stat(filePath);
  const headers = {
    'Content-Type': options && options.contentType ? options.contentType : mimeTypeFor(filePath),
    'Content-Length': stat.size,
    ...((options && options.headers) || {}),
  };

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}

function isInside(candidatePath, parentPath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function isRegularFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.gif':
      return 'image/gif';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // 브라우저가 옛 post JSON(옛 updatedAt)을 캐시하면 이미지 cache-bust 키가 안 바뀌어
    // 재렌더해도 옛 이미지가 보인다 → API 응답은 항상 재검증.
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(text);
}

function handleServerError(res, error) {
  const status =
    Number.isInteger(error && error.status) ? error.status : error && error.code === 'INVALID_ID' ? 400 : 500;
  const code = error && error.code ? String(error.code).toLowerCase() : 'internal_error';
  const message =
    status === 500 ? 'Internal server error.' : error && error.message ? error.message : 'Request failed.';

  sendJson(res, status, {
    error: {
      code,
      message,
    },
  });
}

function createHttpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
