/**
 * Browser smoke test.
 *
 * Drives the real application in headless Chromium: loads the UI, opens a
 * .note archive, checks the renderer, exercises the tools and captures
 * screenshots into test/shots/.
 *
 * The board is a real file now: the sample is served read-only over HTTP by a
 * fixture server and handed to the page as a `File` (see test/lib/local.mjs),
 * which is the same path a dragged-in board takes.
 *
 * Usage:  node test/smoke.mjs [--url http://127.0.0.1:8787/] [--note <path>]
 *                             [--page 3] [--headed] [--chrome <path>]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, openFixture } from './lib/local.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');
const PAGE = Number(arg('page', 3));
const HEADED = argv.includes('--headed');
const CHROME = arg('chrome', path.join(__dirname, '..', '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));

/** `--note` is a path on disk; a bare file name is looked up in the usual spots. */
function resolveNote(given = 'Al-jabr-1.note') {
  const name = path.basename(given);
  const candidates = [
    path.resolve(given),
    path.join(__dirname, '..', name),
    path.join(__dirname, '..', '.tmp-boards', name),
    path.join(process.cwd(), name),
    path.join('/home/cutx64/Workspace/Maths', name),
  ];
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* keep looking */ } }
  console.error(`找不到样例白板：${given}\n请用 --note <path/to/board.note> 指定一个 .note 文件。`);
  process.exit(1);
}
const NOTE = resolveNote(arg('note', 'Al-jabr-1.note'));

