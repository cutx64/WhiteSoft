/**
 * Image-resource lifecycle regression test.
 *
 * The bug this locks down: paste an image into board A, save, open board B,
 * then reopen A — the picture stayed blank until the whole page was reloaded.
 * `ResourceStore.clear()` revoked the pasted file's object URL but kept the
 * entry, so `urlFor()` handed a dead `blob:` URL to the <img> and `has()`
 * reported the file as present, which kept `loadPageResources()` from asking
 * the server for the copy inside the archive.
 *
 * Usage:  node test/resources.mjs [--chrome <path>] [--url http://127.0.0.1:8787/]
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

const A = '.cache/res-A.note';
const B = '.cache/res-B.note';

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
      notePath: ed.resources.notePath,
    };
  }, fileName);
}

const boardImages = (target) => page.evaluate(async (p) => {
  const res = await fetch('/api/note/pages?path=' + encodeURIComponent(p));
  const json = await res.json();
  return Object.values(json.pages).flatMap((pg) => pg.elements.filter((e) => e.type === 300001).map((e) => e.fileName));
}, target);

/** Number of entries inside a `.note` archive. */
const entryCount = (target) => page.evaluate(async (p) => {
  const res = await fetch('/api/note/meta?path=' + encodeURIComponent(p));
  return (await res.json()).entryCount;
}, target);

/* ---------------------------------------------------------------- *
 * 1. Two boards, one of them with a pasted image
 * ---------------------------------------------------------------- */
console.log('\n[1] A 粘贴图片并保存');
const fileA = await page.evaluate(async ({ a, b }) => {
  const app = window.app;
  const els = await import('/js/elements.js');
  const { Rect } = await import('/js/geometry.js');
  const mk = (text) => {
    app.editor.page.elements = [];
    app.editor.addElement(els.makeText({ bounds: new Rect(80, 80, 400, 60).toString(), text, fontSize: 30 }), { select: false });
  };
  mk('白板 A');
  app.editor.doc.path = a; app.editor.doc.name = 'res-A';
  await app.save();
  mk('白板 B');
  app.editor.doc.path = b; app.editor.doc.name = 'res-B';
  await app.save();

  await app.loadNote(a, { confirm: false });
  await new Promise((r) => setTimeout(r, 400));
  return true;
}, { a: A, b: B });
check('两份白板已建立', fileA === true);

const pasted = await pasteImage('#0169BF');
check('粘贴后图片元素建立', !!pasted, String(pasted));
const afterPaste = await imageState(pasted);
check('粘贴后图片画得出来', afterPaste.decoded && afterPaste.ink > 1000, JSON.stringify(afterPaste).slice(0, 120));

const savedA = await page.evaluate(async (a) => { await window.app.save(); await new Promise((r) => setTimeout(r, 400)); return true; }, A);
check('保存 A 成功', savedA === true);
check('图片写进了 A.note', (await boardImages(A)).includes(pasted), JSON.stringify(await boardImages(A)));

/* ---------------------------------------------------------------- *
 * 2. Switch to B and back — the reported sequence
 * ---------------------------------------------------------------- */
console.log('\n[2] 打开 B 再回到 A');
await page.evaluate(async (b) => { await window.app.loadNote(b, { confirm: false }); }, B);
await sleep(900);
const inB = await page.evaluate(() => ({
  local: [...window.app.editor.resources.local.keys()],
  decoded: [...window.app.editor.resources.images.keys()],
  notePath: window.app.editor.resources.notePath,
}));
check('切到 B 后不再持有 A 的图片资源',
  inB.local.length === 0 && inB.decoded.length === 0, JSON.stringify(inB));

const bBefore = await entryCount(B);
await page.evaluate(async (b) => { await window.app.save(); await new Promise((r) => setTimeout(r, 400)); }, B);
check('B 里没有混进 A 的图片', (await boardImages(B)).length === 0, JSON.stringify(await boardImages(B)));
check('B 的归档里也没有多出 A 的图片条目', (await entryCount(B)) === bBefore,
  `条目数 ${bBefore} → ${await entryCount(B)}（旧代码会把上一个白板的粘贴图片也写进去）`);

await page.evaluate(async (a) => { await window.app.loadNote(a, { confirm: false }); }, A);
await sleep(1500);
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
await page.evaluate(async (a) => { await window.app.loadNote(a, { confirm: false }); }, A);
await sleep(1500);
const fresh = await imageState(pasted);
check('刷新后同样是加载好的图片', fresh.decoded && fresh.ink > 1000, `ink=${fresh.ink}`);
check('两条路径渲染一致', Math.abs(fresh.ink - beforeReload) <= Math.max(50, fresh.ink * 0.1),
  `会话内 ${beforeReload} vs 刷新后 ${fresh.ink}`);

/* ---------------------------------------------------------------- *
 * 4. …and a second paste / save / reopen cycle still works
 * ---------------------------------------------------------------- */
console.log('\n[4] 再来一轮');
const second = await pasteImage('#E71125');
await page.evaluate(async () => { await window.app.save(); await new Promise((r) => setTimeout(r, 400)); });
await page.evaluate(async (b) => { await window.app.loadNote(b, { confirm: false }); }, B);
await sleep(800);
await page.evaluate(async (a) => { await window.app.loadNote(a, { confirm: false }); }, A);
await sleep(1500);
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
console.log('\n[3b] 本地打开的白板另存到工作区后图片仍在');
const viaLocal = await page.evaluate(async ({ a }) => {
  const app = window.app;
  const ed = app.editor;
  // read the workspace copy of A as if the user had just picked it from disk
  const blob = await (await fetch('/api/raw?path=' + encodeURIComponent(a))).blob();
  const file = new File([blob], 'picked-from-disk.note');
  app.markSaved();
  await app.openLocalFile(file);
  await new Promise((r) => setTimeout(r, 1200));
  const opened = {
    path: ed.doc.path,
    hasArchive: !!ed.resources.archive,
    decoded: [...ed.resources.images.keys()].length,
  };
  ed.doc.path = '.cache/res-local-saved.note';
  await app.save();
  await new Promise((r) => setTimeout(r, 800));
  const pages = await (await fetch('/api/note/pages?path=' + encodeURIComponent('.cache/res-local-saved.note'))).json();
  const img = Object.values(pages.pages).flat().flatMap((pg) => pg.elements).find((e) => e.type === 300001);
  let bytes = 0;
  if (img) {
    const r = await fetch('/api/note/entry?path=' + encodeURIComponent('.cache/res-local-saved.note')
      + '&name=' + encodeURIComponent('Resources/Images/' + img.fileName));
    bytes = (await r.arrayBuffer()).byteLength;
  }
  return { ...opened, savedImage: !!img, bytes };
}, { a: A });
check('本地打开时不经过服务端（本地归档 + 已解码图片）',
  viaLocal.path === null && viaLocal.hasArchive && viaLocal.decoded >= 1, JSON.stringify(viaLocal));
check('另存到工作区时把归档里的图片一起写进去',
  viaLocal.savedImage && viaLocal.bytes > 100, JSON.stringify(viaLocal));

await page.evaluate(() => { window.app.editor.clearSelection(); window.app.editor.draw(); });
await sleep(300);
await page.screenshot({ path: path.join(SHOTS, 'resources.png') });
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
