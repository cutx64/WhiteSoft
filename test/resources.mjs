/**
 * Image-resource lifecycle regression test.
 *
 * The bug this locks down: paste an image into board A, save, open board B,
 * then reopen A — the picture stayed blank until the whole page was reloaded.
 * `ResourceStore.clear()` revoked the pasted file's object URL but kept the
 * entry, so `urlFor()` handed a dead `blob:` URL to the <img> and `has()`
 * reported the file as present, which kept `loadPageResources()` from reading
 * the copy inside the archive.
 *
 * Boards are local files now: A and B are real `.note` files in the browser's
 * own storage (OPFS) opened through genuine `FileSystemFileHandle`s, so saving,
 * reopening and 另存为 all run their production code paths and the archive can
 * be read back byte for byte instead of through a server API.
 *
 * Usage:  node test/resources.mjs [--chrome <path>] [--url http://127.0.0.1:8787/]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, openFixture, readOpfs, chooseSaveTarget } from './lib/local.mjs';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHROME = arg('chrome', path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');

const profileDir = path.join(__dirname, '.chrome-profile-resources');
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

const A = 'res-A.note';        // the board the picture is pasted into
const B = 'res-B.note';        // a second board that must stay untouched

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
      id: 'resources-seed', version: '1.0.0', screenWidthPixels: 2880, screenHeightPixels: 1920, screenScale: 2,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whitesoft-resources-'));
  fs.writeFileSync(path.join(dir, 'seed.note'), Buffer.from(b64, 'base64'));
  const server = await startFixtureServer(dir);
  return { ...server, tempDir: dir };
}

/** Open a board that already lives in the browser's storage (with its handle). */
async function openOpfsBoard(name, { wait = 1200 } = {}) {
  return page.evaluate(async ({ fileName, wait }) => {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    const app = window.app;
    app.markSaved();
    await app.openLocalFile(file, { handle });
    await new Promise((r) => setTimeout(r, wait));
    return { name: app.editor.doc.name, hasHandle: !!app.editor.doc.fileHandle };
  }, { fileName: name, wait });
}

/** Start a board from the fixture, give it a known page, and write it in place. */
async function makeBoard(name, text) {
  const opened = await openFixture(page, fixtures.url('seed.note'), { name });
  const saved = await page.evaluate(async (label) => {
    const app = window.app;
    const ed = app.editor;
    const els = await import('/js/elements.js');
    const { Rect } = await import('/js/geometry.js');
    ed.page.elements = [];
    ed.addElement(els.makeText({ bounds: new Rect(80, 80, 400, 60).toString(), text: label, fontSize: 30 }), { select: false });
    const ok = await app.save();
    await new Promise((r) => setTimeout(r, 500));
    return { ok, name: ed.doc.name, hasHandle: !!ed.doc.fileHandle };
  }, text);
  return { opened, saved };
}

/** Paint a PNG in the page and paste it through the app's normal path. */
async function pasteImage(color) {
  return page.evaluate(async (color) => {
    const app = window.app;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 150;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 200, 150);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(30, 30, 80, 80);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await app.insertImageBlob(blob);
    await new Promise((r) => setTimeout(r, 500));
    const imgs = app.editor.page.elements.filter((e) => e.type === 300001);
    return imgs[imgs.length - 1]?.fileName || null;
  }, color);
}

/** How much ink the image currently paints, plus the store's view of it. */
async function imageState(fileName) {
  return page.evaluate((file) => {
    const ed = window.app.editor;
    const el = ed.page.elements.find((e) => e.type === 300001 && e.fileName === file);
    const c = document.querySelector('#wb-canvas');
    const dpr = ed.dpr;
    let ink = 0;
    if (el) {
      const [x, y, w, h] = el.bounds.split(',').map(Number);
      const a = ed.worldToScreen(x, y), b = ed.worldToScreen(x + w, y + h);
      const x0 = Math.max(0, Math.floor(a.x * dpr)), y0 = Math.max(0, Math.floor(a.y * dpr));
      const x1 = Math.min(c.width, Math.ceil(b.x * dpr)), y1 = Math.min(c.height, Math.ceil(b.y * dpr));
      if (x1 > x0 && y1 > y0) {
        const d = c.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) ink++;
      }
    }
    const boxes = ed.resources.images.get(file);
    return {
      onPage: !!el,
      ink,
      decoded: !!boxes,
      natural: boxes ? boxes.naturalWidth : 0,
      local: [...ed.resources.local.keys()],
      archive: !!ed.resources.archive,
    };
  }, fileName);
}

