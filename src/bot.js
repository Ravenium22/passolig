// Orchestrator: preflight -> watch -> go -> pick -> basket -> handoff.
// Usage: node src/bot.js [--config config.json] [--preflight] [--now] [--side kuzey|guney|dogu|bati]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { log, screenshot } from './log.js';
import { beep, focusChrome, speak } from './alert.js';
import * as P from './passo.js';

export function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      a[k] = v;
    } else a._.push(t);
  }
  return a;
}

export function loadConfig(path = 'config.json') {
  if (!fs.existsSync(path)) {
    log.error(`${path} not found. Copy config.example.json to config.json and fill tckn/phone.`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  cfg.cdpUrl ||= 'http://127.0.0.1:9222';
  cfg.pollIntervalMs ||= 700;
  cfg.startBeforeSec ??= 90;
  cfg.ticketTypeRegex ||= 'taraftar|genel';
  cfg.blockOrder ||= {};
  cfg.maxSeatRetries ??= 6;
  cfg.maxBlockRetries ??= 4;
  return cfg;
}

const SIDES = {
  kuzey: /^(10[4-9]|20[4-9]|4(0[4-9]|1[01]))$/,
  guney: /^(1(1[7-9]|2[0-2])|2(1[7-9]|2[0-2])|42[2-6])$/,
  dogu: /^(11[0-6]|21[0-6]|41[2-7])$/,
  bati: /^(10[0-3]|12[3-5]|20[0-3]|22[3-5]|40[0-3]|42[7-9])$/,
};
export function applySide(cfg, side) {
  const re = SIDES[String(side || '').toLowerCase()];
  if (!re) return;
  for (const k of Object.keys(cfg.blockOrder)) {
    const arr = cfg.blockOrder[k];
    cfg.blockOrder[k] = [...arr.filter((b) => re.test(P.digits(b))), ...arr.filter((b) => !re.test(P.digits(b)))];
  }
  log.info(`side preference applied: ${side}`);
}

export async function attach(cfg) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(cfg.cdpUrl, { timeout: 5000 });
  } catch (e) {
    log.error(`Cannot reach Chrome at ${cfg.cdpUrl}. Run start-chrome.bat first (and keep that window open). ${e.message}`);
    process.exit(1);
  }
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await P.getPassoPage(context);
  page.setDefaultTimeout(8000);
  return { browser, context, page };
}

export async function serverSkewMs() {
  try {
    const t0 = Date.now();
    const r = await fetch('https://www.passo.com.tr/', { method: 'HEAD', cache: 'no-store' });
    const t1 = Date.now();
    const d = r.headers.get('date');
    if (!d) return null;
    return new Date(d).getTime() - (t0 + t1) / 2; // + means server clock is ahead (1s resolution)
  } catch { return null; }
}

export async function preflight(page, cfg, { needCategories = true } = {}) {
  if (!page.url().includes('passo.com.tr')) {
    await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded' });
    await P.sleep(1500);
  }
  const li = await P.isLoggedIn(page);
  log.info('login check', li);
  if (!li.hasToken) {
    log.big('NOT LOGGED IN - log in to Passo in the bot Chrome window, then rerun');
    process.exit(1);
  }
  const skew = await serverSkewMs();
  log.info(`clock skew vs passo.com.tr: ${skew == null ? 'unknown' : Math.round(skew) + ' ms'} (your PC ${skew > 0 ? 'behind' : 'ahead'})`);
  cfg._skew = skew || 0;

  const basket = await P.getBasket(page);
  log.info('basket', { status: basket.status, items: basket.items, arrays: basket.arrays, looksEmpty: basket.looksEmpty, holdSec: basket.holdSec });
  if (!basket.looksEmpty) log.warn('basket may not be empty: ' + basket.raw);

  let resolved = [];
  if (needCategories) {
    const r = await P.resolveCategories(page, cfg.eventId, cfg.categories);
    resolved = r.resolved;
    log.info('categories on Passo: ' + r.all.map((c) => `${c.name}=${c.formattedPrice}${c.isSoldOut ? '' : ' OPEN'}`).join(' | '));
    log.info('target order: ' + resolved.map((c) => `${c.name} (${c.color}, ₺${c.price})`).join(' -> '));
    if (!resolved.length) { log.error('none of the configured categories exist for this event'); process.exit(1); }
  }
  const sale = await P.isSaleOpen(page, cfg.eventId);
  log.info('sale open now?', sale.open, 'status', sale.status);
  if (cfg.saleTime) {
    const ms = new Date(cfg.saleTime).getTime() - Date.now();
    log.info(`sale time ${cfg.saleTime} -> in ${(ms / 60000).toFixed(1)} min`);
  }
  if (!cfg.tckn) log.warn('config.tckn is empty: if Passo asks for TC Kimlik No the bot will pause for you');
  return resolved;
}

