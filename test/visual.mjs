/**
 * Visual verification: renders a specific whiteboard page in the app, and also
 * dumps the matching PDF page with pdftoppm so the two can be compared.
 *
 * The board is a real file now: the sample is served read-only over HTTP by a
 * fixture server and handed to the page as a `File` (see test/lib/local.mjs).
 * The embedded PDF is taken from the archive the page opened — there is no
 * server-side document endpoint any more.
 *
 * Usage: node test/visual.mjs [--url http://127.0.0.1:8787/] [--note <path>]
 *                             [--index 167] [--zoom 1.4] [--pdf 12] [--chrome <path>]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, openFixture } from './lib/local.mjs';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');
const INDEX = Number(arg('index', 167));
const ZOOM = Number(arg('zoom', 0));
const PAGE_NO = Number(arg('pdf', 0));
const CHROME = arg('chrome', path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));

/** `--note` is a path on disk; a bare file name is looked up in the usual spots. */
function resolveNote(given = 'Al-jabr-1.note') {
  const name = path.basename(given);
  const candidates = [
    path.resolve(given),
    path.join(__dirname, name),
    path.join(__dirname, '.tmp-boards', name),
    path.join(process.cwd(), name),
    path.join('/home/cutx64/Workspace/Maths', name),
  ];
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* keep looking */ } }
  console.error(`找不到样例白板：${given}\n请用 --note <path/to/board.note> 指定一个 .note 文件。`);
  process.exit(1);
}
const NOTE = resolveNote(arg('note', 'Al-jabr-1.note'));

const profileDir = path.join(__dirname, '.chrome-profile-visual');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: profileDir,
  protocolTimeout: 600000,
  env: {
    ...process.env, HOME: chromeHome,
    XDG_CONFIG_HOME: path.join(chromeHome, '.config'), XDG_CACHE_HOME: path.join(chromeHome, '.cache'),
  },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-crashpad'],
  defaultViewport: { width: 1500, height: 1000 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('[E]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[c]', m.text().slice(0, 200)); });

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 1200));
const fixtures = await startFixtureServer(path.dirname(NOTE));
console.log(`→ opening ${NOTE} (served read-only)`);
await openFixture(page, fixtures.url(path.basename(NOTE)), { writable: false });
await page.waitForFunction(() => window.app.editor.doc.pages.length > 1, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 1500));

const info = await page.evaluate((i) => {
  const ed = window.app.editor;
  ed.gotoPage(i);
  return { pages: ed.doc.pages.length, pdfPage: ed.doc.pages[i].pdfPages?.[0]?.pageNumber, elements: ed.doc.pages[i].elements.length };
}, INDEX);
console.log('page info:', JSON.stringify(info));

// wait for the PDF bitmap of that page to be ready
await page.waitForFunction(() => {
  const ed = window.app.editor;
  return ed._pdfPages && ed._pdfPages.length && ed._pdfPages.every((p) => p.bitmap);
}, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 800));

if (ZOOM > 0) {
  await page.evaluate((z) => {
    const ed = window.app.editor;
    const c = ed.screenToWorld(ed.view.w / 2, ed.view.h / 2);
    ed.zoomAt(z, ed.view.w / 2, ed.view.h / 2);
    void c;
  }, ZOOM);
  await new Promise((r) => setTimeout(r, 2500));
}

const name = `visual-${path.basename(NOTE, '.note')}-p${INDEX + 1}`;
await page.screenshot({ path: path.join(SHOTS, name + '.png') });
console.log('→', path.join(SHOTS, name + '.png'));

/* reference render of the same PDF page with poppler */
const pdfPath = path.join(__dirname, 'test', 'ref.pdf');
const pdfB64 = await page.evaluate(async () => {
  const doc = window.app.editor.doc;
  const fileName = doc.document?.fileName;
  if (!fileName) return null;
  let bytes = doc._pdfBytes;
  if (!bytes && doc.localArchive) {
    try { bytes = await doc.localArchive.read('Resources/Document/' + fileName); } catch { /* no backdrop */ }
  }
  if (!bytes) return null;
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
});
if (pdfB64) fs.writeFileSync(pdfPath, Buffer.from(pdfB64, 'base64'));
const pdfPage = PAGE_NO || info.pdfPage;
if (pdfPage && pdfB64) {
  const out = path.join(SHOTS, `ref-pdf-p${pdfPage}`);
  execFileSync('pdftoppm', ['-f', String(pdfPage), '-l', String(pdfPage), '-r', '110', '-png', pdfPath, out]);
  const produced = fs.readdirSync(SHOTS).find((f) => f.startsWith(`ref-pdf-p${pdfPage}`) && f.endsWith('.png'));
  console.log('→ reference', path.join(SHOTS, produced));
} else if (!pdfB64) {
  console.log('（这个白板没有内嵌 PDF，跳过参考渲染）');
}
fs.rmSync(pdfPath, { force: true });

await fixtures.close();
await browser.close();