/** The picture elements page 1 of a local board refers to. */
const boardImages = (name) => page.evaluate(async (fileName) => {
  const dir = await navigator.storage.getDirectory();
  const file = await (await dir.getFileHandle(fileName)).getFile();
  const { ZipReader } = await import('/js/zipread.js');
  const zip = await ZipReader.open(file);
  const page1 = await zip.json('Pages/page1.json');
  return (page1?.elements || []).filter((e) => e.type === 300001).map((e) => e.fileName);
}, name);

/** The texts page 1 of a local board holds. */
const boardTexts = (name) => page.evaluate(async (fileName) => {
  const dir = await navigator.storage.getDirectory();
  const file = await (await dir.getFileHandle(fileName)).getFile();
  const { ZipReader } = await import('/js/zipread.js');
  const zip = await ZipReader.open(file);
  const page1 = await zip.json('Pages/page1.json');
  return (page1?.elements || []).map((e) => e.text).filter((t) => typeof t === 'string');
}, name);

const fixtures = await startFixtures();

/* ---------------------------------------------------------------- *
 * 1. Two boards, one of them with a pasted image
 * ---------------------------------------------------------------- */
console.log('\n[1] A 粘贴图片并保存');
const boardA = await makeBoard(A, '白板 A');
const boardB = await makeBoard(B, '白板 B');
const aDisk = await readOpfs(page, A);
const bDisk = await readOpfs(page, B);
check('两份白板已建立（各是一份可写回的本地文件）',
  boardA.saved.ok === true && boardB.saved.ok === true
  && boardA.saved.hasHandle === true && boardB.saved.hasHandle === true
  && aDisk.elements.length === 1 && bDisk.elements.length === 1
  && (await boardTexts(A)).join() === '白板 A' && (await boardTexts(B)).join() === '白板 B',
  JSON.stringify({ a: await boardTexts(A), b: await boardTexts(B) }));

await openOpfsBoard(A);
const pasted = await pasteImage('#0169BF');
check('粘贴后图片元素建立', !!pasted, String(pasted));
const afterPaste = await imageState(pasted);
check('粘贴后图片画得出来', afterPaste.decoded && afterPaste.ink > 1000, JSON.stringify(afterPaste).slice(0, 120));

const savedA = await page.evaluate(async () => {
  const ok = await window.app.save();
  await new Promise((r) => setTimeout(r, 500));
  return ok;
});
check('保存 A 成功', savedA === true);
const aImages = await boardImages(A);
const aDiskSaved = await readOpfs(page, A);
check('图片写进了 A.note',
  aImages.includes(pasted) && (aDiskSaved.sizes['Resources/Images/' + pasted] || 0) > 100,
  JSON.stringify({ images: aImages, bytes: aDiskSaved.sizes['Resources/Images/' + pasted] }));

/* ---------------------------------------------------------------- *
 * 2. Switch to B and back — the reported sequence
 * ---------------------------------------------------------------- */
console.log('\n[2] 打开 B 再回到 A');
await openOpfsBoard(B);
const inB = await page.evaluate(() => ({
  local: [...window.app.editor.resources.local.keys()],
  decoded: [...window.app.editor.resources.images.keys()],
  archive: !!window.app.editor.resources.archive,
}));
check('切到 B 后不再持有 A 的图片资源',
  inB.local.length === 0 && inB.decoded.length === 0 && inB.archive === true, JSON.stringify(inB));

const bBefore = (await readOpfs(page, B)).entries.length;
await page.evaluate(async () => { await window.app.save(); await new Promise((r) => setTimeout(r, 500)); });
const bAfter = await readOpfs(page, B);
check('B 里没有混进 A 的图片', (await boardImages(B)).length === 0, JSON.stringify(await boardImages(B)));
check('B 的归档里也没有多出 A 的图片条目', bAfter.entries.length === bBefore,
  `条目数 ${bBefore} → ${bAfter.entries.length}（旧代码会把上一个白板的粘贴图片也写进去）`);

