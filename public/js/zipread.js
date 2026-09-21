/**
 * Random-access ZIP reading in the browser.
 *
 * `.note` files are plain ZIP containers, and opening one that lives on the
 * user's own disk must not require uploading a copy anywhere: this module
 * parses the central directory of a `File`/`Blob` and inflates single entries
 * on demand, so a 350 MB board is never read into memory as a whole.
 *
 * The parsing mirrors the server's own reader (server.mjs), including the
 * ZIP64 fields, so the two agree on every archive.
 */

/** fflate ships as a UMD bundle (it assigns itself to `window.fflate`). */
let _fflate = null;
let _loading = null;

export function loadFflate() {
  if (_fflate) return Promise.resolve(_fflate);
  if (_loading) return _loading;
  _loading = new Promise((resolve, reject) => {
    if (window.fflate) { _fflate = window.fflate; return resolve(_fflate); }
    const s = document.createElement('script');
    s.src = 'vendor/fflate/fflate.min.js';
    s.onload = () => { _fflate = window.fflate; resolve(_fflate); };
    s.onerror = () => { _loading = null; reject(new Error('无法加载 fflate')); };
    document.head.append(s);
  });
  return _loading;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export class ZipReader {
  constructor(file, entries) {
    this.file = file;
    this.size = file.size;
    this.entries = entries; // Map<name, {name, method, csize, usize, offset}>
  }

  /** Open a `File`/`Blob` and index its central directory. */
  static async open(file) {
    const tailLen = Math.min(file.size, 66_000);
    const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (readU32(tail, i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 .note（找不到 ZIP 目录）');

    let entryCount = readU16(tail, eocd + 10);
    let cenSize = readU32(tail, eocd + 12);
    let cenOffset = readU32(tail, eocd + 16);

    if (cenOffset === 0xffffffff || cenSize === 0xffffffff || entryCount === 0xffff) {
      const locPos = file.size - tailLen + eocd - 20;
      if (locPos >= 0) {
        const loc = new Uint8Array(await file.slice(locPos, locPos + 20).arrayBuffer());
        if (loc.length === 20 && readU32(loc, 0) === EOCD64_LOC_SIG) {
          const z64Pos = Number(readU64(loc, 8));
          const z64 = new Uint8Array(await file.slice(z64Pos, z64Pos + 56).arrayBuffer());
          if (readU32(z64, 0) === EOCD64_SIG) {
            entryCount = Number(readU64(z64, 32));
            cenSize = Number(readU64(z64, 40));
            cenOffset = Number(readU64(z64, 48));
          }
        }
      }
    }

    const cen = new Uint8Array(await file.slice(cenOffset, cenOffset + cenSize).arrayBuffer());
    const entries = new Map();
    let off = 0;
    for (let i = 0; i < entryCount && off + 46 <= cen.length; i++) {
      if (readU32(cen, off) !== CEN_SIG) break;
      const method = readU16(cen, off + 10);
      let csize = readU32(cen, off + 20);
      let usize = readU32(cen, off + 24);
      const nameLen = readU16(cen, off + 28);
      const extraLen = readU16(cen, off + 30);
      const commentLen = readU16(cen, off + 32);
      let offset = readU32(cen, off + 42);
      const name = new TextDecoder().decode(cen.subarray(off + 46, off + 46 + nameLen));

      if (usize === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
        let e = off + 46 + nameLen;
        const eEnd = e + extraLen;
        while (e + 4 <= eEnd) {
          const id = readU16(cen, e);
          const sz = readU16(cen, e + 2);
          if (id === 0x0001) {
            let p = e + 4;
            if (usize === 0xffffffff) { usize = Number(readU64(cen, p)); p += 8; }
            if (csize === 0xffffffff) { csize = Number(readU64(cen, p)); p += 8; }
            if (offset === 0xffffffff) { offset = Number(readU64(cen, p)); p += 8; }
            break;
          }
          e += 4 + sz;
        }
      }
      entries.set(name, { name, method, csize, usize, offset });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return new ZipReader(file, entries);
  }

  list() { return [...this.entries.keys()]; }

  has(name) { return this.entries.has(name); }

  entry(name) { return this.entries.get(name) || null; }

  /** Inflate one entry; returns `null` when the archive has no such name. */
  async read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const head = new Uint8Array(await this.file.slice(e.offset, e.offset + 30).arrayBuffer());
    if (head.length < 30 || readU32(head, 0) !== LOC_SIG) throw new Error('损坏的 ZIP 条目：' + name);
    const start = e.offset + 30 + readU16(head, 26) + readU16(head, 28);
    const raw = new Uint8Array(await this.file.slice(start, start + e.csize).arrayBuffer());
    if (e.method === 0) return raw;
    if (e.method === 8) {
      const fflate = await loadFflate();
      return fflate.inflateSync(raw);
    }
    throw new Error(`不支持的压缩方式 ${e.method}（${name}）`);
  }

  /** Inflate one entry as UTF-8 text. */
  async text(name) {
    const bytes = await this.read(name);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  /** Inflate one entry as parsed JSON. */
  async json(name) {
    const txt = await this.text(name);
    return txt ? JSON.parse(txt) : null;
  }
}

function readU16(b, i) { return b[i] | (b[i + 1] << 8); }
function readU32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }
function readU64(b, i) {
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[i + k]);
  return v;
}
