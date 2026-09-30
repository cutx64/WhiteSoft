/**
 * End-to-end functional test.
 *
 * Covers: .note loading (both sample archives), heavy-page rendering
 * performance, every drawing tool, ruler, selection, undo/redo, page
 * navigation, PDF import, .note save round-trip and PNG/PDF/Zip export.
 *
 * There is no server-side workspace any more: a board is a local file the user
 * picked, so the sample `.note` files are served by the test process and turned
 * into real `File`s (+ a genuine OPFS-backed `FileSystemFileHandle`) inside the
 * page — see test/lib/local.mjs.  Ctrl+S then writes through that handle, and
 * the written archive is read back with `readOpfs()` instead of an HTTP API.
 *
 * Usage: node test/e2e.mjs [--chrome <path>] [--url <base>] [--fixtures <dir>]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, openFixture, chooseSaveTarget, readOpfs, resolveFixtureDir } from './lib/local.mjs';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHROME = arg('chrome', path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');
// These suites assert on two private sample boards, which the repository does
// not ship (and whose page counts grow: they are living files); point them at
// whatever directory holds them.  Nothing here depends on a fixed page count
// or on a fixed page number.
const FIXTURE_DIR = resolveFixtureDir(arg('fixtures', ''), ['Al-jabr-1.note', 'Al-jabr-2.note']);
if (!FIXTURE_DIR) {
  console.error('找不到样例白板 Al-jabr-1.note / Al-jabr-2.note。\n'
    + '请把这两个文件放进仓库的 .tmp-boards/，或用 --fixtures <目录> 指定它们所在的目录。');
  process.exit(2);
}
const NOTE1 = path.join(FIXTURE_DIR, 'Al-jabr-1.note');
const NOTE2 = path.join(FIXTURE_DIR, 'Al-jabr-2.note');

const profileDir = path.join(__dirname, '.chrome-profile-e2e');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');

const results = [];
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** Serve the sample boards read-only over HTTP so the page can fetch them. */
const fixtures = await startFixtureServer(FIXTURE_DIR);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: profileDir,
  env: {
    ...process.env, HOME: chromeHome,
    XDG_CONFIG_HOME: path.join(chromeHome, '.config'), XDG_CACHE_HOME: path.join(chromeHome, '.cache'),
  },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-crashpad', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await sleep(1500);
check('应用启动', await page.$('#wb-canvas') !== null);

