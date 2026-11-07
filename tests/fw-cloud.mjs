// Firmware from the cloud (PRD D17–D19, TRD §14) against a stand-in cluster and a stand-in firmware/ folder.
// Run from the repo root: node tests/fw-cloud.mjs   (needs Playwright + Chromium)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fakeImage, manifestOf, sha256 } from './fake-image.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/json', '.json': 'application/json' };
// the published firmware lives only in memory here: { 'fz/manifest.json': object, 'fz/speedo-….bin': bytes }
let published = {};
const hits = [];
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  if (p.startsWith('/firmware/')) {
    hits.push(p); const v = published[p.slice(10)];
    if (v === undefined) { res.writeHead(404); res.end(); return; }
    const body = v instanceof Uint8Array ? Buffer.from(v) : JSON.stringify(v);
    res.writeHead(200, { 'Content-Type': v instanceof Uint8Array ? 'application/octet-stream' : 'application/json' }); res.end(body); return;
  }
  try { const b = await readFile(join(ROOT, p)); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(b); } catch { res.writeHead(404); res.end(); }
}).listen(0);
const BASE = `http://localhost:${server.address().port}`;
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };
const browser = await chromium.launch();
const errors = [];

const RUN = '2.8-0.1.6-fz';
const pub = (ch, name, version, opts = {}) => {
  const img = opts.bytes || fakeImage({ version, build: opts.build || '71cd239d165cadda', seed: version.length });
  const m = { ...manifestOf(img, { version, build: opts.build || '71cd239d165cadda' }), ...(opts.man || {}) };
  published[`${ch}/${name}`] = m; published[`${ch}/${m.file}`] = opts.serve || img;
  return { img, m };
};
async function openApp({ files = {}, init = {}, tab = 'setup', sw = false } = {}) {
  published = files; hits.length = 0;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: sw ? 'allow' : 'block' });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204 }));
  await pg.addInitScript(({ init, tab }) => { if (sessionStorage.getItem('init')) return; sessionStorage.setItem('init', '1');
    localStorage.setItem('esp28.tab', JSON.stringify(tab)); for (const [k, v] of Object.entries(init)) localStorage.setItem('esp28.' + k, JSON.stringify(v)); }, { init, tab });
  await pg.goto(BASE + '/?test'); await pg.waitForTimeout(300);
  return { ctx, pg };
}
const line = (pg, o) => pg.evaluate((s) => window.__esp28.onLine(s), JSON.stringify(o));
const sent = (pg) => pg.evaluate(() => window.__esp28.sent.map((m) => ({ ...m })));
async function connect(pg, version = RUN) {
  await pg.evaluate(() => window.__esp28.fakeLink({ ota: true }));
  await line(pg, { type: 'deviceStatus', clusterVersion: version, build: '538bb06a5e5edb0e', updaterVersion: '2.8-upd-1.0.0' });
  await pg.waitForFunction(() => document.getElementById('fwCloud').textContent !== 'Checking for updates…', null, { timeout: 12000 });
}
const ui = (pg) => pg.evaluate(() => ({ banner: !document.getElementById('fwBanner').hidden, bannerText: document.getElementById('fwBannerText').textContent,
  dotTab: !document.getElementById('setupDot').hidden, dotBox: !document.getElementById('fwDot').hidden, cloud: document.getElementById('fwCloud').textContent,
  update: !document.getElementById('fwCloudRow').hidden, prev: document.getElementById('btnFwPrevious').hidden ? '' : document.getElementById('btnFwPrevious').textContent,
  install: !document.getElementById('btnFwInstall').disabled, checked: !document.getElementById('fwChecked').hidden, file: !document.getElementById('fwFile').disabled }));
const waitState = (pg, re) => pg.waitForFunction((src) => new RegExp(src).test(document.getElementById('fwCloud').textContent) && document.getElementById('fwDl').hidden, re.source, { timeout: 15000 });

