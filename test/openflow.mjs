/**
 * Open-flow regression test.
 *
 * 打开白板 now asks *where* the file comes from: 「从本地文件选择」 (a real OS
 * file dialog for .note / .pdf) or 「最近使用的文件」 (what this browser opened
 * before, plus the boards in the workspace, newest first).
 *
 * Recents remember a *location*, never a copy: a local `.note` is read in the
 * browser (nothing is uploaded, nothing lands in `.cache/`) and remembered by
 * name — plus a file handle when the browser hands one out, which is what lets
 * the list open the very same file again.
 *
 * Usage:  node test/openflow.mjs [--chrome <path>] [--url http://127.0.0.1:8787/]
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
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
const apiCalls = [];
page.on('request', (r) => { if (r.url().includes('/api/')) apiCalls.push(r.method() + ' ' + r.url().replace(URL_BASE.replace(/\/$/, ''), '')); });

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await sleep(1200);
check('应用启动', await page.$('#wb-canvas') !== null);

/** Rows currently rendered in the open dialog. */
const rows = () => page.evaluate(() => [...document.querySelectorAll('.wb-filerow')].map((r) => ({
  text: r.textContent.trim(),
  tag: r.querySelector('.wb-filetag')?.textContent || '',
  desc: r.querySelector('.wb-pagedesc')?.textContent || '',
})));
const prefs = (fn) => page.evaluate(async (src) => {
  const m = await import('/js/prefs.js');
  // eslint-disable-next-line no-new-func
  return new Function('m', `return (${src})(m);`)(m);
}, fn.toString());
const closeDialog = () => page.evaluate(() => {
  const dlg = document.querySelector('.wb-dialog, dialog');
  const btn = [...(dlg?.querySelectorAll('button') || [])].find((b) => /\b(取消|关闭)\b/.test(b.textContent));
  if (btn) btn.click();
});

/* ---------------------------------------------------------------- *
 * 1. The chooser
 * ---------------------------------------------------------------- */
console.log('\n[1] 打开时的两个分支');
const initial = await page.evaluate(async () => {
  await window.app.showOpenDialog();
  await new Promise((r) => setTimeout(r, 300));
  return [...document.querySelectorAll('.wb-filerow')].map((r) => r.textContent.trim());
});
check('对话框列出「从本地文件选择」和「最近使用的文件」',
  initial.length === 2 && initial[0].includes('从本地文件选择') && initial[1].includes('最近使用的文件'),
  JSON.stringify(initial));

const localBranch = await page.evaluate(async () => {
  // 有 File System Access API 时优先用它（才能拿到文件句柄），否则回退到 input
  let pickerCalls = 0;
  let pickerOpts = null;
  const orig = window.showOpenFilePicker;
  window.showOpenFilePicker = async (opts) => { pickerCalls++; pickerOpts = opts; return []; };
  const before = document.querySelectorAll('input[type=file]').length;
  document.querySelectorAll('.wb-filerow')[0].click();
  await new Promise((r) => setTimeout(r, 400));
  window.showOpenFilePicker = orig;
  const inputs = document.querySelectorAll('input[type=file]').length - before;
  document.querySelectorAll('input[type=file]').forEach((i) => i.remove());
  const types = JSON.stringify(pickerOpts?.types || []);
  return { pickerCalls, inputs, types, dialogClosed: !document.querySelector('.wb-filerow') };
});
check('「从本地文件选择」调起系统文件对话框（.note / .pdf）',
  localBranch.dialogClosed && (localBranch.pickerCalls === 1 || localBranch.inputs === 1)
  && (localBranch.types.includes('.note') || localBranch.inputs === 1),
  JSON.stringify(localBranch));

/* ---------------------------------------------------------------- *
 * 2. Opening a local file: read in place, remembered as a location
 * ---------------------------------------------------------------- */
console.log('\n[2] 本地文件就地打开，不产生副本');
const source = await page.evaluate(async () => {
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
  await new Promise((r) => setTimeout(r, 300));
  app.editor.doc.path = 'local-source.note';
  app.editor.doc.name = 'local-source';
  await app.save();
  await new Promise((r) => setTimeout(r, 400));
  const blob = await (await fetch('/api/raw?path=local-source.note')).blob();
  window.__localNote = new File([blob], '来自磁盘的白板.note', { type: 'application/octet-stream' });
  return { size: blob.size };
});

apiCalls.length = 0;
const localOpen = await page.evaluate(async () => {
  const app = window.app;
  app.markSaved();
  await app.openLocalFile(window.__localNote);
  await new Promise((r) => setTimeout(r, 900));
  const m = await import('/js/prefs.js');
  return {
    path: app.editor.doc.path,
    name: app.editor.doc.name,
    elements: app.editor.page.elements.map((e) => e.type),
    hasArchive: !!app.editor.resources.archive,
    decoded: app.editor.resources.images.size,
    list: m.recentFiles(),
  };
});
check('本地 .note 在前端直接打开（path 保持为空）',
  localOpen.path === null && localOpen.name === '来自磁盘的白板', JSON.stringify({ path: localOpen.path, name: localOpen.name }));
