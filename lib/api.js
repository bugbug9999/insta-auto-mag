const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  DEFAULT_SETTINGS,
  INPUT_TYPES,
  POST_STATUSES,
  POST_TYPES,
  SOURCE_TYPES,
} = require('./store');
const { createCollector, MAX_IMAGE_BYTES } = require('./collect');
const { createRenderer } = require('./renderer');
const { createJobManager } = require('./jobs');
const { createExportShare } = require('./qr');
const { buildAnglesPrompt, buildTracePrompt, buildThreadPrompt, normalizeThreadIntensity } = require('./prompts');
const { callClaude } = require('./writer');
const { atomicWrite, sanitize, getDomain } = require('./utils');

const fsp = fs.promises;

function createApi(context) {
  const store = context.store;
  global.store = store;

  const collector = context.collector || createCollector({ store, callClaude });
  const renderer = context.renderer || createRenderer({ store });
  const jobs = context.jobs || createJobManager({ store, collector, renderer, callClaude });

  return {
    async getSettings() {
      return ok({ settings: await store.getSettings() });
    },

    async putSettings(request) {
      const body = expectObject(request.body, 'Request body must be a JSON object.');
      const current = await store.getSettings();
      const tonePresets =
        body.tonePresets !== undefined
          ? expectTonePresets(body.tonePresets, 'tonePresets')
          : current.tonePresets;
      const defaultTone =
        body.defaultTone !== undefined
          ? expectDefaultTone(body.defaultTone, tonePresets, 'defaultTone')
          : tonePresets.some((preset) => preset.id === current.defaultTone)
            ? current.defaultTone
            : tonePresets[0].id;
      const next = {
        ...current,
        brand: body.brand !== undefined ? expectNonEmptyString(body.brand, 'brand') : current.brand,
        defaultAccent:
          body.defaultAccent !== undefined
            ? expectAccent(body.defaultAccent, 'defaultAccent')
            : current.defaultAccent,
        defaultTone,
        tonePresets,
        theme: body.theme !== undefined ? expectNonEmptyString(body.theme, 'theme') : current.theme,
      };
      const settings = await store.saveSettings(next);
      return ok({ settings });
    },

    async listSources(request) {
      const sources = await store.listSources();
      const q = normalizeFilter(request.query.q);
      const topic = normalizeFilter(request.query.topic);
      const domain = normalizeFilter(request.query.domain);

      const filtered = sources.filter((source) => {
        if (q) {
          const haystack = [source.name, source.domain, source.notes, source.addedFrom]
            .concat(source.topics)
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(q)) {
            return false;
          }
        }
        if (topic && !source.topics.some((item) => item.toLowerCase() === topic)) {
          return false;
        }
        if (domain && source.domain !== domain) {
          return false;
        }
        return true;
      });

      return ok({ sources: filtered, total: filtered.length });
    },

    async createSource(request) {
      const body = expectObject(request.body, 'Request body must be a JSON object.');
      const source = await store.createSource(parseSourceInput(body, false));
      return created({ source });
    },

    async getSource(request) {
      const source = await store.getSource(request.params.id);
      if (!source) {
        throw notFound('Source not found.');
      }
      return ok({ source });
    },

    async patchSource(request) {
      const body = expectObject(request.body, 'Request body must be a JSON object.');
      const source = await store.updateSource(request.params.id, parseSourceInput(body, true));
      if (!source) {
        throw notFound('Source not found.');
      }
      return ok({ source });
    },

    async deleteSource(request) {
      const removed = await store.deleteSource(request.params.id);
      if (!removed) {
        throw notFound('Source not found.');
      }
      return noContent();
    },

    async traceSource(request) {
      const body = expectObject(request.body, 'Request body must be a JSON object.');
      const url = expectNonEmptyString(body.url, 'url');
      const save = body.save === true;

      let extracted;
      try {
        extracted = await collector.traceUrl(url);
      } catch (error) {
        throw badGateway(error.message || 'URL fetch failed.');
      }

      const settings = await store.getSettings();
      let traced;
      try {
        traced = await callClaude(buildTracePrompt({
          title: extracted.title,
          caption: extracted.ogDescription || extracted.body,
          url: extracted.url || url,
          body: extracted.body,
          outboundLinks: extracted.outboundLinks || [],
          mediaSummary: extracted.mediaSummary || '',
        }), {
          allowWebSearch: true,
          cliPath: settings.claudePath || undefined,
          apiKey: request.apiKey,
        });
      } catch (error) {
        if (error && error.code === 'cli_unavailable') {
          throw createHttpError(503, 'cli_unavailable', 'Claude CLI에 연결할 수 없습니다');
        }
        throw badGateway(error.message || 'Claude trace failed.');
      }

      const candidates = normalizeTraceCandidates(traced.sources);
      const saved = save ? await saveTraceCandidates(store, candidates, extracted.url || url) : [];

      return ok({
        candidates,
        summary: typeof traced.summary === 'string' ? traced.summary : null,
        items: normalizeTraceItems(traced.items),
        outboundLinks: extracted.outboundLinks || [],
        extractedTitle: extracted.title || null,
        extractedCaption: extracted.ogDescription || extracted.body || null,
        extractedBody: extracted.body || null,
        saved,
      });
    },

    async proposeAngles(request) {
      const body = expectObject(request.body, 'Request body must be a JSON object.');
      const items = assignTraceItemRefs(normalizeTraceItems(body.items));
      if (!items.length) {
        throw unprocessableEntity('"items" must include at least one valid item.');
      }

      const settings = await store.getSettings();
      let proposed;
      try {
        proposed = await callClaude(buildAnglesPrompt({
          url: typeof body.url === 'string' ? body.url : '',
          title: typeof body.title === 'string' ? body.title : '',
          summary: typeof body.summary === 'string' ? body.summary : '',
          items,
          body: typeof body.body === 'string' ? body.body : '',
          hints: body.hints === undefined ? [] : expectStringArray(body.hints, 'hints'),
          negativeTitles:
            body.negativeTitles === undefined ? [] : expectStringArray(body.negativeTitles, 'negativeTitles'),
        }), {
          allowWebSearch: false,
          cliPath: settings.claudePath || undefined,
          apiKey: request.apiKey,
        });
      } catch (error) {
        if (error && error.code === 'cli_unavailable') {
          throw createHttpError(503, 'cli_unavailable', 'Claude CLI에 연결할 수 없습니다');
        }
        throw badGateway(error.message || 'Claude angle proposal failed.');
      }

      return ok({
        angles: normalizeAngles(proposed && proposed.angles, items).slice(0, 3),
        items,
      });
    },

    async generateThread(request) {
      const body = expectObject(request.body, 'Request body must be a JSON object.');
      const rawInput = expectNonEmptyString(body.input, 'input').trim();
      const hasCount = Number.isFinite(Number(body.count)) && Number(body.count) > 0;
      const count = hasCount ? Math.max(4, Math.min(20, Number(body.count))) : null;
      const intensity = normalizeThreadIntensity(typeof body.intensity === 'string' ? body.intensity : 'standard');

      const isUrl = /^https?:\/\//i.test(rawInput);
      let topic = '';
      let source = rawInput;
      let sourceUrl = '';
      let extractedTitle = null;

      if (isUrl) {
        sourceUrl = rawInput;
        try {
          const extracted = await collector.traceUrl(rawInput);
          extractedTitle = decodeBasicEntities(extracted.title) || null;
          topic = extractedTitle || '';
          source = [extracted.title, extracted.ogDescription || extracted.body]
            .filter((value) => typeof value === 'string' && value.trim())
            .join('\n\n');
        } catch (error) {
          throw badGateway(error.message || 'URL fetch failed.');
        }
      } else if (rawInput.length <= 80 && !/\n/.test(rawInput)) {
        topic = rawInput;
        source = '';
      }

      const settings = await store.getSettings();
      let generated;
      try {
        generated = await callClaude(buildThreadPrompt({ topic, source, sourceUrl, count, intensity }), {
          allowWebSearch: isUrl,
          cliPath: settings.claudePath || undefined,
          timeoutMs: 300000,
          apiKey: request.apiKey,
        });
      } catch (error) {
        if (error && error.code === 'cli_unavailable') {
          throw createHttpError(503, 'cli_unavailable', 'Claude CLI에 연결할 수 없습니다');
        }
        throw badGateway(error.message || 'Claude thread generation failed.');
      }

      const thread = normalizeThread(generated);
      return ok({
        thread,
        meta: { intensity, count: count || 'auto', posts: thread.posts.length, isUrl, sourceUrl: sourceUrl || null, extractedTitle },
      });
    },

    async listPosts(request) {
      const posts = await store.listPosts();
      const q = normalizeFilter(request.query.q);
      const status = normalizeFilter(request.query.status);
      const inputType = normalizeFilter(request.query.inputType);

      const filtered = posts.filter((post) => {
        if (q) {
          const haystack = [post.title, post.input, post.caption].join(' ').toLowerCase();
          if (!haystack.includes(q)) {
            return false;
          }
        }
        if (status && post.status.toLowerCase() !== status) {
          return false;
        }
        if (inputType && post.inputType.toLowerCase() !== inputType) {
          return false;
        }
        return true;
      });

      return ok({ posts: filtered, total: filtered.length });
    },

    async createPost(request) {
      const body = expectObject(request.body, 'Request body must be a JSON object.');
      const post = await store.createPost(parsePostInput(body, false));
      return created({ post });
    },

    async getPost(request) {
      const post = await store.getPost(request.params.id);
      if (!post) {
        throw notFound('Post not found.');
      }
      return ok({ post });
    },

    async patchPost(request) {
      const body = expectObject(request.body, 'Request body must be a JSON object.');
      const post = await store.updatePost(request.params.id, parsePostInput(body, true));
      if (!post) {
        throw notFound('Post not found.');
      }
      return ok({ post });
    },

    async deletePost(request) {
      const removed = await store.deletePost(request.params.id);
      if (!removed) {
        throw notFound('Post not found.');
      }
      return noContent();
    },

    async generatePost(request) {
      const post = await ensurePostExists(store, request.params.id);
      const body = expectObject(request.body || {}, 'Request body must be a JSON object.');
      const fromStage = body.fromStage === undefined ? undefined : expectStage(body.fromStage, 'fromStage');
      const startedAt = new Date().toISOString();

      try {
        const result = await jobs.startGenerateJob(post.id, { fromStage, apiKey: request.apiKey });
        await store.updatePost(post.id, {
          status: result.status,
          error: '',
          failedStage: null,
          resumeStage: result.status,
          job: {
            stage: result.status,
            progress: stageMessage(result.status),
            startedAt,
          },
        });
        return ok(result);
      } catch (error) {
        if (error && error.status === 409) {
          throw conflict(error.message || '이미 생성이 진행 중입니다');
        }
        throw error;
      }
    },

    async appendSlides(request) {
      const post = await ensurePostExists(store, request.params.id);
      const body = expectObject(request.body || {}, 'Request body must be a JSON object.');
      const instruction = expectString(body.instruction, 'instruction');
      const startedAt = new Date().toISOString();

      try {
        const result = await jobs.startAppendJob(post.id, { instruction, apiKey: request.apiKey });
        await store.updatePost(post.id, {
          status: result.status,
          error: '',
          failedStage: null,
          resumeStage: result.status,
          job: {
            stage: result.status,
            progress: '추가 슬라이드 집필 중...',
            startedAt,
          },
        });
        return ok(result);
      } catch (error) {
        if (error && error.status === 409) {
          throw conflict(error.message || '이미 생성이 진행 중입니다');
        }
        throw error;
      }
    },

    async renderPost(request) {
      const post = await ensurePostExists(store, request.params.id);
      const body = expectObject(request.body || {}, 'Request body must be a JSON object.');
      const slideIds = resolveRenderSlideIds(post, body);
      const result = await renderer.renderSlides(post, slideIds ? { slideIds } : {});
      return ok({
        rendered: result.rendered,
        failed: result.failed,
        warnings: result.warnings,
        post: result.post,
      });
    },

    async exportPost(request) {
      try {
        let post = await ensurePostExists(store, request.params.id);
        expectObject(request.body || {}, 'Request body must be a JSON object.');

        if (!Array.isArray(post.slides) || post.slides.length === 0) {
          throw badRequest('슬라이드가 없습니다');
        }
        if (!post.caption || !post.caption.trim()) {
          throw badRequest('캡션을 입력해주세요');
        }

        const pendingSlideIds = post.slides
          .filter((slide) => slide.dirty || !slide.imagePath)
          .map((slide) => slide.id);

        if (pendingSlideIds.length) {
          const rendered = await renderer.renderSlides(post, { slideIds: pendingSlideIds });
          if (rendered.failed.length) {
            throw createHttpError(500, 'render_failed', rendered.failed[0].error);
          }
          post = rendered.post;
        }

        const paths = store.getPostPaths(post.id);
        await recreateDirectory(paths.exportDir);

        const orderedSlides = post.slides.slice().sort((left, right) => left.order - right.order);
        const files = [];
        for (let index = 0; index < orderedSlides.length; index += 1) {
          const slide = orderedSlides[index];
          const sourcePath = resolvePostFilePath(paths, slide.imagePath);
          if (!sourcePath) {
            throw createHttpError(500, 'missing_render', `슬라이드 ${index + 1} 이미지가 없습니다`);
          }
          const fileName = `${String(index + 1).padStart(2, '0')}.png`;
          const targetPath = path.join(paths.exportDir, fileName);
          await fsp.copyFile(sourcePath, targetPath);
          files.push(fileName);
        }

        await atomicWrite(path.join(paths.exportDir, 'caption.txt'), `${post.caption.trim()}\n`);
        await openDirectory(paths.exportDir);

        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const share = await createExportShare(paths.exportDir);

        return ok({
          dir: paths.exportDir,
          files,
          captionFile: 'caption.txt',
          qrSvg: share.svgDataUri,
          url: share.url,
          expiresAt,
        });
      } catch (error) {
        if (error && Number.isInteger(error.status) && error.code) {
          throw error;
        }
        throw createHttpError(500, 'export_failed', error && error.message ? error.message : 'Export에 실패했습니다');
      }
    },

    async uploadPostAsset(request) {
      const post = await ensurePostExists(store, request.params.id);
      const body = expectObject(request.body, 'Request body must be a JSON object.');
      const data = expectNonEmptyString(body.data, 'data');
      const filename = expectNonEmptyString(body.filename, 'filename');
      const slideId = body.slideId === undefined || body.slideId === null
        ? null
        : expectNonEmptyString(body.slideId, 'slideId');

      const decoded = decodeBase64Payload(data);
      if (decoded.buffer.length > MAX_IMAGE_BYTES) {
        throw badRequest('이미지 크기가 10MB를 초과합니다');
      }

      const paths = store.getPostPaths(post.id);
      await fsp.mkdir(paths.assetsDir, { recursive: true });

      const ext = inferUploadExtension(filename, decoded.mimeType);
      const safeBase = sanitize(path.basename(filename, path.extname(filename)), 'upload');
      const fileName = `${safeBase}_${Date.now()}.${ext}`;
      const targetPath = path.join(paths.assetsDir, fileName);
      const relativePath = `assets/${fileName}`;

      await atomicWrite(targetPath, decoded.buffer);

      let slides = Array.isArray(post.slides) ? post.slides.slice() : [];
      if (slideId) {
        const index = slides.findIndex((slide) => slide.id === slideId);
        if (index === -1) {
          throw badRequest('유효하지 않은 slideId 입니다');
        }
        slides[index] = {
          ...slides[index],
          photo: relativePath,
          dirty: true,
        };
      }

      const imageCandidates = mergeImageCandidates(post.imageCandidates, {
        url: '',
        localPath: relativePath,
        selected: false,
        width: 0,
        height: 0,
      });
      const selectedPaths = new Set(slides.map((slide) => slide.photo).filter(Boolean));
      const nextCandidates = imageCandidates.map((candidate) => ({
        ...candidate,
        selected: Boolean(candidate.localPath && selectedPaths.has(candidate.localPath)),
      }));

      const updated = await store.updatePost(post.id, {
        slides,
        imageCandidates: nextCandidates,
      });

      return ok({
        path: relativePath,
        slideId,
        imageCandidates: updated.imageCandidates,
        post: updated,
      });
    },
  };
}

