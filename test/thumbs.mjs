/**
 * Pages-panel thumbnail regression suite.
 *
 * The previews are the one place where a page is rasterised off-screen, so they
 * break in ways nothing else notices: a shared renderer painting every preview
 * into a single canvas, a preview rasterised at the wrong scale, a preview that
 * never follows the current page, a preview that is never refreshed after an
 * edit.  This suite builds its own board (18 painted pages + one deliberately
 * blank one, each page a big coloured shape plus a label in a distinct colour),
 * saves it into the browser's OPFS through a real `FileSystemFileHandle`,
 * reopens it and then checks the previews:
 *
 *   1. one preview canvas per page;
 *   2. visible previews really contain ink (and an unrendered canvas must not
 *      count as painted);
 *   3. a preview's colour is that page's own colour — not another page's, which
 *      is what the shared-renderer bug produced;
 *   4. the blank page's preview stays blank;
 *   5. previews are lazy: only what was scrolled into view is rasterised;
 *   6. clicking a preview jumps to that page and the active item follows;
 *   7. drawing refreshes the current page's preview within ~1 s (the UI
 *      debounces it) and undo refreshes it again.
 *
 * Nothing here needs a sample board; `--sample <path>` additionally opens a
 * real `.note` from disk (e.g. /home/cutx64/Workspace/Maths/Al-jabr-1.note) to
 * sanity-check that laziness also holds for a real archive.
 *
 * Usage:  node test/thumbs.mjs [--url http://127.0.0.1:8787/] [--chrome <path>]
 *                              [--sample <path/to/board.note>]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseSaveTarget, readOpfs } from './lib/local.mjs';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHROME = arg('chrome', path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');
const SAMPLE = arg('sample', '');

const profileDir = path.join(__dirname, '.chrome-profile-thumbs');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const errors = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

/* ------------------------------------------------------------------ *
 * The board the suite builds for itself
 * ------------------------------------------------------------------ */
const PAGE_COUNT = 22;            // pages of the generated board
const BLANK = 17;                 // …one of them is deliberately empty
const BOARD_NAME = 'thumbs-suite.note';

