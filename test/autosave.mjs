/**
 * Auto-save regression test.
 *
 * Covers the settings entry (interval choices, persistence across a reload),
 * the real timer writing the open file, and the cases where it must stay out
 * of the way: no changes, no file on disk yet, and text being edited.
 *
 * Usage:  node test/autosave.mjs [--chrome <path>] [--url http://127.0.0.1:8787/]
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

const profileDir = path.join(__dirname, '.chrome-profile-autosave');
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
 * 1. Settings entry
 * ---------------------------------------------------------------- */
console.log('\n[1] 设置面板');
const panel = await page.evaluate(() => {
  const ui = window.app.ui;
  ui.openSettingsFlyout(ui.settingsBtn);
  const rows = [...document.querySelectorAll('.wb-flyout .wb-chiprow')];
  const labels = [...document.querySelectorAll('.wb-flyout .wb-chip')].map((b) => b.textContent);
  const active = [...document.querySelectorAll('.wb-flyout .wb-chip.active')].map((b) => b.textContent);
  return { rows: rows.length, labels, active, hint: document.querySelector('.wb-flyout .wb-hint')?.textContent || '' };
});
const wants = ['关闭', '1 分钟', '2 分钟', '5 分钟', '10 分钟', '30 分钟', '1 小时'];
check('设置里有自动保存的 7 个选项', wants.every((w) => panel.labels.includes(w)), panel.labels.join(' / '));
check('默认是「关闭」', panel.active.includes('关闭') && await page.evaluate(() => window.app.autoSaveMinutes === 0), panel.active.join(','));

const byLabel = (label) => page.evaluate((l) => {
  const btn = [...document.querySelectorAll('.wb-flyout .wb-chip')].find((b) => b.textContent === l);
  btn.click();
  return {
    minutes: window.app.autoSaveMinutes,
    active: [...document.querySelectorAll('.wb-flyout .wb-chip.active')].map((b) => b.textContent),
    status: document.querySelector('.wb-status-right')?.textContent || '',
  };
}, label);

const picked = await byLabel('5 分钟');
check('选 5 分钟即生效', picked.minutes === 5 && picked.active.includes('5 分钟'), JSON.stringify(picked.active));
check('底栏显示自动保存状态', picked.status.includes('自动保存 5 分钟'), picked.status);

const stored = await page.evaluate(async () => (await import('/js/prefs.js')).getPref('autoSaveMinutes', null));
check('设置写进 localStorage', stored === 5, String(stored));

/* ---------------------------------------------------------------- *
 * 2. It survives a reload
 * ---------------------------------------------------------------- */
console.log('\n[2] 重新加载后仍然有效');
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(1200);
const afterReload = await page.evaluate(() => ({
  minutes: window.app.autoSaveMinutes,
  status: document.querySelector('.wb-status-right')?.textContent || '',
}));
check('刷新后间隔被记住', afterReload.minutes === 5, String(afterReload.minutes));
check('刷新后底栏也显示', afterReload.status.includes('自动保存 5 分钟'), afterReload.status);

/* ---------------------------------------------------------------- *
 * 3. The timer really writes the file
 * ---------------------------------------------------------------- */
console.log('\n[3] 定时写盘');
// Count saves without changing behaviour.
await page.evaluate(() => {
  const app = window.app;
  window.__saves = 0;
  const orig = app.save.bind(app);
  app.save = (opts) => { window.__saves++; return orig(opts); };
  window.__savedOpts = [];
});

const NOTE = '.cache/autosave.note';
const prepare = await page.evaluate(async (target) => {
  const app = window.app;
  const ed = app.editor;
  ed.doc.path = target;
  ed.doc.name = 'autosave';
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  ed.page.elements = [];
  ed.addElement(els.makeText({ bounds: new Rect(60, 60, 400, 60).toString(), text: '第一版', fontSize: 28, textColor: '#FF000000' }), { select: false });
  await app.save();
  app.setAutoSave(0.02); // 1.2 s: the real timer, just faster
  window.__saves = 0;
  return { modified: app.modified, elements: ed.page.elements.length };
}, NOTE);
check('测试文件写好且处于干净状态', prepare.modified === false, JSON.stringify(prepare));

// (a) nothing to do -> no write
await sleep(2600);
let saves = await page.evaluate(() => window.__saves);
check('没有改动时不会写盘', saves === 0, `saves=${saves}`);

