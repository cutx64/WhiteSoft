/**
 * Full-spectrum colour picker regression test.
 *
 * Every place that asks for a colour must offer the same control: the context
 * palette plus a picker that unfolds underneath it — saturation/value square,
 * hue strip, an alpha strip only where transparency is not already owned by a
 * separate slider, a hex field, and a live preview.  Colours travel through the
 * app as `#AARRGGBB`, so that is what the elements must end up with.
 *
 * Usage:  node test/colorpicker.mjs [--chrome <path>] [--url http://127.0.0.1:8813/]
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

const profileDir = path.join(__dirname, '.chrome-profile-colorpicker');
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
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-crashpad', '--window-size=1400,950'],
  defaultViewport: { width: 1400, height: 950 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await sleep(1300);
check('应用启动', await page.$('#wb-canvas') !== null);

/** Open a tool's flyout through its real toolbar button and describe the field. */
const openTool = (tool) => page.evaluate(async (name) => {
  const btn = document.querySelector(`.wb-toolbar button[data-tool="${name}"]`)
    || [...document.querySelectorAll('.wb-toolbar button')].find((b) => (b.title || '').startsWith(name));
  if (!btn) return { error: 'no button ' + name };
  btn.click();
  await new Promise((r) => setTimeout(r, 250));
  const flyout = document.querySelector('.wb-flyout');
  if (!flyout) return { error: 'no flyout' };
  const hasToggle = !!flyout.querySelector('.wb-color-toggle');
  if (hasToggle) flyout.querySelector('.wb-color-toggle').click();
  await new Promise((r) => setTimeout(r, 220));
  const picker = flyout.querySelector('.wb-picker');
  return {
    title: flyout.querySelector('.wb-flyout-title')?.textContent || '',
    swatches: flyout.querySelectorAll('.wb-swatch').length,
    nativeInputs: flyout.querySelectorAll('input[type=color]').length,
    hasToggle,
    area: !!picker?.querySelector('.wb-picker-area'),
    hue: !!picker?.querySelector('.wb-picker-hue'),
    alpha: !!picker?.querySelector('.wb-picker-alpha'),
    hex: picker?.querySelector('.wb-picker-hex')?.value || null,
    labels: [...flyout.querySelectorAll('.wb-flyout-label')].map((n) => n.textContent),
  };
}, tool);
const closeFlyout = () => page.evaluate(() => window.app.ui.closeFlyout());

/* ---------------------------------------------------------------- *
 * 1. The picker is everywhere a colour is chosen
 * ---------------------------------------------------------------- */
console.log('\n[1] 每个取色处都有全色系调色盘');
for (const [label, tool, wantAlpha] of [
  ['笔', 'pen', false],
  ['荧光笔', 'highlighter', false],
  ['形状', 'shape', false],
  ['文本', 'text', false],
  ['便签', 'sticky', true],
]) {
  const info = await openTool(tool);
  check(`${label}：预设 + 自定义调色盘（${wantAlpha ? '含' : '不含'}不透明度）`,
    info.area === true && info.hue === true && info.swatches >= 12
    && info.alpha === wantAlpha && info.nativeInputs === 0,
    JSON.stringify(info));
  await closeFlyout();
  await sleep(120);
}

