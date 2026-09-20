/**
 * Visual verification: renders a specific whiteboard page in the app, and also
 * dumps the matching PDF page with pdftoppm so the two can be compared.
 *
 * Usage: node test/visual.mjs [--note Al-jabr-1.note] [--index 167] [--zoom 1.4]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const NOTE = arg('note', 'Al-jabr-1.note');
const INDEX = Number(arg('index', 167));
const ZOOM = Number(arg('zoom', 0));
const PAGE_NO = Number(arg('pdf', 0));

const profileDir = path.join(__dirname, '.chrome-profile-visual');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');

const browser = await puppeteer.launch({
  executablePath: path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'),
  headless: 'new',
  userDataDir: profileDir,
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

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate((n) => window.app.loadNote(n, { confirm: false }), NOTE);
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
const res = await fetch(`http://127.0.0.1:8787/api/note/document?path=${encodeURIComponent(NOTE)}`);
fs.writeFileSync(pdfPath, Buffer.from(await res.arrayBuffer()));
const pdfPage = PAGE_NO || info.pdfPage;
if (pdfPage) {
  const out = path.join(SHOTS, `ref-pdf-p${pdfPage}`);
  execFileSync('pdftoppm', ['-f', String(pdfPage), '-l', String(pdfPage), '-r', '110', '-png', pdfPath, out]);
  const produced = fs.readdirSync(SHOTS).find((f) => f.startsWith(`ref-pdf-p${pdfPage}`) && f.endsWith('.png'));
  console.log('→ reference', path.join(SHOTS, produced));
}
fs.rmSync(pdfPath, { force: true });

await browser.close();
