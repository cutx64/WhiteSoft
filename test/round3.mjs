/**
 * Round-3 verification for the newly requested features:
 *
 *   1. undo / delete repaint immediately (no extra interaction needed)
 *   2. move-canvas (hand) tool + G shortcut
 *   3. highlighter "draw straight lines" switch
 *   4. straight highlights get semicircular (rounded) ends
 *   5. delete every kind of selected object + Delete shortcut
 *   6. type an arbitrary zoom percentage into the bottom bar
 *   7. unsaved-changes confirmation before loading another PDF / .note
 *
 * The sample boards are local files now: they are served by the test process
 * and turned into real `File`s inside the page (test/lib/local.mjs).  Opening
 * one goes through `app.openLocalFile()`, and 另存为 writes into an OPFS file
 * whose bytes are then read back.
 *
 * Usage: node test/round3.mjs [--chrome <path>] [--url <base>] [--fixtures <dir>]
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
// These suites assert on two private sample boards (446 / 655 pages), which the
// repository does not ship; point them at whatever directory holds them.
const FIXTURE_DIR = resolveFixtureDir(arg('fixtures', ''), ['Al-jabr-1.note', 'Al-jabr-2.note']);
if (!FIXTURE_DIR) {
  console.error('找不到样例白板 Al-jabr-1.note / Al-jabr-2.note。\n'
    + '请把这两个文件放进仓库的 .tmp-boards/，或用 --fixtures <目录> 指定它们所在的目录。');
  process.exit(2);
}
const NOTE1 = path.join(FIXTURE_DIR, 'Al-jabr-1.note');
const NOTE2 = path.join(FIXTURE_DIR, 'Al-jabr-2.note');

const profileDir = path.join(__dirname, '.chrome-profile-round3');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const errors = [];
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

const box = await page.$eval('#wb-canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const C = (dx, dy) => [box.x + dx, box.y + dy];

/** Wait for the rAF-coalesced repaint to have happened. */
async function settle() {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Cheap fingerprint of what is currently painted on the visible canvas. */
async function canvasHash() {
  return page.evaluate(() => {
    const c = document.querySelector('#wb-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 4 * 13) {
      h ^= d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11;
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  });
}

/** Wait until the PDF background of the open board has been rasterised. */
const waitPdfBitmap = (timeout = 60000) => page.waitForFunction(() => {
  const ed = window.app.editor;
  return !!(ed._pdfPages && ed._pdfPages[0] && ed._pdfPages[0].bitmap);
}, { timeout });

/**
 * Put a fixture into the page as a real `File` the app can open, without
 * touching the browser's file system: this is the "user dragged a file in"
 * case, and it is what the unsaved-changes prompts below are exercised with.
 */
async function stageFixture(url, name = null) {
  return page.evaluate(async ({ url, name }) => {
    const blob = await (await fetch(url)).blob();
    const fileName = name || decodeURIComponent(url.split('/').pop());
    window.__staged = new File([blob], fileName, { type: 'application/x-note' });
    return { name: fileName, size: window.__staged.size };
  }, { url, name });
}

/* ================================================================ *
 * 1. Immediate repaint on undo / redo / delete
 * ================================================================ */
console.log('\n[1] 撤销 / 删除即时渲染');
await page.evaluate(() => window.app.ui.closeDialog());
await openFixture(page, fixtures.url('Al-jabr-1.note'));
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await waitPdfBitmap();
await sleep(2000);
await page.evaluate(() => {
  const ed = window.app.editor;
  ed.gotoPage(1);
  window.app.ui.closeFlyout();
});
await sleep(1500);

const before = await canvasHash();
await page.evaluate(() => window.app.ui.selectTool('pen'));
await page.mouse.move(...C(300, 300));
await page.mouse.down();
for (let i = 0; i <= 24; i++) { await page.mouse.move(box.x + 300 + i * 14, box.y + 300 + Math.sin(i / 3) * 40); await sleep(6); }
await page.mouse.up();
await settle();
const drawn = await canvasHash();
check('绘制后画面改变', drawn !== before, `${before} → ${drawn}`);

// undo with NO further interaction
await page.evaluate(() => window.app.undo());
await settle();
const undone = await canvasHash();
check('撤销后立即重绘（无需其他操作）', undone !== drawn && undone === before, `${drawn} → ${undone}`);

await page.evaluate(() => window.app.redo());
await settle();
const redone = await canvasHash();
check('重做后立即重绘', redone === drawn, `${undone} → ${redone}`);

// delete: select all, delete, undo
await page.evaluate(() => { window.app.ui.selectTool('marquee'); window.app.editor.selectAll(); });
await settle();
const selected = await canvasHash();
await page.evaluate(() => window.app.deleteSelection());
await settle();
const deleted = await canvasHash();
check('删除后立即重绘', deleted !== selected, `${selected} → ${deleted}`);
await page.evaluate(() => window.app.undo());
await settle();
const undeleted = await canvasHash();
check('删除撤销后立即重绘', undeleted === selected, `${deleted} → ${undeleted}`);
await page.screenshot({ path: path.join(SHOTS, 'r3-undo.png') });

/* ================================================================ *
 * 2. Move-canvas tool
 * ================================================================ */
console.log('\n[2] 移动画布');
const handBtn = await page.evaluate(() => {
  const b = document.querySelector('.wb-btn[data-tool="pan"]');
  return b ? b.title : null;
});
check('工具栏有“移动画布”按钮', !!handBtn && handBtn.includes('移动画布'), String(handBtn));

await page.evaluate(() => document.querySelector('.wb-btn[data-tool="pan"]').click());
await sleep(300);
const toolNow = await page.evaluate(() => window.app.editor.tool);
check('点击后切到手形工具', toolNow === 'pan', toolNow);

const cam0 = await page.evaluate(() => ({ ...window.app.editor.camera }));
await page.mouse.move(...C(700, 500));
await page.mouse.down();
await page.mouse.move(...C(880, 620), { steps: 10 });
await page.mouse.up();
await sleep(300);
const cam1 = await page.evaluate(() => ({ ...window.app.editor.camera }));
check('手形工具拖动平移画布',
  Math.abs(cam1.x - cam0.x) > 5 && Math.abs(cam1.y - cam0.y) > 5,
  `(${cam0.x.toFixed(0)},${cam0.y.toFixed(0)}) → (${cam1.x.toFixed(0)},${cam1.y.toFixed(0)})`);

const gKey = await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
  return window.app.editor.tool;
});
check('G 快捷键切到移动画布', gKey === 'pan', gKey);
await page.evaluate(() => window.app.ui.selectTool('pen'));

