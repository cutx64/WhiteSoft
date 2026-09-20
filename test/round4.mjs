/**
 * Round-4 verification:
 *
 *   1. the first marquee/lasso drag only selects — it never moves anything
 *   2. numbered tool shortcuts, Shift+N (new board), Ctrl+Alt+N/P (new page)
 *   3. the floating selection action bar (colour, copy to another page, …)
 *   4. image scaling keeps the aspect ratio, and "send to very bottom"
 *
 * Usage: node test/round4.mjs
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

const profileDir = path.join(__dirname, '.chrome-profile-round4');
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
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function drag([x1, y1], [x2, y2]) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 5 });
  await page.mouse.move(x2, y2, { steps: 5 });
  await page.mouse.up();
  await sleep(250);
}

/** Put a fresh sticky note on screen at canvas coordinates cx,cy. */
async function seedSticky(cx, cy) {
  return page.evaluate(({ cx, cy }) => {
    const ed = window.app.editor;
    const w = ed.screenToWorld(cx, cy);
    const s = 120 / ed.camera.zoom;
    const e = {
      type: 400001, bounds: `${w.x - s / 2},${w.y - s / 2},${s},${s}`,
      color: '#FFFFE6A0', text: 'seed', textColor: '#FF000000', fontSize: 18 / ed.camera.zoom,
    };
    ed.page.elements.push(e);
    ed.selection.clear();
    ed.onSelectionChange?.();
    ed.invalidate();
    return { bounds: e.bounds };
  }, { cx, cy });
}

const boundOf = (text) => page.evaluate((t) => {
  const e = window.app.editor.page.elements.find((x) => x.text === t);
  return e ? e.bounds.split(',').map(Number) : null;
}, text);

/* ================================================================ *
 * 1. First drag only selects
 * ================================================================ */
console.log('\n[1] 第一次框选只选中，不移动');
await page.evaluate(() => { window.app.ui.closeFlyout(); window.app.ui.selectTool('marquee'); });
await seedSticky(700, 500);
await settle();
const before1 = await boundOf('seed');

// drag a marquee that starts *on top of* the note and covers it
await drag(C(600, 400), C(850, 640));
const afterMarquee = await boundOf('seed');
check('框选起点压在对象上也不会拖动它',
  afterMarquee[0] === before1[0] && afterMarquee[1] === before1[1],
  `${before1.slice(0, 2)} → ${afterMarquee.slice(0, 2)}`);
const selCount = await page.evaluate(() => window.app.editor.selection.size);
check('这一次操作完成了选中', selCount === 1, String(selCount));

// now a second, separate drag from inside the selection *does* move it
await drag(C(700, 500), C(760, 545));
const afterMove = await boundOf('seed');
check('再次拖动才移动位置',
  Math.abs(afterMove[0] - before1[0]) > 1 && Math.abs(afterMove[1] - before1[1]) > 1,
  `${before1.slice(0, 2)} → ${afterMove.slice(0, 2)}`);

// same rule for the lasso tool, starting on top of the object
await page.evaluate(() => window.app.ui.selectTool('select'));
const before2 = await boundOf('seed');
await drag(C(process.env.X || 700, 500), C(700, 500));
const after2 = await boundOf('seed');
check('套索同样只选中不移动', Math.abs(after2[0] - before2[0]) < 1e-6, `${before2.slice(0, 2)} → ${after2.slice(0, 2)}`);

// a single click on empty canvas clears the selection without moving anything
await page.mouse.click(...C(300, 800));
await sleep(200);
const afterClick = await boundOf('seed');
check('点击空白只取消选择', Math.abs(afterClick[0] - before2[0]) < 1e-6);

/* ================================================================ *
 * 1b. Dashed marquee / lasso visuals
 * ================================================================ */
console.log('\n[1b] 框选区域的虚线可视化');

const px = (x, y) => page.evaluate(({ x, y }) => {
  const c = document.querySelector('#wb-canvas');
  const d = c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return { r: d[0], g: d[1], b: d[2] };
}, { x, y });

// --- rectangle marquee, held mid-drag ---
await page.evaluate(() => { window.app.ui.selectTool('marquee'); window.app.editor.clearSelection(); });
await settle();
const beforeMarqueePx = await px(400, 350);
await page.mouse.move(...C(200, 200));
await page.mouse.down();
await page.mouse.move(...C(420, 380), { steps: 6 });
await page.mouse.move(...C(600, 500), { steps: 6 });
await settle();
const duringMarqueePx = await px(400, 350);
const insideNow = await page.evaluate(() => {
  const ed = window.app.editor;
  // a point well inside the rubber band must not be the plain white page
  return { sel: ed.selection.size, mode: ed.mode };
});
await page.mouse.up();
await settle();
const afterMarqueePx = await px(400, 350);

