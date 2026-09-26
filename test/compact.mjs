/**
 * 一键压缩（.note garbage collection）回归测试。
 *
 * A `.note` keeps every picture it ever contained — that is what makes saving
 * non-destructive — so a board accumulates images no page refers to any more
 * (paste a picture, delete it, save: the bytes stay).  「一键压缩」 rewrites the
 * archive with only the resources that are still referenced, and re-deflates
 * entries that were stored uncompressed, entirely in the page: the file is read
 * and written through its `FileSystemFileHandle`, nothing is uploaded.
 *
 * Checked here:
 *   1. the preview reports exactly the orphaned entries, and touches nothing;
 *   2. the rewrite really drops them, copies everything else byte for byte,
 *      keeps the pages identical, and leaves a board that still opens;
 *   3. a second pass has nothing left to do (idempotent);
 *   4. saving after a compaction cannot bring the deleted resources back;
 *   5. entries outside Resources/Images|Document are never removed;
 *   6. entries stored uncompressed are deflated again, content unchanged;
 *   7. a board without a writable file (or not a board at all) says so instead
 *      of guessing.
 *
 * Usage:  node test/compact.mjs [--chrome <path>] [--url http://127.0.0.1:8804/]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, openFixture, readOpfs, docState } from './lib/local.mjs';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHROME = arg('chrome', path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');

const profileDir = path.join(__dirname, '.chrome-profile-compact');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const errors = [];
// Section 7 opens files that are meant to fail; the app logs those on purpose.
let collectingErrors = true;
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const A = 'compact-a.note';           // built in the page, saved through a handle
const B = 'compact-stored.note';      // hand-built: stored entries, one of them junk

// A directory the page may fetch fixtures from (nothing is written back here).
const fixtures = await startFixtureServer(SHOTS);

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
page.on('console', (m) => {
  // The browser itself reports refused requests ("Failed to load resource …");
  // only real application errors are collected here.
  if (!collectingErrors) return;
  if (m.type() !== 'error' || /Failed to load resource/.test(m.text())) return;
  errors.push('console: ' + m.text().slice(0, 200));
});

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await sleep(1200);
check('应用启动', await page.$('#wb-canvas') !== null);

/* ---------------------------------------------------------------- *
 * 1. A board that accumulates an orphaned picture
 * ---------------------------------------------------------------- */
console.log('\n[1] 造一个含无用资源的白板');
const built = await page.evaluate(async () => {
  const app = window.app;
  const ed = app.editor;
  const els = await import('/js/elements.js');
  const paint = async (w, h, color) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#FFF'; ctx.fillRect(4, 4, w / 2, h / 2);
    return new Promise((r) => c.toBlob(r, 'image/png'));
  };
  ed.page.elements = [];
  // two pictures the board keeps …
  await app.insertImageBlob(await paint(180, 120, '#0169BF'));
  await app.insertImageBlob(await paint(140, 140, '#00A656'));
  // … one that is pasted and immediately deleted again: the bytes stay in the
  // archive on save, which is exactly how a real board grows
  await app.insertImageBlob(await paint(90, 90, '#E71125'));
  await new Promise((r) => setTimeout(r, 400));
  const orphan = ed.page.elements[ed.page.elements.length - 1];
  const orphanName = 'Resources/Images/' + orphan.fileName;
  ed.selection.clear();
  ed.selection.add(orphan);
  app.deleteSelection();
  ed.selection.clear();
  // … and two entries nothing will ever refer to: a picture plus a PDF in
  // Resources/Document, dropped in by injecting them into the session's "new
  // files" (which is what the normal save path writes), and one file in a
  // directory the format does not define, which no compaction may touch.
  const pdf = new Uint8Array(2048);
  pdf.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);   // "%PDF-1.4"
  for (let i = 8; i < pdf.length; i++) pdf[i] = (i * 7) & 0xff;
  const b64 = (bytes) => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  const extra = {
    'Resources/Images/orphan-injected.png': b64(pdf),
    'Resources/Document/ghost.pdf': b64(pdf),
    'Resources/Other/keepme.bin': b64(pdf),
  };
  const original = ed.resources.newFilesBytes.bind(ed.resources);
  ed.resources.newFilesBytes = () => ({ ...original(), ...extra });

  // Give the board a real file: 另存为 is what does that, and here the target is
  // an OPFS file whose handle is a genuine FileSystemFileHandle.
  const dir = await navigator.storage.getDirectory();
  const handle = await dir.getFileHandle('compact-a.note', { create: true });
  const { noteBlob } = await import('/js/document.js');
  const blob = await noteBlob(ed.doc, { newFiles: ed.resources.newFilesBytes() });
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
  app.markSaved();
  await app.openLocalFile(await handle.getFile(), { handle });
  await new Promise((r) => setTimeout(r, 1300));
  // Opening the file dropped the session's pasted files and adopted the
  // archive, so from here on the board behaves like one opened from disk.
  ed.resources.newFilesBytes = original;
  const { ZipReader } = await import('/js/zipread.js');
  const zip = await ZipReader.open(await handle.getFile());
  return {
    orphanName, pdfName: 'Resources/Document/ghost.pdf',
    hasHandle: !!ed.doc.fileHandle,
    entries: zip.list(),
    images: zip.list().filter((n) => n.startsWith('Resources/Images/')).length,
    elements: ed.page.elements.filter((e) => e.type === 300001).length,
  };
});
check('白板已保存到本地文件：2 张在用图片 + 2 个无用图片 + 1 个无用 PDF + 1 个未知目录条目',
  built.hasHandle === true
  && built.elements === 2
  && built.images === 4
  && built.entries.includes(built.orphanName)
  && built.entries.includes('Resources/Images/orphan-injected.png')
  && built.entries.includes(built.pdfName)
  && built.entries.includes('Resources/Other/keepme.bin'),
  JSON.stringify({ images: built.images, entries: built.entries.length }));