check('内容与图片都从本地归档读出来',
  localOpen.elements.includes(300001) && localOpen.elements.includes(300002)
  && localOpen.hasArchive === true && localOpen.decoded >= 1,
  JSON.stringify({ elements: localOpen.elements, decoded: localOpen.decoded }));
check('整个过程没有上传，也没有写进 .cache',
  apiCalls.filter((c) => c.includes('/api/upload')).length === 0
  && apiCalls.filter((c) => c.includes('/api/note/save')).length === 0,
  JSON.stringify(apiCalls));
check('记录里记的是「位置」而不是副本路径',
  localOpen.list[0]?.source === 'local' && !localOpen.list[0]?.path && localOpen.list[0]?.name === '来自磁盘的白板.note',
  JSON.stringify(localOpen.list[0]));

/* ---------------------------------------------------------------- *
 * 3. The recent list itself
 * ---------------------------------------------------------------- */
console.log('\n[3] 最近使用的文件列表');
await page.evaluate(async () => {
  const app = window.app;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  for (const name of ['order-third', 'order-second', 'order-first']) {
    app.editor.page.elements = [];
    app.editor.addElement(els.makeText({ bounds: new Rect(80, 80, 400, 60).toString(), text: name, fontSize: 30 }), { select: false });
    app.editor.doc.path = `${name}.note`;   // workspace root: the listing shows it
    app.editor.doc.name = name;
    await app.save();
    await new Promise((r) => setTimeout(r, 1100)); // distinct mtimes
  }
});
await page.evaluate(async () => { await window.app.showOpenDialog(); await new Promise((r) => setTimeout(r, 200)); });
await page.evaluate(async () => {
  document.querySelectorAll('.wb-filerow')[1].click();
  await new Promise((r) => setTimeout(r, 600));
});
const list = await rows();
await closeDialog();
await sleep(150);
const recentTexts = list.map((r) => r.text);
check('最近列表按「最近打开」和「工作区文件」分段', recentTexts.length > 2, JSON.stringify(recentTexts).slice(0, 160));
check('本地文件带「本地文件」徽章并标明需要重新选择',
  list.some((r) => r.tag === '本地文件' && r.desc.includes('需重新选择')),
  JSON.stringify(list.map((r) => `${r.tag}|${r.desc}`)));
check('工作区文件按修改时间倒序（最近的在前）',
  recentTexts.findIndex((t) => t.includes('order-first.note')) < recentTexts.findIndex((t) => t.includes('order-second.note'))
  && recentTexts.findIndex((t) => t.includes('order-second.note')) < recentTexts.findIndex((t) => t.includes('order-third.note')),
  JSON.stringify(recentTexts.map((t) => t.split('·')[0].trim())));

const dedup = await page.evaluate(async () => {
  const app = window.app;
  await app.loadNote('order-first.note', { confirm: false });
  await new Promise((r) => setTimeout(r, 400));
  await app.showOpenDialog();
  await new Promise((r) => setTimeout(r, 200));
  document.querySelectorAll('.wb-filerow')[1].click();
  await new Promise((r) => setTimeout(r, 500));
  return [...document.querySelectorAll('.wb-filerow')].map((r) => r.textContent);
});
check('已出现在最近打开里的文件不会在工作区段重复',
  dedup.filter((t) => t.includes('order-first.note')).length === 1,
  JSON.stringify(dedup.filter((t) => t.includes('order-first')).map((t) => t.slice(0, 40))));
await closeDialog();
await sleep(150);

const clicked = await page.evaluate(async () => {
  const app = window.app;
  const row = [...document.querySelectorAll('.wb-filerow')].find((r) => r.textContent.includes('order-second.note'));
  row.click();
  await new Promise((r) => setTimeout(r, 700));
  return { path: app.editor.doc.path, name: app.editor.doc.name, dialogClosed: !document.querySelector('.wb-filerow') };
});
check('点列表里的条目就能打开对应白板',
  clicked.path === 'order-second.note' && clicked.dialogClosed, JSON.stringify(clicked));

/* ---------------------------------------------------------------- *
 * 4. Clearing, empty state, unsupported files
 * ---------------------------------------------------------------- */
console.log('\n[4] 清空、空状态与不支持的类型');
const cleared = await page.evaluate(async () => {
  const app = window.app;
  await app.showOpenDialog();
  await new Promise((r) => setTimeout(r, 200));
  document.querySelectorAll('.wb-filerow')[1].click();
  await new Promise((r) => setTimeout(r, 500));
  const btn = [...document.querySelectorAll('.wb-toggle')].find((b) => b.textContent.includes('清空记录'));
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  const m = await import('/js/prefs.js');
  return { stored: m.recentFiles().length, text: document.querySelector('.wb-dialog, dialog')?.textContent || '' };
});
check('「清空记录」清空最近打开', cleared.stored === 0 && cleared.text.includes('记录已清空'), String(cleared.stored));
await closeDialog();
await sleep(150);

