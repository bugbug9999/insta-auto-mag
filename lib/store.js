const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { atomicWrite } = require('./utils');

const fsp = fs.promises;

const DEFAULT_TONE_PRESETS = Object.freeze([
  {
    id: 'magazine',
    name: '감성 매거진',
    description: '감성 매거진 스타일, ~합니다체, 정제된 톤',
    promptSuffix:
      '톤: 감성 매거진. ~합니다체로 작성. 정제되고 차분한 뉴스레터 느낌. 도발적이되 냉정하게.',
  },
  {
    id: 'newsletter',
    name: '뉴스레터',
    description: '팩트 중심, 간결, 불릿 포인트',
    promptSuffix:
      '톤: 뉴스레터. 팩트 중심으로 간결하게. 불필요한 감성 배제. 숫자와 고유명사 적극 사용.',
  },
  {
    id: 'casual',
    name: '캐주얼',
    description: '~해요체, 친근하고 가벼운',
    promptSuffix: '톤: 캐주얼. ~해요체로 친근하게. 이모지 가끔 사용. 대화하듯 자연스럽게.',
  },
  {
    id: 'provocative',
    name: '자극적',
    description: '도발적 헤드라인, 강한 주장',
    promptSuffix: '톤: 자극적. 도발적이고 단정적으로. 강한 주장과 대비. 독자를 자극하는 헤드라인.',
  },
]);

const DEFAULT_SETTINGS = Object.freeze({
  brand: 'MAG',
  defaultAccent: [156, 206, 245],
  defaultTone: 'magazine',
  tonePresets: DEFAULT_TONE_PRESETS,
  makeCardPath: '',
  exportPath: '',
  claudePath: '',
  theme: 'editorial-dark',
});

const DEFAULT_SOURCES = Object.freeze([]);

const POST_STATUSES = new Set([
  'collecting',
  'writing',
  'rendering',
  'verifying',
  'draft',
  'done',
  'published',
  'error',
]);

const POST_TYPES = new Set(['brief', 'essay']);
const INPUT_TYPES = new Set(['topic', 'url']);
const SOURCE_TYPES = new Set(['media', 'report', 'filing', 'sns', 'blog']);
const SLIDE_TYPES = new Set(['cover', 'body', 'ending']);
const JOB_STAGES = new Set(['collecting', 'writing', 'rendering', 'verifying']);
const TRACE_ITEM_KINDS = new Set(['image', 'video', 'claim', 'data']);
const TRACE_ORIGIN_HOWS = new Set(['direct-link', 'web-search', 'estimate']);
const OUTLINE_ROLES = new Set(['cover', 'context', 'body', 'insight', 'ending']);
const POST_FORMATS = new Set(['quote', 'listicle', 'detective', 'profile', 'news', 'learning']);

const SOURCE_TYPE_ALIASES = {
  언론사: 'media',
  리포트: 'report',
  공시: 'filing',
  SNS: 'sns',
  블로그: 'blog',
};