// 1. not connected, then a newer release: banner on the visible tab, dots
{
  const { m } = { files: {}, ...pub('fz', 'manifest.json', '2.8-0.1.7-fz') };
  const files = published;
  const { ctx, pg } = await openApp({ files, tab: 'live' });
  check('not connected: "Connect the cluster to check for updates."', (await ui(pg)).cloud === 'Connect the cluster to check for updates.');
  check('no manifest fetched before connect', hits.length === 0, hits.join(','));
  await connect(pg);
  let u = await ui(pg);
  check('newer release: banner "Firmware 2.8-0.1.7-fz is available." on the Live tab', u.banner && u.bannerText === 'Firmware 2.8-0.1.7-fz is available.' && await pg.isVisible('#fwBanner'), JSON.stringify(u));
  check('newer release: dot on the Setup tab and on the box title', u.dotTab && u.dotBox && await pg.isVisible('#setupDot'));
  check('manifest fetched with ?t= (no cache)', hits.some((h) => h === '/firmware/fz/manifest.json'));
  await pg.click('#btnFwNotNow'); await pg.waitForTimeout(100);
  u = await ui(pg);
  check('Not now: banner and dots gone, version stored', !u.banner && !u.dotTab && !u.dotBox && (await pg.evaluate(() => localStorage.getItem('esp28.fwDismissed'))) === '"2.8-0.1.7-fz"');
  await ctx.close();
}
// 2. nothing offered: current, older, other channel, dismissed
for (const [name, setup, init, re] of [
  ['current', () => pub('fz', 'manifest.json', RUN), {}, /^The cluster runs the newest firmware \(2\.8-0\.1\.6-fz\)\.$/],
  ['older', () => pub('fz', 'manifest.json', '2.8-0.1.5-fz'), {}, /^The cluster runs the newest firmware/],
  ['other channel', () => pub('main', 'manifest.json', '2.8-0.1.9'), {}, /^No firmware is published for this cluster \(channel fz\)\. Choose a file instead\.$/],
  ['dismissed', () => pub('fz', 'manifest.json', '2.8-0.1.7-fz'), { fwDismissed: '2.8-0.1.7-fz' }, /^Firmware 2\.8-0\.1\.7-fz is available\.$/],
]) {
  published = {}; setup();
  const { ctx, pg } = await openApp({ files: published, init });
  await connect(pg);
  const u = await ui(pg);
  check(`no banner and no dot: ${name}`, !u.banner && !u.dotTab && !u.dotBox && re.test(u.cloud), u.cloud);
  if (name === 'other channel') check('other channel: main manifest not fetched for an fz cluster', !hits.some((h) => h.includes('/main/')));
  await ctx.close();
}
// 3. trial only with Show test builds
{
  published = {}; pub('fz', 'manifest.json', RUN); pub('fz', 'manifest-test.json', '2.8-0.1.7-fzt1', { build: '1111111111111111' });
  const { ctx, pg } = await openApp({ files: published });
  await connect(pg);
  let u = await ui(pg);
  check('trial hidden while Show test builds is off (and not fetched)', !u.banner && !hits.some((h) => h.includes('manifest-test')), u.cloud);
  await pg.check('#fwTest'); await waitState(pg, /available/);
  u = await ui(pg);
  check('Show test builds on: trial 2.8-0.1.7-fzt1 offered, kept on the device', u.banner && u.bannerText === 'Firmware 2.8-0.1.7-fzt1 is available.' && (await pg.evaluate(() => localStorage.getItem('esp28.fwTest'))) === 'true', JSON.stringify(u));
  await ctx.close();
}
// 4. good image: Update downloads and checks; Install sends otaBegin with the manifest sha256, then frames; one dropped frame resent
{
  published = {}; const { img, m } = pub('fz', 'manifest.json', '2.8-0.1.7-fz', { bytes: fakeImage({ version: '2.8-0.1.7-fz', size: 40 * 1024 }) });
  const { ctx, pg } = await openApp({ files: published, tab: 'live' });
  await connect(pg);
  await pg.click('#btnFwBannerUpdate');
  await waitState(pg, /ready to install/);
  const u = await ui(pg);
  check('banner Update: Setup opens, download checked, ready rows and "File checked" line', u.checked && u.install && !u.banner && (await pg.evaluate(() => document.body.dataset.tab)) === 'setup'
    && (await pg.textContent('#fwChecked')) === 'File checked: size, SHA-256, version and build match the published firmware.' && /2\.8-0\.1\.7-fz/.test(await pg.textContent('#fwKv')), JSON.stringify(u));
  check('nothing sent to the cluster before Install', !(await sent(pg)).some((x) => x.type === 'otaBegin'));
  const DROP = 176 * 5;
  await pg.evaluate((drop) => {
    const E = window.__esp28; const st = { exp: 0, size: 0, dropped: false, retried: false, lastAck: 0, offsets: [] }; E.ota = st;
    const say = (o) => setTimeout(() => E.onLine(JSON.stringify(o)), 5);
    E.onSent = (x) => { if (x.type === 'otaBegin') { st.size = x.size; say({ type: 'otaReady', window: 32768 }); } if (x.type === 'otaEnd' && st.exp === st.size) say({ type: 'otaDone' }); };
    E.onOta = (f) => {
      const off = new DataView(f.buffer, f.byteOffset).getUint32(0, true); st.offsets.push(off);
      if (!st.dropped && off === drop) { st.dropped = true; return; }   // lost on the air
      if (off !== st.exp) { if (off > st.exp && !st.retried) { st.retried = true; say({ type: 'otaAck', offset: st.exp, retry: true }); } return; }
      st.exp += f.length - 4; st.retried = false;
      if (st.exp - st.lastAck >= 4096 || st.exp === st.size) { st.lastAck = st.exp; say({ type: 'otaAck', offset: st.exp }); }
    };
  }, DROP);
  await pg.click('#btnFwInstall');
  const dlg = await pg.textContent('#modalBody');
  check('Install keeps the existing confirm text', /^Install firmware 2\.8-0\.1\.7-fz on the cluster\? Keep the bike stopped/.test(dlg), dlg);
  await pg.click('#modalBody .row button:first-child');
  await pg.waitForFunction(() => /Installing on the cluster/.test(document.getElementById('fwStep').textContent), null, { timeout: 20000 });
  const s = await sent(pg); const begin = s.find((x) => x.type === 'otaBegin');
  const st = await pg.evaluate(() => window.__esp28.ota);
  check('otaBegin carries the manifest sha256, size and version', begin && begin.sha256 === m.sha256 && begin.size === img.length && begin.version === '2.8-0.1.7-fz', JSON.stringify(begin));
  check('frames follow otaBegin; the dropped frame was sent again; all bytes received', st.offsets.filter((o) => o === DROP).length === 2 && st.exp === img.length, `${st.offsets.length} frames, received ${st.exp}/${img.length}`);
  check('otaEnd sent, then "Installing on the cluster"', s.some((x) => x.type === 'otaEnd') && /Installing on the cluster/.test(await pg.textContent('#status')));
  await ctx.close();
}
// 5. refused downloads: no otaBegin, the reason shown
const R = {
  sha: 'The downloaded file does not match the published one (SHA-256). Nothing was sent to the cluster.',
  size: 'The downloaded file does not match the published one (size). Nothing was sent to the cluster.',
  version: 'The downloaded file does not match the published one (version). Nothing was sent to the cluster.',
  build: 'The downloaded file does not match the published one (build). Nothing was sent to the cluster.',
  kind: 'The downloaded file is not an ESP32 firmware image. Nothing was sent to the cluster.',
  updater: 'The downloaded file is an updater, not cluster firmware. Nothing was sent to the cluster.',
  large: 'The downloaded file is too large for the cluster. Nothing was sent to the cluster.',
};
const V = '2.8-0.1.7-fz';
const notEsp = (() => { const b = fakeImage({ version: V }); b[0] = 0; return b; })();
const big = fakeImage({ version: V, size: 0x300000 + 1 });
for (const [name, opts, reason] of [
  ['wrong SHA-256', { man: { sha256: sha256(new Uint8Array([1])) } }, R.sha],
  ['wrong size (shorter than published)', { man: { size: 64 * 1024 + 10 } }, R.size],
  ['larger than published (stops reading)', { serve: fakeImage({ version: V, size: 80 * 1024 }) }, R.size],
  ['wrong version', { bytes: fakeImage({ version: '2.8-0.1.8-fz' }) }, R.version],
  ['wrong build', { bytes: fakeImage({ version: V, build: '2222222222222222' }) }, R.build],
  ['wrong kind (not an ESP32 image)', { bytes: notEsp }, R.kind],
  ['wrong kind (updater)', { bytes: fakeImage({ version: V, project: 'updater' }) }, R.updater],
  ['too large for the slot', { bytes: big }, R.large],
]) {
  published = {}; pub('fz', 'manifest.json', V, opts);
  const { ctx, pg } = await openApp({ files: published });
  await connect(pg);
  await pg.click('#btnFwUpdate');
  await waitState(pg, /Nothing was sent/);
  const u = await ui(pg);
  check(`refused, ${name}: reason shown, no otaBegin, Install disabled`, u.cloud === reason && !u.install && !(await sent(pg)).some((x) => x.type === 'otaBegin'), u.cloud);
  await ctx.close();
}
// 6. offline: could not check; the file picker still works
{
  published = {}; pub('fz', 'manifest.json', V);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const pg = await ctx.newPage(); pg.on('pageerror', (e) => errors.push(e.message));
  await pg.addInitScript(() => localStorage.setItem('esp28.tab', '"setup"'));
  await pg.route('**/firmware/**', (r) => r.abort('internetdisconnected'));
  await pg.goto(BASE + '/?test'); await pg.waitForTimeout(300);
  await connect(pg);
  const u = await ui(pg);
  check('offline: "Could not check for updates. Choose a file instead."', u.cloud === 'Could not check for updates. Choose a file instead.' && !u.banner, u.cloud);
  await pg.setInputFiles('#fwFile', { name: 'speedo.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(fakeImage({ version: V })) });
  await pg.waitForTimeout(300);
  const v = await ui(pg);
  check('offline: the file picker is enabled and a chosen file is ready to install', v.file && v.install && !v.checked && /speedo\.bin/.test(await pg.textContent('#fwKv')), JSON.stringify(v));
  await ctx.close();
}
// 7. previous version offered and confirmed
{
  published = {}; pub('fz', 'manifest.json', RUN, { build: '538bb06a5e5edb0e' }); pub('fz', 'manifest-previous.json', '2.8-0.1.5-fz', { build: '3333333333333333' });
  const { ctx, pg } = await openApp({ files: published });
  await connect(pg);
  let u = await ui(pg);
  check('previous: "Install previous version 2.8-0.1.5-fz" shown, no banner', u.prev === 'Install previous version 2.8-0.1.5-fz' && !u.banner, JSON.stringify(u));
  await pg.click('#btnFwPrevious');
  const dlg = await pg.textContent('#modalBody');
  check('previous: asks first', /^Install the older firmware 2\.8-0\.1\.5-fz\? /.test(dlg), dlg);
  await pg.click('#modalBody .row button.push'); await pg.waitForTimeout(300);
  check('previous: Cancel downloads nothing', !hits.some((h) => h.endsWith('.bin')));
  await pg.click('#btnFwPrevious'); await pg.click('#modalBody .row button:first-child');
  await waitState(pg, /ready to install/);
  u = await ui(pg);
  check('previous: confirmed, downloaded, checked and ready', u.install && u.checked && /2\.8-0\.1\.5-fz/.test(await pg.textContent('#fwKv')), JSON.stringify(u));
  await ctx.close();
}
// 8. the service worker never caches firmware/
{
  published = {}; pub('fz', 'manifest.json', V);
  const { ctx, pg } = await openApp({ files: published, sw: true });
  await pg.evaluate(() => navigator.serviceWorker.ready);
  await pg.reload(); await pg.waitForTimeout(500);
  const controlled = await pg.evaluate(() => !!navigator.serviceWorker.controller);
  await connect(pg);
  await pg.click('#btnFwUpdate'); await waitState(pg, /ready to install/);
  await pg.waitForTimeout(300);
  const keys = await pg.evaluate(async () => { const out = []; for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) out.push(n + ' ' + r.url); return out; });
  check('service worker active; Cache Storage holds the app (esp28-w0.7.0) but no firmware/ entry', controlled && keys.some((k) => k.startsWith('esp28-w0.7.0 ')) && !keys.some((k) => k.includes('/firmware/')), `${keys.length} entries`);
  await ctx.close();
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close(); server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
