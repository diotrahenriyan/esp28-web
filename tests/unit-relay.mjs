// App side of the bike unit relay contract (bikeunit.js header), against a stand-in cluster link.
// Run from the repo root: node tests/unit-relay.mjs   (needs Playwright + Chromium)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/json' };
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  try { const b = await readFile(join(ROOT, p)); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(b); } catch { res.writeHead(404); res.end(); }
}).listen(0);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const pg = await ctx.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push(e.message));
await pg.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204 }));
await pg.addInitScript(() => localStorage.setItem('esp28.tab', '"live"'));
await pg.goto(`http://localhost:${server.address().port}/?test`);
await pg.waitForTimeout(500);
const sent = () => pg.evaluate(() => window.__esp28.sent.map((m) => ({ ...m })));
const line = (o) => pg.evaluate((s) => window.__esp28.onLine(s), JSON.stringify(o));
const frame = (expr) => pg.evaluate(async (e) => {
  const m = await import('./bikeunit.js?v=2.8-w0.6.0'); const hx = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  // eslint-disable-next-line no-new-func
  const f = new Function('m', 'return ' + e)(m); window.__esp28.onLine(JSON.stringify({ type: 'bikeFrame', t: 1, h: hx(f) }));
}, expr);

await pg.evaluate(() => window.__esp28.fakeLink());
await pg.waitForTimeout(300);
let s = await sent();
check('on link: bikeQuery, then relay on (Live tab open)', s.some((m) => m.type === 'bikeQuery') && s.some((m) => m.type === 'bikeRelay' && m.on === true));

await line({ type: 'bikeState', profile: 'yamaha-yconnect', state: 'streaming', name: 'YSCCU_TEST', rssi: -60, frames: 5, heartbeats: 3, reconnects: 0, keySet: true });
await frame('m.liveFrame({ ...m.demoValues(0), rpm: 2345, batt: 13.6, eng: 77, odo: 100.5 })');
await pg.waitForTimeout(400);
const ride = await pg.evaluate(() => ({ rpm: document.getElementById('lv0').textContent, eng: document.getElementById('lv2').textContent,
  batt: document.getElementById('lv3').textContent, odo: document.getElementById('lv6').textContent, ccu: document.getElementById('pillUnit').textContent }));
check('bikeFrame drives the Live view (Indonesian number format)', ride.rpm === '2.345' && ride.eng === '77' && ride.batt === '13,6' && ride.odo === '100,5', JSON.stringify(ride));
check('bikeState shows on the bike unit chip', ride.ccu === 'Streaming', ride.ccu);

await pg.click('.tabs [data-tab=map]'); await pg.waitForTimeout(200);
s = await sent();
check('Map tab: relay off', s.filter((m) => m.type === 'bikeRelay').pop().on === false);
await pg.click('.tabs [data-tab=live]'); await pg.click('#btnRecord'); await pg.click('.tabs [data-tab=setup]'); await pg.waitForTimeout(200);
s = await sent();
check('recording keeps the relay on outside the CCU tabs (Setup open)', s.filter((m) => m.type === 'bikeRelay').pop().on === true);
await frame('m.liveFrame(m.demoValues(1))'); await frame('m.liveFrame(m.demoValues(2))');
await pg.click('#btnRecord'); await pg.waitForTimeout(600);
const cap = await pg.evaluate(async () => new Promise((ok) => { const r = indexedDB.open('esp28-captures', 1); r.onsuccess = () => {
  const tx = r.result.transaction(['sessions', 'chunks'], 'readonly'); const a = tx.objectStore('sessions').getAll(); const b = tx.objectStore('chunks').getAll();
  tx.oncomplete = () => ok({ sessions: a.result, text: b.result.map((c) => c.text).join('') }); }; }));
const lines = cap.text.trim().split('\n');
check('capture saved: 2 messages, "<seconds> <hex>" lines', cap.sessions.length === 1 && cap.sessions[0].frames === 2 && lines.length === 2 && lines.every((l) => /^\d+\.\d{3} [0-9a-f]+$/.test(l)), `${cap.sessions.length} sessions, ${lines.length} lines`);


await pg.fill('#unitKey', '0123456789abcdef0123456789abcdef');
await pg.click('#btnKeySave'); await pg.waitForTimeout(200);
s = await sent();
const cfg = s.filter((m) => m.type === 'bikeConfig').pop();
check('login key sent as bikeConfig with the profile', cfg && cfg.key === '0123456789abcdef0123456789abcdef' && cfg.profile === 'yamaha-yconnect');
const logText = await pg.evaluate(() => document.getElementById('log').textContent);
check('phone ID not in the Log, field cleared', !logText.includes('0123456789abcdef') && (await pg.inputValue('#unitKey')) === '');
await pg.fill('#unitKey', 'not-hex'); await pg.click('#btnKeySave');
check('bad login key refused on the device', /32 characters/.test(await pg.textContent('#unitKeyMsg')));
await line({ type: 'bikeConfig', ok: true, keySet: true, profile: 'yamaha-yconnect' }); await pg.waitForTimeout(100);
check('bikeConfig reply shown', /stored on the cluster/.test(await pg.textContent('#unitKeyMsg')));
await pg.click('#unitLinkOn'); await pg.waitForTimeout(200);
s = await sent();
check('switch sends bikeLink', s.some((m) => m.type === 'bikeLink'));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close(); server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