/* ================================================================ *
 * 3. Highlighter straight-line switch
 * ================================================================ */
console.log('\n[3] 荧光笔“直线绘制”开关');
const toggleFound = await page.evaluate(() => {
  window.app.ui.selectTool('highlighter');
  const btns = [...document.querySelectorAll('.wb-flyout .wb-toggle')];
  const b = btns.find((x) => x.textContent.includes('直线绘制'));
  if (!b) return null;
  const was = b.classList.contains('active');
  b.click();
  return { was, now: b.classList.contains('active'), straight: window.app.editor.highlighter.straight };
});
check('荧光笔工具栏有“直线绘制”开关', !!toggleFound && toggleFound.now === true, JSON.stringify(toggleFound));

await page.evaluate(() => window.app.ui.closeFlyout());
await sleep(200);
await page.mouse.move(...C(300, 700));
await page.mouse.down();
for (let i = 0; i <= 20; i++) { await page.mouse.move(box.x + 300 + i * 15, box.y + 700 + Math.sin(i / 2) * 30); await sleep(6); }
await page.mouse.up();
await sleep(400);
const straightEl = await page.evaluate(() => {
  const e = window.app.editor.page.elements.at(-1);
  return { type: e.type, n: (e.points || []).length, cap: e.cap || null, w: e.width };
});
check('开启后拉出的是两点直线', straightEl.type === 100005 && straightEl.n === 2, JSON.stringify(straightEl));
check('直线高亮带 cap:round（半圆端点）', straightEl.cap === 'round', String(straightEl.cap));

// switch it off again -> freehand
await page.evaluate(() => {
  window.app.ui.selectTool('highlighter');
  const b = [...document.querySelectorAll('.wb-flyout .wb-toggle')].find((x) => x.textContent.includes('直线绘制'));
  if (b.classList.contains('active')) b.click();
  window.app.ui.closeFlyout();
});
await sleep(200);
await page.mouse.move(...C(300, 800));
await page.mouse.down();
for (let i = 0; i <= 20; i++) { await page.mouse.move(box.x + 300 + i * 15, box.y + 800 + Math.sin(i / 2) * 30); await sleep(6); }
await page.mouse.up();
await sleep(400);
const freeEl = await page.evaluate(() => {
  const e = window.app.editor.page.elements.at(-1);
  return { type: e.type, n: (e.points || []).length, cap: e.cap || null };
});
check('关闭后恢复自由手绘', freeEl.type === 100005 && freeEl.n > 2 && !freeEl.cap, JSON.stringify(freeEl));

/* ================================================================ *
 * 4. Rounded ends are actually painted
 * ================================================================ */