const box = await page.$eval('#wb-canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const C = (dx, dy) => [box.x + dx, box.y + dy];

/** Wait until the PDF background of the open board has been rasterised. */
const waitPdfBitmap = (timeout = 60000) => page.waitForFunction(() => {
  const ed = window.app.editor;
  return !!(ed._pdfPages && ed._pdfPages[0] && ed._pdfPages[0].bitmap);
}, { timeout });

/**
 * Open a board the browser itself wrote earlier, exactly like picking that file
 * again: the archive is read from its file handle, so what is asserted is the
 * bytes that really landed in the file.
 */
async function reopenOpfs(fileName, { wait = 1500 } = {}) {
  const state = await page.evaluate(async ({ fileName, wait }) => {
    const app = window.app;
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    app.markSaved();
    await app.openLocalFile(file, { handle });
    await new Promise((r) => setTimeout(r, wait));
    const ed = app.editor;
    return {
      name: ed.doc.name,
      pages: ed.doc.pages.length,
      pdfPages: ed.pdf.pageCount,
      hasPdf: !!ed.doc.document,
    };
  }, { fileName, wait });
  if (state.hasPdf) await waitPdfBitmap();
  const pdf = await page.evaluate(() => {
    const ed = window.app.editor;
    return {
      pdfOpen: ed.pdf.isOpen,
      bg: !!(ed._pdfPages && ed._pdfPages[0] && ed._pdfPages[0].bitmap),
    };
  });
  return { ...state, ...pdf };
}

/* ---------------------------------------------------------------- *
 * 1. Load Al-jabr-1.note
 * ---------------------------------------------------------------- */
console.log('\n[1] 打开 Al-jabr-1.note');
await page.evaluate(() => window.app.ui.closeDialog());
// opens the sample board for real: a writable, OPFS-backed file handle
await openFixture(page, fixtures.url('Al-jabr-1.note'));
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await waitPdfBitmap();
await sleep(2500);
const doc1 = await page.evaluate(async (url) => {
  const ed = window.app.editor;
  // Read the page the *file* remembers straight out of the archive, so the
  // check keeps working when the board's owner saves from another page.
  const { ZipReader } = await import('/js/zipread.js');
  const blob = await (await fetch(url)).blob();
  const zip = await ZipReader.open(new File([blob], 'manifest-probe.note'));
  const manifest = await zip.json('manifest.json').catch(() => null);
  return {
    pages: ed.doc.pages.length,
    pdfPages: ed.pdf.pageCount,
    current: ed.pageIndex,
    manifestPage: Math.max(0, (manifest?.currentPage || 1) - 1),
    elements: ed.page.elements.length,
    pdfBitmap: !!(ed._pdfPages && ed._pdfPages[0] && ed._pdfPages[0].bitmap),
  };
}, fixtures.url('Al-jabr-1.note'));
// the sample boards are living files: assert "it opened whole", not a count
check('画纸数 ≥ 446', doc1.pages >= 446, String(doc1.pages));
check('PDF 页数 ≥ 445', doc1.pdfPages >= 445, String(doc1.pdfPages));
check('manifest.currentPage 生效', doc1.current === doc1.manifestPage,
  `第 ${doc1.current + 1} 页（manifest: ${doc1.manifestPage + 1}）`);
check('PDF 背景位图已生成', doc1.pdfBitmap);
check('当前画纸元素已还原', doc1.elements > 0, doc1.elements + ' 个');

/* ---------------------------------------------------------------- *
 * 2. Heavy page render performance
 * ---------------------------------------------------------------- */
console.log('\n[2] 重页面渲染性能 (page265: 1751 个元素 / 186k 点)');
const perf = await page.evaluate(async () => {
  const ed = window.app.editor;
  ed.gotoPage(264);
  await new Promise((r) => setTimeout(r, 300));
  const t0 = performance.now();
  ed.renderer.invalidate();
  ed.draw();
  const cold = performance.now() - t0;
  const t1 = performance.now();
  ed.draw();
  const warm = performance.now() - t1;
  return { cold, warm, elements: ed.page.elements.length };
});
check('重页面可渲染', perf.elements === 1751, `${perf.elements} 个元素`);
check('冷缓存渲染 < 3000ms', perf.cold < 3000, perf.cold.toFixed(0) + 'ms');
check('热缓存渲染 < 120ms', perf.warm < 120, perf.warm.toFixed(0) + 'ms');
await page.screenshot({ path: path.join(SHOTS, 'e2e-heavy-page.png') });

/* ---------------------------------------------------------------- *
 * 3. Tools
 * ---------------------------------------------------------------- */
console.log('\n[3] 绘图工具');
await page.evaluate(() => { window.app.editor.gotoPage(400); });
await sleep(1200);
const before = await page.evaluate(() => window.app.editor.page.elements.length);

// pen
await page.evaluate(() => window.app.ui.selectTool('pen'));
await stroke(page, C(200, 300), 130, 40);
// highlighter
await page.evaluate(() => window.app.ui.selectTool('highlighter'));
await stroke(page, C(200, 420), 160, 0);
// laser (ephemeral)
await page.evaluate(() => window.app.ui.selectTool('laser'));
await stroke(page, C(200, 520), 120, 30);
await sleep(300);
const laserSaved = await page.evaluate(() => window.app.editor.page.elements.length);
// eraser: wipe the highlighter
const hlBeforeErase = await page.evaluate(() => window.app.editor.page.elements.filter((e) => e.type === 100005).length);
await page.evaluate(() => window.app.ui.selectTool('eraser'));
await page.mouse.move(...C(200, 420));
await page.mouse.down();
for (let i = 0; i < 12; i++) { await page.mouse.move(box.x + 200 + i * 14, box.y + 420); await sleep(10); }
await page.mouse.up();
await sleep(200);
const hlAfterErase = await page.evaluate(() => window.app.editor.page.elements.filter((e) => e.type === 100005).length);
// undo/redo the erase right away, while it is still the newest history entry
const eraseUndo = await page.evaluate(() => {
  const label = window.app.editor.history.undoLabel;
  window.app.undo();
  const restored = window.app.editor.page.elements.filter((e) => e.type === 100005).length;
  window.app.redo();
  const again = window.app.editor.page.elements.filter((e) => e.type === 100005).length;
  return { label, restored, again };
});
check('橡皮擦整笔删除', hlAfterErase < hlBeforeErase, `荧光笔 ${hlBeforeErase} → ${hlAfterErase}`);
check('擦除记入历史且可撤销/重做',
  eraseUndo.label === '擦除' && eraseUndo.restored === hlBeforeErase && eraseUndo.again === hlAfterErase,
  JSON.stringify(eraseUndo));

// shapes (rect, ellipse, triangle, double arrow, rounded rect)
for (const [kind, extra] of [[200003, {}], [200004, {}], [200005, {}], [200016, {}], [200003, { rounded: true }]]) {
  await page.evaluate(({ k, e }) => {
    const ed = window.app.editor;
    ed.shapeKind = k; ed.shapeForce = null;
    ed.shapeStyle.rounded = !!e.rounded; ed.shapeStyle.dash = false;
    window.app.ui.selectTool('shape');
  }, { k: kind, e: extra });
  await drag(page, C(300 + kind % 7 * 40, 600), C(420 + kind % 7 * 40, 700));
}
// ruler + straight line
await page.evaluate(() => {
  const ed = window.app.editor;
  ed.ruler.active = true;
  ed.ruler.cx = ed.camera.x + ed.view.w / ed.camera.zoom / 2;
  ed.ruler.cy = ed.camera.y + ed.view.h / ed.camera.zoom * 0.75;
  ed.ruler.angle = 0.3;
  ed.setTool('pen');
});
await stroke(page, C(400, 760), 220, 0);
const rulerLine = await page.evaluate(() => {
  const e = window.app.editor.page.elements.at(-1);
  const pts = e.inks || [];
  const dx = pts.at(-1).x - pts[0].x, dy = pts.at(-1).y - pts[0].y;
  const angle = Math.atan2(dy, dx);
  return { n: pts.length, angle, expect: window.app.editor.ruler.angle };
});
await page.evaluate(() => { window.app.editor.ruler.active = false; });

// reaction
await page.evaluate(() => { window.app.editor.reactionEmoji = '❤️'; window.app.ui.selectTool('reaction'); });
await page.mouse.click(...C(900, 300));
await sleep(300);

// sticky + text + table + image
await page.evaluate(() => window.app.ui.selectTool('sticky'));
await page.mouse.click(...C(900, 450));
await sleep(400);
await page.keyboard.type('便签 sticky ノート');
await page.keyboard.press('Escape');
await sleep(300);

await page.evaluate(() => window.app.ui.selectTool('text'));
await page.mouse.click(...C(700, 160));
await sleep(500);
await page.keyboard.type('文本 Text テスト 123');
await page.keyboard.press('Escape');
await sleep(400);

await page.evaluate(() => {
  const ed = window.app.editor;
  ed.host.querySelector('.wb-inline-editor')?.remove();
  const c = ed.screenToWorld(ed.view.w * 0.62, ed.view.h * 0.78);
  window.__tbl = { x: c.x, y: c.y };
  window.app.ui.selectTool('table');
});
await page.mouse.move(...C(1000, 700));
await page.mouse.down();
await page.mouse.move(...C(1250, 880), { steps: 8 });
await page.mouse.up();
await sleep(600);
await page.keyboard.press('Escape');
await sleep(300);

// image via evaluate (no real clipboard in headless)
await page.evaluate(async () => {
  const cv = document.createElement('canvas');
  cv.width = 200; cv.height = 120;
  const c = cv.getContext('2d');
  c.fillStyle = '#0f6cbd'; c.fillRect(0, 0, 200, 120);
  c.fillStyle = '#fff'; c.font = '20px sans-serif'; c.fillText('IMG', 60, 70);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  await window.app.insertImageBlob(blob);
});
await sleep(600);

const afterTools = await page.evaluate(() => {
  const ed = window.app.editor;
  const t = {};
  for (const e of ed.page.elements) t[e.type] = (t[e.type] || 0) + 1;
  return { total: ed.page.elements.length, types: t };
});
await page.screenshot({ path: path.join(SHOTS, 'e2e-tools.png') });
console.log('   types:', JSON.stringify(afterTools.types));
check('笔迹 (100001)', (afterTools.types[100001] || 0) >= 1);
check('荧光笔 (100005)', (afterTools.types[100005] || 0) >= 1);
check('矩形 (200003)', (afterTools.types[200003] || 0) >= 1);
check('椭圆 (200004)', (afterTools.types[200004] || 0) >= 1);
check('三角形 (200005)', (afterTools.types[200005] || 0) >= 1);
check('双箭头 (200016)', (afterTools.types[200016] || 0) >= 1);
check('文本 (300002)', (afterTools.types[300002] || 0) >= 1);
check('便签 (400001)', (afterTools.types[400001] || 0) >= 1);
check('表格 (400002)', (afterTools.types[400002] || 0) >= 1);
check('图片 (300001)', (afterTools.types[300001] || 0) >= 1);
check('反应 (400003)', (afterTools.types[400003] || 0) >= 1);
check('激光笔不落墨', laserSaved === before + 2, `元素数 ${laserSaved}`);

const angleDiff = Math.abs(rulerLine.angle - rulerLine.expect);
check('直尺约束为直线', rulerLine.n === 2 && angleDiff < 0.001, `角度差 ${angleDiff.toExponential(2)}`);

// inline text editing really stored the text
const texts = await page.evaluate(() =>
  window.app.editor.page.elements.filter((e) => e.type === 300002 || e.type === 400001).map((e) => e.text));
check('中文输入写入元素', texts.some((t) => (t || '').includes('文本')) && texts.some((t) => (t || '').includes('便签')), JSON.stringify(texts));

/* ---------------------------------------------------------------- *
 * 4. Selection / transform / undo
 * ---------------------------------------------------------------- */
console.log('\n[4] 选择、变换与撤销');
const sel = await page.evaluate(() => {
  const ed = window.app.editor;
  window.app.ui.selectTool('marquee');
  ed.selectAll();
  const n = ed.selection.size;
  const b = ed.selectionBounds();
  for (const e of ed.selection) { e.__probe = true; delete e.__probe; }
  ed.nudgeSelection(10, 10);
  const afterMove = ed.selectionBounds();
  ed.history.undo();
  const afterUndo = ed.selectionBounds();
  window.app.ui.selectTool('select');
  return { n, dx: afterMove.x - b.x, dxUndo: afterUndo.x - b.x, canRedo: ed.history.canRedo };
});
check('全选可用', sel.n > 0, sel.n + ' 个对象');
check('方向键微移生效', Math.abs(sel.dx) > 0.001, 'dx=' + sel.dx.toFixed(3));
check('撤销恢复位置', Math.abs(sel.dxUndo) < 0.001, 'dx=' + sel.dxUndo.toFixed(4));
check('可重做', sel.canRedo);

const rot = await page.evaluate(() => {
  const ed = window.app.editor;
  ed.selectAll();
  const e = [...ed.selection].find((x) => x.type === 200003);
  const before = JSON.parse(JSON.stringify(e.points));
  window.app.onKeyDownRotate = true;
  const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true });
  window.dispatchEvent(ev);
  const changed = JSON.stringify(e.points) !== JSON.stringify(before);
  ed.history.undo();
  return changed;
});
check('Alt+→ 旋转所选', rot);

