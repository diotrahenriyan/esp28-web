// Google map fallback: a stand-in Google Maps script, served in place of maps.googleapis.com.
// Run from the repo root: node tests/map-fallback.mjs   (needs Playwright + Chromium)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/json' };
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const b = await readFile(join(ROOT, p)); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(0);
const BASE = `http://localhost:${server.address().port}/`;

// mode: 'ok' (tiles load), 'authAfterLoad' (gm_authFailure + console MapError after the callback), 'noTiles'
const stub = (mode) => `(() => {
  const ls = [];
  class MVC { addListener(e, f) { ls.push([this, e, f]); return { remove() {} }; } setMap() {} setPosition() {} }
  class Map extends MVC { constructor(el) { super(); el.style.position = 'relative'; el.style.overflow = 'hidden'; el.insertAdjacentHTML('beforeend', '<div class="gm-stub" style="position:absolute;top:0;left:0">GOOGLE</div>');
    const tall = el.getBoundingClientRect().height > 0;
    ${mode === 'ok' ? "if (tall) setTimeout(() => ls.filter(([o, e]) => o === this && e === 'tilesloaded').forEach(([, , f]) => f()), 200);" : ''} }
    setCenter() {} setZoom() {} getCenter() { return { lat: () => -6.9, lng: () => 107.6 }; } fitBounds() {} }
  window.google = { maps: {
    importLibrary: async (n) => n === 'maps' ? { Map, Polyline: MVC } : { Marker: MVC },
    event: { addListenerOnce: (o, e, f) => ls.push([o, e, f]) },
    LatLngBounds: class { extend() {} }, SymbolPath: { CIRCLE: 0 } } };
  const cb = new URLSearchParams(document.currentScript.src.split('?')[1]).get('callback');
  setTimeout(() => window[cb](), 50);
  ${mode === 'authAfterLoad' ? `setTimeout(() => {
    console.error('Google Maps JavaScript API error: RefererNotAllowedMapError\\nhttps://developers.google.com/maps/documentation/javascript/error-messages#referer-not-allowed-map-error\\nYour site URL to be authorized: ' + location.href);
    window.gm_authFailure && window.gm_authFailure(); }, 600);` : ''}
})();`;

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };

const browser = await chromium.launch();
async function run(mode, key, waitMs, act) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('https://maps.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: stub(mode) }));
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204 }));
  await page.addInitScript((k) => { if (k) localStorage.setItem('esp28.gkey', JSON.stringify(k)); }, key);
  await page.route('https://routes.googleapis.com/**', (r) => r.fulfill({ status: 403, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Requests from this Android client application <empty> are blocked.' } }) }));
  await page.route('https://places.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"suggestions":[]}' }));
  await page.goto(BASE);
  if (act) await page.evaluate(act);
  await page.waitForTimeout(waitMs);
  const r = await page.evaluate(() => ({
    log: document.getElementById('log').textContent,
    leaflet: !!document.querySelector('#map.leaflet-container'),
    google: !!document.querySelector('.gm-stub'),
    gHeight: (document.getElementById('gmap') || { getBoundingClientRect: () => ({ height: -1 }) }).getBoundingClientRect().height,
    mapStyle: document.getElementById('map').getAttribute('style') || '',
    status: document.getElementById('status').textContent,
  }));
  await ctx.close();
  return r;
}

let r = await run('none', '', 1500);
check('no key → OpenStreetMap', r.leaflet && !r.google && /Map: OpenStreetMap/.test(r.log));

r = await run('ok', 'TESTKEY', 2000);
check('good key → Google map stays, full height', r.gHeight >= 700 && r.google && !r.leaflet && /Map: Google/.test(r.log) && /tiles loaded/.test(r.log));

r = await run('authAfterLoad', 'TESTKEY', 2500);
check('key rejected after load → falls back to OpenStreetMap', r.leaflet && !r.google, r.status);
check('  Log names the Google error', /RefererNotAllowedMapError/.test(r.log) && /website restriction/.test(r.log));
check('  Log shows the page origin', /loading for http:\/\/localhost/.test(r.log));
check('  #map has no Google styles left', !/overflow/.test(r.mapStyle));
check('  key never printed', !/TESTKEY/.test(r.log));

r = await run('noTiles', 'TESTKEY', 16500);
check('tiles never load → falls back after 15 s', r.leaflet && !r.google && /tiles did not load/.test(r.log));
check('  diag line: size and requests', /Google diag: map \d+x\d+/.test(r.log) && /requests: /.test(r.log));
check('  diag line has no key', !/TESTKEY/.test(r.log));

r = await run('ok', 'TESTKEY', 1500, () => document.getElementById('btnTestKey').click());
check('key test: Routes error message logged', /Key test Routes: HTTP 403 PERMISSION_DENIED — Requests from this Android client/.test(r.log), r.log.split('\n').filter((l) => /Key test/.test(l)).join(' | '));
check('key test: Places OK logged', /Key test Places: HTTP 200 OK/.test(r.log));
check('key test: key never printed', !/TESTKEY/.test(r.log));

await browser.close();
server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
