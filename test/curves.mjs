/**
 * Curve shapes regression test.
 *
 * ① Preset curves in the shape tool: 抛物线 / 双曲线 / 正弦波 / 三次曲线.  They are
 *    stored as ordinary polylines (`T.POLYLINE`), which is a Microsoft Whiteboard
 *    type, so the files stay readable in the original app — a hyperbola is two
 *    elements because one polyline cannot hold two disjoint branches.
 * ② 任意画 → 高次曲线拟合: a freehand stroke is replaced by the smooth parametric
 *    polynomial through it (the same operation is available for selected ink in
 *    the 更多 menu).
 *
 * Usage:  node test/curves.mjs [--chrome <path>] [--url http://127.0.0.1:8813/]
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

const profileDir = path.join(__dirname, '.chrome-profile-curves');
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

/* ---------------------------------------------------------------- *
 * 1. The shape flyout offers the curves
 * ---------------------------------------------------------------- */
console.log('\n[1] 形状面板里的曲线');
const buttons = await page.evaluate(async () => {
  const ui = window.app.ui;
  ui.openShapeFlyout(ui.toolButtons.shape);
  await new Promise((r) => setTimeout(r, 250));
  const list = [...document.querySelectorAll('.wb-shapebtn[data-curve]')];
  return {
    curves: list.map((b) => b.dataset.curve),
    titles: list.map((b) => b.title),
    section: [...document.querySelectorAll('.wb-flyout-label')].map((n) => n.textContent).find((t) => t.includes('曲线')) || '',
  };
});
check('形状面板有 4 条曲线 + 任意画拟合入口',
  ['parabola', 'hyperbola', 'sine', 'cubic', 'fit'].every((c) => buttons.curves.includes(c))
  && buttons.titles.includes('抛物线') && buttons.titles.includes('双曲线'),
  JSON.stringify(buttons));

// clicking a curve button arms the shape tool with that curve
const armed = await page.evaluate(async () => {
  const btn = document.querySelector('.wb-shapebtn[data-curve="hyperbola"]');
  btn.click();
  await new Promise((r) => setTimeout(r, 200));
  const ed = window.app.editor;
  const active = document.querySelector('.wb-shapebtn[data-curve="hyperbola"]').classList.contains('active');
  return { tool: ed.tool, kind: ed.shapeKind, curve: ed.shapeCurve, active };
});
check('点「双曲线」后形状工具进入 curve 模式并高亮该按钮',
  armed.tool === 'shape' && armed.kind === 'curve' && armed.curve === 'hyperbola' && armed.active === true,
  JSON.stringify(armed));
await page.evaluate(() => window.app.ui.closeFlyout());

/* ---------------------------------------------------------------- *
 * 2. The maths of every preset
 * ---------------------------------------------------------------- */
console.log('\n[2] 曲线形状');
const geom = await page.evaluate(async () => {
  const { buildShapeElement } = await import('/js/tools.js');
  const { elementPoints } = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  const style = { stroke: '#FF1F1F1F', width: 2, curve: null };
  const out = {};
  const RECT = new Rect(100, 100, 400, 300);
  for (const curve of ['parabola', 'hyperbola', 'sine', 'cubic']) {
    const built = buildShapeElement('curve', RECT, { ...style, curve });
    const list = Array.isArray(built) ? built : [built];
    const stat = (e) => {
      // points are stored the way `.note` does (`"x,y"` per point)
      const pts = elementPoints(e);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return {
        type: e.type, n: pts.length, curve: e.curve, closed: !!e.closed,
        minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
        // stored coordinates are rounded to 4 decimals, so compare with that
        // much slack instead of exactly
        monotonicX: pts.every((p, i, a) => i === 0 || p.x >= a[i - 1].x - 2e-4),
        monotonicYUp: pts.every((p, i, a) => i === 0 || p.y >= a[i - 1].y - 2e-4),
        monotonicYDown: pts.every((p, i, a) => i === 0 || p.y <= a[i - 1].y + 2e-4),
        extremes: pts.filter((p, i, a) => i > 0 && i < a.length - 1
          && ((p.y < a[i - 1].y && p.y <= a[i + 1].y) || (p.y > a[i - 1].y && p.y >= a[i + 1].y))).length,
      };
    };
    out[curve] = { count: list.length, shapes: list.map(stat) };
  }
  // fill closes the curve against the baseline
  const filled = buildShapeElement('curve', RECT, { ...style, curve: 'parabola', filled: true });
  out.filled = (Array.isArray(filled) ? filled[0] : filled);
  out.filledStat = { closed: !!(Array.isArray(filled) ? filled[0] : filled).closed, filled: !!(Array.isArray(filled) ? filled[0] : filled).filled };
  out.rect = {
    x: RECT.x, y: RECT.y, w: RECT.w, h: RECT.h,
    left: RECT.left, right: RECT.right, top: RECT.top, bottom: RECT.bottom, cx: RECT.cx, cy: RECT.cy,
  };
  return out;
});
const insideBox = (s, b, tol = 2) => s.minX >= b.left - tol && s.maxX <= b.right + tol
  && s.minY >= b.top - tol && s.maxY <= b.bottom + tol;
