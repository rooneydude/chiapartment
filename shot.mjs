import { chromium } from 'playwright-core';
const D = '/tmp/claude-0/-home-user-chiapartment/39cc3aff-111e-54fb-a7fc-1ae5a542a852/scratchpad';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://127.0.0.1:3116/buildings/demo-tower', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
const canvas = await page.$('canvas');
console.log('canvas present:', !!canvas);
if (canvas) {
  const box = await canvas.boundingBox();
  console.log('canvas size:', box && `${Math.round(box.width)}x${Math.round(box.height)}`);
  // Check the canvas actually drew something rather than staying blank.
  const nonBlank = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return { hasGL: !!gl, w: c.width, h: c.height };
  });
  console.log('gl:', JSON.stringify(nonBlank));
}
console.log('callout text:', await page.textContent('body').then(t => (t.match(/Unit \d+/) || ['none'])[0]));
await page.screenshot({ path: D + '/building.png' });

await page.goto('http://127.0.0.1:3116/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.screenshot({ path: D + '/home.png', fullPage: true });

await page.goto('http://127.0.0.1:3116/compare?beds=2', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: D + '/compare.png', fullPage: true });

console.log('console errors:', errors.length ? errors.slice(0,8) : 'none');
await browser.close();