await closeDialog();
const unsupported = await page.evaluate(async () => {
  const app = window.app;
  const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  await app.openLocalFile(file);
  await new Promise((r) => setTimeout(r, 400));
  return document.querySelector('.wb-toast, .wb-toasts')?.textContent || '';
});
check('不支持的类型给出提示而不是崩溃', unsupported.includes('不支持'), unsupported.slice(0, 40));

/* ---------------------------------------------------------------- *
 * 5. An imported PDF is listed and can be reopened
 * ---------------------------------------------------------------- */
console.log('\n[5] PDF 导入后可以在列表里再次打开');
const pdfImported = await page.evaluate(async () => {
  const app = window.app;
  // A minimal one-page PDF, built in the page so the test needs no fixtures.
  const content = 'BT /F1 18 Tf 20 40 Td (WhiteSoft) Tj ET';
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (const o of objs) { offsets.push(out.length); out += o; }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  await app.importPdfFile(new File([out], 'tiny-test.pdf', { type: 'application/pdf' }));
  await new Promise((r) => setTimeout(r, 800));
  const m = await import('/js/prefs.js');
  return { pages: app.editor.doc.pages.length, list: m.recentFiles().filter((r) => r.kind === 'pdf') };
});
check('PDF 导入生成画纸', pdfImported.pages === 1, String(pdfImported.pages));
check('PDF 只记录位置（没有副本）',
  pdfImported.list.length === 1 && !pdfImported.list[0].path
  && pdfImported.list[0].name === 'tiny-test.pdf'
  && apiCalls.filter((c) => c.includes('/api/upload')).length === 0,
  JSON.stringify(pdfImported.list[0] || null));

await closeDialog();
await sleep(150);
const reopenedPdf = await page.evaluate(async () => {
  const app = window.app;
  app.markModified();                       // 有未保存的改动
  await app.showOpenDialog();
  await new Promise((r) => setTimeout(r, 200));
  document.querySelectorAll('.wb-filerow')[1].click();
  await new Promise((r) => setTimeout(r, 600));
  const row = [...document.querySelectorAll('.wb-filerow')].find((r) => r.textContent.includes('tiny-test.pdf'));
  row.click();
  await new Promise((r) => setTimeout(r, 700));
  // 没有句柄时只能请用户重新选：会弹系统文件对话框（无头下回退到 input[type=file]）
  const inputs = document.querySelectorAll('input[type=file]').length;
  const toast = document.querySelector('.wb-toasts')?.textContent || '';
  document.querySelectorAll('input[type=file]').forEach((i) => i.remove());
  return { inputs, toast, dialogClosed: !document.querySelector('.wb-filerow') };
});
check('没有句柄的本地记录会请用户重新选择文件',
  reopenedPdf.dialogClosed && reopenedPdf.toast.includes('请重新选择'), JSON.stringify(reopenedPdf));

/* ---------------------------------------------------------------- *
 * 6. File System Access API: a real link to the file's location
 * ---------------------------------------------------------------- */
console.log('\n[6] 浏览器文件句柄（位置链接）');
const handleSupport = await page.evaluate(async () => {
  const fh = await import('/js/filehandles.js');
  return { supported: fh.handlesSupported(), hasPicker: typeof window.showOpenFilePicker === 'function' };
});
check('Chrome/Edge 下检测到文件句柄支持',
  handleSupport.supported === true && handleSupport.hasPicker === true, JSON.stringify(handleSupport));

const pickerUsed = await page.evaluate(async () => {
  const app = window.app;
  let called = 0;
  const orig = window.showOpenFilePicker;
  window.showOpenFilePicker = async () => { called++; return []; };   // 用户取消
  await app.pickLocalFile();
  window.showOpenFilePicker = orig;
  return { called, inputs: document.querySelectorAll('input[type=file]').length };
});
check('「从本地文件选择」优先走系统文件选择器（可拿到句柄）',
  pickerUsed.called === 1 && pickerUsed.inputs === 0, JSON.stringify(pickerUsed));

const fallback = await page.evaluate(async () => {
  const app = window.app;
  const orig = window.showOpenFilePicker;
  window.showOpenFilePicker = async () => { throw new Error('not allowed here'); };
  await app.pickLocalFile();
  window.showOpenFilePicker = orig;
  const inputs = document.querySelectorAll('input[type=file]').length;
  document.querySelectorAll('input[type=file]').forEach((i) => i.remove());
  return { inputs };
});
check('选择器不可用时回退到 input[type=file]', fallback.inputs === 1, JSON.stringify(fallback));

await closeDialog();
await page.screenshot({ path: path.join(SHOTS, 'openflow.png') });
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
