/**
 * PNG output for pages bigger than a canvas.
 *
 * A whiteboard page can easily be 10 000 px on a side once it is exported at a
 * readable scale, and a canvas that size is either refused outright or comes
 * back blank — the browser's limit on total pixels is around 268 million, and a
 * WebView gets far less before the allocation fails.  So a large export never
 * goes through one canvas: the page is painted in tiles, the tiles are stitched
 * into rows, and the rows are deflated into a PNG as they are produced.
 *
 * The result is an ordinary PNG file, limited by memory and patience rather than
 * by canvas size, and the peak memory is one band of rows plus the compressed
 * data — not the whole image.
 */

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* CRC32, the one table-driven checksum every PNG chunk carries. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, from, to) {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

/** One PNG chunk: length, type, payload, CRC over type + payload. */
function chunk(type, data) {
  const typeBytes = encoder.encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Join the byte arrays a compression stream produced, without copying twice. */
function join(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * zlib compression of a stream of bytes, through the platform if it has one.
 *
 * `CompressionStream('deflate')` produces the zlib wrapper PNG asks for, and it
 * runs off the main thread; the vendored fflate is the fallback for a browser
 * without it, at the price of holding everything until the end.
 */
class Deflater {
  constructor() {
    this.parts = [];
    this.raw = null;
    this.writer = null;
    if (typeof CompressionStream === 'function') {
      this.stream = new CompressionStream('deflate');
      this.writer = this.stream.writable.getWriter();
      this.draining = (async () => {
        const reader = this.stream.readable.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.parts.push(value);
        }
      })();
    } else {
      this.raw = [];
    }
  }

  async write(bytes) {
    if (!this.writer) { this.raw.push(bytes.slice()); return; }
    await this.writer.write(bytes);
  }

  async finish() {
    if (!this.writer) {
      const mod = await import('./zipread.js');
      const fflate = await mod.loadFflate();
      return fflate.zlibSync(join(this.raw), { level: 6 });
    }
    await this.writer.close();
    await this.draining;
    return join(this.parts);
  }
}

/**
 * Paint a page in tiles and encode the result as a PNG.
 *
 * @param {object} opts
 * @param {number} opts.width  output width in pixels
 * @param {number} opts.height output height in pixels
 * @param {(x:number, y:number, w:number, h:number) => Promise<CanvasImageSource>} opts.paint
 *   paints the given rectangle of the output, in output pixels; the rectangle
 *   may extend past the image edges, in which case those pixels are ignored
 * @param {number} [opts.tileWidth] how wide one painted tile is, default 2048
 * @param {number} [opts.bandHeight] how many rows are assembled before they are
 *   compressed, default 512
 * @param {number} [opts.margin] extra pixels painted around a tile so that
 *   shadows and antialiasing cross the seam, default 96
 * @param {(done:number, total:number) => void} [opts.onProgress]
 * @returns {Promise<Blob>}
 */
export async function encodePng({
  width, height, paint, tileWidth = 2048, bandHeight = 512, margin = 96, onProgress = null,
}) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const cols = Math.ceil(w / tileWidth);
  const bands = Math.ceil(h / bandHeight);
  const rows = Math.min(bandHeight, h);

  const deflate = new Deflater();
  const band = new Uint8Array(w * rows * 4);
  const scanlines = new Uint8Array((w * 4 + 1) * rows);
  let prev = new Uint8Array(w * 4); // the row above the band, for the Up filter
  let done = 0;

  for (let bi = 0; bi < bands; bi++) {
    const y0 = bi * bandHeight;
    const bandRows = Math.min(bandHeight, h - y0);
    // 1. paint every tile that overlaps this band, into the band buffer
    for (let ci = 0; ci < cols; ci++) {
      const x0 = ci * tileWidth;
      const tileW = Math.min(tileWidth, w - x0);
      // Clip the margin at the image edges: nothing is painted outside them.
      const left = Math.min(margin, x0);
      const top = Math.min(margin, y0);
      const right = Math.min(margin, w - (x0 + tileW));
      const bottom = Math.min(margin, h - (y0 + bandRows));
      const cw = tileW + left + right;
      const ch = bandRows + top + bottom;
      const source = await paint(x0 - left, y0 - top, cw, ch);
      const pixels = source.getContext
        ? source.getContext('2d').getImageData(0, 0, cw, ch).data
        : source;
      for (let r = 0; r < bandRows; r++) {
        const from = ((top + r) * cw + left) * 4;
        band.set(pixels.subarray(from, from + tileW * 4), (r * w + x0) * 4);
      }
    }

    // 2. filter the band and hand it to the compressor
    let at = 0;
    for (let r = 0; r < bandRows; r++) {
      const row = band.subarray(r * w * 4, (r + 1) * w * 4);
      const above = r === 0 ? prev : band.subarray((r - 1) * w * 4, r * w * 4);
      const first = y0 + r === 0;
      // Up (2) makes the empty stretches of a whiteboard compress to nothing;
      // the first row of the image has nothing above it and stays unfiltered.
      scanlines[at++] = first ? 0 : 2;
      for (let i = 0; i < row.length; i++) {
        scanlines[at++] = first ? row[i] : (row[i] - above[i]) & 0xff;
      }
    }
    await deflate.write(scanlines.subarray(0, at));
    // The band buffer is about to be refilled, so the row the next band
    // compares against has to survive it.
    prev = band.slice((bandRows - 1) * w * 4, bandRows * w * 4);

    done = y0 + bandRows;
    if (onProgress) onProgress(done, h);
  }

  const idat = await deflate.finish();

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // IDAT chunks are capped at 8 MB so no single chunk length is unusual.
  const pieces = [SIGNATURE, chunk('IHDR', ihdr)];
  for (let at2 = 0; at2 < idat.length; at2 += 8 << 20) {
    pieces.push(chunk('IDAT', idat.subarray(at2, Math.min(at2 + (8 << 20), idat.length))));
  }
  pieces.push(chunk('IEND', new Uint8Array(0)));
  return new Blob(pieces, { type: 'image/png' });
}