export async function watch(page, cfg, cats, { now = false } = {}) {
  const wantedIds = cats.map((c) => c.id);
  const saleAt = new Date(cfg.saleTime).getTime() - (cfg._skew || 0);
  const startAt = saleAt - cfg.startBeforeSec * 1000;
  if (!now) {
    let lastReload = Date.now();
    while (Date.now() < startAt) {
      const left = startAt - Date.now();
      if (left > 60000 && Date.now() - lastReload > 4 * 60000) {
        // keep the app's session fresh (its own code refreshes the token on page load)
        await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        lastReload = Date.now();
      }
      log.info(`waiting... polling starts in ${Math.round(left / 1000)} s`);
      await P.sleep(Math.min(left, 15000));
    }
  }
  await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await P.sleep(800);
  // After the main sale (sale time + 1h) tickets only appear as returns/releases, one block at a time.
  // "Returns mode": poll slower, forever, and only jump when one of OUR categories opens.
  const returnsMode = Date.now() > saleAt + 60 * 60 * 1000;
  const interval = returnsMode ? (cfg.returnsPollIntervalMs || 2000) : cfg.pollIntervalMs;
  if (returnsMode) log.big(`RETURNS MODE: sale time passed, watching event ${cfg.eventId} for returned tickets in your categories every ${interval} ms (runs until you stop it)`);
  else log.big(`WATCHING event ${cfg.eventId} every ${interval} ms`);
  let n = 0, errors = 0, lastReload = Date.now(), lastOpen = '';
  const deadline = returnsMode ? Infinity : saleAt + 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const t = Date.now();
    try {
      const s = await P.pollSignals(page, cfg.eventId, wantedIds);
      n++;
      if (s.availStatus === 401 || s.catStatus === 401) {
        log.warn('401 from API - reloading page to refresh session');
        await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        lastReload = Date.now();
      }
      const openNow = s.openCats.join(',');
      if (n % (returnsMode ? 30 : 10) === 1 || openNow !== lastOpen) log.info(`poll #${n} avail=${s.avail} open=[${openNow}] wanted=[${s.wantedOpen.join(',')}] (${Date.now() - t} ms)`);
      lastOpen = openNow;
      // NOTE: `avail` (getisavailableseatforeventorserie) was already true the day before while every
      // category was sold out, so it is informational only. Trigger on a category actually opening.
      // Live sale: any category opening means the gates opened -> go. Returns mode: only our categories matter.
      if (s.wantedOpen.length || (!returnsMode && s.openCats.length)) {
        log.big(`${returnsMode ? 'TICKETS APPEARED' : 'SALE OPEN'}! avail=${s.avail} open=[${openNow}] wanted=[${s.wantedOpen.join(',')}]`);
        return { ...s, returnsMode };
      }
      if (returnsMode && Date.now() - lastReload > 4 * 60000) {
        await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        lastReload = Date.now();
      }
    } catch (e) {
      errors++;
      log.warn('poll error', String(e).slice(0, 200));
      if (errors % 5 === 0) await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    const el = Date.now() - t;
    if (el < interval) await P.sleep(interval - el);
  }
  log.error('gave up waiting (1h after sale time)');
  process.exit(2);
}

async function pauseIfChallenged(page) {
  const paused = await P.waitOutChallenge(page, (why) => {
    beep(2); focusChrome();
    log.big(`CLOUDFLARE CHECK (${why}) - solve it in the Chrome window, bot continues automatically`);
  });
  if (paused) log.info('challenge gone, continuing');
}

