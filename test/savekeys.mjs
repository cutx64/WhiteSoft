/**
 * Ctrl+S vs Ctrl+Shift+S regression test, in a world without a server-side
 * workspace.
 *
 * Ctrl+S must always write the file the board came from:
 *   - a board opened through the OS file dialog owns a handle → overwrite it;
 *   - a board that only exists as a read-only snapshot (dragged in, or a
 *     browser without the File System Access API) → ask where to put it
 *     (system dialog, or a plain download as the last resort).
 * Ctrl+Shift+S is the only way to get 另存为, even when a handle exists.
 *
 * The writes go to real files: the suite hands the page genuine
 * `FileSystemFileHandle`s backed by the Origin Private File System, so the
 * production writer runs unchanged and the bytes can be read back and parsed.
 *
 * Usage:  node test/savekeys.mjs [--chrome <path>] [--url http://127.0.0.1:8807/]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startFixtureServer, openFixture, readOpfs, chooseSaveTarget, cancelSaveTarget,
  removeSaveTarget, watchDownloads, docState, listOpfs,
} from './lib/local.mjs';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// One board on "disk" to open, built by the page itself.
const SCRATCH = path.join(__dirname, '.cache', 'savekeys-fixtures');
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const BOARD = 'savekeys-source.note';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHROME = arg('chrome', path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');

const profileDir = path.join(__dirname, '.chrome-profile-savekeys');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const errors = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const fixtures = await startFixtureServer(SCRATCH);

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

/** Ctrl+S / Ctrl+Shift+S through real key events. */
const press = async (shift) => {
  await page.keyboard.down('Control');
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press('KeyS');
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await sleep(1100);
};
/** Add an element so the board is genuinely dirty. */
const edit = () => page.evaluate(async () => {
  const app = window.app;
  const els = await import('/js/elements.js');
  app.editor.addElement(
    els.makeText({ bounds: `60,${300 + Math.round(Math.random() * 100)},320,50`, text: '编辑 ' + Math.random().toString(36).slice(2, 6), fontSize: 26 }),
    { select: false },
  );
  await new Promise((r) => setTimeout(r, 300));
});
const opfsSize = (target, name) => page.evaluate(async (n) => {
  const dir = await navigator.storage.getDirectory();
  try { return (await (await dir.getFileHandle(n)).getFile()).size; } catch { return null; }
}, name);

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await sleep(1200);
check('应用启动', await page.$('#wb-canvas') !== null);

/* ---------------------------------------------------------------- *
 * 0. A board on disk
 * ---------------------------------------------------------------- */
console.log('\n[0] 准备示例文件');
const bytes = await page.evaluate(async () => {
  const app = window.app;
  const els = await import('/js/elements.js');
  app.editor.page.elements = [];
  app.editor.addElement(els.makeText({ bounds: '60,60,320,50', text: '工作区已消失', fontSize: 26 }), { select: false });
  const c = document.createElement('canvas');
  c.width = 200; c.height = 150;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0169BF'; ctx.fillRect(0, 0, 200, 150);
  ctx.fillStyle = '#FFF'; ctx.fillRect(30, 30, 80, 80);
  await app.insertImageBlob(await new Promise((r) => c.toBlob(r, 'image/png')));
  await new Promise((r) => setTimeout(r, 400));
  const { noteBlob } = await import('/js/document.js');
  const blob = await noteBlob(app.editor.doc, { newFiles: app.editor.resources.newFilesBytes() });
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
});
fs.writeFileSync(path.join(SCRATCH, BOARD), Buffer.from(bytes));
check('示例白板已写到磁盘', fs.statSync(path.join(SCRATCH, BOARD)).size > 1000,
  `${fs.statSync(path.join(SCRATCH, BOARD)).size} B`);

/* ---------------------------------------------------------------- *
 * 1. A board opened with a handle: Ctrl+S overwrites it
 * ---------------------------------------------------------------- */
