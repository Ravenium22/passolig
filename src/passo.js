// Passo page helpers. Everything here drives the REAL, logged-in Chrome page.
// No credentials, no protection bypass: the site's own JS produces tokens/signatures.
import { log } from './log.js';

export const API = 'https://ticketingweb.passo.com.tr/api/passoweb/';
export const GREY = new Set(['#89a0a3', 'none', '', 'transparent']);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/\.$/, '');
export const digits = (s) => String(s ?? '').replace(/\D/g, '');

// ---------- API (runs inside the page so the app's own token/cookies are used) ----------
export async function api(page, path, opts = {}) {
  return page.evaluate(
    async ({ path, opts, API }) => {
      const tok = (localStorage.getItem('storage_token') || '').replace(/^"|"$/g, '');
      const headers = { Authorization: tok, Accept: 'application/json' };
      if (opts.body) headers['Content-Type'] = 'application/json';
      const r = await fetch(API + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const t = await r.text();
      try { return { status: r.status, json: JSON.parse(t) }; }
      catch { return { status: r.status, text: t.slice(0, 300) }; }
    },
    { path, opts, API },
  );
}

export async function isLoggedIn(page) {
  return page.evaluate(() => {
    const tok = localStorage.getItem('storage_token');
    const exp = Number(JSON.parse(localStorage.getItem('storage_expire_token_date') || '0'));
    const hasLogout = /ÇIKIŞ|LOGOUT/i.test(document.body?.innerText || '');
    return { hasToken: !!tok && tok.length > 20, expMinutes: exp ? Math.round((exp - Date.now()) / 60000) : null, hasLogout };
  });
}

export async function getCategories(page, eventId) {
  const r = await api(page, `getcategories?eventId=${eventId}&serieId=&tickettype=100&campaignId=&validationintegrationid=`);
  return r.json?.valueList || [];
}

export async function isSaleOpen(page, eventId) {
  const r = await api(page, `getisavailableseatforeventorserie/null/${eventId}`);
  return { open: r.json?.value === true, status: r.status, raw: r.json ?? r.text };
}

/** Both sale signals in ONE round trip (parallel fetches inside the page). */
export async function pollSignals(page, eventId, wantedCatIds) {
  return page.evaluate(
    async ({ eventId, wantedCatIds, API }) => {
      const tok = (localStorage.getItem('storage_token') || '').replace(/^"|"$/g, '');
      const headers = { Authorization: tok, Accept: 'application/json' };
      const get = (p) => fetch(API + p, { headers }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
      const [a, c] = await Promise.all([
        get(`getisavailableseatforeventorserie/null/${eventId}`),
        get(`getcategories?eventId=${eventId}&serieId=&tickettype=100&campaignId=&validationintegrationid=`),
      ]);
      const cats = c.json?.valueList || [];
      const openCats = cats.filter((x) => x.isSoldOut === false).map((x) => x.name);
      const wantedOpen = cats.filter((x) => x.isSoldOut === false && wantedCatIds.includes(x.id)).map((x) => x.name);
      return { avail: a.json?.value === true, availStatus: a.status, catStatus: c.status, openCats, wantedOpen, catCount: cats.length };
    },
    { eventId, wantedCatIds, API },
  );
}

export async function resolveCategories(page, eventId, names) {
  const cats = await getCategories(page, eventId);
  const out = [];
  for (const n of names) {
    const hit = cats.find((c) => norm(c.name) === norm(n));
    if (hit) out.push({ name: hit.name, id: hit.id, color: String(hit.color || '').toLowerCase(), price: hit.price, isSoldOut: hit.isSoldOut });
    else log.warn(`category "${n}" not found on Passo. Available: ${cats.map((c) => c.name).join(' | ')}`);
  }
  return { resolved: out, all: cats };
}

/** Blocks that currently have free seats in a category: [{id, name, totalCount, categoriesCount}]. id == g.block#block_<id>. */
export async function getAvailableBlocks(page, eventId, catId) {
  const r = await api(page, `getavailableblocklist?eventId=${eventId}&serieId=&seatCategoryId=${catId}`);
  const list = (r.json?.valueList || (Array.isArray(r.json?.value) ? r.json.value : []))
    .map((b) => ({ id: b.id, name: b.name, totalCount: b.totalCount, categoriesCount: b.categoriesCount }));
  return { status: r.status, list, raw: JSON.stringify(r.json ?? r.text).slice(0, 400) };
}

export async function getBasket(page) {
  const r = await api(page, 'getuserbasketbooking');
  const j = r.json || {};
  const v = j.value || {};
  const arrays = Object.entries(v).filter(([, x]) => Array.isArray(x) && x.length).map(([k, x]) => `${k}:${x.length}`);
  const items = arrays.length ? Math.max(...Object.values(v).filter(Array.isArray).map((x) => x.length)) : 0;
  const looksEmpty = !(v.totalPrice > 0) && !v.canPay && !(v.basketRemaningTime > 0);
  return { status: r.status, items, arrays, looksEmpty, holdSec: v.channelBasketTime, remainingSec: v.basketRemaningTime, canPay: v.canPay, raw: JSON.stringify(j).slice(0, 500) };
}

export async function clearBasketApi(page) {
  const r = await api(page, 'removeallseatfrombookingbasket', { method: 'POST', body: {} });
  return { status: r.status, raw: JSON.stringify(r.json ?? r.text).slice(0, 300) };
}

// ---------- Page state ----------
export async function getPassoPage(context, preferUrlPart = 'passo.com.tr') {
  const pages = context.pages().filter((p) => !p.isClosed());
  let page = pages.find((p) => p.url().includes(preferUrlPart) && !p.url().includes('/sepet'))
    || pages.find((p) => p.url().includes(preferUrlPart));
  if (!page) page = await context.newPage();
  return page;
}

export async function detectChallenge(page) {
  return page.evaluate(() => {
    const t = document.title || '';
    if (/just a moment|bir dakika|attention required/i.test(t)) return 'cloudflare-interstitial:' + t;
    const big = (e) => { const r = e.getBoundingClientRect(); return r.width > 50 && r.height > 30; };
    const ifr = [...document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]')].find(big);
    if (ifr) return 'turnstile-widget-visible';
    const box = [...document.querySelectorAll('.turnstile-container, .cf-turnstile, [class*="turnstile"]')].find(big);
    if (box) {
      // Passo keeps the overlay until its popup is dismissed; the hidden response field tells pending vs solved.
      const solved = [...box.querySelectorAll('input[name="cf-turnstile-response"]')].some((i) => (i.value || '').length > 10);
      if (!solved) return 'turnstile-checkbox-overlay';
    }
    if (/Gerçek kişi olduğunuzu doğrulayın|Verify you are human/i.test(document.body?.innerText || '')) return 'turnstile-text-visible';
    if (document.querySelector('#challenge-running, #cf-challenge-running')) return 'cloudflare-challenge-running';
    return null;
  }).catch(() => null);
}

let _challengeAlerted = 0;
export async function alertChallenge(why) {
  const now = Date.now();
  if (now - _challengeAlerted < 15000) return; // don't spam
  _challengeAlerted = now;
  const { beep, focusChrome, speak } = await import('./alert.js');
  beep(3); focusChrome();
  log.big(`CLOUDFLARE "GERÇEK KİŞİ" KUTUSUNU TIKLA / CLICK THE CHECKBOX IN CHROME (${why}) - bot waits`);
  speak('Kutuyu tıkla');
}

export async function waitOutChallenge(page, onPause) {
  const why = await detectChallenge(page);
  if (!why) return false;
  onPause?.(why);
  for (let i = 0; i < 600; i++) { // up to ~5 min
    await sleep(500);
    if (!(await detectChallenge(page))) return true;
  }
  return true;
}

export async function dismissKnownPopups(page) {
  const clicked = [];
  // SweetAlert2 confirm
  const swal = page.locator('.swal2-container .swal2-confirm:visible');
  if (await swal.count()) {
    const txt = (await page.locator('.swal2-container').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    await swal.first().click({ timeout: 2000 }).catch(() => {});
    clicked.push('swal:' + txt);
  }
  // Cookie banner: reject non-essential (removes the overlay at the bottom of the page)
  const cookie = page.locator('button, a').filter({ hasText: /Tümünü Reddet/i }).first();
  if (await cookie.isVisible().catch(() => false)) { await cookie.click({ timeout: 1500 }).catch(() => {}); clicked.push('cookie-banner:reject'); }
  // Bootstrap modals with a plain confirm button, excluding the TCKN modal (handled elsewhere)
  const modals = page.locator('.modal.show');
  const n = await modals.count();
  for (let i = 0; i < n; i++) {
    const m = modals.nth(i);
    const text = (await m.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (/Taraftar Kart Tanımlama/i.test(text)) continue;
    const btn = m.locator('button, a.btn').filter({ hasText: /^(tamam|onaylıyorum|onayla|okay|ok|anladım|devam et|kabul ediyorum)$/i }).first();
    if (await btn.count()) { await btn.click({ timeout: 2000 }).catch(() => {}); clicked.push('modal:' + text.slice(0, 120)); }
  }
  if (clicked.length) log.info('dismissed popups', clicked);
  return clicked;
}

// ---------- Seat picker steps ----------
export async function readTicketTypeOptions(page) {
  return page.evaluate(() => {
    const label = [...document.querySelectorAll('label, span, div, p, h5, h6, b, strong')].find((e) => e.children.length === 0 && /Üyelik\s*\/\s*Kampanya Tipi/i.test(e.textContent));
    if (!label) return null;
    // Walk up until the container holds more text than the label itself and at least one option-like line.
    let box = label.parentElement;
    for (let i = 0; i < 5 && box; i++) {
      const lines = box.innerText.split('\n').map((s) => s.replace(/[✓✔●•]/g, '').trim()).filter(Boolean);
      if (lines.length >= 2 && !/Kendim seçmek|En iyi koltuğu/i.test(box.innerText)) break;
      if (/Kendim seçmek|En iyi koltuğu/i.test(box.innerText)) break; // went too far; use previous
      box = box.parentElement;
    }
    const html = box?.outerHTML?.slice(0, 1200) || '';
    const seen = new Set();
    const opts = [];
    // Option rows = direct descendants (any depth) whose own text is a non-label line.
    const nodes = [...box.querySelectorAll('*')].filter((e) => e !== label && !label.contains(e) && !e.contains(label));
    for (const e of nodes) {
      const own = e.innerText?.split('\n').map((s) => s.replace(/[✓✔●•]/g, '').trim()).filter(Boolean) || [];
      if (own.length !== 1) continue;
      const text = own[0];
      if (!text || text.length > 80 || seen.has(text) || /Üyelik\s*\/\s*Kampanya|Kendim seçmek|En iyi/i.test(text)) continue;
      seen.add(text);
      const r = e.getBoundingClientRect();
      if (r.width < 10 || r.height < 8) continue;
      opts.push({ text, cx: r.x + r.width / 2, cy: r.y + r.height / 2, selected: /[✓✔]/.test(e.innerText || '') });
    }
    opts.html = html;
    return opts;
  });
}

export async function selectTicketType(page, regexStr) {
  const opts = await readTicketTypeOptions(page);
  if (!opts) { log.warn('ticket-type step not found (maybe skipped by the site)'); return null; }
  log.info('ticket types:', opts.map((o) => (o.selected ? '✓' : '·') + o.text));
  if (!opts.length) log.warn('ticket-type container html:', opts.html);
  if (opts.length <= 1) return opts[0]?.text ?? null;
  const re = new RegExp(regexStr, 'i');
  const pick = opts.find((o) => re.test(o.text)) || opts[0];
  if (!pick.selected) { await page.mouse.click(pick.cx, pick.cy); await sleep(300); }
  log.info('ticket type chosen:', pick.text);
  return pick.text;
}

export async function openManualSelection(page, preferBest = false, timeout = 12000) {
  const best = page.getByRole('button', { name: /En iyi koltuğu bul/i });
  const manual = page.getByRole('button', { name: /Kendim seçmek istiyorum/i });
  if (preferBest && (await best.isVisible().catch(() => false))) {
    await best.click({ timeout: 3000 });
    log.info('clicked "En iyi koltuğu bul"');
    return 'best';
  }
  await manual.first().waitFor({ state: 'visible', timeout });
  // Passo renders the button disabled first and enables it once the step's data has loaded.
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => /Kendim seçmek istiyorum/i.test(x.textContent)); return b && !b.disabled; }, null, { timeout }).catch(() => log.warn('manual button still disabled after wait'));
  try {
    await manual.first().click({ timeout: 2500, noWaitAfter: true });
  } catch (e) {
    const b = await manual.first().boundingBox();
    if (!b) throw e;
    log.warn('locator click timed out, using raw mouse click');
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  }
  log.info('clicked "Kendim seçmek istiyorum"');
  await page.waitForFunction(() => document.querySelectorAll('g.block').length > 0, null, { timeout });
  await waitForOverviewPainted(page);
  return 'manual';
}

/** Block outlines (polyline rows) render a beat after g.block appears; wait until the count is stable. */
export async function waitForOverviewPainted(page, timeout = 4000) {
  await page.waitForFunction(() => document.querySelectorAll('g.block .polyline-segment').length > 0, null, { timeout }).catch(() => {});
  let last = -1;
  for (let i = 0; i < 10; i++) {
    const n = await page.evaluate(() => document.querySelectorAll('g.block .polyline-segment').length);
    if (n === last && n > 0) break;
    last = n; await sleep(120);
  }
}

export async function readOverviewBlocks(page) {
  await waitForOverviewPainted(page, 1500);
  return page.evaluate((GREY_ARR) => {
    const GREY = new Set(GREY_ARR);
    const titles = [...document.querySelectorAll('g.block-titles, g.blockTitleList text')].map((t) => {
      const r = t.getBoundingClientRect();
      return { text: t.textContent.trim(), cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }).filter((t) => t.text);
    const svg = (document.querySelector('div.seat-map') || document.querySelector('svg.seatmap-svg') || document.querySelector('g.block')?.closest('svg'))?.getBoundingClientRect();
    const blocks = [...document.querySelectorAll('g.block')].map((g) => {
      const r = g.getBoundingClientRect();
      const colors = {};
      g.querySelectorAll('.polyline-segment').forEach((s) => {
        const c = (s.getAttribute('stroke') || '').toLowerCase();
        if (c && !GREY.has(c)) colors[c] = (colors[c] || 0) + 1;
      });
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      let best = null, bd = 1e9;
      for (const t of titles) { const d = Math.hypot(t.cx - cx, t.cy - cy); if (d < bd) { bd = d; best = t; } }
      return { id: g.id, cx, cy, w: r.width, h: r.height, colors, title: best?.text || '', titleDist: Math.round(bd) };
    });
    return { blocks, svg: svg ? { x: svg.x, y: svg.y, w: svg.width, h: svg.height } : null, seatsRendered: document.querySelectorAll('g.seat').length, titleCount: titles.length };
  }, [...GREY]);
}

export async function ensureMapInView(page) {
  const r = await page.evaluate(() => {
    let el = (document.querySelector('div.seat-map') || document.querySelector('svg.seatmap-svg') || document.querySelector('g.block')?.closest('svg'));
    let box = null;
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) { const r = el.getBoundingClientRect(); if (r.width > 50 && r.height > 50) { box = el; break; } }
    if (!box) return null;
    const b0 = box.getBoundingClientRect();
    if (b0.y < 0 || b0.y + b0.height > innerHeight) box.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return true;
  });
  if (!r) return null;
  await sleep(150);
  return page.evaluate(() => {
    let el = (document.querySelector('div.seat-map') || document.querySelector('svg.seatmap-svg') || document.querySelector('g.block')?.closest('svg'));
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      const b = el.getBoundingClientRect();
      if (b.width > 50 && b.height > 50) return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), vh: innerHeight };
    }
    return null;
  });
}

