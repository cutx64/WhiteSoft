/** Final sanity pass: clean load shows no dirty marker; an edit does. */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = path.join(__dirname, '.chrome-profile-final');
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
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
await sleep(1500);

const dirty = () => page.$eval('.wb-savestate', (n) => n.textContent.trim());
console.log('fresh board dirty marker:', JSON.stringify(await dirty()));

await page.evaluate(() => window.app.loadNote('Al-jabr-1.note', { confirm: false }));
await page.waitForFunction(() => window.app.editor.doc.pages.length > 100, { timeout: 120000 });
await sleep(2000);
console.log('after opening a note:', JSON.stringify(await dirty()));
await page.evaluate(() => window.app.editor.nextPage());
await sleep(500);
console.log('after page navigation:', JSON.stringify(await dirty()));

// draw something
const box = await page.$eval('#wb-canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y }; });
await page.evaluate(() => window.app.ui.selectTool('pen'));
await page.mouse.move(box.x + 300, box.y + 300);
await page.mouse.down();
for (let i = 0; i < 15; i++) { await page.mouse.move(box.x + 300 + i * 8, box.y + 300 + Math.sin(i / 3) * 20); await sleep(8); }
await page.mouse.up();
await sleep(400);
console.log('after drawing:', JSON.stringify(await dirty()));
await page.evaluate(() => window.app.undo());
await sleep(300);
console.log('after undo:', JSON.stringify(await dirty()));

// pages panel + final screenshot on a rich page
await page.evaluate(() => {
  const ed = window.app.editor;
  const idx = ed.doc.pages.findIndex((p) => p.elements.length > 150);
  ed.gotoPage(idx);
  ed.fitPageWidth();
});
await sleep(4000);
await page.screenshot({ path: path.join(__dirname, 'test/shots/final-overview.png') });
console.log('screenshot → test/shots/final-overview.png');
console.log('errors:', errs.filter((e) => !e.includes('favicon')).length ? errs : '(none)');
await browser.close();
