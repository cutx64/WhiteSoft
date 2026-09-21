/**
 * Sticky-note styling + selection action bar regression test.
 *
 * Covers:
 *   - the action bar offers 编辑 for a single text box / sticky note and opens
 *     the inline editor without a double click;
 *   - it offers 便签样式 whenever sticky notes are selected (one or many) and
 *     not for anything else;
 *   - corner rounding, colour and transparency really change the rendering;
 *   - transparency picks a hue without losing the note's alpha, and one slider
 *     gesture is one undo step;
 *   - the per-note fields survive a JSON round-trip (i.e. they are plain data
 *     in the page file).
 *
 * Usage:  node test/sticky.mjs [--chrome <path>]
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

const profileDir = path.join(__dirname, '.chrome-profile-sticky');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const errors = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
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
 * Scene: placed in screen coordinates, so the camera does not matter.
 *   A: maximum rounding        B: square corners
 *   C: 40 % transparent        + one text box and one shape
 * ---------------------------------------------------------------- */
const S = { w: 240, h: 200, ax: 60, bx: 340, cx: 620, y: 90, textY: 360 };
const scene = await page.evaluate(async (S) => {
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  const ed = window.app.editor;
  ed.background.style = 'none';
  const z = ed.camera.zoom;
  const P = (x, y) => ed.screenToWorld(x, y);
  const R = (x, y, w, h) => { const p = P(x, y); return new Rect(p.x, p.y, w / z, h / z); };
  const rect = (x, y, w, h) => { const r = R(x, y, w, h); return { x: r.x, y: r.y, w: r.w, h: r.h }; };

  ed.page.elements = [];
  const round = els.makeSticky({ bounds: R(S.ax, S.y, S.w, S.h).toString(), text: '大圆角', fontSize: 22, radius: 0.5 });
  const square = els.makeSticky({ bounds: R(S.bx, S.y, S.w, S.h).toString(), text: '直角', fontSize: 22, radius: 0 });
  const faded = els.makeSticky({
    bounds: R(S.cx, S.y, S.w, S.h).toString(), text: '半透明', fontSize: 22,
    color: '#66E71125', radius: 0.12,
  });
  const text = els.makeText({ bounds: R(S.ax, S.textY, 400, 60).toString(), text: '文本框', fontSize: 30, textColor: '#FF000000' });
  const shape = els.makePointsElement(200003, {
    stroke: '#FF0169BF', width: 2,
    points: [
      { x: R(450, S.textY, 1, 1).x, y: R(450, S.textY, 1, 1).y },
      { x: R(600, S.textY, 1, 1).x, y: R(450, S.textY, 1, 1).y },
      { x: R(600, S.textY, 1, 1).x, y: R(450, S.textY + 120, 1, 1).y },
      { x: R(450, S.textY, 1, 1).x, y: R(450, S.textY + 120, 1, 1).y },
    ],
    closed: true,
  });
  for (const e of [round, square, faded, text, shape]) ed.addElement(e, { select: false });
  ed.invalidate();
  return { count: ed.page.elements.length };
}, S);
check('测试元素已建立', scene.count === 5, String(scene.count));
await sleep(400);