/* ---------------------------------------------------------------- *
 * 2. Preview: reports the orphans, writes nothing
 * ---------------------------------------------------------------- */
console.log('\n[2] 压缩预览');
const before = await page.evaluate(async () => {
  const { ZipReader } = await import('/js/zipread.js');
  const dir = await navigator.storage.getDirectory();
  const file = await (await dir.getFileHandle('compact-a.note')).getFile();
  const zip = await ZipReader.open(file);
  const sizes = {};
  for (const n of zip.list()) {
    const e = zip.entry(n);
    sizes[n] = { method: e.method, csize: e.csize, usize: e.usize };
  }
  return { size: file.size, sizes };
});

const dialog = await page.evaluate(async () => {
  const app = window.app;
  const before = app.editor.doc.archiveBytes;
  await app.compactCurrentNote();
  await new Promise((r) => setTimeout(r, 500));
  const body = document.querySelector('.wb-dialog .wb-dialog-body');
  return {
    title: document.querySelector('.wb-dialog h3')?.textContent || '',
    text: body?.textContent || '',
    before,
  };
});
check('弹窗说明将删除的对象、体积变化与「没有额外备份」',
  dialog.title === '一键压缩 .note'
  && dialog.text.includes('将删除 3 个')
  && dialog.text.includes('省下约')
  && dialog.text.includes('没有额外备份'),
  JSON.stringify({ title: dialog.title, text: dialog.text.slice(0, 120) }));
await page.screenshot({ path: path.join(SHOTS, 'compact-dialog.png') });
check('预览不动文件',
  await page.evaluate(() => window.app.editor.doc.archiveBytes === window.app.editor.doc.localFile.size),
  JSON.stringify(dialog.before));

await page.evaluate(() => {
  [...document.querySelectorAll('.wb-dialog button')].find((b) => b.textContent === '开始压缩')?.click();
});
await sleep(2500);
const applied = await readOpfs(page, A);
const state = await docState(page);
check('压缩完成并提示删除了几个资源',
  state.toast.includes('已压缩') && state.toast.includes('删除 3 个'),
  JSON.stringify(state.toast));

/* ---------------------------------------------------------------- *
 * 3. What the compacted file looks like
 * ---------------------------------------------------------------- */
console.log('\n[3] 压缩后的文件');
check('被删除的条目真的没了（图片、注入图片、脱离的 PDF）',
  !applied.entries.includes(built.orphanName)
  && !applied.entries.includes('Resources/Images/orphan-injected.png')
  && !applied.entries.includes(built.pdfName),
  JSON.stringify(applied.entries));
check('未知目录的条目被保留',
  applied.entries.includes('Resources/Other/keepme.bin'), JSON.stringify(applied.entries));