console.log('\n[4] 半圆端点的像素验证');
const pixelTest = await page.evaluate(async () => {
  const ed = window.app.editor;
  ed.addPage();
  await new Promise((r) => setTimeout(r, 100));
  const page = ed.page;
  page.elements = [];
  ed.camera.zoom = 1;
  ed.camera.x = 0;
  ed.camera.y = 0;
  ed.background.style = 'none';
  const mk = (cap) => ({
    type: 100005, stroke: '#5AFF0000', width: 60, closed: false,
    points: [{ point: '200,300' }, { point: '500,300' }],
    // 'butt' is explicit: with the new default, an unmarked straight
    // highlight is rounded like the ones found in existing .note files.
    cap: cap || 'butt',
  });
  const sample = async (el) => {
    page.elements = [el];
    ed.invalidate();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.querySelector('#wb-canvas');
    const dpr = ed.dpr;
    const ctx = c.getContext('2d');
    const pick = (wx, wy) => {
      const s = ed.worldToScreen(wx, wy);
      const d = ctx.getImageData(Math.round(s.x * dpr), Math.round(s.y * dpr), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    };
    return {
      // 25 world units left of the start point: inside the semicircle only
      capZone: pick(175, 300),
      // well before that: bare canvas
      outside: pick(120, 300),
      // middle of the band
      middle: pick(350, 300),
      // just past the top edge of the band
      above: pick(350, 265),
    };
  };
  const round = await sample(mk('round'));
  const butt = await sample(mk('butt'));
  // an unmarked two-point highlight (exactly what the .note files contain)
  const legacy = await sample({
    type: 100005, stroke: '#5AFF0000', width: 60, closed: false,
    points: [{ point: '200,300' }, { point: '500,300' }],
  });
  page.elements = [];
  ed.invalidate();
  return { round, butt, legacy };
});
const isWhite = (p) => p.r > 250 && p.g > 250 && p.b > 250;
const capPainted = !isWhite(pixelTest.round.capZone) && isWhite(pixelTest.round.outside);
const buttEmpty = isWhite(pixelTest.butt.capZone) && isWhite(pixelTest.butt.outside);
check('round：端点外 25 单位处被半圆覆盖', capPainted, JSON.stringify(pixelTest.round.capZone));
check('butt：同一点保持空白', buttEmpty, JSON.stringify(pixelTest.butt.capZone));
check('两种模式中段都有高亮', !isWhite(pixelTest.round.middle) && !isWhite(pixelTest.butt.middle),
  `${JSON.stringify(pixelTest.round.middle)} / ${JSON.stringify(pixelTest.butt.middle)}`);
check('原版 .note 的直线高亮默认也画成半圆端点',
  !isWhite(pixelTest.legacy.capZone) && isWhite(pixelTest.legacy.outside),
  JSON.stringify(pixelTest.legacy.capZone));
await page.screenshot({ path: path.join(SHOTS, 'r3-highlighter.png') });

/* ================================================================ *
 * 5. Delete every kind of selection
 * ================================================================ */
console.log('\n[5] 删除所选（含便签/文本/表格/图片）');
const del = await page.evaluate(async () => {
  const ed = window.app.editor;
  ed.doc.pages[ed.pageIndex].elements = [];
  // one of every object kind
  ed.page.elements.push(
    { type: 400001, bounds: '60,60,120,120', color: '#FFFFE6A0', text: 'n', textColor: '#FF000000', fontSize: 18 },
    { type: 300002, bounds: '220,60,120,30', text: 't', textColor: '#FF000000', fontSize: 20 },
    {
      type: 400002, bounds: '380,60,240,120', rows: 2, cols: 2,
      cells: [['a', 'b'], ['c', 'd']], colWidths: [120, 120], rowHeights: [60, 60],
      stroke: '#FF808285', width: 1.6, textColor: '#FF000000', fontSize: 16,
    },
    { type: 300001, bounds: '660,60,120,80', rotation: 0, fileName: 'nonexistent.png' },
    { type: 100001, stroke: '#FF000000', width: 3, inks: [{ x: 100, y: 260, pr: 0.5 }, { x: 200, y: 280, pr: 0.5 }] },
  );
  ed.invalidate();
  await new Promise((r) => setTimeout(r, 150));
  const ids = ['便签', '文本', '表格', '图片', '墨迹'];
  ed.selection.clear();
  ed.selectAll();
  const selected = ed.selection.size;
  return { before: ed.page.elements.length, selected, ids };
});
check('全选涵盖所有对象类型', del.selected === del.before, `${del.selected}/${del.before}`);

const delCount = await page.evaluate(() => window.app.deleteSelection());
check('删除所选返回删除数量', delCount === del.before, String(delCount));
const afterDelete = await page.evaluate(() => window.app.editor.page.elements.length);
check('所有选中对象被删除', afterDelete === 0, String(afterDelete));
await settle();
const undoneDel = await page.evaluate(() => { window.app.undo(); return window.app.editor.page.elements.length; });
check('删除可整体撤销', undoneDel === del.before, String(undoneDel));

// the real Delete key
await page.evaluate(() => { window.app.editor.selectAll(); document.body.focus(); });
await sleep(200);
await page.keyboard.press('Delete');
await sleep(300);
const afterKey = await page.evaluate(() => window.app.editor.page.elements.length);
check('Delete 键删除所选', afterKey === 0, String(afterKey));
await page.evaluate(() => window.app.undo());

// right-click context menu
const menu = await page.evaluate(() => {
  const ed = window.app.editor;
  const countBefore = ed.page.elements.length;
  ed.selection.clear();
  ed.selection.add(ed.page.elements[0]);
  ed.onSelectionChange?.();
  const c = document.querySelector('#wb-canvas');
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: r.left + 100, clientY: r.top + 100,
  }));
  const items = [...document.querySelectorAll('.wb-menu .wb-menulabel')].map((n) => n.textContent);
  const hasDelete = items.some((t) => t.startsWith('删除'));
  const delBtn = [...document.querySelectorAll('.wb-menu .wb-menuitem')].find((n) => n.textContent.startsWith('删除'));
  if (delBtn) delBtn.click();
  return { items, hasDelete, countBefore, remaining: ed.page.elements.length };
});
check('右键菜单包含删除项', menu.hasDelete, JSON.stringify(menu.items.slice(0, 4)));
check('右键菜单删除可用', menu.remaining === menu.countBefore - 1,
  `${menu.countBefore} → ${menu.remaining}`);
await page.evaluate(() => window.app.undo());

/* ================================================================ *
 * 6. Arbitrary zoom percentage
 * ================================================================ */
console.log('\n[6] 任意比例缩放');
const zoomCases = [];
for (const [typed, expect] of [['137', 1.37], ['42.5', 0.425], ['250%', 2.5], ['', 1]]) {
  const got = await page.evaluate(async (t) => {
    const input = document.querySelector('.wb-zoominput');
    input.focus();
    input.value = t;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    return { zoom: window.app.editor.camera.zoom, shown: input.value };
  }, typed);
  zoomCases.push({ typed, ...got });
  check(`输入「${typed || '空'}」→ ${expect * 100}%`, Math.abs(got.zoom - expect) < 0.005,
    `${(got.zoom * 100).toFixed(1)}% (显示 ${got.shown})`);
}
const badZoom = await page.evaluate(async () => {
  const before = window.app.editor.camera.zoom;
  const input = document.querySelector('.wb-zoominput');
  input.focus();
  input.value = 'abc';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  return { before, after: window.app.editor.camera.zoom };
});
check('非法输入不改变比例', Math.abs(badZoom.after - badZoom.before) < 1e-6, JSON.stringify(badZoom));
const zoomButtons = await page.evaluate(() => {
  const i = document.querySelector('.wb-zoominput');
  return { exists: !!i, tag: i && i.tagName, title: i && i.title };
});
check('底栏比例是可输入的输入框', zoomButtons.exists && zoomButtons.tag === 'INPUT', JSON.stringify(zoomButtons));
await page.screenshot({ path: path.join(SHOTS, 'r3-zoom.png') });

/* ================================================================ *
 * 6b. Global (document-wide) zoom + 80 % default
 * ================================================================ */