const logs = [];
const errors = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profileDir = path.join(__dirname, '.chrome-profile');
  fs.rmSync(profileDir, { recursive: true, force: true });
  const chromeHome = path.join(__dirname, '.chrome-home');
  fs.mkdirSync(path.join(chromeHome, '.config'), { recursive: true });
  fs.mkdirSync(path.join(chromeHome, '.cache'), { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADED ? false : 'new',
    userDataDir: profileDir,
    protocolTimeout: 600000,
    env: {
      ...process.env,
      HOME: chromeHome,
      XDG_CONFIG_HOME: path.join(chromeHome, '.config'),
      XDG_CACHE_HOME: path.join(chromeHome, '.cache'),
    },
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-crash-reporter', '--no-crashpad', '--disable-breakpad',
      '--disable-gpu', '--hide-scrollbars', '--mute-audio',
      '--window-size=1600,1000',
    ],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  page.on('console', (m) => {
    const t = `${m.type()}: ${m.text()}`;
    logs.push(t);
    if (m.type() === 'error') errors.push(t);
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => {
    if (!r.url().includes('favicon')) errors.push('requestfailed: ' + r.url() + ' ' + r.failure()?.errorText);
  });

  console.log('→ loading', URL_BASE);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  try {
    await page.waitForSelector('#wb-canvas', { timeout: 20000 });
  } catch (err) {
    console.log('!! canvas never appeared. logs:');
    logs.slice(-40).forEach((l) => console.log('   ', l));
    console.log('   URL:', page.url());
    console.log('   ERRORS:', errors.slice(-20).join('\n     '));
    console.log('   BODY:', (await page.content()).slice(0, 400));
    throw err;
  }
  await sleep(600);
  await shot(page, '01-empty');

  const title = await page.title();
  console.log('  title:', title);

  // --- open a .note -------------------------------------------------
  console.log('→ opening', NOTE, '(served read-only)');
  const fixtures = await startFixtureServer(path.dirname(NOTE));
  const openBoard = () => openFixture(page, fixtures.url(path.basename(NOTE)), { writable: false });
  const opened = await openBoard();
  await page.waitForFunction(
    () => window.app.editor.doc.pages.length > 1,
    { timeout: 120000 },
  );
  await sleep(2500);
  console.log('  opened:', JSON.stringify(opened));

  const info = await page.evaluate(() => {
    const ed = window.app.editor;
    return {
      name: ed.doc.name,
      pages: ed.doc.pages.length,
      pdfOpen: ed.pdf.isOpen,
      pdfPages: ed.pdf.pageCount,
      pageIndex: ed.pageIndex,
      hasPdfBackdrop: !!(ed._pdfPages && ed._pdfPages.length && ed._pdfPages[0].bitmap),
      elements: ed.page.elements.length,
      zoom: ed.camera.zoom,
    };
  });
  console.log('  document:', JSON.stringify(info));
  await shot(page, '02-opened');

  // --- jump to a page with content ---------------------------------
  const target = await page.evaluate((wanted) => {
    const ed = window.app.editor;
    const idx = ed.doc.pages.findIndex((p, i) => i > 5 && p.elements.length > 4);
    const chosen = wanted > 0 ? wanted - 1 : idx;
    ed.gotoPage(chosen);
    return { chosen, elements: ed.doc.pages[chosen].elements.length };
  }, PAGE);
  console.log('  jumped to page', target.chosen + 1, 'with', target.elements, 'elements');
  await sleep(3000);
  await shot(page, `03-page-${target.chosen + 1}`);

  // --- page navigation input (bottom right) ------------------------
  const navWorks = await page.evaluate(() => {
    const input = document.querySelector('.wb-pageinput');
    if (!input) return { ok: false, reason: 'no input' };
    input.value = '7';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { ok: true, pageIndex: window.app.editor.pageIndex };
  });
  console.log('  page-nav input →', JSON.stringify(navWorks));

  // --- drawing ------------------------------------------------------
  await page.evaluate(() => { window.app.editor.gotoPage(1); });
  await sleep(1200);
  await page.evaluate(() => window.app.ui.selectTool('pen'));
  await sleep(200);
  const canvasBox = await page.$eval('#wb-canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await drawStroke(page, canvasBox, 120);
  const afterDraw = await page.evaluate(() => {
    const ed = window.app.editor;
    return { elements: ed.page.elements.length, lastType: ed.page.elements.at(-1)?.type, canUndo: ed.history.canUndo };
  });
  console.log('  after pen stroke:', JSON.stringify(afterDraw));
  await shot(page, '04-pen');

  // --- shape --------------------------------------------------------
  await page.evaluate(() => { window.app.editor.shapeKind = 200003; window.app.ui.selectTool('shape'); });
  await drag(page, canvasBox.x + 220, canvasBox.y + 200, canvasBox.x + 460, canvasBox.y + 360);
  // --- sticky -------------------------------------------------------
  await page.evaluate(() => window.app.ui.selectTool('sticky'));
  await page.mouse.click(canvasBox.x + 700, canvasBox.y + 260);
  await sleep(400);
  await page.keyboard.type('便签测试 Note');
  await page.keyboard.press('Escape');
  await sleep(300);
  // --- text ---------------------------------------------------------
  await page.evaluate(() => window.app.ui.selectTool('text'));
  await page.mouse.click(canvasBox.x + 700, canvasBox.y + 420);
  await sleep(400);
  await page.keyboard.type('文本 text テスト');
  await page.keyboard.press('Escape');
  await sleep(400);

  const afterObjects = await page.evaluate(() => {
    const ed = window.app.editor;
    const types = {};
    for (const e of ed.page.elements) types[e.type] = (types[e.type] || 0) + 1;
    return { total: ed.page.elements.length, types };
  });
  console.log('  after shapes/notes/text:', JSON.stringify(afterObjects));
  await shot(page, '05-objects');

  // --- selection ----------------------------------------------------
  await page.evaluate(() => { window.app.ui.selectTool('marquee'); window.app.editor.selectAll(); });
  await sleep(400);
  await shot(page, '06-selected');

  // --- undo ---------------------------------------------------------
  await page.evaluate(() => { for (let i = 0; i < 4; i++) window.app.undo(); });
  await sleep(400);
  const afterUndo = await page.evaluate(() => window.app.editor.page.elements.length);
  console.log('  elements after 4 undos:', afterUndo);
  await page.evaluate(() => { for (let i = 0; i < 4; i++) window.app.redo(); });
  await sleep(300);
  await shot(page, '07-redo');

  // --- zoom / fit ---------------------------------------------------
  await page.evaluate(() => window.app.editor.fitPage());
  await sleep(800);
  await shot(page, '08-fit');

  await openBoard();
  await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
  await sleep(2000);
  const zoomed = await page.evaluate(() => {
    const ed = window.app.editor;
    ed.gotoPage(167);
    ed.camera.zoom = 3;
    return true;
  });
  await sleep(4000);
  void zoomed;
  await shot(page, '09-zoom-detail');

  // --- export PNG ---------------------------------------------------
  const png = await page.evaluate(async () => {
    const c = await window.app.renderPageBitmap(window.app.editor.pageIndex, 1);
    return { w: c.width, h: c.height, data: c.toDataURL('image/png').length };
  });
  console.log('  export bitmap:', JSON.stringify(png));

  // --- report -------------------------------------------------------
  await fixtures.close();
  await browser.close();

  const report = { info, target, navWorks, afterDraw, afterObjects, afterUndo, png, errors };
  fs.writeFileSync(path.join(SHOTS, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n--- console errors ---');
  if (!errors.length) console.log('  (none)');
  else errors.slice(0, 30).forEach((e) => console.log('  ' + e));
  console.log('\nscreenshots →', SHOTS);
  if (errors.length) process.exitCode = 1;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  console.log('  shot:', name);
}

async function drawStroke(page, box, len) {
  const y = box.y + box.h * 0.55;
  await page.mouse.move(box.x + 140, y);
  await page.mouse.down();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    await page.mouse.move(box.x + 140 + t * len, y + Math.sin(t * Math.PI * 2) * 34);
    await sleep(8);
  }
  await page.mouse.up();
  await sleep(300);
}

async function drag(page, x1, y1, x2, y2) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 6 });
  await page.mouse.move(x2, y2, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
}

main().catch((e) => { console.error(e); process.exit(1); });
