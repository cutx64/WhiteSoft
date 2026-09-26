/**
 * Minimal streaming ZIP writer, used to save a locally opened `.note` back
 * into its own file.
 *
 * fflate can build archives, but it always recompresses what you hand it.  A
 * `.note` may hold hundreds of megabytes of images that are *already*
 * compressed, so recompressing them wastes seconds and — if the source had
 * them deflated and we store them instead — inflates the file.  This writer
 * therefore has one extra move: `addRaw` copies an entry's compressed bytes,
 * method and CRC across untouched, so saving a board in place leaves the size
 * of everything the user did not touch exactly as it was.
 *
 * Layout follows the project's server-side writer (server.mjs): UTF-8 names,
 * no data descriptors, deflate or store per entry.  Archives above 4 GB are
 * rejected rather than written with truncated fields.
 */
import { loadFflate } from './zipread.js';

const LOC_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipWriter {
  /** @param {FileSystemWritableFileStream} stream */
  constructor(stream) {
    this.stream = stream;
    this.offset = 0;
    this.central = [];
    this.pending = [];
    this.failed = null;
  }

  #write(bytes) {
    this.offset += bytes.length;
    if (this.offset > 0xffffffff) throw new Error('白板超过 4 GB，无法写回单个 .note');
    this.pending.push(this.stream.write(bytes).catch((err) => { this.failed = this.failed || err; }));
  }

  /** Add an entry from memory, compressing it when that actually helps. */
  async add(name, bytes, { compress = true } = {}) {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let method = 0;
    let payload = raw;
    if (compress && raw.length > 128) {
      const { deflateSync } = await loadFflate();
      const deflated = deflateSync(raw, { level: 6 });
      if (deflated.length < raw.length) { method = 8; payload = deflated; }
    }
    this.#emit(name, method, crc32(raw), payload, raw.length);
  }

  /** Copy an entry that this save did not change, byte for byte. */
  addRaw(name, { method, crc, usize, data }) {
    this.#emit(name, method, crc, data, usize);
  }

  #emit(name, method, crc, payload, usize) {
    const nameBuf = new TextEncoder().encode(name);
    const head = new Uint8Array(30);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, LOC_SIG, true);
    dv.setUint16(4, 20, true);        // version needed
    dv.setUint16(6, 0x0800, true);    // UTF-8 names
    dv.setUint16(8, method, true);
    dv.setUint16(10, DOS_TIME, true);
    dv.setUint16(12, DOS_DATE, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, payload.length, true);
    dv.setUint32(22, usize, true);
    dv.setUint16(26, nameBuf.length, true);
    dv.setUint16(28, 0, true);
    this.central.push({ nameBuf, method, crc, csize: payload.length, usize, offset: this.offset });
    this.#write(head);
    this.#write(nameBuf);
    this.#write(payload);
    return this;
  }

  /** Write the central directory and the end-of-central-directory record. */
  async finish() {
    const dirStart = this.offset;
    let dirSize = 0;
    for (const e of this.central) {
      const h = new Uint8Array(46);
      const dv = new DataView(h.buffer);
      dv.setUint32(0, CEN_SIG, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, e.method, true);
      dv.setUint16(12, DOS_TIME, true);
      dv.setUint16(14, DOS_DATE, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.csize, true);
      dv.setUint32(24, e.usize, true);
      dv.setUint16(28, e.nameBuf.length, true);
      dv.setUint32(42, e.offset, true);
      this.#write(h);
      this.#write(e.nameBuf);
      dirSize += h.length + e.nameBuf.length;
    }
    const eocd = new Uint8Array(22);
    const dv = new DataView(eocd.buffer);
    dv.setUint32(0, EOCD_SIG, true);
    dv.setUint16(8, this.central.length, true);
    dv.setUint16(10, this.central.length, true);
    dv.setUint32(12, dirSize, true);
    dv.setUint32(16, dirStart, true);
    this.#write(eocd);
    await Promise.all(this.pending);
    if (this.failed) throw this.failed;
    await this.stream.close();
    return this.offset;
  }

  /** Discard whatever was written so far (the original file stays intact). */
  async abort() {
    try { await this.stream.abort?.(); } catch { /* already closed */ }
  }
}
