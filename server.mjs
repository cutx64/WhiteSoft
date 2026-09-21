#!/usr/bin/env node
/**
 * WhiteSoft — local whiteboard application server.
 *
 * Zero runtime dependencies.  Provides:
 *   - static hosting of ./public
 *   - random-access reading of `.note` archives (Microsoft Whiteboard local format),
 *     which are plain ZIP containers with manifest.json / Pages/*.json / Resources/*
 *   - writing `.note` archives back to disk, copying already-compressed resources
 *     verbatim so that round-tripping a 350 MB whiteboard stays fast
 *   - PDF upload / import helpers
 *
 * Usage:  node server.mjs [--port 8787] [--root <workspace dir>]
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(name.length + 3);
  return dflt;
}
const PORT = Number(arg('port', process.env.PORT || 8787));
const HOST = arg('host', '127.0.0.1');
const WORKSPACE = path.resolve(arg('root', path.resolve(__dirname, '..')));
const PUBLIC_DIR = path.join(__dirname, 'public');
// Uploads (a .note picked from disk, a PDF, an extracted resource) belong to
// the workspace the user is working in — and must stay inside it, because
// every later request goes through resolveInsideWorkspace().
const CACHE_DIR = path.join(WORKSPACE, '.cache');

/* ------------------------------------------------------------------ *
 * Minimal random-access ZIP reader
 * ------------------------------------------------------------------ */
const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

class ZipArchive {
  constructor(fh, size, filePath) {
    this.handle = fh;
    this.fd = fh.fd; // numeric descriptor, required by fs.readSync
    this.size = size;
    this.path = filePath;
    /** @type {Map<string, {name:string,method:number,csize:number,usize:number,offset:number,crc:number}>} */
    this.entries = new Map();
    this.#readCentralDirectory();
  }

  static async open(filePath) {
    const st = await fsp.stat(filePath);
    const fd = await fsp.open(filePath, 'r');
    return new ZipArchive(fd, st.size, filePath);
  }

