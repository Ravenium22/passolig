// Tiny local control panel for non-technical users: http://127.0.0.1:4567
// Serves ui.html, saves config.json, launches the bot Chrome, runs the bot scripts and streams their log via SSE.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PASSOBOT_UI_PORT || 4567);
const CONFIG = path.join(ROOT, 'config.json');
const EXAMPLE = path.join(ROOT, 'config.example.json');
const NO_OPEN = process.argv.includes('--no-open');

let child = null;
let childMode = null;
const clients = new Set();
const history = [];

function send(ev, data) {
  const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
  if (ev === 'log') { history.push(data); if (history.length > 400) history.shift(); }
  for (const res of clients) res.write(msg);
}

function readConfig() {
  const file = fs.existsSync(CONFIG) ? CONFIG : EXAMPLE;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveConfig(patch) {
  const cfg = readConfig();
  for (const k of ['tckn', 'phone']) if (k in patch) cfg[k] = String(patch[k] || '').trim();
  cfg.invoice = { ...(cfg.invoice || {}) };
  for (const k of ['city', 'district', 'address']) if (patch.invoice && k in patch.invoice) cfg.invoice[k] = String(patch.invoice[k] || '').trim();
  if ('profile' in patch) cfg.profile = String(patch.profile || 'me').replace(/[^\w-]/g, '') || 'me';
  if ('port' in patch) cfg.cdpUrl = `http://127.0.0.1:${Number(patch.port) || 9222}`;
  if ('side' in patch) cfg.side = String(patch.side || '');
  if (Array.isArray(patch.categories)) {
    const cats = patch.categories.map((s) => String(s).trim()).filter(Boolean);
    if (cats.length) cfg.categories = cats;
  }
  const txt = JSON.stringify(cfg, null, 2).replace(/\[\s+("[^\]]*?")\s+\]/gs, (m, i) => '[' + i.replace(/\s*\n\s*/g, ' ') + ']');
  fs.writeFileSync(CONFIG, txt + '\n');
  return cfg;
}

function publicConfig() {
  const c = readConfig();
  return {
    tckn: c.tckn || '', phone: c.phone || '', invoice: c.invoice || { city: '', district: '', address: '' },
    profile: c.profile || 'me', port: Number((c.cdpUrl || '').split(':').pop()) || 9222, side: c.side || '',
    saleTime: c.saleTime, eventUrl: c.eventUrl, categories: c.categories, hasConfig: fs.existsSync(CONFIG),
  };
}

const MODES = {
  preflight: () => ['src/bot.js', '--preflight'],
  dryrun: () => ['scripts/dryrun.js'],
  'dryrun-basket': () => ['scripts/dryrun.js', '--to-basket'],
  start: (cfg) => ['src/bot.js', ...(cfg.side ? ['--side', cfg.side] : [])],
  clear: () => ['scripts/clear-basket.js'],
};

function runBot(mode) {
  if (child) return { ok: false, error: `Zaten çalışıyor: ${childMode}. Önce durdur.` };
  const make = MODES[mode];
  if (!make) return { ok: false, error: 'unknown mode' };
  const cfg = readConfig();
  const args = make(cfg);
  child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' } });
  childMode = mode;
  send('status', { running: true, mode });
  send('log', `--- ${mode} başlatıldı: node ${args.join(' ')} ---`);
  const onData = (buf) => buf.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((l) => send('log', l));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    send('log', `--- ${mode} bitti (exit ${code}) ---`);
    child = null; childMode = null;
    send('status', { running: false, mode, exitCode: code });
  });
  return { ok: true };
}

function stopBot() {
  if (!child) return { ok: true };
  try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { child.kill(); }
  return { ok: true };
}

function launchChrome() {
  const c = readConfig();
  const profile = c.profile || 'me';
  const port = Number((c.cdpUrl || '').split(':').pop()) || 9222;
  const p = spawn('cmd.exe', ['/c', 'start-chrome.bat', profile, String(port)], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  send('log', `Chrome açılıyor (profil ${profile}, port ${port}). O pencerede Passo'ya giriş yap.`);
  return { ok: true, profile, port };
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function body(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } }); });
}

const server = http.createServer(async (req, res) => {
  // Local-only panel: refuse anything that is not from this machine's browser.
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); return res.end('local only'); }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(ROOT, 'src', 'ui.html')));
  }
  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, publicConfig());
  if (req.method === 'POST' && url.pathname === '/api/config') { saveConfig(await body(req)); send('log', 'Bilgiler config.json dosyasına kaydedildi.'); return json(res, 200, publicConfig()); }
  if (req.method === 'POST' && url.pathname === '/api/chrome') return json(res, 200, launchChrome());
  if (req.method === 'POST' && url.pathname === '/api/run') { const b = await body(req); const r = runBot(b.mode); return json(res, r.ok ? 200 : 409, r); }
  if (req.method === 'POST' && url.pathname === '/api/stop') return json(res, 200, stopBot());
  if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { running: !!child, mode: childMode, now: Date.now() });
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: status\ndata: ${JSON.stringify({ running: !!child, mode: childMode })}\n\n`);
    for (const l of history) res.write(`event: log\ndata: ${JSON.stringify(l)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`PassoBot paneli: ${url}  (bu pencereyi kapatma / keep this window open)`);
  if (!NO_OPEN && process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
});
process.on('SIGINT', () => { stopBot(); process.exit(0); });