function createStore(rootDir) {
  const dataDir = rootDir;
  const postsDir = path.join(dataDir, 'posts');
  const settingsPath = path.join(dataDir, 'settings.json');
  const sourcesPath = path.join(dataDir, 'sources.json');

  async function bootstrap() {
    await ensureDir(dataDir);
    await ensureDir(postsDir);
    await ensureJsonFile(settingsPath, DEFAULT_SETTINGS);
    await ensureJsonFile(sourcesPath, DEFAULT_SOURCES);
  }

  async function getSettings() {
    const value = await readJson(settingsPath, DEFAULT_SETTINGS);
    return normalizeSettings(value);
  }

  async function saveSettings(nextSettings) {
    const normalized = normalizeSettings(nextSettings);
    await writeJsonAtomic(settingsPath, normalized);
    return normalized;
  }

  async function listSources() {
    const raw = await readJson(sourcesPath, DEFAULT_SOURCES);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map(normalizeSource).sort(compareByCreatedDesc);
  }

  async function saveSources(sources) {
    const normalized = Array.isArray(sources) ? sources.map(normalizeSource) : [];
    await writeJsonAtomic(sourcesPath, normalized);
    return normalized;
  }

  async function getSource(id) {
    assertSafeId(id, 'source id');
    const sources = await listSources();
    return sources.find((source) => source.id === id) || null;
  }

  async function createSource(input) {
    const sources = await listSources();
    const now = isoNow();
    const source = normalizeSource({
      ...input,
      id: generateId('src'),
      createdAt: now,
      lastUsedAt: input && input.lastUsedAt ? input.lastUsedAt : null,
      useCount: input && Number.isInteger(input.useCount) ? input.useCount : 0,
    });
    sources.push(source);
    await writeJsonAtomic(sourcesPath, sources);
    return source;
  }

  async function updateSource(id, patch) {
    assertSafeId(id, 'source id');
    const sources = await listSources();
    const index = sources.findIndex((source) => source.id === id);
    if (index === -1) {
      return null;
    }

    const merged = normalizeSource({
      ...sources[index],
      ...cloneJson(patch),
      id,
      createdAt: sources[index].createdAt,
    });

    sources[index] = merged;
    await writeJsonAtomic(sourcesPath, sources);
    return merged;
  }

  async function deleteSource(id) {
    assertSafeId(id, 'source id');
    const sources = await listSources();
    const nextSources = sources.filter((source) => source.id !== id);
    if (nextSources.length === sources.length) {
      return false;
    }
    await writeJsonAtomic(sourcesPath, nextSources);
    return true;
  }

  async function listPosts() {
    await ensureDir(postsDir);
    const entries = await fsp.readdir(postsDir, { withFileTypes: true });
    const posts = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const postPath = path.join(postsDir, entry.name, 'post.json');
      if (!(await exists(postPath))) {
        continue;
      }

      const raw = await readJson(postPath, null);
      if (!raw) {
        continue;
      }

      posts.push(normalizePost(raw));
    }

    posts.sort(compareByUpdatedDesc);
    return posts;
  }

  async function getPost(id) {
    const paths = getPostPaths(id);
    if (!(await exists(paths.postJsonPath))) {
      return null;
    }
    const raw = await readJson(paths.postJsonPath, null);
    return raw ? normalizePost(raw) : null;
  }

  async function createPost(input) {
    const id = generateId('post');
    const paths = getPostPaths(id);
    const now = isoNow();

    await ensureDir(paths.postDir);
    await ensureDir(paths.assetsDir);
    await ensureDir(paths.slidesDir);
    await ensureDir(paths.exportDir);

    const post = normalizePost({
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
    });

    await writeJsonAtomic(paths.postJsonPath, post);
    return post;
  }

  async function savePost(post) {
    const normalized = normalizePost(post);
    const paths = getPostPaths(normalized.id);
    await ensureDir(paths.postDir);
    await ensureDir(paths.assetsDir);
    await ensureDir(paths.slidesDir);
    await ensureDir(paths.exportDir);
    await writeJsonAtomic(paths.postJsonPath, normalized);
    return normalized;
  }

  async function updatePost(id, patch) {
    const paths = getPostPaths(id);
    if (!(await exists(paths.postJsonPath))) {
      return null;
    }

    const current = await getPost(id);
    if (!current) {
      return null;
    }

    const merged = normalizePost({
      ...current,
      ...cloneJson(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: isoNow(),
    });

    await writeJsonAtomic(paths.postJsonPath, merged);
    return merged;
  }

  async function deletePost(id) {
    const paths = getPostPaths(id);
    if (!(await exists(paths.postDir))) {
      return false;
    }

    await fsp.rm(paths.postDir, { recursive: true, force: true });
    return true;
  }

  function getPostPaths(id) {
    assertSafeId(id, 'post id');
    const postDir = path.join(postsDir, id);
    return {
      id,
      postDir,
      postJsonPath: path.join(postDir, 'post.json'),
      assetsDir: path.join(postDir, 'assets'),
      slidesDir: path.join(postDir, 'slides'),
      exportDir: path.join(postDir, 'export'),
    };
  }

  return {
    bootstrap,
    dataDir,
    postsDir,
    settingsPath,
    sourcesPath,
    generateId,
    getPostPaths,
    getSettings,
    saveSettings,
    listSources,
    saveSources,
    getSource,
    createSource,
    updateSource,
    deleteSource,
    listPosts,
    getPost,
    createPost,
    savePost,
    updatePost,
    deletePost,
  };
}

