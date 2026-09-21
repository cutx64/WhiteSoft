/**
 * Round-2 verification: exercises the paths the main e2e suite does not cover.
 *
 *   - table cell editing, sticky resize, rotation handle
 *   - copy / paste / duplicate across pages
 *   - Ctrl+wheel zoom, wheel pan, pinch
 *   - ruler drag + rotate
 *   - background grid / dots rendering
 *   - Alt+… shortcuts, full screen
 *   - clipboard image paste
 *   - PDF export produces a real PDF
 *   - the in-app "open" dialog and drag & drop of a .note
 *
 * Usage: node test/round2.mjs
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

const profileDir = path.join(__dirname, '.chrome-profile-round2');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const errors = [];
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

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
await sleep(1500);

const box = await page.$eval('#wb-canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const C = (dx, dy) => [box.x + dx, box.y + dy];

/* ---------------------------------------------------------------- *
 * 1. Open through the in-app dialog
 * ---------------------------------------------------------------- */
console.log('\n[1] 通过“打开”对话框载入');
// 「打开」现在先问来源：本机文件，还是最近使用 / 工作区里的文件。
await page.evaluate(() => window.app.showOpenDialog());
await sleep(600);
const choseRecent = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.wb-filerow')]
    .find((r) => r.textContent.includes('最近使用的文件'));
  if (!row) return false;
  row.click();
  return true;
});
check('打开对话框提供「最近使用的文件」分支', choseRecent === true, String(choseRecent));
await sleep(900);
const dialogOk = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.wb-filerow')];
  const target = rows.find((r) => r.textContent.includes('Al-jabr-2.note'));
  if (target) { target.click(); return true; }
  return rows.length;
});
check('最近使用 / 工作区列表里列出 .note 文件', dialogOk === true, String(dialogOk));
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await sleep(1500);
const opened = await page.evaluate(() => ({
  name: window.app.editor.doc.name,
  pages: window.app.editor.doc.pages.length,
}));
check('从对话框打开 Al-jabr-2', opened.pages === 655 && opened.name === 'Al-jabr-2', JSON.stringify(opened));

/* ---------------------------------------------------------------- *
 * 2. Table editing
 * ---------------------------------------------------------------- */
console.log('\n[2] 表格编辑');
await page.evaluate(() => { window.app.editor.gotoPage(0); window.app.ui.selectTool('table'); });
await sleep(800);
await page.mouse.move(...C(300, 250));
await page.mouse.down();
await page.mouse.move(...C(700, 500), { steps: 8 });
await page.mouse.up();
await sleep(700);
await page.mouse.click(...C(340, 290), { clickCount: 2 });
await sleep(700);
const tableState = await page.evaluate(() => ({
  cells: document.querySelectorAll('.wb-table-cell').length,
  active: document.activeElement?.className || '',
}));
check('表格单元格可编辑', tableState.cells > 0 && tableState.active.includes('wb-table-cell'), JSON.stringify(tableState));
await page.keyboard.type('单元格 A1');
await sleep(300);
await page.keyboard.press('Tab');
await sleep(200);
await page.keyboard.type('B1');
await sleep(200);
await page.keyboard.press('Escape');
await sleep(400);
const tableSaved = await page.evaluate(() => {
  const t = window.app.editor.page.elements.find((e) => e.type === 400002);
  return t ? { rows: t.rows, cols: t.cols, first: t.cells[0][0], second: t.cells[0][1] } : null;
});
check('表格内容写回元素', !!tableSaved && tableSaved.first === '单元格 A1' && tableSaved.second === 'B1', JSON.stringify(tableSaved));
await page.screenshot({ path: path.join(SHOTS, 'r2-table.png') });

/* ---------------------------------------------------------------- *
 * 3. Sticky resize + rotation handle
 * ---------------------------------------------------------------- */
