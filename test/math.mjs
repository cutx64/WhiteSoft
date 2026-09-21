/**
 * LaTeX (MathJax) regression test for text boxes and sticky notes.
 *
 * Drives the real application in headless Chromium: types `$…$` into a text
 * box, checks that the canvas really draws a typeset formula (and not the raw
 * source), that the atom drives the layout, that display math gets its own
 * line, that prose with dollar signs is left alone, that nothing but the DOM
 * editor paints a text element while it is being edited (no ghosting), and
 * that everything stays offline and error-free.
 *
 * Usage:  node test/math.mjs [--chrome <path>]
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

const profileDir = path.join(__dirname, '.chrome-profile-math');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const errors = [];
const external = [];
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
page.on('requestfailed', (r) => { if (!r.url().includes('favicon')) errors.push('requestfailed: ' + r.url()); });
page.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith(URL_BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
});

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await sleep(1200);
check('应用启动', await page.$('#wb-canvas') !== null);

/* ---------------------------------------------------------------- *
 * 1. Delimiter parsing
 * ---------------------------------------------------------------- */
console.log('\n[1] 分隔符解析');
const parse = await page.evaluate(async () => {
  const m = await import('/js/mathtext.js');
  const kind = (t) => m.parseMathRuns(t).map((r) => (r.type === 'math' ? (r.display ? 'D' : 'M') : 't')).join('');
  return {
    inline: kind('行内 $x^2$ 结束'),
    display: kind('前 $$\\int_0^1 x\\,dx$$ 后'),
    texParen: kind('a \\(y\\) b'),
    texBracket: kind('a \\[y\\] b'),
    prices: kind('价格 $5 与 $6 都不是公式'),
    escaped: kind('转义 \\$9.99 保持原样'),
    lone: kind('单个 $ 符号'),
    multi: m.parseMathRuns('$a$ 和 $b$').filter((r) => r.type === 'math').length,
    plain: m.hasMathSyntax('没有公式的一段话'),
    rich: m.hasMathSyntax('有 $x$ 的一段话'),
  };
});
check('行内 $…$', parse.inline === 'tMt', parse.inline);
check('独立 $$…$$', parse.display === 'tDt', parse.display);
check('\\(…\\) 与 \\[…\\]', parse.texParen === 'tMt' && parse.texBracket === 'tDt', `${parse.texParen} / ${parse.texBracket}`);
check('普通文本里的 $ 不误判', parse.prices === 't' && parse.lone === 't', `${parse.prices} / ${parse.lone}`);
check('转义 \\$ 保持字面量', parse.escaped === 't', parse.escaped);
check('同一段可含多个公式', parse.multi === 2, String(parse.multi));
check('hasMathSyntax 快速判定', parse.plain === false && parse.rich === true, `${parse.plain} / ${parse.rich}`);

/* ---------------------------------------------------------------- *
 * 2. Scene: elements are placed in *screen* coordinates so the test does
 *    not depend on where the camera happens to start.
 * ---------------------------------------------------------------- */
console.log('\n[2] 画布渲染');
const scene = await page.evaluate(async () => {
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  const ed = window.app.editor;
  ed.background.style = 'none';
  const z = ed.camera.zoom;
  const P = (x, y) => ed.screenToWorld(x, y);
  const R = (x, y, w, h) => { const p = P(x, y); return new Rect(p.x, p.y, w / z, h / z); };
  const rect = (x, y, w, h) => { const r = R(x, y, w, h); return { x: r.x, y: r.y, w: r.w, h: r.h }; };

  ed.page.elements = [];
  // A: typeset math.  B: the same characters escaped, i.e. literal text.
  const math = els.makeText({ bounds: R(60, 60, 620, 60).toString(), text: '$x^2+y^2$', fontSize: 36, textColor: '#FF000000' });
  const literal = els.makeText({ bounds: R(60, 150, 620, 60).toString(), text: '\\$x^2+y^2\\$', fontSize: 36, textColor: '#FF000000' });
  const broken = els.makeText({ bounds: R(60, 240, 620, 60).toString(), text: '$\\frac{1}{$', fontSize: 32, textColor: '#FF000000' });
  const display = els.makeText({ bounds: R(60, 330, 620, 160).toString(), text: '上式\n$$\\sum_{n=1}^{\\infty}\\frac{1}{n^2}$$', fontSize: 26, textColor: '#FF000000' });
  const sticky = els.makeSticky({ bounds: R(700, 60, 420, 220).toString(), text: '便签 $\\frac{a}{b}$ 公式', fontSize: 26 });
  // A table: its cells are edited by DOM contenteditable nodes, so they must
  // not be painted on the canvas either while the table editor is open.
  const table = els.makeTable({ bounds: R(700, 330, 420, 150).toString(), rows: 2, cols: 2, cellW: 210, cellH: 75 });
  table.cells = [['表格', 'ghost'], ['AB', 'CD']];

  for (const e of [math, literal, broken, display, sticky, table]) ed.addElement(e, { select: false });
  ed.invalidate();
  return {
    count: ed.page.elements.length,
    boxes: {
      mathText: rect(60, 60, 620, 60),
      plainText: rect(60, 150, 620, 60),
      broken: rect(60, 240, 620, 60),
      sticky: rect(700, 60, 420, 220),
      table: rect(700, 330, 420, 150),
    },
  };
});
check('测试元素已建立', scene.count === 6, String(scene.count));
const BOX = scene.boxes;