await openOpfsBoard(A, { wait: 1500 });
const reopened = await imageState(pasted);
check('回到 A：图片从归档重新加载', reopened.onPage && reopened.decoded && reopened.natural > 0, JSON.stringify(reopened).slice(0, 140));
check('回到 A：图片真的渲染出来了（本次修复的核心）', reopened.ink > 1000, `ink=${reopened.ink}`);
check('回到 A：内存里不再留着过期的粘贴文件', reopened.local.length === 0, JSON.stringify(reopened.local));

/* ---------------------------------------------------------------- *
 * 3. Same result as a fresh page (the workaround the user had)
 * ---------------------------------------------------------------- */
console.log('\n[3] 与刷新整页后的结果一致');
const beforeReload = reopened.ink;
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(1300);
await openOpfsBoard(A, { wait: 1500 });
const fresh = await imageState(pasted);
check('刷新后同样是加载好的图片', fresh.decoded && fresh.ink > 1000, `ink=${fresh.ink}`);
check('两条路径渲染一致', Math.abs(fresh.ink - beforeReload) <= Math.max(50, fresh.ink * 0.1),
  `会话内 ${beforeReload} vs 刷新后 ${fresh.ink}`);

/* ---------------------------------------------------------------- *
 * 4. …and a second paste / save / reopen cycle still works
 * ---------------------------------------------------------------- */
console.log('\n[4] 再来一轮');
const second = await pasteImage('#E71125');
await page.evaluate(async () => { await window.app.save(); await new Promise((r) => setTimeout(r, 500)); });
await openOpfsBoard(B);
await openOpfsBoard(A, { wait: 1500 });
const both = await page.evaluate(({ f1, f2 }) => {
  const ed = window.app.editor;
  const files = ed.page.elements.filter((e) => e.type === 300001).map((e) => e.fileName);
  return { files, decoded: files.map((f) => ed.resources.images.has(f)), f1, f2 };
}, { f1: pasted, f2: second });
check('两张图片都在页面上且都已解码',
  both.files.length === 2 && both.decoded.every(Boolean), JSON.stringify(both));

const bothInk = await imageState(second);
check('新粘贴的这张也渲染出来了', bothInk.ink > 1000, `ink=${bothInk.ink}`);

/* ---------------------------------------------------------------- *
 * 3b. A board opened from local disk keeps its pictures when saved
 * ---------------------------------------------------------------- */
console.log('\n[3b] 本地打开的白板另存到本机后图片仍在');
const viaLocal = await page.evaluate(async (a) => {
  const app = window.app;
  const ed = app.editor;
  // read board A as if the user had just picked it from disk (no handle)
  const dir = await navigator.storage.getDirectory();
  const blob = await (await dir.getFileHandle(a)).getFile();
  app.markSaved();
  await app.openLocalFile(new File([blob], 'picked-from-disk.note', { type: 'application/x-note' }));
  await new Promise((r) => setTimeout(r, 1300));
  return {
    name: ed.doc.name,
    hasHandle: !!ed.doc.fileHandle,
    localFile: ed.doc.localFile?.name || null,
    hasArchive: !!ed.resources.archive,
    decoded: [...ed.resources.images.keys()].length,
  };
}, A);
check('本地打开时不经过服务端（本地归档 + 已解码图片）',
  viaLocal.hasHandle === false && viaLocal.localFile === 'picked-from-disk.note'
  && viaLocal.hasArchive && viaLocal.decoded >= 1, JSON.stringify(viaLocal));

await chooseSaveTarget(page, 'res-local-saved.note');
const savedLocal = await page.evaluate(async () => {
  const app = window.app;
  const ok = await app.saveAs();
  await new Promise((r) => setTimeout(r, 700));
  return { ok, savedTo: window.__savedTo || [], name: app.editor.doc.name, hasHandle: !!app.editor.doc.fileHandle };
});
const savedDisk = await readOpfs(page, 'res-local-saved.note');
const savedImages = await boardImages('res-local-saved.note');
const savedImageBytes = savedDisk.sizes['Resources/Images/' + pasted] || 0;
check('另存为到本机时把归档里的图片一起写进去',
  savedLocal.ok === true && savedLocal.savedTo.includes('res-local-saved.note')
  && savedImages.includes(pasted) && savedImageBytes > 100,
  JSON.stringify({ name: savedLocal.name, images: savedImages, bytes: savedImageBytes }));