check('在用的两张图片仍按原样搬运（压缩方式与大小都没变）',
  applied.images.length === 2
  && applied.images.every((n) => before.sizes[n]
    && applied.methods[n] === before.sizes[n].method
    && applied.sizes[n] === before.sizes[n].csize),
  JSON.stringify(applied.images));
const pageAfter = await page.evaluate(async () => {
  const { ZipReader } = await import('/js/zipread.js');
  const dir = await navigator.storage.getDirectory();
  const zip = await ZipReader.open(await (await dir.getFileHandle('compact-a.note')).getFile());
  const page1 = await zip.json('Pages/page1.json');
  return { entry: zip.entry('Pages/page1.json'), images: page1.elements.filter((e) => e.type === 300001).length };
});
check('画纸内容未变（元素还是 2 张图）', pageAfter.images === 2, JSON.stringify(pageAfter.images));
check('文件确实变小了',
  applied.size < before.size,
  JSON.stringify({ before: before.size, after: applied.size }));

// the compacted board still opens and still has its pictures
const reopened = await page.evaluate(async () => {
  const app = window.app;
  const dir = await navigator.storage.getDirectory();
  const handle = await dir.getFileHandle('compact-a.note');
  app.markSaved();
  await app.openLocalFile(await handle.getFile(), { handle });
  await new Promise((r) => setTimeout(r, 1400));
  const ed = app.editor;
  const imgs = ed.page.elements.filter((e) => e.type === 300001);
  const loaded = [];
  for (const e of imgs) loaded.push(!!(await ed.resources.load(e.fileName)));
  return { images: imgs.length, loaded, pages: ed.doc.pages.length };
});
check('压缩后重新打开：图片都还在、能取到字节',
  reopened.images === 2 && reopened.loaded.every(Boolean), JSON.stringify(reopened));

/* ---------------------------------------------------------------- *
 * 4. Saving after a compaction must not resurrect anything
 * ---------------------------------------------------------------- */
console.log('\n[4] 压缩后再保存');
const resaved = await page.evaluate(async () => {
  const app = window.app;
  const els = await import('/js/elements.js');
  app.editor.addElement(els.makeText({ bounds: '60,500,320,40', text: '压缩后再保存', fontSize: 24 }), { select: false });
  await new Promise((r) => setTimeout(r, 300));
  const ok = await app.save();
  await new Promise((r) => setTimeout(r, 900));
  const { ZipReader } = await import('/js/zipread.js');
  const dir = await navigator.storage.getDirectory();
  const file = await (await dir.getFileHandle('compact-a.note')).getFile();
  const zip = await ZipReader.open(file);
  const page1 = await zip.json('Pages/page1.json');
  return {
    ok,
    entries: zip.list(),
    size: file.size,
    hasText: page1.elements.some((e) => String(e.text || '').includes('压缩后再保存')),
    images: page1.elements.filter((e) => e.type === 300001).length,
  };
});
check('压缩之后再保存，被删掉的资源不会被带回来',
  resaved.ok === true && resaved.hasText && resaved.images === 2
  && !resaved.entries.includes(built.orphanName)
  && !resaved.entries.includes('Resources/Images/orphan-injected.png')
  && !resaved.entries.includes(built.pdfName)
  && resaved.size < before.size,
  JSON.stringify({ ...resaved, before: before.size }));

/* ---------------------------------------------------------------- *
 * 5. Second pass: nothing left to do
 * ---------------------------------------------------------------- */
console.log('\n[5] 再压缩一次');
const second = await page.evaluate(async () => {
  const app = window.app;
  const sizeAt = () => app.editor.doc.localFile.size;
  await app.compactCurrentNote();
  await new Promise((r) => setTimeout(r, 1500));
  return {
    size: sizeAt(),
    toast: document.querySelector('.wb-toasts')?.textContent || '',
    dialog: document.querySelector('.wb-dialog h3')?.textContent || '',
  };
});
check('第二次压缩发现没有可清理的资源，文件不再变化',
  second.dialog === '' && second.toast.includes('没有可清理的资源'),
  JSON.stringify(second));

/* ---------------------------------------------------------------- *
 * 6. Entries stored without compression are deflated again
 * ---------------------------------------------------------------- */