console.log('\n[1] 有句柄的本地文件');
const opened = await openFixture(page, fixtures.url(BOARD), { name: BOARD });
check('带句柄打开本地白板',
  opened.pages === 1 && opened.elements === 2 && opened.hasHandle === true && opened.writable === true,
  JSON.stringify(opened));

const sizeBefore = await opfsSize(page, BOARD);
await edit();
await press(false);
const afterSave = await docState(page);
const sizeAfter = await opfsSize(page, BOARD);
check('Ctrl+S 直接覆盖原文件（没有弹窗，文件变大）',
  afterSave.dialog === '' && afterSave.modified === false && sizeAfter > sizeBefore,
  JSON.stringify({ ...afterSave, sizeBefore, sizeAfter }));

const reparsed = await readOpfs(page, BOARD);
check('写回去的 .note 仍能解析（页面 + 图片 + 文字都在）',
  reparsed.pageCount === 1 && reparsed.images.length === 1 && reparsed.elements.includes(300002)
  && reparsed.entries.includes('manifest.json') && reparsed.entries.includes('Pages/page1.json'),
  JSON.stringify({ pages: reparsed.pageCount, images: reparsed.images.length, elements: reparsed.elements }));

/* ---------------------------------------------------------------- *
 * 2. Repeated in-place saves keep the archive intact
 * ---------------------------------------------------------------- */
console.log('\n[2] 连续就地保存');
const rounds = [];
for (let i = 0; i < 3; i++) {
  await edit();
  rounds.push(await page.evaluate(async () => {
    const ok = await window.app.save();
    await new Promise((r) => setTimeout(r, 900));
    return { ok, modified: window.app.modified, elements: window.app.editor.page.elements.length };
  }));
}
const afterRounds = await readOpfs(page, BOARD);
check('第二次、第三次写回同样成功',
  rounds.every((r) => r.ok === true && r.modified === false) && afterRounds.elements.length >= 5,
  JSON.stringify({ rounds, elements: afterRounds.elements.length }));
check('反复保存不会让文件无谓膨胀',
  afterRounds.size < sizeBefore + 6000,
  JSON.stringify({ sizeBefore, after: afterRounds.size }));

/* ---------------------------------------------------------------- *
 * 3. Ctrl+Shift+S asks for a new location
 * ---------------------------------------------------------------- */
console.log('\n[3] Ctrl+Shift+S 另存为');
await chooseSaveTarget(page, 'savekeys-copy.note');
const copySizeBefore = await opfsSize(page, BOARD);
await edit();
await press(true);
const savedAs = await docState(page);
const copy = await readOpfs(page, 'savekeys-copy.note');
const originalAfterCopy = await opfsSize(page, BOARD);
check('Ctrl+Shift+S 写出一个新文件并接管后续保存',
  savedAs.dialog === '' && savedAs.handleName === 'savekeys-copy.note' && copy.size > 0,
  JSON.stringify({ ...savedAs, copySize: copy.size }));
check('原来那个文件没有被这次另存为改动',
  originalAfterCopy === copySizeBefore,
  JSON.stringify({ before: copySizeBefore, after: originalAfterCopy }));

await edit();
await press(false);
const copyAfterCtrlS = await opfsSize(page, 'savekeys-copy.note');
const originalAfterCtrlS = await opfsSize(page, BOARD);
check('之后的 Ctrl+S 覆盖新位置，而不是回到旧文件',
  copyAfterCtrlS > copy.size && originalAfterCtrlS === originalAfterCopy,
  JSON.stringify({ copy: [copy.size, copyAfterCtrlS], original: [originalAfterCopy, originalAfterCtrlS], files: await listOpfs(page) }));

/* ---------------------------------------------------------------- *
 * 4. Cancelling the system dialog writes nothing
 * ---------------------------------------------------------------- */