/* ---------------------------------------------------------------- *
 * 5. 墨迹转形状
 * ---------------------------------------------------------------- */
console.log('\n[5] 墨迹转形状');
// draw an almost-straight stroke, then beautify it into a line
await page.evaluate(() => {
  const ed = window.app.editor;
  ed.shapeStyle.dash = false;
  window.app.ui.selectTool('pen');
});
await page.mouse.move(...C(300, 900));
await page.mouse.down();
for (let i = 0; i <= 20; i++) {
  await page.mouse.move(box.x + 300 + i * 10, box.y + 900 + Math.sin(i / 20 * Math.PI) * 3);
  await sleep(6);
}
await page.mouse.up();
await sleep(300);
const beautify = await page.evaluate(() => {
  const ed = window.app.editor;
  const ink = ed.page.elements.at(-1);
  if (!ink || ink.type !== 100001) return { skipped: true, type: ink && ink.type };
  ed.selection.clear();
  ed.selection.add(ink);
  const n = window.app.beautify();
  return { n, types: [...ed.selection].map((e) => e.type) };
});
check('墨迹转形状（直线）', beautify.n === 1 && beautify.types.includes(200002), JSON.stringify(beautify));

// a closed hand-drawn square should become a rectangle
const beautify2 = await page.evaluate(() => {
  const ed = window.app.editor;
  const pts = [];
  const x0 = 200, y0 = 200, s = 80;
  for (let i = 0; i <= 10; i++) pts.push({ x: x0 + s * i / 10, y: y0 });
  for (let i = 1; i <= 10; i++) pts.push({ x: x0 + s, y: y0 + s * i / 10 });
  for (let i = 1; i <= 10; i++) pts.push({ x: x0 + s - s * i / 10, y: y0 + s });
  for (let i = 1; i <= 10; i++) pts.push({ x: x0, y: y0 + s - s * i / 10 });
  const ink = { type: 100001, stroke: '#FF1F1F1F', width: 2, inks: pts.map((p) => ({ x: p.x + 0.4, y: p.y - 0.3, pr: 0.6 })) };
  ed.page.elements.push(ink);
  ed.selection.clear();
  ed.selection.add(ink);
  const n = window.app.beautify();
  return { n, types: [...ed.selection].map((e) => e.type) };
});
check('墨迹转形状（闭合矩形）', beautify2.n === 1 && beautify2.types.includes(200003), JSON.stringify(beautify2));