console.log('\n[6] 未压缩存放的条目');
const stored = await page.evaluate(async () => {
  const { ZipWriter, crc32 } = await import('/js/zipwrite.js');
  const els = await import('/js/elements.js');
  const app = window.app;
  // a real PNG for the referenced picture
  const c = document.createElement('canvas');
  c.width = 120; c.height = 80;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0169BF'; ctx.fillRect(0, 0, 120, 80);
  const png = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
  const junk = new Uint8Array(40000).fill(65);      // 'A', nobody references it
  const big = new Uint8Array(40000).fill(66);       // 'B', in an unknown directory

  const chunks = [];
  const sink = { write: async (b) => { chunks.push(b); }, close: async () => {}, abort: async () => {} };
  const zip = new ZipWriter(sink);
  const enc = new TextEncoder();
  const manifest = {
    id: 'stored-test', version: '1.0.0', screenWidthPixels: 2880, screenHeightPixels: 1920, screenScale: 2,
    pages: [{ fileName: 'page1.json' }], currentPage: 1, backgroundColor: '#FFFFFFFF',
    createTime: '2024-01-01 00:00:00',
  };
  const page = { elements: [{ type: 300001, fileName: 'pic.png', bounds: '-200,-150,400,300' }], scale: 1 };
  await zip.add('manifest.json', enc.encode(JSON.stringify(manifest)));
  await zip.add('Pages/page1.json', enc.encode(JSON.stringify(page)));
  await zip.add('Resources/Images/pic.png', png);
  // stored (method 0) on purpose — the older writer could produce such files
  zip.addRaw('Resources/Images/junk.png', { method: 0, crc: crc32(junk), usize: junk.length, data: junk });
  zip.addRaw('Resources/Other/big.bin', { method: 0, crc: crc32(big), usize: big.length, data: big });
  await zip.finish();
  const bytes = new Uint8Array(chunks.reduce((n, x) => n + x.length, 0));
  let off = 0;
  for (const x of chunks) { bytes.set(x, off); off += x.length; }

  const dir = await navigator.storage.getDirectory();
  const handle = await dir.getFileHandle('compact-stored.note', { create: true });
  const w = await handle.createWritable();
  await w.write(bytes);
  await w.close();
  app.markSaved();
  await app.openLocalFile(await handle.getFile(), { handle });
  await new Promise((r) => setTimeout(r, 1300));
  const { ZipReader } = await import('/js/zipread.js');
  const z = await ZipReader.open(await handle.getFile());
  return {
    size: (await handle.getFile()).size,
    methods: { junk: z.entry('Resources/Images/junk.png').method, big: z.entry('Resources/Other/big.bin').method },
    pic: { method: z.entry('Resources/Images/pic.png').method, csize: z.entry('Resources/Images/pic.png').csize },
  };
});
check('本地打开一份含两个未压缩条目的白板（一个没人引用、一个在未知目录）',
  stored.methods.junk === 0 && stored.methods.big === 0 && stored.size > 80000,
  JSON.stringify({ size: stored.size, ...stored.methods }));

const storedDialog = await page.evaluate(async () => {
  await window.app.compactCurrentNote();
  await new Promise((r) => setTimeout(r, 500));
  const text = document.querySelector('.wb-dialog .wb-dialog-body')?.textContent || '';
  return { text, title: document.querySelector('.wb-dialog h3')?.textContent || '' };
});
check('预览分别报告「要删除的」与「要重新压缩的」',
  storedDialog.title === '一键压缩 .note'
  && storedDialog.text.includes('将删除 1 个')
  && storedDialog.text.includes('另有 1 个条目')
  && storedDialog.text.includes('重新压缩'),
  JSON.stringify(storedDialog.text.slice(0, 140)));

await page.evaluate(() => {
  [...document.querySelectorAll('.wb-dialog button')].find((b) => b.textContent === '开始压缩')?.click();
});
await sleep(2500);
const storedAfter = await page.evaluate(async () => {
  const { ZipReader } = await import('/js/zipread.js');
  const dir = await navigator.storage.getDirectory();
  const file = await (await dir.getFileHandle('compact-stored.note')).getFile();
  const zip = await ZipReader.open(file);
  const big = zip.entry('Resources/Other/big.bin');
  const bigBytes = await zip.read('Resources/Other/big.bin');
  const pic = zip.entry('Resources/Images/pic.png');
  const manifest = await zip.json('manifest.json');
  return {
    size: file.size,
    entries: zip.list(),
    big: { method: big.method, csize: big.csize, usize: big.usize },
    bigOk: bigBytes.length === 40000 && bigBytes.every((b) => b === 66),
    pic: { method: pic.method, csize: pic.csize },
    pages: (manifest.pages || []).length,
    toast: document.querySelector('.wb-toasts')?.textContent || '',
  };
});
check('未压缩的条目不删、重新压缩后内容逐字节不变',
  storedAfter.big.method === 8 && storedAfter.big.csize < 2000 && storedAfter.big.usize === 40000
  && storedAfter.bigOk === true,
  JSON.stringify(storedAfter.big));