async function keepPointOnScreen(page, pt) {
  const vh = await page.evaluate(() => innerHeight);
  if (pt.cy < 10 || pt.cy > vh - 10) {
    await page.evaluate((dy) => window.scrollBy(0, dy), pt.cy - vh / 2);
    await sleep(150);
    return true;
  }
  return false;
}

/** Map svg rect + seat circle size stats (diagnostics). */
export async function seatStats(page) {
  return page.evaluate(() => {
    let el = (document.querySelector('div.seat-map') || document.querySelector('svg.seatmap-svg') || document.querySelector('g.block')?.closest('svg'));
    let svg = null;
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) { const r = el.getBoundingClientRect(); if (r.width > 50 && r.height > 50) { svg = r; break; } }
    if (!svg) svg = { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const cs = [...document.querySelectorAll('g.seat circle.seat-lists')];
    const ws = cs.map((c) => c.getBoundingClientRect().width);
    const inView = cs.filter((c) => { const r = c.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2; return svg && cx > svg.x && cx < svg.x + svg.width && cy > svg.y && cy < svg.y + svg.height; }).length;
    return { svg: svg && { x: Math.round(svg.x), y: Math.round(svg.y), w: Math.round(svg.width), h: Math.round(svg.height) }, seats: cs.length, inView, minW: Math.min(...ws).toFixed(1), maxW: Math.max(...ws).toFixed(1) };
  });
}

