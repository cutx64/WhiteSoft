/**
 * Pen-stroke continuity regression test.
 *
 * Walks the centreline of every ink element and samples the rendered canvas:
 * a correct variable-width ribbon must be painted at *every* sample.  Merging
 * the ribbon and its round caps/joints into one path (or any other winding
 * mistake) punches holes in the stroke, which this catches.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = path.join(__dirname, '.chrome-profile-stroke');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'),
  headless: 'new', userDataDir: profileDir,
  env: { ...process.env, HOME: chromeHome, XDG_CONFIG_HOME: path.join(chromeHome, '.config'), XDG_CACHE_HOME: path.join(chromeHome, '.cache') },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-crashpad'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('[E]', e.message));
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
await sleep(1500);

const box = await page.$eval('#wb-canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

/** Walk along the expected path and sample the canvas for unpainted gaps. */
async function gapReport(label) {
  return page.evaluate((lbl) => {
    const ed = window.app.editor;
    const c = document.querySelector('#wb-canvas');
    const ctx = c.getContext('2d');
    const dpr = ed.dpr;
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const at = (sx, sy) => {
      const x = Math.round(sx * dpr), y = Math.round(sy * dpr);
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
      const i = (y * c.width + x) * 4;
      return { r: img[i], g: img[i + 1], b: img[i + 2], a: img[i + 3] };
    };
    const ink = ed.page.elements.filter((e) => e.type === 100001);
    const out = [];
    for (const e of ink) {
      const pts = e.inks;
      let painted = 0, gaps = 0, worstRun = 0, run = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(2, Math.ceil(len * ed.camera.zoom));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const p = ed.worldToScreen(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
          const px = at(p.x, p.y);
          const dark = px && px.r < 200 && px.g < 200 && px.b < 200;
          if (dark) { painted++; run = 0; } else { gaps++; run++; worstRun = Math.max(worstRun, run); }
        }
      }
      out.push({ points: pts.length, painted, gaps, worstGapRun: worstRun, width: e.width, stroke: e.stroke });
    }
    return { label: lbl, inkCount: ink.length, strokes: out };
  }, label);
}

async function drawStroke(label, y0, steps, wave = 40) {
  await page.evaluate(() => { window.app.editor.page.elements = []; window.app.editor.invalidate(); window.app.ui.closeFlyout(); window.app.ui.selectTool('pen'); });
  await sleep(300);
  await page.mouse.move(box.x + 200, box.y + y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(box.x + 200 + i * 8, box.y + y0 + Math.sin(i / 4) * wave);
    await sleep(10);
  }
  await page.mouse.up();
  await sleep(400);
  const duringCommit = await gapReport(label + ' / 提交后');
  // force a cache rebuild (change zoom bucket) and re-check
  await page.evaluate(() => { window.app.editor.renderer.invalidate(); window.app.editor.requestRender(); });
  await sleep(400);
  const afterRebuild = await gapReport(label + ' / 重建后');
  return { duringCommit, afterRebuild };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

async function verify(label, zoom, steps, wave) {
  await page.evaluate((z) => window.app.editor.setZoom(z), zoom);
  await sleep(600);
  const r = await drawStroke(label, 300, steps, wave);
  for (const [phase, rep] of [['提交后', r.duringCommit], ['缓存重建后', r.afterRebuild]]) {
    const s = rep.strokes[0];
    check(`${label} ${phase}：笔迹连续无断点`,
      !!s && s.gaps === 0 && s.points > 20,
      s ? `${s.points} 点 / ${s.painted} 命中 / ${s.gaps} 断点（最长 ${s.worstGapRun}）` : '没有生成笔迹');
  }
  return r;
}

console.log('\n[笔迹连续性]');
await verify('80%', 0.8, 60, 40);
await verify('150%', 1.5, 60, 40);
await verify('45%', 0.45, 60, 40);
await verify('80% 大幅摆动', 0.8, 80, 120);

// a highlighter stroke must be continuous too
await page.evaluate(() => {
  const ed = window.app.editor;
  ed.page.elements = [];
  ed.invalidate();
  window.app.ui.selectTool('highlighter');
});
await sleep(300);
await page.mouse.move(box.x + 200, box.y + 450);
await page.mouse.down();
for (let i = 1; i <= 50; i++) {
  await page.mouse.move(box.x + 200 + i * 9, box.y + 450 + Math.sin(i / 5) * 25);
  await sleep(9);
}
await page.mouse.up();
await sleep(400);
const hl = await page.evaluate(() => {
  const ed = window.app.editor;
  const c = document.querySelector('#wb-canvas');
  const ctx = c.getContext('2d');
  const dpr = ed.dpr;
  const img = ctx.getImageData(0, 0, c.width, c.height).data;
  const e = ed.page.elements.find((x) => x.type === 100005);
  if (!e) return null;
  let painted = 0, gaps = 0;
  for (let i = 0; i + 1 < e.points.length; i++) {
    const [ax, ay] = e.points[i].point.split(',').map(Number);
    const [bx, by] = e.points[i + 1].point.split(',').map(Number);
    const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) * ed.camera.zoom / 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const p = ed.worldToScreen(ax + (bx - ax) * t, ay + (by - ay) * t);
      const x = Math.round(p.x * dpr), y = Math.round(p.y * dpr);
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
      const k = (y * c.width + x) * 4;
      const isWhite = img[k] > 250 && img[k + 1] > 250 && img[k + 2] > 250;
      if (!isWhite) painted++; else gaps++;
    }
  }
  return { points: e.points.length, painted, gaps };
});
check('荧光笔笔迹连续无断点', !!hl && hl.gaps === 0, JSON.stringify(hl));

await page.screenshot({ path: path.join(__dirname, 'test/shots/stroke-continuity.png') });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
process.exitCode = failed.length ? 1 : 0;