  #readSync(fd, len, pos) {
    const buf = Buffer.allocUnsafe(len);
    let done = 0;
    while (done < len) {
      const n = fs.readSync(fd, buf, done, len - done, pos + done);
      if (n <= 0) break;
      done += n;
    }
    return done === len ? buf : buf.subarray(0, done);
  }

  #readCentralDirectory() {
    const tailLen = Math.min(this.size, 66_000);
    const tail = this.#readSync(this.fd, tailLen, this.size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)');

    let entryCount = tail.readUInt16LE(eocd + 10);
    let cenSize = tail.readUInt32LE(eocd + 12);
    let cenOffset = tail.readUInt32LE(eocd + 16);

    // ZIP64 upgrade when any field is saturated.
    const needZip64 = cenOffset === 0xffffffff || cenSize === 0xffffffff || entryCount === 0xffff;
    if (needZip64) {
      const locPos = this.size - tailLen + eocd - 20;
      if (locPos >= 0) {
        const loc = this.#readSync(this.fd, 20, locPos);
        if (loc.length === 20 && loc.readUInt32LE(0) === EOCD64_LOC_SIG) {
          const z64Pos = Number(loc.readBigUInt64LE(8));
          const z64 = this.#readSync(this.fd, 56, z64Pos);
          if (z64.readUInt32LE(0) === EOCD64_SIG) {
            entryCount = Number(z64.readBigUInt64LE(32));
            cenSize = Number(z64.readBigUInt64LE(40));
            cenOffset = Number(z64.readBigUInt64LE(48));
          }
        }
      }
    }

    // The central directory may itself be large; read it in chunks.
    const CHUNK = 8 * 1024 * 1024;
    let pos = cenOffset;
    const cenEnd = cenOffset + cenSize;
    let rest = Buffer.alloc(0);
    let parsed = 0;
    while (pos < cenEnd && parsed < entryCount) {
      const want = Math.min(CHUNK, cenEnd - pos + 4096);
      const chunk = this.#readSync(this.fd, want, pos);
      if (chunk.length === 0) break;
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let off = 0;
      while (off + 46 <= buf.length && parsed < entryCount) {
        if (buf.readUInt32LE(off) !== CEN_SIG) { off = buf.length; break; }
        const method = buf.readUInt16LE(off + 10);
        const crc = buf.readUInt32LE(off + 16);
        let csize = buf.readUInt32LE(off + 20);
        let usize = buf.readUInt32LE(off + 24);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        let offset = buf.readUInt32LE(off + 42);
        const total = 46 + nameLen + extraLen + commentLen;
        if (off + total > buf.length) break; // need more data
        const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

        if (usize === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
          // Walk the extra field looking for the ZIP64 record (0x0001).
          let e = off + 46 + nameLen;
          const eEnd = e + extraLen;
          while (e + 4 <= eEnd) {
            const id = buf.readUInt16LE(e);
            const sz = buf.readUInt16LE(e + 2);
            if (id === 0x0001) {
              let p = e + 4;
              if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(p)); p += 8; }
              if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(p)); p += 8; }
              if (offset === 0xffffffff) { offset = Number(buf.readBigUInt64LE(p)); p += 8; }
              break;
            }
            e += 4 + sz;
          }
        }
        this.entries.set(name, { name, method, csize, usize, offset, crc });
        parsed++;
        off += total;
      }
      rest = off < buf.length ? buf.subarray(off) : Buffer.alloc(0);
      pos += chunk.length;
    }
  }

  has(name) { return this.entries.has(name); }

  /** Raw (still compressed) payload of an entry, for verbatim copying. */
  rawDataSync(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error('No such entry: ' + name);
    const head = this.#readSync(this.fd, 30, e.offset);
    if (head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) throw new Error('Bad local header for ' + name);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    return { entry: e, data: this.#readSync(this.fd, e.csize, e.offset + 30 + nameLen + extraLen) };
  }

  /** Decompressed contents of an entry. */
  readSync(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error('No such entry: ' + name);
    const { data } = this.rawDataSync(name);
    if (e.method === 0) return data;
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Unsupported ZIP compression method ${e.method} for ${name}`);
  }

  list() {
    return [...this.entries.keys()];
  }

  async close() {
    try { await this.handle.close(); } catch {}
  }
}

/* Cache of open archives so repeated requests do not re-parse the directory.
 * Entries are keyed by path and validated against the file's size + mtime, so
 * saving over a file that is currently open cannot serve stale contents. */
const archiveCache = new Map(); // absPath -> { promise, size, mtimeMs }

async function openArchive(absPath) {
  const st = await fsp.stat(absPath);
  const hit = archiveCache.get(absPath);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.promise;
  if (hit) {
    hit.promise.then((z) => z.close()).catch(() => {});
    archiveCache.delete(absPath);
  }
  const promise = ZipArchive.open(absPath);
  const rec = { promise, size: st.size, mtimeMs: st.mtimeMs };
  archiveCache.set(absPath, rec);
  promise.catch(() => archiveCache.delete(absPath));
  return promise;
}

/** Drop a path from the archive cache (used after writing a new .note). */
function invalidateArchive(absPath) {
  const hit = archiveCache.get(absPath);
  if (!hit) return;
  hit.promise.then((z) => z.close()).catch(() => {});
  archiveCache.delete(absPath);
}

/* ------------------------------------------------------------------ *
 * Path safety
 * ------------------------------------------------------------------ */
function resolveInsideWorkspace(p) {
  const abs = path.resolve(WORKSPACE, p);
  const rel = path.relative(WORKSPACE, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Path outside workspace: ' + p);
    err.status = 403;
    throw err;
  }
  return abs;
}

/* ------------------------------------------------------------------ *
 * ZIP writer (used when saving .note files)
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Streaming ZIP writer.  Entries may be supplied either as raw bytes or as a
 * "copy" instruction referencing an entry in an already-open ZipArchive, which
 * lets us move hundreds of megabytes of PNG data without recompressing.
 */
class ZipWriter {
  constructor(outPath) {
    this.outPath = outPath;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    this.stream = fs.createWriteStream(outPath);
    this.offset = 0;
    this.central = [];
    this.failed = null;
    this.stream.on('error', (err) => { this.failed = err; });
    this.pending = Promise.resolve();
  }

  #write(buf) {
    this.pending = this.pending.then(
      () => new Promise((res, rej) => {
        if (this.failed) return rej(this.failed);
        this.stream.write(buf, (e) => (e ? rej(e) : res()));
      })
    );
    this.offset += buf.length;
    return this.pending;
  }

  /** Add an entry from an in-memory buffer. */
  add(name, data, { compress = true } = {}) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = crc32(raw);
    let method = 0;
    let payload = raw;
    if (compress && raw.length > 128) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) { method = 8; payload = deflated; }
    }
    return this.#emit(name, method, crc, payload, raw.length);
  }

  /** Copy an entry from a source archive without decompressing it. */
  copyFrom(zip, name) {
    const { entry, data } = zip.rawDataSync(name);
    return this.#emit(name, entry.method, entry.crc, data, entry.usize);
  }

  #emit(name, method, crc, payload, usize) {
    const nameBuf = Buffer.from(name, 'utf8');
    const offset = this.offset;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOC_SIG, 0);
    head.writeUInt16LE(20, 4);        // version needed
    head.writeUInt16LE(0x0800, 6);    // UTF-8 names
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(0, 10);        // time
    head.writeUInt16LE(0x21, 12);     // date (1980-01-01)
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(payload.length, 18);
    head.writeUInt32LE(usize, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    this.central.push({ name, nameBuf, method, crc, csize: payload.length, usize, offset });
    this.#write(head);
    this.#write(nameBuf);
    this.#write(payload);
    return this;
  }

  async finish() {
    const cenStart = this.offset;
    const parts = [];
    for (const e of this.central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(CEN_SIG, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(0, 12);
      h.writeUInt16LE(0x21, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(0, 38); // external attrs
      h.writeUInt32LE(e.offset, 42);
      parts.push(h, e.nameBuf);
    }
    const cenBuf = Buffer.concat(parts);
    await this.#write(cenBuf);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.central.length, 8);
    eocd.writeUInt16LE(this.central.length, 10);
    eocd.writeUInt32LE(cenBuf.length, 12);
    eocd.writeUInt32LE(cenStart, 16);
    eocd.writeUInt16LE(0, 20);
    await this.#write(eocd);
    await this.pending;
    await new Promise((res, rej) => this.stream.end((e) => (e ? rej(e) : res())));
  }
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}
const sendJson = (res, obj, status = 200) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

async function readBody(req, limit = 2 * 1024 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

/* ------------------------------------------------------------------ *
 * Static files
 * ------------------------------------------------------------------ */
async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  let st;
  try { st = await fsp.stat(abs); } catch { return send(res, 404, 'Not found: ' + rel); }
  if (st.isDirectory()) return send(res, 404, 'Not found');
  const ext = path.extname(abs).toLowerCase();
  const noCache = ['.html', '.js', '.mjs', '.css', '.json'].includes(ext);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': noCache ? 'no-store, must-revalidate' : 'public, max-age=3600',
    'Accept-Ranges': 'bytes',
  };
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : st.size - 1;
      if (start <= end && start < st.size) {
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': end - start + 1,
        });
        return fs.createReadStream(abs, { start, end }).pipe(res);
      }
    }
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(abs).pipe(res);
}

/* ------------------------------------------------------------------ *
 * Workspace file listing
 * ------------------------------------------------------------------ */
async function listWorkspaceFiles() {
  const out = [];
  const skip = new Set(['node_modules', '.git', '.cache']);
  async function walk(dir, depth) {
    if (depth > 3) return;
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name.startsWith('.') || skip.has(it.name)) continue;
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) await walk(abs, depth + 1);
      else {
        const ext = path.extname(it.name).toLowerCase();
        if (ext === '.note' || ext === '.pdf' || ext === '.whiteboard') {
          let size = 0;
          let mtime = 0;
          try {
            const st = await fsp.stat(abs);
            size = st.size;
            mtime = st.mtimeMs;
          } catch {}
          // `mtime` lets the client list the workspace most-recent-first.
          out.push({ path: path.relative(WORKSPACE, abs), abs, name: it.name, ext, size, mtime });
        }
      }
    }
  }
  await walk(WORKSPACE, 0);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/health') {
    return sendJson(res, { ok: true, workspace: WORKSPACE, version: 1, pid: process.pid });
  }

  if (p === '/api/files') {
    return sendJson(res, { workspace: WORKSPACE, files: await listWorkspaceFiles() });
  }

  /* ---- .note archive access ------------------------------------- */
  if (p === '/api/note/meta') {
    const abs = resolveInsideWorkspace(q.get('path'));
    const zip = await openArchive(abs);
    const names = zip.list();
    let manifest = null;
    if (zip.has('manifest.json')) {
      manifest = JSON.parse(zip.readSync('manifest.json').toString('utf8'));
    }
    const st = await fsp.stat(abs);
    return sendJson(res, {
      path: path.relative(WORKSPACE, abs),
      size: st.size,
      entryCount: names.length,
      manifest,
      hasDocument: names.some((n) => n.startsWith('Resources/Document/')),
      documentName: (manifest && manifest.document && manifest.document.fileName) || null,
    });
  }

  if (p === '/api/note/entry') {
    const abs = resolveInsideWorkspace(q.get('path'));
    const name = q.get('name');
    if (!name) return sendJson(res, { error: 'name required' }, 400);
    const zip = await openArchive(abs);
    if (!zip.has(name)) return sendJson(res, { error: 'no such entry: ' + name }, 404);
    const data = zip.readSync(name);
    const ext = path.extname(name).toLowerCase();
    return send(res, 200, data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  }

  if (p === '/api/note/pages') {
    // Bulk page fetch: returns every Pages/*.json in one response.
    const abs = resolveInsideWorkspace(q.get('path'));
    const zip = await openArchive(abs);
    const out = {};
    for (const name of zip.list()) {
      if (/^Pages\/.*\.json$/.test(name)) {
        out[name] = JSON.parse(zip.readSync(name).toString('utf8'));
      }
    }
    return sendJson(res, { pages: out });
  }

  /* ---- saving ---------------------------------------------------- */
  if (p === '/api/note/save' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const targetAbs = resolveInsideWorkspace(body.target);
    const sourceAbs = body.source ? resolveInsideWorkspace(body.source) : null;
    const sourceZip = sourceAbs ? await openArchive(sourceAbs) : null;

    await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
    const tmp = targetAbs + '.tmp-' + process.pid;
    const zw = new ZipWriter(tmp);
    try {
      // 1. manifest
      zw.add('manifest.json', JSON.stringify(body.manifest));

      // 2. pages
      for (const [name, data] of Object.entries(body.pages || {})) {
        zw.add(name, JSON.stringify(data));
      }

      // 3. resources
      const newFiles = body.newFiles || {};
      const written = new Set([...Object.keys(body.pages || {}), 'manifest.json', ...Object.keys(newFiles)]);
      if (body.keepAll && sourceZip) {
        // Non-destructive save: carry over *every* entry of the source archive
        // (including images no page currently references) so that saving never
        // silently drops anything the user's file contained.
        let copied = 0;
        for (const name of sourceZip.list()) {
          if (written.has(name)) continue;
          zw.copyFrom(sourceZip, name);
          copied++;
        }
        console.log(`[save] kept ${copied} entries from ${body.source}`);
      } else {
        for (const name of body.resources || []) {
          if (newFiles[name] != null) continue;
          if (sourceZip && sourceZip.has(name)) { zw.copyFrom(sourceZip, name); continue; }
          // Referenced resource missing from the source archive — skip it rather
          // than failing the whole save.
          console.warn('[save] missing resource, skipped:', name);
        }
      }
      for (const [name, b64] of Object.entries(newFiles)) {
        if (b64 == null) continue;
        zw.add(name, Buffer.from(String(b64), 'base64'));
      }
      await zw.finish();
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw err;
    }

    await fsp.rename(tmp, targetAbs);
    invalidateArchive(targetAbs);
    return sendJson(res, { ok: true, target: path.relative(WORKSPACE, targetAbs), bytes: (await fsp.stat(targetAbs)).size });
  }

  /* ---- PDF import ------------------------------------------------ */
  if (p === '/api/upload' && req.method === 'POST') {
    const name = (q.get('name') || 'document.pdf').replace(/[^\w.\-\u4e00-\u9fff]+/g, '_');
    const buf = await readBody(req);
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const abs = path.join(CACHE_DIR, Date.now() + '-' + name);
    await fsp.writeFile(abs, buf);
    return sendJson(res, { ok: true, path: path.relative(WORKSPACE, abs), bytes: buf.length });
  }

  if (p === '/api/raw') {
    // Serve an arbitrary workspace file (used for uploaded PDFs).
    const abs = resolveInsideWorkspace(q.get('path'));
    const st = await fsp.stat(abs);
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
    });
    return fs.createReadStream(abs).pipe(res);
  }

  /* ---- document extraction from a .note (for PDF background) ----- */
  if (p === '/api/note/document') {
    const abs = resolveInsideWorkspace(q.get('path'));
    const zip = await openArchive(abs);
    const name = q.get('name') || zip.list().find((n) => n.startsWith('Resources/Document/'));
    if (!name || !zip.has(name)) return sendJson(res, { error: 'no document in archive' }, 404);
    const data = zip.readSync(name);
    return send(res, 200, data, {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  }

  if (p === '/api/note/extract' && req.method === 'POST') {
    // Materialise a resource next to the workspace so external tools can read it.
    const body = await readJsonBody(req);
    const abs = resolveInsideWorkspace(body.path);
    const zip = await openArchive(abs);
    const name = body.name;
    if (!zip.has(name)) return sendJson(res, { error: 'no such entry' }, 404);
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const out = path.join(CACHE_DIR, path.basename(name));
    await fsp.writeFile(out, zip.readSync(name));
    return sendJson(res, { ok: true, path: path.relative(WORKSPACE, out) });
  }

  return sendJson(res, { error: 'unknown endpoint: ' + p }, 404);
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', req.method, req.url, err);
    if (!res.headersSent) sendJson(res, { error: String(err.message || err) }, status);
    else res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请换一个端口，例如：node server.mjs --port 8788`);
  } else {
    console.error('[server error]', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`WhiteSoft 已启动  →  ${url}`);
  console.log(`工作区目录: ${WORKSPACE}`);
  console.log(`界面目录:   ${PUBLIC_DIR}`);
});

process.on('SIGINT', () => { console.log('\nshutting down'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled rejection]', err));
