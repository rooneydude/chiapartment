import { chromium } from 'playwright-core';
const D='/tmp/claude-0/-home-user-chiapartment/39cc3aff-111e-54fb-a7fc-1ae5a542a852/scratchpad';
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const page = await b.newPage({viewport:{width:1500,height:950}, deviceScaleFactor:1});
await page.goto('http://127.0.0.1:3118/buildings/demo-tower',{waitUntil:'networkidle'});
await page.waitForTimeout(3000);
const rows = await page.$$('ul li button');
console.log('rows:', rows.length);
// Select the LAST row (lowest floor) and see where the orange lands.
await rows[rows.length-1].click();
await page.waitForTimeout(2000);
console.log('selected:', (await page.textContent('h2')));
console.log('detail:', (await page.textContent('[title]'))?.slice(0,0) ?? '');
const stats = await page.$$eval('dl div dd', els => els.map(e=>e.textContent));
console.log('stats:', stats.join(' | '));
await page.$eval('canvas', c=>c.scrollIntoView());
await (await page.$('canvas')).screenshot({path: D+'/canvas_low.png'});
await b.close();