console.log('\n[6b] 全局统一比例与默认 80%');
// re-open the board so we observe the value it starts with
await openFixture(page, fixtures.url('Al-jabr-1.note'));
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await sleep(1200);
const defaultZoom = await page.evaluate(() => {
  const ed = window.app.editor;
  return { zoom: ed.camera.zoom, def: ed.defaultZoom, shown: document.querySelector('.wb-zoominput').value };
});
check('打开白板时默认 80%', Math.abs(defaultZoom.zoom - 0.8) < 1e-6 && Math.abs(defaultZoom.def - 0.8) < 1e-6,
  JSON.stringify(defaultZoom));

const globalZoom = await page.evaluate(async () => {
  const ed = window.app.editor;
  const out = {};
  ed.gotoPage(4);
  out.atPage5 = ed.camera.zoom;
  // change the zoom on page 5 ...
  const input = document.querySelector('.wb-zoominput');
  input.focus(); input.value = '100';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  out.afterSet = ed.camera.zoom;
  // ... and every other page must follow
  ed.gotoPage(49);
  out.atPage50 = ed.camera.zoom;
  ed.gotoPage(199);
  out.atPage200 = ed.camera.zoom;
  input.focus(); input.value = '137';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  ed.gotoPage(3);
  out.atPage4 = ed.camera.zoom;
  // fit-to-width also becomes the shared zoom
  ed.fitPageWidth();
  out.fitted = ed.camera.zoom;
  ed.gotoPage(300);
  out.afterFitOtherPage = ed.camera.zoom;
  return out;
});
check('在一页调整比例后其他页同步', globalZoom.atPage50 === globalZoom.afterSet && globalZoom.atPage200 === globalZoom.afterSet,
  JSON.stringify(globalZoom));
check('再次调整仍全局同步', Math.abs(globalZoom.atPage4 - 1.37) < 1e-6, String(globalZoom.atPage4));
check('适应宽度也写入全局比例', Math.abs(globalZoom.afterFitOtherPage - globalZoom.fitted) < 1e-6,
  `${globalZoom.fitted.toFixed(4)} → ${globalZoom.afterFitOtherPage.toFixed(4)}`);

const zoomPersist = await page.evaluate(async () => {
  const ed = window.app.editor;
  const before = ed.camera.zoom;
  ed.gotoPage(10);
  return { before, after: ed.camera.zoom };
});
check('翻页不改变比例', Math.abs(zoomPersist.before - zoomPersist.after) < 1e-9, JSON.stringify(zoomPersist));
await page.screenshot({ path: path.join(SHOTS, 'r3-global-zoom.png') });

/* ================================================================ *
 * 6c. Straight highlights coming from an existing .note
 * ================================================================ */
console.log('\n[6c] 原版 .note 的直线高亮');
const legacyShot = await page.evaluate(async () => {
  const ed = window.app.editor;
  // page 168 of Al-jabr-1 holds 14 ruler-drawn two-point highlights
  ed.gotoPage(167);
  ed.fitPageWidth();
  await new Promise((r) => setTimeout(r, 2500));
  const hs = ed.page.elements.filter((e) => e.type === 100005);
  return {
    count: hs.length,
    twoPoint: hs.filter((e) => (e.points || []).length === 2).length,
    anyCapField: hs.some((e) => e.cap),
  };
});
check('原版高亮都是两点直线且无 cap 字段',
  legacyShot.count > 0 && legacyShot.twoPoint === legacyShot.count && !legacyShot.anyCapField,
  JSON.stringify(legacyShot));
await page.screenshot({ path: path.join(SHOTS, 'r3-legacy-highlight.png') });

/* ================================================================ *
 * 7. Unsaved-changes confirmation
 * ================================================================ */
console.log('\n[7] 未保存更改确认');
// make the board dirty (pushing directly bypasses the editor, so fire the
// content-change hook the way a real edit would)
await page.evaluate(() => {
  const ed = window.app.editor;
  ed.page.elements.push({ type: 400001, bounds: '80,80,100,100', color: '#FFFFE6A0', text: 'dirty', textColor: '#FF000000', fontSize: 18 });
  ed.invalidate();
  ed.onContentChange?.();
});
await sleep(300);
const dirty = await page.evaluate(() => window.app.modified);
check('编辑后标记为未保存', dirty === true, String(dirty));

// stage the second board, then start loading it and inspect the dialog without
// resolving it
await stageFixture(fixtures.url('Al-jabr-2.note'));
const prompt = await page.evaluate(async () => {
  const p = window.app.openLocalFile(window.__staged, { handle: null });
  p.catch(() => {});
  window.__pending = p;
  await new Promise((r) => setTimeout(r, 400));
  const dlg = document.querySelector('.wb-modal');
  const title = dlg ? dlg.querySelector('h3').textContent : null;
  const buttons = dlg ? [...dlg.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean) : [];
  return { title, buttons, pending: !!dlg, name: window.app.editor.doc.name };
});
check('加载其他白板前弹出确认', prompt.pending && prompt.title === '有未保存的更改', JSON.stringify(prompt));
check('确认框提供 取消 / 放弃更改 / 保存并继续',
  prompt.buttons.includes('取消') && prompt.buttons.includes('放弃更改') && prompt.buttons.includes('保存并继续'),
  JSON.stringify(prompt.buttons));

// cancel keeps the current board
const beforeCancel = await page.evaluate(() => ({
  name: window.app.editor.doc.name,
  pages: window.app.editor.doc.pages.length,
}));
const cancelled = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('.wb-modal button')].find((b) => b.textContent.trim() === '取消');
  if (btn) btn.click();
  else document.querySelector('.wb-modal')?.remove();
  await new Promise((r) => setTimeout(r, 300));
  return { name: window.app.editor.doc.name, pages: window.app.editor.doc.pages.length, modal: !!document.querySelector('.wb-modal') };
});
check('取消后保留当前白板',
  cancelled.name === beforeCancel.name && cancelled.pages === beforeCancel.pages && !cancelled.modal,
  JSON.stringify({ before: beforeCancel, after: cancelled }));