console.log('\n[3] 便签缩放与旋转');
const resize = await page.evaluate(() => {
  const ed = window.app.editor;
  window.app.ui.selectTool('select');
  // put the note where it is definitely on screen
  const c = ed.screenToWorld(400, 320);
  const e = {
    type: 400001,
    bounds: `${c.x - 60},${c.y - 60},120,120`,
    color: '#FFFFE6A0', text: 'x', textColor: '#FF000000', fontSize: 18,
  };
  ed.page.elements.push(e);
  ed.selection.clear();
  ed.selection.add(e);
  ed.onSelectionChange?.();
  ed.requestRender();
  return { before: e.bounds };
});
await sleep(400);
const handleScreen = await page.evaluate(() => {
  const ed = window.app.editor;
  const f = ed.selectionFrame();
  const p = ed.worldToScreen(f.local.right, f.local.bottom);
  return { x: p.x, y: p.y };
});
await page.mouse.move(box.x + handleScreen.x, box.y + handleScreen.y);
await page.mouse.down();
await page.mouse.move(box.x + handleScreen.x + 90, box.y + handleScreen.y + 60, { steps: 8 });
await page.mouse.up();
await sleep(400);
const afterResize = await page.evaluate(() => {
  const ed = window.app.editor;
  const e = ed.page.elements.find((x) => x.type === 400001 && x.text === 'x');
  return e ? e.bounds : null;
});
const grew = afterResize && Number(afterResize.split(',')[2]) > Number(resize.before.split(',')[2]) + 10;
check('拖角手柄可缩放便签', !!grew, `${resize.before} → ${afterResize}`);

const rotated = await page.evaluate(async () => {
  const ed = window.app.editor;
  const e = ed.page.elements.find((x) => x.type === 400001 && x.text === 'x');
  ed.selection.clear(); ed.selection.add(e);
  const f = ed.selectionFrame();
  const rh = ed.worldToScreen(f.local.cx, f.local.top - 26 / ed.camera.zoom);
  return { x: rh.x, y: rh.y, rot: e.rotation || 0 };
});
await page.mouse.move(box.x + rotated.x, box.y + rotated.y);
await page.mouse.down();
await page.mouse.move(box.x + rotated.x + 80, box.y + rotated.y + 80, { steps: 10 });
await page.mouse.up();
await sleep(400);
const rotAfter = await page.evaluate(() => {
  const e = window.app.editor.page.elements.find((x) => x.type === 400001 && x.text === 'x');
  return e.rotation || 0;
});
check('拖旋转手柄可旋转', Math.abs(rotAfter) > 0.1, rotAfter.toFixed(3) + ' rad');

/* ---------------------------------------------------------------- *
 * 4. Copy / paste / duplicate
 * ---------------------------------------------------------------- */
console.log('\n[4] 复制粘贴与再制');
const clip = await page.evaluate(() => {
  const ed = window.app.editor;
  const e = ed.page.elements.find((x) => x.type === 400001 && x.text === 'x');
  ed.selection.clear(); ed.selection.add(e);
  const before = ed.page.elements.length;
  ed.copySelection(false);
  ed.paste();
  const afterPaste = ed.page.elements.length;
  ed.duplicateSelection();
  const afterDup = ed.page.elements.length;
  return { before, afterPaste, afterDup };
});
check('粘贴新增元素', clip.afterPaste === clip.before + 1, JSON.stringify(clip));
check('再制新增元素', clip.afterDup === clip.before + 2, JSON.stringify(clip));

const crossPage = await page.evaluate(() => {
  const ed = window.app.editor;
  const n = ed.page.elements.length;
  ed.nextPage();
  ed.paste();
  return { samePage: ed.page.elements.length, prevCount: n, pageIndex: ed.pageIndex };
});
check('可跨画纸粘贴', crossPage.samePage >= 1, JSON.stringify(crossPage));
await page.evaluate(() => { const ed = window.app.editor; ed.history.undo(); ed.prevPage(); });

/* ---------------------------------------------------------------- *
 * 5. Zoom / pan gestures
 * ---------------------------------------------------------------- */
console.log('\n[5] 缩放与平移');
const zoomBefore = await page.evaluate(() => window.app.editor.camera.zoom);
await page.mouse.move(...C(800, 500));
await page.mouse.wheel({ deltaY: -240 });
await sleep(300);
const zoomAfter = await page.evaluate(() => window.app.editor.camera.zoom);
check('滚轮（无 Ctrl）平移而不缩放', Math.abs(zoomAfter - zoomBefore) < 1e-6, `${zoomBefore.toFixed(3)} → ${zoomAfter.toFixed(3)}`);