const tinted = (p, base) => Math.abs(p.b - base.b) > 6 || Math.abs(p.g - base.g) > 6;
check('矩形框选过程中画出虚线选区（像素被着色）',
  tinted(duringMarqueePx, beforeMarqueePx),
  `${JSON.stringify(beforeMarqueePx)} → ${JSON.stringify(duringMarqueePx)}`);
check('松手后虚线选区消失',
  !tinted(afterMarqueePx, beforeMarqueePx),
  JSON.stringify(afterMarqueePx));
check('拖动过程中不会先选中按下的对象', insideNow.sel === 0 && insideNow.mode === 'draw',
  JSON.stringify(insideNow));

// --- lasso, held mid-drag ---
await page.evaluate(() => { window.app.ui.selectTool('select'); window.app.editor.clearSelection(); });
await settle();
const beforeLassoPx = await px(500, 400);
await page.mouse.move(...C(350, 250));
await page.mouse.down();
for (const [x, y] of [[650, 250], [650, 520], [350, 520], [350, 300]]) {
  await page.mouse.move(...C(x, y), { steps: 8 });
}
await settle();
const duringLassoPx = await px(500, 400);
await page.screenshot({ path: path.join(SHOTS, 'r4-lasso.png') });
await page.mouse.up();
await settle();
const afterLassoPx = await px(500, 400);
check('套索过程中画出虚线套索（像素被着色）',
  tinted(duringLassoPx, beforeLassoPx),
  `${JSON.stringify(beforeLassoPx)} → ${JSON.stringify(duringLassoPx)}`);
check('松手后套索消失', !tinted(afterLassoPx, beforeLassoPx), JSON.stringify(afterLassoPx));

// --- pressing straight onto an object still runs the marquee, then selects on release ---
await page.evaluate(() => {
  const ed = window.app.editor;
  ed.page.elements = [];
  const w = ed.screenToWorld(700, 400);
  ed.page.elements.push({ type: 400001, bounds: `${w.x - 80},${w.y - 80},160,160`, color: '#FFFFE6A0', text: 'under', textColor: '#FF000000', fontSize: 18 });
  ed.selection.clear();
  ed.onSelectionChange?.();
  ed.invalidate();
  window.app.ui.selectTool('marquee');
});
await settle();
await page.mouse.move(...C(700, 400));   // exactly on the note
await page.mouse.down();
await page.mouse.move(...C(820, 520), { steps: 8 });
await settle();
const midPress = await page.evaluate(() => ({ sel: window.app.editor.selection.size, mode: window.app.editor.mode }));
await page.mouse.up();
await settle();
const afterPress = await page.evaluate(() => ({
  sel: window.app.editor.selection.size,
  texts: [...window.app.editor.selection].map((e) => e.text),
  x: window.app.editor.page.elements[0].bounds.split(',').map(Number)[0],
}));
check('直接点中目标时先忽略它，继续走虚线框流程',
  midPress.sel === 0 && midPress.mode === 'draw', JSON.stringify(midPress));
check('确定终点后再判定选中了哪些东西', afterPress.sel === 1 && afterPress.texts[0] === 'under',
  JSON.stringify(afterPress));

/* ================================================================ *
 * 2. Shortcuts
 * ================================================================ */
console.log('\n[2] 工具栏数字快捷键与新页快捷键');
const order = await page.evaluate(() => window.app.ui.toolOrder);
check('工具栏工具有序号', Array.isArray(order) && order.length >= 10, JSON.stringify(order));

const digitChecks = [];
for (let i = 0; i < 10; i++) {
  const key = i === 9 ? '0' : String(i + 1);
  const got = await page.evaluate((k) => {
    const ed = window.app.editor;
    ed.ruler.active = false;               // the ruler is a toggle, start clean
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    return { tool: ed.tool, ruler: ed.ruler.active };
  }, key);
  // 'ruler' turns the ruler on instead of switching the active tool
  const ok = order[i] === 'ruler' ? got.ruler === true : got.tool === order[i];
  digitChecks.push({ key, want: order[i], got: got.tool, ruler: got.ruler, ok });
}
check('数字键按顺序选中工具栏工具', digitChecks.every((d) => d.ok),
  digitChecks.map((d) => `${d.key}→${d.want === 'ruler' ? 'ruler:' + d.ruler : d.got}`).join(' '));

