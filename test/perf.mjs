/**
 * Frame-rate harness.
 *
 * Drives the app and records real animation-frame timings while drawing,
 * marquee-selecting, panning and zooming — on a light page and on the
 * heaviest page of the sample board.
 *
 * The board is a real file now: the sample is served read-only over HTTP by a
 * fixture server and handed to the page as a `File` (see test/lib/local.mjs),
 * which is the same path a dragged-in board takes.
 *
 *   node test/perf.mjs [--note <path>] [--index 264] [--dpr 1] [--json]
 *                      [--headed] [--url http://127.0.0.1:8787/] [--chrome <path>]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, openFixture } from './lib/local.mjs';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHROME = arg('chrome', path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'));
const URL_BASE = arg('url', 'http://127.0.0.1:8787/');
const JSON_OUT = argv.includes('--json');
const PAGE_INDEX = Number(arg('index', 264));
const DPR = Number(arg('dpr', 1));
const HEADED = argv.includes('--headed');
const SHOTS = path.join(__dirname, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

/** `--note` is a path on disk; a bare file name is looked up in the usual spots. */
function resolveNote(given = 'Al-jabr-1.note') {
  const name = path.basename(given);
  const candidates = [
    path.resolve(given),
    path.join(__dirname, name),
    path.join(__dirname, '.tmp-boards', name),
    path.join(process.cwd(), name),
    path.join('/home/cutx64/Workspace/Maths', name),
  ];
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* keep looking */ } }
  console.error(`找不到样例白板：${given}\n请用 --note <path/to/board.note> 指定一个 .note 文件。`);
  process.exit(1);
}
const NOTE = resolveNote(arg('note', 'Al-jabr-1.note'));

const profileDir = path.join(__dirname, '.chrome-profile-perf');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADED ? false : 'new',
  userDataDir: profileDir,
  protocolTimeout: 600000,
  env: {
    ...process.env, HOME: chromeHome,
    XDG_CONFIG_HOME: path.join(chromeHome, '.config'), XDG_CACHE_HOME: path.join(chromeHome, '.cache'),
  },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-crashpad', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
if (DPR !== 1) await page.emulateVisionDeficiency?.('none');
if (DPR !== 1) {
  await page.evaluateOnNewDocument((d) => {
    Object.defineProperty(window, 'devicePixelRatio', { get: () => d, configurable: true });
  }, DPR);
}
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await sleep(1200);

const fixtures = await startFixtureServer(path.dirname(NOTE));
console.log(`→ opening ${NOTE} (served read-only)`);
await openFixture(page, fixtures.url(path.basename(NOTE)), { writable: false });
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await sleep(1500);

const box = await page.$eval('#wb-canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const C = (dx, dy) => [box.x + dx, box.y + dy];

/** Record frame intervals while `fn` drives the mouse. */
async function fps(label, fn) {
  await page.evaluate(() => {
    window.__f = [];
    window.__r = [];
    window.__rb = 0;
    window.__stop = false;
    let last = performance.now();
    const tick = (t) => {
      window.__f.push(t - last);
      window.__r.push(window.app.editor.renderer.lastStats.ms);
      if (window.app.editor.renderer.lastStats.rebuilt) window.__rb++;
      last = t;
      if (!window.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await fn();
  const stats = await page.evaluate(() => {
    window.__stop = true;
    const f = window.__f.slice(3);
    if (!f.length) return null;
    const sorted = [...f].sort((a, b) => a - b);
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    return {
      frames: f.length,
      avgMs: avg,
      fps: 1000 / avg,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      worst: sorted[sorted.length - 1],
      renderMs: window.app.editor.renderer.lastStats.ms,
      avgRender: window.__r.reduce((a, b) => a + b, 0) / Math.max(1, window.__r.length),
      maxRender: Math.max(...window.__r),
      rebuilds: window.__rb,
    };
  });
  if (!JSON_OUT) {
    console.log(`  ${label.padEnd(24)} ${stats.fps.toFixed(1).padStart(5)} fps  p95 ${stats.p95.toFixed(1).padStart(5)}ms  worst ${stats.worst.toFixed(0).padStart(4)}ms  draw avg ${stats.avgRender.toFixed(1).padStart(5)}ms max ${stats.maxRender.toFixed(0).padStart(4)}ms  rebuilds ${stats.rebuilds}`);
  }
  return stats;
}

const report = {};

async function scenario(name, index, prepare) {
  console.log(`\n[${name}]`);
  await page.evaluate((i) => {
    const ed = window.app.editor;
    ed.gotoPage(i);
    window.app.ui.closeFlyout();
  }, index);
  await sleep(2500);
  if (prepare) await page.evaluate(prepare);
  await sleep(500);

  report[name] = {};
  report[name].elements = await page.evaluate(() => window.app.editor.page.elements.length);

  // --- freehand drawing ---
  await page.evaluate(() => window.app.ui.selectTool('pen'));
  report[name].draw = await fps('画笔实时渲染', async () => {
    await page.mouse.move(...C(300, 300));
    await page.mouse.down();
    for (let i = 0; i < 60; i++) {
      await page.mouse.move(box.x + 300 + Math.sin(i / 6) * 200 + i * 6, box.y + 300 + Math.cos(i / 5) * 120);
      await sleep(12);
    }
    await page.mouse.up();
  });
  await page.evaluate(() => window.app.undo());

  // --- marquee selection ---
  await page.evaluate(() => window.app.ui.selectTool('marquee'));
  report[name].marquee = await fps('矩形框选', async () => {
    await page.mouse.move(...C(200, 200));
    await page.mouse.down();
    for (let i = 0; i < 40; i++) {
      await page.mouse.move(box.x + 200 + i * 20, box.y + 200 + i * 12);
      await sleep(12);
    }
    await page.mouse.up();
  });

  // --- panning ---
  await page.evaluate(() => window.app.ui.selectTool('pan'));
  report[name].pan = await fps('平移画布', async () => {
    await page.mouse.move(...C(700, 500));
    await page.mouse.down();
    for (let i = 0; i < 40; i++) {
      await page.mouse.move(box.x + 700 + Math.sin(i / 5) * 220, box.y + 500 + Math.cos(i / 7) * 140);
      await sleep(12);
    }
    await page.mouse.up();
  });

  // --- zooming ---
  report[name].zoom = await fps('缩放画布', async () => {
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel({ deltaY: i < 15 ? -60 : 60 });
      await sleep(16);
    }
  });

  await page.evaluate(() => window.app.ui.selectTool('select'));
}

await scenario('轻页面', 1);
await scenario('重页面', PAGE_INDEX);

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('\n--- 汇总 (fps) ---');
  for (const [k, v] of Object.entries(report)) {
    console.log(`${k}: 元素 ${v.elements} | 画笔 ${v.draw.fps.toFixed(1)} | 框选 ${v.marquee.fps.toFixed(1)} | 平移 ${v.pan.fps.toFixed(1)} | 缩放 ${v.zoom.fps.toFixed(1)}`);
  }
}
fs.writeFileSync(path.join(SHOTS, 'perf.json'), JSON.stringify(report, null, 2));
await fixtures.close();
await browser.close();