check('所有曲线都是 POLYLINE（Microsoft Whiteboard 认得）且落在拖出的范围里',
  ['parabola', 'hyperbola', 'sine', 'cubic'].every((c) => geom[c].shapes.every((s) => s.type === 200017 && s.n >= 80))
  && ['parabola', 'hyperbola', 'sine', 'cubic'].every((c) => geom[c].shapes.every((s) => insideBox(s, geom.rect))),
  JSON.stringify(Object.fromEntries(['parabola', 'hyperbola', 'sine', 'cubic'].map((c) => [c, geom[c].shapes.length]))));

const parabola = geom.parabola.shapes[0];
check('抛物线：开口向下（顶点在下、两端在上）且铺满宽度',
  parabola.monotonicX === true
  && Math.abs(parabola.minX - geom.rect.left) < 2 && Math.abs(parabola.maxX - geom.rect.right) < 2
  && parabola.maxY > geom.rect.top + geom.rect.h * 0.5
  && parabola.minY < geom.rect.top + geom.rect.h * 0.2,
  JSON.stringify(parabola));

// A hyperbola branch turns around at its vertex, so it is monotonic in *y*,
// never in x; what matters is that each branch keeps to its own half.  Screen
// coordinates grow downwards, hence "bottom to top" is y decreasing.
check('双曲线：两条分支，各自从下到上、分居左右',
  geom.hyperbola.count === 2
  && geom.hyperbola.shapes.every((s) => s.monotonicYDown && s.n >= 80)
  && geom.hyperbola.shapes[0].maxX < geom.rect.cx
  && geom.hyperbola.shapes[1].minX > geom.rect.cx
  // the branches stop just short of the box edges (5% margin), like a plot
  && Math.abs(geom.hyperbola.shapes[0].minY - geom.rect.top) < geom.rect.h * 0.06
  && Math.abs(geom.hyperbola.shapes[0].maxY - geom.rect.bottom) < geom.rect.h * 0.06,
  JSON.stringify({
    count: geom.hyperbola.count,
    cx: geom.rect.cx, top: geom.rect.top, bottom: geom.rect.bottom, h: geom.rect.h,
    shapes: geom.hyperbola.shapes.map((sh) => ({
      n: sh.n, up: sh.monotonicYUp, minX: sh.minX, maxX: sh.maxX, minY: sh.minY, maxY: sh.maxY,
    })),
  }));

const sine = geom.sine.shapes[0];
check('正弦波：跨两个完整周期（四个极值点）且振幅接近整高',
  sine.extremes === 4 && sine.minY < geom.rect.top + geom.rect.h * 0.2
  && sine.maxY > geom.rect.bottom - geom.rect.h * 0.2,
  JSON.stringify({ extremes: sine.extremes, minY: sine.minY, maxY: sine.maxY, top: geom.rect.top, bottom: geom.rect.bottom }));

const cubic = geom.cubic.shapes[0];
check('三次曲线：单调向右上的 S 形',
  cubic.monotonicX === true && cubic.monotonicYDown === true
  && Math.abs(cubic.minX - geom.rect.left) < 2 && Math.abs(cubic.maxX - geom.rect.right) < 2,
  JSON.stringify({ minX: cubic.minX, maxX: cubic.maxX, up: cubic.monotonicYUp, down: cubic.monotonicYDown }));

check('打开「填充」后曲线收口成闭合图形', geom.filledStat.closed === true && geom.filledStat.filled === true,
  JSON.stringify(geom.filledStat));

/* ---------------------------------------------------------------- *
 * 3. Drawing one on the canvas with real pointer events
 * ---------------------------------------------------------------- */
