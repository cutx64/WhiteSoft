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
 * Usage: node test/round3.mjs
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

/* ================================================================ *
 * 1. Immediate repaint on undo / redo / delete
 * ================================================================ */
console.log('\n[1] 撤销 / 删除即时渲染');
await page.evaluate(() => window.app.loadNote('Al-jabr-1.note', { confirm: false }));
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
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
await page.evaluate(() => window.app.loadNote('Al-jabr-1.note', { confirm: false }));
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

// start a load and inspect the dialog without resolving it
const prompt = await page.evaluate(async () => {
  const p = window.app.loadNote('Al-jabr-2.note');
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
  const p = window.app.loadNote('Al-jabr-2.note');
  await new Promise((r) => setTimeout(r, 400));
  const btn = [...document.querySelectorAll('.wb-modal button')].find((b) => b.textContent.trim() === '放弃更改');
  if (btn) btn.click();
  await p;
  await new Promise((r) => setTimeout(r, 1500));
  return { name: window.app.editor.doc.name, pages: window.app.editor.doc.pages.length, modified: window.app.modified };
});
check('放弃更改后载入新白板', discarded.name === 'Al-jabr-2' && discarded.pages === 655, JSON.stringify(discarded));

// a clean board loads without any prompt
const clean = await page.evaluate(async () => {
  const p = window.app.loadNote('Al-jabr-1.note');
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
  const res = await fetch('/api/note/document?path=' + encodeURIComponent('Al-jabr-1.note'));
  const blob = await res.blob();
  const file = new File([blob], 'x.pdf', { type: 'application/pdf' });
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
const saveAs = await page.evaluate(async () => {
  const ed = window.app.editor;
  const before = await (await fetch('/api/note/meta?path=' + encodeURIComponent('Al-jabr-1.note'))).json();
  ed.doc.path = '.cache/saveas-copy.note';
  ed.doc.sourcePath = 'Al-jabr-1.note';
  await window.app.save();
  await new Promise((r) => setTimeout(r, 1500));
  const after = await (await fetch('/api/note/meta?path=' + encodeURIComponent('Al-jabr-1.note'))).json();
  const copy = await (await fetch('/api/note/meta?path=' + encodeURIComponent('.cache/saveas-copy.note'))).json();
  return {
    originalSize: before.size, originalSizeAfter: after.size,
    originalEntries: before.entryCount, copyEntries: copy.entryCount, copySize: copy.size,
  };
});
check('另存为不影响原文件',
  saveAs.originalSize === saveAs.originalSizeAfter,
  `${saveAs.originalSize} → ${saveAs.originalSizeAfter}`);
check('另存为的副本保留全部条目',
  saveAs.copyEntries >= saveAs.originalEntries,
  `${saveAs.originalEntries} → ${saveAs.copyEntries}`);

const saveAsUi = await page.evaluate(() => {
  const titles = [...document.querySelectorAll('.wb-titleactions .wb-btn')].map((b) => b.title);
  return titles.some((t) => t.includes('另存为'));
});
check('标题栏有「另存为」按钮', saveAsUi);

await page.screenshot({ path: path.join(SHOTS, 'r3-final.png') });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { console.log('失败项：'); failed.forEach((f) => console.log('  ✗', f.name, f.detail)); }
const realErrors = errors.filter((e) => !e.includes('favicon'));
if (realErrors.length) { console.log('\n控制台错误：'); [...new Set(realErrors)].slice(0, 15).forEach((e) => console.log('  ' + e)); }
fs.writeFileSync(path.join(SHOTS, 'round3-report.json'), JSON.stringify({ results, errors }, null, 2));
process.exitCode = failed.length || realErrors.length ? 1 : 0;