/** hsl → '#AARRGGBB', the colour format the element model stores. */
function hslToArgb(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255);
  };
  const hex = (v) => v.toString(16).padStart(2, '0').toUpperCase();
  return `#FF${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}
// Evenly spaced hues plus alternating lightness: 16px of hue at this
// saturation already moves every channel, so no two pages can be confused.
const FILLS = Array.from({ length: PAGE_COUNT }, (_, i) => hslToArgb((i * 360) / PAGE_COUNT, 0.8, i % 2 ? 0.38 : 0.52));
const TEXTS = Array.from({ length: PAGE_COUNT }, (_, i) => hslToArgb((i * 360) / PAGE_COUNT + 180, 0.9, 0.14));
const FILLS_RGB = FILLS.map((c) => [3, 5, 7].map((k) => parseInt(c.slice(k, k + 2), 16)));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: profileDir,
  protocolTimeout: 600000,
  env: {
    ...process.env, HOME: chromeHome,
    XDG_CONFIG_HOME: path.join(chromeHome, '.config'), XDG_CACHE_HOME: path.join(chromeHome, '.cache'),
  },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-crashpad', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await sleep(1200);
check('应用启动', await page.$('#wb-canvas') !== null);

/* ---------------------------------------------------------------- *
 * 1. Build a board and save it through a real handle
 * ---------------------------------------------------------------- */
console.log('\n[1] 造板 → 存到 OPFS → 重新打开');
const built = await page.evaluate(async ({ count, blank, fills, texts }) => {
  const app = window.app;
  const ed = app.editor;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  ed.background.style = 'none';
  while (ed.doc.pages.length < count) ed.addPage(ed.doc.pages.length - 1);
  const W = 640, H = 440;                       // the world rect every page draws into
  for (let i = 0; i < count; i++) {
    ed.gotoPage(i);
    ed.page.elements = [];
    if (i === blank) continue;                  // deliberately empty page
    const shape = els.makePointsElement(els.T.RECT, {
      stroke: fills[i], width: 6, closed: true,
      points: [{ x: 24, y: 24 }, { x: W - 24, y: 24 }, { x: W - 24, y: H - 24 }, { x: 24, y: H - 24 }],
    });
    shape.filled = true;
    shape.fill = fills[i];
    ed.addElement(shape, { select: false });
    ed.addElement(els.makeText({
      bounds: new Rect(70, 180, W - 140, 90).toString(),
      text: `P${i + 1}`, fontSize: 56, textColor: texts[i],
    }), { select: false });
  }
  ed.gotoPage(0);
  ed.fitPage();
  ed.invalidate();
  return {
    pages: ed.doc.pages.length,
    blankElements: ed.doc.pages[blank].elements.length,
    painted: ed.doc.pages.filter((p) => p.elements.length).length,
  };
}, { count: PAGE_COUNT, blank: BLANK, fills: FILLS, texts: TEXTS });
check('自建白板：每页都有内容，留一页空白',
  built.pages === PAGE_COUNT && built.painted === PAGE_COUNT - 1 && built.blankElements === 0,
  JSON.stringify(built));

await chooseSaveTarget(page, BOARD_NAME);
const saved = await page.evaluate(async () => {
  window.app.editor.doc.name = 'thumbs-suite';
  const ok = await window.app.saveAs();
  await new Promise((r) => setTimeout(r, 400));
  return { ok, savedTo: window.__savedTo || [], modified: window.app.modified };
});
check('另存为写进 OPFS 句柄', saved.ok === true && saved.savedTo.includes(BOARD_NAME), JSON.stringify(saved));

const stored = await readOpfs(page, BOARD_NAME);
check('存下来的 .note 里就是这些页', stored.pageCount === PAGE_COUNT && stored.size > 0,
  `pages=${stored.pageCount} size=${stored.size}`);

const reopened = await page.evaluate(async (name) => {
  const app = window.app;
  const dir = await navigator.storage.getDirectory();
  const handle = await dir.getFileHandle(name);
  app.markSaved();
  await app.openLocalFile(await handle.getFile(), { handle });
  await new Promise((r) => setTimeout(r, 900));
  return { name: app.editor.doc.name, pages: app.editor.doc.pages.length, hasHandle: !!app.editor.doc.fileHandle };
}, BOARD_NAME);
check('重新打开：页数与句柄都在',
  reopened.pages === PAGE_COUNT && reopened.hasHandle === true, JSON.stringify(reopened));

/* ---------------------------------------------------------------- *
 * 2. The panel: one canvas per page, visible ones really painted
 * ---------------------------------------------------------------- */
console.log('\n[2] 面板预览');
await page.evaluate(() => window.app.ui.togglePages(true));

/** Poll until at least `min` previews have been rasterised (lazy + async). */
async function waitForThumbs(min, timeout = 12000) {
  const started = Date.now();
  let n = 0;
  while (Date.now() - started < timeout) {
    n = await page.evaluate(() => window.app.ui.thumbCache?.size || 0);
    if (n >= min) break;
    await sleep(150);
  }
  await sleep(300);                              // let the last paint land
  return n;
}

/** Per-preview pixel census: ink, near-black pen ink, per-colour matches. */
const previewStats = () => page.evaluate((expected) => {
  const cache = window.app.ui.thumbCache || new Map();
  const canvases = [...document.querySelectorAll('.wb-thumbcanvas')];
  const out = canvases.map((c) => {
    const idx = Number(c.dataset.index);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0, black = 0;
    const counts = new Array(expected.length).fill(0);
    for (let p = 0; p < d.length; p += 4) {
      if (d[p + 3] === 0) continue;
      const r = d[p], g = d[p + 1], b = d[p + 2];
      if (r >= 246 && g >= 246 && b >= 246) continue;   // paper
      ink++;
      if (r < 90 && g < 90 && b < 90 && Math.max(r, g, b) - Math.min(r, g, b) < 20) black++;
      for (let k = 0; k < expected.length; k++) {
        const e = expected[k];
        if (Math.abs(r - e[0]) <= 30 && Math.abs(g - e[1]) <= 30 && Math.abs(b - e[2]) <= 30) { counts[k]++; break; }
      }
    }
    // previews are cached per *page*, so ask the UI for this row's key
    return { index: idx, w: c.width, h: c.height, ink, black, counts, cached: cache.has(window.app.ui.thumbKey(idx)) };
  });
  return { canvases: out, items: document.querySelectorAll('.wb-pageitem').length, cache: cache.size, pageIndex: window.app.editor.pageIndex };
}, FILLS_RGB);

await waitForThumbs(4);
let stats = await previewStats();
const canvasCount = stats.canvases.length;
check('页面面板每页一个预览画布', canvasCount === PAGE_COUNT && stats.items === PAGE_COUNT,
  `canvas=${canvasCount} item=${stats.items} pages=${PAGE_COUNT}`);

const drawn = stats.canvases.filter((c) => c.cached);
check('可见页的预览真的画上了墨（不是空白画布）',
  drawn.length >= 4 && drawn.every((c) => c.ink > 300),
  drawn.map((c) => `${c.index}:${c.ink}`).join(' '));

/** Is `i`'s preview painted with its own colour, and not another page's? */
function colourVerdict(c) {
  const own = c.counts[c.index];
  const others = c.counts.filter((_, k) => k !== c.index);
  const best = Math.max(...others);
  return { own, best, share: c.ink ? own / c.ink : 0, ok: own > 300 && own >= best * 4 && own >= c.ink * 0.4 };
}
const verdicts = drawn.map((c) => ({ c, v: colourVerdict(c) }));
const badColour = verdicts.filter(({ v }) => !v.ok);
check('每页预览的颜色就是这一页自己的颜色（不是别页的）',
  badColour.length === 0,
  badColour.length
    ? badColour.map(({ c, v }) => `p${c.index + 1} own=${v.own} other=${v.best} ink=${c.ink}`).join('; ')
    : verdicts.map(({ c, v }) => `p${c.index + 1} ${Math.round(v.share * 100)}%`).join(' '));

/* ---------------------------------------------------------------- *
 * 3. Laziness: only what was scrolled into view is rasterised
 * ---------------------------------------------------------------- */
console.log('\n[3] 懒渲染');
const last = stats.canvases[PAGE_COUNT - 1];
check('未滚到的页面还没栅格化（缓存远小于页数）',
  stats.cache < PAGE_COUNT && stats.cache <= Math.ceil(PAGE_COUNT * 0.75) && last.cached === false,
  `cache=${stats.cache}/${PAGE_COUNT} last=${last.cached ? 'cached' : 'not cached'}`);
check('没栅格化的画布不算“已绘制”',
  stats.canvases.filter((c) => !c.cached).every((c) => c.ink === 0),
  stats.canvases.filter((c) => !c.cached).map((c) => c.ink).join(','));

/* ---------------------------------------------------------------- *
 * 4. The deliberately blank page stays blank
 * ---------------------------------------------------------------- */
console.log('\n[4] 空白页');
await page.evaluate((i) => {
  const list = document.querySelector('.wb-pageslist');
  const item = document.querySelectorAll('.wb-pageitem')[i];
  item.scrollIntoView({ block: 'center' });
  void list;
}, BLANK);
await waitForThumbs(stats.cache + 1, 8000);
stats = await previewStats();
const blank = stats.canvases[BLANK];
check('空白页的预览保持空白（而且确实栅格化过）',
  blank.cached === true && blank.ink === 0, `cached=${blank.cached} ink=${blank.ink}`);

/* ---------------------------------------------------------------- *
 * 5. Clicking a preview jumps to that page
 * ---------------------------------------------------------------- */
console.log('\n[5] 点击跳页');
const TARGET = 4;
await page.evaluate((i) => document.querySelectorAll('.wb-pageitem')[i].click(), TARGET);
await sleep(500);
const afterClick = await page.evaluate(() => ({
  pageIndex: window.app.editor.pageIndex,
  active: [...document.querySelectorAll('.wb-pageitem')].findIndex((n) => n.classList.contains('active')),
  activeThumb: Number(document.querySelector('.wb-pageitem.active .wb-thumbcanvas')?.dataset.index),
}));
check('点击预览跳到该页，活动项跟随',
  afterClick.pageIndex === TARGET && afterClick.active === TARGET && afterClick.activeThumb === TARGET,
  JSON.stringify(afterClick));

/* ---------------------------------------------------------------- *
 * 6. An edit refreshes that page's preview (debounced), undo again
 * ---------------------------------------------------------------- */
console.log('\n[6] 编辑后刷新预览');
const before = (await previewStats()).canvases[TARGET];
const elementsBefore = await page.evaluate(() => window.app.editor.page.elements.length);
const box = await page.$eval('#wb-canvas', (c) => { const r = c.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; });
await page.evaluate(() => {
  const ed = window.app.editor;
  ed.pen = ed.pens[0];
  // A thick line on purpose: a hairline is only a fraction of a preview pixel
  // once the page is scaled down, so it would barely register.
  ed.pen.width = 30;
  window.app.ui.selectTool('pen');
  window.app.ui.closeFlyout();       // the pen options flyout covers the canvas
});
await page.mouse.move(box.cx - 120, box.cy);
await page.mouse.down();
for (let i = 0; i <= 24; i++) { await page.mouse.move(box.cx - 120 + i * 10, box.cy + Math.sin(i / 3) * 26); await sleep(8); }
await page.mouse.up();
const drawnElements = await page.evaluate(() => window.app.editor.page.elements.length);

/** Poll the preview until `fn` accepts its census (the repaint is debounced). */
async function waitPreview(index, fn, timeout = 2000) {
  const started = Date.now();
  let c = null;
  while (Date.now() - started < timeout) {
    c = (await previewStats()).canvases[index];
    if (fn(c)) return { ok: true, c, ms: Date.now() - started };
    await sleep(120);
  }
  return { ok: false, c, ms: Date.now() - started };
}

const afterDraw = await waitPreview(TARGET, (c) => c.black > before.black + 150, 2000);
check('画笔落下后 ~1 秒内该页预览刷新（出现黑色笔迹）',
  afterDraw.ok && drawnElements === elementsBefore + 1,
  `black ${before.black} → ${afterDraw.c.black}（${afterDraw.ms}ms, 元素 ${elementsBefore} → ${drawnElements}）`);

await page.evaluate(() => window.app.undo());
await sleep(150);
const afterUndo = await waitPreview(TARGET, (c) => c.black <= before.black + 30, 2000);
check('撤销后预览再次刷新（笔迹消失）',
  afterUndo.ok, `black ${afterDraw.c.black} → ${afterUndo.c.black}（${afterUndo.ms}ms）`);

const undoState = await page.evaluate(() => ({
  elements: window.app.editor.page.elements.length,
  cached: window.app.ui.thumbCache?.has(window.app.ui.thumbKey(window.app.editor.pageIndex)),
}));
check('撤销回到画之前的元素数，预览仍在缓存里', undoState.elements === drawnElements - 1 && undoState.cached === true,
  JSON.stringify(undoState));

await page.screenshot({ path: path.join(SHOTS, 'thumbs.png') });

/* ---------------------------------------------------------------- *
 * 7. Optional: a real .note from disk
 * ---------------------------------------------------------------- */
if (SAMPLE) {
  console.log('\n[7] 真实白板（可选）');
  const samplePath = path.resolve(SAMPLE);
  if (!fs.existsSync(samplePath)) {
    check('真实白板存在', false, samplePath);
  } else {
    const { startFixtureServer, openFixture } = await import('./lib/local.mjs');
    const fixtures = await startFixtureServer(path.dirname(samplePath));
    const info = await openFixture(page, fixtures.url(path.basename(samplePath)), { writable: false });
    await page.evaluate(() => window.app.ui.togglePages(true));
    await waitForThumbs(4);
    const real = await previewStats();
    const paintedReal = real.canvases.filter((c) => c.cached);
    check('真实白板：可见预览有墨、缓存远小于页数',
      paintedReal.length >= 3 && paintedReal.filter((c) => c.ink > 100).length >= 3 && real.cache < info.pages,
      `pages=${info.pages} cache=${real.cache} painted=${paintedReal.filter((c) => c.ink > 100).length}/${paintedReal.length}`);
    await page.screenshot({ path: path.join(SHOTS, 'thumbs-sample.png') });
    await fixtures.close();
  }
}

/* ---------------------------------------------------------------- *
 * 7. Switching boards drops the previews of the board that was left behind
 * ---------------------------------------------------------------- */
console.log('\n[7] 换白板后预览不会留着上一张板的画面');
await page.evaluate(() => window.app.ui.togglePages(true));
await waitForThumbs(4);
const beforeSwitch = await previewStats();
const beforeInk = beforeSwitch.canvases.filter((c) => c.ink > 300).length;
check('换板前：可见预览画的是这张板的内容', beforeInk >= 3, `painted=${beforeInk}`);
await page.evaluate(() => {
  const app = window.app;
  app.markSaved();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', shiftKey: true, bubbles: true }));
});
await sleep(1600);                       // deliberately no further interaction
const afterSwitch = await previewStats();
const stale = afterSwitch.canvases.filter((c) => c.ink > 200);
check('Shift+N 之后面板只剩新白板的一页，而且立刻是空白预览',
  afterSwitch.items === 1 && afterSwitch.canvases.length === 1 && stale.length === 0,
  JSON.stringify({
    items: afterSwitch.items,
    canvases: afterSwitch.canvases.length,
    ink: afterSwitch.canvases.map((c) => c.ink),
    pages: await page.evaluate(() => window.app.editor.doc.pages.length),
  }));

/* ---------------------------------------------------------------- *
 * 8. Dragging a page to another position updates the list and its previews
 * ---------------------------------------------------------------- */
console.log('\n[8] 拖动排序后面板要跟着走');
const reorder = await page.evaluate(async () => {
  const app = window.app;
  const ed = app.editor;
  const els = await import('/js/elements.js');
  // three pages, each a solid colour nobody else uses
  while (ed.doc.pages.length < 3) ed.addPage(ed.doc.pages.length - 1);
  const colours = ['#FFD61E1E', '#FF1EA51E', '#FF1E5AD6'];   // red / green / blue
  for (let i = 0; i < 3; i++) {
    ed.gotoPage(i);
    ed.page.elements = [];
    const shape = els.makePointsElement(els.T.RECT, {
      stroke: colours[i], width: 6, closed: true,
      points: [{ x: 40, y: 40 }, { x: 600, y: 40 }, { x: 600, y: 420 }, { x: 40, y: 420 }],
    });
    shape.filled = true;
    shape.fill = colours[i];
    ed.addElement(shape, { select: false });
  }
  ed.gotoPage(0);
  ed.invalidate();
  ed.requestRender();
  app.markSaved();
  await new Promise((r) => setTimeout(r, 2200));
  const read = () => [...document.querySelectorAll('.wb-pageitem')].map((item) => {
    const canvas = item.querySelector('.wb-thumbcanvas');
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const hist = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
      hist.set(key, (hist.get(key) || 0) + 1);
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1])[0];
    return { num: item.querySelector('.wb-pagenum').textContent, colour: top ? top[0] : null };
  });
  const before = read();
  ed.movePage(0, 2);                       // what a drop in the panel does
  window.app.ui.syncPages();
  await new Promise((r) => setTimeout(r, 1200));
  return { before, after: read(), docOrder: ed.doc.pages.length };
});
const RED = '214,30,30', GREEN = '30,165,30', BLUE = '30,90,214';
check('拖动前：三页预览各是自己的颜色',
  reorder.before.length === 3 && reorder.before[0].colour === RED
  && reorder.before[1].colour === GREEN && reorder.before[2].colour === BLUE,
  JSON.stringify(reorder.before));
check('把第 1 页拖到最后：列表顺序与预览一起跟着走',
  reorder.after.length === 3
  && reorder.after[0].colour === GREEN && reorder.after[1].colour === BLUE && reorder.after[2].colour === RED
  && reorder.after.map((r) => r.num).join(',') === '1,2,3',
  JSON.stringify(reorder.after));

await browser.close();

/* ---------------------------------------------------------------- *
 * Summary
 * ---------------------------------------------------------------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  ✗', f.name);
}
if (errors.length) {
  console.log('控制台错误：');
  for (const e of errors.slice(0, 10)) console.log('  !', e);
}
process.exitCode = failed.length || errors.length ? 1 : 0;