export async function clickBlock(page, blockId, timeout = 6000) {
  const map = await ensureMapInView(page);
  const rect = () => page.evaluate((id) => {
    const g = document.getElementById(id); if (!g) return null;
    const b = g.getBoundingClientRect(); return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, w: b.width, h: b.height };
  }, blockId);
  let r = await rect();
  if (!r) throw new Error('block not in DOM: ' + blockId);
  const inside = (p, m) => m && p.cx > m.x + 2 && p.cx < m.x + m.w - 2 && p.cy > m.y + 2 && p.cy < m.y + m.h - 2;
  if (!inside(r, map)) {
    // Map is panned/zoomed so the block is outside the visible map: try the toolbar reset button, else reload later.
    const reset = page.locator('button.zoom-btn-tooltip').nth(3);
    if (await reset.count()) { await reset.click({ timeout: 800 }).catch(() => {}); await sleep(400); }
    const map2 = await ensureMapInView(page);
    r = await rect();
    if (!r || !inside(r, map2)) { const e = new Error(`block outside visible map: ${blockId} r=${JSON.stringify(r)} map=${JSON.stringify(map2)}`); e.offMap = true; throw e; }
  }
  if (await keepPointOnScreen(page, r)) r = await rect();
  log.info(`click block ${blockId} at (${Math.round(r.cx)},${Math.round(r.cy)}) map=${JSON.stringify(map)}`);
  await page.mouse.move(r.cx, r.cy);
  await page.mouse.click(r.cx, r.cy);
  await page.waitForFunction(() => document.querySelectorAll('g.seat circle.seat-lists').length > 0, null, { timeout });
  await sleep(250); // let seat statuses paint
  const st = await seatStats(page);
  log.info('seat stats', st);
  return st.seats;
}