// Shift+N starts a new board, lowercase N still picks the sticky tool
const caseCheck = await page.evaluate(async () => {
  const ed = window.app.editor;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  const lower = ed.tool;
  const before = { pages: ed.doc.pages.length, name: ed.doc.name };
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', shiftKey: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  // the board has unsaved edits, so the confirmation dialog appears first
  const prompted = !!document.querySelector('.wb-modal');
  const discard = [...document.querySelectorAll('.wb-modal button')].find((b) => b.textContent.trim() === '放弃更改');
  if (discard) discard.click();
  await new Promise((r) => setTimeout(r, 600));
  return {
    lower, before, prompted,
    after: { pages: ed.doc.pages.length, name: ed.doc.name, elements: ed.page.elements.length },
  };
});
check('小写 n 仍是便签工具', caseCheck.lower === 'sticky', caseCheck.lower);
check('Shift+N 新建白板（先弹未保存确认）',
  caseCheck.prompted && caseCheck.after.pages === 1 && caseCheck.after.elements === 0,
  JSON.stringify({ prompted: caseCheck.prompted, after: caseCheck.after }));

// Ctrl+Alt+N / Ctrl+Alt+P insert after / before
const pageKeys = await page.evaluate(async () => {
  const ed = window.app.editor;
  const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, altKey: true, bubbles: true }));
  ed.gotoPage(0);
  const start = ed.doc.pages.length;
  fire('n');
  await new Promise((r) => setTimeout(r, 60));
  const afterInsert = { count: ed.doc.pages.length, index: ed.pageIndex };
  fire('p');
  await new Promise((r) => setTimeout(r, 60));
  const beforeInsert = { count: ed.doc.pages.length, index: ed.pageIndex };
  return { start, afterInsert, beforeInsert };
});
check('Ctrl+Alt+N 在当前页之后新建',
  pageKeys.afterInsert.count === pageKeys.start + 1 && pageKeys.afterInsert.index === 1,
  JSON.stringify(pageKeys.afterInsert));
check('Ctrl+Alt+P 在当前页之前新建',
  pageKeys.beforeInsert.count === pageKeys.start + 2 && pageKeys.beforeInsert.index === 1,
  JSON.stringify(pageKeys.beforeInsert));

/* ================================================================ *
 * 3. Selection action bar
 * ================================================================ */
console.log('\n[3] 所选操作栏');
await page.evaluate(() => window.app.ui.selectTool('marquee'));
await seedSticky(700, 500);
await page.evaluate(() => {
  const ed = window.app.editor;
  ed.page.elements.forEach((e) => { if (e.__seed) delete e.__seed; });
  ed.selection.clear();
  ed.selection.add(ed.page.elements.at(-1));
  ed.onSelectionChange?.();
  ed.requestRender();
});
await settle();
await sleep(300);
const barInfo = await page.evaluate(() => {
  const bar = document.querySelector('.wb-selbar');
  if (!bar) return null;
  const r = bar.getBoundingClientRect();
  const sel = window.app.editor.selectionScreenRect();
  const canvas = document.querySelector('#wb-canvas').getBoundingClientRect();
  return {
    buttons: [...bar.querySelectorAll('.wb-selbtn')].map((b) => b.title),
    bar: { top: r.top - canvas.top, bottom: r.bottom - canvas.top, left: r.left - canvas.left, right: r.right - canvas.left },
    sel,
  };
});
check('选中后出现浮动操作栏', !!barInfo && barInfo.buttons.length >= 8, JSON.stringify(barInfo && barInfo.buttons));
const noOverlap = barInfo && (barInfo.bar.top >= barInfo.sel.y + barInfo.sel.h
  || barInfo.bar.bottom <= barInfo.sel.y);
check('操作栏不遮挡选区（旋转手柄也不受影响）', !!noOverlap,
  barInfo ? `bar ${Math.round(barInfo.bar.top)}–${Math.round(barInfo.bar.bottom)}, sel ${Math.round(barInfo.sel.y)}–${Math.round(barInfo.sel.y + barInfo.sel.h)}` : 'n/a');

await page.screenshot({ path: path.join(SHOTS, 'r4-selbar.png') });

