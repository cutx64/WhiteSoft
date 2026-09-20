/** Pages-panel thumbnail check (renders lazily, so give it time). */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = path.join(__dirname, '.chrome-profile-thumbs');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'),
  headless: 'new',
  userDataDir: profileDir,
  env: { ...process.env, HOME: chromeHome, XDG_CONFIG_HOME: path.join(chromeHome, '.config'), XDG_CACHE_HOME: path.join(chromeHome, '.cache') },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-crashpad'],
  defaultViewport: { width: 1500, height: 1000 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('[E]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[c]', m.text().slice(0, 160)); });

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
await sleep(1200);
await page.evaluate(() => window.app.loadNote('Al-jabr-1.note', { confirm: false }));
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await sleep(2000);
await page.evaluate(() => { window.app.editor.gotoPage(166); window.app.ui.togglePages(true); });
await sleep(6000);
const stats = await page.evaluate(() => {
  const cs = [...document.querySelectorAll('.wb-thumbcanvas')];
  let painted = 0;
  for (const c of cs) {
    try {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let nonWhite = 0;
      for (let i = 0; i < d.length; i += 4 * 37) if (d[i + 3] > 0 && (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240)) nonWhite++;
      if (nonWhite > 3) painted++;
    } catch { /* ignore */ }
  }
  return { count: cs.length, painted, cache: window.app.ui.thumbCache?.size ?? 0 };
});
console.log('thumbnails:', JSON.stringify(stats));
await page.screenshot({ path: path.join(__dirname, 'test/shots/thumbs.png') });
await browser.close();
console.log(stats.painted > 0 ? 'OK: thumbnails render' : 'FAIL: no painted thumbnails');
