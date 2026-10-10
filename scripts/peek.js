import { attach } from '../src/bot.js';
import * as P from '../src/passo.js';
import { screenshot } from '../src/log.js';
import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const { page } = await attach(cfg);
const info = await page.evaluate(() => ({
  url: location.href,
  iframes: [...document.querySelectorAll('iframe')].map((f) => { const r = f.getBoundingClientRect(); return (f.src || f.title || '').slice(0, 70) + ` [${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}]`; }),
  modals: [...document.querySelectorAll('.modal.show, .swal2-container')].map((m) => m.innerText.replace(/\s+/g, ' ').slice(0, 200)),
  selected: (document.body.innerText.match(/Seçilen Koltuklar\s*\((\d+)\)/) || [])[1],
  turnstileEls: [...document.querySelectorAll('[class*=turnstile], [id*=turnstile], .cf-turnstile')].map((e) => { const r = e.getBoundingClientRect(); return e.tagName + '.' + e.className + ` [${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}]`; }),
}));
console.log(JSON.stringify(info, null, 1));
await screenshot(page, 'peek');
console.log('basket', JSON.stringify(await P.getBasket(page)).slice(0, 160));
process.exit(0);