async function ensurePostExists(store, id) {
  const post = await store.getPost(id);
  if (!post) {
    throw notFound('Post not found.');
  }
  return post;
}

function parseSourceInput(input, partial) {
  const next = {};

  if (input.name !== undefined) {
    next.name = expectNonEmptyString(input.name, 'name');
  } else if (!partial) {
    next.name = expectNonEmptyString('', 'name');
  }
  if (input.domain !== undefined) {
    next.domain = expectNonEmptyString(input.domain, 'domain').toLowerCase();
  } else if (!partial) {
    next.domain = expectNonEmptyString('', 'domain').toLowerCase();
  }
  if (input.type !== undefined) {
    next.type = expectEnum(input.type, SOURCE_TYPES, 'type');
  } else if (!partial) {
    next.type = 'blog';
  }
  if (input.topics !== undefined) {
    next.topics = expectStringArray(input.topics, 'topics');
  } else if (input.tags !== undefined) {
    next.topics = expectStringArray(input.tags, 'tags');
  } else if (!partial) {
    next.topics = [];
  }
  if (input.trust !== undefined) {
    next.trust = expectIntegerRange(input.trust, 'trust', 1, 5);
  } else if (!partial) {
    next.trust = 3;
  }
  if (input.addedFrom !== undefined) {
    next.addedFrom = expectNonEmptyString(input.addedFrom, 'addedFrom');
  } else if (!partial) {
    next.addedFrom = 'manual';
  }
  if (input.notes !== undefined) {
    next.notes = expectString(input.notes, 'notes');
  } else if (!partial) {
    next.notes = '';
  }
  if (input.lastUsedAt !== undefined) {
    next.lastUsedAt = input.lastUsedAt === null ? null : expectString(input.lastUsedAt, 'lastUsedAt');
  }
  if (input.useCount !== undefined) {
    next.useCount = expectIntegerRange(input.useCount, 'useCount', 0, Number.MAX_SAFE_INTEGER);
  }
  if (input.url !== undefined) {
    next.url = input.url === null ? null : expectString(input.url, 'url');
  }

  return next;
}

