/**
 * 界面文案回归测试：文案里不留括号。
 *
 * 产品要求是界面上的说明文字不写括号里的补充说明，所以这里把每一个能看到的
 * 界面都打开一遍 —— 工具栏按钮提示、各个悬浮面板、颜色面板、对话框、页面面板、
 * 快捷键帮助、状态栏、所选操作栏、以及各种提示条 —— 收集可见文字与 title /
 * aria-label，然后检查里面没有括号。
 *
 *   node test/wording.mjs [--chrome <path>] [--url http://127.0.0.1:8787/]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHROME = arg('chrome', path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');

const profileDir = path.join(__dirname, '.chrome-profile-wording');
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
  protocolTimeout: 600000,
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
 * A board with one of everything, so every panel and the selection bar exist
 * ---------------------------------------------------------------- */
console.log('\n[1] 造一页内容');
const built = await page.evaluate(async () => {
  const app = window.app;
  const ed = app.editor;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  ed.background.style = 'none';
  ed.page.elements = [];
  const rect = els.makePointsElement(els.T.RECT, {
    stroke: '#FF1F1F1F', width: 4, closed: true,
    points: [{ x: 40, y: 40 }, { x: 340, y: 40 }, { x: 340, y: 240 }, { x: 40, y: 240 }],
  });
  ed.addElement(rect, { select: false });
  const sticky = els.makeSticky({ bounds: new Rect(420, 40, 200, 160) });
  sticky.text = '便签';
  ed.addElement(sticky, { select: false });
  const text = els.makeText({ bounds: new Rect(40, 300, 320, 120), text: '文本', fontSize: 24 });
  ed.addElement(text, { select: false });
  ed.addElement(els.makeImage({ bounds: new Rect(420, 300, 160, 120), fileName: 'none.png' }), { select: false });
  ed.selection.clear();
  ed.selection.add(rect);
  ed.selection.add(sticky);
  app.ui.syncSelection();
  app.ui.selectionBar.update();
  await new Promise((r) => setTimeout(r, 250));
  return { elements: ed.page.elements.length };
});
check('一页上有形状 / 便签 / 文本 / 图片', built.elements === 4, String(built.elements));

/* ---------------------------------------------------------------- *
 * Every surface, one by one
 * ---------------------------------------------------------------- */
console.log('\n[2] 逐个打开界面，扫描文案');
const HINT = /（[^）]*）|\([^)]*\)/;

const scan = () => page.evaluate(() => {
  const out = [];
  const push = (where, text) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t) out.push({ where, text: t });
  };
  for (const n of document.querySelectorAll('[title]')) push('title', n.getAttribute('title'));
  for (const n of document.querySelectorAll('[aria-label]')) push('aria', n.getAttribute('aria-label'));
  for (const n of document.querySelectorAll('[placeholder]')) push('placeholder', n.getAttribute('placeholder'));
  for (const sel of ['.wb-flyout', '.wb-dialog', '.wb-toasts', '.wb-pages', '.wb-shortcuts',
    '.wb-status', '.wb-zoom', '.wb-pagenav', '.wb-selbar', '.wb-toolbar']) {
    // a button's own label is its tooltip, already collected above via [title]
    for (const n of document.querySelectorAll(sel)) push(sel, n.innerText);
  }
  return out;
});

/** Open one surface, look at its copy, then look again with the colour panel open. */
async function surface(label, open) {
  await page.evaluate(async () => {
    window.app.ui.closeFlyout?.();
    window.app.ui.closeDialog?.();
    await new Promise((r) => setTimeout(r, 120));
  });
  try {
    await page.evaluate(open);
  } catch (err) {
    check(`${label}：可以打开`, false, err.message);
    return;
  }
  await sleep(380);
  let items = await scan();
  let bad = items.filter((i) => HINT.test(i.text));
  const picked = await page.evaluate(async () => {
    const t = document.querySelector('.wb-flyout .wb-color-toggle');
    if (!t) return false;
    t.click();
    await new Promise((r) => setTimeout(r, 250));
    return true;
  });
  if (picked) {
    const more = await scan();
    items = items.concat(more);
    bad = bad.concat(more.filter((i) => HINT.test(i.text)));
  }
  const uniq = [...new Map(bad.map((b) => [b.text, b])).values()];
  check(`${label}：${items.length} 条文案里没有括号`, uniq.length === 0,
    uniq.map((u) => `${u.where}: ${u.text.slice(0, 80)}`).join(' | '));
}

