const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const fsp = fs.promises;

async function atomicWrite(filePath, data) {
  const directory = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const tempPath = path.join(
    directory,
    `.${fileName}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(tempPath, data);
  await fsp.rename(tempPath, filePath);
}

function extractJSON(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    return null;
  }

  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch (error) {
    return null;
  }
}

function sanitize(value, fallback = 'file') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const sanitized = value
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);

  return sanitized || fallback;
}

function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const group of Object.values(interfaces)) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const entry of group) {
      if (entry && entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function detectInputType(input) {
  return isProbablyUrl(input) ? 'url' : 'topic';
}

function isProbablyUrl(input) {
  if (typeof input !== 'string') {
    return false;
  }

  try {
    const url = new URL(input.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function getDomain(input) {
  try {
    return new URL(input).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (error) {
    return '';
  }
}

function htmlToText(html) {
  if (typeof html !== 'string') {
    return '';
  }

  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  atomicWrite,
  extractJSON,
  sanitize,
  getLanIP,
  generateToken,
  detectInputType,
  isProbablyUrl,
  getDomain,
  htmlToText,
  decodeHtmlEntities,
  escapeHtml,
};