/* ---------------------------------------------------------------- *
 * 6. Page navigation
 * ---------------------------------------------------------------- */
console.log('\n[6] 页面导航');
// pick the very same board from disk again (a fresh copy, unsaved edits dropped)
await openFixture(page, fixtures.url('Al-jabr-1.note'));
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await sleep(1500);
const nav = await page.evaluate(() => {
  const input = document.querySelector('.wb-pageinput');
  input.value = '250';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return window.app.editor.pageIndex;
});
check('页码框跳转到第 250 页', nav === 249, String(nav + 1));
const nextPrev = await page.evaluate(() => {
  const ed = window.app.editor;
  ed.nextPage();
  const a = ed.pageIndex;
  ed.prevPage();
  return { a, b: ed.pageIndex };
});
check('下一页 / 上一页', nextPrev.a === 250 && nextPrev.b === 249, JSON.stringify(nextPrev));

/* ---------------------------------------------------------------- *
 * 7. Save round-trip
 * ---------------------------------------------------------------- */
console.log('\n[7] .note 保存与回读');
const preSave = await page.evaluate(() => {
  const ed = window.app.editor;
  ed.gotoPage(400);
  const marker = ed.page.elements[0];
  if (marker) marker._roundtrip = 'yes';
  return {
    elements: ed.page.elements.length,
    types: [...new Set(ed.page.elements.map((e) => e.type))],
    // what the archive the board was opened from contains, for the "nothing is
    // lost" comparison below
    sourceEntries: ed.doc.localArchive ? ed.doc.localArchive.list().length : 0,
  };
});
// Ctrl+S: the board has a handle, so it is written back into that very file
const saved = await page.evaluate(async () => {
  const ed = window.app.editor;
  const written = await window.app.save();
  await new Promise((r) => setTimeout(r, 1500));
  return { ok: written, modified: window.app.modified, target: ed.doc.fileHandle?.name || null, name: ed.doc.name };
});
check('写入 .note 成功', saved.ok === true && saved.modified === false, JSON.stringify(saved).slice(0, 120));

