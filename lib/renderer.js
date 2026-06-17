const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { atomicWrite } = require('./utils');

const fsp = fs.promises;
const DEFAULT_HOT = [214, 245, 90];

function createRenderer({ store }) {
  async function renderSlides(post, options = {}) {
    const current = await store.getPost(post.id);
    if (!current) {
      throw new Error('Post not found');
    }

    const settings = await store.getSettings();
    const makeCardPath = resolveMakeCardPath(store.dataDir, settings.makeCardPath);
    const paths = store.getPostPaths(current.id);
    const specPath = path.join(paths.postDir, '.render_spec.json');
    const spec = buildSpec(current, paths);
    await atomicWrite(specPath, `${JSON.stringify(spec, null, 2)}\n`);

    const targetIndices = resolveTargetIndices(current, options.slideIds);
    const rendered = [];
    const failed = [];
    const warnings = [];
    const nextSlides = current.slides.slice();

    try {
      for (const index of targetIndices) {
        const slide = current.slides[index];
        try {
          const result = await runMakeCard(makeCardPath, specPath, index);
          const outputPath = spec.slides[index].out;
          const stat = await fsp.stat(outputPath);
          if (!stat.isFile() || stat.size <= 0) {
            throw new Error('출력 파일이 비어 있습니다');
          }

          nextSlides[index] = {
            ...slide,
            imagePath: `/data/posts/${current.id}/slides/${path.basename(outputPath)}`,
            dirty: false,
            overflow: result.overflow,
          };

          if (result.overflow || result.placeholder) {
            warnings.push(slide.id);
          }

          rendered.push({
            slideId: slide.id,
            imagePath: nextSlides[index].imagePath,
            success: true,
          });
        } catch (error) {
          failed.push({
            slideId: slide.id,
            error: error.message,
          });
        }
      }

      const saved = await store.updatePost(current.id, {
        slides: nextSlides,
        coverImage: nextSlides[0] && nextSlides[0].imagePath ? nextSlides[0].imagePath : null,
      });

      return {
        post: saved,
        rendered,
        failed,
        warnings,
      };
    } finally {
      await fsp.rm(specPath, { force: true });
    }
  }

  return {
    renderSlides,
  };
}

function buildSpec(post, paths) {
  const outdir = paths.slidesDir;
  return {
    brand: post.brand,
    theme: resolveRenderTheme(post.format),
    outdir,
    slides: post.slides.map((slide, index) => {
      const outputPath = path.join(outdir, `${String(index + 1).padStart(2, '0')}_${slide.type}.png`);
      if (slide.type === 'body') {
        return {
          type: slide.type,
          subtitle: slide.text.subtitle || '',
          paragraphs: Array.isArray(slide.text.paragraphs) ? slide.text.paragraphs : [],
          photo: resolvePhotoPath(paths.postDir, slide.photo),
          accent: post.accent,
          hot: DEFAULT_HOT,
          lineSpacing: Number.isFinite(slide.text.lineSpacing) ? slide.text.lineSpacing : null,
          source: slide.text.source || null,
          subtitleSize: Number.isFinite(slide.text.subtitleSize) ? slide.text.subtitleSize : null,
          bodySize: Number.isFinite(slide.text.bodySize) ? slide.text.bodySize : null,
          bodyPos: slide.text.bodyPos && Number.isFinite(slide.text.bodyPos.xPct) ? slide.text.bodyPos : null,
          overlays: Array.isArray(slide.text.overlays) ? slide.text.overlays : [],
          out: outputPath,
        };
      }

      return {
        type: slide.type,
        headline: slide.text.headline || '',
        kicker: slide.text.kicker || null,
        kickerBg: Number.isFinite(slide.text.kickerBg) ? slide.text.kickerBg : null,
        prebuilt: typeof slide.text.prebuilt === 'string' && slide.text.prebuilt.trim()
          ? slide.text.prebuilt.trim() : null,
        headlinePos: slide.text.headlinePos && Number.isFinite(slide.text.headlinePos.xPct)
          ? slide.text.headlinePos : null,
        photo: resolvePhotoPath(paths.postDir, slide.photo),
        accent: post.accent,
        hot: DEFAULT_HOT,
        overlays: Array.isArray(slide.text.overlays) ? slide.text.overlays : [],
        out: outputPath,
      };
    }),
  };
}

function resolveTargetIndices(post, slideIds) {
  if (!Array.isArray(slideIds) || !slideIds.length) {
    return post.slides.map((_, index) => index);
  }

  const targets = [];
  for (const slideId of slideIds) {
    const index = post.slides.findIndex((slide) => slide.id === slideId);
    if (index !== -1) {
      targets.push(index);
    }
  }
  return Array.from(new Set(targets));
}

function resolvePhotoPath(postDir, photo) {
  if (typeof photo !== 'string' || !photo.trim()) {
    return null;
  }
  if (path.isAbsolute(photo)) {
    return photo;
  }
  return path.join(postDir, photo);
}

function resolveMakeCardPath(dataDir, configuredPath) {
  if (configuredPath && configuredPath.trim()) {
    return configuredPath.trim();
  }
  return path.join(path.dirname(dataDir), 'make_card.py');
}

function resolveRenderTheme(format) {
  // 실측(bzcf): 어록·인물·탐정(거제야호)·넘버링(이병철) = 라이트 아이보리 / 뉴스·배움 = 다크
  const LIGHT_FORMATS = new Set(['quote', 'profile', 'detective', 'listicle']);
  return LIGHT_FORMATS.has(format) ? 'light' : 'dark';
}

function runMakeCard(makeCardPath, specPath, slideIndex) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const child = spawn('python3', [makeCardPath, 'json', specPath, String(slideIndex)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`make_card.py failed: ${stderr.slice(0, 1000)}`));
        return;
      }

      const lines = stdout.split(/\r?\n/).map((line) => line.trim());
      const overflow = lines.includes(`WARN:overflow:${slideIndex}`);
      const placeholder = lines.includes(`WARN:placeholder:${slideIndex}`);

      resolve({ overflow, placeholder, stdout, stderr });
    });
  });
}

module.exports = {
  createRenderer,
};
