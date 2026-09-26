/**
 * Final sanity pass: clean load shows no dirty marker; an edit does.
 *
 * The board is a real file now: the sample is served read-only over HTTP by a
 * fixture server and handed to the page as a `File`, exactly like a drag & drop
 * (see test/lib/local.mjs).
 *
 * Usage:  node test/final.mjs [--url http://127.0.0.1:8787/] [--note <path>]
 *                             [--chrome <path>]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, openFixture } from './lib/local.mjs';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');
const CHROME = arg('chrome', path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

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

const profileDir = path.join(__dirname, '.chrome-profile-final');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: profileDir,
  protocolTimeout: 600000,
  env: { ...process.env, HOME: chromeHome, XDG_CONFIG_HOME: path.join(chromeHome, '.config'), XDG_CACHE_HOME: path.join(chromeHome, '.cache') },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-crashpad'],
  defaultViewport: { width: 1500, height: 1000 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await sleep(1500);

const dirty = () => page.$eval('.wb-savestate', (n) => n.textContent.trim());
console.log('fresh board dirty marker:', JSON.stringify(await dirty()));

const fixtures = await startFixtureServer(path.dirname(NOTE));
console.log('→ opening', NOTE, '(served read-only)');
const opened = await openFixture(page, fixtures.url(path.basename(NOTE)), { writable: false });
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await sleep(2000);
console.log('opened:', JSON.stringify(opened));
console.log('after opening a note:', JSON.stringify(await dirty()));
await page.evaluate(() => window.app.editor.nextPage());
await sleep(500);
console.log('after page navigation:', JSON.stringify(await dirty()));

// draw something
const box = await page.$eval('#wb-canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y }; });
await page.evaluate(() => window.app.ui.selectTool('pen'));
await page.mouse.move(box.x + 300, box.y + 300);
await page.mouse.down();
for (let i = 0; i < 15; i++) { await page.mouse.move(box.x + 300 + i * 8, box.y + 300 + Math.sin(i / 3) * 20); await sleep(8); }
await page.mouse.up();
await sleep(400);
console.log('after drawing:', JSON.stringify(await dirty()));
await page.evaluate(() => window.app.undo());
await sleep(300);
console.log('after undo:', JSON.stringify(await dirty()));

// pages panel + final screenshot on a rich page
await page.evaluate(() => {
  const ed = window.app.editor;
  const idx = ed.doc.pages.findIndex((p) => p.elements.length > 150);
  ed.gotoPage(idx);
  ed.fitPageWidth();
});
await sleep(4000);
await page.screenshot({ path: path.join(SHOTS, 'final-overview.png') });
console.log('screenshot → test/shots/final-overview.png');
console.log('errors:', errs.filter((e) => !e.includes('favicon')).length ? errs : '(none)');
await fixtures.close();
await browser.close();