// Wait for MathJax + the SVG bitmaps.
await page.waitForFunction(async () => {
  const m = await import('/js/mathtext.js');
  const s = m.mathStats();
  return s.loaded && s.pending === 0 && s.rasters >= 4;
}, { timeout: 60000 }).catch(() => {});
await sleep(600);

const stats = await page.evaluate(async () => (await import('/js/mathtext.js')).mathStats());
check('MathJax 已加载（本地 vendored）', stats.loaded === true, `v${stats.version}`);
check('公式已排版并栅格化', stats.expressions >= 4 && stats.rasters >= 4, JSON.stringify(stats));
check('全程无外部网络请求', external.length === 0, external.slice(0, 3).join(' | ') || 'none');

/** Ink bounding box of a world-space rectangle, in device pixels. */
async function inkBox(world) {
  return page.evaluate((w) => {
    const ed = window.app.editor;
    const c = document.querySelector('#wb-canvas');
    const ctx = c.getContext('2d');
    const dpr = ed.dpr;
    const a = ed.worldToScreen(w.x, w.y);
    const b = ed.worldToScreen(w.x + w.w, w.y + w.h);
    const x0 = Math.max(0, Math.floor(a.x * dpr)), y0 = Math.max(0, Math.floor(a.y * dpr));
    const x1 = Math.min(c.width, Math.ceil(b.x * dpr)), y1 = Math.min(c.height, Math.ceil(b.y * dpr));
    const img = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, ink = 0, dark = 0;
    const w0 = x1 - x0;
    for (let i = 0; i < img.length; i += 4) {
      const r = img[i], g = img[i + 1], bl = img[i + 2];
      // `dark` isolates black-ish text from a coloured sticky note or a grid.
      if (Math.max(r, g, bl) < 120) dark++;
      // count anything clearly darker than white paper
      if (r < 235 || g < 235 || bl < 235) {
        const px = (i / 4) % w0, py = Math.floor((i / 4) / w0);
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
        ink++;
      }
    }
    const zoomDpr = ed.camera.zoom * dpr;
    return ink
      ? { ink, dark, w: (maxX - minX + 1) / zoomDpr, h: (maxY - minY + 1) / zoomDpr }
      : { ink: 0, dark, w: 0, h: 0 };
  }, world);
}

const atom = await page.evaluate(async () => {
  const m = await import('/js/mathtext.js');
  const els = await import('/js/elements.js');
  const c = document.createElement('canvas').getContext('2d');
  c.font = els.fontString(36, {});
  const a = m.mathAtom('x^2+y^2', false, c, 36, {}, 1);
  return { w: a.w, h: a.h, literal: c.measureText('$x^2+y^2$').width };
});

const mathInk = await inkBox(BOX.mathText);
const litInk = await inkBox(BOX.plainText);
check('公式画出了内容', mathInk.dark > 200, JSON.stringify(mathInk));
check('公式宽度取自 MathJax 度量（而非源码宽度）',
  Math.abs(mathInk.w - atom.w) < atom.w * 0.12,
  `绘制 ${mathInk.w.toFixed(1)} / 度量 ${atom.w.toFixed(1)} / 源码 ${atom.literal.toFixed(1)}`);
check('同一串字符转义后按字面量渲染，宽度不同',
  Math.abs(litInk.w - mathInk.w) > 4 && litInk.dark > 100,
  `字面量 ${litInk.w.toFixed(1)} vs 公式 ${mathInk.w.toFixed(1)}`);

/* ---------------------------------------------------------------- *
 * 3. Display math, sticky notes, broken TeX
 * ---------------------------------------------------------------- */
console.log('\n[3] 独立公式 / 便签 / 坏公式');
const stickyInk = await inkBox(BOX.sticky);
check('便签里的公式已渲染', stickyInk.dark > 100, JSON.stringify(stickyInk));

