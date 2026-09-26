/**
 * Shared helpers for driving WhiteSoft's file flows in tests.
 *
 * The application has no server-side file system any more: a board is whatever
 * the browser was handed — a real file the user picked (Chrome / Edge give a
 * writable handle with it), or a read-only snapshot from a drag & drop.  Tests
 * therefore need to put *real files* into the page instead of asking a server
 * to open a path, which is what this module does:
 *
 *   const fixtures = await startFixtureServer(dirWithBoards);
 *   await openFixture(page, fixtures.url('board.note'));   // opens it for real
 *   await chooseSaveTarget(page, 'saved.note');            // stubs 另存为
 *   const downloads = await watchDownloads(page);          // captures downloads
 *
 * Fixtures are served over HTTP by the test process (read-only, CORS open) and
 * written into the Origin Private File System inside the browser, so the handle
 * the app receives is a genuine `FileSystemFileHandle`: saving, autosave and
 * compaction all run their production code paths.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.note': 'application/x-note',
  '.whiteboard': 'application/x-note',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.png': 'image/png',
};

/**
 * Locate a directory holding (private) sample boards.
 *
 * `--fixtures <dir>` wins; otherwise the scratch directory next to the
 * repository and the maintainer's usual layout are tried, so the suites that
 * assert on those boards work out of the box on the machine they were written
 * on and print a readable hint anywhere else.
 *
 * @param {string} explicit value of `--fixtures` ("" when not given)
 * @param {string[]} names files that must be present
 * @returns {string|null} absolute directory, or null when nothing matches
 */
export function resolveFixtureDir(explicit, names) {
  const home = os.homedir();
  const here = path.dirname(fileURLToPath(import.meta.url));   // test/lib
  const candidates = [
    explicit,
    path.join(here, '..', '..', '.tmp-boards'),
    path.join(home, 'Workspace', 'Maths'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const abs = path.resolve(String(candidate).replace(/^~(?=$|\/)/, home));
    if (names.every((n) => fs.existsSync(path.join(abs, n)))) return abs;
  }
  return null;
}

/** Serve `dir` read-only on 127.0.0.1 with CORS, so the page can fetch files. */
export async function startFixtureServer(dir) {
  const root = path.resolve(dir);
  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const abs = path.join(root, path.normalize(rel));
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!abs.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
    let st;
    try { st = await fsp.stat(abs); } catch { res.writeHead(404).end('not found'); return; }
    if (st.isDirectory()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(abs).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    port,
    /** Absolute URL of a file inside the served directory. */
    url: (name) => `http://127.0.0.1:${port}/${String(name).split('/').map(encodeURIComponent).join('/')}`,
    dir: root,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * Open a fixture in the app exactly like the user picking it from disk.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} url      fixture URL from `startFixtureServer`
 * @param {{name?: string, writable?: boolean, remember?: boolean}} opts
 *   `writable: false` mimics a browser without the File System Access API (or
 *   a dragged-in file): the board opens read-only and Ctrl+S has to fall back
 *   to 另存为.
 */
export async function openFixture(page, url, { name = null, writable = true, remember = false } = {}) {
  return page.evaluate(async ({ url, name, writable, remember }) => {
    const app = window.app;
    const blob = await (await fetch(url)).blob();
    const fileName = name || decodeURIComponent(url.split('/').pop());
    const file = new File([blob], fileName, { type: 'application/x-note' });
    let handle = null;
    if (writable) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const dir = await navigator.storage.getDirectory();
      handle = await dir.getFileHandle(fileName, { create: true });
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
    }
    const handleId = remember ? `fix-${fileName}` : null;
    // A remembered file is only reachable again if its handle really is in the
    // store, which is what the picker flow does before opening.
    if (handleId && handle) {
      const { saveHandle } = await import('/js/filehandles.js');
      await saveHandle(handleId, handle);
    }
    app.markSaved();
    await app.openLocalFile(file, { handle, handleId });
    await new Promise((r) => setTimeout(r, 900));
    const doc = app.editor.doc;
    return {
      name: doc.name,
      pages: doc.pages.length,
      elements: doc.pages.reduce((n, p) => n + p.elements.length, 0),
      hasHandle: !!doc.fileHandle,
      writable: !!handle,
      size: doc.archiveBytes,
    };
  }, { url, name, writable, remember });
}

/** Read a file back out of the browser's own storage (what was actually written). */
export async function readOpfs(page, name) {
  return page.evaluate(async (fileName) => {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    const { ZipReader } = await import('/js/zipread.js');
    const zip = await ZipReader.open(file);
    const entries = zip.list();
    const manifest = await zip.json('manifest.json').catch(() => null);
    const page1 = await zip.json('Pages/page1.json').catch(() => null);
    return {
      size: file.size,
      entries,
      images: entries.filter((n) => n.startsWith('Resources/Images/')),
      pageCount: (manifest?.pages || []).length,
      elements: (page1?.elements || []).map((e) => e.type),
      methods: Object.fromEntries(entries.map((n) => [n, zip.entry(n).method])),
      sizes: Object.fromEntries(entries.map((n) => [n, zip.entry(n).csize])),
    };
  }, name);
}

/**
 * Stub 另存为's system dialog: the next `showSaveFilePicker()` returns a fresh
 * OPFS file with this name, which is a real writable handle.
 */
export async function chooseSaveTarget(page, fileName) {
  return page.evaluate((name) => {
    window.__savedTo = [];
    window.showSaveFilePicker = async () => {
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle(name, { create: true });
      window.__savedTo.push(name);
      return handle;
    };
    return true;
  }, fileName);
}

/** Simulate the user cancelling the系统 save dialog. */
export async function cancelSaveTarget(page) {
  return page.evaluate(() => {
    window.showSaveFilePicker = async () => {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      throw err;
    };
  });
}

/** Remove the picker entirely (Firefox / Safari): 另存为 must download a copy. */
export async function removeSaveTarget(page) {
  return page.evaluate(() => { delete window.showSaveFilePicker; });
}

/**
 * Record what `另存为` downloads when the browser cannot write files.
 * Returns a getter for the captured list.
 */
export async function watchDownloads(page) {
  await page.evaluate(() => {
    window.__downloads = [];
    const realCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.__downloads.push({ size: blob.size, type: blob.type });
      return realCreate(blob);
    };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedClick() {
      if (this.download) window.__downloads[window.__downloads.length - 1].name = this.download;
      return realClick.call(this);
    };
  });
  return () => page.evaluate(() => window.__downloads || []);
}

/** Every file the browser currently holds (debugging aid for the suites). */
export async function listOpfs(page) {
  return page.evaluate(async () => {
    const dir = await navigator.storage.getDirectory();
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      const file = await handle.getFile();
      out.push({ name, size: file.size });
    }
    return out;
  });
}

/** The board the app currently has open, plus its save bookkeeping. */
export async function docState(page) {
  return page.evaluate(() => {
    const app = window.app;
    const doc = app.editor.doc;
    return {
      name: doc.name,
      pages: doc.pages.length,
      modified: app.modified,
      hasHandle: !!doc.fileHandle,
      handleName: doc.fileHandle?.name || null,
      file: doc.localFile?.name || null,
      toast: document.querySelector('.wb-toasts')?.textContent || '',
      dialog: document.querySelector('.wb-dialog h3')?.textContent || '',
    };
  });
}
