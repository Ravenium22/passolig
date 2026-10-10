// Dry run against a match that is ON SALE NOW. Exercises: attach, ticket type, manual map,
// block click (real mouse), seat click, "Seçilen Koltuklar (1)", then cleans up. Never pays.
// Usage: node scripts/dryrun.js [--event 13390322] [--url <eventUrl>] [--cats "7.Kategori,8.Kategori"] [--to-basket] [--keep]
import { log, screenshot } from '../src/log.js';
import * as P from '../src/passo.js';
import { parseArgs, attach, preflight, go, pick } from '../src/bot.js';
import fs from 'node:fs';

const args = parseArgs(process.argv.slice(2));
const base = fs.existsSync('config.json') ? JSON.parse(fs.readFileSync('config.json', 'utf8')) : JSON.parse(fs.readFileSync('config.example.json', 'utf8'));
const cfg = {
  ...base,
  eventId: Number(args.event || 13390322),
  eventUrl: args.url || 'https://www.passo.com.tr/tr/etkinlik/besiktas-kocaelispor-super-lig-mac-bileti/13390322',
  categories: args.cats ? String(args.cats).split(',').map((s) => s.trim()) : [],
  blockOrder: {},
  saleTime: null,
  maxBlockRetries: 3,
  maxSeatRetries: 4,
};

const { page } = await attach(cfg);
await preflight(page, cfg, { needCategories: false });

// Choose categories: configured ones, else every category that is not sold out, cheapest first.
let cats;
const all = await P.getCategories(page, cfg.eventId);
if (cfg.categories.length) cats = (await P.resolveCategories(page, cfg.eventId, cfg.categories)).resolved;
else cats = all.filter((c) => !c.isSoldOut && !/misafir/i.test(c.name)).sort((a, b) => a.price - b.price).map((c) => ({ name: c.name, id: c.id, color: String(c.color).toLowerCase(), price: c.price }));
log.info('dry-run categories: ' + cats.map((c) => `${c.name} ${c.color} ₺${c.price}`).join(' | '));
if (!cats.length) { log.error('no open categories on this event; pick another --event'); process.exit(1); }

const opened = await go(page, cfg);
if (!opened) { log.error('seat picker did not open'); await screenshot(page, 'dry-go-failed'); process.exit(1); }

const ov = await P.readOverviewBlocks(page);
log.info(`overview: ${ov.blocks.length} blocks, svg=${JSON.stringify(ov.svg)}; with colours: ` + ov.blocks.filter((b) => Object.keys(b.colors).length).map((b) => `${b.id} ${JSON.stringify(b.colors)}`).join(' ; '));
log.info('ticket-type html:', (await P.readTicketTypeOptions(page))?.html ?? '(n/a)');

let result = null;
try {
  result = await pick(page, cfg, cats);
} catch (e) {
  if (e?.fatal) { log.big(e.message + '\n    -> Renew/check your Passo Taraftar Kart E-Bilet at https://passotaraftar.com.tr/tr/kartlarim before the sale.'); process.exit(3); }
  throw e;
}
await screenshot(page, 'dry-after-pick');
if (!result) { log.error('DRY RUN: no seat could be selected'); process.exit(1); }
log.big(`DRY RUN OK: selected ${result.cat.name} in block ${result.block.title || result.block.id}`);
const bk = await P.getBasket(page);
log.info('basket after seat click:', bk.status, 'items', bk.items, bk.raw.slice(0, 300));

if (args['to-basket']) {
  // Same path as the real run: Devam -> assign ticket to my TC id -> Devam -> /odeme invoice form (filled from config).
  // The dry run stops BEFORE the invoice "Devam" so nothing is submitted; the real run presses it and hands over.
  cfg.stopBeforeInvoiceDevam = true;
  const url = await P.goToBasket(page);
  log.info('basket page:', url);
  await screenshot(page, 'dry-basket');
  const status = await P.basketProceed(page, cfg);
  log.big(`BASKET FLOW: ${status} @ ${page.url()}`);
  await screenshot(page, 'dry-odeme');
  const ngs = await page.evaluate(() => [...document.querySelectorAll('ng-select')].map((s) => `${s.querySelector('.ng-placeholder')?.innerText}=${s.querySelector('.ng-value-label')?.innerText?.trim() || ''}`));
  const addr = await page.locator('textarea[placeholder="Adres Detayı"]').first().inputValue().catch(() => '(n/a)');
  log.info('invoice selects:', ngs, 'address:', addr ? 'filled' : 'EMPTY');
  if (/incomplete/.test(status)) log.warn('invoice form incomplete -> fill tckn + invoice.city/district/address in config.json so the real run can press Devam for you');
}

if (!args.keep) {
  // Cleanup: toggle the seat off (if still on the map), then make sure the server basket is empty.
  if (!/\/sepet|\/odeme/.test(page.url()) && result.seat) {
    await page.mouse.click(result.seat.cx, result.seat.cy).catch(() => {});
    await P.sleep(800);
    log.info('selected count after toggle:', await P.selectedCount(page));
  }
  const after = await P.getBasket(page);
  if (!after.looksEmpty) {
    const cl = await P.clearBasketApi(page);
    log.info('clearBasketApi:', cl);
  }
  const final = await P.getBasket(page);
  log.info('final basket:', final.status, 'items', final.items, 'looksEmpty', final.looksEmpty, final.raw.slice(0, 200));
  // Leave Chrome on the event page: the basket/odeme page that is open belongs to the test basket we just emptied,
  // pressing "Devam" there would only say "Sepetinizde ürün bulunmamaktadır".
  await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  log.big('DRY RUN FINISHED - test basket emptied, Chrome returned to the event page (this was a test, nothing was bought)');
} else {
  log.big('DRY RUN FINISHED - basket KEPT (--keep): the hold expires in ~10 min');
}
process.exit(0);
