/**
 * Generates resources/icon.png (1024x1024) with zero dependencies.
 *
 * The icon is the source of truth for packaging: electron-builder converts this
 * single PNG into the platform formats (.icns / .ico) at build time, so there
 * are no binary icon blobs to commit or keep in sync. Re-run with
 * `node scripts/generate-icon.mjs` after changing the design.
 *
 * Design: a rounded blue tile (matching the app accent) carrying three white
 * "index rows" above a green query-latency pulse — the same visual language as
 * the in-app sidebar (accent), status dots (good-green) and monitoring pulse.
 *
 * Rendering is a tiny signed-distance-field rasterizer: each shape returns a
 * distance, converted to antialiased coverage and alpha-composited. PNG is
 * encoded by hand (IHDR + single deflated IDAT + IEND) using node:zlib.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;

// --- palette (mirrors tailwind.config.js) ---
const ACCENT_TOP = [0x5b, 0x8d, 0xef];
const ACCENT_BOT = [0x32, 0x52, 0x9c];
const WHITE = [0xff, 0xff, 0xff];
const GREEN = [0x3f, 0xb9, 0x50];

// --- signed-distance helpers (positive = outside shape) ---
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
function sdPolyline(px, py, pts, halfWidth) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, sdSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  return d - halfWidth;
}

// coverage from a signed distance (1px antialiased edge)
const cov = (d) => Math.max(0, Math.min(1, 0.5 - d));

// src-over composite of a straight-alpha color onto an [r,g,b,a] buffer pixel
function over(dst, i, color, a) {
  if (a <= 0) return;
  const inv = 1 - a;
  dst[i] = color[0] * a + dst[i] * inv;
  dst[i + 1] = color[1] * a + dst[i + 1] * inv;
  dst[i + 2] = color[2] * a + dst[i + 2] * inv;
  dst[i + 3] = a * 255 + dst[i + 3] * inv;
}

function render() {
  const buf = new Float64Array(SIZE * SIZE * 4); // straight RGBA, 0..255

  const tileHalf = (SIZE - 96) / 2; // 48px inset
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const radius = 224;

  // three "index rows" (white), top-aligned within the tile
  const rows = [
    { cx: 512, cy: 312, hw: 248, hh: 38 },
    { cx: 442, cy: 432, hw: 178, hh: 38 },
    { cx: 482, cy: 552, hw: 218, hh: 38 },
  ];

  // query-latency pulse (green heartbeat) across the lower third
  const pulse = [
    [264, 720], [372, 720], [440, 632], [520, 824], [600, 668], [700, 720], [760, 720],
  ];

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      // 1) background tile with vertical gradient, masked to the rounded rect
      const tile = cov(sdRoundRect(px, py, cx, cy, tileHalf, tileHalf, radius));
      if (tile > 0) {
        const t = (py - (cy - tileHalf)) / (tileHalf * 2);
        const bg = [
          ACCENT_TOP[0] + (ACCENT_BOT[0] - ACCENT_TOP[0]) * t,
          ACCENT_TOP[1] + (ACCENT_BOT[1] - ACCENT_TOP[1]) * t,
          ACCENT_TOP[2] + (ACCENT_BOT[2] - ACCENT_TOP[2]) * t,
        ];
        over(buf, i, bg, tile);
      }

      // 2) index rows (clipped to the tile so AA edges stay inside)
      for (const r of rows) {
        const c = Math.min(cov(sdRoundRect(px, py, r.cx, r.cy, r.hw, r.hh, r.hh)), tile);
        if (c > 0) over(buf, i, WHITE, c * 0.95);
      }

      // 3) latency pulse
      const c = Math.min(cov(sdPolyline(px, py, pulse, 16)), tile);
      if (c > 0) over(buf, i, GREEN, c);
    }
  }

  // quantize to 8-bit
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let k = 0; k < buf.length; k++) out[k] = Math.round(Math.max(0, Math.min(255, buf[k])));
  return out;
}

// --- minimal PNG encoder ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../resources/icon.png');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, encodePng(render(), SIZE));
console.log(`wrote ${outPath} (${SIZE}x${SIZE})`);