export async function listSeats(page, colors = []) {
  return page.evaluate((colors) => {
    let el = (document.querySelector('div.seat-map') || document.querySelector('svg.seatmap-svg') || document.querySelector('g.block')?.closest('svg'));
    let svg = null;
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) { const r = el.getBoundingClientRect(); if (r.width > 50 && r.height > 50) { svg = r; break; } }
    if (!svg) svg = { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const want = new Set(colors.map((c) => c.toLowerCase()));
    const out = [];
    document.querySelectorAll('g.seat circle.seat-lists').forEach((c) => {
      const fill = (c.getAttribute('fill') || c.style.fill || '').toLowerCase();
      const pe = (c.getAttribute('pointer-events') || '').toLowerCase();
      const r = c.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const inView = cx > Math.max(4, svg.x + 4) && cx < Math.min(innerWidth - 4, svg.x + svg.width - 4)
        && cy > Math.max(4, svg.y + 4) && cy < Math.min(innerHeight - 4, svg.y + svg.height - 4);
      const ok = want.size ? want.has(fill) : !['#89a0a3', 'none', '', 'transparent'].includes(fill);
      const id = c.id || c.parentElement?.getAttribute('class') || `${Math.round(cx)}x${Math.round(cy)}`;
      if (ok && pe !== 'none' && inView && r.width > 1) out.push({ id, cx, cy, fill, r: r.width / 2 });
    });
    return out;
  }, colors);
}