function parsePostInput(input, partial) {
  const next = {};

  if (input.title !== undefined) {
    next.title = expectString(input.title, 'title');
  } else if (!partial) {
    next.title = '';
  }
  if (input.inputType !== undefined) {
    next.inputType = expectEnum(input.inputType, INPUT_TYPES, 'inputType');
  } else if (!partial) {
    throw badRequest('"inputType" is required.');
  }
  if (input.input !== undefined) {
    next.input = expectString(input.input, 'input');
  } else if (!partial) {
    throw badRequest('"input" is required.');
  }
  if (input.status !== undefined) {
    next.status = expectEnum(input.status, POST_STATUSES, 'status');
  } else if (!partial) {
    next.status = 'draft';
  }
  if (input.error !== undefined) {
    next.error = expectString(input.error, 'error');
  } else if (!partial) {
    next.error = '';
  }
  if (input.postType !== undefined) {
    next.postType = expectEnum(input.postType, POST_TYPES, 'postType');
  } else if (!partial) {
    next.postType = 'brief';
  }
  if (input.tone !== undefined) {
    next.tone = expectNonEmptyString(input.tone, 'tone');
  }
  if (input.accent !== undefined) {
    next.accent = expectAccent(input.accent, 'accent');
  } else if (!partial) {
    next.accent = DEFAULT_SETTINGS.defaultAccent.slice();
  }
  if (input.sources !== undefined) {
    next.sources = expectArray(input.sources, 'sources');
  } else if (!partial) {
    next.sources = [];
  }
  if (input.imageCandidates !== undefined) {
    next.imageCandidates = expectArray(input.imageCandidates, 'imageCandidates');
  } else if (!partial) {
    next.imageCandidates = [];
  }
  if (input.spec !== undefined) {
    next.spec = expectJsonValue(input.spec, 'spec');
    // updatePost는 {...current, ...patch} 머지라 기존 slides가 spec을 이긴다 —
    // spec이 오면 slides도 함께 갱신해야 텍스트 수정이 실제 저장된다.
    if (isPlainObject(next.spec) && Array.isArray(next.spec.slides)) {
      next.slides = next.spec.slides;
    }
  } else if (!partial) {
    next.spec = { slides: [] };
  }
  if (input.body !== undefined) {
    next.body = expectString(input.body, 'body');
  } else if (!partial) {
    next.body = '';
  }
  if (input.angle !== undefined) {
    next.angle = expectAngleInput(input.angle, 'angle');
  }
  if (input.direction !== undefined) {
    next.direction = input.direction === null ? null : expectString(input.direction, 'direction');
  }
  if (input.traceItems !== undefined) {
    next.traceItems = expectJsonValue(expectArray(input.traceItems, 'traceItems'), 'traceItems');
  }
  if (input.caption !== undefined) {
    next.caption = expectString(input.caption, 'caption');
  } else if (!partial) {
    next.caption = '';
  }

  return next;
}