export async function go(page, cfg) {
  const seatUrl = cfg.eventUrl.replace(/\/$/, '') + '/koltuk-secim';
  for (let attempt = 1; attempt <= 20; attempt++) {
    log.info(`opening seat picker (attempt ${attempt})`);
    await page.goto(seatUrl, { waitUntil: 'domcontentloaded' }).catch((e) => log.warn('goto failed', e.message));
    await pauseIfChallenged(page);
    // Wait for: manual button | blocks | redirect back to event page
    const outcome = await Promise.race([
      page.getByRole('button', { name: /Kendim seçmek istiyorum|En iyi koltuğu bul/i }).first().waitFor({ state: 'visible', timeout: 9000 }).then(() => 'picker').catch(() => null),
      page.waitForFunction(() => document.querySelectorAll('g.block').length > 0, null, { timeout: 9000 }).then(() => 'map').catch(() => null),
      page.waitForURL((u) => !u.toString().includes('koltuk-secim'), { timeout: 9000 }).then(() => 'redirected').catch(() => null),
    ]);
    log.info('seat picker outcome:', outcome, page.url());
    await P.dismissKnownPopups(page);
    if (outcome === 'picker' || outcome === 'map') {
      if (outcome === 'picker') {
        await P.selectTicketType(page, cfg.ticketTypeRegex);
        await P.openManualSelection(page, !!cfg.preferBestAvailable);
      }
      return true;
    }
    // Redirected to event page: try the SATIN AL button if present
    const buy = page.locator('button:visible').filter({ hasText: /^\s*SATIN AL\s*$/i }).first();
    if (await buy.count()) {
      log.info('clicking SATIN AL');
      await buy.click({ timeout: 1500 }).catch(() => {});
      await P.sleep(1000);
      await P.dismissKnownPopups(page);
      if (page.url().includes('koltuk-secim')) {
        await P.selectTicketType(page, cfg.ticketTypeRegex).catch(() => {});
        await P.openManualSelection(page, !!cfg.preferBestAvailable).catch((e) => log.warn(String(e)));
        if (await page.evaluate(() => document.querySelectorAll('g.block').length)) return true;
      }
    }
    await P.sleep(300);
  }
  return false;
}

/** Merge API block list (authoritative: id + name + free count) with DOM overview (colours), apply config order. */
function orderBlocks(apiBlocks, domBlocks, cat, cfg) {
  const want = cat.color;
  const dom = new Map(domBlocks.map((b) => [b.id, b]));
  let withStock = apiBlocks
    .map((b) => ({ id: `block_${b.id}`, title: b.name, free: b.categoriesCount ?? b.totalCount ?? 0, dom: dom.get(`block_${b.id}`) }))
    .filter((b) => b.free > 0);
  if (!withStock.length) {
    // API empty/failed: fall back to DOM colours
    withStock = domBlocks.filter((b) => b.colors[want]).map((b) => ({ id: b.id, title: b.title, free: b.colors[want], dom: b }));
  }
  const order = (cfg.blockOrder[cat.name] || []).map(P.digits);
  const num = (b) => (String(b.title).match(/\d{3}/) || [P.digits(b.title)])[0];
  const preferred = order.map((t) => withStock.find((b) => num(b) === t)).filter(Boolean);
  const rest = withStock.filter((b) => !preferred.includes(b)).sort((a, b) => b.free - a.free);
  return [...preferred, ...rest];
}

export async function pick(page, cfg, cats) {
  const triedBlocks = new Set();
  for (const cat of cats) {
    log.info(`--- category ${cat.name} (${cat.color}) ---`);
    for (let round = 0; round < cfg.maxBlockRetries; round++) {
      await pauseIfChallenged(page);
      const ov = await P.readOverviewBlocks(page);
      if (ov.seatsRendered > 0 || !ov.blocks.length) {
        const how = await P.backToOverview(page);
        log.info('back to overview:', how);
        if (how === 'still-zoomed') { await go(page, cfg); }
        await page.waitForFunction(() => document.querySelectorAll('g.block').length > 0, null, { timeout: 5000 }).catch(() => {});
      }
      const [ov2, apiBlocks] = await Promise.all([
        P.readOverviewBlocks(page),
        P.getAvailableBlocks(page, cfg.eventId, cat.id).catch((e) => ({ status: 0, list: [], raw: String(e) })),
      ]);
      const candidates = orderBlocks(apiBlocks.list, ov2.blocks, cat, cfg).filter((b) => !triedBlocks.has(b.id));
      log.info(`api blocks for ${cat.name}: status ${apiBlocks.status}, ${apiBlocks.list.length} -> candidates: ` + candidates.map((b) => `${b.title}(${b.free})`).join(' '));
      if (!candidates.length) { log.warn(`no blocks with free ${cat.name} seats`); break; }
      const block = candidates[0];
      triedBlocks.add(block.id);
      try {
        const n = await P.clickBlock(page, block.id);
        log.info(`block ${block.title}: ${n} seats rendered`);
      } catch (e) {
        log.warn(`block click failed (${block.title || block.id}): ${String(e).slice(0, 120)}`);
        if (e.offMap || /Timeout/i.test(String(e))) { triedBlocks.delete(block.id); await go(page, cfg); } // fresh overview, retry same block once
        if (!e.offMap && !/Timeout/i.test(String(e))) continue;
        if (triedBlocks.has(block.id + ':retried')) { triedBlocks.add(block.id); continue; }
        triedBlocks.add(block.id + ':retried');
        continue;
      }
      let seat;
      try { seat = await P.pickSeat(page, [cat.color], cfg); }
      catch (e) { if (e?.skipCategory) { log.warn(e.message); break; } throw e; }
      if (seat) return { cat, block, seat };
    }
  }
  return null;
}

