// Destructive actions (PRD D22, TRD §16): every red button is at the left of its row, asks first, and Cancel (on the right) changes nothing.
// Run from the repo root: node tests/destructive.mjs   (needs Playwright + Chromium)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fakeImage } from './fake-image.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/json' };
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  try { const b = await readFile(join(ROOT, p)); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(b); } catch { res.writeHead(404); res.end(); }
}).listen(0);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const errors = [];
const QUIET = ['ping', 'networkStatus', 'routeQuery', 'route', 'gpsSharing', 'appearance', 'bikeQuery', 'bikeRelay'];

// what each red button may change; read before and after Cancel
const state = (pg) => pg.evaluate(async () => {
  const idb = (name, st, key) => new Promise((ok) => { const r = indexedDB.open(name); r.onsuccess = () => { const db = r.result;
    if (!db.objectStoreNames.contains(st)) { ok(null); return; } const q = db.transaction(st, 'readonly').objectStore(st)[key === undefined ? 'getAll' : 'get'](key ?? undefined);
    q.onsuccess = () => ok(JSON.stringify(q.result, (k, v) => (v instanceof CryptoKey ? '[key]' : v))); }; });
  return { saved: localStorage.getItem('esp28.saved'), appearance: localStorage.getItem('esp28.appearance'), route: localStorage.getItem('esp28.route'),
    bikePub: await idb('esp28', 'kv', 'bikePub'), caps: await idb('esp28-captures', 'sessions'), fw: document.getElementById('fwStep').textContent.replace(/\d+%/, ''),
    sent: window.__esp28.sent.filter((m) => !['ping', 'networkStatus', 'routeQuery', 'route', 'gpsSharing', 'appearance', 'bikeQuery', 'bikeRelay'].includes(m.type)).length };
});

