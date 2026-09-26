/**
 * Open-flow regression test.
 *
 * A board is a local file, full stop.  「打开」 offers two ways in — a real OS
 * file dialog (「从本地文件选择」) or 「最近使用的文件」 — and the server is not
 * involved in either: it only ever serves the page itself, so opening a board
 * must not produce a single `/api/` request.
 *
 * Recents remember a *location*, never a copy: the browser file handle when the
 * browser hands one out (Chrome / Edge), otherwise just the name so the file
 * can be picked again.
 *
 * Usage:  node test/openflow.mjs [--chrome <path>] [--url http://127.0.0.1:8787/]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, openFixture } from './lib/local.mjs';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// A scratch directory holding the "file on disk" this suite opens.  The page
// builds the board, the test process writes the bytes, the fixture server hands
// them back as a URL — exactly what a file the user picked looks like.
const SCRATCH = path.join(__dirname, '.cache', 'openflow-fixtures');
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHROME = arg('chrome', path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');

const profileDir = path.join(__dirname, '.chrome-profile-openflow');
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
const BOARD = '来自磁盘的白板.note';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: profileDir,
  env: {
    ...process.env, HOME: chromeHome,
    XDG_CONFIG_HOME: path.join(chromeHome, '.config'), XDG_CACHE_HOME: path.join(chromeHome, '.cache'),
  },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-crashpad', '--window-size=1300,900'],
  defaultViewport: { width: 1300, height: 900 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() !== 'error' || /Failed to load resource/.test(m.text())) return;
  errors.push('console: ' + m.text().slice(0, 200));
});
const apiCalls = [];
page.on('request', (r) => { if (r.url().includes('/api/')) apiCalls.push(r.method() + ' ' + r.url().replace(URL_BASE.replace(/\/$/, ''), '')); });

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await sleep(1200);
check('应用启动', await page.$('#wb-canvas') !== null);

const prefs = (fn) => page.evaluate(async (src) => {
  const m = await import('/js/prefs.js');
  // eslint-disable-next-line no-new-func
  return new Function('m', `return (${src})(m);`)(m);
}, fn.toString());

/* ---------------------------------------------------------------- *
 * 0. A board on disk to open
 * ---------------------------------------------------------------- */