function expectObject(value, message) {
  if (!isPlainObject(value)) {
    throw badRequest(message);
  }
  return value;
}

function expectNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest(`"${field}" must be a non-empty string.`);
  }
  return value.trim();
}

function expectString(value, field) {
  if (typeof value !== 'string') {
    throw badRequest(`"${field}" must be a string.`);
  }
  return value;
}

function expectEnum(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw badRequest(`"${field}" is invalid.`);
  }
  return value;
}

function expectStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw badRequest(`"${field}" must be an array of non-empty strings.`);
  }
  return value.map((item) => item.trim());
}

function expectArray(value, field) {
  if (!Array.isArray(value)) {
    throw badRequest(`"${field}" must be an array.`);
  }
  return value;
}

function expectTonePresets(value, field) {
  const presets = expectArray(value, field).map((item, index) => {
    const preset = expectObject(item, `"${field}[${index}]" must be a JSON object.`);
    return {
      id: expectNonEmptyString(preset.id, `${field}[${index}].id`),
      name: expectString(preset.name, `${field}[${index}].name`),
      description: expectString(preset.description, `${field}[${index}].description`),
      promptSuffix: expectString(preset.promptSuffix, `${field}[${index}].promptSuffix`),
    };
  });

  if (!presets.length) {
    throw badRequest(`"${field}" must include at least one preset.`);
  }

  const ids = new Set();
  for (const preset of presets) {
    if (ids.has(preset.id)) {
      throw badRequest(`"${field}" contains duplicate id "${preset.id}".`);
    }
    ids.add(preset.id);
  }

  return presets;
}