for (const width of [390, 1366]) {
  const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, serviceWorkers: 'block' });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204 }));
  await pg.addInitScript(() => {
    if (sessionStorage.getItem('init')) return; sessionStorage.setItem('init', '1');
    localStorage.setItem('esp28.tab', '"setup"');
    localStorage.setItem('esp28.saved', JSON.stringify([{ name: 'Home', latitude: -6.2, longitude: 106.8 }]));
    localStorage.setItem('esp28.appearance', JSON.stringify({ dayRoad: 30, dayTerrain: 40, nightRoad: 50, nightTerrain: 20, simulationSpeedKph: 20, clusterThemeMode: 0 }));
    localStorage.setItem('esp28.route', JSON.stringify({ type: 'route', routeId: 'r1', points: [] }));
  });
  await pg.goto(`http://localhost:${server.address().port}/?test`); await pg.waitForTimeout(400);
  // pairing data, a capture, a linked cluster that answers, an update in progress (the cluster never gets ready within the test)
  await pg.evaluate(() => Promise.all([
    new Promise((ok) => { const r = indexedDB.open('esp28', 1); r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put('04' + 'ab'.repeat(64), 'bikePub'); t.oncomplete = ok; }; }),
    new Promise((ok) => { const r = indexedDB.open('esp28-captures', 1); r.onsuccess = () => { const t = r.result.transaction('sessions', 'readwrite'); t.objectStore('sessions').put({ id: 'yamaha-yconnect_2026-11-07_101500', frames: 3, started: '2026-11-07T03:15:00.000Z' }); t.oncomplete = ok; }; }),
  ]));
  await pg.evaluate(() => window.__esp28.fakeLink({ ota: true }));
  await pg.evaluate(() => window.__esp28.onLine(JSON.stringify({ type: 'deviceStatus', clusterVersion: '2.8-0.1.6-fz', build: '538bb06a5e5edb0e', updaterVersion: '2.8-upd-1.0.0' })));
  await pg.evaluate(() => window.__esp28.onLine(JSON.stringify({ type: 'bikeState', profile: 'yamaha-yconnect', state: 'off', keySet: true })));
  await pg.click('.tabs [data-tab=live]'); await pg.click('.tabs [data-tab=setup]'); await pg.waitForTimeout(300);
  await pg.setInputFiles('#fwFile', { name: 'speedo.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(fakeImage({ version: '2.8-0.1.7-fz' })) });
  await pg.waitForTimeout(200);
  await pg.click('#btnFwInstall'); await pg.click('#modalBody .row button:first-child'); await pg.waitForTimeout(300);

  const RED = [
    ['Erase from the cluster', '#btnKeyErase', 'setup', /^Erase the phone id from the cluster\?/],
    ['Erase pairing data', '#btnForget', 'setup', /^Erase this phone's pairing data\?/],
    ['Delete (capture)', '#capList .btn.bad', 'setup', /^Delete yamaha-yconnect_2026-11-07_101500\? /],
    ['Delete (saved place)', '#savedList .btn.bad', 'setup', /^Delete "Home"\? /],
    ['Reset this mode', '#btnResetMode', 'setup', /^Reset day brightness to the defaults\?$/],
    ['Cancel update', '#btnFwCancel', 'setup', /^Cancel the update\? The cluster keeps its current firmware; the download starts again next time\.$/],
    ['Stop navigation', '#btnStop', 'map', /^Stop navigation\? The cluster clears the route\.$/],
  ];
  const found = await pg.evaluate(() => [...document.querySelectorAll('.btn.bad')].map((b) => b.id || b.textContent));
  check(`${width} px: every red button is in the test list`, found.length === 7, found.join(', '));
  for (const [name, sel, tab, text] of RED) {
    if (await pg.evaluate(() => document.body.dataset.tab) !== tab) { await pg.click(`.tabs [data-tab=${tab}]`); await pg.waitForTimeout(200); }
    const b = pg.locator(sel).first();
    await b.scrollIntoViewIfNeeded();
    const geo = await b.evaluate((el) => {
      const row = el.closest('.row'); const btns = [...row.querySelectorAll('button')].filter((x) => x.offsetParent !== null);
      const r = el.getBoundingClientRect(), rr = row.getBoundingClientRect();
      const safe = btns.filter((x) => x !== el);
      const last = safe.length ? safe[safe.length - 1].getBoundingClientRect() : null;
      return { first: btns[0] === el, leftmost: btns.every((x) => x.getBoundingClientRect().left >= r.left - 0.5), atRowLeft: Math.abs(r.left - rr.left) < 1,
        safeRight: !last || Math.abs(last.right - rr.right) < 1, red: getComputedStyle(el).color, n: btns.length };
    });
    check(`${width} px · ${name}: leftmost in its row, safe buttons at the right end`, geo.first && geo.leftmost && geo.atRowLeft && geo.safeRight, JSON.stringify(geo));
    const before = await state(pg);
    await b.click();
    const dlg = await pg.evaluate(() => { const m = document.getElementById('modal'); const bs = [...m.querySelectorAll('button')];
      return { open: !m.hidden, text: m.querySelector('#modalBody > div').textContent, labels: bs.map((x) => x.textContent), danger: bs[0].classList.contains('bad'),
        actionRight: bs[0].getBoundingClientRect().right, cancelLeft: bs[1].getBoundingClientRect().left, cancelRightEdge: Math.abs(bs[1].getBoundingClientRect().right - bs[1].parentElement.getBoundingClientRect().right) < 1 }; });
    check(`${width} px · ${name}: opens a confirmation that says what is lost`, dlg.open && text.test(dlg.text), dlg.text);
    check(`${width} px · ${name}: red action left of Cancel, Cancel at the right edge`, dlg.danger && dlg.labels[1] === 'Cancel' && dlg.actionRight < dlg.cancelLeft && dlg.cancelRightEdge, JSON.stringify(dlg));
    await pg.click('#modalBody .row button.push'); await pg.waitForTimeout(150);
    const after = await state(pg);
    check(`${width} px · ${name}: Cancel changes nothing (no line sent, nothing deleted)`, JSON.stringify(after) === JSON.stringify(before) && await pg.isHidden('#modal'),
      JSON.stringify(after) === JSON.stringify(before) ? '' : JSON.stringify({ before, after }));
  }
  await ctx.close();
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close(); server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
