import { chromium } from 'playwright-core';
const D = '/tmp/claude-0/-home-user-chiapartment/39cc3aff-111e-54fb-a7fc-1ae5a542a852/scratchpad';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://127.0.0.1:3118/buildings/demo-tower', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);

// Pick a mid-building unit so the highlight is not at the very top edge.
const rows = await page.$$('ul li button');
if (rows.length > 12) { await rows[12].click(); await page.waitForTimeout(2200); }
console.log('selected:', await page.textContent('h2'));

await page.screenshot({ path: D + '/building2.png' });
const canvas = await page.$('canvas');
await canvas.screenshot({ path: D + '/canvas.png' });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
