#!/usr/bin/env node
/**
 * Draws the WhiteSoft mark and writes every place it is needed.
 *
 * The mark is a rounded canvas in the interface's accent blue with a white
 * marker stroke across it: legible at 16 px, which is the size the menu bar and
 * the window title use.
 *
 * Outputs:
 *   desktop/winres/app.ico      16, 32, 48, 256 for the executable
 *   public/favicon.ico          same, for the browser tab
 *   public/brand.svg            vector copy for the menu bar
 */
import fs from 'node:fs';
import path from 'node:path';

const ACCENT = '#0F6CBD';
const SIZES = [16, 32, 48, 256];
const OUT_DIR = process.argv[2] || '.';

/** The mark as SVG, used directly by the interface. */
function svg(size) {
  // Coordinates are a 16 unit grid so the shapes stay whole numbers at 16 px.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}">
  <rect x="0.5" y="0.5" width="15" height="15" rx="3.25" fill="${ACCENT}"/>
  <path d="M3.6 10.4 L6.2 5.6 L8.6 8.4 L10.6 5.2 L12.4 8.8"
        fill="none" stroke="#FFFFFF" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

/* ------------------------------------------------------------------ raster */

/**
 * Renders the mark at one size into an RGBA buffer.
 * Written by hand so the result does not depend on a browser or an image
 * library being present; the shapes are simple rounded rect and round-capped
 * segments, both of which are a signed distance away from trivial.
 */
function render(size) {
  const px = new Uint8Array(size * size * 4);
  const accent = [0x0f, 0x6c, 0xbd];
  const s = size / 16;                       // 16 unit grid to pixels
  const r = 3.25 * s;                        // corner radius
  // Stroke centre line, in the same 16 unit grid.
  const line = [[3.6, 10.4], [6.2, 5.6], [8.6, 8.4], [10.6, 5.2], [12.4, 8.8]]
    .map(([x, y]) => [x * s, y * s]);
  const stroke = (1.7 * s) / 2;

  const put = (x, y, rgb, a) => {
    const i = (y * size + x) * 4;
    const inA = a;
    const outA = px[i + 3] / 255;
    const na = inA + outA * (1 - inA);
    if (na <= 0) return;
    for (let c = 0; c < 3; c++) {
      px[i + c] = Math.round((rgb[c] * inA + px[i + c] * outA * (1 - inA)) / na);
    }
    px[i + 3] = Math.round(na * 255);
  };

  // coverage helper: distance to a rounded rectangle
  const roundedRectAlpha = (x, y) => {
    const cx = x + 0.5, cy = y + 0.5;
    const dx = Math.abs(cx - size / 2) - (size / 2 - r);
    const dy = Math.abs(cy - size / 2) - (size / 2 - r);
    const qx = Math.max(dx, 0), qy = Math.max(dy, 0);
    const d = Math.hypot(qx, qy) + Math.min(Math.max(dx, dy), 0) - r;
    return Math.min(Math.max(0.5 - d, 0), 1);
  };
  const segDist = (x, y, a, b) => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const wx = x - a[0], wy = y - a[1];
    const len2 = vx * vx + vy * vy || 1;
    let t = (wx * vx + wy * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(wx - vx * t, wy - vy * t);
  };
  const strokeAlpha = (x, y) => {
    let best = Infinity;
    for (let i = 0; i + 1 < line.length; i++) {
      best = Math.min(best, segDist(x + 0.5, y + 0.5, line[i], line[i + 1]));
    }
    return Math.min(Math.max(stroke + 0.5 - best, 0), 1);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const base = roundedRectAlpha(x, y);
      if (base > 0) put(x, y, accent, base);
      const ink = strokeAlpha(x, y) * base;
      if (ink > 0) put(x, y, [255, 255, 255], ink);
    }
  }
  return px;
}

/** Encodes an RGBA buffer as a PNG. */
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                       // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4)
      .copy(raw, y * (size * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibDeflate(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Minimal zlib wrapper around Node's own compressor, stored blocks avoided. */
import zlib from 'node:zlib';
function zlibDeflate(buf) {
  return zlib.deflateSync(buf, { level: 9 });
}

/**
 * Encodes an RGBA buffer as a 32-bit BMP icon entry.
 *
 * Only the 256 px image may be stored as PNG inside an icon. Older shell APIs,
 * including the one behind the shortcut's "change icon" dialog, cannot read a
 * PNG at 16, 32 or 48 px and fall back to the generic icon. Those sizes are
 * therefore written the classic way: a bottom-up BGRA bitmap plus the 1-bit
 * transparency mask that the format requires.
 */
function dib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);              // header size
  header.writeInt32LE(size, 4);             // width
  header.writeInt32LE(size * 2, 8);         // height: colour + mask
  header.writeUInt16LE(1, 12);              // planes
  header.writeUInt16LE(32, 14);             // bits per pixel
  header.writeUInt32LE(0, 16);              // no compression
  header.writeUInt32LE(size * size * 4, 20); // colour data size

  const colour = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = (size - 1 - y) * size * 4;      // bottom-up
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      colour[d] = rgba[s + 2];       // B
      colour[d + 1] = rgba[s + 1];   // G
      colour[d + 2] = rgba[s];       // R
      colour[d + 3] = rgba[s + 3];   // A
    }
  }

  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = (size - 1 - y) * maskStride;
    for (let x = 0; x < size; x++) {
      // A pixel that is fully transparent is marked opaque to the mask.
      if (rgba[srcRow + x * 4 + 3] === 0) {
        mask[dstRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return Buffer.concat([header, colour, mask]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* --------------------------------------------------------------------- ico */

/** Packs PNG images into an ICO container. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);          // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;      // width, 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;                            // palette
    e[3] = 0;
    e.writeUInt16LE(1, 4);               // colour planes
    e.writeUInt16LE(32, 6);              // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/* -------------------------------------------------------------------- main */

// 256 px may be PNG; every smaller size has to be a bitmap for the shell APIs.
const images = SIZES.map((size) => {
  const rgba = render(size);
  return { size, data: size >= 256 ? png(size, rgba) : dib(size, rgba) };
});
const icon = ico(images);

fs.writeFileSync(path.join(OUT_DIR, 'favicon.ico'), icon);
fs.writeFileSync(path.join(OUT_DIR, 'brand.svg'), svg(16));
console.log(`favicon.ico  ${icon.length} bytes, sizes ${SIZES.join('/')}`);
console.log(`brand.svg    ${svg(16).length} bytes`);
