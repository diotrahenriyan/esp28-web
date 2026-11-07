// In-app monthly Google limit: at 99 % of a SKU's free amount the app must not call Google for it.
// Run from the repo root: node tests/google-cap.mjs   (needs Playwright + Chromium)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/json' };
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const b = await readFile(join(ROOT, p)); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(0);
const BASE = `http://localhost:${server.address().port}/`;
const MONTH = new Date().toISOString().slice(0, 7);

// minimal stand-in Google Maps script (map draws, tiles load)
const GMAPS = `(() => { const ls = [];
  class MVC { addListener(e, f) { ls.push([this, e, f]); return { remove() {} }; } setMap() {} setPosition() {} }
  class Map extends MVC { constructor(el) { super(); setTimeout(() => ls.filter(([o, e]) => o === this && e === 'tilesloaded').forEach(([, , f]) => f()), 100); }
    setCenter() {} setZoom() {} getCenter() { return { lat: () => -6.9, lng: () => 107.6 }; } fitBounds() {} }
  window.google = { maps: { importLibrary: async (n) => n === 'maps' ? { Map, Polyline: MVC } : { Marker: MVC },
    event: { addListenerOnce: (o, e, f) => ls.push([o, e, f]) }, LatLngBounds: class { extend() {} }, SymbolPath: { CIRCLE: 0 } } };
  const cb = new URLSearchParams(document.currentScript.src.split('?')[1]).get('callback'); setTimeout(() => window[cb](), 20); })();`;
const OSRM = JSON.stringify({ code: 'Ok', routes: [{ duration: 600, distance: 3000, legs: [{ steps: [] }],
  geometry: { type: 'LineString', coordinates: [[107.6098, -6.9147], [107.6191, -6.9175]] } }] });

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();

async function run(usage, act) {
  const ctx = await browser.newContext({ geolocation: { latitude: -6.9147, longitude: 107.6098 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  const hits = { gmaps: 0, places: 0, routes: 0, nominatim: 0, osrm: 0 };
  await page.route('https://maps.googleapis.com/**', (r) => { hits.gmaps++; r.fulfill({ contentType: 'text/javascript', body: GMAPS }); });
  await page.route('https://places.googleapis.com/**', (r) => { hits.places++; r.fulfill({ contentType: 'application/json', body: '{"suggestions":[]}' }); });
  await page.route('https://routes.googleapis.com/**', (r) => { hits.routes++; r.fulfill({ contentType: 'application/json', body: '{"routes":[]}' }); });
  await page.route('https://nominatim.openstreetmap.org/**', (r) => { hits.nominatim++; r.fulfill({ contentType: 'application/json',
    body: JSON.stringify([{ name: 'Gedung Sate', display_name: 'Gedung Sate, Bandung', lat: '-6.9025', lon: '107.6188' }]) }); });
  await page.route('https://router.project-osrm.org/**', (r) => { hits.osrm++; r.fulfill({ contentType: 'application/json', body: OSRM }); });
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204 }));
  await page.addInitScript(([u]) => { localStorage.setItem('esp28.gkey', JSON.stringify('TESTKEY')); localStorage.setItem('esp28.usage', JSON.stringify(u)); localStorage.setItem('esp28.tab', '"map"'); }, [usage]);
  await page.goto(BASE);
  await page.waitForTimeout(1200);
  if (act) await act(page);
  const log = await page.evaluate(() => document.getElementById('log').textContent);
  const leaflet = await page.evaluate(() => !!document.querySelector('#map.leaflet-container'));
  await ctx.close();
  return { hits, log, leaflet };
}
const searchAndPick = async (page) => {
  await page.fill('#q', 'Gedung Sate');
  await page.press('#q', 'Enter');
  await page.waitForTimeout(800);
  const b = await page.$('#results .result');
  if (b) { await b.click(); await page.waitForTimeout(1500); }
};

let r = await run({ month: MONTH, map: 9899 });
check('map loads 9,899 → Google map', r.hits.gmaps === 1 && !r.leaflet);

r = await run({ month: MONTH, map: 9900 });
check('map loads 9,900 (99% of 10,000) → no Google request, OpenStreetMap', r.hits.gmaps === 0 && r.leaflet);
check('  Log explains the limit', /map loads: 9900 this month, limit 9900 \(99% of 10000 free\)/.test(r.log));

r = await run({ month: '2000-01', map: 9999 });
check('last month\'s count does not block this month', r.hits.gmaps === 1);

r = await run({ month: MONTH, map: 9900, autocomplete: 9900, routeMoto: 990 }, searchAndPick);
check('search limit reached → Nominatim, no Places call', r.hits.places === 0 && r.hits.nominatim === 1, JSON.stringify(r.hits));
check('motorbike route limit reached (990 of 1,000) → OSRM, no Routes call', r.hits.routes === 0 && r.hits.osrm === 1, JSON.stringify(r.hits));
check('  Log explains the route limit', /motorbike routes: 990 this month, limit 990/.test(r.log));

r = await run({ month: MONTH, map: 9900, autocomplete: 9900, routeMoto: 989 }, searchAndPick);
check('motorbike routes 989 → Google Routes used', r.hits.routes === 1 && r.hits.osrm === 0, JSON.stringify(r.hits));

await browser.close();
server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