/** Canvas pixel at a canvas-local CSS position. */
async function pixelAt(x, y) {
  return page.evaluate(({ x, y }) => {
    const c = document.querySelector('#wb-canvas');
    const dpr = window.app.editor.dpr;
    const d = c.getContext('2d').getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, { x, y });
}

/* ---------------------------------------------------------------- *
 * 1. Rendering: rounding and transparency
 * ---------------------------------------------------------------- */
console.log('\n[1] 便签外观');
const near = (a, b, tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const CORNER = 2;                                    // just inside the box corner
const inner = (x) => [x + S.w - 40, S.y + S.h - 40]; // inside, clear of the label text
const cornerRound = await pixelAt(S.ax + CORNER, S.y + CORNER);
const cornerSquare = await pixelAt(S.bx + CORNER, S.y + CORNER);
const midRound = await pixelAt(...inner(S.ax));
const midSquare = await pixelAt(...inner(S.bx));
check('圆角 50% 的角上是页面背景（角被切掉）', cornerRound.every((v) => v > 245), JSON.stringify(cornerRound));
check('圆角 0% 的角仍是便签颜色', near(cornerSquare, [255, 230, 160], 6), JSON.stringify(cornerSquare));
check('两张便签内部都是不透明的便签颜色',
  near(midRound, [255, 230, 160], 6) && near(midSquare, [255, 230, 160], 6),
  `${JSON.stringify(midRound)} / ${JSON.stringify(midSquare)}`);

// 40 % of #E71125 over white paper
const expectFaded = [0.4 * 231 + 0.6 * 255, 0.4 * 17 + 0.6 * 255, 0.4 * 37 + 0.6 * 255].map(Math.round);
const midFaded = await pixelAt(...inner(S.cx));
check('40% 不透明度与白底混合成浅色', near(midFaded, expectFaded, 6),
  `实测 ${JSON.stringify(midFaded)} / 期望 ${JSON.stringify(expectFaded)}`);

/* ---------------------------------------------------------------- *
 * 2. Selection bar adapts to what is selected
 * ---------------------------------------------------------------- */
console.log('\n[2] 操作栏按钮');
const barTitles = () => page.evaluate(() => [...document.querySelectorAll('.wb-selbar .wb-selbtn')].map((b) => b.title));
const selectBy = (spec) => page.evaluate((spec) => {
  const ed = window.app.editor;
  ed.selection.clear();
  const els = ed.page.elements;
  if (spec === 'text') ed.selection.add(els.find((e) => e.type === 300002));
  if (spec === 'sticky') ed.selection.add(els.filter((e) => e.type === 400001)[0]);
  if (spec === 'twoStickies') ed.selection.add(els.filter((e) => e.type === 400001)[0]) === undefined;
  if (spec === 'twoStickies') { ed.selection.add(els.filter((e) => e.type === 400001)[0]); ed.selection.add(els.filter((e) => e.type === 400001)[1]); }
  if (spec === 'stickyAndShape') { ed.selection.add(els.filter((e) => e.type === 400001)[0]); ed.selection.add(els.find((e) => e.type === 200003)); }
  if (spec === 'shape') ed.selection.add(els.find((e) => e.type === 200003));
  if (spec === 'none') ed.selection.clear();
  window.app.ui.syncSelection();
  window.app.ui.selectionBar.update();
}, spec);

await selectBy('text');
let titles = await barTitles();
check('单选文本框：有「编辑」、无便签样式', titles.some((t) => t.startsWith('编辑文字')) && !titles.some((t) => t.startsWith('便签样式')), String(titles.length));

await selectBy('sticky');
titles = await barTitles();
check('单选便签：有「编辑」和「便签样式」',
  titles.some((t) => t.startsWith('编辑便签文字')) && titles.some((t) => t.startsWith('便签样式')), String(titles.length));

await selectBy('twoStickies');
titles = await barTitles();
check('多选便签：有「便签样式」、无「编辑」',
  titles.some((t) => t.includes('已选 2 张')) && !titles.some((t) => t.startsWith('编辑')), String(titles.length));

await selectBy('stickyAndShape');
titles = await barTitles();
check('便签 + 形状：仍可改便签样式、不显示「编辑」',
  titles.some((t) => t.startsWith('便签样式')) && !titles.some((t) => t.startsWith('编辑')), String(titles.length));

await selectBy('shape');
titles = await barTitles();
check('单选形状：两个新按钮都不显示',
  !titles.some((t) => t.startsWith('编辑')) && !titles.some((t) => t.startsWith('便签样式')), String(titles.length));

/* ---------------------------------------------------------------- *
 * 3. The 编辑 button really opens the editor
 * ---------------------------------------------------------------- */
console.log('\n[3] 「编辑」按钮');
await selectBy('text');
await page.evaluate(() => {
  [...document.querySelectorAll('.wb-selbar .wb-selbtn')].find((b) => b.title.startsWith('编辑文字')).click();
});
await sleep(500);
const editText = await page.evaluate(() => ({
  editing: !!window.app.editor.inline.current,
  value: document.querySelector('.wb-inline-textarea')?.value ?? null,
  barHidden: !document.querySelector('.wb-selbar'),
}));
check('文本框：点了就进入编辑，内容在编辑器里',
  editText.editing && editText.value === '文本框', JSON.stringify(editText));
check('编辑期间操作栏自动隐藏', editText.barHidden === true, String(editText.barHidden));
await page.keyboard.press('Escape');
await sleep(400);

await selectBy('sticky');
await page.evaluate(() => {
  [...document.querySelectorAll('.wb-selbar .wb-selbtn')].find((b) => b.title.startsWith('编辑便签文字')).click();
});
await sleep(500);
const editSticky = await page.evaluate(() => ({
  editing: !!window.app.editor.inline.current,
  isSticky: window.app.editor.inline.current?.type === 400001,
}));
check('便签：点了就进入编辑', editSticky.editing && editSticky.isSticky === true, JSON.stringify(editSticky));
await page.keyboard.press('Escape');
await sleep(400);

/* ---------------------------------------------------------------- *
 * 4. The style panel drives rounding / colour / transparency
 * ---------------------------------------------------------------- */
console.log('\n[4] 便签样式面板');
await selectBy('twoStickies');
await page.evaluate(() => {
  [...document.querySelectorAll('.wb-selbar .wb-selbtn')].find((b) => b.title.startsWith('便签样式')).click();
});
await sleep(400);
const panel = await page.evaluate(() => {
  const f = document.querySelector('.wb-flyout');
  return {
    open: !!f,
    title: f?.querySelector('.wb-flyout-title')?.textContent || '',
    labels: [...(f?.querySelectorAll('.wb-slider-label') || [])].map((n) => n.textContent),
    swatches: f?.querySelectorAll('.wb-swatch').length || 0,
  };
});
check('样式面板包含颜色 / 透明度 / 圆角',
  panel.open && panel.title === '便签样式' && panel.labels.join(',') === '透明度,圆角' && panel.swatches === 12,
  JSON.stringify(panel));

const setSlider = (index, value) => page.evaluate(({ index, value }) => {
  const input = document.querySelectorAll('.wb-flyout input[type=range]')[index];
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, { index, value });

const stickyState = () => page.evaluate(() => window.app.editor.page.elements
  .filter((e) => e.type === 400001)
  .map((e) => ({ radius: e.radius, alpha: parseInt(String(e.color).replace('#', '').slice(0, 2), 16), hex: String(e.color).toUpperCase() })));

const before = await stickyState();
const radiusBefore = before[0].radius;
await setSlider(1, 40);           // 圆角 slider (second row)
await sleep(300);
let state = await stickyState();
check('圆角滑块只改写所选便签（2 张，未选的保持 0.12）',
  Math.abs(state[0].radius - 0.4) < 1e-6 && Math.abs(state[1].radius - 0.4) < 1e-6
  && Math.abs(state[2].radius - 0.12) < 1e-6,
  JSON.stringify(state.map((s) => s.radius)));

await setSlider(0, 40);           // 透明度 slider (first row)
await sleep(300);
state = await stickyState();
check('透明度滑块只改写所选便签（写进颜色 alpha）',
  state.slice(0, 2).every((s) => Math.abs(s.alpha - 102) <= 2) && state[2].alpha === 102,
  JSON.stringify(state.map((s) => s.alpha)));

// picking a palette colour keeps the transparency the note already had
await page.evaluate(() => {
  const sw = document.querySelectorAll('.wb-flyout .wb-swatch');
  sw[sw.length - 1].click();      // last note colour
});
await sleep(300);
state = await stickyState();
check('换颜色时保留透明度',
  state.slice(0, 2).every((s) => s.alpha >= 98 && s.alpha <= 106 && s.hex.endsWith('B6B6B6')),
  state.map((s) => s.hex).join(' '));

const undoLabel = await page.evaluate(() => window.app.editor.history.undoLabel);
await page.evaluate(() => window.app.undo());
await sleep(400);
const afterUndo = await stickyState();
check('一次拖动 = 一步撤销（撤销回到换色之前，圆角与透明度保留）',
  undoLabel === '便签样式' && afterUndo[0].hex.endsWith('FFE6A0')
  && Math.abs(afterUndo[0].radius - 0.4) < 1e-6 && Math.abs(afterUndo[0].alpha - 102) <= 2,
  `undoLabel=${undoLabel}, ${JSON.stringify(afterUndo[0])} (radius was ${radiusBefore})`);

// With the selection cleared the canvas shows the notes without selection
// chrome, so the two effects can be verified on the pixels themselves.
await page.evaluate(() => {
  const ed = window.app.editor;
  ed.selection.clear();
  window.app.ui.syncSelection();
  ed.invalidate();
  ed.draw();
});
await sleep(400);
const stillRound = await pixelAt(S.ax + CORNER, S.y + CORNER);
const fadedNow = await pixelAt(...inner(S.ax));
const blended = [0.4 * 255 + 0.6 * 255, 0.4 * 230 + 0.6 * 255, 0.4 * 160 + 0.6 * 255].map(Math.round);
check('圆角改动反映到画布（原先的直角位置现在是背景）',
  stillRound.every((v) => v > 245), JSON.stringify(stillRound));
check('透明度改动反映到画布（纸面与白底混合）', near(fadedNow, blended, 6),
  `实测 ${JSON.stringify(fadedNow)} / 期望 ${JSON.stringify(blended)}`);

/* ---------------------------------------------------------------- *
 * 5. The new fields are plain page data
 * ---------------------------------------------------------------- */
console.log('\n[5] 存储字段');
const roundTrip = await page.evaluate(() => {
  const el = window.app.editor.page.elements.filter((e) => e.type === 400001)[0];
  const copy = JSON.parse(JSON.stringify(el));
  return {
    color: copy.color === el.color, radius: copy.radius === el.radius,
    keys: Object.keys(copy).sort().join(','),
  };
});
check('color / radius 是可直接写进 .note 的普通字段',
  roundTrip.color && roundTrip.radius && roundTrip.keys.includes('radius'),
  roundTrip.keys);

await page.evaluate(() => {
  const ed = window.app.editor;
  ed.selection.clear();
  ed.invalidate();
  ed.draw();
});
await sleep(300);
await page.screenshot({ path: path.join(SHOTS, 'sticky-style.png') });
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
