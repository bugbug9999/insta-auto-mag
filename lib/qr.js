const fs = require('fs');
const http = require('http');
const path = require('path');

const { escapeHtml, generateToken, getLanIP } = require('./utils');

const fsp = fs.promises;
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

async function createExportShare(exportDir) {
  const token = generateToken();
  const lanIp = getLanIP();
  const files = await listExportFiles(exportDir);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://0.0.0.0');
        const pathname = decodeURIComponent(url.pathname || '/');
        const prefix = `/${token}`;

        if (!pathname.startsWith(prefix)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const relative = pathname.slice(prefix.length).replace(/^\/+/, '');
        if (!relative) {
          const html = renderGalleryHtml(token, files);
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
          });
          res.end(html);
          return;
        }

        const fileName = path.basename(relative);
        const targetPath = path.join(exportDir, fileName);
        if (fileName !== relative || !files.includes(fileName)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const body = await fsp.readFile(targetPath);
        res.writeHead(200, {
          'content-type': mimeType(fileName),
          'content-length': String(body.length),
        });
        res.end(body);
      } catch (error) {
        res.writeHead(500);
        res.end('Server error');
      }
    });

    server.on('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const port = server.address().port;
      const url = `http://${lanIp}:${port}/${token}/`;
      const timer = setTimeout(() => {
        server.close();
      }, 5 * 60 * 1000);

      resolve({
        url,
        svgDataUri: createQrDataUri(url),
        close() {
          clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}

function createQrDataUri(text) {
  const svg = createQrSvg(text);
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function createQrSvg(text, options = {}) {
  const qr = makeQr(text);
  const margin = Number.isInteger(options.margin) ? options.margin : 4;
  const moduleSize = Number.isInteger(options.moduleSize) ? options.moduleSize : 8;
  const count = qr.moduleCount;
  const size = (count + margin * 2) * moduleSize;
  const parts = [];

  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.modules[row][col]) {
        continue;
      }
      const x = (col + margin) * moduleSize;
      const y = (row + margin) * moduleSize;
      parts.push(`M${x},${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">
<rect width="${size}" height="${size}" fill="#ffffff"/>
<path d="${parts.join('')}" fill="#000000"/>
</svg>`;
}

function makeQr(text) {
  const data = selectDataMode(text);
  let typeNumber = 1;
  while (typeNumber <= 40) {
    const rsBlocks = getRSBlocks(typeNumber);
    const buffer = new BitBuffer();
    buffer.put(data.mode, 4);
    buffer.put(data.length, typeNumber < 10 ? data.lengthBitsSmall : data.lengthBitsLarge);
    data.write(buffer);

    const totalDataCount = rsBlocks.reduce((sum, block) => sum + block.dataCount, 0);
    if (buffer.getLengthInBits() <= totalDataCount * 8) {
      const bytes = createData(typeNumber, data, rsBlocks);
      const qr = new QRCodeModel(typeNumber, bytes);
      qr.make();
      return qr;
    }
    typeNumber += 1;
  }

  throw new Error('QR payload too large');
}

function selectDataMode(text) {
  if (/^[0-9A-Z $%*+\-./:]+$/.test(text)) {
    return {
      mode: 0x2,
      length: text.length,
      lengthBitsSmall: 9,
      lengthBitsLarge: 11,
      write(buffer) {
        let index = 0;
        while (index + 1 < text.length) {
          const value = ALNUM.indexOf(text[index]) * 45 + ALNUM.indexOf(text[index + 1]);
          buffer.put(value, 11);
          index += 2;
        }
        if (index < text.length) {
          buffer.put(ALNUM.indexOf(text[index]), 6);
        }
      },
    };
  }

  const bytes = Array.from(Buffer.from(text, 'utf8'));
  return {
    mode: 0x4,
    length: bytes.length,
    lengthBitsSmall: 8,
    lengthBitsLarge: 16,
    write(buffer) {
      for (const byte of bytes) {
        buffer.put(byte, 8);
      }
    },
  };
}

function createData(typeNumber, data, rsBlocks) {
  const buffer = new BitBuffer();
  buffer.put(data.mode, 4);
  buffer.put(data.length, typeNumber < 10 ? data.lengthBitsSmall : data.lengthBitsLarge);
  data.write(buffer);

  const totalDataCount = rsBlocks.reduce((sum, block) => sum + block.dataCount, 0);
  if (buffer.getLengthInBits() > totalDataCount * 8) {
    throw new Error('code length overflow');
  }

  if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
    buffer.put(0, 4);
  }
  while (buffer.getLengthInBits() % 8 !== 0) {
    buffer.putBit(false);
  }

  const pads = [0xec, 0x11];
  let padIndex = 0;
  while (buffer.buffer.length < totalDataCount) {
    buffer.put(pads[padIndex % 2], 8);
    padIndex += 1;
  }

  return createBytes(buffer.buffer, rsBlocks);
}

function createBytes(data, rsBlocks) {
  let offset = 0;
  let maxDcCount = 0;
  let maxEcCount = 0;
  const dcData = [];
  const ecData = [];

  for (let r = 0; r < rsBlocks.length; r += 1) {
    const dcCount = rsBlocks[r].dataCount;
    const ecCount = rsBlocks[r].totalCount - dcCount;
    maxDcCount = Math.max(maxDcCount, dcCount);
    maxEcCount = Math.max(maxEcCount, ecCount);

    dcData[r] = [];
    for (let i = 0; i < dcCount; i += 1) {
      dcData[r][i] = data[i + offset];
    }
    offset += dcCount;

    const rsPoly = getErrorCorrectPolynomial(ecCount);
    const rawPoly = new QRPolynomial(dcData[r], rsPoly.getLength() - 1);
    const modPoly = rawPoly.mod(rsPoly);

    ecData[r] = [];
    for (let i = 0; i < ecCount; i += 1) {
      const modIndex = i + modPoly.getLength() - ecCount;
      ecData[r][i] = modIndex >= 0 ? modPoly.get(modIndex) : 0;
    }
  }

  const totalCodeCount = rsBlocks.reduce((sum, block) => sum + block.totalCount, 0);
  const result = [];

  for (let i = 0; i < maxDcCount; i += 1) {
    for (let r = 0; r < rsBlocks.length; r += 1) {
      if (i < dcData[r].length) {
        result.push(dcData[r][i]);
      }
    }
  }

  for (let i = 0; i < maxEcCount; i += 1) {
    for (let r = 0; r < rsBlocks.length; r += 1) {
      if (i < ecData[r].length) {
        result.push(ecData[r][i]);
      }
    }
  }

  if (result.length !== totalCodeCount) {
    throw new Error('bad rs block');
  }

  return result;
}

function getErrorCorrectPolynomial(errorCorrectLength) {
  let poly = new QRPolynomial([1], 0);
  for (let i = 0; i < errorCorrectLength; i += 1) {
    poly = poly.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0));
  }
  return poly;
}

function listExportFiles(exportDir) {
  return fsp.readdir(exportDir).then((entries) => {
    return entries
      .filter((name) => !name.startsWith('.'))
      .sort((left, right) => left.localeCompare(right));
  });
}

function renderGalleryHtml(token, files) {
  const caption = files.includes('caption.txt')
    ? `<p><a href="/${token}/caption.txt" download="caption.txt">caption.txt 다운로드</a></p>`
    : '';

  const images = files
    .filter((file) => /\.(png|jpg|jpeg|webp)$/i.test(file))
    .map((file) => {
      return `<figure><img src="/${token}/${encodeURIComponent(file)}" alt="${escapeHtml(file)}"/><figcaption><a href="/${token}/${encodeURIComponent(file)}" download="${escapeHtml(file)}">${escapeHtml(file)}</a></figcaption></figure>`;
    })
    .join('');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Export Share</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:24px;background:#111827;color:#f9fafb}
h1{font-size:20px;margin:0 0 16px}
a{color:#93c5fd}
.grid{display:grid;gap:16px}
img{display:block;max-width:100%;border-radius:12px}
figure{margin:0;background:#1f2937;padding:12px;border-radius:16px}
figcaption{margin-top:8px;font-size:14px}
</style>
</head>
<body>
<h1>Carousel Export</h1>
${caption}
<div class="grid">${images}</div>
</body>
</html>`;
}

function mimeType(fileName) {
  if (/\.png$/i.test(fileName)) {
    return 'image/png';
  }
  if (/\.jpe?g$/i.test(fileName)) {
    return 'image/jpeg';
  }
  if (/\.webp$/i.test(fileName)) {
    return 'image/webp';
  }
  if (/\.svg$/i.test(fileName)) {
    return 'image/svg+xml';
  }
  return 'text/plain; charset=utf-8';
}

class QRCodeModel {
  constructor(typeNumber, dataCache) {
    this.typeNumber = typeNumber;
    this.errorCorrectLevel = 1;
    this.modules = null;
    this.moduleCount = 0;
    this.dataCache = dataCache;
  }

  make() {
    this.makeImpl(false, this.getBestMaskPattern());
  }

  makeImpl(test, maskPattern) {
    this.moduleCount = this.typeNumber * 4 + 17;
    this.modules = Array.from({ length: this.moduleCount }, () => Array(this.moduleCount).fill(null));

    this.setupPositionProbePattern(0, 0);
    this.setupPositionProbePattern(this.moduleCount - 7, 0);
    this.setupPositionProbePattern(0, this.moduleCount - 7);
    this.setupPositionAdjustPattern();
    this.setupTimingPattern();
    this.setupTypeInfo(test, maskPattern);
    if (this.typeNumber >= 7) {
      this.setupTypeNumber(test);
    }
    this.mapData(this.dataCache, maskPattern);
  }

  setupPositionProbePattern(row, col) {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r <= -1 || this.moduleCount <= row + r) {
        continue;
      }
      for (let c = -1; c <= 7; c += 1) {
        if (col + c <= -1 || this.moduleCount <= col + c) {
          continue;
        }
        if (
          (0 <= r && r <= 6 && (c === 0 || c === 6))
          || (0 <= c && c <= 6 && (r === 0 || r === 6))
          || (2 <= r && r <= 4 && 2 <= c && c <= 4)
        ) {
          this.modules[row + r][col + c] = true;
        } else {
          this.modules[row + r][col + c] = false;
        }
      }
    }
  }

  getBestMaskPattern() {
    let minLostPoint = 0;
    let pattern = 0;
    for (let i = 0; i < 8; i += 1) {
      this.makeImpl(true, i);
      const lostPoint = getLostPoint(this);
      if (i === 0 || minLostPoint > lostPoint) {
        minLostPoint = lostPoint;
        pattern = i;
      }
    }
    return pattern;
  }

  setupTimingPattern() {
    for (let r = 8; r < this.moduleCount - 8; r += 1) {
      if (this.modules[r][6] !== null) {
        continue;
      }
      this.modules[r][6] = r % 2 === 0;
    }
    for (let c = 8; c < this.moduleCount - 8; c += 1) {
      if (this.modules[6][c] !== null) {
        continue;
      }
      this.modules[6][c] = c % 2 === 0;
    }
  }

  setupPositionAdjustPattern() {
    const positions = PATTERN_POSITION_TABLE[this.typeNumber - 1];
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = 0; j < positions.length; j += 1) {
        const row = positions[i];
        const col = positions[j];
        if (this.modules[row][col] !== null) {
          continue;
        }
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            this.modules[row + r][col + c] =
              r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          }
        }
      }
    }
  }

  setupTypeNumber(test) {
    const bits = getBCHTypeNumber(this.typeNumber);
    for (let i = 0; i < 18; i += 1) {
      const mod = !test && ((bits >> i) & 1) === 1;
      this.modules[Math.floor(i / 3)][(i % 3) + this.moduleCount - 8 - 3] = mod;
    }
    for (let i = 0; i < 18; i += 1) {
      const mod = !test && ((bits >> i) & 1) === 1;
      this.modules[(i % 3) + this.moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
    }
  }

  setupTypeInfo(test, maskPattern) {
    const data = (this.errorCorrectLevel << 3) | maskPattern;
    const bits = getBCHTypeInfo(data);

    for (let i = 0; i < 15; i += 1) {
      const mod = !test && ((bits >> i) & 1) === 1;
      if (i < 6) {
        this.modules[i][8] = mod;
      } else if (i < 8) {
        this.modules[i + 1][8] = mod;
      } else {
        this.modules[this.moduleCount - 15 + i][8] = mod;
      }
    }

    for (let i = 0; i < 15; i += 1) {
      const mod = !test && ((bits >> i) & 1) === 1;
      if (i < 8) {
        this.modules[8][this.moduleCount - i - 1] = mod;
      } else if (i < 9) {
        this.modules[8][15 - i - 1 + 1] = mod;
      } else {
        this.modules[8][15 - i - 1] = mod;
      }
    }

    this.modules[this.moduleCount - 8][8] = !test;
  }

  mapData(data, maskPattern) {
    let inc = -1;
    let row = this.moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;

    for (let col = this.moduleCount - 1; col > 0; col -= 2) {
      if (col === 6) {
        col -= 1;
      }
      while (true) {
        for (let c = 0; c < 2; c += 1) {
          if (this.modules[row][col - c] !== null) {
            continue;
          }
          let dark = false;
          if (byteIndex < data.length) {
            dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          }
          if (getMask(maskPattern, row, col - c)) {
            dark = !dark;
          }
          this.modules[row][col - c] = dark;
          bitIndex -= 1;
          if (bitIndex === -1) {
            byteIndex += 1;
            bitIndex = 7;
          }
        }

        row += inc;
        if (row < 0 || this.moduleCount <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  }
}

class BitBuffer {
  constructor() {
    this.buffer = [];
    this.length = 0;
  }

  getLengthInBits() {
    return this.length;
  }

  put(num, length) {
    for (let i = 0; i < length; i += 1) {
      this.putBit(((num >>> (length - i - 1)) & 1) === 1);
    }
  }

  putBit(bit) {
    const bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) {
      this.buffer.push(0);
    }
    if (bit) {
      this.buffer[bufIndex] |= 0x80 >>> (this.length % 8);
    }
    this.length += 1;
  }
}

class QRPolynomial {
  constructor(num, shift) {
    let offset = 0;
    while (offset < num.length && num[offset] === 0) {
      offset += 1;
    }
    this.num = new Array(num.length - offset + shift);
    for (let i = 0; i < num.length - offset; i += 1) {
      this.num[i] = num[i + offset];
    }
  }

  get(index) {
    return this.num[index];
  }

  getLength() {
    return this.num.length;
  }

  multiply(other) {
    const num = new Array(this.getLength() + other.getLength() - 1).fill(0);
    for (let i = 0; i < this.getLength(); i += 1) {
      for (let j = 0; j < other.getLength(); j += 1) {
        num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(other.get(j)));
      }
    }
    return new QRPolynomial(num, 0);
  }

  mod(other) {
    if (this.getLength() - other.getLength() < 0) {
      return this;
    }

    const ratio = QRMath.glog(this.get(0)) - QRMath.glog(other.get(0));
    const num = this.num.slice();
    for (let i = 0; i < other.getLength(); i += 1) {
      num[i] ^= QRMath.gexp(QRMath.glog(other.get(i)) + ratio);
    }
    return new QRPolynomial(num, 0).mod(other);
  }
}

const QRMath = {
  glog(n) {
    if (n < 1) {
      throw new Error(`glog(${n})`);
    }
    return this.LOG_TABLE[n];
  },
  gexp(n) {
    while (n < 0) {
      n += 255;
    }
    while (n >= 256) {
      n -= 255;
    }
    return this.EXP_TABLE[n];
  },
  EXP_TABLE: new Array(256),
  LOG_TABLE: new Array(256),
};

for (let i = 0; i < 8; i += 1) {
  QRMath.EXP_TABLE[i] = 1 << i;
}
for (let i = 8; i < 256; i += 1) {
  QRMath.EXP_TABLE[i] =
    QRMath.EXP_TABLE[i - 4]
    ^ QRMath.EXP_TABLE[i - 5]
    ^ QRMath.EXP_TABLE[i - 6]
    ^ QRMath.EXP_TABLE[i - 8];
}
for (let i = 0; i < 255; i += 1) {
  QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]] = i;
}

function getRSBlocks(typeNumber) {
  const table = RS_BLOCK_TABLE[(typeNumber - 1) * 4];
  const list = [];
  for (let i = 0; i < table.length / 3; i += 1) {
    const count = table[i * 3];
    const totalCount = table[i * 3 + 1];
    const dataCount = table[i * 3 + 2];
    for (let j = 0; j < count; j += 1) {
      list.push({ totalCount, dataCount });
    }
  }
  return list;
}

function getBCHTypeInfo(data) {
  let d = data << 10;
  while (getBCHDigit(d) - getBCHDigit(0x537) >= 0) {
    d ^= 0x537 << (getBCHDigit(d) - getBCHDigit(0x537));
  }
  return ((data << 10) | d) ^ 0x5412;
}

function getBCHTypeNumber(data) {
  let d = data << 12;
  while (getBCHDigit(d) - getBCHDigit(0x1f25) >= 0) {
    d ^= 0x1f25 << (getBCHDigit(d) - getBCHDigit(0x1f25));
  }
  return (data << 12) | d;
}

function getBCHDigit(data) {
  let digit = 0;
  while (data !== 0) {
    digit += 1;
    data >>>= 1;
  }
  return digit;
}

function getMask(maskPattern, i, j) {
  switch (maskPattern) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default: return false;
  }
}

function getLostPoint(qrCode) {
  const moduleCount = qrCode.moduleCount;
  let lostPoint = 0;

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      let sameCount = 0;
      const dark = qrCode.modules[row][col];

      for (let r = -1; r <= 1; r += 1) {
        if (row + r < 0 || moduleCount <= row + r) {
          continue;
        }
        for (let c = -1; c <= 1; c += 1) {
          if (col + c < 0 || moduleCount <= col + c || (r === 0 && c === 0)) {
            continue;
          }
          if (dark === qrCode.modules[row + r][col + c]) {
            sameCount += 1;
          }
        }
      }

      if (sameCount > 5) {
        lostPoint += 3 + sameCount - 5;
      }
    }
  }

  for (let row = 0; row < moduleCount - 1; row += 1) {
    for (let col = 0; col < moduleCount - 1; col += 1) {
      let count = 0;
      if (qrCode.modules[row][col]) count += 1;
      if (qrCode.modules[row + 1][col]) count += 1;
      if (qrCode.modules[row][col + 1]) count += 1;
      if (qrCode.modules[row + 1][col + 1]) count += 1;
      if (count === 0 || count === 4) {
        lostPoint += 3;
      }
    }
  }

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount - 6; col += 1) {
      if (
        qrCode.modules[row][col]
        && !qrCode.modules[row][col + 1]
        && qrCode.modules[row][col + 2]
        && qrCode.modules[row][col + 3]
        && qrCode.modules[row][col + 4]
        && !qrCode.modules[row][col + 5]
        && qrCode.modules[row][col + 6]
      ) {
        lostPoint += 40;
      }
    }
  }

  for (let col = 0; col < moduleCount; col += 1) {
    for (let row = 0; row < moduleCount - 6; row += 1) {
      if (
        qrCode.modules[row][col]
        && !qrCode.modules[row + 1][col]
        && qrCode.modules[row + 2][col]
        && qrCode.modules[row + 3][col]
        && qrCode.modules[row + 4][col]
        && !qrCode.modules[row + 5][col]
        && qrCode.modules[row + 6][col]
      ) {
        lostPoint += 40;
      }
    }
  }

  let darkCount = 0;
  for (let col = 0; col < moduleCount; col += 1) {
    for (let row = 0; row < moduleCount; row += 1) {
      if (qrCode.modules[row][col]) {
        darkCount += 1;
      }
    }
  }

  const ratio = Math.abs((100 * darkCount) / moduleCount / moduleCount - 50) / 5;
  lostPoint += ratio * 10;

  return lostPoint;
}

const PATTERN_POSITION_TABLE = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

const RS_BLOCK_TABLE = [
  [1, 26, 19],[1, 26, 16],[1, 26, 13],[1, 26, 9],[1, 44, 34],[1, 44, 28],[1, 44, 22],[1, 44, 16],
  [1, 70, 55],[1, 70, 44],[2, 35, 17],[2, 35, 13],[1, 100, 80],[2, 50, 32],[2, 50, 24],[4, 25, 9],
  [1, 134, 108],[2, 67, 43],[2, 33, 15, 2, 34, 16],[2, 33, 11, 2, 34, 12],[2, 86, 68],[4, 43, 27],[4, 43, 19],[4, 43, 15],
  [2, 98, 78],[4, 49, 31],[2, 32, 14, 4, 33, 15],[4, 39, 13, 1, 40, 14],[2, 121, 97],[2, 60, 38, 2, 61, 39],[4, 40, 18, 2, 41, 19],[4, 40, 14, 2, 41, 15],
  [2, 146, 116],[3, 58, 36, 2, 59, 37],[4, 36, 16, 4, 37, 17],[4, 36, 12, 4, 37, 13],[2, 86, 68, 2, 87, 69],[4, 69, 43, 1, 70, 44],[6, 43, 19, 2, 44, 20],[6, 43, 15, 2, 44, 16],
  [4, 101, 81],[1, 80, 50, 4, 81, 51],[4, 50, 22, 4, 51, 23],[3, 36, 12, 8, 37, 13],[2, 116, 92, 2, 117, 93],[6, 58, 36, 2, 59, 37],[4, 46, 20, 6, 47, 21],[7, 42, 14, 4, 43, 15],
  [4, 133, 107],[8, 59, 37, 1, 60, 38],[8, 44, 20, 4, 45, 21],[12, 33, 11, 4, 34, 12],[3, 145, 115, 1, 146, 116],[4, 64, 40, 5, 65, 41],[11, 36, 16, 5, 37, 17],[11, 36, 12, 5, 37, 13],
  [5, 109, 87, 1, 110, 88],[5, 65, 41, 5, 66, 42],[5, 54, 24, 7, 55, 25],[11, 36, 12],[5, 122, 98, 1, 123, 99],[7, 73, 45, 3, 74, 46],[15, 43, 19, 2, 44, 20],[3, 45, 15, 13, 46, 16],
  [1, 135, 107, 5, 136, 108],[10, 74, 46, 1, 75, 47],[1, 50, 22, 15, 51, 23],[2, 42, 14, 17, 43, 15],[5, 150, 120, 1, 151, 121],[9, 69, 43, 4, 70, 44],[17, 50, 22, 1, 51, 23],[2, 42, 14, 19, 43, 15],
  [3, 141, 113, 4, 142, 114],[3, 70, 44, 11, 71, 45],[17, 47, 21, 4, 48, 22],[9, 39, 13, 16, 40, 14],[3, 135, 107, 5, 136, 108],[3, 67, 41, 13, 68, 42],[15, 54, 24, 5, 55, 25],[15, 43, 15, 10, 44, 16],
  [4, 144, 116, 4, 145, 117],[17, 68, 42],[17, 50, 22, 6, 51, 23],[19, 46, 16, 6, 47, 17],[2, 139, 111, 7, 140, 112],[17, 74, 46],[7, 54, 24, 16, 55, 25],[34, 37, 13],
  [4, 151, 121, 5, 152, 122],[4, 75, 47, 14, 76, 48],[11, 54, 24, 14, 55, 25],[16, 45, 15, 14, 46, 16],[6, 147, 117, 4, 148, 118],[6, 73, 45, 14, 74, 46],[11, 54, 24, 16, 55, 25],[30, 46, 16, 2, 47, 17],
  [8, 132, 106, 4, 133, 107],[8, 75, 47, 13, 76, 48],[7, 54, 24, 22, 55, 25],[22, 45, 15, 13, 46, 16],[10, 142, 114, 2, 143, 115],[19, 74, 46, 4, 75, 47],[28, 50, 22, 6, 51, 23],[33, 46, 16, 4, 47, 17],
  [8, 152, 122, 4, 153, 123],[22, 73, 45, 3, 74, 46],[8, 53, 23, 26, 54, 24],[12, 45, 15, 28, 46, 16],[3, 147, 117, 10, 148, 118],[3, 73, 45, 23, 74, 46],[4, 54, 24, 31, 55, 25],[11, 45, 15, 31, 46, 16],
  [7, 146, 116, 7, 147, 117],[21, 73, 45, 7, 74, 46],[1, 53, 23, 37, 54, 24],[19, 45, 15, 26, 46, 16],[5, 145, 115, 10, 146, 116],[19, 75, 47, 10, 76, 48],[15, 54, 24, 25, 55, 25],[23, 45, 15, 25, 46, 16],
  [13, 145, 115, 3, 146, 116],[2, 74, 46, 29, 75, 47],[42, 54, 24, 1, 55, 25],[23, 45, 15, 28, 46, 16],[17, 145, 115],[10, 74, 46, 23, 75, 47],[10, 54, 24, 35, 55, 25],[19, 45, 15, 35, 46, 16],
  [17, 145, 115, 1, 146, 116],[14, 74, 46, 21, 75, 47],[29, 54, 24, 19, 55, 25],[11, 45, 15, 46, 46, 16],[13, 145, 115, 6, 146, 116],[14, 74, 46, 23, 75, 47],[44, 54, 24, 7, 55, 25],[59, 46, 16, 1, 47, 17],
  [12, 151, 121, 7, 152, 122],[12, 75, 47, 26, 76, 48],[39, 54, 24, 14, 55, 25],[22, 45, 15, 41, 46, 16],[6, 151, 121, 14, 152, 122],[6, 75, 47, 34, 76, 48],[46, 54, 24, 10, 55, 25],[2, 45, 15, 64, 46, 16],
  [17, 152, 122, 4, 153, 123],[29, 74, 46, 14, 75, 47],[49, 54, 24, 10, 55, 25],[24, 45, 15, 46, 46, 16],[4, 152, 122, 18, 153, 123],[13, 74, 46, 32, 75, 47],[48, 54, 24, 14, 55, 25],[42, 45, 15, 32, 46, 16],
  [20, 147, 117, 4, 148, 118],[40, 75, 47, 7, 76, 48],[43, 54, 24, 22, 55, 25],[10, 45, 15, 67, 46, 16],[19, 148, 118, 6, 149, 119],[18, 75, 47, 31, 76, 48],[34, 54, 24, 34, 55, 25],[20, 45, 15, 61, 46, 16],
];

module.exports = {
  createQrSvg,
  createQrDataUri,
  createExportShare,
};