await surface('初始界面', () => {});
await surface('工具栏提示', () => {
  // every toolbar button's tooltip is in the document already; also hover one
  const b = document.querySelector('.wb-toolbar button');
  b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
});
await surface('笔', () => window.app.ui.openPenFlyout(window.app.ui.toolButtons.pen));
await surface('荧光笔', () => window.app.ui.openHighlighterFlyout(window.app.ui.toolButtons.highlighter));
await surface('橡皮擦', () => window.app.ui.openEraserFlyout(window.app.ui.toolButtons.eraser));
await surface('形状', () => window.app.ui.openShapeFlyout(window.app.ui.toolButtons.shape));
await surface('文本', () => window.app.ui.openTextFlyout(window.app.ui.toolButtons.text));
await surface('便签', () => window.app.ui.openStickyFlyout(window.app.ui.toolButtons.sticky));
await surface('画布背景', () => {
  const b = [...document.querySelectorAll('.wb-toolbar button')].find((n) => (n.title || '').startsWith('画布背景'));
  window.app.ui.openBackgroundFlyout(b);
});
await surface('设置', () => window.app.ui.openSettingsFlyout(window.app.ui.settingsBtn));
await surface('更多', () => window.app.ui.openMoreFlyout(window.app.ui.moreBtn));
await surface('导出', () => window.app.ui.openExportDialog());
await surface('打开', () => window.app.showOpenDialog());
await surface('快捷键帮助', () => window.app.ui.showShortcuts());
await surface('页面面板', () => window.app.ui.togglePages(true));
await surface('复制到指定页', () => {
  const b = [...document.querySelectorAll('.wb-selbar .wb-selbtn')].find((n) => (n.title || '').includes('复制到指定页'));
  b.click();
});
await surface('右键菜单', () => {
  const ed = window.app.editor;
  ed.selection.clear();
  window.app.ui.syncSelection();
  window.app.ui.openContextMenu({ clientX: 400, clientY: 300, preventDefault() {}, target: document.querySelector('#wb-canvas') });
});

/* ---------------------------------------------------------------- *
 * The toast lines the app writes while working
 * ---------------------------------------------------------------- */
console.log('\n[3] 提示条文案');
const toasts = await page.evaluate(async () => {
  const app = window.app;
  const ed = app.editor;
  const ui = app.ui;
  const seen = [];
  const grab = () => { seen.push(...document.querySelectorAll('.wb-toasts .wb-toast')); };
  const step = async (fn) => {
    document.querySelectorAll('.wb-toasts .wb-toast').forEach((n) => n.remove());
    fn();
    await new Promise((r) => setTimeout(r, 250));
    grab();
  };
  await step(() => app.setAutoSave(5));
  await step(() => app.fitSelectionCurves());          // nothing selected
  await step(() => { ed.selection.clear(); ed.selection.add(ed.page.elements[0]); ui.syncSelection(); app.deleteSelection(); });
  await step(() => app.clearPage());
  await step(() => app.compactCurrentNote());          // no writable handle yet
  const text = [...new Set(seen.map((n) => n.innerText.replace(/\s+/g, ' ').trim()))];
  document.querySelectorAll('.wb-toasts .wb-toast').forEach((n) => n.remove());
  return { text, hasOpen: !!document.querySelector('.wb-dialog') };
});
const badToasts = toasts.text.filter((t) => HINT.test(t));
check(`提示条：${toasts.text.length} 条文案里没有括号`, badToasts.length === 0,
  badToasts.join(' | ') || toasts.text.map((t) => t.slice(0, 40)).join(' · '));

/* ---------------------------------------------------------------- *
 * Dialogs the app opens on its own, and the modified-document prompt
 * ---------------------------------------------------------------- */
console.log('\n[4] 自动弹出的对话框');
const confirmText = await page.evaluate(async () => {
  const app = window.app;
  app.modified = true;                       // make the app ask before switching boards
  app.confirmDiscard('打开其他文件');          // resolves when the user answers
  await new Promise((r) => setTimeout(r, 300));
  const dlg = document.querySelector('.wb-dialog');
  const out = {
    title: dlg?.querySelector('.wb-dialog-head h3')?.textContent || '',
    text: dlg?.innerText || '',
    buttons: [...(dlg?.querySelectorAll('.wb-dialog-foot button') || [])].map((b) => b.textContent),
  };
  dlg?.querySelector('.wb-dialog-foot button')?.click();
  await new Promise((r) => setTimeout(r, 150));
  app.modified = false;
  app.ui.closeDialog();
  return out;
});
check('确认框：文案里没有括号', confirmText.title.length > 0
  && !HINT.test(confirmText.title) && !HINT.test(confirmText.text)
  && confirmText.buttons.every((b) => !HINT.test(b)),
  `${confirmText.title} / ${confirmText.buttons.join(' ')} / ${confirmText.text.slice(0, 60)}`);

await page.screenshot({ path: path.join(SHOTS, 'wording.png') });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { console.log('失败项：'); failed.forEach((f) => console.log('  ✗', f.name, f.detail)); }
const realErrors = errors.filter((e) => !e.includes('favicon'));
if (realErrors.length) { console.log('\n控制台错误：'); [...new Set(realErrors)].slice(0, 15).forEach((e) => console.log('  ' + e)); }
fs.writeFileSync(path.join(SHOTS, 'wording-report.json'), JSON.stringify({ results, errors }, null, 2));
process.exitCode = failed.length || realErrors.length ? 1 : 0;