async function ensureJsonFile(filePath, defaultValue) {
  if (await exists(filePath)) {
    return;
  }
  await writeJsonAtomic(filePath, defaultValue);
}

async function readJson(filePath, fallbackValue) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return cloneJson(fallbackValue);
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await atomicWrite(filePath, text);
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function exists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function generateId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${stamp}_${random}`;
}

function normalizeSettings(input) {
  const value = isPlainObject(input) ? input : {};
  const tonePresets = Array.isArray(value.tonePresets) && value.tonePresets.length
    ? value.tonePresets.map(normalizeTonePreset).filter(Boolean)
    : DEFAULT_TONE_PRESETS.map((preset) => ({ ...preset }));

  const defaultTone = typeof value.defaultTone === 'string' && tonePresets.some((item) => item.id === value.defaultTone)
    ? value.defaultTone
    : tonePresets[0].id;

  return {
    brand: typeof value.brand === 'string' && value.brand.trim() ? value.brand.trim() : DEFAULT_SETTINGS.brand,
    defaultAccent: normalizeAccent(value.defaultAccent, DEFAULT_SETTINGS.defaultAccent),
    defaultTone,
    tonePresets,
    makeCardPath: typeof value.makeCardPath === 'string' ? value.makeCardPath.trim() : '',
    exportPath: typeof value.exportPath === 'string' ? value.exportPath.trim() : '',
    claudePath: typeof value.claudePath === 'string' ? value.claudePath.trim() : '',
    theme: typeof value.theme === 'string' && value.theme.trim() ? value.theme.trim() : DEFAULT_SETTINGS.theme,
  };
}

function normalizeTonePreset(input) {
  if (!isPlainObject(input)) {
    return null;
  }

  if (typeof input.id !== 'string' || !input.id.trim()) {
    return null;
  }

  return {
    id: input.id.trim(),
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : input.id.trim(),
    description: typeof input.description === 'string' ? input.description : '',
    promptSuffix: typeof input.promptSuffix === 'string' ? input.promptSuffix : '',
  };
}

function normalizeSource(input) {
  const value = isPlainObject(input) ? input : {};
  const createdAt = isIsoLike(value.createdAt) ? value.createdAt : isoNow();
  const lastUsedAt = value.lastUsedAt === null || isIsoLike(value.lastUsedAt) ? value.lastUsedAt : null;
  const tags = normalizeStringList(value.tags || value.topics);
  const type = normalizeSourceType(value.type);

  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : generateId('src'),
    name: typeof value.name === 'string' ? value.name.trim() : '',
    domain: typeof value.domain === 'string' ? value.domain.trim().toLowerCase() : '',
    type,
    tags,
    topics: tags.slice(),
    url: typeof value.url === 'string' && value.url.trim() ? value.url.trim() : null,
    trust: normalizeTrust(value.trust),
    addedFrom: typeof value.addedFrom === 'string' ? value.addedFrom.trim() : null,
    notes: typeof value.notes === 'string' ? value.notes : '',
    createdAt,
    lastUsedAt,
    useCount: Number.isInteger(value.useCount) && value.useCount >= 0 ? value.useCount : 0,
  };
}

function normalizePost(input) {
  const value = isPlainObject(input) ? input : {};
  const createdAt = isIsoLike(value.createdAt) ? value.createdAt : isoNow();
  const updatedAt = isIsoLike(value.updatedAt) ? value.updatedAt : createdAt;
  const slidesSource = Array.isArray(value.slides)
    ? value.slides
    : isPlainObject(value.spec) && Array.isArray(value.spec.slides)
      ? value.spec.slides
      : [];
  const slides = slidesSource.map((slide, index) => normalizeSlide(slide, index)).sort(compareSlides);
  const coverSlide = slides.find((slide) => slide.type === 'cover') || slides[0] || null;

  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : generateId('post'),
    title: typeof value.title === 'string' ? value.title : '',
    inputType: INPUT_TYPES.has(value.inputType) ? value.inputType : 'topic',
    input: typeof value.input === 'string' ? value.input : '',
    status: POST_STATUSES.has(value.status) ? value.status : 'draft',
    error: typeof value.error === 'string' ? value.error : '',
    resumeStage: JOB_STAGES.has(value.resumeStage) ? value.resumeStage : null,
    failedStage: JOB_STAGES.has(value.failedStage) ? value.failedStage : null,
    postType: POST_TYPES.has(value.postType) ? value.postType : null,
    format: typeof value.format === 'string' && POST_FORMATS.has(value.format.trim()) ? value.format.trim() : null,
    tone: typeof value.tone === 'string' && value.tone.trim() ? value.tone.trim() : DEFAULT_SETTINGS.defaultTone,
    accent: normalizeAccent(value.accent, DEFAULT_SETTINGS.defaultAccent),
    brand: typeof value.brand === 'string' && value.brand.trim() ? value.brand.trim() : DEFAULT_SETTINGS.brand,
    sources: normalizeStringList(value.sources),
    imageCandidates: Array.isArray(value.imageCandidates)
      ? value.imageCandidates.map(normalizeImageCandidate)
      : [],
    slides,
    spec: { slides: slides.map(toLegacySpecSlide) },
    caption: typeof value.caption === 'string' ? value.caption : '',
    hashtags: typeof value.hashtags === 'string' ? value.hashtags : '',
    body: typeof value.body === 'string' ? value.body : '',
    transcriptSegments: normalizeTranscriptSegments(value.transcriptSegments),
    angle: normalizeAngle(value.angle),
    direction: typeof value.direction === 'string' && value.direction.trim() ? value.direction.trim() : null,
    traceItems: normalizeTraceItems(value.traceItems),
    outline: normalizeOutline(value.outline),
    verify: normalizeVerify(value.verify),
    coverImage: typeof value.coverImage === 'string' && value.coverImage.trim()
      ? value.coverImage
      : coverSlide && coverSlide.imagePath
        ? coverSlide.imagePath
        : null,
    sourceUrls: normalizeStringList(value.sourceUrls),
    job: normalizeJob(value.job),
    createdAt,
    updatedAt,
  };
}

function normalizeAngle(input) {
  if (!isPlainObject(input)) {
    return null;
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const hook = typeof input.hook === 'string' ? input.hook.trim() : '';
  if (!title && !hook) {
    return null;
  }

  const tone = typeof input.tone === 'string' && input.tone.trim() ? input.tone.trim() : null;
  return {
    title,
    hook,
    tone,
  };
}

function normalizeTraceItems(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map(normalizeTraceItem);
}

function normalizeTraceItem(input, index) {
  const value = isPlainObject(input) ? input : {};
  const ref = typeof value.ref === 'string' && value.ref.trim() ? value.ref.trim() : `i${(index || 0) + 1}`;
  const kind = typeof value.kind === 'string' && TRACE_ITEM_KINDS.has(value.kind.trim())
    ? value.kind.trim()
    : 'claim';

  return {
    ref,
    kind,
    desc: typeof value.desc === 'string' ? value.desc : '',
    origin: normalizeTraceOrigin(value.origin),
  };
}

function normalizeTraceOrigin(input) {
  const value = isPlainObject(input) ? input : {};
  const how = typeof value.how === 'string' && TRACE_ORIGIN_HOWS.has(value.how.trim())
    ? value.how.trim()
    : null;

  return {
    name: typeof value.name === 'string' ? value.name.trim() : '',
    domain: typeof value.domain === 'string' ? value.domain.trim().toLowerCase() : '',
    url: typeof value.url === 'string' && value.url.trim() ? value.url.trim() : null,
    how,
    confidence: normalizeConfidence(value.confidence),
  };
}

function normalizeOutline(input) {
  if (!Array.isArray(input)) {
    return null;
  }

  const outline = input.map((item, index) => normalizeOutlineItem(item, index));
  return outline.length ? outline : [];
}

function normalizeOutlineItem(input, index) {
  const value = isPlainObject(input) ? input : {};
  const type = SLIDE_TYPES.has(value.type) ? value.type : inferOutlineType(index, value.role);
  const role = typeof value.role === 'string' && OUTLINE_ROLES.has(value.role.trim())
    ? value.role.trim()
    : inferOutlineRole(type, index);

  return {
    slideIndex: Number.isInteger(value.slideIndex) && value.slideIndex >= 0 ? value.slideIndex : index,
    type,
    role,
    message: typeof value.message === 'string' ? value.message : '',
    itemRefs: normalizeStringList(value.itemRefs),
    // 영상 프레임 매칭용 타임스탬프 — 영속화 안 하면 resume 시 프레임 소싱이 죽는다 (리뷰 D1)
    frameTs: Number.isFinite(value.frameTs) && value.frameTs >= 0 ? Math.floor(value.frameTs) : null,
  };
}

function normalizeVerify(input) {
  if (!isPlainObject(input)) {
    return null;
  }

  return {
    round: Number.isInteger(input.round) && input.round >= 0 ? input.round : 0,
    results: Array.isArray(input.results) ? input.results.map(normalizeVerifyResult) : [],
  };
}

function normalizeVerifyResult(input, index) {
  const value = isPlainObject(input) ? input : {};
  return {
    slideIndex: Number.isInteger(value.slideIndex) && value.slideIndex >= 0 ? value.slideIndex : index,
    ok: Boolean(value.ok),
    issues: normalizeStringList(value.issues),
    fix: normalizeVerifyFix(value.fix),
  };
}

function normalizeVerifyFix(input) {
  if (!isPlainObject(input)) {
    return null;
  }

  return {
    headline: typeof input.headline === 'string' ? input.headline : null,
    kicker: typeof input.kicker === 'string' ? input.kicker : null,
    subtitle: typeof input.subtitle === 'string' ? input.subtitle : null,
    paragraphs: normalizeStringList(input.paragraphs),
    closing: typeof input.closing === 'string' ? input.closing : null,
  };
}

function normalizeImageCandidate(input) {
  const value = isPlainObject(input) ? input : {};
  return {
    url: typeof value.url === 'string' ? value.url : '',
    localPath: typeof value.localPath === 'string' && value.localPath.trim() ? value.localPath.trim() : null,
    label: typeof value.label === 'string' ? value.label : '',
    selected: Boolean(value.selected),
    width: Number.isInteger(value.width) && value.width >= 0 ? value.width : 0,
    height: Number.isInteger(value.height) && value.height >= 0 ? value.height : 0,
  };
}

function normalizeTranscriptSegments(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      const value = isPlainObject(item) ? item : {};
      const t = Number(value.t);
      if (!Number.isFinite(t) || t < 0 || typeof value.text !== 'string') {
        return null;
      }
      return {
        t,
        text: value.text,
      };
    })
    .filter(Boolean)
    .slice(0, 400);
}

function normalizeSlide(input, index) {
  const value = isPlainObject(input) ? input : {};
  const type = SLIDE_TYPES.has(value.type) ? value.type : inferSlideType(index);
  const text = normalizeSlideText(value.text || value, type);
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : generateId('slide'),
    type,
    order: Number.isInteger(value.order) && value.order >= 0 ? value.order : index,
    text,
    photo: typeof value.photo === 'string' && value.photo.trim() ? value.photo.trim() : null,
    imagePath: typeof value.imagePath === 'string' && value.imagePath.trim() ? value.imagePath.trim() : null,
    dirty: Boolean(value.dirty),
    overflow: Boolean(value.overflow),
    verifyFailed: Boolean(value.verifyFailed),
  };
}

function normalizeSlideText(input, type) {
  const value = isPlainObject(input) ? input : {};
  if (type === 'body') {
    return {
      headline: null,
      kicker: null,
      subtitle: typeof value.subtitle === 'string' ? value.subtitle : '',
      paragraphs: normalizeStringList(value.paragraphs),
      closing: null,
      lineSpacing: normalizeLineSpacing(value.lineSpacing),
      source: typeof value.source === 'string' && value.source.trim() ? value.source.trim() : null,
      subtitleSize: normalizeFontSize(value.subtitleSize),
      bodySize: normalizeFontSize(value.bodySize),
      bodyPos: normalizeHeadlinePos(value.bodyPos),
      overlays: normalizeOverlays(value.overlays),
    };
  }

  if (type === 'ending') {
    return {
      headline: typeof value.headline === 'string' ? value.headline : '',
      kicker: null,
      subtitle: null,
      paragraphs: [],
      closing: typeof value.closing === 'string' ? value.closing : null,
      headlinePos: normalizeHeadlinePos(value.headlinePos),
      overlays: normalizeOverlays(value.overlays),
    };
  }

  return {
    headline: typeof value.headline === 'string' ? value.headline : '',
    kicker: typeof value.kicker === 'string' ? value.kicker : null,
    kickerBg: normalizeKickerBg(value.kickerBg),
    prebuilt: typeof value.prebuilt === 'string' && value.prebuilt.trim() ? value.prebuilt.trim() : null,
    subtitle: null,
    paragraphs: [],
    closing: null,
    headlinePos: normalizeHeadlinePos(value.headlinePos),
    overlays: normalizeOverlays(value.overlays),
  };
}

function normalizeHeadlinePos(value) {
  // 헤드라인을 드래그로 옮긴 위치(중심, 0~1 비율). null = 기본 레이아웃.
  if (!isPlainObject(value)) {
    return null;
  }
  const x = Number(value.xPct);
  const y = Number(value.yPct);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { xPct: Math.min(1, Math.max(0, x)), yPct: Math.min(1, Math.max(0, y)) };
}

function normalizeOverlays(value) {
  // 사용자가 에디터에서 자유 추가하는 텍스트 오버레이(드래그 위치). 좌표는 0~1 비율(해상도 독립).
  if (!Array.isArray(value)) {
    return [];
  }
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  return value
    .filter((item) => isPlainObject(item) && typeof item.text === 'string' && item.text.trim())
    .map((item, index) => {
      const x = Number(item.xPct);
      const y = Number(item.yPct);
      const size = Number(item.size);
      const color = typeof item.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(item.color.trim())
        ? item.color.trim().toLowerCase()
        : '#ffffff';
      return {
        id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `ov_${index}`,
        text: item.text.trim().slice(0, 120),
        xPct: clamp01(Number.isFinite(x) ? x : 0.5),
        yPct: clamp01(Number.isFinite(y) ? y : 0.5),
        size: Math.min(180, Math.max(16, Number.isFinite(size) ? Math.round(size) : 48)),
        color,
        weight: item.weight === 'regular' ? 'regular' : 'bold',
      };
    })
    .slice(0, 12);
}

function normalizeKickerBg(value) {
  // 커버 키커 칩 배경 불투명도(%). null/빈값 = '기본(88)' 그대로 보존 (Number(null)===0 함정 회피)
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeFontSize(value) {
  // Number(null) === 0 → 최소값으로 오염되는 함정. null/빈값 = '자동' 그대로 보존
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.max(22, Math.min(80, Math.round(number)));
}

function normalizeLineSpacing(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.max(1.2, Math.min(1.8, number));
}

function normalizeJob(input) {
  if (!isPlainObject(input)) {
    return null;
  }

  if (!JOB_STAGES.has(input.stage)) {
    return null;
  }

  return {
    stage: input.stage,
    progress: typeof input.progress === 'string' ? input.progress : '',
    startedAt: isIsoLike(input.startedAt) ? input.startedAt : isoNow(),
  };
}

function normalizeAccent(input, fallback) {
  if (!Array.isArray(input) || input.length !== 3) {
    return fallback.slice();
  }

  const next = input.map((channel) => {
    if (!Number.isInteger(channel)) {
      return null;
    }
    return Math.max(0, Math.min(255, channel));
  });

  if (next.some((channel) => channel === null)) {
    return fallback.slice();
  }

  return next;
}

function normalizeTrust(value) {
  if (!Number.isInteger(value)) {
    return 3;
  }
  return Math.max(1, Math.min(5, value));
}

function normalizeSourceType(value) {
  if (typeof value !== 'string') {
    return 'blog';
  }
  const lowered = value.trim().toLowerCase();
  if (SOURCE_TYPES.has(lowered)) {
    return lowered;
  }
  return SOURCE_TYPE_ALIASES[value.trim()] || 'blog';
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeConfidence(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, Number(value)));
}

function inferSlideType(index) {
  if (index === 0) {
    return 'cover';
  }
  return 'body';
}

function inferOutlineType(index, role) {
  if (typeof role === 'string') {
    const trimmed = role.trim();
    if (trimmed === 'cover') {
      return 'cover';
    }
    if (trimmed === 'ending') {
      return 'ending';
    }
  }

  return inferSlideType(index);
}

function inferOutlineRole(type, index) {
  if (type === 'cover') {
    return 'cover';
  }
  if (type === 'ending') {
    return 'ending';
  }
  return index === 1 ? 'context' : 'body';
}

function toLegacySpecSlide(slide) {
  if (slide.type === 'body') {
    return {
      id: slide.id,
      type: slide.type,
      order: slide.order,
      subtitle: slide.text.subtitle,
      paragraphs: slide.text.paragraphs,
      photo: slide.photo,
      imagePath: slide.imagePath,
      dirty: slide.dirty,
      verifyFailed: slide.verifyFailed,
    };
  }

  return {
    id: slide.id,
    type: slide.type,
    order: slide.order,
    headline: slide.text.headline,
    kicker: slide.text.kicker,
    closing: slide.text.closing,
    photo: slide.photo,
    imagePath: slide.imagePath,
    dirty: slide.dirty,
    verifyFailed: slide.verifyFailed,
  };
}

function compareByUpdatedDesc(left, right) {
  return String(right.updatedAt).localeCompare(String(left.updatedAt));
}

function compareByCreatedDesc(left, right) {
  return String(right.createdAt).localeCompare(String(left.createdAt));
}

function compareSlides(left, right) {
  return left.order - right.order;
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value)) {
    const error = new Error(`Invalid ${label}.`);
    error.code = 'INVALID_ID';
    throw error;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIsoLike(value) {
  return typeof value === 'string' && value.length >= 20;
}

function isoNow() {
  return new Date().toISOString();
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_SOURCES,
  DEFAULT_TONE_PRESETS,
  POST_STATUSES,
  POST_TYPES,
  INPUT_TYPES,
  SOURCE_TYPES,
  SLIDE_TYPES,
  JOB_STAGES,
  createStore,
  readJson,
  writeJsonAtomic,
  ensureDir,
  exists,
};