const displayLines = await page.evaluate(async () => {
  const m = await import('/js/mathtext.js');
  const els = await import('/js/elements.js');
  const c = document.createElement('canvas').getContext('2d');
  c.font = els.fontString(24, {});
  const lines = m.layoutRichText(c, '上式\n$$\\sum_{n=1}^{\\infty}\\frac{1}{n^2}$$', 24, 640, {});
  const trailing = m.layoutRichText(c, '带换行的一段\n', 24, 640, {});
  return { lines: lines.map((l) => l.items.map((it) => it.kind).join('+')), trailing: trailing.length };
});
check('独立公式单独占行', displayLines.lines.length === 2 && displayLines.lines[1] === 'math', JSON.stringify(displayLines.lines));
check('普通换行仍保留空行', displayLines.trailing === 2, String(displayLines.trailing));

const brokenInk = await inkBox(BOX.broken);
check('坏公式不崩溃且有可见输出', brokenInk.dark > 50, JSON.stringify(brokenInk));

/* ---------------------------------------------------------------- *
 * 4. Caching: redraws must not re-typeset
 * ---------------------------------------------------------------- */
console.log('\n[4] 缓存');
const before = await page.evaluate(async () => (await import('/js/mathtext.js')).mathStats());
const camera0 = await page.evaluate(() => ({ ...window.app.editor.camera }));
await page.evaluate(async () => {
  const ed = window.app.editor;
  for (let i = 0; i < 4; i++) {
    ed.camera.zoom = 0.8 + i * 0.05;
    ed.invalidate();
    ed.draw();
  }
});
await sleep(800);
// restore the view the other measurements were taken in
await page.evaluate((c) => {
  const ed = window.app.editor;
  Object.assign(ed.camera, c);
  ed.invalidate();
  ed.draw();
}, camera0);
await sleep(400);
const after = await page.evaluate(async () => (await import('/js/mathtext.js')).mathStats());
check('反复重绘不重复排版', after.expressions === before.expressions, `${before.expressions} → ${after.expressions}`);
check('位图按需分档缓存', after.rasters >= before.rasters, `${before.rasters} → ${after.rasters} rasters`);

/* ---------------------------------------------------------------- *
 * 5. Editing owns the text: the canvas must not paint a second copy
 * ---------------------------------------------------------------- */
console.log('\n[5] 编辑态不重影');
// While an element is open in the DOM inline editor the canvas must not paint
// its text: the transparent textarea sits right on top, and a second copy
// underneath shows through as ghosting (DOM and canvas rasterise differently).
const findEl = {
  mathText: '$x^2+y^2$',
  plainText: '\\$x^2+y^2\\$',
  sticky: '便签 $\\frac{a}{b}$ 公式',
  table: null, // looked up by type
};

const idleInk = {};
for (const [k, b] of Object.entries(BOX)) idleInk[k] = await inkBox(b);
check('静止时四类元素都有文字',
  idleInk.mathText.dark > 200 && idleInk.plainText.dark > 200
  && idleInk.sticky.dark > 100 && idleInk.table.dark > 100,
  JSON.stringify(idleInk));

const editState = {};
for (const k of Object.keys(BOX)) {
  const entered = await page.evaluate(({ kind, text }) => {
    const ed = window.app.editor;
    ed.inline.commit();
    const el = kind === 'table'
      ? ed.page.elements.find((e) => e.type === 400002)
      : ed.page.elements.find((e) => e.text === text);
    if (!el) throw new Error('test element vanished: ' + kind);
    ed.editElement(el, {});
    ed.draw();
    return { isEditing: ed.inline?.current === el, kind: el.type };
  }, { kind: k, text: findEl[k] });
  await sleep(500);
  editState[k] = { ...entered, ...(await inkBox(BOX[k])) };
  // leave the editor before measuring the next element
  await page.evaluate(() => { window.app.editor.inline.commit(); window.app.editor.draw(); });
  await sleep(300);
}

check('编辑数学文本框时画布不再绘制文字（无重影）',
  editState.mathText.isEditing && editState.mathText.dark === 0,
  `dark ${idleInk.mathText.dark} → ${editState.mathText.dark}`);
check('编辑纯文本框时同样无重影',
  editState.plainText.dark === 0, `dark ${idleInk.plainText.dark} → ${editState.plainText.dark}`);
check('编辑便签时：文字不重影、纸张仍在',
  editState.sticky.dark === 0 && editState.sticky.ink > idleInk.sticky.ink * 0.9,
  `dark ${idleInk.sticky.dark} → ${editState.sticky.dark}，纸面 ${idleInk.sticky.ink} → ${editState.sticky.ink}`);
check('编辑表格时：单元格文字不重影、网格仍在',
  editState.table.dark === 0 && editState.table.ink > 0,
  `dark ${idleInk.table.dark} → ${editState.table.dark}，网格 ${editState.table.ink}`);

