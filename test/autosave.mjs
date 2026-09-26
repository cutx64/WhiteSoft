/**
 * Auto-save regression test.
 *
 * Covers the settings entry (interval choices, persistence across a reload),
 * the real timer writing the open file, and the cases where it must stay out
 * of the way: no changes, no writable file yet, and text being edited.
 *
 * A board used to live in a server workspace; it is a local file now, so the
 * suite opens a real `.note` fixture the way the user does (fetched over HTTP,
 * handed to the page as a `File` + a writable OPFS `FileSystemFileHandle`) and
 * reads the bytes back out of that very file with `readOpfs` / a SHA-256 of the
 * file, instead of asking a server what it wrote.
 *
 * Usage:  node test/autosave.mjs [--chrome <path>] [--url http://127.0.0.1:8787/]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, openFixture, readOpfs } from './lib/local.mjs';

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
 * Fixture: a real, tiny `.note` the page can be handed like a file
 * ---------------------------------------------------------------- */
/** Build a small `.note` with the app's own writer and serve it over HTTP. */
async function startFixtures() {
  const b64 = await page.evaluate(async () => {
    const { ZipWriter } = await import('/js/zipwrite.js');
    const els = await import('/js/elements.js');
    const { Rect } = await import('/js/geometry.js');
    const chunks = [];
    const zip = new ZipWriter({ write: async (b) => { chunks.push(b); }, close: async () => {}, abort: async () => {} });
    const enc = new TextEncoder();
    const c = document.createElement('canvas');
    c.width = 200; c.height = 150;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0169BF'; ctx.fillRect(0, 0, 200, 150);
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(20, 20, 60, 60);
    const png = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
    const manifest = {
      id: 'autosave-seed', version: '1.0.0', screenWidthPixels: 2880, screenHeightPixels: 1920, screenScale: 2,
      pages: [{ fileName: 'page1.json' }], currentPage: 1,
      backgroundColor: '#FFFFFFFF', createTime: '2024-01-01 00:00:00',
    };
    const page1 = {
      elements: [
        els.makeText({ bounds: new Rect(80, 80, 400, 60).toString(), text: '种子白板', fontSize: 28 }),
        els.makeImage({ bounds: new Rect(80, 200, 200, 150), fileName: 'seed.png' }),
      ],
      scale: 1,
    };
    await zip.add('manifest.json', enc.encode(JSON.stringify(manifest)));
    await zip.add('Pages/page1.json', enc.encode(JSON.stringify(page1)));
    await zip.add('Resources/Images/seed.png', png);
    await zip.finish();
    const out = new Uint8Array(chunks.reduce((n, ch) => n + ch.length, 0));
    let off = 0;
    for (const ch of chunks) { out.set(ch, off); off += ch.length; }
    let s = '';
    for (const b of out) s += String.fromCharCode(b);
    return btoa(s);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whitesoft-autosave-'));
  fs.writeFileSync(path.join(dir, 'seed.note'), Buffer.from(b64, 'base64'));
  const server = await startFixtureServer(dir);
  return { ...server, tempDir: dir };
}

/** SHA-256 of the file on disk, plus its size — the cheapest "did it change?". */
const fileDigest = (name) => page.evaluate(async (fileName) => {
  const dir = await navigator.storage.getDirectory();
  const file = await (await dir.getFileHandle(fileName)).getFile();
  const buf = await file.arrayBuffer();
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return { size: file.size, hex };
}, name);

/** The texts the open board actually wrote into page 1 of a local file. */
const boardTexts = (name) => page.evaluate(async (fileName) => {
  const dir = await navigator.storage.getDirectory();
  const file = await (await dir.getFileHandle(fileName)).getFile();
  const { ZipReader } = await import('/js/zipread.js');
  const zip = await ZipReader.open(file);
  const page1 = await zip.json('Pages/page1.json');
  return (page1?.elements || []).map((e) => e.text).filter((t) => typeof t === 'string');
}, name);

/** Count writes without changing behaviour (safe to call more than once). */
const watchSaves = () => page.evaluate(() => {
  const app = window.app;
  if (window.__watched !== app) {
    window.__watched = app;
    window.__origSave = app.save.bind(app);
  }
  window.__saves = 0;
  app.save = (opts) => { window.__saves++; return window.__origSave(opts); };
});

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

const fixtures = await startFixtures();
const NOTE = 'autosave.note';

/* ---------------------------------------------------------------- *
 * 3. The timer really writes the file
 * ---------------------------------------------------------------- */
console.log('\n[3] 定时写盘');
const opened = await openFixture(page, fixtures.url('seed.note'), { name: NOTE });
await watchSaves();

const prepare = await page.evaluate(async () => {
  const app = window.app;
  const ed = app.editor;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  ed.page.elements = [];
  ed.addElement(els.makeText({ bounds: new Rect(60, 60, 400, 60).toString(), text: '第一版', fontSize: 28, textColor: '#FF000000' }), { select: false });
  const ok = await app.save();               // straight into the picked file
  await new Promise((r) => setTimeout(r, 300));
  app.setAutoSave(0.02);                     // 1.2 s: the real timer, just faster
  window.__saves = 0;
  return { ok, modified: app.modified, elements: ed.page.elements.length, name: ed.doc.name, hasHandle: !!ed.doc.fileHandle };
});
const preparedDisk = await readOpfs(page, NOTE);
check('测试文件写好且处于干净状态',
  opened.hasHandle === true && prepare.ok === true && prepare.modified === false
  && prepare.name === 'autosave' && (await boardTexts(NOTE)).includes('第一版'),
  JSON.stringify({ ...prepare, disk: preparedDisk.elements }));

// (a) nothing to do -> no write
const clean = await fileDigest(NOTE);
await sleep(2600);
const idle = { saves: await page.evaluate(() => window.__saves), disk: await fileDigest(NOTE) };
check('没有改动时不会写盘',
  idle.saves === 0 && idle.disk.hex === clean.hex && idle.disk.size === clean.size,
  `saves=${idle.saves}, size ${clean.size} → ${idle.disk.size}`);

// (b) one edit -> one write, and the file on disk really changed
const before = await fileDigest(NOTE);
const beforeCount = (await readOpfs(page, NOTE)).elements.length;

await page.evaluate(async () => {
  const app = window.app;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  app.editor.addElement(els.makeText({ bounds: new Rect(60, 200, 400, 60).toString(), text: '第二版', fontSize: 28, textColor: '#FF000000' }), { select: false });
});
await sleep(2600);
const afterTick = {
  saves: await page.evaluate(() => window.__saves),
  modified: await page.evaluate(() => window.app.modified),
  disk: await fileDigest(NOTE),
  opfs: await readOpfs(page, NOTE),
  texts: await boardTexts(NOTE),
};
check('有改动时按间隔自动写盘', afterTick.saves === 1, `saves=${afterTick.saves}`);
check('磁盘上的文件确实更新了',
  afterTick.opfs.elements.length === beforeCount + 1
  && afterTick.disk.hex !== before.hex && afterTick.texts.includes('第二版'),
  `${beforeCount} → ${afterTick.opfs.elements.length} 个元素，${before.size} → ${afterTick.disk.size} 字节`);
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
const offState = {
  saves: await page.evaluate(() => window.__saves),
  modified: await page.evaluate(() => window.app.modified),
  disk: await fileDigest(NOTE),
};
check('关闭后不再自动写盘',
  offState.saves === 1 && offState.modified === true && offState.disk.hex === afterTick.disk.hex,
  JSON.stringify({ saves: offState.saves, modified: offState.modified }));

/* ---------------------------------------------------------------- *
 * 4. Cases where it must stay out of the way
 * ---------------------------------------------------------------- */
console.log('\n[4] 不该打扰用户的情况');
// A board without a writable handle (dragged in / browser without the File
// System Access API): there is nothing to write into, and asking for a
// location is a user decision — the timer must never do it on its own.
const readonly = await openFixture(page, fixtures.url('seed.note'), { name: 'autosave-readonly.note', writable: false });
await watchSaves();
const noHandle = await page.evaluate(async () => {
  const app = window.app;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  window.__saveDialogs = 0;
  window.showSaveFilePicker = async () => { window.__saveDialogs++; return null; };
  app.setAutoSave(0.02);
  app.editor.addElement(els.makeText({ bounds: new Rect(60, 440, 400, 60).toString(), text: '只读打开的白板', fontSize: 28, textColor: '#FF000000' }), { select: false });
  await new Promise((r) => setTimeout(r, 2400));
  const byTimer = window.__saves;              // the 1.2 s timer had two chances here
  const tick = await app.autoSaveTick();       // …and an explicit tick has nothing to do
  const auto = await app.save({ auto: true }); // …and Ctrl+S cannot fall back to 另存为 either
  return {
    byTimer, tick, auto, dialogs: window.__saveDialogs,
    modified: app.modified, hasHandle: !!app.editor.doc.fileHandle, localFile: app.editor.doc.localFile?.name || null,
  };
});
check('没有可写句柄时不会偷偷写盘、也不会弹「另存为」',
  readonly.hasHandle === false && noHandle.hasHandle === false && noHandle.localFile === 'autosave-readonly.note'
  && noHandle.byTimer === 0 && noHandle.tick === false && noHandle.auto === false && noHandle.dialogs === 0,
  JSON.stringify(noHandle));

// A writable file again: the read-only board above is replaced by the same
// fixture opened with a genuine handle, holding one text box we then edit the
// way the UI does.
await openFixture(page, fixtures.url('seed.note'), { name: NOTE });
await watchSaves();
const duringEdit = await page.evaluate(async () => {
  const app = window.app;
  const ed = app.editor;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
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
});
check('输入文字时不会把编辑器抢走', duringEdit.editing === true, JSON.stringify({ editing: duringEdit.editing }));
check('但内容照常写盘', duringEdit.saves === 1 && duringEdit.modified === false, JSON.stringify({ saves: duringEdit.saves }));

const onDisk = await boardTexts(NOTE);
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
await fixtures.close();
fs.rmSync(fixtures.tempDir, { recursive: true, force: true });

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