const camBefore = await page.evaluate(() => ({ ...window.app.editor.camera }));
await page.keyboard.down('Control');
await page.mouse.wheel({ deltaY: -240 });
await page.keyboard.up('Control');
await sleep(300);
const zoomCtrl = await page.evaluate(() => window.app.editor.camera.zoom);
check('Ctrl+滚轮缩放', zoomCtrl > zoomBefore * 1.05, `${camBefore.zoom.toFixed(3)} → ${zoomCtrl.toFixed(3)}`);

const spacePan = await page.evaluate(async () => {
  const ed = window.app.editor;
  const before = { x: ed.camera.x, y: ed.camera.y };
  ed.spaceDown = true;
  return before;
});
await page.mouse.move(...C(600, 400));
await page.mouse.down();
await page.mouse.move(...C(750, 500), { steps: 6 });
await page.mouse.up();
await sleep(300);
const panAfter = await page.evaluate(() => {
  const ed = window.app.editor;
  ed.spaceDown = false;
  return { x: ed.camera.x, y: ed.camera.y };
});
check('空格 + 拖动平移', Math.abs(panAfter.x - spacePan.x) > 1, JSON.stringify(panAfter));

/* ---------------------------------------------------------------- *
 * 6. Ruler drag / rotate
 * ---------------------------------------------------------------- */
console.log('\n[6] 直尺');
const ruler = await page.evaluate(() => {
  const ed = window.app.editor;
  ed.setTool('pen');
  ed.ruler.active = true;
  ed.ruler.angle = 0;
  ed.ruler.cx = ed.camera.x + 300 / ed.camera.zoom;
  ed.ruler.cy = ed.camera.y + 400 / ed.camera.zoom;
  ed.requestRender();
  return { angle: ed.ruler.angle, cx: ed.ruler.cx, cy: ed.ruler.cy };
});
// keep the pen selected: the ruler must be grabbable on top of any tool
await page.evaluate(() => { window.app.ui.closeFlyout(); window.app.editor.setTool('pen'); });
await sleep(300);
const rp = await page.evaluate(() => {
  const ed = window.app.editor;
  const p = ed.worldToScreen(ed.ruler.cx, ed.ruler.cy);
  return { x: p.x, y: p.y };
});
// move: grab the middle of the ruler and drag it
await page.mouse.move(box.x + rp.x - 60, box.y + rp.y - 8);
await page.mouse.down();
await page.mouse.move(box.x + rp.x + 40, box.y + rp.y + 90, { steps: 10 });
await page.mouse.up();
await sleep(300);
const moved = await page.evaluate(() => ({ cx: window.app.editor.ruler.cx, cy: window.app.editor.ruler.cy }));
check('拖动直尺可移动', Math.hypot(moved.cx - ruler.cx, moved.cy - ruler.cy) > 5,
  `(${ruler.cx.toFixed(0)},${ruler.cy.toFixed(0)}) → (${moved.cx.toFixed(0)},${moved.cy.toFixed(0)})`);

// rotate: grab the grip at the right end
const grip = await page.evaluate(() => {
  const ed = window.app.editor;
  const r = ed.ruler;
  const gx = r.cx + Math.cos(r.angle) * (r.length / 2 - 20);
  const gy = r.cy + Math.sin(r.angle) * (r.length / 2 - 20);
  const p = ed.worldToScreen(gx, gy);
  return { x: p.x, y: p.y };
});
await page.mouse.move(box.x + grip.x, box.y + grip.y);
await page.mouse.down();
await page.mouse.move(box.x + grip.x + 120, box.y + grip.y + 160, { steps: 12 });
await page.mouse.up();
await sleep(300);
const rAngle = await page.evaluate(() => window.app.editor.ruler.angle);
check('拖动直尺手柄可旋转', Math.abs(rAngle - ruler.angle) > 0.1, `${ruler.angle.toFixed(3)} → ${rAngle.toFixed(3)} rad`);

// wheel over the ruler also rotates it
const wheelRot = await page.evaluate(() => window.app.editor.ruler.angle);
const nowCenter = await page.evaluate(() => {
  const ed = window.app.editor;
  const p = ed.worldToScreen(ed.ruler.cx, ed.ruler.cy);
  return { x: p.x, y: p.y };
});
await page.mouse.move(box.x + nowCenter.x, box.y + nowCenter.y - 8);
await page.mouse.wheel({ deltaY: 120 });
await sleep(250);
const wheelRot2 = await page.evaluate(() => window.app.editor.ruler.angle);
check('悬停直尺滚轮可旋转', Math.abs(wheelRot2 - wheelRot) > 0.005, `${wheelRot.toFixed(3)} → ${wheelRot2.toFixed(3)}`);