// (b) one edit -> one write, and the file on disk really changed
const before = await page.evaluate(async (target) => {
  const res = await fetch('/api/note/pages?path=' + encodeURIComponent(target));
  const json = await res.json();
  return json.pages['Pages/page1.json'].elements.length;
}, NOTE);

await page.evaluate(async () => {
  const app = window.app;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  app.editor.addElement(els.makeText({ bounds: new Rect(60, 200, 400, 60).toString(), text: '第二版', fontSize: 28, textColor: '#FF000000' }), { select: false });
});
await sleep(2600);
const afterTick = await page.evaluate(async (target) => {
  const res = await fetch('/api/note/pages?path=' + encodeURIComponent(target));
  const json = await res.json();
  return { elements: json.pages['Pages/page1.json'].elements.length, saves: window.__saves, modified: window.app.modified };
}, NOTE);
check('有改动时按间隔自动写盘', afterTick.saves === 1, `saves=${afterTick.saves}`);
check('磁盘上的文件确实更新了', afterTick.elements === before + 1, `${before} → ${afterTick.elements} 个元素`);
check('自动保存后脏标记被清掉', afterTick.modified === false, String(afterTick.modified));

// (c) turning it off stops the timer
await page.evaluate(() => window.app.setAutoSave(0));
await page.evaluate(async () => {
  const app = window.app;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  app.editor.addElement(els.makeText({ bounds: new Rect(60, 320, 400, 60).toString(), text: '第三版', fontSize: 28, textColor: '#FF000000' }), { select: false });
});
await sleep(2400);
const offState = await page.evaluate(() => ({ saves: window.__saves, modified: window.app.modified }));
check('关闭后不再自动写盘', offState.saves === 1 && offState.modified === true, JSON.stringify(offState));

/* ---------------------------------------------------------------- *
 * 4. Cases where it must stay out of the way
 * ---------------------------------------------------------------- */
console.log('\n[4] 不该打扰用户的情况');
const noPath = await page.evaluate(async () => {
  const app = window.app;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  app.editor.doc.path = null;              // 从未保存过的新白板
  app.setAutoSave(0.02);
  window.__saves = 0;
  app.editor.addElement(els.makeText({ bounds: new Rect(60, 440, 400, 60).toString(), text: '未保存的新白板', fontSize: 28, textColor: '#FF000000' }), { select: false });
  await new Promise((r) => setTimeout(r, 2400));
  const tick = await app.autoSaveTick();
  return { saves: window.__saves, tick, modified: app.modified };
});
check('没有文件路径时不会偷偷新建文件', noPath.saves === 0 && noPath.tick === false, JSON.stringify(noPath));

const duringEdit = await page.evaluate(async (target) => {
  const app = window.app;
  const ed = app.editor;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  // Put a text box on disk again, then edit it the way the UI does.
  ed.doc.path = target;
  ed.page.elements = [];
  const text = els.makeText({ bounds: new Rect(60, 60, 500, 60).toString(), text: '编辑中', fontSize: 28, textColor: '#FF000000' });
  ed.addElement(text, { select: false });
  await app.save();
  app.setAutoSave(0.02);
  window.__saves = 0;

  ed.editElement(text, {});
  await new Promise((r) => setTimeout(r, 300));
  const ta = document.querySelector('.wb-inline-textarea');
  ta.value = '编辑中 $x^2$';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 2400));
  return {
    editing: !!ed.inline.current,
    text: text.text,
    saves: window.__saves,
    modified: app.modified,
  };
}, NOTE);
check('输入文字时不会把编辑器抢走', duringEdit.editing === true, JSON.stringify({ editing: duringEdit.editing }));
check('但内容照常写盘', duringEdit.saves === 1 && duringEdit.modified === false, JSON.stringify({ saves: duringEdit.saves }));

const onDisk = await page.evaluate(async (target) => {
  const res = await fetch('/api/note/pages?path=' + encodeURIComponent(target));
  const json = await res.json();
  return json.pages['Pages/page1.json'].elements.map((e) => e.text);
}, NOTE);
check('磁盘上是编辑中的最新文字', onDisk.includes('编辑中 $x^2$'), JSON.stringify(onDisk));

await page.evaluate(() => {
  window.app.editor.inline.commit(true);
  window.app.setAutoSave(0);
  window.app.editor.clearSelection();
  window.app.editor.draw();
});
await sleep(300);
await page.screenshot({ path: path.join(SHOTS, 'autosave.png') });
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