console.log('\n[0] 准备一个本地文件');
const bytes = await page.evaluate(async () => {
  const app = window.app;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  app.editor.page.elements = [];
  app.editor.addElement(els.makeText({ bounds: new Rect(80, 80, 400, 60).toString(), text: '本地白板', fontSize: 30 }), { select: false });
  const c = document.createElement('canvas');
  c.width = 120; c.height = 90;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0169BF'; ctx.fillRect(0, 0, 120, 90);
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
 * 1. The chooser
 * ---------------------------------------------------------------- */
console.log('\n[1] 打开时的两个分支');
const initial = await page.evaluate(async () => {
  await window.app.showOpenDialog();
  await new Promise((r) => setTimeout(r, 300));
  const rows = [...document.querySelectorAll('.wb-filerow')].map((r) => r.textContent.trim());
  const dialogText = document.querySelector('.wb-dialog')?.textContent || '';
  window.app.ui.closeDialog();
  return { rows, dialogText };
});
check('对话框只列出「从本地文件选择」和「最近使用的文件」',
  initial.rows.length === 2
  && initial.rows[0].includes('从本地文件选择')
  && initial.rows[1].includes('最近使用的文件'),
  JSON.stringify(initial.rows));
check('界面里不再出现「工作区」', !initial.dialogText.includes('工作区'),
  JSON.stringify(initial.dialogText.slice(0, 60)));

const localBranch = await page.evaluate(async () => {
  let pickerCalls = 0;
  let pickerOpts = null;
  const orig = window.showOpenFilePicker;
  window.showOpenFilePicker = async (opts) => { pickerCalls++; pickerOpts = opts; return []; };
  await window.app.showOpenDialog();
  const before = document.querySelectorAll('input[type=file]').length;
  document.querySelectorAll('.wb-filerow')[0].click();
  await new Promise((r) => setTimeout(r, 400));
  window.showOpenFilePicker = orig;
  const inputs = document.querySelectorAll('input[type=file]').length - before;
  document.querySelectorAll('input[type=file]').forEach((i) => i.remove());
  return {
    pickerCalls, inputs,
    types: JSON.stringify(pickerOpts?.types || []),
    dialogClosed: !document.querySelector('.wb-filerow'),
  };
});
check('「从本地文件选择」调起系统文件对话框（.note / .pdf）',
  localBranch.dialogClosed
  && (localBranch.pickerCalls === 1 || localBranch.inputs === 1)
  && (localBranch.types.includes('.note') || localBranch.inputs === 1),
  JSON.stringify(localBranch));

/* ---------------------------------------------------------------- *
 * 2. Opening a file: read in place, no server involved
 * ---------------------------------------------------------------- */
console.log('\n[2] 本地文件就地打开');
apiCalls.length = 0;
const opened = await openFixture(page, fixtures.url(BOARD), { name: BOARD, remember: true });
check('本地 .note 直接在前端打开（页数 / 元素 / 句柄）',
  opened.pages === 1 && opened.elements === 2 && opened.hasHandle === true, JSON.stringify(opened));
const loaded = await page.evaluate(async () => {
  const ed = window.app.editor;
  const imgs = ed.page.elements.filter((e) => e.type === 300001);
  const bytes = [];
  for (const e of imgs) bytes.push(!!(await ed.resources.load(e.fileName)));
  return { images: imgs.length, bytes, texts: ed.page.elements.filter((e) => e.type === 300002).length };
});
check('内容与图片都从本地归档读出来',
  loaded.images === 1 && loaded.bytes.every(Boolean) && loaded.texts === 1, JSON.stringify(loaded));
check('整个过程服务端一次都没有被调用（没有上传、没有副本）',
  apiCalls.length === 0, JSON.stringify(apiCalls.slice(0, 5)));

/* ---------------------------------------------------------------- *
 * 3. Recents remember a location
 * ---------------------------------------------------------------- */
console.log('\n[3] 最近使用的是「位置」');
const recents = await prefs((m) => m.recentFiles());
check('记录里存的是位置（句柄 id），不是副本路径',
  recents.length === 1 && recents[0].name === BOARD
  && !!recents[0].handleId && !recents[0].path && recents[0].source === 'local',
  JSON.stringify(recents));

await openFixture(page, fixtures.url(BOARD), { name: BOARD, remember: true });
const dedup = await prefs((m) => m.recentFiles());
check('同一个文件不会在记录里出现两次', dedup.length === 1, JSON.stringify(dedup.map((r) => r.name)));

// A file that was edited and saved in between has a different size.  Only the
// name identifies it (a browser never hands out a path), so the list must still
// grow by nothing — and it must show the *fresh* size, not the old one.
const afterEdit = await page.evaluate(async (name) => {
  const app = window.app;
  const els = await import('/js/elements.js');
  const { saveHandle } = await import('/js/filehandles.js');
  const dir = await navigator.storage.getDirectory();
  const handle = await dir.getFileHandle(name);
  app.editor.addElement(els.makeText({ bounds: '60,420,320,50', text: '改一下', fontSize: 26 }), { select: false });
  await new Promise((r) => setTimeout(r, 250));
  await app.save();                                   // writes in place, size changes
  await new Promise((r) => setTimeout(r, 800));
  const grown = (await handle.getFile()).size;
  const id = `again-${Date.now().toString(36)}`;
  await saveHandle(id, handle);
  app.markSaved();
  await app.openLocalFile(await handle.getFile(), { handle, handleId: id });
  await new Promise((r) => setTimeout(r, 900));
  const { recentFiles } = await import('/js/prefs.js');
  return { grown, list: recentFiles().map((r) => ({ name: r.name, size: r.size })) };
}, BOARD);
check('保存过、体积变了的同一个文件也只占一条记录',
  afterEdit.list.length === 1 && afterEdit.list[0].name === BOARD
  && afterEdit.list[0].size === afterEdit.grown,
  JSON.stringify(afterEdit));

// Entries written by an older version can hold the same file several times; the
// list merges them on read, newest first, and keeps a handle from any of them.
const merged = await page.evaluate(async () => {
  const { setPref, recentFiles } = await import('/js/prefs.js');
  setPref('recentFiles', [
    { at: 300, name: 'dup.note', size: 3, kind: 'note', source: 'local' },
    { at: 200, name: 'DUP.note', size: 2, kind: 'note', source: 'local', handleId: 'old-handle' },
    { at: 100, name: 'other.note', size: 1, kind: 'note', source: 'local' },
  ]);
  return recentFiles().map((r) => ({ name: r.name, size: r.size, handle: r.handleId || null }));
});
check('历史遗留的重复记录会在读取时合并（保留最新的一条与句柄）',
  merged.length === 2 && merged[0].name === 'dup.note' && merged[0].size === 3
  && merged[0].handle === 'old-handle' && merged[1].name === 'other.note',
  JSON.stringify(merged));
// put the list back to just this one file for the sections that follow
await page.evaluate(async () => (await import('/js/prefs.js')).clearRecentFiles());
await openFixture(page, fixtures.url(BOARD), { name: BOARD, remember: true });
const restored = await prefs((m) => m.recentFiles());
check('清掉记录后重新打开，列表里还是那一条',
  restored.length === 1 && restored[0].name === BOARD && !!restored[0].handleId,
  JSON.stringify(restored.map((r) => ({ n: r.name, h: !!r.handleId }))));

const recentDialog = await page.evaluate(async () => {
  await window.app.showRecentDialog();
  await new Promise((r) => setTimeout(r, 300));
  const rows = [...document.querySelectorAll('.wb-filerow')].map((r) => r.textContent.trim());
  const text = document.querySelector('.wb-dialog')?.textContent || '';
  window.app.ui.closeDialog();
  return { rows, text };
});
check('最近使用列表显示「已记住位置」，没有工作区分段',
  recentDialog.rows.length === 1
  && recentDialog.rows[0].includes('已记住位置')
  && !recentDialog.text.includes('工作区'),
  JSON.stringify(recentDialog.rows));

/* ---------------------------------------------------------------- *
 * 4. Reopening from the list, and re-picking without a handle
 * ---------------------------------------------------------------- */
console.log('\n[4] 从列表再打开');
const reopened = await page.evaluate(async () => {
  const app = window.app;
  // Move to a different board first, so opening the recent entry has to do
  // something real (otherwise "it is still open" would look like success).
  app.newDocument();
  await new Promise((r) => setTimeout(r, 500));
  const before = app.editor.doc.pages.length && app.editor.page.elements.length;
  await app.showRecentDialog();
  await new Promise((r) => setTimeout(r, 250));
  document.querySelectorAll('.wb-filerow')[0].click();
  await new Promise((r) => setTimeout(r, 1600));
  return {
    before,
    name: app.editor.doc.name,
    pages: app.editor.doc.pages.length,
    elements: app.editor.page.elements.length,
    hasHandle: !!app.editor.doc.fileHandle,
    toast: document.querySelector('.wb-toasts')?.textContent || '',
  };
});
check('点列表里的条目就能重新打开（内容一致）',
  reopened.before === 0 && reopened.pages === 1 && reopened.elements === 2
  && reopened.hasHandle === true && !reopened.toast.includes('请重新选择'),
  JSON.stringify(reopened));

// A remembered file whose handle is gone (another browser, cleared storage)
// has to ask for the file again instead of failing silently.
const repick = await page.evaluate(async () => {
  const { forgetHandle } = await import('/js/filehandles.js');
  const { recentFiles } = await import('/js/prefs.js');
  await forgetHandle(recentFiles()[0].handleId);
  let pickerCalls = 0;
  const orig = window.showOpenFilePicker;
  window.showOpenFilePicker = async () => { pickerCalls++; return []; };
  await window.app.showRecentDialog();
  await new Promise((r) => setTimeout(r, 250));
  document.querySelectorAll('.wb-filerow')[0].click();
  await new Promise((r) => setTimeout(r, 600));
  window.showOpenFilePicker = orig;
  return { pickerCalls, toast: document.querySelector('.wb-toasts')?.textContent || '' };
});
check('句柄丢失时请用户重新选择文件',
  repick.pickerCalls === 1 && repick.toast.includes('请重新选择'), JSON.stringify(repick));

/* ---------------------------------------------------------------- *
 * 5. Clearing, unsupported types, drag & drop
 * ---------------------------------------------------------------- */
console.log('\n[5] 清空、类型与拖放');
const cleared = await page.evaluate(async () => {
  await window.app.showRecentDialog();
  await new Promise((r) => setTimeout(r, 250));
  [...document.querySelectorAll('.wb-dialog button')].find((b) => b.textContent.includes('清空记录'))?.click();
  await new Promise((r) => setTimeout(r, 300));
  const text = document.querySelector('.wb-dialog')?.textContent || '';
  window.app.ui.closeDialog();
  return text;
});
const afterClear = await prefs((m) => m.recentFiles());
check('「清空记录」把最近打开清空',
  afterClear.length === 0 && cleared.includes('记录已清空'), JSON.stringify({ n: afterClear.length }));

const unsupported = await page.evaluate(async () => {
  const app = window.app;
  app.markSaved();
  await app.openLocalFile(new File([new Uint8Array([1, 2, 3])], 'notes.txt'), { handle: null });
  await new Promise((r) => setTimeout(r, 300));
  return document.querySelector('.wb-toasts')?.textContent || '';
});
check('不支持的类型给出提示而不是崩溃', unsupported.includes('不支持'), unsupported.slice(0, 40));

const dropped = await page.evaluate(async (url) => {
  const app = window.app;
  const blob = await (await fetch(url)).blob();
  const file = new File([blob], '拖进来的白板.note', { type: 'application/x-note' });
  const dt = new DataTransfer();
  dt.items.add(file);
  app.markSaved();
  document.querySelector('.wb-stage').dispatchEvent(
    new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
  );
  await new Promise((r) => setTimeout(r, 1600));
  return {
    name: app.editor.doc.name,
    pages: app.editor.doc.pages.length,
    hasHandle: !!app.editor.doc.fileHandle,
  };
}, fixtures.url(BOARD));
check('把 .note 拖进窗口也能打开（没有句柄，只能另存为）',
  dropped.pages === 1 && dropped.hasHandle === false && dropped.name.includes('拖进来'),
  JSON.stringify(dropped));

/* ---------------------------------------------------------------- *
 * 6. The workspace is gone for good
 * ---------------------------------------------------------------- */
console.log('\n[6] 工作区彻底消失');
const gone = await page.evaluate(async () => {
  const app = window.app;
  const res = await fetch('/api/files').then((r) => r.json()).catch((e) => ({ error: String(e) }));
  return {
    files: res,
    hasLoadNote: typeof app.loadNote === 'function',
    docHasPath: 'path' in app.editor.doc,
    workspaceKeys: Object.keys(app).filter((k) => /workspace/i.test(k)),
  };
});
check('服务端不再提供文件列表接口', !!gone.files.error, JSON.stringify(gone.files));
check('客户端没有 loadNote / doc.path 之类的残留',
  gone.hasLoadNote === false && gone.docHasPath === false && gone.workspaceKeys.length === 0,
  JSON.stringify(gone));

await page.evaluate(() => { window.app.editor.clearSelection(); window.app.editor.draw(); });
await sleep(200);
await page.screenshot({ path: path.join(SHOTS, 'openflow.png') });
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