// --- colour ---
const colour = await page.evaluate(async () => {
  const ed = window.app.editor;
  const e = ed.page.elements.at(-1);
  const before = e.color;
  const btn = [...document.querySelectorAll('.wb-selbar .wb-selbtn')].find((b) => b.title.includes('改变颜色'));
  btn.click();
  await new Promise((r) => setTimeout(r, 150));
  const swatches = [...document.querySelectorAll('.wb-selpopover .wb-swatch')];
  const target = swatches[3];
  const picked = target && target.style.background;
  target.click();
  await new Promise((r) => setTimeout(r, 200));
  return { before, after: e.color, picked, swatchCount: swatches.length };
});
check('操作栏可改变颜色', colour.after !== colour.before && !!colour.after,
  `${colour.before} → ${colour.after}`);
await page.screenshot({ path: path.join(SHOTS, 'r4-colour.png') });

// --- copy to next page ---
const copyNext = await page.evaluate(async () => {
  const ed = window.app.editor;
  ed.gotoPage(0);
  await new Promise((r) => setTimeout(r, 100));
  ed.page.elements = [{
    type: 400001, bounds: '100,100,120,120', color: '#FFFFE6A0', text: 'mover',
    textColor: '#FF000000', fontSize: 18,
  }];
  ed.selection.clear();
  ed.selection.add(ed.page.elements[0]);
  ed.onSelectionChange?.();
  ed.requestRender();
  await new Promise((r) => setTimeout(r, 250));
  const beforeNext = ed.doc.pages[1].elements.length;
  const btn = [...document.querySelectorAll('.wb-selbar .wb-selbtn')].find((b) => b.title.includes('复制到下一页'));
  const found = !!btn;
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 250));
  return {
    found,
    sourceStillThere: ed.doc.pages[0].elements.length,
    targetBefore: beforeNext,
    targetAfter: ed.doc.pages[1].elements.length,
    copiedText: (ed.doc.pages[1].elements.at(-1) || {}).text,
  };
});
check('操作栏复制到下一页',
  copyNext.found && copyNext.sourceStillThere === 1 && copyNext.targetAfter === copyNext.targetBefore + 1
  && copyNext.copiedText === 'mover',
  JSON.stringify(copyNext));

// --- copy to an arbitrary page ---
const copyArbitrary = await page.evaluate(async () => {
  const ed = window.app.editor;
  while (ed.doc.pages.length < 5) ed.doc.pages.push({ elements: [], scale: 1, pdfPages: [] });
  ed.gotoPage(0);
  ed.selection.clear();
  ed.selection.add(ed.page.elements[0]);
  ed.onSelectionChange?.();
  ed.requestRender();
  await new Promise((r) => setTimeout(r, 250));
  const btn = [...document.querySelectorAll('.wb-selbar .wb-selbtn')].find((b) => b.title.includes('复制到指定页'));
  btn.click();
  await new Promise((r) => setTimeout(r, 150));
  const input = document.querySelector('.wb-selpage-input');
  const hadPrompt = !!input;
  input.value = '4';
  const go = [...document.querySelectorAll('.wb-selpopover button')].find((b) => b.textContent.trim() === '复制');
  go.click();
  await new Promise((r) => setTimeout(r, 250));
  return {
    hadPrompt,
    page4: ed.doc.pages[3].elements.length,
    page0: ed.doc.pages[0].elements.length,
    text: (ed.doc.pages[3].elements.at(-1) || {}).text,
  };
});
check('操作栏可输入页码复制到任意页',
  copyArbitrary.hadPrompt && copyArbitrary.page4 === 1 && copyArbitrary.text === 'mover' && copyArbitrary.page0 === 1,
  JSON.stringify(copyArbitrary));

/* ================================================================ *
 * 4. Image aspect ratio + send to very bottom
 * ================================================================ */
console.log('\n[4] 图片等比缩放与移到最底层');
const imgSetup = await page.evaluate(async () => {
  const ed = window.app.editor;
  ed.gotoPage(0);
  await new Promise((r) => setTimeout(r, 100));
  ed.doc.pages[0].elements = [
    { type: 100001, stroke: '#FF000000', width: 3, inks: [{ x: 60, y: 60, pr: 0.5 }, { x: 160, y: 90, pr: 0.5 }] },
    { type: 400001, bounds: '200,60,100,100', color: '#FFFFE6A0', text: 'over', textColor: '#FF000000', fontSize: 18 },
    { type: 300001, bounds: '400,300,400,200', rotation: 0, fileName: 'nonexistent.png' },
  ];
  const img = ed.doc.pages[0].elements[2];
  ed.selection.clear();
  ed.selection.add(img);
  ed.onSelectionChange?.();
  ed.requestRender();
  await new Promise((r) => setTimeout(r, 250));
  const f = ed.selectionFrame();
  const handle = ed.worldToScreen(f.local.left, f.local.top);
  return { bounds: img.bounds.split(',').map(Number), handle, index: ed.doc.pages[0].elements.indexOf(img) };
});
check('图片初始不在最底层', imgSetup.index > 0, String(imgSetup.index));

