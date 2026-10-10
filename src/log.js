import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve('logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(LOG_DIR, `bot-${stamp}.log`);

function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function write(level, args) {
  const line = `[${ts()}] ${level.padEnd(5)} ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  const fn = level === 'ERROR' ? console.error : console.log;
  fn(line);
  fs.appendFileSync(file, line + '\n');
}

export const log = {
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
  big: (msg) => {
    const bar = '='.repeat(Math.max(20, msg.length + 8));
    write('INFO', [`\n${bar}\n    ${msg}\n${bar}`]);
  },
  file,
};

export async function screenshot(page, name) {
  try {
    const p = path.join(LOG_DIR, `${stamp}-${name}.png`);
    await page.screenshot({ path: p, fullPage: false });
    log.info('screenshot', p);
    return p;
  } catch (e) {
    log.warn('screenshot failed', String(e));
  }
}