check('已压缩的条目依旧原样搬运，没人引用的条目已删除，画纸仍然可读',
  storedAfter.pic.method === stored.pic.method && storedAfter.pic.csize === stored.pic.csize
  && !storedAfter.entries.includes('Resources/Images/junk.png')
  && storedAfter.pages === 1
  && storedAfter.size < stored.size - 50000
  && storedAfter.toast.includes('已压缩'),
  JSON.stringify({ before: stored.size, after: storedAfter.size, pic: storedAfter.pic, entries: storedAfter.entries }));

/* ---------------------------------------------------------------- *
 * 7. Refusals
 * ---------------------------------------------------------------- */
console.log('\n[7] 边界情况');
collectingErrors = false;   // the next two checks provoke real errors on purpose
const noFile = await page.evaluate(async () => {
  const app = window.app;
  app.markSaved();
  app.newDocument();
  await new Promise((r) => setTimeout(r, 600));
  const ok = await app.compactCurrentNote();
  await new Promise((r) => setTimeout(r, 400));
  return {
    ok,
    dialog: document.querySelector('.wb-dialog h3')?.textContent || '',
    toast: document.querySelector('.wb-toasts')?.textContent || '',
  };
});
check('还没保存到文件的白板给出提示而不是猜测',
  noFile.ok === false && noFile.dialog === '' && noFile.toast.includes('另存为'),
  JSON.stringify(noFile));

// A read-only snapshot (drag & drop, or a browser without file system access)
// can be read but not rewritten, so compaction must refuse it the same way.
const readOnly = await page.evaluate(async () => {
  const app = window.app;
  const { ZipWriter } = await import('/js/zipwrite.js');
  const chunks = [];
  const sink = { write: async (b) => { chunks.push(b); }, close: async () => {}, abort: async () => {} };
  const zip = new ZipWriter(sink);
  const enc = new TextEncoder();
  await zip.add('manifest.json', enc.encode(JSON.stringify({ pages: [{ fileName: 'page1.json' }], currentPage: 1 })));
  await zip.add('Pages/page1.json', enc.encode(JSON.stringify({ elements: [], scale: 1 })));
  await zip.finish();
  const bytes = new Uint8Array(chunks.reduce((n, x) => n + x.length, 0));
  let off = 0;
  for (const x of chunks) { bytes.set(x, off); off += x.length; }
  app.markSaved();
  await app.openLocalFile(new File([bytes], 'dragged.note'), { handle: null });
  await new Promise((r) => setTimeout(r, 900));
  const ok = await app.compactCurrentNote();
  await new Promise((r) => setTimeout(r, 400));
  return { ok, hasHandle: !!app.editor.doc.fileHandle, toast: document.querySelector('.wb-toasts')?.textContent || '' };
});
check('只读打开的白板（拖进来 / 浏览器不支持写回）压缩时会说明原因',
  readOnly.ok === false && readOnly.hasHandle === false && readOnly.toast.includes('另存为'),
  JSON.stringify(readOnly));

// A file that is not a ZIP is rejected when opening, not when compacting.
const notAZip = await page.evaluate(async () => {
  const app = window.app;
  app.markSaved();
  await app.openLocalFile(new File([new Uint8Array([1, 2, 3, 4, 5])], 'broken.note'), { handle: null });
  await new Promise((r) => setTimeout(r, 700));
  return {
    toast: document.querySelector('.wb-toasts')?.textContent || '',
    name: app.editor.doc.name,
  };
});
check('不是 ZIP / 不是白板的文件在打开时就被拒绝',
  notAZip.toast.includes('打开失败'), JSON.stringify(notAZip));

await page.evaluate(() => { window.app.editor.clearSelection(); window.app.editor.draw(); });
await sleep(200);
await page.screenshot({ path: path.join(SHOTS, 'compact.png') });
await browser.close();
await fixtures.close();

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