function expectDefaultTone(value, tonePresets, field) {
  const defaultTone = expectNonEmptyString(value, field);
  if (!tonePresets.some((preset) => preset.id === defaultTone)) {
    throw badRequest(`"${field}" must reference an existing tone preset id.`);
  }
  return defaultTone;
}

function expectAccent(value, field) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw badRequest(`"${field}" must be an RGB array with three integers.`);
  }

  const next = value.map((channel) => {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw badRequest(`"${field}" must contain integers between 0 and 255.`);
    }
    return channel;
  });

  return next;
}

function expectIntegerRange(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`"${field}" must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function expectJsonValue(value, field) {
  if (value === undefined) {
    throw badRequest(`"${field}" is required.`);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw badRequest(`"${field}" must be JSON-serializable.`);
  }
}

function expectStage(value, field) {
  const allowed = new Set(['collecting', 'writing', 'rendering', 'verifying']);
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw badRequest(`"${field}" is invalid.`);
  }
  return value;
}

function normalizeFilter(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

function ok(body) {
  return { status: 200, body };
}

function created(body) {
  return { status: 201, body };
}

function noContent() {
  return { status: 204, body: null };
}

function badRequest(message) {
  return createHttpError(400, 'bad_request', message);
}

function notFound(message) {
  return createHttpError(404, 'not_found', message);
}

function conflict(message) {
  return createHttpError(409, 'conflict', message);
}

function unprocessableEntity(message) {
  return createHttpError(422, 'unprocessable_entity', message);
}

function badGateway(message) {
  return createHttpError(502, 'bad_gateway', message);
}

function notImplemented(message) {
  return createHttpError(501, 'not_implemented', message);
}

function createHttpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTraceCandidates(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((item) => isPlainObject(item))
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name.trim() : '',
      domain: normalizeDomain(item.domain, item.url),
      type: normalizeSourceType(item.type),
      url: typeof item.url === 'string' && item.url.trim() ? item.url.trim() : null,
      tags: normalizeTags(item.tags),
      confidence: normalizeConfidence(item.confidence),
    }))
    .filter((item) => item.name && item.domain);
}

function normalizeTraceItems(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const KINDS = new Set(['image', 'video', 'claim', 'data']);
  return values
    .filter((item) => isPlainObject(item))
    .map((item) => {
      const origin = isPlainObject(item.origin) ? item.origin : {};
      return {
        kind: KINDS.has(item.kind) ? item.kind : 'claim',
        desc: typeof item.desc === 'string' ? item.desc.trim() : '',
        origin: {
          name: typeof origin.name === 'string' ? origin.name.trim() : '',
          domain: normalizeDomain(origin.domain, origin.url),
          url: typeof origin.url === 'string' && origin.url.trim() ? origin.url.trim() : null,
          how: ['direct-link', 'web-search', 'estimate'].includes(origin.how) ? origin.how : 'estimate',
          confidence: normalizeConfidence(origin.confidence),
        },
      };
    })
    .filter((item) => item.desc)
    .slice(0, 12);
}

function assignTraceItemRefs(items) {
  return items.map((item, index) => ({
    ...item,
    ref: `i${index + 1}`,
  }));
}

function expectAngleInput(value, field) {
  const angle = expectObject(value, `"${field}" must be a JSON object.`);
  const next = {
    title: expectNonEmptyString(angle.title, `${field}.title`),
    hook: expectNonEmptyString(angle.hook, `${field}.hook`),
  };

  if (angle.tone !== undefined) {
    next.tone = expectString(angle.tone, `${field}.tone`);
  }

  return next;
}

function normalizeAngles(values, items) {
  if (!Array.isArray(values)) {
    return [];
  }

  const validRefs = new Set(items.map((item) => item.ref));
  const confidenceByRef = new Map(items.map((item) => [item.ref, normalizeConfidence(item.origin && item.origin.confidence)]));

  return values
    .filter((item) => isPlainObject(item))
    .map((item) => normalizeAngleCandidate(item, validRefs, confidenceByRef))
    .filter(Boolean);
}

function normalizeAngleCandidate(value, validRefs, confidenceByRef) {
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const hook = typeof value.hook === 'string' ? value.hook.trim() : '';
  if (!title || !hook) {
    return null;
  }

  const tone = normalizeAngleTone(value.tone);
  const postType = normalizeAnglePostType(value.postType);
  const structure = normalizeAngleStructure(value.structure);
  const itemRefs = normalizeAngleItemRefs(value.itemRefs, validRefs);
  const slideEstimate = normalizeAngleSlideEstimate(value.slideEstimate, structure, postType);

  return {
    title,
    hook,
    tone,
    postType,
    slideEstimate,
    structure,
    itemRefs,
    estimateCount: normalizeAngleEstimateCount(value.estimateCount, itemRefs, confidenceByRef),
  };
}

function normalizeAngleTone(value) {
  return value === 'emotional' || value === 'behind' ? value : 'fact';
}

function normalizeAnglePostType(value) {
  return value === 'essay' ? 'essay' : 'brief';
}

function normalizeAngleStructure(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAngleItemRefs(value, validRefs) {
  if (!Array.isArray(value)) {
    return [];
  }

  const refs = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const ref = item.trim();
    if (!ref || !validRefs.has(ref) || refs.includes(ref)) {
      continue;
    }
    refs.push(ref);
  }
  return refs;
}

function normalizeAngleSlideEstimate(value, structure, postType) {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : NaN;
  if (Number.isFinite(numeric)) {
    return Math.max(1, Math.round(numeric));
  }
  if (structure.length) {
    return structure.length;
  }
  return postType === 'essay' ? 6 : 3;
}

function normalizeAngleEstimateCount(value, itemRefs, confidenceByRef) {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : NaN;
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return itemRefs.reduce((count, ref) => count + (confidenceByRef.get(ref) < 0.7 ? 1 : 0), 0);
}

async function saveTraceCandidates(store, candidates, addedFrom) {
  const saved = [];

  for (const candidate of candidates) {
    const existing = await findSourceByDomainOrUrl(store, candidate.domain, candidate.url);
    if (existing) {
      const tags = Array.from(new Set([...(existing.tags || existing.topics || []), ...candidate.tags]));
      const updated = await store.updateSource(existing.id, {
        name: candidate.name || existing.name,
        domain: existing.domain || candidate.domain,
        type: candidate.type || existing.type,
        url: candidate.url || existing.url || null,
        topics: tags,
        addedFrom: existing.addedFrom || addedFrom,
      });
      if (updated) {
        saved.push(updated);
      }
      continue;
    }

    const createdSource = await store.createSource({
      name: candidate.name,
      domain: candidate.domain,
      type: candidate.type,
      url: candidate.url,
      tags: candidate.tags,
      topics: candidate.tags,
      addedFrom,
      notes: '',
    });
    saved.push(createdSource);
  }

  return saved;
}

async function findSourceByDomainOrUrl(store, domain, url) {
  const sources = await store.listSources();
  return sources.find((source) => {
    if (domain && source.domain === domain) {
      return true;
    }
    return Boolean(url && source.url && source.url === url);
  }) || null;
}

function normalizeSourceType(value) {
  if (typeof value === 'string' && SOURCE_TYPES.has(value.trim().toLowerCase())) {
    return value.trim().toLowerCase();
  }
  return 'blog';
}

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(
    value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

function normalizeConfidence(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeDomain(domain, url) {
  if (typeof domain === 'string' && domain.trim()) {
    return domain.trim().toLowerCase().replace(/^www\./i, '');
  }
  return getDomain(url || '');
}

function resolveRenderSlideIds(post, body) {
  if (body.slideIndex !== undefined) {
    if (!Number.isInteger(body.slideIndex) || body.slideIndex < 0 || body.slideIndex >= post.slides.length) {
      throw badRequest('"slideIndex" is invalid.');
    }
    return [post.slides[body.slideIndex].id];
  }

  if (body.slideId !== undefined) {
    const slideId = expectNonEmptyString(body.slideId, 'slideId');
    const slide = post.slides.find((item) => item.id === slideId);
    if (!slide) {
      throw badRequest('"slideId" is invalid.');
    }
    return [slide.id];
  }

  if (body.slideIds !== undefined) {
    const slideIds = expectArray(body.slideIds, 'slideIds')
      .map((value) => expectNonEmptyString(value, 'slideIds'))
      .filter((value, index, array) => array.indexOf(value) === index);
    const validIds = new Set(post.slides.map((slide) => slide.id));
    if (!slideIds.every((slideId) => validIds.has(slideId))) {
      throw badRequest('"slideIds" contains an invalid slide id.');
    }
    return slideIds;
  }

  return null;
}

function stageMessage(stage) {
  if (stage === 'collecting') {
    return '소재를 수집하는 중...';
  }
  if (stage === 'writing') {
    return '슬라이드 텍스트를 작성하는 중...';
  }
  if (stage === 'verifying') {
    return '슬라이드를 검수하는 중...';
  }
  return '슬라이드를 렌더링하는 중...';
}

async function recreateDirectory(dirPath) {
  await fsp.rm(dirPath, { recursive: true, force: true });
  await fsp.mkdir(dirPath, { recursive: true });
}

function resolvePostFilePath(paths, storedPath) {
  if (typeof storedPath !== 'string' || !storedPath.trim()) {
    return '';
  }

  const trimmed = storedPath.trim();
  if (path.isAbsolute(trimmed) && trimmed.startsWith(paths.postDir)) {
    return trimmed;
  }
  if (trimmed.startsWith(`/data/posts/${paths.id}/slides/`)) {
    return path.join(paths.slidesDir, path.basename(trimmed));
  }
  if (trimmed.startsWith(`/data/posts/${paths.id}/assets/`)) {
    return path.join(paths.assetsDir, path.basename(trimmed));
  }
  if (trimmed.startsWith('slides/')) {
    return path.join(paths.postDir, trimmed);
  }
  if (trimmed.startsWith('assets/')) {
    return path.join(paths.postDir, trimmed);
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.join(paths.postDir, trimmed);
}

function openDirectory(dirPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('open', [dirPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `open exit ${code}`));
        return;
      }
      resolve();
    });
  });
}

function decodeBase64Payload(value) {
  let source = value.trim();
  let mimeType = '';
  const dataUriMatch = source.match(/^data:([^;,]+)?;base64,(.*)$/i);
  if (dataUriMatch) {
    mimeType = dataUriMatch[1] || '';
    source = dataUriMatch[2] || '';
  }

  source = source.replace(/\s+/g, '');
  if (!source || /[^a-z0-9+/=]/i.test(source)) {
    throw badRequest('"data" must be a valid base64 string.');
  }

  const buffer = Buffer.from(source, 'base64');
  if (!buffer.length) {
    throw badRequest('"data" must be a valid base64 string.');
  }

  return { buffer, mimeType };
}

function inferUploadExtension(filename, mimeType) {
  const explicit = path.extname(filename).replace(/^\./, '').toLowerCase();
  if (explicit) {
    return explicit;
  }
  if (mimeType.includes('png')) {
    return 'png';
  }
  if (mimeType.includes('webp')) {
    return 'webp';
  }
  if (mimeType.includes('gif')) {
    return 'gif';
  }
  return 'jpg';
}

function mergeImageCandidates(current, incoming) {
  const next = Array.isArray(current) ? current.slice() : [];
  const exists = next.some((item) => item && item.localPath === incoming.localPath);
  if (!exists) {
    next.push(incoming);
  }
  return next;
}

function decodeBasicEntities(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function normalizeThread(generated) {
  const source = generated && typeof generated === 'object' ? generated : {};
  const lead = typeof source.lead === 'string' ? source.lead.trim() : '';
  const imageHint = typeof source.imageHint === 'string' ? source.imageHint.trim() : '';
  const closing = typeof source.closing === 'string' ? source.closing.trim() : '';

  const rawPosts = Array.isArray(source.posts) ? source.posts : [];
  const posts = [];
  rawPosts.forEach((entry) => {
    const text = typeof entry === 'string'
      ? entry
      : entry && typeof entry.text === 'string'
        ? entry.text
        : '';
    const trimmed = String(text).trim();
    if (!trimmed) {
      return;
    }
    const n = posts.length + 1;
    const normalizedText = /^\s*\d+\s*\//.test(trimmed) ? trimmed : `${n}/ ${trimmed}`;
    posts.push({ n, text: normalizedText });
  });

  return { lead, imageHint, closing, posts };
}

module.exports = {
  createApi,
};