console.log('\n[4] 取消系统对话框');
await cancelSaveTarget(page);
const sizeBeforeCancel = await opfsSize(page, 'savekeys-copy.note');
await edit();
await press(true);
const cancelled = await docState(page);
check('取消另存为：不写文件、不崩溃、仍然标记为未保存',
  cancelled.modified === true && cancelled.dialog === ''
  && (await opfsSize(page, 'savekeys-copy.note')) === sizeBeforeCancel,
  JSON.stringify({ ...cancelled, sizeBeforeCancel }));

/* ---------------------------------------------------------------- *
 * 5. A read-only board falls back to 另存为
 * ---------------------------------------------------------------- */
console.log('\n[5] 只读打开（拖进来 / 浏览器不支持写回）');
const readOnly = await openFixture(page, fixtures.url(BOARD), { name: BOARD, writable: false });
check('只读白板打开后没有句柄', readOnly.hasHandle === false && readOnly.pages === 1, JSON.stringify(readOnly));

await chooseSaveTarget(page, 'savekeys-from-readonly.note');
await edit();
await press(false);
const readonlySaved = await docState(page);
check('Ctrl+S 对只读白板转为另存为（写到用户选的位置）',
  readonlySaved.handleName === 'savekeys-from-readonly.note'
  && (await opfsSize(page, 'savekeys-from-readonly.note')) > 1000,
  JSON.stringify(readonlySaved));

/* ---------------------------------------------------------------- *
 * 6. No file system access at all: download a copy instead
 * ---------------------------------------------------------------- */
console.log('\n[6] 浏览器完全没有文件系统访问（Firefox / Safari）');
const downloads = await watchDownloads(page);
await removeSaveTarget(page);
await openFixture(page, fixtures.url(BOARD), { name: BOARD, writable: false });
const hadPicker = await page.evaluate(() => typeof window.showSaveFilePicker === 'function');
await edit();
await press(false);
const listed = await downloads();
// pasting a picture also creates an object URL, so only entries that reached
// an <a download> count as downloads
const files = listed.filter((d) => d.name);
check('没有可写句柄时另存为下载一份副本',
  hadPicker === false && files.length === 1 && files[0].size > 1000
  && String(files[0].name).endsWith('.note'),
  JSON.stringify({ hadPicker, listed }));
const afterDownload = await docState(page);
check('下载之后提示说明了原因',
  afterDownload.toast.includes('下载') || afterDownload.toast.includes('不能直接写回'),
  JSON.stringify(afterDownload.toast));

/* ---------------------------------------------------------------- *
 * 7. A brand-new board has no file yet
 * ---------------------------------------------------------------- */
console.log('\n[7] 新白板第一次保存');
await page.evaluate(() => { window.app.markSaved(); window.app.newDocument(); });
await sleep(700);
await chooseSaveTarget(page, 'savekeys-new.note');
await edit();
await press(false);
const fresh = await readOpfs(page, 'savekeys-new.note');
const freshState = await docState(page);
check('新白板 Ctrl+S → 另存为对话框 → 写出一个完整 .note',
  freshState.handleName === 'savekeys-new.note' && fresh.pageCount === 1
  && fresh.elements.includes(300002) && freshState.modified === false,
  JSON.stringify({ ...freshState, pages: fresh.pageCount, elements: fresh.elements }));
check('写完之后最近使用里记的是这个位置',
  await page.evaluate(async () => {
    const { recentFiles } = await import('/js/prefs.js');
    const list = recentFiles();
    return list.length > 0 && list[0].name === 'savekeys-new.note' && !!list[0].handleId;
  }),
  JSON.stringify(await page.evaluate(async () => {
    const { recentFiles } = await import('/js/prefs.js');
    return recentFiles().map((r) => ({ n: r.name, id: !!r.handleId }));
  })));

await page.evaluate(() => { window.app.editor.clearSelection(); window.app.editor.draw(); });
await sleep(200);
await page.screenshot({ path: path.join(SHOTS, 'savekeys.png') });
await browser.close();
await fixtures.close();
fs.rmSync(SCRATCH, { recursive: true, force: true });

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
