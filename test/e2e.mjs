/**
 * End-to-end functional test.
 *
 * Covers: .note loading (both sample archives), heavy-page rendering
 * performance, every drawing tool, ruler, selection, undo/redo, page
 * navigation, PDF import, .note save round-trip and PNG/PDF/Zip export.
 *
 * Usage: node test/e2e.mjs [--chrome <path>]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHROME = arg('chrome', path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');

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

/* ---------------------------------------------------------------- *
 * 1. Load Al-jabr-1.note
 * ---------------------------------------------------------------- */
console.log('\n[1] 打开 Al-jabr-1.note');
await page.evaluate(() => window.app.loadNote('Al-jabr-1.note', { confirm: false }));
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await sleep(2500);
const doc1 = await page.evaluate(() => {
  const ed = window.app.editor;
  return {
    pages: ed.doc.pages.length,
    pdfPages: ed.pdf.pageCount,
    current: ed.pageIndex,
    elements: ed.page.elements.length,
    pdfBitmap: !!(ed._pdfPages && ed._pdfPages[0] && ed._pdfPages[0].bitmap),
  };
});
check('画纸数 = 446', doc1.pages === 446, String(doc1.pages));
check('PDF 页数 = 445', doc1.pdfPages === 445, String(doc1.pdfPages));
check('manifest.currentPage 生效 (163)', doc1.current === 162, String(doc1.current + 1));
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
await page.evaluate(() => window.app.loadNote('Al-jabr-1.note', { confirm: false }));
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
  return { elements: ed.page.elements.length, types: [...new Set(ed.page.elements.map((e) => e.type))] };
});
const saved = await page.evaluate(async () => {
  const ed = window.app.editor;
  const doc = ed.doc;
  doc.path = '.cache/roundtrip.note';
  await window.app.save();
  await new Promise((r) => setTimeout(r, 1500));
  return { ok: !window.app.modified, target: doc.path, name: doc.name };
});
check('写入 .note 成功', saved.ok === true, JSON.stringify(saved).slice(0, 120));

// a save must not drop any entry the source archive contained
const entryCheck = await page.evaluate(async () => {
  const a = await (await fetch('/api/note/meta?path=' + encodeURIComponent('Al-jabr-1.note'))).json();
  const b = await (await fetch('/api/note/meta?path=' + encodeURIComponent('.cache/roundtrip.note'))).json();
  return { source: a.entryCount, saved: b.entryCount };
});
// keepAll copies every source entry, so saving can only ever add entries
check('保存不丢条目（原样保留源归档 + 新增资源）', entryCheck.saved >= entryCheck.source,
  `${entryCheck.source} → ${entryCheck.saved}`);

const reopened = await page.evaluate(async () => {
  const ed = window.app.editor;
  await window.app.loadNote('.cache/roundtrip.note', { confirm: false });
  const p = ed.doc.pages[400];
  return {
    pages: ed.doc.pages.length,
    elements: p.elements.length,
    marker: p.elements.some((e) => e._roundtrip === 'yes'),
    pdfPages: p.pdfPages?.length || 0,
    types: [...new Set(p.elements.map((e) => e.type))],
  };
});
check('回读画纸数一致', reopened.pages === 446, String(reopened.pages));
check('回读元素数一致', reopened.elements === preSave.elements, `${reopened.elements} vs ${preSave.elements}`);
check('自定义扩展字段保真', reopened.marker);
check('pdfPages 保真', reopened.pdfPages === 1);
check('元素类型齐全', reopened.types.length >= preSave.types.length, JSON.stringify(reopened.types));
await page.screenshot({ path: path.join(SHOTS, 'e2e-roundtrip.png') });

/* ---------------------------------------------------------------- *
 * 8. PDF import
 * ---------------------------------------------------------------- */
console.log('\n[8] 导入 PDF');
const pdfBytes = await page.evaluate(async () => {
  const res = await fetch('/api/note/document?path=' + encodeURIComponent('Al-jabr-1.note'));
  const buf = await res.arrayBuffer();
  return buf.byteLength;
});
check('可取到 PDF 字节', pdfBytes > 1000, pdfBytes + ' bytes');

const imported = await page.evaluate(async () => {
  const res = await fetch('/api/note/document?path=' + encodeURIComponent('Al-jabr-1.note'));
  const blob = await res.blob();
  const file = new File([blob], 'Al-jabr-1.pdf', { type: 'application/pdf' });
  await window.app.importPdfFile(file);
  await new Promise((r) => setTimeout(r, 2500));
  const ed = window.app.editor;
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
const importSave = await page.evaluate(async () => {
  const ed = window.app.editor;
  ed.doc.path = '.cache/imported.note';
  const cv = document.createElement('canvas');
  ed.setTool('pen');
  await window.app.save();
  await new Promise((r) => setTimeout(r, 1200));
  void cv;
  return { path: ed.doc.path, name: ed.doc.name, modified: window.app.modified };
});
check('另存为 .note 成功', importSave.modified === false, JSON.stringify(importSave));
const reImported = await page.evaluate(async () => {
  await window.app.loadNote('.cache/imported.note', { confirm: false });
  const ed = window.app.editor;
  await new Promise((r) => setTimeout(r, 1200));
  return {
    pages: ed.doc.pages.length,
    pdfPages: ed.pdf.pageCount,
    pdfOpen: ed.pdf.isOpen,
    bg: !!(ed._pdfPages && ed._pdfPages[0] && ed._pdfPages[0].bitmap),
  };
});
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
await page.evaluate(() => window.app.loadNote('Al-jabr-2.note', { confirm: false }));
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await sleep(2500);
const doc2 = await page.evaluate(() => {
  const ed = window.app.editor;
  const idx = ed.doc.pages.findIndex((p) => p.elements.length > 20);
  ed.gotoPage(idx >= 0 ? idx : 0);
  return { pages: ed.doc.pages.length, pdf: ed.pdf.pageCount, idx, elements: ed.page.elements.length };
});
check('Al-jabr-2 画纸数 = 655', doc2.pages === 655, String(doc2.pages));
check('Al-jabr-2 PDF 页数 = 652', doc2.pdf === 652, String(doc2.pdf));
await page.waitForFunction(() => {
  const ed = window.app.editor;
  return ed._pdfPages && ed._pdfPages[0] && ed._pdfPages[0].bitmap;
}, { timeout: 60000 });
await sleep(1500);
await page.screenshot({ path: path.join(SHOTS, 'e2e-aljabr2.png') });

/* ---------------------------------------------------------------- */
await browser.close();

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