// discard actually loads
const discarded = await page.evaluate(async () => {
  const p = window.app.openLocalFile(window.__staged, { handle: null });
  await new Promise((r) => setTimeout(r, 400));
  const btn = [...document.querySelectorAll('.wb-modal button')].find((b) => b.textContent.trim() === '放弃更改');
  if (btn) btn.click();
  await p;
  await new Promise((r) => setTimeout(r, 1500));
  return { name: window.app.editor.doc.name, pages: window.app.editor.doc.pages.length, modified: window.app.modified };
});
check('放弃更改后载入新白板', discarded.name === 'Al-jabr-2' && discarded.pages >= 600, JSON.stringify(discarded));

// a clean board loads without any prompt
await stageFixture(fixtures.url('Al-jabr-1.note'));
const clean = await page.evaluate(async () => {
  const p = window.app.openLocalFile(window.__staged, { handle: null });
  await new Promise((r) => setTimeout(r, 400));
  const modal = !!document.querySelector('.wb-modal');
  await p;
  return { modal };
});
check('未修改时不弹确认框', clean.modal === false);

// PDF import also guards
const pdfGuard = await page.evaluate(async () => {
  const ed = window.app.editor;
  ed.page.elements.push({ type: 400001, bounds: '80,80,100,100', color: '#FFFFE6A0', text: 'x', textColor: '#FF000000', fontSize: 18 });
  ed.onContentChange?.();
  await new Promise((r) => setTimeout(r, 200));
  // the PDF the sample board embeds, read straight out of its local archive
  const doc = ed.doc;
  const bytes = doc._pdfBytes || await doc.localArchive.read('Resources/Document/' + doc.document.fileName);
  const file = new File([bytes], 'x.pdf', { type: 'application/pdf' });
  const p = window.app.importPdfFile(file);
  await new Promise((r) => setTimeout(r, 500));
  const dlg = document.querySelector('.wb-modal');
  const buttons = dlg ? [...dlg.querySelectorAll('button')].map((b) => b.textContent.trim()) : [];
  const cancel = [...document.querySelectorAll('.wb-modal button')].find((b) => b.textContent.trim() === '取消');
  if (cancel) cancel.click();
  await p;
  await new Promise((r) => setTimeout(r, 300));
  return { buttons, name: window.app.editor.doc.name };
});
check('导入 PDF 前同样确认', pdfGuard.buttons.includes('放弃更改'), JSON.stringify(pdfGuard.buttons));

/* ================================================================ *
 * 8. Save As keeps the original file untouched
 * ================================================================ */
console.log('\n[8] 另存为不覆盖原件');
// open the sample board for real, so it owns a writable handle and 另存为 has
// an original file it must leave alone
await openFixture(page, fixtures.url('Al-jabr-1.note'));
const originalBefore = await readOpfs(page, 'Al-jabr-1.note');
await chooseSaveTarget(page, 'saveas-copy.note');
const saveAs = await page.evaluate(async () => {
  const ok = await window.app.saveAs();
  await new Promise((r) => setTimeout(r, 1500));
  return { ok, modified: window.app.modified, name: window.app.editor.doc.name };
});
const originalAfter = await readOpfs(page, 'Al-jabr-1.note');
const copy = await readOpfs(page, 'saveas-copy.note');
check('另存为不影响原文件',
  originalBefore.size === originalAfter.size,
  `${originalBefore.size} → ${originalAfter.size}`);
check('另存为的副本保留全部条目',
  copy.entries.length >= originalBefore.entries.length,
  `${originalBefore.entries.length} → ${copy.entries.length}`);
if (saveAs.ok !== true || saveAs.modified !== false) console.log('   另存为状态:', JSON.stringify(saveAs));

const saveAsUi = await page.evaluate(() => {
  const titles = [...document.querySelectorAll('.wb-titleactions .wb-btn')].map((b) => b.title);
  return titles.some((t) => t.includes('另存为'));
});
check('标题栏有「另存为」按钮', saveAsUi);

/* ---------------------------------------------------------------- *
 * Where a page is framed when it has no PDF backdrop
 * ---------------------------------------------------------------- */