// drag the corner handle outwards, mostly in x, staying inside the canvas
await page.mouse.move(box.x + imgSetup.handle.x, box.y + imgSetup.handle.y);
await page.mouse.down();
await page.mouse.move(box.x + imgSetup.handle.x - 220, box.y + imgSetup.handle.y - 20, { steps: 10 });
await page.mouse.up();
await sleep(300);
const scaled = await page.evaluate(() => {
  const e = window.app.editor.page.elements.find((x) => x.type === 300001);
  return e.bounds.split(',').map(Number);
});
const ratioBefore = imgSetup.bounds[2] / imgSetup.bounds[3];
const ratioAfter = scaled[2] / scaled[3];
check('拖角手柄缩放图片保持长宽比', Math.abs(ratioAfter - ratioBefore) < 0.01,
  `${ratioBefore.toFixed(3)} → ${ratioAfter.toFixed(3)} (${scaled[2].toFixed(0)}×${scaled[3].toFixed(0)})`);
check('图片确实被放大了', scaled[2] > imgSetup.bounds[2] + 10, `${imgSetup.bounds[2]} → ${scaled[2].toFixed(0)}`);

// an edge handle must also stay proportional
const edgeHandle = await page.evaluate(() => {
  const ed = window.app.editor;
  const e = ed.page.elements.find((x) => x.type === 300001);
  ed.selection.clear(); ed.selection.add(e); ed.onSelectionChange?.();
  const f = ed.selectionFrame();
  return { p: ed.worldToScreen(f.local.right, f.local.cy), bounds: e.bounds.split(',').map(Number) };
});
await page.mouse.move(box.x + edgeHandle.p.x, box.y + edgeHandle.p.y);
await page.mouse.down();
await page.mouse.move(box.x + edgeHandle.p.x - 150, box.y + edgeHandle.p.y, { steps: 10 });
await page.mouse.up();
await sleep(300);
const edgeScaled = await page.evaluate(() => {
  const e = window.app.editor.page.elements.find((x) => x.type === 300001);
  return e.bounds.split(',').map(Number);
});
check('拖边手柄缩放图片同样保持长宽比',
  Math.abs(edgeScaled[2] / edgeScaled[3] - ratioBefore) < 0.01,
  `${(edgeScaled[2] / edgeScaled[3]).toFixed(3)} (${edgeScaled[2].toFixed(0)}×${edgeScaled[3].toFixed(0)})`);

// send to very bottom from the action bar
await page.evaluate(() => {
  const ed = window.app.editor;
  const e = ed.page.elements.find((x) => x.type === 300001);
  ed.selection.clear(); ed.selection.add(e); ed.onSelectionChange?.(); ed.requestRender();
});
await sleep(300);
const bottom = await page.evaluate(async () => {
  const ed = window.app.editor;
  const btn = [...document.querySelectorAll('.wb-selbar .wb-selbtn')].find((b) => b.title.includes('最底层'));
  const found = !!btn;
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 250));
  return { found, index: ed.page.elements.findIndex((x) => x.type === 300001), items: ed.page.elements.map((x) => x.type) };
});
check('操作栏“移到图层最底层”', bottom.found && bottom.index === 0, JSON.stringify(bottom));
await page.screenshot({ path: path.join(SHOTS, 'r4-image-bottom.png') });

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { console.log('失败项：'); failed.forEach((f) => console.log('  ✗', f.name, f.detail)); }
const realErrors = errors.filter((e) => !e.includes('favicon'));
if (realErrors.length) { console.log('\n控制台错误：'); [...new Set(realErrors)].slice(0, 15).forEach((e) => console.log('  ' + e)); }
fs.writeFileSync(path.join(SHOTS, 'round4-report.json'), JSON.stringify({ results, errors }, null, 2));
process.exitCode = failed.length || realErrors.length ? 1 : 0;