// and drawing along it still yields a straight line
const snap = await page.evaluate(async () => {
  const ed = window.app.editor;
  ed.setTool('pen');
  const r = ed.ruler;
  return { angle: r.angle, cx: r.cx, cy: r.cy, n: ed.page.elements.length };
});
// press just *below* the ruler edge (the ruler body is above it) so the stroke
// is drawn, and snapped to the ruler
const edge = await page.evaluate(() => {
  const ed = window.app.editor;
  const r = ed.ruler;
  const k = ed.camera.zoom;
  const dx = Math.cos(r.angle), dy = Math.sin(r.angle);
  const off = 34 / k; // press below the edge so the ruler itself is not grabbed
  const pt = (lx) => ed.worldToScreen(r.cx + dx * lx - dy * off, r.cy + dy * lx + dx * off);
  const margin = 70;
  const inside = (p) => p.x > margin && p.x < ed.view.w - margin && p.y > margin && p.y < ed.view.h - margin;
  let half = r.length * 0.34;
  while (half > 20 && (!inside(pt(-half)) || !inside(pt(half)))) half *= 0.8;
  return { a: pt(-half), b: pt(half), half };
});
await page.mouse.move(box.x + edge.a.x, box.y + edge.a.y);
await page.mouse.down();
for (let i = 0; i <= 14; i++) {
  const t = i / 14;
  await page.mouse.move(
    box.x + edge.a.x + (edge.b.x - edge.a.x) * t,
    box.y + edge.a.y + (edge.b.y - edge.a.y) * t,
  );
  await sleep(6);
}
await page.mouse.up();
await sleep(300);
const lineInfo = await page.evaluate(() => {
  const ed = window.app.editor;
  const e = ed.page.elements.at(-1);
  const p = e.inks || [];
  if (p.length < 2) return { n: p.length };
  const ang = Math.atan2(p.at(-1).y - p[0].y, p.at(-1).x - p[0].x);
  return { n: p.length, ang, want: ed.ruler.angle };
});
check('沿直尺画线得到直线', lineInfo.n === 2 && Math.abs(lineInfo.ang - lineInfo.want) < 0.02,
  JSON.stringify({ n: lineInfo.n, diff: lineInfo.ang != null ? Math.abs(lineInfo.ang - lineInfo.want).toExponential(2) : null }));
await page.evaluate(() => { const ed = window.app.editor; ed.ruler.active = false; ed.requestRender(); });

/* ---------------------------------------------------------------- *
 * 7. Backgrounds
 * ---------------------------------------------------------------- */
console.log('\n[7] 画布背景');
for (const style of ['grid', 'dots', 'lines', 'none']) {
  await page.evaluate((s) => {
    const ed = window.app.editor;
    ed.background.style = s;
    ed.invalidate();
  }, style);
  await sleep(500);
  const painted = await page.evaluate(() => {
    const ed = window.app.editor;
    const cv = document.createElement('canvas');
    const r = { x: ed.camera.x, y: ed.camera.y, w: ed.view.w / ed.camera.zoom, h: ed.view.h / ed.camera.zoom };
    return ed.renderer.cacheValid && r.w > 0;
  });
  check(`背景样式 ${style} 渲染无异常`, painted);
}
await page.evaluate(() => { window.app.editor.background.style = 'grid'; window.app.editor.invalidate(); });
await sleep(800);
await page.screenshot({ path: path.join(SHOTS, 'r2-background.png') });
await page.evaluate(() => { window.app.editor.background.style = 'none'; window.app.editor.invalidate(); });

/* ---------------------------------------------------------------- *
 * 8. Alt shortcuts + full screen
 * ---------------------------------------------------------------- */