console.log('\n[9] 无 PDF 背景的页面从左上角开始显示');
const framing = await page.evaluate(async () => {
  const ed = window.app.editor;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  const mkPage = (pdf, blocks) => ({
    elements: blocks.map(([x, y, w, h]) => els.makePointsElement(els.T.RECT, {
      stroke: '#FF1F1F1F', width: 2, closed: true,
      points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
    })),
    scale: 1,
    pdfPages: pdf ? [{ pageNumber: 1, bounds: `${pdf.x},${pdf.y},${pdf.w},${pdf.h}` }] : [],
  });
  // a wide collage without a backdrop, a narrow sketch without one, a PDF page
  // whose content stays on the paper, and two pages whose content spills out of
  // the paper (the shape real boards have: scans pasted next to each other)
  const wide = mkPage(null, [[-200, -100, 1200, 900], [1100, -100, 1200, 900], [2000, 900, 1200, 900]]);
  const narrow = mkPage(null, [[400, 300, 300, 200]]);
  const framed = mkPage({ x: 0, y: 0, w: 1437, h: 2040 }, [[100, 100, 300, 200]]);
  // PDF pages: one whose ink spills far outside the paper, one whose paper sits
  // above its content, and one with no ink at all — all keep the paper view
  const spill = mkPage({ x: 285, y: 103, w: 1437, h: 2040 }, [[-173, -93, 1200, 900], [1100, 700, 1400, 1900]]);
  const paperAbove = mkPage({ x: 0, y: -900, w: 1437, h: 2040 }, [[0, 0, 1100, 900], [1200, 200, 1100, 900]]);
  const emptyPaper = mkPage({ x: 0, y: 0, w: 1437, h: 2040 }, []);
  // …and one whose PDF sheet is *all white*: that counts as no backdrop at all,
  // so the content decides the framing (real boards: Al-jabr-2 pages 228/302).
  // The flag itself is filled in by the app once it has looked at the sheet.
  const blankSheet = mkPage({ x: 285, y: 103, w: 1437, h: 2040 }, [[-173, -93, 1200, 900], [1100, 700, 1400, 1900]]);
  // real boards (Al-jabr-2 page 555): the leftmost column starts lower than a
  // column further right — the page must start at the *leftmost* column
  const tallerRight = mkPage(null, [[0, 300, 800, 1600], [950, -400, 800, 2400]]);
  ed.doc.pages = [wide, narrow, framed, spill, paperAbove, tallerRight, emptyPaper, blankSheet];
  ed.doc.currentPage = 0;

  /** Screen position of the top-left corner of a page's content. */
  const corner = (i) => {
    const b = ed.boundsOfPage(i);
    return { p: ed.worldToScreen(b.left, b.top), frame: { x: b.x, y: b.y, w: b.w, h: b.h } };
  };
  const out = {};
  for (const [name, index] of [
    ['wide', 0], ['narrow', 1], ['framed', 2], ['spill', 3],
    ['paperAbove', 4], ['tallerRight', 5], ['emptyPaper', 6], ['blankSheet', 7],
  ]) {
    ed.camera.zoom = 0.8;
    ed.gotoPage(index);
    await new Promise((r) => setTimeout(r, 150));
    const c = corner(index);
    out[name] = {
      zoom: ed.camera.zoom,
      screenX: Math.round(c.p.x),
      screenY: Math.round(c.p.y),
      viewW: ed.view.w,
      frameW: Math.round(c.frame.w),
      // what a centred view would have shown instead
      centredX: Math.round(c.p.x + (ed.view.w / 2 / ed.camera.zoom - c.frame.w / 2) * ed.camera.zoom),
    };
  }
  // 显示整页 must still frame everything (centred), wide page or not
  ed.gotoPage(0);
  ed.fitPage();
  await new Promise((r) => setTimeout(r, 150));
  const fit = corner(0);
  out.fit = {
    screenX: Math.round(fit.p.x),
    screenY: Math.round(fit.p.y),
    zoom: Number(ed.camera.zoom.toFixed(3)),
    visible: fit.frame.w * ed.camera.zoom <= ed.view.w + 1,
  };
  void Rect;
  return out;
});
check('无 PDF 且内容比窗口宽：视口对到内容的左上角（不再从中段开始）',
  Math.abs(framing.wide.screenX - 12) <= 2 && Math.abs(framing.wide.screenY - 12) <= 2
  && framing.wide.centredX < -100,
  JSON.stringify(framing.wide));
check('无 PDF 的页面一律从左上角开始（内容窄时也一样）',
  Math.abs(framing.narrow.screenX - 12) <= 2 && Math.abs(framing.narrow.screenY - 12) <= 2,
  JSON.stringify(framing.narrow));
check('带 PDF 背景的页面仍然居中（纸面框住窗口）',
  Math.abs(framing.framed.screenX - (framing.framed.viewW - framing.framed.frameW * 0.8) / 2) <= 3,
  JSON.stringify(framing.framed));
check('「显示整页」(Ctrl+Shift+0) 依然把整页框进窗口',
  framing.fit.visible === true && framing.fit.zoom < 0.8,
  JSON.stringify(framing.fit));

// pages 228 和 302 of a real board: a blank PDF sheet with scans pasted over it,
// spilling far outside the paper — those must start at the content too
const spill = await page.evaluate(async () => {
  const ed = window.app.editor;
  const els = await import('/js/elements.js');
  const out = {};
  for (const [name, index] of [['spill', 3], ['paperAbove', 4]]) {
    ed.camera.zoom = 0.8;
    ed.gotoPage(index);
    await new Promise((r) => setTimeout(r, 150));
    const p = ed.doc.pages[index];
    let content = null;
    for (const e of p.elements) {
      const b = els.elementBounds(e);
      content = content ? content.union(b) : b;
    }
    const screen = ed.worldToScreen(content.left, content.top);
    const union = ed.boundsOfPage(index);
    const paper = ed.doc.pages[index].pdfPages[0].bounds.split(',').map(Number);
    out[name] = {
      contentOnScreen: { x: Math.round(screen.x), y: Math.round(screen.y) },
      content: { x: Math.round(content.x), y: Math.round(content.y), w: Math.round(content.w), h: Math.round(content.h) },
      frame: { x: Math.round(union.x), y: Math.round(union.y), w: Math.round(union.w), h: Math.round(union.h) },
      paper: { x: paper[0], y: paper[1], w: paper[2], h: paper[3] },
    };
  }
  return out;
});
// Pages with a PDF backdrop keep the view they always had: the sheet of paper,
// centred, its top at the top — no matter what was drawn or pasted on it.
const paperView = await page.evaluate(async () => {
  const ed = window.app.editor;
  const out = {};
  for (const [name, index] of [['spill', 3], ['paperAbove', 4], ['emptyPaper', 6]]) {
    ed.camera.zoom = 0.8;
    ed.gotoPage(index);
    await new Promise((r) => setTimeout(r, 150));
    const p = ed.doc.pages[index];
    const paper = p.pdfPages[0].bounds.split(',').map(Number);
    const frame = ed.boundsOfPage(index);
    const corner = ed.worldToScreen(frame.left, frame.top);
    out[name] = {
      frameW: Math.round(frame.w),
      paperW: Math.round(paper[2]),
      frameOnScreen: { x: Math.round(corner.x), y: Math.round(corner.y) },
      centredX: (ed.view.w - frame.w * ed.camera.zoom) / 2,
      elements: p.elements.length,
    };
  }
  return out;
});
check('有 PDF 背景的页面按纸面显示（笔迹溢出纸外也不改）',
  paperView.spill.frameW === paperView.spill.paperW
  && Math.abs(paperView.spill.frameOnScreen.x - paperView.spill.centredX) <= 2
  && Math.abs(paperView.spill.frameOnScreen.y - 12) <= 2,
  JSON.stringify(paperView.spill));