// a save must not drop any entry the source archive contained
const savedArchive = await readOpfs(page, 'Al-jabr-1.note');
// keepAll copies every source entry, so saving can only ever add entries
check('保存不丢条目（原样保留源归档 + 新增资源）', savedArchive.entries.length >= preSave.sourceEntries,
  `${preSave.sourceEntries} → ${savedArchive.entries.length}`);

await reopenOpfs('Al-jabr-1.note');
const reopened = await page.evaluate(() => {
  const ed = window.app.editor;
  const p = ed.doc.pages[400];
  return {
    pages: ed.doc.pages.length,
    elements: p.elements.length,
    marker: p.elements.some((e) => e._roundtrip === 'yes'),
    pdfPages: p.pdfPages?.length || 0,
    types: [...new Set(p.elements.map((e) => e.type))],
  };
});
check('回读画纸数一致', reopened.pages === doc1.pages, `${reopened.pages} vs ${doc1.pages}`);
check('回读元素数一致', reopened.elements === preSave.elements, `${reopened.elements} vs ${preSave.elements}`);
check('自定义扩展字段保真', reopened.marker);
check('pdfPages 保真', reopened.pdfPages === 1);
check('元素类型齐全', reopened.types.length >= preSave.types.length, JSON.stringify(reopened.types));
await page.screenshot({ path: path.join(SHOTS, 'e2e-roundtrip.png') });

