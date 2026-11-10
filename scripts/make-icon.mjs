// 由 apps/web/public/favicon.svg 生成桌面图标: PNG(512) 与多尺寸 ICO(16..256)。
// 只用本机 Edge 的 --screenshot 与 node:zlib, 不引入任何 npm 依赖。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const repo = process.cwd();
const svgPath = path.join(repo, 'apps', 'web', 'public', 'favicon.svg');
const outDir = path.join(repo, 'apps', 'desktop', 'assets');
const work = path.join(repo, '.local', 'tmp', `icon-${process.pid}`);
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

function findEdge() {
  const candidates = [
    process.env.HH_EDGE,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('找不到 msedge.exe(可用 HH_EDGE 指定)');
  return hit;
}

/** 解 PNG(8 位, 非隔行, RGB 或 RGBA), 返回 RGBA 像素。 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}`);
      if (data.readUInt8(12) !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!width || !height) throw new Error('PNG 缺少 IHDR');
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`不支持的 PNG 颜色类型 ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  let line = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp];
    rp += 1;
    raw.copy(line, 0, rp, rp + stride);
    rp += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < width; x += 1) {
      const src = x * bpp;
      const dst = (y * width + x) * 4;
      out[dst] = line[src];
      out[dst + 1] = line[src + 1];
      out[dst + 2] = line[src + 2];
      out[dst + 3] = bpp === 4 ? line[src + 3] : 255;
    }
  }
  return { width, height, rgba: out };
}

/** 面积平均缩放(alpha 预乘), 用于把 512 缩到 16..256。 */
function resizeRgba(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < dw; x += 1) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1) && py < sh; py += 1) {
        const wy = Math.min(py + 1, y1) - Math.max(py, y0);
        if (wy <= 0) continue;
        for (let px = Math.floor(x0); px < Math.ceil(x1) && px < sw; px += 1) {
          const wx = Math.min(px + 1, x1) - Math.max(px, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (py * sw + px) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al * w;
          g += src[i + 1] * al * w;
          b += src[i + 2] * al * w;
          a += al * w;
          wsum += w;
        }
      }
      const o = (y * dw + x) * 4;
      const alpha = a / wsum;
      out[o + 3] = Math.round(alpha * 255);
      if (alpha > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
    }
  }
  return out;
}

function icoEntry(rgba, size) {  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = (y * size + x) * 4;
      xor[dst] = rgba[src + 2];
      xor[dst + 1] = rgba[src + 1];
      xor[dst + 2] = rgba[src];
      xor[dst + 3] = rgba[src + 3];
    }
  }
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const andMask = Buffer.alloc(maskRowBytes * size, 0);
  return Buffer.concat([header, xor, andMask]);
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

function main() {
  if (!existsSync(svgPath)) throw new Error(`缺少 ${svgPath}`);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(work, { recursive: true });

  const svg = readFileSync(svgPath);
  const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}
img{display:block;width:100vw;height:100vh}
</style><img alt="" src="data:image/svg+xml;base64,${svg.toString('base64')}">`;
  const htmlPath = path.join(work, 'page.html');
  writeFileSync(htmlPath, html, 'utf8');

  const edge = findEdge();
  const png = path.join(work, '512.png');
  const r = spawnSync(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      '--window-size=512,512',
      `--screenshot=${png}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ],
    { timeout: 60_000, windowsHide: true, stdio: 'ignore' },
  );
  if (!existsSync(png)) throw new Error(`Edge 没有产出截图(code=${r.status})`);

  const big = decodePng(readFileSync(png));
  if (big.width < 512 || big.height < 512) throw new Error(`截图尺寸异常: ${big.width}x${big.height}`);
  writeFileSync(path.join(outDir, 'icon.png'), readFileSync(png));

  // 一次渲染 512, 再用面积平均缩放出各档 ICO 尺寸(alpha 预乘, 避免深色描边)。
  const images = icoSizes.map((size) => ({
    size,
    data: icoEntry(resizeRgba(big.rgba, big.width, big.height, size, size), size),
  }));
  writeFileSync(path.join(outDir, 'icon.ico'), buildIco(images));

  const corner = [big.rgba[3], big.rgba[(big.height - 1) * big.width * 4 + 3]];
  console.log(`[icon] 512 PNG -> apps/desktop/assets/icon.png`);
  console.log(`[icon] ICO ${icoSizes.join('/')} -> apps/desktop/assets/icon.ico`);
  console.log(`[icon] 角点 alpha=${corner.join(',')}${corner.some((a) => a > 0) ? '(不透明, 检查背景)' : '(透明)'}`);
}

try {
  main();
} catch (e) {
  console.error('[icon] 失败:', e.message);
  process.exitCode = 1;
} finally {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