check('纸面比内容更靠上时同样按纸面显示',
  paperView.paperAbove.frameW === paperView.paperAbove.paperW
  && Math.abs(paperView.paperAbove.frameOnScreen.x - paperView.paperAbove.centredX) <= 2,
  JSON.stringify(paperView.paperAbove));
check('有 PDF 背景但没有笔迹的页面，显示方式和以前一模一样',
  paperView.emptyPaper.elements === 0
  && paperView.emptyPaper.frameW === paperView.emptyPaper.paperW
  && Math.abs(paperView.emptyPaper.frameOnScreen.x - paperView.emptyPaper.centredX) <= 2
  && Math.abs(paperView.emptyPaper.frameOnScreen.y - 12) <= 2,
  JSON.stringify(paperView.emptyPaper));

// A PDF sheet that is blank white is not a backdrop: such a page is framed by
// its content, exactly like a page without any PDF at all.  The page is built
// here so nothing can have looked at it before, and the PDF detector is stubbed
// because a synthetic page has no real sheet behind it (the real detector runs
// against a sample board in e2e.mjs).
const blankSheet = await page.evaluate(async () => {
  const ed = window.app.editor;
  const els = await import('/js/elements.js');
  const box = (x, y, w, h) => els.makePointsElement(els.T.RECT, {
    stroke: '#FF1F1F1F', width: 2, closed: true,
    points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
  });
  const real = ed.pdf.pageIsBlank.bind(ed.pdf);
  window.__blankCalls = [];
  ed.pdf.pageIsBlank = async (n) => { window.__blankCalls.push(n); return true; };
  ed.doc.pages = [{
    elements: [box(-173, -93, 1200, 900), box(1100, 700, 1400, 1900)],
    scale: 1,
    pdfPages: [{ pageNumber: 2, bounds: '285,103,1437,2040' }],
  }];
  ed.doc.currentPage = 0;
  ed.camera.zoom = 0.8;
  ed.gotoPage(0);
  const p = ed.doc.pages[0];
  for (let i = 0; i < 60 && p.blankBackdrop !== true; i++) await new Promise((r) => setTimeout(r, 50));
  const frame = ed.boundsOfPage(0);
  let content = null;
  for (const e of p.elements) {
    const b = els.elementBounds(e);
    content = content ? content.union(b) : b;
  }
  const s = ed.worldToScreen(content.left, content.top);
  const out = {
    blankBackdrop: p.blankBackdrop,
    calls: window.__blankCalls,
    frameW: Math.round(frame.w),
    paperW: 1437,
    contentOnScreen: { x: Math.round(s.x), y: Math.round(s.y) },
    centred: ed.anchorOfPage(0).centred,
  };
  ed.pdf.pageIsBlank = real;
  return out;
});
check('PDF 背景全白的页面按内容取景（不是围着一张空纸）',
  blankSheet.blankBackdrop === true && blankSheet.calls.length > 0
  && blankSheet.centred === false && blankSheet.frameW > blankSheet.paperW
  && Math.abs(blankSheet.contentOnScreen.x - 12) <= 2 && Math.abs(blankSheet.contentOnScreen.y - 12) <= 2,
  JSON.stringify(blankSheet));

/* ---------------------------------------------------------------- *
 * A new page starts at the top-left, and so does a picture pasted on it
 * ---------------------------------------------------------------- */
console.log('\n[10] 新建空白页 + 粘贴图片');
const pasteFlow = await page.evaluate(async () => {
  const app = window.app;
  const ed = app.editor;
  const els = await import('/js/elements.js');
  const box = (x, y, w, h) => els.makePointsElement(els.T.RECT, {
    stroke: '#FF1F1F1F', width: 2, closed: true,
    points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
  });
  // a backdrop-less page with content (like page 302), then a fresh page after it
  ed.doc.pages = [
    { elements: [box(-183, -96, 1200, 900), box(1100, 700, 1400, 1900)], scale: 1, pdfPages: [], blankBackdrop: true },
    { elements: [], scale: 1, pdfPages: [] },
  ];
  ed.doc.currentPage = 0;
  ed.camera.zoom = 0.8;
  ed.gotoPage(0);
  await new Promise((r) => setTimeout(r, 200));
  ed.addPageAfter(0);
  await new Promise((r) => setTimeout(r, 350));
  const fresh = {
    index: ed.pageIndex,
    elements: ed.page.elements.length,
    originOnScreen: (() => { const s = ed.worldToScreen(0, 0); return { x: Math.round(s.x), y: Math.round(s.y) }; })(),
  };
  const c = document.createElement('canvas');
  c.width = 640; c.height = 400;
  const g = c.getContext('2d');
  g.fillStyle = '#0169BF'; g.fillRect(0, 0, 640, 400);
  await app.insertImageBlob(await new Promise((r) => c.toBlob(r, 'image/png')));
  await new Promise((r) => setTimeout(r, 400));
  const img = ed.page.elements.find((e) => e.type === 300001);
  const b = els.elementBounds(img);
  const tl = ed.worldToScreen(b.left, b.top);
  // leaving the page and coming back must frame the same corner
  ed.gotoPage(0);
  await new Promise((r) => setTimeout(r, 200));
  ed.gotoPage(1);
  await new Promise((r) => setTimeout(r, 350));
  const again = ed.worldToScreen(b.left, b.top);
  return {
    fresh,
    image: { x: Math.round(b.x), y: Math.round(b.y) },
    imageTopLeftOnScreen: { x: Math.round(tl.x), y: Math.round(tl.y) },
    afterReopen: { x: Math.round(again.x), y: Math.round(again.y) },
    docPages: ed.doc.pages.length,
  };
});
check('新建的空白页：页面原点就在窗口左上角（不居中）',
  pasteFlow.fresh.elements === 0
  && Math.abs(pasteFlow.fresh.originOnScreen.x - 12) <= 3
  && Math.abs(pasteFlow.fresh.originOnScreen.y - 12) <= 3,
  JSON.stringify(pasteFlow.fresh));