export async function seatFillSummary(page) {
  return page.evaluate(() => {
    const m = {};
    document.querySelectorAll('g.seat circle.seat-lists').forEach((c) => {
      const k = (c.getAttribute('fill') || '').toLowerCase() + '|pe=' + (c.getAttribute('pointer-events') || '');
      m[k] = (m[k] || 0) + 1;
    });
    return m;
  });
}

export async function selectedCount(page) {
  return page.evaluate(() => {
    const m = (document.body.innerText || '').match(/Seçilen Koltuklar\s*\((\d+)\)/i);
    return m ? Number(m[1]) : null;
  });
}

export async function isTcknModalVisible(page) {
  return page.locator('.modal.show').filter({ hasText: /Taraftar Kart Tanımlama/i }).isVisible().catch(() => false);
}

export async function handleTcknModal(page, cfg) {
  const modal = page.locator('.modal.show').filter({ hasText: /Taraftar Kart Tanımlama/i });
  if (!(await modal.isVisible().catch(() => false))) return false;
  log.info('TCKN modal appeared');
  if (!cfg.tckn) { log.warn('config.tckn is empty - fill the modal by hand'); return 'manual'; }
  const id = modal.locator('input[placeholder*="Kimlik" i]').first();
  await id.fill(String(cfg.tckn));
  if (cfg.phone) {
    const ph = modal.locator('input[placeholder*="Telefon" i]').first();
    if (await ph.count()) await ph.fill(String(cfg.phone).replace(/\D/g, '').replace(/^90(?=\d{10}$)/, ''));
  }
  await modal.locator('button').filter({ hasText: /GÖNDER/i }).first().click({ timeout: 3000 });
  await modal.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => log.warn('TCKN modal still visible'));
  return true;
}