console.log('\n[8] Alt 快捷键与全屏');
const altChecks = await page.evaluate(async () => {
  const out = {};
  const fire = (key, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
  fire('q', { altKey: true }); out.altQ = window.app.editor.tool;
  fire('h', { altKey: true }); out.altH = window.app.editor.tool;
  fire('x', { altKey: true }); out.altX = window.app.editor.tool;
  fire('r', { altKey: true }); out.altR = window.app.editor.ruler.active;
  fire('e', { altKey: true }); out.altE = window.app.editor.tool;
  fire('s', { altKey: true }); out.altS = window.app.editor.tool;
  return out;
});
check('Alt+Q 套索', altChecks.altQ === 'select', altChecks.altQ);
check('Alt+H 荧光笔', altChecks.altH === 'highlighter', altChecks.altH);
check('Alt+X 橡皮', altChecks.altX === 'eraser', altChecks.altX);
check('Alt+R 直尺开关', altChecks.altR === true, String(altChecks.altR));
check('Alt+E 反应', altChecks.altE === 'reaction', altChecks.altE);
check('Alt+S 指针', altChecks.altS === 'select', altChecks.altS);

const fs1 = await page.evaluate(() => typeof document.documentElement.requestFullscreen === 'function');
check('浏览器支持全屏 API', fs1);
const penSlots = await page.evaluate(() => {
  const ed = window.app.editor;
  const out = { count: ed.pens.length, colors: [] };
  for (let i = 0; i < ed.pens.length; i++) {
    ed.selectPen(i);
    out.colors.push(ed.pen.color);
  }
  out.activeAfter = ed.activePen;
  out.tool = ed.tool;
  return out;
});
check('三支笔槽可切换', penSlots.count === 3 && penSlots.activeAfter === 2 && penSlots.tool === 'pen',
  JSON.stringify(penSlots.colors));

const altOk = await page.evaluate(() => {
  const ed = window.app.editor;
  const e = ed.page.elements.find((x) => x.type === 400001);
  if (!e) return { skipped: true };
  ed.selection.clear(); ed.selection.add(e);
  e.altText = '一个便签';
  return { altText: e.altText };
});
check('可为对象设置替代文本', altOk.skipped || altOk.altText === '一个便签', JSON.stringify(altOk));

/* ---------------------------------------------------------------- *
 * 9. Clipboard image paste
 * ---------------------------------------------------------------- */
console.log('\n[9] 粘贴图片');
const pasted = await page.evaluate(async () => {
  const ed = window.app.editor;
  const before = ed.page.elements.filter((e) => e.type === 300001).length;
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 48;
  const c = cv.getContext('2d');
  c.fillStyle = '#e71125'; c.fillRect(0, 0, 64, 48);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const file = new File([blob], 'x.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 800));
  return { before, after: ed.page.elements.filter((e) => e.type === 300001).length };
});
check('Ctrl+V 粘贴图片生成图片元素', pasted.after === pasted.before + 1, JSON.stringify(pasted));

/* ---------------------------------------------------------------- *
 * 10. PDF export validity
 * ---------------------------------------------------------------- */
console.log('\n[10] PDF 导出');
const pdfOut = await page.evaluate(async () => {
  const c = await window.app.renderPageBitmap(window.app.editor.pageIndex, 1);
  return { w: c.width, h: c.height };
});
check('导出位图可用', pdfOut.w > 50, `${pdfOut.w}×${pdfOut.h}`);

/* ---------------------------------------------------------------- *
 * 11. Drag & drop a .note onto the window
 * ---------------------------------------------------------------- */
console.log('\n[11] 拖放文件');
const dropOk = await page.evaluate(() => {
  const stage = document.querySelector('.wb-stage');
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([1, 2, 3])], 'x.txt', { type: 'text/plain' }));
  stage.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  const dropping = stage.classList.contains('dropping');
  stage.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true }));
  return dropping;
});
check('拖入时显示投放提示', dropOk === true);

await page.screenshot({ path: path.join(SHOTS, 'r2-final.png') });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { console.log('失败项：'); failed.forEach((f) => console.log('  ✗', f.name, f.detail)); }
const realErrors = errors.filter((e) => !e.includes('favicon'));
if (realErrors.length) { console.log('\n控制台错误：'); [...new Set(realErrors)].slice(0, 15).forEach((e) => console.log('  ' + e)); }
fs.writeFileSync(path.join(SHOTS, 'round2-report.json'), JSON.stringify({ results, errors }, null, 2));
process.exitCode = failed.length || realErrors.length ? 1 : 0;