console.log('\n[3] 用鼠标拖出一条抛物线');
const box = await page.$eval('#wb-canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y }; });
const C = (dx, dy) => [box.x + dx, box.y + dy];
const drawn = await page.evaluate(async () => {
  const ed = window.app.editor;
  ed.page.elements = [];
  ed.shapeKind = 'curve';
  ed.shapeCurve = 'parabola';
  ed.setTool('shape');
  ed.invalidate();
  return { tool: ed.tool, elements: ed.page.elements.length };
});
await page.mouse.move(...C(300, 250));
await page.mouse.down();
await page.mouse.move(...C(500, 400), { steps: 8 });
await page.mouse.move(...C(700, 500), { steps: 8 });
await page.mouse.up();
await sleep(600);
const placed = await page.evaluate(async () => {
  const ed = window.app.editor;
  const { elementBounds } = await import('/js/elements.js');
  const e = ed.page.elements[0];
  return {
    count: ed.page.elements.length,
    type: e?.type, curve: e?.curve, points: e?.points?.length,
    bounds: e ? elementBounds(e) : null,
    tool: ed.tool, selected: ed.selection.size, history: ed.history.undoLabel,
  };
});
check('拖出一个范围就得到一条抛物线（拖完自动回到选择工具）',
  drawn.tool === 'shape' && placed.count === 1 && placed.type === 200017
  && placed.curve === 'parabola' && placed.points >= 80 && placed.selected === 1
  && placed.tool === 'select',
  JSON.stringify(placed));

/* ---------------------------------------------------------------- *
 * 3b. Every curve button draws its own curve *through the tool*
 * ---------------------------------------------------------------- */
console.log('\n[3b] 每个曲线按钮画出来的都是它自己');
const perButton = await page.evaluate(async () => {
  const ui = window.app.ui;
  const ed = window.app.editor;
  const { shapeTool } = await import('/js/tools.js');
  const { elementPoints } = await import('/js/elements.js');
  const out = {};
  for (const kind of ['parabola', 'hyperbola', 'sine', 'cubic']) {
    ui.openShapeFlyout(ui.toolButtons.shape);
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector(`.wb-shapebtn[data-curve="${kind}"]`).click();
    await new Promise((r) => setTimeout(r, 120));
    ui.closeFlyout();
    // drag a box with the real tool, which is what the user does
    shapeTool.down(ed, { x: 0, y: 0 }, { shiftKey: false });
    const built = shapeTool._build(ed, { x: 600, y: 300 }, { shiftKey: false });
    shapeTool.cancel(ed);
    const list = (Array.isArray(built) ? built : [built]).filter(Boolean);
    const pts = elementPoints(list[0]);
    const ys = pts.map((p) => p.y);
    out[kind] = {
      count: list.length,
      curve: list[0]?.curve,
      n: pts.length,
      extremes: pts.filter((p, i, a) => i > 0 && i < a.length - 1
        && ((p.y < a[i - 1].y && p.y <= a[i + 1].y) || (p.y > a[i - 1].y && p.y >= a[i + 1].y))).length,
      top: Math.min(...ys), bottom: Math.max(...ys),
      mid: pts[(pts.length / 2) | 0].y,
    };
  }
  return out;
});
check('四个曲线按钮各自画出对应的曲线（不是画什么都变抛物线）',
  perButton.parabola.curve === 'parabola' && perButton.parabola.mid > perButton.parabola.top + 100
  && perButton.hyperbola.curve === 'hyperbola' && perButton.hyperbola.count === 2
  && perButton.sine.curve === 'sine' && perButton.sine.extremes === 4
  && perButton.cubic.curve === 'cubic' && perButton.cubic.extremes === 0
  && Math.abs(perButton.parabola.mid - perButton.parabola.bottom) < 1        // vertex on the bottom edge
  && Math.abs(perButton.cubic.mid - 150) < 2                                // S curve crosses the middle
  && Math.abs(perButton.hyperbola.mid - 150) < 60,                          // branches turn near the centre
  JSON.stringify(perButton));

/* ---------------------------------------------------------------- *
 * 4. 任意画 → 高次曲线拟合
 * ---------------------------------------------------------------- */
console.log('\n[4] 任意画 → 高次曲线拟合');
const fitTool = await page.evaluate(async () => {
  const ed = window.app.editor;
  // the shape drawn in [3] is still selected, and its action bar would swallow
  // the next pointerdown
  ed.selection.clear();
  ed.onSelectionChange?.();
  ed.page.elements = [];
  ed.setTool('curvefit');
  ed.invalidate();
  await new Promise((r) => setTimeout(r, 150));
  return { tool: ed.tool, cursor: ed.canvas.style.cursor };
});
// a deliberately wobbly sine, drawn with real mouse events
const cx = box.x + 420, cy = box.y + 560;
await page.mouse.move(cx, cy);
await page.mouse.down();
const raw = [];
for (let i = 0; i <= 70; i++) {
  const x = cx + i * 6;
  const y = cy + Math.sin(i / 5.5) * 90 + Math.sin(i / 1.7) * 4;   // smooth + jitter
  raw.push({ x: x - box.x, y: y - box.y });
  await page.mouse.move(x, y);
  await sleep(5);
}
await page.mouse.up();
await sleep(700);
const fitted = await page.evaluate(async (rawPts) => {
  const ed = window.app.editor;
  const { elementPoints, elementBounds } = await import('/js/elements.js');
  const { curveFitError } = await import('/js/geometry.js');
  const e = ed.page.elements[0];
  if (!e) {
    return {
      missing: true, count: ed.page.elements.length, tool: ed.tool,
      live: !!ed.live, raw: rawPts.length,
      toast: document.querySelector('.wb-toasts')?.textContent || '',
    };
  }
  const pts = elementPoints(e);
  const b = elementBounds(e);
  // the recorded mouse positions are canvas-local; the curve lives in world
  // space, so put them through the same transform the editor used
  const world = rawPts.map((p) => ed.screenToWorld(p.x, p.y));
  const err = curveFitError(world, pts);
  return {
    count: ed.page.elements.length, type: e?.type, fitted: !!e?.curveFit,
    points: pts.length, height: b.h, width: b.w,
    error: Number(err.toFixed(2)),
    tool: ed.tool, selected: ed.selection.size, history: ed.history.undoLabel,
  };
}, raw);
check('松手后得到一条拟合曲线（一个元素、一个撤销步）',
  fitTool.tool === 'curvefit' && fitted.count === 1 && fitted.type === 200017
  && fitted.fitted === true && fitted.points >= 80 && fitted.selected === 1
  && fitted.history === '曲线拟合',
  JSON.stringify(fitted));
check('拟合曲线贴着原来的笔迹（不偏离超过 14% 高度）',
  fitted.error < Math.max(fitted.height, fitted.width) * 0.14 + 2,
  JSON.stringify({ error: fitted.error, w: fitted.width, h: fitted.height }));

const undone = await page.evaluate(async () => {
  const ed = window.app.editor;
  window.app.undo();
  await new Promise((r) => setTimeout(r, 250));
  return ed.page.elements.length;
});
check('一步撤销去掉整条拟合曲线', undone === 0, String(undone));

/* ---------------------------------------------------------------- *
 * 5. 更多 menu: fit the selected ink
 * ---------------------------------------------------------------- */
console.log('\n[5] 菜单：曲线拟合所选墨迹');
const menu = await page.evaluate(async () => {
  const ed = window.app.editor;
  const els = await import('/js/elements.js');
  ed.page.elements = [];
  const pts = [];
  for (let i = 0; i <= 90; i++) {
    const t = i / 90;
    pts.push({ x: 120 + t * 600, y: 500 + Math.sin(t * Math.PI * 2) * 140 + Math.sin(t * 40) * 3 });
  }
  ed.addElement(els.makeInk({ stroke: '#FF0169BF', width: 3, points: pts }), { select: true });
  ed.setTool('select');
  await new Promise((r) => setTimeout(r, 200));
  const ui = window.app.ui;
  ui.openMoreFlyout(ui.moreBtn);
  await new Promise((r) => setTimeout(r, 250));
  const row = [...document.querySelectorAll('.wb-morerow')].find((b) => b.textContent.includes('曲线拟合'));
  const label = row?.textContent.trim() || '';
  row?.click();
  await new Promise((r) => setTimeout(r, 300));
  const e = ed.page.elements[0];
  return {
    label, count: ed.page.elements.length, type: e?.type, fitted: !!e?.curveFit,
    points: e?.points?.length, toast: document.querySelector('.wb-toasts')?.textContent || '',
    history: ed.history.undoLabel,
  };
});
check('「更多」里有曲线拟合，点一下就把所选墨迹变成高次曲线',
  menu.label.includes('曲线拟合') && menu.count === 1 && menu.type === 200017
  && menu.fitted === true && menu.points >= 80 && menu.history === '曲线拟合'
  && menu.toast.includes('已把 1 条墨迹拟合成高次曲线'),
  JSON.stringify(menu));

const tooShort = await page.evaluate(async () => {
  const ed = window.app.editor;
  const els = await import('/js/elements.js');
  ed.page.elements = [];
  ed.addElement(els.makeInk({ stroke: '#FF1F1F1F', width: 3, points: [{ x: 100, y: 100 }, { x: 104, y: 102 }] }), { select: true });
  ed.setTool('select');
  const n = window.app.fitSelectionCurves();
  return { n, toast: document.querySelector('.wb-toasts')?.textContent || '' };
});
check('太短的笔画不会被硬凑成曲线（给出提示）',
  tooShort.n === 0 && tooShort.toast.includes('太短'), JSON.stringify(tooShort));

/* ---------------------------------------------------------------- *
 * 6. Curves survive a save / reload
 * ---------------------------------------------------------------- */
console.log('\n[6] 曲线保存后还能读回来');
const saved = await page.evaluate(async () => {
  const ed = window.app.editor;
  const { buildShapeElement } = await import('/js/tools.js');
  const { Rect } = await import('/js/geometry.js');
  const els = await import('/js/elements.js');
  ed.page.elements = [];
  const shot = [].concat(
    buildShapeElement('curve', new Rect(60, 80, 300, 220), { stroke: '#FFD61E1E', width: 2.5, curve: 'parabola' }),
    buildShapeElement('curve', new Rect(420, 80, 300, 220), { stroke: '#FF1EA51E', width: 2.5, curve: 'hyperbola' }),
  );
  const ink = els.makeInk({
    stroke: '#FF1E5AD6', width: 3,
    points: Array.from({ length: 60 }, (_, i) => ({ x: 80 + i * 8, y: 420 + Math.sin(i / 5) * 60 })),
  });
  ed.addElements(shot, { select: false });
  ed.addElement(ink, { select: true });
  window.app.fitSelectionCurves();
  await new Promise((r) => setTimeout(r, 200));
  const { noteBlob } = await import('/js/document.js');
  const blob = await noteBlob(ed.doc, {});
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { ZipReader } = await import('/js/zipread.js');
  const zip = await ZipReader.open(new Blob([bytes]));
  const page1 = await zip.json('Pages/page1.json');
  return {
    count: page1.elements.length,
    types: page1.elements.map((e) => e.type),
    curves: page1.elements.map((e) => e.curve || (e.curveFit ? 'fit' : null)),
    points: page1.elements.map((e) => (e.points || []).length),
  };
});
check('存进 .note：抛物线 + 双曲线（2 条）+ 拟合曲线，点数原样保留',
  saved.count === 4 && saved.types.every((t) => t === 200017)
  && saved.curves.join(',') === 'parabola,hyperbola,hyperbola,fit'
  && saved.points.every((n) => n >= 80),
  JSON.stringify(saved));

await chooseSaveTarget(page, 'curves-suite.note');
await page.evaluate(async () => { await window.app.saveAs(); });
await sleep(1200);
const reopened = await page.evaluate(async () => {
  const app = window.app;
  const dir = await navigator.storage.getDirectory();
  const handle = await dir.getFileHandle('curves-suite.note');
  app.markSaved();
  await app.openLocalFile(await handle.getFile(), { handle });
  await new Promise((r) => setTimeout(r, 1200));
  const ed = app.editor;
  return {
    count: ed.page.elements.length,
    types: ed.page.elements.map((e) => e.type),
    points: ed.page.elements.map((e) => (e.points || []).length),
    strokes: ed.page.elements.map((e) => e.stroke),
  };
});
const stored = await readOpfs(page, 'curves-suite.note');
check('重新打开后曲线还是曲线',
  reopened.count === 4 && reopened.types.every((t) => t === 200017)
  && reopened.points.every((n) => n >= 80) && stored.entries.includes('Pages/page1.json'),
  JSON.stringify(reopened));

await page.evaluate(async () => {
  const ed = window.app.editor;
  ed.gotoPage(0);
  ed.fitPage();
  ed.invalidate(); ed.requestRender();
  await new Promise((r) => setTimeout(r, 400));
});
await page.screenshot({ path: path.join(SHOTS, 'curves.png') });
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