/* ---------------------------------------------------------------- *
 * 3c. Pasting while a locally opened board is open
 * ---------------------------------------------------------------- */
// The bug: a pasted file lives in memory, not in the archive that happens to be
// open, so it must be resolved from its object URL first.  Looking it up in the
// archive returned nothing, `insertImageBlob` then fell back to a guessed 0.6
// aspect ratio, and the picture came out badly stretched.
console.log('\n[3c] 在本地打开的白板里粘贴图片');
const localBoard = await page.evaluate(async (a) => {
  const app = window.app;
  const dir = await navigator.storage.getDirectory();
  const file = await (await dir.getFileHandle(a)).getFile();
  app.markSaved();
  await app.openLocalFile(new File([file], 'pasted-into.note', { type: 'application/x-note' }));
  await new Promise((r) => setTimeout(r, 1400));
  return {
    bytes: file.size,
    archive: !!app.editor.resources.archive,
    hasHandle: !!app.editor.doc.fileHandle,
    path: app.editor.doc.localFile?.name || null,
    name: app.editor.doc.name,
    toast: document.querySelector('.wb-toasts')?.textContent || '',
  };
}, A);
check('先本地打开一个白板（归档模式）',
  localBoard.archive === true && localBoard.hasHandle === false && localBoard.name === 'pasted-into'
  && localBoard.toast.includes('已打开'),
  JSON.stringify(localBoard));

const pastedLocal = await page.evaluate(async () => {
  const app = window.app;
  const ed = app.editor;
  const c = document.createElement('canvas');
  c.width = 300; c.height = 100;              // 3:1 — nothing like the 0.6 fallback
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0169BF'; ctx.fillRect(0, 0, 300, 100);
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(20, 20, 60, 60);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  await app.insertImageBlob(blob);
  await new Promise((r) => setTimeout(r, 500));
  const el = ed.page.elements.filter((e) => e.type === 300001).at(-1);
  const [, , w, h] = el.bounds.split(',').map(Number);
  const img = ed.resources.get(el.fileName);
  return {
    decoded: !!img,
    ratio: +(h / w).toFixed(4),
    natural: img ? +(img.naturalHeight / img.naturalWidth).toFixed(4) : null,
  };
});
check('本地归档打开时，粘贴的图片仍然解码成功',
  pastedLocal.decoded === true, JSON.stringify(pastedLocal));
check('粘贴的图片比例等于原始比例（不是 0.6 的兜底值）',
  pastedLocal.natural != null && Math.abs(pastedLocal.ratio - pastedLocal.natural) < 0.01
  && Math.abs(pastedLocal.ratio - 0.6) > 0.05,
  JSON.stringify(pastedLocal));

const pastedBlank = await page.evaluate(async () => {
  const app = window.app;
  app.markSaved();
  await app.newDocument();                     // 回到“没有归档”的空白白板
  const c = document.createElement('canvas');
  c.width = 300; c.height = 100;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#00A656'; ctx.fillRect(0, 0, 300, 100);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  await app.insertImageBlob(blob);
  await new Promise((r) => setTimeout(r, 500));
  const el = app.editor.page.elements.filter((e) => e.type === 300001).at(-1);
  const [, , w, h] = el.bounds.split(',').map(Number);
  return { ratio: +(h / w).toFixed(4), archive: !!app.editor.resources.archive };
});
check('空白页面粘贴的比例同样正确（两条路径一致）',
  Math.abs(pastedBlank.ratio - pastedLocal.natural) < 0.01, JSON.stringify(pastedBlank));

await page.evaluate(() => { window.app.editor.clearSelection(); window.app.editor.draw(); });
await sleep(300);
await page.screenshot({ path: path.join(SHOTS, 'resources.png') });
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