const bg = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('.wb-toolbar button')].find((b) => (b.title || '').startsWith('画布背景'));
  btn.click();
  await new Promise((r) => setTimeout(r, 250));
  const flyout = document.querySelector('.wb-flyout');
  flyout.querySelector('.wb-color-toggle').click();
  await new Promise((r) => setTimeout(r, 220));
  const picker = flyout.querySelector('.wb-picker');
  return {
    area: !!picker?.querySelector('.wb-picker-area'),
    hex: picker?.querySelector('.wb-picker-hex')?.value,
    native: flyout.querySelectorAll('input[type=color]').length,
  };
});
check('画布背景：自定义调色盘（并去掉了系统取色器）',
  bg.area === true && bg.native === 0 && /^#[0-9A-F]{6}$/.test(bg.hex || ''), JSON.stringify(bg));
await closeFlyout();

const shapeFill = await page.evaluate(async () => {
  const ui = window.app.ui;
  const ed = window.app.editor;
  ed.shapeStyle.filled = false;
  ui.openShapeFlyout(ui.toolButtons.shape);
  await new Promise((r) => setTimeout(r, 200));
  const before = [...document.querySelectorAll('.wb-flyout .wb-flyout-label')].map((n) => n.textContent);
  const fillToggle = [...document.querySelectorAll('.wb-flyout .wb-toggle')].find((b) => b.textContent === '填充');
  fillToggle.click();
  await new Promise((r) => setTimeout(r, 150));
  ui.openShapeFlyout(ui.toolButtons.shape);       // re-opened with the toggle on
  await new Promise((r) => setTimeout(r, 200));
  const after = [...document.querySelectorAll('.wb-flyout .wb-flyout-label')].map((n) => n.textContent);
  return { before, after, fields: document.querySelectorAll('.wb-flyout .wb-field').length };
});
check('形状：打开填充后多出一条「填充颜色」的全色系调色盘',
  !shapeFill.before.some((l) => l.includes('填充颜色'))
  && shapeFill.after.some((l) => l.includes('填充颜色'))
  && shapeFill.fields >= 2,
  JSON.stringify(shapeFill));
await closeFlyout();

/* ---------------------------------------------------------------- *
 * 2. Picking colours actually changes things
 * ---------------------------------------------------------------- */
console.log('\n[2] 取色真的生效');
const dragArea = (fx, fy) => page.evaluate(async ({ fx, fy }) => {
  const area = document.querySelector('.wb-flyout .wb-picker-area');
  const r = area.getBoundingClientRect();
  const x = r.left + r.width * fx, y = r.top + r.height * fy;
  const opts = { bubbles: true, pointerId: 1, clientX: x, clientY: y };
  area.dispatchEvent(new PointerEvent('pointerdown', opts));
  area.dispatchEvent(new PointerEvent('pointermove', opts));
  area.dispatchEvent(new PointerEvent('pointerup', opts));
  await new Promise((r2) => setTimeout(r2, 150));
  return document.querySelector('.wb-flyout .wb-picker-hex').value;
}, { fx, fy });

const penPick = await page.evaluate(async () => {
  const ui = window.app.ui;
  const ed = window.app.editor;
  ed.pen.inkGradient = null;
  ui.openPenFlyout(ui.toolButtons.pen, false);
  await new Promise((r) => setTimeout(r, 200));
  document.querySelector('.wb-flyout .wb-color-toggle').click();
  await new Promise((r) => setTimeout(r, 200));
  return { before: ed.pen.color };
});
const hexA = await dragArea(0.9, 0.12);
const penAfter = await page.evaluate(() => ({ color: window.app.editor.pen.color, gradient: window.app.editor.pen.inkGradient }));
check('笔：在色板上拖动即改变笔色（#AARRGGBB）',
  /^#[0-9A-F]{6}$/.test(hexA) && penAfter.color === `#FF${hexA.slice(1)}` && penAfter.gradient === null,
  JSON.stringify({ ...penPick, hexA, penAfter }));

const hue = await page.evaluate(async () => {
  const input = document.querySelector('.wb-flyout .wb-picker-hue');
  input.value = '210';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  return { hex: document.querySelector('.wb-flyout .wb-picker-hex').value, color: window.app.editor.pen.color };
});
check('色相条改变色相', /^#[0-9A-F]{6}$/.test(hue.hex) && hue.hex.slice(1, 3) !== hexA.slice(1, 3), JSON.stringify(hue));

const typed = await page.evaluate(async () => {
  const input = document.querySelector('.wb-flyout .wb-picker-hex');
  input.value = '#3C7A5B';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  return { color: window.app.editor.pen.color, hex: document.querySelector('.wb-flyout .wb-picker-hex').value };
});
check('十六进制输入框精确取色', typed.color === '#FF3C7A5B', JSON.stringify(typed));
await page.screenshot({ path: path.join(SHOTS, 'colorpicker.png') });
await closeFlyout();

const sticky = await page.evaluate(async () => {
  const ui = window.app.ui;
  const ed = window.app.editor;
  const els = await import('/js/elements.js');
  ed.page.elements = [];
  const note = els.makeSticky({ bounds: '120,160,260,200', text: '便签', fontSize: 22, color: '#FFE71125' });
  ed.addElement(note, { select: true });
  ed.setTool('select');
  ui.openStickyFlyout(ui.toolButtons.sticky);    // the sticky tool's own colour field
  await new Promise((r) => setTimeout(r, 250));
  const hexBefore = window.getComputedStyle(document.querySelector('.wb-flyout .wb-swatch')).backgroundColor;
  document.querySelector('.wb-flyout .wb-color-toggle').click();
  await new Promise((r) => setTimeout(r, 220));
  const alphaShown = !!document.querySelector('.wb-flyout .wb-picker-alpha');
  const input = document.querySelector('.wb-flyout .wb-picker-hex');
  input.value = '#12C4A0';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const after = ed.doc.pages[0].elements[0].color;
  return { hexBefore, alphaShown, after, noteColor: note.color };
});
check('便签：调色盘带不透明度，新颜色写进便签的 #AARRGGBB',
  sticky.alphaShown === true && /^#[0-9A-F]{8}$/i.test(sticky.after)
  && sticky.after.slice(3).toUpperCase() === '12C4A0',
  JSON.stringify(sticky));
await page.evaluate(() => { window.app.editor.clearSelection(); window.app.ui.closeFlyout(); });

/* ---------------------------------------------------------------- *
 * 3. The selection bar's picker: live painting, one undo step
 * ---------------------------------------------------------------- */
console.log('\n[3] 操作栏改色：边拖边看，只记一步撤销');
const bar = await page.evaluate(async () => {
  const ed = window.app.editor;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  ed.page.elements = [];
  const s1 = els.makePointsElement(els.T.RECT, {
    stroke: '#FF1F1F1F', width: 3, closed: true,
    points: [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }],
  });
  const s2 = els.makePointsElement(els.T.ELLIPSE, {
    stroke: '#FF1F1F1F', width: 3, closed: true,
    points: [{ x: 400, y: 100 }, { x: 600, y: 250 }],
  });
  void Rect;
  ed.addElements([s1, s2], { select: true });
  ed.setTool('select');
  await new Promise((r) => setTimeout(r, 250));
  const btn = document.querySelector('.wb-selbar button[title="改变颜色"]');
  btn.click();
  await new Promise((r) => setTimeout(r, 250));
  const pop = document.querySelector('.wb-selpopover');
  return {
    popover: !!pop,
    swatches: pop?.querySelectorAll('.wb-swatch').length ?? 0,
    picker: !!pop?.querySelector('.wb-picker'),
    undoBefore: ed.history.canUndo,
  };
});
check('操作栏的颜色面板里也有全色系调色盘',
  bar.popover === true && bar.swatches >= 12 && bar.picker === true, JSON.stringify(bar));

const painted = await page.evaluate(async () => {
  const area = document.querySelector('.wb-selpopover .wb-picker-area');
  const r = area.getBoundingClientRect();
  const at = (fx) => ({ bubbles: true, pointerId: 3, clientX: r.left + r.width * fx, clientY: r.top + r.height * 0.5 });
  const ed = window.app.editor;
  area.dispatchEvent(new PointerEvent('pointerdown', at(0.85)));
  area.dispatchEvent(new PointerEvent('pointermove', at(0.6)));
  const midway = ed.page.elements.map((e) => e.stroke);
  const undoMidway = ed.history.undoLabel;
  area.dispatchEvent(new PointerEvent('pointerup', at(0.6)));
  await new Promise((r2) => setTimeout(r2, 200));
  return {
    midway,
    undoMidway,
    after: ed.page.elements.map((e) => e.stroke),
    undoLabel: ed.history.undoLabel,
  };
});
check('拖动时两个对象都跟着变色，但中途不写历史',
  new Set(painted.midway).size === 1 && painted.midway[0] !== '#FF1F1F1F' && painted.undoMidway !== '修改颜色',
  JSON.stringify(painted));
check('松手后只记一步「修改颜色」',
  painted.undoLabel === '修改颜色'
  && new Set(painted.after).size === 1 && painted.after[0] === painted.midway[0],
  JSON.stringify(painted));

const undone = await page.evaluate(async () => {
  const ed = window.app.editor;
  window.app.undo();
  await new Promise((r) => setTimeout(r, 250));
  return ed.page.elements.map((e) => e.stroke);
});
check('一次撤销把两个对象一起还原',
  undone.length === 2 && undone.every((c) => c === '#FF1F1F1F'), JSON.stringify(undone));

const preset = await page.evaluate(async () => {
  const ed = window.app.editor;
  ed.selection.clear();
  for (const e of ed.page.elements) ed.selection.add(e);
  ed.onSelectionChange?.();
  await new Promise((r) => setTimeout(r, 250));
  const btn = document.querySelector('.wb-selbar button[title="改变颜色"]');
  btn.click();
  await new Promise((r) => setTimeout(r, 250));
  const swatch = [...document.querySelectorAll('.wb-selpopover .wb-swatch')][4];
  swatch.click();
  await new Promise((r) => setTimeout(r, 250));
  return { colors: ed.page.elements.map((e) => e.stroke) };
});
check('预设色板照旧可用（点击即改色）',
  new Set(preset.colors).size === 1 && preset.colors[0] !== '#FF1F1F1F', JSON.stringify(preset));

/* ---------------------------------------------------------------- *
 * 3b. Gradients: the library, the live indicator, and the rendering
 * ---------------------------------------------------------------- */
console.log('\n[3b] 渐变色');
const gradients = await page.evaluate(async () => {
  const { GRADIENTS } = await import('/js/elements.js');
  const ui = window.app.ui;
  const ed = window.app.editor;
  ed.pens[0].inkGradient = null;
  ed.pens[0].color = '#FF1F1F1F';
  ed.activePen = 0;
  ed.selection.clear();
  ed.page.elements = [];
  ui.openPenFlyout(ui.toolButtons.pen, false);
  await new Promise((r) => setTimeout(r, 250));
  const dot = () => document.querySelector('.wb-penslot-dot[data-pen-dot="0"]').style.background;
  const before = dot();
  const buttons = document.querySelectorAll('.wb-gradient[data-gradient]').length;
  document.querySelector('.wb-gradient[data-gradient="plasma"]').click();
  await new Promise((r) => setTimeout(r, 200));
  const afterGradient = dot();
  const active = document.querySelector('.wb-gradient.active')?.dataset.gradient;
  // …and picking a plain colour right afterwards must switch the indicator back
  document.querySelector('.wb-color-toggle').click();
  await new Promise((r) => setTimeout(r, 200));
  const hex = document.querySelector('.wb-picker-hex');
  hex.value = '#3C7A5B';
  hex.dispatchEvent(new Event('input', { bubbles: true }));
  hex.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  return {
    ids: GRADIENTS.map((g) => g.id),
    names: GRADIENTS.map((g) => g.name),
    buttons,
    before,
    afterGradient,
    afterColor: dot(),
    active,
    activeAfterColor: document.querySelector('.wb-gradient.active')?.dataset.gradient || null,
    pen: { color: ed.pen.color, gradient: ed.pen.inkGradient },
  };
});
check('渐变笔有十多种（含 matplotlib 配色：viridis/plasma/inferno/turbo…）',
  gradients.ids.length >= 12
  && ['viridis', 'plasma', 'inferno', 'magma', 'turbo', 'jet', 'coolwarm'].every((id) => gradients.ids.includes(id))
  && gradients.buttons === gradients.ids.length,
  JSON.stringify({ n: gradients.ids.length, names: gradients.names.slice(0, 6) }));
check('选渐变色后笔 1 的指示色立刻变成该渐变（不用重开面板）',
  gradients.before.startsWith('rgb(') && gradients.afterGradient.includes('linear-gradient')
  && gradients.active === 'plasma',
  JSON.stringify({ before: gradients.before, after: gradients.afterGradient, active: gradients.active }));
check('之后选普通颜色，指示色与高亮也跟着回退',
  /^rgb\(/.test(gradients.afterColor) && gradients.activeAfterColor === null
  && gradients.pen.gradient === null && gradients.pen.color === '#FF3C7A5B',
  JSON.stringify({ after: gradients.afterColor, activeAfter: gradients.activeAfterColor, pen: gradients.pen }));
await closeFlyout();

// the stroke really uses the colormap: its two ends differ, and they match the
// first and last stop of the gradient
const rendered = await page.evaluate(async () => {
  const ed = window.app.editor;
  const els = await import('/js/elements.js');
  ed.page.elements = [];
  // draw across the visible viewport, so both ends can be sampled on screen
  const y = ed.view.h / 2;
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const s = ed.screenToWorld(80 + (i / 40) * (ed.view.w - 160), y);
    pts.push(s);
  }
  const ink = els.makeInk({ stroke: '#FF1F1F1F', width: 16, points: pts });
  ink.inkGradient = 'plasma';
  ed.addElement(ink, { select: false });
  ed.invalidate(); ed.requestRender();
  await new Promise((r) => setTimeout(r, 700));
  const canvas = document.querySelector('#wb-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = ed.dpr;
  const sample = (sx, sy) => {
    const d = ctx.getImageData(Math.round(sx * dpr), Math.round(sy * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const stops = els.gradientById('plasma').stops;
  const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const near = (a, b, tol = 70) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const left = sample(110, y);
  const right = sample(ed.view.w - 110, y);
  return {
    left,
    right,
    firstStop: hexToRgb(stops[0]),
    lastStop: hexToRgb(stops[stops.length - 1]),
    startsAtFirstStop: near(left, hexToRgb(stops[0])),
    endsAtLastStop: near(right, hexToRgb(stops[stops.length - 1])),
  };
});
check('渐变笔画出来真的是渐变（两端颜色不同，且首尾对应该色带的两端）',
  rendered.left.join() !== rendered.right.join()
  && rendered.endsAtLastStop === true && rendered.startsAtFirstStop === true,
  JSON.stringify(rendered));

/* ---------------------------------------------------------------- *
 * 4. Keyboard control and persistence
 * ---------------------------------------------------------------- */
console.log('\n[4] 键盘微调与保存');
const keys = await page.evaluate(async () => {
  const ui = window.app.ui;
  const ed = window.app.editor;
  ed.pen.color = '#FF808080';
  ui.openPenFlyout(ui.toolButtons.pen, false);
  await new Promise((r) => setTimeout(r, 200));
  document.querySelector('.wb-flyout .wb-color-toggle').click();
  await new Promise((r) => setTimeout(r, 220));
  const area = document.querySelector('.wb-flyout .wb-picker-area');
  area.focus();
  const start = ed.pen.color;
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  return { start, now: ed.pen.color, hex: document.querySelector('.wb-flyout .wb-picker-hex').value };
});
check('方向键可以微调颜色（可键盘操作）',
  keys.now !== keys.start && /^#[0-9A-F]{6}$/.test(keys.hex), JSON.stringify(keys));
await closeFlyout();

const roundTrip = await page.evaluate(async () => {
  const ed = window.app.editor;
  const els = await import('/js/elements.js');
  ed.page.elements = [];
  ed.addElement(els.makePointsElement(els.T.RECT, {
    stroke: '#FF3C7A5B', width: 3, closed: true,
    points: [{ x: 80, y: 80 }, { x: 300, y: 80 }, { x: 300, y: 240 }, { x: 80, y: 240 }],
  }), { select: false });
  const { noteBlob } = await import('/js/document.js');
  const blob = await noteBlob(ed.doc, {});
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { ZipReader } = await import('/js/zipread.js');
  const zip = await ZipReader.open(new Blob([bytes]));
  const page1 = await zip.json('Pages/page1.json');
  return { stroke: page1.elements[0].stroke };
});
check('自定义颜色按 #AARRGGBB 存进 .note（Whiteboard 也认）',
  roundTrip.stroke === '#FF3C7A5B', JSON.stringify(roundTrip));

await page.evaluate(() => { window.app.editor.clearSelection(); window.app.ui.closeFlyout(); });
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