check('在这页上粘贴图片：图片落在页面左上角（不是屏幕正中）',
  pasteFlow.image.x >= 0 && pasteFlow.image.x < 40 && pasteFlow.image.y >= 0 && pasteFlow.image.y < 40
  && pasteFlow.imageTopLeftOnScreen.x < 60 && pasteFlow.imageTopLeftOnScreen.y < 60,
  JSON.stringify(pasteFlow));
check('离开再回到这页，仍然从左上角显示',
  Math.abs(pasteFlow.afterReopen.x - 12) <= 3 && Math.abs(pasteFlow.afterReopen.y - 12) <= 3,
  JSON.stringify(pasteFlow.afterReopen));

/* ---------------------------------------------------------------- *
 * 10b. A page's start is the point the view is framed from
 *
 * A picture pasted on an empty page goes to the page's start, so that start
 * has to be the same point the page is framed from — otherwise the picture
 * lands somewhere the user is not looking at.  Pages begin in different
 * places: at their sheet's top-left when the sheet is a backdrop, and at the
 * world origin when the sheet turned out to be a blank white page (not a
 * backdrop) or when there is no PDF at all.
 * ---------------------------------------------------------------- */
console.log('\n[10b] 页面起点 = 取景锚点');
const startFlow = await page.evaluate(async () => {
  const app = window.app;
  const ed = app.editor;
  const Z = 0.8;
  const MARGIN = 12 / Z;
  // a sheet that sits far from the world origin, so "started at the sheet"
  // and "started at the origin" cannot be confused
  const sheet = [{ bounds: '600,400,1600,2272', pageNumber: 1 }];
  const blob = async () => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const g = c.getContext('2d');
    g.fillStyle = '#0169BF'; g.fillRect(0, 0, 400, 300);
    return new Promise((r) => c.toBlob(r, 'image/png'));
  };
  const probe = async (page) => {
    ed.doc.pages = [{ elements: [], scale: 1, ...page }];
    ed.doc.currentPage = 0;
    ed.camera.zoom = Z;
    ed.gotoPage(0);
    ed.centerPage(); // framing is what is under test here, not gotoPage's early-out
    await new Promise((r) => setTimeout(r, 200));
    const start = ed.pageStart();
    const anchor = ed.anchorOfPage(0);
    const s = ed.worldToScreen(start.x, start.y);
    await app.insertImageBlob(await blob());
    await new Promise((r) => setTimeout(r, 300));
    const els = await import('/js/elements.js');
    const img = ed.page.elements.find((e) => e.type === 300001);
    const b = els.elementBounds(img);
    return {
      start,
      anchor: { left: anchor.left, top: anchor.top, centred: anchor.centred },
      startOnScreen: { x: Math.round(s.x), y: Math.round(s.y) },
      image: { x: b.left, y: b.top },
      margin: MARGIN,
    };
  };
  return {
    painted: await probe({ pdfPages: sheet, blankBackdrop: false, _blankProbe: '1' }),
    blank: await probe({ pdfPages: sheet, blankBackdrop: true, _blankProbe: '1' }),
    none: await probe({ pdfPages: [] }),
  };
});
const near = (a, b) => Math.abs(a - b) < 0.01;
const samePoint = (p, x, y) => p.start.x === x && p.start.y === y
  && p.anchor.left === x && p.anchor.top === y
  && near(p.image.x, x + p.margin) && near(p.image.y, y + p.margin);
check('有 PDF 背景的空页：起点是纸面左上角，粘贴也落在纸面左上角',
  startFlow.painted.anchor.centred === true && samePoint(startFlow.painted, 600, 400),
  JSON.stringify(startFlow.painted));
check('PDF 背景全白的空页：纸面不算背景，起点是世界原点（不是纸面的角落）',
  startFlow.blank.anchor.centred === false && samePoint(startFlow.blank, 0, 0)
  && Math.abs(startFlow.blank.startOnScreen.x - 12) <= 3,
  JSON.stringify(startFlow.blank));
check('没有 PDF 的空页：起点是世界原点，粘贴也落在原点',
  startFlow.none.anchor.centred === false && samePoint(startFlow.none, 0, 0)
  && Math.abs(startFlow.none.startOnScreen.x - 12) <= 3,
  JSON.stringify(startFlow.none));

await page.screenshot({ path: path.join(SHOTS, 'r3-final.png') });
await browser.close();
await fixtures.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { console.log('失败项：'); failed.forEach((f) => console.log('  ✗', f.name, f.detail)); }
const realErrors = errors.filter((e) => !e.includes('favicon'));
if (realErrors.length) { console.log('\n控制台错误：'); [...new Set(realErrors)].slice(0, 15).forEach((e) => console.log('  ' + e)); }
fs.writeFileSync(path.join(SHOTS, 'round3-report.json'), JSON.stringify({ results, errors }, null, 2));
process.exitCode = failed.length || realErrors.length ? 1 : 0;