export async function swalText(page) {
  const c = page.locator('.swal2-container:visible');
  if (!(await c.count())) return null;
  return (await c.first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
}

/** Click seats of the wanted colour until "Seçilen Koltuklar (1)". Returns the seat or null. */
export async function pickSeat(page, colors, cfg) {
  const tried = new Set();
  for (let attempt = 0; attempt < (cfg.maxSeatRetries ?? 6); attempt++) {
    let seats = (await listSeats(page, colors)).filter((s) => !tried.has(s.id));
    if (!seats.length) {
      await ensureMapInView(page);
      seats = (await listSeats(page, colors)).filter((s) => !tried.has(s.id));
    }
    if (!seats.length) { log.warn('no clickable seats of wanted colour in this block', await seatFillSummary(page), await seatStats(page)); return null; }
    const seat = seats[Math.floor(Math.random() * seats.length)];
    tried.add(seat.id);
    await page.mouse.move(seat.cx, seat.cy);
    await page.mouse.click(seat.cx, seat.cy);
    await sleep(cfg.seatClickDelayMs ?? 150);
    const deadline = Date.now() + (cfg.challengeWaitMs ?? 120000);
    let challenged = false;
    for (let i = 0; Date.now() < deadline; i++) {
      if (await isTcknModalVisible(page)) await handleTcknModal(page, cfg);
      // Result signals first (seat selected / server popup), then the challenge gate.
      const nSel = await selectedCount(page);
      if (nSel >= 1) { log.info(`seat selected (${nSel}) id=${seat.id} fill=${seat.fill}`); return seat; }
      const errNow = await swalText(page);
      if (!errNow) {
        const why = await detectChallenge(page);
        if (why) { challenged = true; await alertChallenge(why); await sleep(400); continue; }
        if (!challenged && i >= 20) break; // ~3s with no challenge and no result -> treat as not registered
      }
      const err = errNow;
      if (err) {
        log.warn('popup after seat click:', err);
        await dismissKnownPopups(page);
        if (/E-Bilet kullanım süresi|kara liste|blacklist|ceza/i.test(err)) {
          const e = new Error('ACCOUNT BLOCKED BY PASSO: ' + err); e.fatal = true; throw e;
        }
        if (/kart bilgilerine ulaşılamadığından|kulüp kuralları/i.test(err)) {
          const e = new Error('CATEGORY NOT ALLOWED FOR THIS ACCOUNT/CARD: ' + err); e.skipCategory = true; throw e;
        }
        // Transient: "Güvenlik doğrulaması başarısız (g)" / "Koltuk ekleme işlemi başarısız. Lütfen tekrar deneyiniz"
        // -> the seat may still be free; allow the same seat to be clicked again after a short pause.
        if (/tekrar deney|Güvenlik doğrulaması/i.test(err) && !tried.has(seat.id + ':retry')) {
          tried.delete(seat.id); tried.add(seat.id + ':retry');
          await sleep(900);
        }
        break;
      }
      const n = await selectedCount(page);
      if (n >= 1) { log.info(`seat selected (${n}) id=${seat.id} fill=${seat.fill}`); return seat; }
      await sleep(150);
    }
    log.warn(`seat click did not register (attempt ${attempt + 1})`);
  }
  return null;
}

export async function backToOverview(page) {
  // Zoom-out buttons are the fastest way back to the block overview (observed); fall back to "Seçimi değiştir".
  const overview = () => page.waitForFunction(() => document.querySelectorAll('g.block').length > 0 && document.querySelectorAll('g.seat').length === 0, null, { timeout: 1500 }).then(() => true).catch(() => false);
  const zoomOut = page.locator('button.zoom-btn-tooltip').nth(1);
  for (let i = 0; i < 6 && (await zoomOut.count()); i++) await zoomOut.click({ timeout: 800 }).catch(() => {});
  if (await overview()) return 'zoom-out';
  const change = page.getByRole('button', { name: /Seçimi değiştir/i }).first();
  if (await change.isVisible().catch(() => false)) {
    await change.click({ timeout: 1500 }).catch(() => {});
    await dismissKnownPopups(page);
    if (await overview()) return 'change-button';
  }
  return 'still-zoomed';
}

export async function goToBasket(page, timeout = 15000) {
  const btn = page.locator('button.red-btn').filter({ hasText: /^Devam$/i }).first();
  if (!(await btn.isVisible().catch(() => false))) {
    const any = page.getByRole('button', { name: /^Devam$/i }).first();
    await any.click({ timeout: 3000 });
  } else await btn.click({ timeout: 3000 });
  log.info('clicked Devam -> basket');
  await page.waitForURL(/\/sepet|\/basket|\/odeme|\/payment/i, { timeout }).catch(() => log.warn('did not reach basket URL yet: ' + page.url()));
  await sleep(500);
  await dismissKnownPopups(page);
  return page.url();
}

/** Basket page (/tr/sepet): every ticket must be assigned to a Passo Taraftar Kart holder before "Devam" works.
 *  We tick "Kendi T.C. Kimlik Numarama Tanımla" (assign to my own TC id). Passo throttles this call
 *  ("Şuan işleminizi gerçekleştiremiyoruz N saniye sonra tekrar deneyiniz") -> wait N s, reload, retry. */
export async function assignTicketsToSelf(page, { maxRounds = 4 } = {}) {
  const state = () => page.evaluate(() => {
    const cbs = [...document.querySelectorAll('input[id^="checkassign-to-my-id"]')];
    return {
      total: cbs.length,
      unchecked: cbs.filter((c) => !c.checked).map((c) => c.id),
      assigning: /Tanımlanıyor/.test(document.body.innerText),
      assigned: (document.body.innerText.match(/Atanan Kişi/g) || []).length,
    };
  });
  for (let round = 0; round < maxRounds; round++) {
    let st = await state();
    if (!st.total) { log.warn('no "Kendi T.C. Kimlik Numarama Tanımla" box on basket page', st); return st; }
    if (!st.unchecked.length && !st.assigning) { log.info('tickets assigned', st); return st; }
    if (!st.assigning) {
      for (const id of st.unchecked) {
        await page.locator(`label[for="${id}"]`).first().click({ timeout: 3000 }).catch((e) => log.warn('assign label click failed', String(e).slice(0, 120)));
        await sleep(300);
      }
      log.info('clicked assign-to-my-id for', st.unchecked);
    }
    const t0 = Date.now();
    let sw = null;
    while (Date.now() - t0 < 25000) {
      await sleep(300);
      sw = await swalText(page);
      if (sw) break;
      st = await state();
      if (!st.assigning && !st.unchecked.length) break;
    }
    st = await state();
    if (sw) {
      log.warn('popup during assignment:', sw);
      await dismissKnownPopups(page);
      if (/E-Bilet kullanım süresi|kara liste|blacklist|ceza/i.test(sw)) { const e = new Error('ACCOUNT BLOCKED BY PASSO: ' + sw); e.fatal = true; throw e; }
      const m = sw.match(/(\d+)\s*saniye/);
      const wait = m ? Number(m[1]) + 1 : 4;
      log.info(`assignment throttled, waiting ${wait}s then reloading basket`);
      await sleep(wait * 1000);
      await page.goto('https://www.passo.com.tr/tr/sepet', { waitUntil: 'domcontentloaded' });
      await sleep(1200);
      await dismissKnownPopups(page);
      continue;
    }
    if (!st.unchecked.length && !st.assigning) { log.info('tickets assigned', st); return st; }
    if (st.assigning) { log.warn('still "Tanımlanıyor..." after 25s, reloading basket'); await page.goto('https://www.passo.com.tr/tr/sepet', { waitUntil: 'domcontentloaded' }); await sleep(1200); }
  }
  const st = await state();
  log.warn('could not assign all tickets', st);
  return st;
}

/** Basket -> "Devam" -> /odeme (invoice + payment page). Dismisses the Passo Taraftar Kart info popup. */
export async function goToPayment(page, timeout = 10000) {
  const devam = page.locator('button.red-btn:visible').filter({ hasText: /Devam/i }).first();
  if (!(await devam.count())) { log.warn('no visible Devam button on basket'); return page.url(); }
  await devam.click({ timeout: 3000 }).catch((e) => log.warn('Devam click failed', String(e).slice(0, 120)));
  await page.waitForURL(/\/odeme|\/payment/i, { timeout }).catch(() => log.warn('did not reach /odeme: ' + page.url()));
  await sleep(1000);
  const sw = await swalText(page);
  if (sw) { log.info('popup on payment page:', sw.slice(0, 120)); await dismissKnownPopups(page); }
  if (/tüm biletleri atamalısınız/i.test(sw || '')) return 'unassigned';
  return page.url();
}

/** Select an option in an ng-select by visible text (the Passo ones are not searchable, so click the option). */
async function ngSelectPick(page, placeholder, text) {
  if (!text) return false;
  const sel = page.locator('ng-select').filter({ has: page.locator('.ng-placeholder', { hasText: new RegExp(`^\\s*${placeholder}\\s*$`) }) }).first();
  if (!(await sel.count())) { log.warn(`ng-select "${placeholder}" not found`); return false; }
  const current = (await sel.locator('.ng-value-label').innerText().catch(() => '')).trim();
  if (current && current.localeCompare(text, 'tr', { sensitivity: 'base' }) === 0) return true;
  await sel.locator('.ng-select-container').click({ timeout: 2000 }).catch(() => {});
  const opt = page.locator('.ng-dropdown-panel .ng-option').filter({ hasText: new RegExp(`^\\s*${text}\\s*$`, 'i') }).first();
  if (!(await opt.count())) {
    const loose = page.locator('.ng-dropdown-panel .ng-option').filter({ hasText: new RegExp(text, 'i') }).first();
    if (!(await loose.count())) { log.warn(`option "${text}" not found for ${placeholder}`); await page.keyboard.press('Escape'); return false; }
    await loose.click({ timeout: 2000 }).catch(() => {});
  } else await opt.click({ timeout: 2000 }).catch(() => {});
  await sleep(400);
  return true;
}

/** /odeme: invoice details. Ticks "Faturayı kayıtlı bilgilerime istiyorum", fills TCKN / city / district / address from
 *  config when the fields are empty, then presses "Devam" if the form became valid. Card details are NEVER touched. */
export async function fillInvoice(page, cfg) {
  const inv = cfg.invoice || {};
  // The /odeme form renders asynchronously: wait for the address box and both ng-selects before touching anything.
  await page.waitForSelector('textarea[placeholder="Adres Detayı"]', { timeout: 10000 }).catch(() => log.warn('invoice form (address box) not rendered within 10s'));
  await page.waitForFunction(() => document.querySelectorAll('ng-select').length >= 2, null, { timeout: 5000 }).catch(() => {});
  await sleep(300);
  const saved = page.locator('label[for="checksend-invoice-my-membership"]').first();
  if (await saved.isVisible().catch(() => false)) {
    const checked = await page.locator('#checksend-invoice-my-membership').isChecked().catch(() => false);
    if (!checked) { await saved.click({ timeout: 2000 }).catch(() => {}); await sleep(1200); log.info('ticked "Faturayı kayıtlı bilgilerime istiyorum"'); }
  }
  const tckn = page.locator('input[placeholder="T.C. Kimlik No"]:visible').first();
  if (await tckn.count()) {
    const v = await tckn.inputValue().catch(() => '');
    if (!v && cfg.tckn) { await tckn.fill(String(cfg.tckn)); log.info('filled invoice TCKN from config'); }
    else if (!v) log.warn('invoice TCKN empty and config.tckn empty -> you must type it');
  }
  await ngSelectPick(page, 'Ülke', inv.country || 'TÜRKİYE');
  if (inv.city) await ngSelectPick(page, 'Şehir', inv.city);
  if (inv.district) await ngSelectPick(page, 'Seçiniz', inv.district);
  const addr = page.locator('textarea[placeholder="Adres Detayı"]:visible').first();
  if (await addr.count()) {
    const v = await addr.inputValue().catch(() => '');
    if (!v && inv.address) { await addr.fill(String(inv.address)); log.info('filled invoice address from config'); }
    else if (!v) log.warn('invoice address empty and config.invoice.address empty -> you must type it');
  }
  await sleep(300);
  const devam = page.locator('button.black-btn:visible, button.red-btn:visible').filter({ hasText: /Devam/i }).first();
  const enabled = (await devam.count()) && (await devam.isEnabled().catch(() => false));
  log.info('invoice form Devam enabled:', !!enabled);
  if (enabled && !cfg.stopBeforeInvoiceDevam) {
    await devam.click({ timeout: 3000 }).catch((e) => log.warn('invoice Devam click failed', String(e).slice(0, 120)));
    await sleep(1500);
    await dismissKnownPopups(page);
    log.info('after invoice Devam:', page.url());
    return 'submitted';
  }
  return enabled ? 'ready' : 'incomplete';
}

/** Full basket flow: assign -> Devam -> invoice. Returns a short status for the handoff message. */
export async function basketProceed(page, cfg) {
  if (!/\/sepet/.test(page.url())) return 'not-on-basket';
  await assignTicketsToSelf(page);
  const r = await goToPayment(page);
  if (r === 'unassigned') { await assignTicketsToSelf(page); await goToPayment(page); }
  if (!/\/odeme/.test(page.url())) return 'basket';
  return 'invoice:' + (await fillInvoice(page, cfg));
}