/* ---------------------------------------------------------------- *
 * 8. PDF import
 * ---------------------------------------------------------------- */
console.log('\n[8] 导入 PDF');
// the PDF the board embeds (Resources/Document/…) — the same bytes the server
// used to hand out, now read straight out of the local archive
const pdfBytes = await page.evaluate(async () => {
  const doc = window.app.editor.doc;
  const bytes = doc._pdfBytes || (doc.document
    ? await doc.localArchive.read('Resources/Document/' + doc.document.fileName)
    : null);
  return bytes ? bytes.byteLength : 0;
});
check('可取到 PDF 字节', pdfBytes > 1000, pdfBytes + ' bytes');

const imported = await page.evaluate(async () => {
  const ed = window.app.editor;
  const doc = ed.doc;
  const bytes = doc._pdfBytes || await doc.localArchive.read('Resources/Document/' + doc.document.fileName);
  const file = new File([bytes], 'Al-jabr-1.pdf', { type: 'application/pdf' });
  await window.app.importPdfFile(file);
  await new Promise((r) => setTimeout(r, 2500));
  const p = ed.page;
  return {
    pages: ed.doc.pages.length,
    pdfPages: ed.pdf.pageCount,
    bounds: p.pdfPages?.[0]?.bounds,
    scale: p.scale,
    elements: p.elements.length,
    bitmapLoaded: !!(ed._pdfPages && ed._pdfPages[0] && ed._pdfPages[0].bitmap),
    name: ed.doc.name,
  };
});
check('PDF 导入生成 n 张画纸', imported.pages === 445, String(imported.pages));
check('每张画纸带 pdfPages 背景', !!imported.bounds, imported.bounds);
check('导入的 PDF 可渲染', imported.bitmapLoaded);
check('文档名取自 PDF', imported.name === 'Al-jabr-1', imported.name);
await sleep(1500);
await page.screenshot({ path: path.join(SHOTS, 'e2e-pdf-import.png') });

/* ---------------------------------------------------------------- *
 * 8b. Import PDF -> draw -> save as .note -> reopen
 * ---------------------------------------------------------------- */
console.log('\n[8b] 导入 PDF 后另存为 .note');
await chooseSaveTarget(page, 'imported.note');
const importSave = await page.evaluate(async () => {
  const ed = window.app.editor;
  const ok = await window.app.saveAs();
  await new Promise((r) => setTimeout(r, 1200));
  return { ok, target: ed.doc.fileHandle?.name || null, name: ed.doc.name, modified: window.app.modified };
});
check('另存为 .note 成功', importSave.ok === true && importSave.modified === false, JSON.stringify(importSave));
const reImported = await reopenOpfs('imported.note');
check('回读导入的 PDF 白板页数一致', reImported.pages === 445, String(reImported.pages));
check('回读后 PDF 背景仍可渲染', reImported.pdfOpen && reImported.bg, JSON.stringify(reImported));

/* ---------------------------------------------------------------- *
 * 9. Exports
 * ---------------------------------------------------------------- */
console.log('\n[9] 导出');
const png = await page.evaluate(async () => {
  const c = await window.app.renderPageBitmap(window.app.editor.pageIndex, 2);
  return { w: c.width, h: c.height };
});
check('PNG 导出位图', png.w > 100 && png.h > 100, `${png.w}×${png.h}`);

