#!/usr/bin/env node
/**
 * WhiteSoft — local whiteboard application server.
 *
 * Zero runtime dependencies, and deliberately dumb: it hosts ./public and
 * answers a health check.  Every file operation — opening a `.note`, writing it
 * back, compaction, PDF import — happens in the browser against the user's own
 * files (File System Access where available, a download otherwise), so the
 * server never sees a whiteboard and needs no directory of its own.
 *
 * Usage:  node server.mjs [--port 8787] [--host 127.0.0.1]
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
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
const PUBLIC_DIR = path.join(__dirname, 'public');

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
 * Server
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    // The desktop launcher polls this to know when the UI is reachable.
    if (url.pathname === '/api/health') {
      return sendJson(res, { ok: true, version: 1, pid: process.pid });
    }
    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, { error: '这个服务只托管界面：文件都在你自己的机器上由浏览器读写。' }, 404);
    }
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, { error: String(err.message || err) }, err.status || 500);
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
  console.log(`界面目录:   ${PUBLIC_DIR}`);
  console.log('文件读写由浏览器直接完成，服务端不保存任何白板。');
});

process.on('SIGINT', () => { console.log('\nshutting down'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled rejection]', err));