// ...and everything comes back when the editor closes.
await sleep(300);
const restored = await inkBox(BOX.mathText);
check('关闭编辑器后公式重新绘制',
  restored.dark > 200 && Math.abs(restored.w - mathInk.w) < mathInk.w * 0.15,
  `dark ${restored.dark}, w ${restored.w.toFixed(1)}`);

/* ---------------------------------------------------------------- *
 * 6. Round-trip: a .note keeps the LaTeX source verbatim
 * ---------------------------------------------------------------- */
console.log('\n[6] 存储保真与导出');
const roundTrip = await page.evaluate(async () => {
  const ed = window.app.editor;
  const el = ed.page.elements.find((e) => e.text === '$x^2+y^2$');
  return { text: el.text };
});
check('元素文本保存的是 LaTeX 源码', roundTrip.text === '$x^2+y^2$', roundTrip.text);

// PNG / PDF export both go through renderPageBitmap: a separate renderer with
// a cold cache, so the math has to typeset and rasterise there too.
const exported = await page.evaluate(async () => {
  const canvas = await window.app.renderPageBitmap(0, 2);
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) ink++;
  return { w: canvas.width, h: canvas.height, ink };
});
check('导出位图包含公式', exported.ink > 500, JSON.stringify(exported));

/* ---------------------------------------------------------------- *
 * 7. Typing LaTeX through the real UI (tool → click → type → commit)
 * ---------------------------------------------------------------- */
console.log('\n[7] 真实交互：打字输入公式');
const canvasBox = await page.$eval('#wb-canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y };
});
await page.evaluate(() => {
  const ed = window.app.editor;
  ed.page.elements = [];
  ed.invalidate();
  window.app.ui.selectTool('text');
});
await sleep(300);
await page.mouse.click(canvasBox.x + 200, canvasBox.y + 200);
await sleep(500);
await page.keyboard.type('欧拉恒等式 $e^{i\\pi}+1=0$ 真漂亮');
await sleep(400);
const typedEditing = await page.evaluate(() => ({
  editing: !!window.app.editor.inline.current,
  textarea: document.querySelector('.wb-inline-textarea')?.value || null,
}));
check('编辑框里是 LaTeX 源码', typedEditing.editing && typedEditing.textarea === '欧拉恒等式 $e^{i\\pi}+1=0$ 真漂亮',
  JSON.stringify(typedEditing));

// Ctrl+Enter commits and re-fits the box around the typeset formula.
await page.keyboard.down('Control');
await page.keyboard.press('Enter');
await page.keyboard.up('Control');
await sleep(1200);

const typed = await page.evaluate(async () => {
  const m = await import('/js/mathtext.js');
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  const ed = window.app.editor;
  const el = ed.page.elements[0];
  const c = document.createElement('canvas').getContext('2d');
  c.font = els.fontString(el.fontSize, el);
  const atom = m.mathAtom('e^{i\\pi}+1=0', false, c, el.fontSize, el, 1);
  const full = m.layoutRichText(c, el.text, el.fontSize, Infinity, el);
  return {
    text: el.text, fontSize: el.fontSize, boxW: Rect.parse(el.bounds).w,
    lineW: full[0].w, atomW: atom.w, lines: full.length,
    kinds: full[0].items.map((it) => it.kind).join('+'),
  };
});
check('提交后文本仍是 LaTeX 源码', typed.text === '欧拉恒等式 $e^{i\\pi}+1=0$ 真漂亮', typed.text);
check('文本框按公式宽度自动适配',
  Math.abs(typed.boxW - (typed.lineW + typed.fontSize * 0.4)) < 1.5,
  `框宽 ${typed.boxW.toFixed(1)} / 行宽 ${typed.lineW.toFixed(1)} / 内边距 ${(typed.fontSize * 0.4).toFixed(1)}`);
check('一行里文字与公式混排', typed.kinds === 'text+math+text' && typed.lines === 1, typed.kinds);

const typedInk = await page.evaluate(() => {
  const c = document.querySelector('#wb-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) ink++;
  return ink;
});
check('公式已画到画布上', typedInk > 500, String(typedInk));

await page.evaluate(() => { window.app.editor.clearSelection(); window.app.editor.draw(); });
await page.screenshot({ path: path.join(SHOTS, 'math-render.png') });
await browser.close();

/* ---------------------------------------------------------------- *
 * Summary
 * ---------------------------------------------------------------- */
const failed = results.filter((r) => !r.ok);
const realErrors = errors.filter((e) => !/favicon/.test(e));
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  ✗', f.name);
}
if (realErrors.length) {
  console.log('控制台错误：');
  for (const e of realErrors.slice(0, 10)) console.log('  !', e);
}
process.exitCode = failed.length || realErrors.length ? 1 : 0;