const zipOk = await page.evaluate(async () => {
  const f = window.fflate || (await new Promise((res) => {
    const s = document.createElement('script');
    s.src = '/vendor/fflate/fflate.min.js';
    s.onload = () => res(window.fflate);
    document.head.append(s);
  }));
  const z = f.zipSync({ 'a.txt': f.strToU8('hello') });
  return z.length;
});
check('Zip 导出可用', zipOk > 0, zipOk + ' bytes');

/* ---------------------------------------------------------------- *
 * 10. Al-jabr-2
 * ---------------------------------------------------------------- */
console.log('\n[10] 打开 Al-jabr-2.note');
await openFixture(page, fixtures.url('Al-jabr-2.note'));
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await sleep(2500);
const doc2 = await page.evaluate(() => {
  const ed = window.app.editor;
  const idx = ed.doc.pages.findIndex((p) => p.elements.length > 20);
  ed.gotoPage(idx >= 0 ? idx : 0);
  return { pages: ed.doc.pages.length, pdf: ed.pdf.pageCount, idx, elements: ed.page.elements.length };
});
// the sample board is a living file (its owner keeps drawing in it)
check('Al-jabr-2 画纸数 ≥ 655', doc2.pages >= 655, String(doc2.pages));
check('Al-jabr-2 PDF 图层已载入', doc2.pdf >= 600, String(doc2.pdf));
await waitPdfBitmap();
await sleep(1500);
await page.screenshot({ path: path.join(SHOTS, 'e2e-aljabr2.png') });

/* ---------------------------------------------------------------- *
 * 10b. What counts as a page's backdrop
 *
 * A page carrying a PDF layer must be framed by its sheet — unless that
 * sheet is *entirely white*, in which case the visible content is scans
 * pasted over an empty PDF and the page must be framed by its content
 * instead; a page with no PDF layer at all is framed by its content too.
 *
 * These suites run against a living sample board whose owner adds and
 * inserts pages, so the pages are found by their properties rather than
 * by number, and framed by the invariant "page start sits at the top-left
 * margin" instead of a frozen pixel count.
 * ---------------------------------------------------------------- */