export async function basket(page, cfg) {
  const url = await P.goToBasket(page);
  log.info('basket url', url);
  await screenshot(page, 'basket');
  if (await P.isTcknModalVisible(page)) await P.handleTcknModal(page, cfg);
  const status = await P.basketProceed(page, cfg);
  log.info('basket flow status:', status, page.url());
  await screenshot(page, 'after-basket');
  return status;
}

export async function handoff(page, result) {
  beep(4); focusChrome();
  await page.bringToFront().catch(() => {});
  const what = result ? `${result.cat.name} - blok ${result.block.title || result.block.id}` : 'NO SEAT GRABBED - continue by hand';
  const hint = {
    'invoice:submitted': 'Fatura formu gönderildi -> kart bilgilerini gir, SMS onayla',
    'invoice:ready': 'Fatura formu dolu -> Devam, kart bilgilerini gir, SMS onayla',
    'invoice:incomplete': 'Fatura formunda eksik var (adres/şehir/TCKN) -> doldur, Devam, kart, SMS',
    basket: 'Sepet sayfasında kaldı -> "Kendi T.C. Kimlik Numarama Tanımla" + Devam, sonra ödeme',
  }[result?.basketStatus] || 'Chrome penceresinde kaldığı yerden devam et';
  log.big(`ÖDEMEYİ TAMAMLA / COMPLETE PAYMENT IN CHROME NOW  (${what})\n    ${hint}`);
  speak(result ? 'Koltuk alındı, ödemeyi tamamla' : 'Koltuk alınamadı, elle devam et');
  const t0 = Date.now();
  for (;;) {
    await P.sleep(2000);
    const u = page.url();
    if (/thanks|tesekkur|basarili/i.test(u)) { log.big('PAYMENT DONE: ' + u); beep(2); return; }
    const m = Math.floor((Date.now() - t0) / 60000), s = Math.floor(((Date.now() - t0) % 60000) / 1000);
    if (s % 30 === 0) log.info(`waiting for you to pay... ${m}m${s}s elapsed (basket holds are usually a few minutes)`);
  }
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.config || 'config.json');
  if (args.side) applySide(cfg, args.side);
  log.info('log file:', log.file);
  const { page } = await attach(cfg);
  const cats = await preflight(page, cfg);
  if (args.preflight) { log.big('PREFLIGHT OK'); process.exit(0); }
  let result = null;
  for (let attempt = 1; ; attempt++) {
    const sig = await watch(page, cfg, cats, { now: !!args.now && attempt === 1 });
    const opened = await go(page, cfg);
    if (!opened) {
      log.error('could not open the seat picker'); await screenshot(page, 'go-failed');
      if (sig.returnsMode) { log.warn('returns mode: back to watching'); await P.sleep(3000); continue; }
      await handoff(page, null); return;
    }
    result = await pick(page, cfg, cats);
    if (result) break;
    await screenshot(page, 'pick-failed');
    if (sig.returnsMode) { log.warn('returns mode: the returned seat was gone before we got it, back to watching'); await page.goto(cfg.eventUrl, { waitUntil: 'domcontentloaded' }).catch(() => {}); await P.sleep(2000); continue; }
    await handoff(page, null); return;
  }
  log.big(`GOT SEAT: ${result.cat.name} block ${result.block.title || result.block.id}`);
  const status = await basket(page, cfg).catch((e) => { if (e?.fatal) throw e; log.error('basket flow error', String(e).slice(0, 200)); return 'error'; });
  result.basketStatus = status;
  await handoff(page, result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (e) => {
    if (e?.fatal) log.big(e.message); else log.error('fatal', e?.stack || String(e));
    beep(2); process.exit(1);
  });
}
