/** Focused check of the inline text / sticky / table editors. */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = path.join(__dirname, '.chrome-profile-inline');
fs.rmSync(profileDir, { recursive: true, force: true });
const chromeHome = path.join(__dirname, '.chrome-home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: path.join(__dirname, '.browsers/chrome/linux-153.0.8010.52/chrome-linux64/chrome'),
  headless: 'new',
  userDataDir: profileDir,
  env: { ...process.env, HOME: chromeHome, XDG_CONFIG_HOME: path.join(chromeHome, '.config'), XDG_CACHE_HOME: path.join(chromeHome, '.cache') },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter', '--no-crashpad'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('[E]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[c]', m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
await sleep(1500);

const box = await page.$eval('#wb-canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y };
});

async function probe(label) {
  const s = await page.evaluate(() => ({
    active: document.activeElement ? document.activeElement.className || document.activeElement.tagName : 'none',
    editors: document.querySelectorAll('.wb-inline-editor').length,
    inlineCurrent: !!window.app.editor.inline.current,
    elements: window.app.editor.page.elements.length,
    types: window.app.editor.page.elements.map((e) => e.type),
  }));
  console.log(label, JSON.stringify(s));
  return s;
}

console.log('--- TEXT ---');
await page.evaluate(() => window.app.ui.selectTool('text'));
await sleep(200);
await page.mouse.click(box.x + 300, box.y + 300);
await sleep(600);
await probe('after click:');
await page.keyboard.type('Hello 你好');
await sleep(300);
await probe('after type:');
await page.keyboard.press('Escape');
await sleep(400);
const t = await probe('after esc:');
console.log('   texts:', await page.evaluate(() => window.app.editor.page.elements.map((e) => e.text)));

console.log('--- STICKY ---');
await page.evaluate(() => window.app.ui.selectTool('sticky'));
await sleep(200);
await page.mouse.click(box.x + 600, box.y + 300);
await sleep(600);
await probe('after click:');
await page.keyboard.type('Sticky 便签');
await sleep(300);
await page.keyboard.press('Escape');
await sleep(400);
console.log('   texts:', await page.evaluate(() => window.app.editor.page.elements.map((e) => e.text)));

console.log('--- reopen text by double click ---');
await page.evaluate(() => window.app.ui.selectTool('select'));
await sleep(200);
await page.mouse.click(box.x + 300, box.y + 300, { clickCount: 2 });
await sleep(700);
await probe('after dblclick:');
await page.keyboard.press('Escape');
await sleep(300);

await page.screenshot({ path: path.join(__dirname, 'test/shots/inline-probe.png') });
await browser.close();
void t;