console.log('\n[10b] 页面取景：全白 PDF 背景 / 没有 PDF 背景');
const framing = await page.evaluate(async () => {
  const ed = window.app.editor;
  const els = await import('/js/elements.js');
  const pages = ed.doc.pages;
  const framesOf = (i) => pages[i].pdfPages || [];

  const kindOf = async (i) => {
    if (!framesOf(i).length) return 'nosheet';
    for (const f of framesOf(i)) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await ed.pdf.pageIsBlank(f.pageNumber))) return 'painted';
    }
    return 'blank';
  };

  // Find the first page of each kind that has something drawn on it.  Only
  // pages with a sheet need to be rasterised, and the scan stops as soon as
  // all three kinds are known.
  let blankIdx = -1;
  let paintedIdx = -1;
  let nosheetIdx = -1;
  let classified = 0;
  for (let i = 0; i < pages.length && classified < 400; i++) {
    if (!pages[i].elements.length) continue;
    if (!framesOf(i).length) { if (nosheetIdx < 0) nosheetIdx = i; continue; }
    if (blankIdx >= 0 && paintedIdx >= 0) continue;
    classified++;
    // eslint-disable-next-line no-await-in-loop
    const kind = await kindOf(i);
    if (kind === 'blank' && blankIdx < 0) blankIdx = i;
    else if (kind === 'painted' && paintedIdx < 0) paintedIdx = i;
  }

  /** Visit a page, let its backdrop be decided, then measure the framing. */
  const measure = async (i, forceBlank = false) => {
    if (i < 0) return null;
    ed.gotoPage(i);
    if (forceBlank) {
      pages[i].blankBackdrop = true;
      pages[i]._blankProbe = framesOf(i).map((f) => f.pageNumber).join(',');
      ed.centerPage();
    }
    for (let k = 0; k < 60; k++) {
      if (!framesOf(i).length || pages[i].blankBackdrop !== undefined) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    const p = pages[i];
    const anchor = ed.anchorOfPage(i);
    const bounds = ed.boundsOfPage(i);
    const start = ed.worldToScreen(anchor.left, anchor.top);
    const paper = ed.worldToScreen(bounds.left, bounds.top);
    let content = null;
    for (const e of p.elements) {
      const b = els.elementBounds(e);
      content = content ? content.union(b) : b;
    }
    const cs = content ? ed.worldToScreen(content.left, content.top) : null;
    const out = {
      pageNo: i + 1,
      pdf: framesOf(i).length,
      blank: p.blankBackdrop,
      elements: p.elements.length,
      centred: anchor.centred,
      // the page's starting point should sit at the top-left margin (12,12)
      startOnScreen: { x: Math.round(start.x), y: Math.round(start.y) },
      contentOnScreen: cs ? { x: Math.round(cs.x), y: Math.round(cs.y) } : null,
      paperOnScreen: { x: Math.round(paper.x), y: Math.round(paper.y) },
      paperW: Math.round(bounds.w),
      zoom: ed.camera.zoom,
      viewW: ed.view.w,
    };
    if (forceBlank) { p.blankBackdrop = false; delete p._blankProbe; ed.centerPage(); }
    return out;
  };

  // A sample board that no longer has a blank-sheeted page would leave the
  // rule untested, so exercise it on a real page with the flag forced.
  const blank = await measure(blankIdx >= 0 ? blankIdx : paintedIdx, blankIdx < 0);
  return {
    blank: blank && { ...blank, forced: blankIdx < 0 },
    painted: await measure(paintedIdx),
    nosheet: await measure(nosheetIdx),
  };
});
const atTopLeft = (p) => Math.abs(p.startOnScreen.x - 12) <= 2 && Math.abs(p.startOnScreen.y - 12) <= 2;
check('PDF 背景全白（有内容）→ 按内容取景，页面左上角贴住窗口左上角',
  framing.blank && framing.blank.blank === true && framing.blank.centred === false && atTopLeft(framing.blank),
  JSON.stringify(framing.blank));
check('没有 PDF 图层（有内容）→ 按内容取景，页面左上角贴住窗口左上角',
  framing.nosheet && framing.nosheet.pdf === 0 && framing.nosheet.blank === undefined
  && framing.nosheet.centred === false && atTopLeft(framing.nosheet),
  JSON.stringify(framing.nosheet));
check('PDF 背景不是全白 → 仍然按纸面居中显示（纸面上沿贴住顶边、左右居中）',
  framing.painted && framing.painted.blank === false && framing.painted.centred === true
  && Math.abs(framing.painted.paperOnScreen.y - 12) <= 2
  && Math.abs(framing.painted.paperOnScreen.x + (framing.painted.paperW * framing.painted.zoom) / 2
    - framing.painted.viewW / 2) <= 3,
  JSON.stringify(framing.painted));
await page.screenshot({ path: path.join(SHOTS, 'e2e-aljabr2-blank.png') });

/* ---------------------------------------------------------------- */
await browser.close();
await fixtures.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log('  ✗', f.name, f.detail));
}
const realErrors = errors.filter((e) => !e.includes('favicon'));
if (realErrors.length) {
  console.log('\n控制台错误：');
  [...new Set(realErrors)].slice(0, 20).forEach((e) => console.log('  ' + e));
}
fs.writeFileSync(path.join(SHOTS, 'e2e-report.json'), JSON.stringify({ results, errors }, null, 2));
process.exitCode = failed.length || realErrors.length ? 1 : 0;

/* ---------------------------------------------------------------- */
async function stroke(pg, [x, y], len, amp) {
  await pg.mouse.move(x, y);
  await pg.mouse.down();
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    await pg.mouse.move(x + t * len, y + Math.sin(t * Math.PI * 2) * amp);
    await sleep(6);
  }
  await pg.mouse.up();
  await sleep(150);
}

async function drag(pg, [x1, y1], [x2, y2]) {
  await pg.mouse.move(x1, y1);
  await pg.mouse.down();
  await pg.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 5 });
  await pg.mouse.move(x2, y2, { steps: 5 });
  await pg.mouse.up();
  await sleep(200);
}
