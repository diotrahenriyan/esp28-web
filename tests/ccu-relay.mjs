// App side of the CCU relay contract (ccu.js header), against a stand-in cluster link.
// Run from the repo root: node tests/ccu-relay.mjs   (needs Playwright + Chromium)
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
await pg.addInitScript(() => localStorage.setItem('esp28.tab', '"engine"'));
await pg.goto(`http://localhost:${server.address().port}/?test`);
await pg.waitForTimeout(500);
const sent = () => pg.evaluate(() => window.__esp28.sent.map((m) => ({ ...m })));
const line = (o) => pg.evaluate((s) => window.__esp28.onLine(s), JSON.stringify(o));
const frame = (expr) => pg.evaluate(async (e) => {
  const m = await import('./ccu.js?v=2.8-w0.6.0'); const hx = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  // eslint-disable-next-line no-new-func
  const f = new Function('m', 'return ' + e)(m); window.__esp28.onLine(JSON.stringify({ type: 'ccuFrame', t: 1, h: hx(f) }));
}, expr);

await pg.evaluate(() => window.__esp28.fakeLink());
await pg.waitForTimeout(300);
let s = await sent();
check('on link: ccuQuery, then relay on (Engine tab open)', s.some((m) => m.type === 'ccuQuery') && s.some((m) => m.type === 'ccuRelay' && m.on === true));

await line({ type: 'ccuState', state: 'streaming', name: 'YSCCU_TEST', rssi: -60, frames: 5, heartbeats: 3, reconnects: 0, idSet: true });
await frame('m.liveFrame({ ...m.demoValues(0), rpm: 2345, batt: 13.6, eng: 77, odo: 100.5 })');
await pg.waitForTimeout(400);
const ride = await pg.evaluate(() => ({ rpm: document.getElementById('vRpm').textContent, eng: document.getElementById('vEng').textContent,
  batt: document.getElementById('vBatt').textContent, odo: document.getElementById('vOdo').textContent, ccu: document.getElementById('pillCcu').textContent }));
check('ccuFrame drives the Ride view (Indonesian number format)', ride.rpm === '2.345' && ride.eng === '77' && ride.batt === '13,6' && ride.odo === '100,5', JSON.stringify(ride));
check('ccuState shows on the CCU pill', ride.ccu === 'Streaming', ride.ccu);

await pg.click('.tabbar [data-tab=map]'); await pg.waitForTimeout(200);
s = await sent();
check('Map tab: relay off', s.filter((m) => m.type === 'ccuRelay').pop().on === false);
await pg.click('.tabbar [data-tab=engine]'); await pg.click('#btnRecord'); await pg.click('.tabbar [data-tab=more]'); await pg.waitForTimeout(200);
s = await sent();
check('recording keeps the relay on outside Engine and Bike', s.filter((m) => m.type === 'ccuRelay').pop().on === true);
await frame('m.liveFrame(m.demoValues(1))'); await frame('m.liveFrame(m.demoValues(2))');
await pg.click('.tabbar [data-tab=engine]'); await pg.click('#btnRecord'); await pg.waitForTimeout(600);
const cap = await pg.evaluate(async () => new Promise((ok) => { const r = indexedDB.open('esp28-captures', 1); r.onsuccess = () => {
  const tx = r.result.transaction(['sessions', 'chunks'], 'readonly'); const a = tx.objectStore('sessions').getAll(); const b = tx.objectStore('chunks').getAll();
  tx.oncomplete = () => ok({ sessions: a.result, text: b.result.map((c) => c.text).join('') }); }; }));
const lines = cap.text.trim().split('\n');
check('capture saved: 2 messages, "<seconds> <hex>" lines', cap.sessions.length === 1 && cap.sessions[0].frames === 2 && lines.length === 2 && lines.every((l) => /^\d+\.\d{3} [0-9a-f]+$/.test(l)), `${cap.sessions.length} sessions, ${lines.length} lines`);

await pg.evaluate(() => { document.querySelector('[data-open=pgCcu]').click(); });
await pg.fill('#ccuId', '0123456789abcdef0123456789abcdef');
await pg.click('#btnCcuIdSave'); await pg.waitForTimeout(200);
s = await sent();
const cfg = s.filter((m) => m.type === 'ccuConfig').pop();
check('phone ID sent as ccuConfig', cfg && cfg.phoneId === '0123456789abcdef0123456789abcdef');
const logText = await pg.evaluate(() => document.getElementById('log').textContent);
check('phone ID not in the Log, field cleared', !logText.includes('0123456789abcdef') && (await pg.inputValue('#ccuId')) === '');
await pg.fill('#ccuId', 'not-hex'); await pg.click('#btnCcuIdSave');
check('bad phone ID refused on the phone', /32 characters/.test(await pg.textContent('#ccuIdMsg')));
await line({ type: 'ccuConfig', ok: true, idSet: true }); await pg.waitForTimeout(100);
check('ccuConfig reply shown', /Stored on the cluster/.test(await pg.textContent('#ccuIdMsg')));
await pg.click('#ccuLinkOn'); await pg.waitForTimeout(200);
s = await sent();
check('switch sends ccuLink', s.some((m) => m.type === 'ccuLink'));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close(); server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
