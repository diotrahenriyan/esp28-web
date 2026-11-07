// ESP 2.8 Companion (web): the Android app's flow on Web Bluetooth (Bluefy on iPhone), with free
// OpenStreetMap services instead of Google. Link behaviour mirrors BleSpeedometerLink.kt and
// LocationStreamService.kt; the wire contract is speedo-idf/main/ble_link_proto.h + nav_lines.tsv.
import { PROTOCOL, SVC, RX, TX, DEVICE_NAME, LINE_MAX, toHex, fromHex, authText, LineAssembler, chunks,
  locationLine, osrmRouteLine, withRouteId, distanceToLine, metersBetween, RerouteDetector,
  APPEARANCE_DEFAULTS, appearanceLine, usesToll, decodePolyline, routeLine, FIELD_MASK, OTA, OTA_MAX, appDesc, otaDecide, plainVersion, OtaSender,
  parseVersion, compareVersion, channelOf, checkManifest, checkImage, IMAGE_REASONS } from './core.js?v=2.8-w0.7.0';
import { PROFILES, DEFAULT_PROFILE, UNIT_STATES, bikeConfigLine, bikeLinkLine, bikeRelayLine, bikeQueryLine, captureLine,
  V as ST_V, P as ST_P, U as ST_U, X as ST_X, N as ST_N } from './bikeunit.js?v=2.8-w0.7.0';

const VERSION = '2.8-w0.7.0';
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const store = {
  get(k, d) { try { const v = localStorage.getItem('esp28.' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('esp28.' + k, JSON.stringify(v)); } catch (_) {} },
};

// ---------- log and status ----------
function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  $('log').textContent = `${t} ${msg}\n` + $('log').textContent.slice(0, 30000);
}
function status(text, cls = '') { const s = $('status'); s.textContent = text; s.className = 'status ' + cls; }

// ---------- IndexedDB: the phone key (non-extractable) and the cluster's key ----------
const db = new Promise((res, rej) => {
  const r = indexedDB.open('esp28', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function kv(key, val) {
  const d = await db;
  return new Promise((res, rej) => {
    const st = d.transaction('kv', val === undefined ? 'readonly' : 'readwrite').objectStore('kv');
    const r = val === undefined ? st.get(key) : (val === null ? st.delete(key) : st.put(val, key));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function phoneKey() {
  let k = await kv('phoneKey');
  if (!k) {
    const pair = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']);
    k = { priv: pair.privateKey, pub: toHex(await crypto.subtle.exportKey('raw', pair.publicKey)) };
    await kv('phoneKey', k);
    log('New phone key made');
  }
  return k;
}
const NO_BT = 'This browser has no Bluetooth access. Use Chrome or Edge on a laptop, tablet or Android phone, or Bluefy on an iPhone.';
const STATUS_HINT = {
  'Phone not registered': 'The cluster does not know this device. Register it again in Setup › Registration.',
  'Registration closed': 'Registration is closed. On the cluster, open the phone page and hold BOOT for 2 seconds, then try again.',
  'Phone list full': 'The cluster already has 3 registered devices, the maximum.',
  'Bad key': "The cluster rejected this device's key.",
};

// ---------- BLE link ----------
const link = { dev: null, rx: null, ota: null, chain: Promise.resolve(), authed: false, register: false,
  bikeNonce: null, phoneNonce: null, lastSent: 0, lastStatusAsk: 0, since: 0, device: null, routeAck: '',
  awaitingRouteId: null, routeQueryAt: 0 };

function write(bytes) {
  const p = link.chain.then(async () => {
    const w = link.rx.writeValueWithResponse ? (c) => link.rx.writeValueWithResponse(c) : (c) => link.rx.writeValue(c);
    for (const c of chunks(bytes)) await w(c);
  });
  link.chain = p.catch(() => {});
  link.lastSent = Date.now();
  return p;
}
function sendLine(obj, quiet = false) {
  const b = enc.encode(JSON.stringify(obj) + '\n');
  if (b.length > LINE_MAX) return Promise.reject(new Error('This route is too long for the cluster (over 256 KB). Choose a nearer destination.'));
  if (!quiet) log(`→ ${obj.type} (${b.length} bytes)`);
  return write(b);
}
const linked = () => link.authed && link.dev && link.dev.gatt.connected;

async function connect(register) {
  if (!navigator.bluetooth) { status(NO_BT, 'bad'); return; }
  if (!register && !(await kv('bikePub'))) { openPage('pgPairing'); return; }
  Object.assign(link, { register, authed: false, bikeNonce: null, awaitingRouteId: null });
  try {
    status(register ? 'Choose "ESP 2.8 Cluster" in the list…' : 'Choose "ESP 2.8 Cluster" in the list to connect…');
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ name: DEVICE_NAME }, { namePrefix: 'ESP 2.8' }], optionalServices: [SVC] });
    link.dev = dev;
    dev.addEventListener('gattserverdisconnected', onDisconnect);
    status('Connecting over Bluetooth…');
    const server = await dev.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    link.rx = await svc.getCharacteristic(RX);
    const tx = await svc.getCharacteristic(TX);
    link.ota = await svc.getCharacteristic(OTA).catch(() => null);
    const asm = new LineAssembler(onLine);
    tx.addEventListener('characteristicvaluechanged', (e) =>
      asm.feed(new Uint8Array(e.target.value.buffer, e.target.value.byteOffset, e.target.value.byteLength)));
    await tx.startNotifications();
    log('Connected, notifications on');
    status(register ? 'Registering this device…' : 'Signing in…');
    if (register) $('pairState').textContent = 'Registering… (with firmware older than 0.1.4, also confirm the pairing code on both screens)';
    // an empty line is ignored by the cluster, but the encrypted RX makes iOS pair / encrypt first
    await write(enc.encode('\n'));
    log('Link secure');
    if (register) {
      const k = await phoneKey();
      await sendLine({ type: 'register', pub: k.pub, name: 'Diag web' });
      status('Registering this device…');
    }
  } catch (e) {
    log('Connect failed: ' + e.message);
    status('Not connected: ' + e.message, 'bad');
    try { link.dev && link.dev.gatt.disconnect(); } catch (_) {}
  }
  render();
}

function onDisconnect() {
  link.authed = false;
  cloud.checked = false; clearTimeout(unit.queryT); clearTimeout(unit.cfgT);
  if (fw.running && fw.sender && fw.sender.state !== 'done') fw.sender.fail('Disconnected');
  log('Disconnected');
  status('The cluster disconnected. Tap Connect cluster.', 'bad');
  render();
}

async function onLine(line) {
  let m;
  try { m = JSON.parse(line); } catch (_) { return; }
  if (!['challenge', 'deviceStatus', 'otaAck', 'bikeFrame', 'bikeState'].includes(m.type)) log('← ' + line.slice(0, 160));
  switch (m.type) {
    case 'registered':
      if (!link.register || m.protocol !== PROTOCOL || !/^04[0-9a-f]{128}$/i.test(m.bikePub || '')) return;
      await kv('bikePub', m.bikePub.toLowerCase());
      status('Device registered. Signing in…');
      $('pairState').textContent = 'This device is registered with the cluster.';
      break;
    case 'challenge': {
      if (m.protocol !== PROTOCOL) { status(`This app does not support cluster link ${m.protocol}.`, 'bad'); return; }
      if (link.authed || !/^[0-9a-f]{64}$/.test(m.nonce || '') || m.nonce === link.bikeNonce) return;
      const k = await kv('phoneKey');
      if (!k || !(await kv('bikePub'))) { status(STATUS_HINT['Phone not registered'], 'bad'); return; }
      link.bikeNonce = m.nonce;
      link.phoneNonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const sig = await crypto.subtle.sign(SIGN, k.priv, enc.encode(authText('phone', link.bikeNonce, link.phoneNonce)));
      await sendLine({ type: 'authenticate', nonce: link.phoneNonce, sig: toHex(sig) });
      break;
    }
    case 'authenticated': {
      if (link.authed || !link.bikeNonce) return;
      const pub = await crypto.subtle.importKey('raw', fromHex(await kv('bikePub')), ECDSA, false, ['verify']);
      const ok = await crypto.subtle.verify(SIGN, pub, fromHex(m.sig || ''),
        enc.encode(authText('bike', link.bikeNonce, link.phoneNonce))).catch(() => false);
      if (!ok) { status("The cluster's reply did not check out. Is this a different cluster?", 'bad'); link.dev.gatt.disconnect(); return; }
      link.authed = true;
      link.since = Date.now();
      log('Authenticated');
      onLinked();
      break;
    }
    case 'deviceStatus': link.device = m; renderDetails(); checkUpdated(); renderFirmware();
      if (!cloud.checked) { cloud.checked = true; fwCheck(); } break;
    case 'bikeState': unit.state = m; unit.noRelay = false; clearTimeout(unit.queryT); renderChips(); renderUnitPage(); break;
    case 'bikeFrame': if (!unit.demo) onUnitFrame(m.h); break;
    case 'bikeConfig': unitConfigReply(m); break;
    case 'otaReady': case 'otaAck': case 'otaDone': case 'otaError': otaMessage(m); break;
    case 'routeAck':
      link.routeAck = `${m.points} points, ${m.steps} steps, ${(m.meters / 1000).toFixed(1)} km${m.simulation ? ', simulated' : ''}`;
      status(m.simulation ? 'Simulation running on the cluster' : `Route on the cluster: ${(m.meters / 1000).toFixed(1)} km`, 'ok');
      break;
    case 'routeState':
      if (link.awaitingRouteId) {
        const id = link.awaitingRouteId; link.awaitingRouteId = null;
        if (m.id !== id && nav.line) sendRouteLine(nav.line);
        else log('Cluster already holds this route');
      }
      break;
    case 'status': {
      const hint = STATUS_HINT[m.text];
      status(hint || m.text, hint ? 'bad' : '');
      if (m.text === 'Phone not registered') await kv('bikePub', null);
      break;
    }
  }
  render();
}

// LocationStreamService.bleSendLoop on a new link: sharing state, the route (asked first), appearance
async function onLinked() {
  status(gps.sharing ? 'Connected over Bluetooth · GPS sharing on' : 'Connected over Bluetooth · GPS sharing off', 'ok');
  render();
  await sendLine({ type: 'gpsSharing', enabled: gps.sharing });
  if (nav.line) { link.awaitingRouteId = nav.line.routeId; link.routeQueryAt = Date.now(); await sendLine({ type: 'routeQuery' }); }
  await sendLine(appearanceLine(appearance));
  unit.relayOn = null;   // the cluster starts with the relay off at each connection
  unit.state = null; unit.noRelay = false;
  await sendLine(bikeQueryLine(), true).catch(() => {});
  // D21: firmware without the bike unit relay never answers bikeQuery
  clearTimeout(unit.queryT);
  unit.queryT = setTimeout(() => { if (linked() && !unit.state) { unit.noRelay = true; log('No bikeState within 3 s: this cluster firmware has no bike unit support'); renderUnitPage(); } }, 3000);
  syncRelay();
}

// keep the link busy (ping after 5 s quiet), device status every 30 s, route reply timeout 2 s
setInterval(() => {
  if (!linked() || fw.running) return;
  const now = Date.now();
  if (link.awaitingRouteId && now - link.routeQueryAt >= 2000) { link.awaitingRouteId = null; if (nav.line) sendRouteLine(nav.line); }
  if (now - link.lastStatusAsk >= 30000) { link.lastStatusAsk = now; sendLine({ type: 'networkStatus' }, true).catch(() => {}); }
  else if (now - link.lastSent >= 5000) sendLine({ type: 'ping' }, true).catch(() => {});
}, 1000);

// ---------- phone GPS: map dot always, cluster only while sharing ----------
const gps = { sharing: false, since: 0, fix: null, lock: null };
const detector = new RerouteDetector();
let rerouting = false;

function startWatch() {
  navigator.geolocation.watchPosition(onFix, (e) => log('GPS: ' + e.message),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
function onFix(p) {
  const c = p.coords;
  gps.fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy || 0, heading: c.heading, speed: c.speed, t: p.timestamp };
  drawMe();
  // GpsFixGate: only fixes taken after sharing started, at most 10 s old
  if (gps.sharing && linked() && !fw.running && p.timestamp >= gps.since && Date.now() - p.timestamp <= 10000) {
    write(enc.encode(JSON.stringify(locationLine(c, p.timestamp)) + '\n')).catch(() => {});
    keepRoute();
  }
}
async function setSharing(on) {
  if (on && !linked()) { status('Connect the cluster before sharing GPS.', 'warn'); return; }
  gps.sharing = on;
  gps.since = Date.now();
  if (linked()) await sendLine({ type: 'gpsSharing', enabled: on }).catch(() => {});
  if (on) {
    try { gps.lock = await navigator.wakeLock.request('screen'); } catch (_) { log('Screen lock not available: keep the screen on'); }
    status('Connected over Bluetooth · GPS sharing on', 'ok');
  } else {
    if (gps.lock) { gps.lock.release().catch(() => {}); gps.lock = null; }
    status('GPS sharing paused · cluster stays connected', 'ok');
  }
  render();
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && gps.sharing && !gps.lock) {
    try { gps.lock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
});

// ---------- providers: Google when a key is set (like the Android app), else free OpenStreetMap ----------
const gkey = () => (store.get('gkey', '') || '').trim();
const ropt = () => ({ mode: 'TWO_WHEELER', tolls: true, highways: false, ferries: false, ...store.get('routeOptions', {}) });
// GoogleUsageMeter: requests per calendar month on this phone (an estimate, not Google billing)
function meter(sku) {
  const m = new Date().toISOString().slice(0, 7);
  const u = store.get('usage', {});
  if (u.month !== m) { for (const k of Object.keys(u)) delete u[k]; u.month = m; }
  u[sku] = (u[sku] || 0) + 1;
  store.set('usage', u);
}
// Free usage per month and SKU (Google Maps Platform pricing page, updated 2026-11-02): map loads
// (Dynamic Maps) 10,000; car route with traffic (Compute Routes Pro) 5,000; motorbike route (Compute
// Routes Enterprise, two-wheel) 1,000; autocomplete requests 10,000; place details asking only for
// location (Place Details Essentials) 10,000.
const FREE = { map: 10000, routeCar: 5000, routeMoto: 1000, autocomplete: 10000, details: 10000 };
// Hard stop on this phone: Google's daily quotas cannot be changed on this account, so the app stops
// calling Google for a SKU at 99 % of its free amount this month and uses OpenStreetMap instead
// (Operator ruling 2026-11-06 23:46). The 1 % margin is small against Google's billing month
// (Pacific time) versus this count (UTC month); the free trial covers any overshoot until 2027-02-05.
const CAP_SHARE = 0.99;
const LABEL = { map: 'map loads', routeCar: 'car routes', routeMoto: 'motorbike routes', autocomplete: 'search suggestions', details: 'place details' };
const capOf = (sku) => Math.floor(FREE[sku] * CAP_SHARE);
function used(sku) {
  const u = store.get('usage', {});
  return u.month === new Date().toISOString().slice(0, 7) ? (u[sku] || 0) : 0;
}
const capLogged = {};
// true: use Google for this SKU now. false: no key, or this month's limit reached (logged once).
function useGoogle(sku, quiet = false) {
  if (!gkey()) return false;
  if (used(sku) < capOf(sku)) return true;
  if (!quiet && !capLogged[sku]) {
    capLogged[sku] = true;
    log(`Google ${LABEL[sku]}: ${used(sku)} this month, limit ${capOf(sku)} (${Math.round(CAP_SHARE * 100)}% of ${FREE[sku]} free). Using OpenStreetMap until next month.`);
    status(`Google free limit for ${LABEL[sku]} reached this month: using OpenStreetMap.`, 'warn');
  }
  return false;
}
const routeSku = () => (ropt().mode === 'DRIVE' ? 'routeCar' : 'routeMoto');
let routeProvider = 'osm';

// a route choice, the same shape for both providers
function fromOsrm(r) { return { coords: r.geometry.coordinates, duration: r.duration, distance: r.distance, toll: usesToll(r), toLine: (d) => osrmRouteLine(r, d) }; }
function fromGoogle(g) {
  const coords = decodePolyline(g.polyline.encodedPolyline);
  return { coords, duration: parseFloat(g.duration) || 0, distance: g.distanceMeters || 0, toll: false, toLine: (d) => routeLine(g, d) };
}

async function osrm(from, to) {
  const u = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}` +
    '?overview=full&geometries=geojson&steps=true&alternatives=3';
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.code !== 'Ok') throw new Error(j.message || j.code || `HTTP ${r.status}`);
  return j.routes || [];
}
async function googleRoutes(from, to, alternatives = true) {
  const o = ropt();
  const origin = { location: { latLng: { latitude: from.lat, longitude: from.lon } } };
  if (Number.isFinite(from.heading) && (from.speed || 0) >= 2) origin.location.heading = Math.round(from.heading);
  meter(o.mode === 'DRIVE' ? 'routeCar' : 'routeMoto');
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': gkey(), 'X-Goog-FieldMask': FIELD_MASK },
    body: JSON.stringify({ origin, destination: { location: { latLng: { latitude: to.lat, longitude: to.lon } } },
      travelMode: o.mode, routingPreference: 'TRAFFIC_AWARE', computeAlternativeRoutes: alternatives,
      routeModifiers: { avoidTolls: o.tolls, avoidHighways: o.highways, avoidFerries: o.ferries },
      languageCode: 'en', units: 'METRIC' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
  return j.routes || [];
}
async function planRoutes(from, to, alternatives = true) {
  if (useGoogle(routeSku())) { routeProvider = 'google'; return (await googleRoutes(from, to, alternatives)).map(fromGoogle); }
  routeProvider = 'osm';
  return (await osrm(from, to)).map(fromOsrm).sort((a, b) => a.toll - b.toll);
}

// ---------- map: one interface, Google Maps or Leaflet + OpenStreetMap ----------
function loadScript(src) { return new Promise((res, rej) => { const e = document.createElement('script'); e.src = src; e.onload = res; e.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(e); }); }
let M = null;
let followed = false;
const sheetPad = () => document.querySelector('.sheet').offsetHeight + 20;
function leafletMap() {
  const map = L.map('map', { zoomControl: false }).setView([-6.9147, 107.6098], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
  let me = null, dest = null, lines = [];
  return {
    kind: 'osm',
    view(lat, lon, z) { map.setView([lat, lon], z); },
    center() { const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; },
    me(lat, lon) { if (!me) me = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [22, 22] }), interactive: false }).addTo(map); else me.setLatLng([lat, lon]); },
    dest(p) { if (dest) dest.remove(); dest = p ? L.marker([p.lat, p.lon]).addTo(map) : null; },
    routes(list, sel, onPick) {
      lines.forEach((l) => l.remove()); lines = [];
      list.forEach((c, i) => { if (i !== sel) lines.push(L.polyline(c.coords.map(([x, y]) => [y, x]), { color: '#8a93a3', weight: 5, opacity: 0.7 }).on('click', () => onPick(i)).addTo(map)); });
      if (list[sel]) lines.push(L.polyline(list[sel].coords.map(([x, y]) => [y, x]), { color: list[sel].toll ? '#ff6b6b' : '#4c8dff', weight: 7 }).addTo(map));
    },
    fit(coords) { map.fitBounds(L.polyline(coords.map(([x, y]) => [y, x])).getBounds(), { paddingTopLeft: [30, 90], paddingBottomRight: [30, sheetPad()] }); },
    onHold(cb) { map.on('contextmenu', (e) => cb(e.latlng.lat, e.latlng.lng)); },
  };
}
// Google reports key and project problems through window.gm_authFailure and as console errors
// named "...MapError", usually AFTER the script has loaded (so a load promise never sees them).
// Bluefy has no console: both go to the Log, and a fatal one switches the map to OpenStreetMap.
const MAP_ERRORS = {
  ApiNotActivatedMapError: 'Maps JavaScript API is not enabled in the key\'s project',
  ApiTargetBlockedMapError: 'the key\'s API restrictions do not include Maps JavaScript API',
  BillingNotEnabledMapError: 'the key\'s project has no billing account linked',
  RefererNotAllowedMapError: 'the key\'s website restriction does not allow ' + location.origin,
  InvalidKeyMapError: 'the key is wrong or was deleted',
  ExpiredKeyMapError: 'the key has expired',
  DeletedApiProjectMapError: 'the key\'s project was deleted',
  ProjectDeniedMapError: 'Google denied the key\'s project',
  ApiProjectMapError: 'the key or its project is not usable',
  OverQuotaMapError: 'the project is over its quota',
  MissingKeyMapError: 'no key reached Google',
};
let gmFail = () => {};
function watchGoogleConsole() {
  for (const lvl of ['error', 'warn']) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a) => {
      orig(...a);
      const t = a.map(String).join(' ');
      if (!/Google Maps|MapError|maps\.googleapis/i.test(t)) return;
      const name = (t.match(/\b[A-Za-z]+MapError\b/) || [])[0];
      log(`Google ${lvl}: ` + (name ? `${name} (${MAP_ERRORS[name] || 'see Google error docs'}) ` : '') +
        t.replace(/key=[^&\s]+/g, 'key=…').slice(0, 300));
      if (name && MAP_ERRORS[name]) gmFail(name + ': ' + MAP_ERRORS[name]);
    };
  }
}
function loadGoogle(key) {
  return new Promise((res, rej) => {
    window.gm_authFailure = () => {
      rej(new Error('Google rejected the key for maps'));
      gmFail('Google rejected the key for maps (gm_authFailure)');
    };
    window.__gmReady = res;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__gmReady`;
    s.onerror = () => rej(new Error('Google Maps did not load (network)'));
    document.head.appendChild(s);
    setTimeout(() => rej(new Error('Google Maps did not load in 15 s')), 15000);
  });
}
// what the Google map got to before it gave up (for the Log; no key, no query strings)
function googleDiag(el) {
  const r = el.getBoundingClientRect();
  const err = el.querySelector('.gm-err-message, .gm-err-title');
  const paths = {};
  for (const e of performance.getEntriesByType('resource')) {
    const u = new URL(e.name);
    if (!/google|gstatic/.test(u.host)) continue;
    const k = u.host.replace('.com', '') + u.pathname.split('/').slice(0, 4).join('/');
    paths[k] = (paths[k] || 0) + 1;
  }
  return `Google diag: map ${Math.round(r.width)}x${Math.round(r.height)}, ` +
    `${el.querySelectorAll('img').length} img, ${el.querySelectorAll('canvas').length} canvas, ` +
    `version ${(window.google && google.maps && google.maps.version) || '?'}, ` +
    `error box: ${err ? err.textContent.trim().slice(0, 120) : 'none'}\n  requests: ` +
    (Object.entries(paths).map(([k, n]) => `${k} x${n}`).join(', ') || 'none');
}
// one Routes and one Places request with the key: the exact reply Google gives (status + message)
async function testKey() {
  if (!gkey()) { log('Key test: no key set'); return; }
  log('Key test: start (2 requests)');
  const show = async (name, r) => {
    const j = await r.json().catch(() => ({}));
    const e = j.error || {};
    log(`Key test ${name}: HTTP ${r.status}` + (r.ok ? ' OK' : ` ${e.status || ''} — ${(e.message || '').slice(0, 200)}`));
  };
  try {
    meter('routeMoto');
    await show('Routes', await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': gkey(), 'X-Goog-FieldMask': 'routes.distanceMeters' },
      body: JSON.stringify({ origin: { location: { latLng: { latitude: -6.9147, longitude: 107.6098 } } },
        destination: { location: { latLng: { latitude: -6.9175, longitude: 107.6191 } } }, travelMode: 'TWO_WHEELER' }) }));
  } catch (e) { log('Key test Routes: network error ' + e.message); }
  try {
    meter('autocomplete');
    await show('Places', await fetch('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': gkey() }, body: JSON.stringify({ input: 'Gedung Sate' }) }));
  } catch (e) { log('Key test Places: network error ' + e.message); }
}
window.addEventListener('error', (e) => log('Page error: ' + (e.message || e.type) + (e.filename ? ' @ ' + new URL(e.filename, location.href).host : '')));
window.addEventListener('unhandledrejection', (e) => log('Unhandled: ' + ((e.reason && e.reason.message) || e.reason)));
async function googleMap() {
  await loadGoogle(gkey());
  meter('map');
  const { Map, Polyline } = await google.maps.importLibrary('maps');
  const { Marker } = await google.maps.importLibrary('marker');
  // Google writes position:relative onto its container, so inset/absolute sizing is lost and the
  // map collapses to 0 px tall (iPhone diag "393x0"). Size the container with width/height
  // instead: #map is fixed full-screen, so 100% is a definite size whatever position Google sets.
  const el = document.createElement('div');
  el.id = 'gmap';
  el.style.cssText = 'width:100%;height:100%';
  $('map').appendChild(el);
  const map = new Map(el, { center: { lat: -6.9147, lng: 107.6098 }, zoom: 13, disableDefaultUI: true, clickableIcons: false, gestureHandling: 'greedy' });
  // a map that never draws a tile is blank: give it 15 s, then fall back
  let tiles = false;
  google.maps.event.addListenerOnce(map, 'tilesloaded', () => { tiles = true; log('Google map tiles loaded'); });
  ['projection_changed', 'bounds_changed', 'idle'].forEach((ev) => google.maps.event.addListenerOnce(map, ev, () => log('Google map event: ' + ev)));
  setTimeout(() => { if (!tiles) { log(googleDiag(el)); gmFail('Google map tiles did not load in 15 s'); } }, 15000);
  let me = null, dest = null, lines = [], holdT = null;
  const path = (c) => c.map(([x, y]) => ({ lat: y, lng: x }));
  return {
    kind: 'google',
    view(lat, lon, z) { map.setCenter({ lat, lng: lon }); map.setZoom(z); },
    center() { const c = map.getCenter(); return { lat: c.lat(), lon: c.lng() }; },
    me(lat, lon) {
      if (!me) me = new Marker({ map, position: { lat, lng: lon }, clickable: false,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#4c8dff', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 } });
      else me.setPosition({ lat, lng: lon });
    },
    dest(p) { if (dest) dest.setMap(null); dest = p ? new Marker({ map, position: { lat: p.lat, lng: p.lon } }) : null; },
    routes(list, sel, onPick) {
      lines.forEach((l) => l.setMap(null)); lines = [];
      list.forEach((c, i) => { if (i !== sel) { const l = new Polyline({ map, path: path(c.coords), strokeColor: '#8a93a3', strokeWeight: 5, strokeOpacity: 0.7 }); l.addListener('click', () => onPick(i)); lines.push(l); } });
      if (list[sel]) lines.push(new Polyline({ map, path: path(list[sel].coords), strokeColor: list[sel].toll ? '#ff6b6b' : '#4c8dff', strokeWeight: 7, zIndex: 2 }));
    },
    fit(coords) {
      const b = new google.maps.LatLngBounds();
      coords.forEach(([x, y]) => b.extend({ lat: y, lng: x }));
      map.fitBounds(b, { top: 90, left: 30, right: 30, bottom: sheetPad() });
    },
    onHold(cb) {
      // a long press (600 ms without moving) picks a spot; right click on a computer
      map.addListener('contextmenu', (e) => cb(e.latLng.lat(), e.latLng.lng()));
      map.addListener('mousedown', (e) => { clearTimeout(holdT); holdT = setTimeout(() => cb(e.latLng.lat(), e.latLng.lng()), 600); });
      ['mouseup', 'dragstart', 'zoom_changed'].forEach((ev) => map.addListener(ev, () => clearTimeout(holdT)));
    },
  };
}
let googleTried = false;
let googleFailed = '';
// swap whatever map is there for OpenStreetMap (Google leaves its own styles on #map: start clean)
async function leafletReady() {
  if (window.L) return;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'leaflet/leaflet.css'; document.head.appendChild(css);
  await loadScript('leaflet/leaflet.js');
}
async function useOsm(reason) {
  if (M && M.kind === 'osm') return;
  if (reason) { log('Google map failed: ' + reason); status(`Google map failed: ${reason}. Using OpenStreetMap (see Log).`, 'warn'); }
  const old = $('map'), fresh = old.cloneNode(false);
  fresh.removeAttribute('style');
  old.replaceWith(fresh);
  M = null;
  await leafletReady();
  M = leafletMap();
  log('Map: OpenStreetMap');
  wireMap();
}
function wireMap() {
  followed = false;
  M.onHold((lat, lon) => setDestination({ name: 'Dropped pin', lat, lon }));
  if (gps.fix) drawMe();
  if (nav.dest) M.dest(nav.dest);
  if (nav.choices.length) drawRoutes(nav.choices, nav.sel);
  $('mapAttrib').textContent = M.kind === 'google' ? 'Map, search and routes: Google. Live traffic on motorbike and car routes.'
    : 'Map, search and routes: © OpenStreetMap contributors (tiles, Nominatim, OSRM). Free, no account. No live traffic. Routes that use a toll road are marked in red.';
}
let mapStarted = false;
async function startMap() {
  if (mapStarted) return;
  mapStarted = true;
  if (!useGoogle('map', true)) await leafletReady();
  if (useGoogle('map')) {
    googleTried = true;
    log('Google map: loading for ' + location.origin);
    gmFail = (reason) => { if (googleFailed) return; googleFailed = reason; if (M && M.kind === 'google') useOsm(reason); };
    try { M = await googleMap(); log('Map: Google'); }
    catch (e) { useOsm(googleFailed || e.message); return; }
    if (googleFailed) { useOsm(googleFailed); return; }
  }
  if (!M) { await leafletReady(); M = leafletMap(); log('Map: OpenStreetMap'); }
  wireMap();
}
function drawMe() {
  const f = gps.fix;
  if (!f || !M) return;
  M.me(f.lat, f.lon);
  if (!followed) { followed = true; M.view(f.lat, f.lon, 15); }
}
function drawRoutes(list, sel) { if (M) M.routes(list, sel, selectRoute); }

// ---------- TripRouteKeeper: arrival at 100 m, reroute when off the route, traffic refresh (Google) ----------
const trip = { refreshes: 0, lastRefresh: 0, sentAt: 0 };
async function keepRoute() {
  const f = gps.fix;
  if (!nav.active || rerouting || !f) return;
  const line = nav.active.geometry.coordinates;
  const end = line[line.length - 1];
  const toDest = metersBetween(f.lat, f.lon, nav.active.latitude, nav.active.longitude);
  if (toDest < 100 || metersBetween(f.lat, f.lon, end[1], end[0]) < 100) {
    nav.active = null; status('Arrived · route updates off', 'ok'); return;
  }
  const now = Date.now();
  let kind = null;
  if (detector.offer(distanceToLine(f.lat, f.lon, line), f.acc, now)) kind = 'reroute';
  else if (useGoogle(routeSku(), true) && trip.refreshes < 6 && now - trip.lastRefresh >= 600000 && toDest > 3000) { kind = 'refresh'; trip.refreshes++; trip.lastRefresh = now; }
  if (!kind) return;
  rerouting = true;
  try {
    const rs = await planRoutes(f, nav.dest, false);
    const pick = rs.find((c) => !c.toll) || rs[0];
    if (!pick || !nav.active) return;
    if (kind === 'refresh') {
      // TrafficRefreshPolicy: send only when the ETA moved by 2 minutes or 10 %
      const expected = Math.max(0, nav.active.durationSeconds - (now - trip.sentAt) / 1000);
      if (Math.abs(pick.duration - expected) < Math.max(120, 0.1 * expected)) return;
    }
    const l = await withRouteId(pick.toLine(nav.dest));
    nav.active = l; nav.line = l; store.set('route', l); trip.sentAt = Date.now();
    detector.routeReplaced(Date.now());
    await sendRouteLine(l);
    drawRoutes([pick], 0);
    status(`${kind === 'reroute' ? 'Rerouted' : 'Arrival time updated for traffic'} · ${Math.ceil(pick.duration / 60)} min`, 'ok');
  } catch (e) { status(`${kind === 'reroute' ? 'Reroute' : 'Traffic update'} failed: ${e.message}`, 'bad'); }
  finally { rerouting = false; }
}

// ---------- destination, search and routes ----------
const nav = { dest: null, choices: [], sel: 0, line: store.get('route', null), active: null };
let session = crypto.randomUUID();
let searchT = null;

async function search(submitted = true) {
  const q = $('q').value.trim();
  if (q.length < 3) return;
  if (submitted) $('q').blur();
  const list = $('results');
  const c = M ? M.center() : { lat: -6.9147, lon: 107.6098 };
  try {
    if (useGoogle('autocomplete') && useGoogle('details')) {
      meter('autocomplete');
      const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': gkey() },
        body: JSON.stringify({ input: q, sessionToken: session, languageCode: 'en', includedRegionCodes: ['id'],
          locationBias: { circle: { center: { latitude: c.lat, longitude: c.lon }, radius: 30000 } } }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
      list.innerHTML = '';
      for (const s of (j.suggestions || []).filter((x) => x.placePrediction).slice(0, 6)) {
        const p = s.placePrediction;
        const main = p.structuredFormat ? p.structuredFormat.mainText.text : p.text.text;
        const sub = p.structuredFormat && p.structuredFormat.secondaryText ? p.structuredFormat.secondaryText.text : '';
        list.appendChild(resultButton(main, sub, () => pickGoogle(p.placeId, main)));
      }
    } else {
      if (!submitted) return;   // Nominatim's rule: no search as you type
      const u = new URL('https://nominatim.openstreetmap.org/search');
      u.search = new URLSearchParams({ q, format: 'jsonv2', limit: '6', countrycodes: 'id', 'accept-language': 'en',
        viewbox: `${c.lon - 0.5},${c.lat + 0.5},${c.lon + 0.5},${c.lat - 0.5}` });
      const found = await fetch(u).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
      list.innerHTML = '';
      if (!found.length) status('No places found.', 'bad');
      for (const p of found) {
        const name = p.name || p.display_name.split(',')[0];
        list.appendChild(resultButton(name, p.display_name, () => { list.innerHTML = ''; setDestination({ name, lat: +p.lat, lon: +p.lon }); }));
      }
    }
  } catch (e) { status('Search failed: ' + e.message, 'bad'); }
}
async function pickGoogle(id, name) {
  $('results').innerHTML = '';
  try {
    meter('details');
    const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?sessionToken=${session}`, {
      headers: { 'X-Goog-Api-Key': gkey(), 'X-Goog-FieldMask': 'location' } });   // location only: Place Details Essentials
    const p = await r.json().catch(() => ({}));
    session = crypto.randomUUID();
    if (!r.ok || !p.location) throw new Error((p.error && p.error.message) || 'no location');
    setDestination({ name, lat: p.location.latitude, lon: p.location.longitude });
  } catch (e) { status('Could not open the place: ' + e.message, 'bad'); }
}
function resultButton(title, sub, onclick) {
  const b = document.createElement('button');
  b.className = 'result';
  b.innerHTML = '<b></b><span></span>';
  b.querySelector('b').textContent = title;
  b.querySelector('span').textContent = sub;
  b.onclick = onclick;
  return b;
}

async function setDestination(d) {
  nav.dest = d;
  nav.choices = [];
  $('q').value = d.name;
  $('destName').textContent = d.name;
  $('destInfo').textContent = 'Planning the route…';
  $('routes').innerHTML = '';
  $('destBox').hidden = false;
  if (M) { M.dest(d); M.routes([], 0, selectRoute); }
  render();
  // a pending permission prompt never times out on its own: give up after 20 s
  const from = gps.fix || await new Promise((res) => {
    setTimeout(() => res(null), 20000);
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }), () => res(null),
      { enableHighAccuracy: true, timeout: 15000 });
  });
  if (!from) { $('destInfo').textContent = 'Location unavailable: allow location for this page.'; return; }
  try {
    nav.choices = await planRoutes(from, d);
    nav.sel = 0;
    if (!nav.choices.length) { $('destInfo').textContent = 'No route found'; return; }
    const o = ropt();
    $('destInfo').textContent = routeProvider === 'google' ? `Google · ${o.mode === 'DRIVE' ? 'car' : 'motorbike'} · live traffic${o.tolls ? ' · no tolls' : ''}`
      : (nav.choices.every((c) => c.toll) ? 'Every route found uses a toll road' : 'No live traffic: times assume empty roads');
    renderChoices();
    if (M) M.fit(nav.choices[0].coords);
  } catch (e) { $('destInfo').textContent = 'Route failed: ' + e.message; }
  render();
}
function renderChoices() {
  const box = $('routes');
  box.innerHTML = '';
  nav.choices.forEach((c, i) => {
    const b = resultButton(`Route ${i + 1}: ${Math.round(c.duration / 60)} min${c.toll ? '. Uses a toll road, not for motorbikes' : ''}`,
      `${(c.distance / 1000).toFixed(1)} km`, () => selectRoute(i));
    if (i === nav.sel) b.classList.add('sel');
    if (c.toll) b.classList.add('toll');
    box.appendChild(b);
  });
  drawRoutes(nav.choices, nav.sel);
}
function selectRoute(i) { nav.sel = i; renderChoices(); }

async function sendSelected(simulation) {
  if (!linked()) { status('Connect the cluster to send this route.', 'warn'); return; }
  const c = nav.choices[nav.sel];
  if (!c) return;
  const line = c.toLine(nav.dest);
  line.simulation = simulation;
  const l = await withRouteId(line);
  try {
    await sendLine({ type: 'destination', name: l.name, latitude: l.latitude, longitude: l.longitude });
    await sendRouteLine(l);
    nav.line = l; store.set('route', l);
    nav.active = simulation ? null : l;
    detector.startTrip(Date.now());
    Object.assign(trip, { refreshes: 0, lastRefresh: Date.now(), sentAt: Date.now() });
    status(simulation ? 'Simulation requested · send the route again to return to real GPS'
      : `Route sent · ${gps.sharing ? 'phone GPS sharing stays on' : 'phone GPS sharing stays off'}`, 'ok');
  } catch (e) { status('Could not send the route: ' + e.message, 'bad'); }
  render();
}
async function sendRouteLine(l) {
  status('Sending the route…');
  await sendLine(l);
}

// ---------- Google settings: key (on this phone only), route options, usage ----------
function renderGoogle() {
  $('gkey').value = gkey();
  const o = ropt();
  $('optMode').value = o.mode; $('optTolls').checked = o.tolls; $('optHighways').checked = o.highways; $('optFerries').checked = o.ferries;
  const row = (k, label) => `${label}: ${used(k)} of ${FREE[k].toLocaleString('en')} free · stops at ${capOf(k).toLocaleString('en')}`;
  $('usage').textContent = [row('map', 'Map loads'), row('routeMoto', 'Motorbike routes'), row('routeCar', 'Car routes'),
    row('autocomplete', 'Search suggestions'), row('details', 'Place details')].join('\n');
  const capped = Object.keys(FREE).filter((k) => !useGoogle(k, true));
  $('googleState').textContent = !gkey() ? 'No key: the app uses free OpenStreetMap.'
    : capped.length ? `Monthly limit reached for ${capped.map((k) => LABEL[k]).join(', ')}: those use OpenStreetMap until next month.`
    : M && M.kind === 'google' ? 'Google is on: map, search and routes.'
    : googleTried ? `The Google map did not load${googleFailed ? ': ' + googleFailed : ''}. Search and routes still use Google.`
    : 'Key saved. Tap Reload to apply.';
}

// ---------- saved places (SavedDestination.kt: up to 50, names 1..80) ----------
const saved = () => store.get('saved', []);
function renderSaved() {
  const list = $('savedList');
  list.innerHTML = '';
  const s = saved();
  $('savedEmpty').hidden = s.length > 0;
  s.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'saveditem';
    card.innerHTML = '<b></b><div class="note"></div><div class="row"><button class="btn bad">Delete</button><button class="btn push">Rename</button><button class="btn">Drive here</button></div>';
    card.querySelector('b').textContent = p.name;
    card.querySelector('.note').textContent = `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;
    const [del, ren, go] = card.querySelectorAll('button');
    go.onclick = () => { closePages(); showTab('map'); setDestination({ name: p.name, lat: p.latitude, lon: p.longitude }); };
    ren.onclick = () => askName('Rename place', p.name, (n) => { const a = saved(); a[i].name = n; store.set('saved', a); renderSaved(); });
    del.onclick = () => confirmBox(`Delete "${p.name}"? The saved place is removed from this device.`, 'Delete', () => { const a = saved(); a.splice(i, 1); store.set('saved', a); renderSaved(); }, { danger: true });
    list.appendChild(card);
  });
}
function saveCurrent() {
  if (!nav.dest) return;
  if (saved().length >= 50) { status('You can save up to 50 places.', 'bad'); return; }
  askName('Save place', nav.dest.name, (n) => {
    store.set('saved', [...saved(), { name: n, latitude: nav.dest.lat, longitude: nav.dest.lon }]);
    status(`Saved "${n}"`, 'ok');
  });
}

// ---------- map appearance (MapAppearance.kt) ----------
const appearance = { ...APPEARANCE_DEFAULTS, ...store.get('appearance', {}) };
let previewDay = true;
const THEMES = ['Auto (day 06–18 by its clock)', 'Light', 'Dark'];
function renderAppearance() {
  const road = previewDay ? appearance.dayRoad : appearance.nightRoad;
  const terrain = previewDay ? appearance.dayTerrain : appearance.nightTerrain;
  $('slRoad').value = road; $('slTerrain').value = terrain;
  $('lblRoad').textContent = `Road brightness ${road}%`;
  $('lblTerrain').textContent = `Terrain brightness ${terrain}%`;
  $('btnPreviewMode').textContent = previewDay ? 'Previewing day. Tap for night' : 'Previewing night. Tap for day';
  const base = previewDay ? [238, 236, 228] : [24, 28, 34];
  const t = terrain / 100, r = road / 100;
  $('preview').style.background = `rgb(${base.map((v) => Math.round(previewDay ? v * (0.55 + 0.45 * t) : v + 70 * t)).join(',')})`;
  $('preview').firstElementChild.style.background = previewDay ? `rgb(${Math.round(255 * (1 - r) * 0.8)},${Math.round(255 * (1 - r) * 0.8)},${Math.round(255 * (1 - r) * 0.8)})`
    : `rgb(${Math.round(60 + 195 * r)},${Math.round(60 + 195 * r)},${Math.round(70 + 185 * r)})`;
  $('btnClusterTheme').textContent = `Cluster theme: ${THEMES[appearance.clusterThemeMode] || THEMES[0]}`;
  $('slSim').value = appearance.simulationSpeedKph;
  $('lblSim').textContent = `Simulation top speed ${appearance.simulationSpeedKph} km/h`;
}
function saveAppearance() {
  store.set('appearance', appearance);
  if (linked()) sendLine(appearanceLine(appearance)).catch(() => {});
}


// ---------- firmware update (FirmwareUpdater.kt flow, image from a file instead of the update server) ----------
const fw = { image: null, desc: null, target: 'app', running: false, sender: null, lock: null };

function renderFirmware() {
  const d = link.device;
  $('fwInstalled').textContent = !linked() || !d ? 'Cluster: not connected over Bluetooth'
    : `Installed: ${plainVersion(d.clusterVersion) || '?'}${d.build ? ' · build ' + d.build.slice(0, 8) : ''} · updater ${plainVersion(d.updaterVersion) || 'none'}`;
  const ok = !!fw.desc;
  $('fwInfo').hidden = !ok;
  let can = false;
  if (ok) {
    const rows = [['File', fw.name], ['Size', `${(fw.image.length / 1024).toFixed(0)} KB`], ['Kind', fw.target === 'updater' ? 'Updater' : 'App'],
      ['Version', fw.desc.version], ['Build', fw.desc.build], ['Built', `${fw.desc.date} ${fw.desc.time}`]];
    $('fwKv').innerHTML = '';
    for (const [k, v] of rows) { const a = document.createElement('span'); a.textContent = k; const b = document.createElement('span'); b.textContent = v; $('fwKv').append(a, b); }
    const r = otaDecide(fw.desc, fw.target, linked() ? d : null);
    const v = $('fwVerdict');
    if (fw.image.length > OTA_MAX[fw.target]) { v.textContent = 'Too large for this slot on the cluster.'; v.className = 'status bad'; }
    else if (fw.target === 'app' && d && !(d.updaterVersion || '').trim()) { v.textContent = 'The cluster has no valid updater: install updater.bin first.'; v.className = 'status bad'; }
    else if (r === 'unknown') { v.textContent = 'Connect the cluster to compare versions.'; v.className = 'status warn'; }
    else if (r === 'current') { v.textContent = 'The cluster already runs this image.'; v.className = 'status'; can = true; }
    else { v.textContent = r === 'rebuild' ? 'Same version, different build: installable.' : 'Newer or different version: installable.'; v.className = 'status ok'; can = true; }
  }
  $('fwChecked').hidden = !(ok && fw.fromCloud);
  $('btnFwInstall').disabled = !can || !linked() || !link.ota || fw.running;
  if (linked() && !link.ota) $('fwInstalled').textContent += '. This cluster has no update channel.';
}

$('fwFile').onchange = async (e) => {
  const f = e.target.files[0];
  fw.image = null; fw.desc = null; fw.fromCloud = null;
  if (cloud.state === 'ready') cloud.state = cloud.offer ? 'available' : 'current';
  if (f) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const d = appDesc(bytes);
    if (!d) { status('This file is not an ESP32 firmware image.', 'bad'); }
    else { fw.image = bytes; fw.desc = d; fw.name = f.name; fw.target = d.project === 'updater' ? 'updater' : 'app'; }
  }
  renderFirmware(); renderCloud();
};

$('btnFwInstall').onclick = () => confirmBox(
  `Install ${fw.target === 'updater' ? 'updater' : 'firmware'} ${fw.desc.version} on the cluster? Keep the bike stopped and this page open. ${fw.target === 'app' ? 'The cluster restarts twice.' : ''}`,
  'Install', startOta);

async function startOta() {
  const sha = toHex(await crypto.subtle.digest('SHA-256', fw.image));
  fw.sender = new OtaSender(fw.image);
  fw.running = true;
  fw.before = link.device ? plainVersion(link.device.clusterVersion) : null;
  try { fw.lock = await navigator.wakeLock.request('screen'); } catch (_) {}
  $('fwProgress').hidden = false;
  $('fwStep').textContent = 'Preparing the cluster…';
  renderFirmware();
  log(`OTA ${fw.target} ${fw.desc.version} ${fw.image.length} bytes sha ${sha.slice(0, 16)}`);
  try {
    await sendLine({ type: 'otaBegin', size: fw.image.length, sha256: sha, version: fw.desc.version, target: fw.target });
  } catch (e) { fw.sender.fail(e.message); }
  fw.sender.start(Date.now());
  pumpOta();
}

function otaMessage(m) {
  if (!fw.sender) return;
  fw.sender.onMessage(m, Date.now());
  if (m.type === 'otaAck' && m.retry) log(`OTA resend from ${m.offset}`);
}

async function pumpOta() {
  const s = fw.sender;
  const w = link.ota.writeValueWithoutResponse ? (f) => link.ota.writeValueWithoutResponse(f) : (f) => link.ota.writeValue(f);
  let lastUi = 0;
  while (s.state !== 'done' && s.state !== 'failed') {
    const now = Date.now();
    s.tick(now);
    const f = s.nextFrame();
    if (f) {
      const p = link.chain.then(() => w(f));
      link.chain = p.catch(() => {});
      try { await p; } catch (e) { log('OTA write: ' + e.message); await new Promise((r) => setTimeout(r, 30)); }
    } else {
      if (s.endDue()) { s.markEndSent(now); sendLine({ type: 'otaEnd' }).catch((e) => s.fail(e.message)); }
      await new Promise((r) => setTimeout(r, 25));
    }
    if (now - lastUi > 250) {
      lastUi = now;
      $('fwBar').style.width = s.percent() + '%';
      $('fwStep').textContent = s.state === 'waitReady' ? 'Preparing the cluster (erasing)…'
        : s.state === 'waitDone' ? 'Checking the image on the cluster…' : `Sending ${s.percent()}%`;
    }
  }
  fw.running = false;
  if (fw.lock) { fw.lock.release().catch(() => {}); fw.lock = null; }
  if (s.state === 'done') {
    $('fwBar').style.width = '100%';
    if (fw.target === 'app') {
      store.set('otaExpect', { version: fw.desc.version, build: fw.desc.build, before: fw.before });
      $('fwStep').textContent = 'Installing on the cluster… it restarts twice. Tap Connect cluster again in about 1 minute.';
      status('Installing on the cluster… it restarts twice', 'warn');
    } else {
      $('fwStep').textContent = 'Updater installed';
      status('Updater installed', 'ok');
      sendLine({ type: 'networkStatus' }, true).catch(() => {});
    }
  } else {
    $('fwStep').textContent = 'Update failed: ' + s.error + '. The cluster keeps its current firmware.';
    status('Update failed: ' + s.error, 'bad');
    if (linked()) sendLine({ type: 'otaAbort' }, true).catch(() => {});
  }
  renderFirmware();
}
$('btnFwCancel').onclick = () => confirmBox('Cancel the update? The cluster keeps its current firmware; the download starts again next time.', 'Cancel update',
  () => { if (fw.sender && fw.running) fw.sender.fail('Cancelled'); }, { danger: true });

// after the restart: what the cluster runs now (UpdateCheck.restart)
function checkUpdated() {
  const e = store.get('otaExpect', null);
  const d = link.device;
  if (!e || !d) return;
  store.set('otaExpect', null);
  const v = plainVersion(d.clusterVersion);
  const r = otaDecide({ version: e.version, build: e.build }, 'app', d);
  if (r === 'current') status(`Updated · the cluster now runs ${v}`, 'ok');
  else if (v === plainVersion(e.version)) status(`The cluster runs ${v} but a different build`, 'warn');
  else if (e.before && v === e.before) status(`The update was rolled back · the cluster still runs ${v}`, 'bad');
  else status(`The cluster runs ${v}`, 'warn');
}


// ---------- firmware from the cloud (PRD D17–D19, TRD §14): firmware/<channel>/ on this same site ----------
// state: off | unknown | checking | current | available | none | offline | downloading | verifying | ready | refused | dlfail
const cloud = { state: 'off', channel: null, offer: null, previous: null, msg: '', pct: 0, seq: 0, dl: null, checked: false };
const fwUrl = (ch, name) => new URL('firmware/' + ch + '/' + name, location.href).href;
const fwTest = () => store.get('fwTest', false) === true;

// one manifest: null when nothing is published (404) or the file has the wrong shape; throws when offline
async function getManifest(ch, name) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(fwUrl(ch, name) + '?t=' + Date.now(), { cache: 'no-store', signal: ctl.signal });
    if (r.status === 404) { log(`Firmware ${ch}/${name}: nothing published`); return null; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = checkManifest(await r.json().catch(() => null));
    if (!m || channelOf(m.version) !== ch) { log(`Firmware ${ch}/${name}: not a valid manifest, ignored`); return null; }
    return m;
  } finally { clearTimeout(t); }
}

async function fwCheck() {
  if (fw.running || ['checking', 'downloading', 'verifying', 'ready'].includes(cloud.state)) return;
  const seq = ++cloud.seq;
  cloud.offer = null; cloud.previous = null;
  if (!linked() || !link.device) { cloud.state = 'off'; renderCloud(); return; }
  const running = plainVersion(link.device.clusterVersion);
  const ch = channelOf(running);
  cloud.channel = ch;
  if (!ch) { cloud.state = 'unknown'; log(`Firmware check: cannot read the version "${running}"; choose a file`); renderCloud(); return; }
  cloud.state = 'checking'; renderCloud();
  try {
    const [rel, prev, test] = await Promise.all([getManifest(ch, 'manifest.json'), getManifest(ch, 'manifest-previous.json'),
      fwTest() ? getManifest(ch, 'manifest-test.json') : null]);
    if (seq !== cloud.seq) return;
    // only a newer version of the same channel is offered; a trial only with Show test builds on
    const newer = [rel, test].filter((m) => m && compareVersion(m.version, running) === 1)
      .sort((a, b) => compareVersion(b.version, a.version));
    cloud.offer = newer[0] || null;
    cloud.previous = prev && prev.version !== running ? prev : null;
    cloud.state = cloud.offer ? 'available' : (rel || test) ? 'current' : 'none';
    log(`Firmware check (${ch}): ${cloud.offer ? cloud.offer.version + ' available' : 'no newer version'}`);
  } catch (e) {
    if (seq !== cloud.seq) return;
    cloud.state = 'offline'; log('Firmware check failed: ' + (e.name === 'AbortError' ? 'no answer in 10 s' : e.message));
  }
  renderCloud();
}

// stream the image with progress from the manifest size; refuse above it; then the §14.5 checks
async function fwDownload(m) {
  if (fw.running || !m) return;
  if (cloud.dl) cloud.dl.abort();
  const ctl = new AbortController();
  cloud.dl = ctl; cloud.state = 'downloading'; cloud.pct = 0; cloud.msg = '';
  fw.image = null; fw.desc = null; fw.fromCloud = null; $('fwFile').value = '';
  renderCloud(); renderFirmware();
  const t0 = Date.now(); let last = t0, why = '';
  const watch = setInterval(() => {
    const n = Date.now();
    if (n - last > 15000) { why = 'no data for 15 s'; ctl.abort(); } else if (n - t0 > 120000) { why = 'over 120 s'; ctl.abort(); }
  }, 1000);
  try {
    const r = await fetch(fwUrl(cloud.channel, m.file), { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = new Uint8Array(m.size);
    let got = 0;
    const rd = r.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      if (got + value.length > m.size) { ctl.abort(); cloud.state = 'refused'; cloud.msg = IMAGE_REASONS.size; log('Firmware download refused: larger than published'); return; }
      buf.set(value, got); got += value.length; last = Date.now();
      cloud.pct = Math.floor((got * 100) / m.size); renderDl();
    }
    cloud.state = 'verifying'; renderCloud();
    const res = await checkImage(buf.subarray(0, got), m, OTA_MAX.app);
    if (!res.ok) { cloud.state = 'refused'; cloud.msg = res.reason; log('Firmware download refused: ' + res.code); return; }
    fw.image = buf; fw.desc = res.desc; fw.name = m.file; fw.target = 'app'; fw.fromCloud = m;
    cloud.state = 'ready';
    log(`Firmware ${m.version} downloaded and checked`);
  } catch (e) {
    if (cloud.dl !== ctl) return;
    if (ctl.signal.aborted && !why) { cloud.state = cloud.offer ? 'available' : 'current'; log('Firmware download cancelled'); }
    else { cloud.state = 'dlfail'; log('Firmware download failed: ' + (why || e.message)); }
  } finally {
    clearInterval(watch);
    if (cloud.dl === ctl) cloud.dl = null;
    renderCloud(); renderFirmware();
  }
}

function renderDl() { $('fwDlBar').style.width = cloud.pct + '%'; setText('fwDlStep', cloud.state === 'verifying' ? 'Checking the file…' : `Downloading ${cloud.pct}%`); }

const CLOUD_TEXT = {
  off: () => 'Connect the cluster to check for updates.',
  unknown: () => 'This cluster firmware has an older version name and cannot be checked online. Choose a file instead.',
  checking: () => 'Checking for updates…',
  current: () => `The cluster runs the newest firmware (${plainVersion(link.device && link.device.clusterVersion)}).`,
  available: () => `Firmware ${cloud.offer.version} is available.`,
  none: () => `No firmware is published for this cluster (channel ${cloud.channel}). Choose a file instead.`,
  offline: () => 'Could not check for updates. Choose a file instead.',
  downloading: () => '', verifying: () => '',
  ready: () => `Firmware ${fw.fromCloud ? fw.fromCloud.version : ''} is ready to install.`,
  refused: () => cloud.msg,
  dlfail: () => 'Could not download the firmware. Choose a file instead.',
};
const CLOUD_CLASS = { refused: 'bad', offline: 'warn', dlfail: 'warn', unknown: 'warn', available: 'ok', ready: 'ok' };
function renderCloud() {
  if (!$('fwCloud')) return;
  const st = cloud.state;
  const busy = st === 'downloading' || st === 'verifying';
  $('fwCloud').hidden = busy;
  if (!busy) { setText('fwCloud', CLOUD_TEXT[st](cloud)); $('fwCloud').className = 'status ' + (CLOUD_CLASS[st] || ''); }
  $('fwDl').hidden = !busy; if (busy) renderDl();
  $('btnFwDlCancel').hidden = st !== 'downloading';
  const canUpdate = !!cloud.offer && !fw.running && ['available', 'refused', 'dlfail'].includes(st);
  $('fwCloudRow').hidden = !canUpdate;
  const pv = cloud.previous && !fw.running && !busy && st !== 'ready' && linked();
  $('btnFwPrevious').hidden = !pv;
  if (pv) setText('btnFwPrevious', `Install previous version ${cloud.previous.version}`);
  $('fwTest').checked = fwTest();
  // banner and dots: an offered version that is not installed and not dismissed
  const dismissed = store.get('fwDismissed', '');
  const show = !!cloud.offer && linked() && cloud.offer.version !== dismissed;
  const bannerOn = show && !fw.running && st === 'available';
  $('fwBanner').hidden = !bannerOn;
  if (bannerOn) setText('fwBannerText', `Firmware ${cloud.offer.version} is available.`);
  $('setupDot').hidden = !show; $('fwDot').hidden = !show;
}
function fwUpdateNow() { const m = cloud.offer; if (!m) return; openPage('pgFirmware'); fwDownload(m); }
$('btnFwUpdate').onclick = fwUpdateNow;
$('btnFwBannerUpdate').onclick = fwUpdateNow;
$('btnFwNotNow').onclick = () => { if (cloud.offer) { store.set('fwDismissed', cloud.offer.version); log(`Firmware ${cloud.offer.version}: Not now`); } renderCloud(); };
$('btnFwDlCancel').onclick = () => { if (cloud.dl) cloud.dl.abort(); };
$('btnFwPrevious').onclick = () => {
  const m = cloud.previous; if (!m) return;
  confirmBox(`Install the older firmware ${m.version}? The cluster restarts twice and then runs the older version.`, 'Download older version', () => fwDownload(m));
};
$('fwTest').onchange = (e) => { store.set('fwTest', e.target.checked); if (!['downloading', 'verifying', 'ready'].includes(cloud.state)) { cloud.state = 'off'; fwCheck(); } };

// ---------- Setup boxes (were pushed pages), dialogs ----------
function openPage(id) {
  showTab('setup');
  if (id === 'pgSaved') renderSaved(); if (id === 'pgCluster') renderDetails(); if (id === 'pgUnit') renderUnitPage(); if (id === 'pgCaptures') renderCaptures();
  if (id === 'pgFirmware') { renderFirmware(); fwCheck(); } if (id === 'pgGoogle') renderGoogle(); if (id === 'pgAppearance' || id === 'pgDebug') renderAppearance();
  const el = $(id); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
  render();
}
function closePages() {}
function modal(build) {
  const body = $('modalBody');
  body.innerHTML = '';
  build(body, () => { $('modal').hidden = true; });
  $('modal').hidden = false;
}
// D22: the action on the left, Cancel at the right edge (a slip of the right thumb lands on Cancel)
function confirmBox(text, okLabel, ok, { danger = false } = {}) {
  modal((b, close) => {
    b.innerHTML = `<div></div><div class="row"><button class="btn ${danger ? 'bad' : 'pri'}"></button><button class="btn push">Cancel</button></div>`;
    b.firstChild.textContent = text;
    const [y, n] = b.querySelectorAll('button');
    y.textContent = okLabel; y.onclick = () => { close(); ok(); };
    n.onclick = close;
  });
}
function askName(title, value, ok) {
  modal((b, close) => {
    b.innerHTML = '<b></b><input maxlength="80"><div class="note"></div><button class="btn pri">Save</button> <button class="btn">Cancel</button>';
    b.querySelector('b').textContent = title;
    const inp = b.querySelector('input'); inp.value = value;
    const [y, n] = b.querySelectorAll('button');
    y.onclick = () => { const v = inp.value.trim(); if (v.length < 1 || v.length > 80) { b.querySelector('.note').textContent = 'Use a name between 1 and 80 characters.'; return; } close(); ok(v); };
    n.onclick = close;
  });
}

function renderDetails() {
  const d = link.device || {};
  const rows = [
    ['Cluster', linked() ? 'Connected' : 'Not connected'],
    ['Connected since', linked() && link.since ? new Date(link.since).toTimeString().slice(0, 8) : '-'],
    ['Firmware', d.clusterVersion || '-'],
    ['Firmware build', d.build || '-'],
    ['Updater', d.updaterVersion || '-'],
    ['GPS sharing', gps.sharing ? 'On' : 'Off'],
    ['Last route', link.routeAck || '-'],
    ['Web app', VERSION],
  ];
  $('details').innerHTML = '';
  for (const [k, v] of rows) { const a = document.createElement('span'); a.textContent = k; const b = document.createElement('span'); b.textContent = v; $('details').append(a, b); }
}

async function render() {
  const reg = !!(await kv('bikePub'));
  const on = !!(link.dev && link.dev.gatt.connected);
  $('btnLink').textContent = on ? 'Disconnect cluster' : (reg ? 'Connect cluster' : 'Register this device');
  $('btnLink').className = 'btn js-link' + (on && link.authed ? ' on' : '');
  $('btnGps').textContent = gps.sharing ? 'GPS sharing on' : 'Share GPS';
  $('btnGps').className = 'btn' + (gps.sharing ? ' on' : '');
  $('btnGps').disabled = !linked();
  $('btnSend').disabled = !linked() || !nav.choices.length;
  $('stopRow').hidden = !(linked() && nav.line);
  $('btnSimulate').disabled = !nav.choices.length || !linked();
  $('simHint').hidden = nav.choices.length > 0;
  $('pairState').textContent = reg ? 'This device is registered with a cluster.' : 'Not registered yet.';
  if (document.body.dataset.tab === 'setup') renderDetails();
  const label = $('btnLink').textContent;
  document.querySelectorAll('.js-link').forEach((b) => { b.textContent = label; b.className = 'btn js-link' + (on && link.authed ? ' on' : ''); });
  renderChips();
  renderCloud();
}


// ---------- bike unit through the cluster (bikeunit.js: profiles, decoders, relay contract) ----------
const profileOf = (id) => PROFILES[id] || PROFILES[DEFAULT_PROFILE];
const unit = { profile: profileOf(store.get('unitProfile', DEFAULT_PROFILE)), fields: null, state: null, relayOn: null,
  demo: false, demoT: null, demoStart: 0, frames: 0, lastFrameAt: 0, rateFrames: [], rec: null, raw: [], rawPaused: false, rawDirty: false };
unit.fields = unit.profile.create();
const STATUS_CLASS = { [ST_V]: 'verified', [ST_P]: 'plausible', [ST_U]: 'unknown', [ST_X]: 'notverified', [ST_N]: 'notfitted' };
const nf = (v, d = 0) => (typeof v === 'number' ? v.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }) : (v ?? '-'));
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function onUnitFrame(h) {
  let b;
  try { b = fromHex(h); } catch (_) { return; }
  const ok = unit.fields.decode(b);
  const now = Date.now();
  unit.frames++; unit.lastFrameAt = now; unit.rateFrames.push(now);
  if (unit.rateFrames.length > 200) unit.rateFrames.splice(0, 100);
  if (unit.rec) { unit.rec.buf.push(captureLine(now, h.toLowerCase())); unit.rec.frames++; }
  if (!unit.rawPaused) { unit.raw.unshift({ t: now, h: h.toLowerCase(), ok, id: b[0] }); if (unit.raw.length > 200) unit.raw.length = 200; unit.rawDirty = true; }
}
// the relay runs while a bike-data tab is on screen, or while recording
const UNIT_TABS = ['live', 'fields', 'raw', 'bike'];
function wantRelay() { return unit.rec !== null || UNIT_TABS.includes(document.body.dataset.tab); }
function syncRelay() {
  if (!linked() || unit.demo) return;
  const want = wantRelay();
  if (unit.relayOn === want) return;
  unit.relayOn = want;
  sendLine(bikeRelayLine(want), true).catch(() => { unit.relayOn = null; });
}
function unitStateName() {
  if (unit.demo) return 'Demo data';
  if (!linked()) return 'Off';
  if (!unit.state) return unit.noRelay ? 'No reply' : 'Asking the cluster…';
  return UNIT_STATES[unit.state.state] || unit.state.state;
}
function rate() { const now = Date.now(); let n = 0; for (const t of unit.rateFrames) if (now - t < 5000) n++; return n / 5; }
function setText(id, v) { const e = $(id); if (e.textContent !== v) e.textContent = v; }
function renderChips() {
  const on = linked();
  setText('pillCluster', on ? 'Linked' : (link.dev && link.dev.gatt.connected ? 'Connecting' : 'Off'));
  $('chipCluster').className = 'chip ' + (on ? 'ok' : '');
  const st = unit.demo ? 'streaming' : (on && unit.state ? unit.state.state : 'off');
  const live = Date.now() - unit.lastFrameAt < 3000;
  setText('pillUnit', unitStateName());
  $('chipUnit').className = 'chip ' + (st === 'streaming' && live ? 'ok' : st === 'rejected' ? 'bad' : ['scanning', 'connecting', 'reconnecting'].includes(st) ? 'warn' : '');
  setText('chipRate', `${nf(rate(), 1)} per second`);
  $('demoTag').hidden = !unit.demo;
  setText('recLabel', unit.rec ? `Stop recording · ${clock(Date.now() - unit.rec.started)} · ${unit.rec.frames}` : 'Record');
  $('btnRecord').className = 'btn' + (unit.rec ? ' rec' : '');
  $('btnRecord').disabled = !unit.rec && !unit.demo && !linked();
}
const clock = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
// Live cells come from the profile
let liveBuiltFor = '';
function buildLive() {
  if (liveBuiltFor === unit.profile.id) return;
  liveBuiltFor = unit.profile.id;
  $('liveCells').innerHTML = unit.profile.live.map(([k, label, u], i) =>
    `<div class="cell"><div class="k">${esc(label)} <em class="vs" data-k="${esc(k)}"></em></div><div class="v"><span id="lv${i}">-</span> <small>${esc(u)}</small></div></div>`).join('');
}
function renderLive() {
  buildLive();
  const f = unit.fields;
  unit.profile.live.forEach(([k, , , d], i) => { const v = f.get(k); setText('lv' + i, v === undefined ? '-' : nf(v, d)); });
  document.querySelectorAll('#liveCells .vs[data-k]').forEach((e) => {
    const r = f.rows.get(e.dataset.k); const st = r ? r.status : '';
    const txt = st && st !== ST_V ? st : '';
    if (e.textContent !== txt) { e.textContent = txt; e.className = 'vs ' + (STATUS_CLASS[st] || ''); }
  });
  const w = f.warning();
  $('attention').className = 'fault ' + (w.level === 'unknown' ? '' : w.level);
  setText('attentionText', w.text);
  const has = f.rows.size > 0;
  $('engEmpty').hidden = has;
  const st = unit.state && unit.state.state;
  setText('engEmptyWhy', !linked() && !unit.demo ? 'Connect the cluster. It reads the bike unit and passes the data here. To try the screens without a bike, turn on Demo data in Setup.'
    : !unit.state && !unit.demo ? 'The cluster has not reported a bike unit. Reading a bike unit needs cluster firmware 0.1.5 or later.'
    : st === 'noKey' ? `Send the ${unit.profile.key.label.toLowerCase()} to the cluster (Setup).`
    : st === 'off' ? 'Turn on "Cluster connects to the bike unit" (Setup).'
    : st === 'rejected' ? `The bike unit rejected the ${unit.profile.key.label.toLowerCase()}.`
    : 'Turn the key on. Bike unit: ' + unitStateName().toLowerCase() + '.');
}
const fmtVal = (r) => (typeof r.value === 'number' ? nf(r.value, Number.isInteger(r.value) ? 0 : (Math.abs(r.value) < 100 ? 2 : 1)) : String(r.value));
const numFmt = (x) => (x === null || x === undefined ? '' : nf(x, Number.isInteger(x) ? 0 : 1));
// Fields table: rows are created once per field and only their changed cells are written
const fieldRows = new Map();
let fieldsLayout = '';
function renderFields() {
  const showAll = $('showNotFitted').checked;
  const groups = unit.fields.groups(!showAll);
  const layout = unit.profile.id + '|' + showAll + '|' + groups.map(([g, rows]) => g + ':' + rows.length).join(',');
  const body = $('fieldBody');
  if (layout !== fieldsLayout) {
    fieldsLayout = layout; fieldRows.clear(); body.textContent = '';
    if (!groups.length) { body.innerHTML = '<tr><td colspan="7" class="note">No data yet.</td></tr>'; return; }
    for (const [g, rows] of groups) {
      const gr = document.createElement('tr'); gr.className = 'grp'; gr.innerHTML = `<td colspan="7">${esc(g)}</td>`; body.appendChild(gr);
      for (const r of rows) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${esc(r.label)}</td><td class="r v"></td><td>${esc(r.unit)}</td><td class="r opt"></td><td class="r opt"></td><td class="raw opt"></td><td><span class="vs ${STATUS_CLASS[r.status] || ''}">${esc(r.status)}</span></td>`;
        body.appendChild(tr); fieldRows.set(r, tr.children);
      }
    }
  }
  for (const [r, c] of fieldRows) {
    const v = fmtVal(r), mn = numFmt(r.min), mx = numFmt(r.max), raw = String(r.raw ?? '');
    if (c[1].textContent !== v) c[1].textContent = v;
    if (c[3].textContent !== mn) c[3].textContent = mn;
    if (c[4].textContent !== mx) c[4].textContent = mx;
    if (c[5].textContent !== raw) c[5].textContent = raw;
  }
}
let rawDrawn = 0;
function renderRaw(force = false) {
  if (!unit.rawDirty) return;
  if (!force && Date.now() - rawDrawn < 500) return;   // twice a second is enough to read
  rawDrawn = Date.now(); unit.rawDirty = false;
  const hideId = $('rawHideFrequent').checked ? unit.profile.frequent.id : -1;
  const rows = [];
  for (const m of unit.raw) {
    if (rows.length >= 100) break;
    if (m.id === hideId) continue;
    const d = new Date(m.t);
    // two lines per message: details, then the whole message in hex across the table
    rows.push(`<tr class="rhead"><td>${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}</td><td>0x${m.id.toString(16).padStart(2, '0')}</td><td class="r">${m.h.length / 2}</td><td class="${m.ok ? '' : 'badsum'}">${m.ok ? 'OK' : 'Bad'}</td></tr><tr><td class="hex" colspan="4">${m.h}</td></tr>`);
  }
  $('rawBody').innerHTML = rows.join('') || '<tr><td colspan="4" class="note">No messages yet.</td></tr>';
}
let bikeSig = '';
function renderBike() {
  const f = unit.fields, html = [];
  const sec = (name, rows) => { if (!rows.length) return; html.push(`<tr class="grp"><td colspan="4">${esc(name)}</td></tr>`);
    for (const r of rows) html.push(`<tr><td>${esc(r.label)}</td><td class="r v">${esc(fmtVal(r))}</td><td>${esc(r.unit)}</td><td><span class="vs ${STATUS_CLASS[r.status] || ''}">${esc(r.status)}</span></td></tr>`); };
  for (const [name, keys] of unit.profile.bike) sec(name, keys.map((k) => f.rows.get(k)).filter(Boolean));
  for (const g of unit.profile.bikeRawGroups) sec(g, [...f.rows.values()].filter((r) => r.group === g));
  const out = html.join('') || '<tr><td class="note">No data yet.</td></tr>';
  if (out !== bikeSig) { bikeSig = out; $('bikeBody').innerHTML = out; }
  setText('bikeSub', unit.demo ? 'Demo data: made-up values.' : `${unit.profile.name}. Read from the bike unit once per connection.`);
}
function renderUnitPage() {
  const s = unit.state || {};
  const rows = [['State', unitStateName()], ['Unit name', s.name || '-'], ['Signal', s.rssi ? `${s.rssi} dBm` : '-'],
    ['Messages read by the cluster', nf(s.frames ?? 0)], ['Messages received here', nf(unit.frames)], ['Messages per second here', nf(rate(), 1)],
    ['Heartbeats', nf(s.heartbeats ?? 0)], ['Reconnects', nf(s.reconnects ?? 0)],
    [`${unit.profile.key.label} on the cluster`, s.keySet === undefined ? '-' : (s.keySet ? 'Stored' : 'Not stored')]];
  const html = rows.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('');
  if ($('unitKv').innerHTML !== html) $('unitKv').innerHTML = html;
  $('unitLinkOn').checked = !!(s.state && s.state !== 'off');
  // D21: firmware that never answered bikeQuery cannot store the key
  const noFw = linked() && unit.noRelay && !unit.demo;
  $('unitLinkOn').disabled = !linked() || noFw;
  $('btnKeySave').disabled = noFw; $('btnKeyErase').disabled = noFw;
  $('unitNoFw').hidden = !noFw;
  if (noFw) {
    const v = link.device ? plainVersion(link.device.clusterVersion) : '';
    const lab = unit.profile.key.label, kname = lab.charAt(0).toLowerCase() + lab.slice(1);
    setText('unitNoFwText', `This cluster firmware${v ? ` (${v})` : ''} cannot store the ${kname}. Update the cluster first.`);
  }
  $('demoOn').checked = unit.demo;
  setText('keyLabel', unit.profile.key.label);
  setText('keyHelp', `${unit.profile.key.help} It is sent once to the cluster and stored there. It is never shown again and never part of the website.`);
  $('unitKey').placeholder = unit.profile.key.hint;
  $('unitKey').setAttribute('aria-label', unit.profile.key.label);
}
function unitConfigReply(m) {
  clearTimeout(unit.cfgT);
  const k = unit.profile.key.label;
  $('unitKeyMsg').textContent = !m.ok ? `The cluster did not accept the ${k.toLowerCase()}.` : m.keySet ? `${k} stored on the cluster.` : `${k} erased from the cluster.`;
  sendLine(bikeQueryLine(), true).catch(() => {});
}
function setProfile(id) {
  unit.profile = profileOf(id); store.set('unitProfile', unit.profile.id);
  unit.fields = unit.profile.create(); unit.raw = []; unit.rawDirty = true; fieldsLayout = ''; liveBuiltFor = ''; bikeSig = '';
  if (unit.demo) setDemo(true);
  renderUnitPage();
}

// demo data: made-up messages from the profile at 10 per second, through the same decoder
function setDemo(on) {
  unit.demo = on;
  clearInterval(unit.demoT);
  unit.fields.clear(); unit.frames = 0; unit.rateFrames = []; unit.raw = []; unit.rawDirty = true; fieldsLayout = '';
  const demo = unit.profile.demo;
  if (on && demo) {
    unit.demoStart = Date.now();
    demo.start().forEach((b) => onUnitFrame(hexOf(b)));
    unit.demoT = setInterval(() => onUnitFrame(hexOf(demo.at((Date.now() - unit.demoStart) / 1000))), 100);
  } else { unit.relayOn = null; syncRelay(); }
  log(on ? 'Demo data on' : 'Demo data off');
  renderChips(); renderUnitPage();
}

// captures: IndexedDB on this device
const capDb = new Promise((res, rej) => {
  const r = indexedDB.open('esp28-captures', 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('sessions', { keyPath: 'id' }); d.createObjectStore('chunks', { autoIncrement: true }).createIndex('sid', 'sid'); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const capStore = async (name, mode) => (await capDb).transaction(name, mode).objectStore(name);
const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
async function flushCapture() {
  const c = unit.rec;
  if (!c || !c.buf.length) return;
  const text = c.buf.join(''); c.buf = [];
  await req((await capStore('chunks', 'readwrite')).add({ sid: c.id, text }));
  await req((await capStore('sessions', 'readwrite')).put({ id: c.id, frames: c.frames, started: c.startedIso, demo: unit.demo, profile: unit.profile.id }));
}
setInterval(() => { flushCapture().catch(() => {}); }, 5000);
async function toggleRecord() {
  if (unit.rec) {
    await flushCapture().catch(() => {});
    status(`Capture saved: ${unit.rec.frames} messages (Setup › Captures)`, 'ok');
    unit.rec = null; syncRelay(); renderChips(); return;
  }
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  unit.rec = { id: `${unit.profile.id}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${unit.demo ? '_demo' : ''}`,
    started: Date.now(), startedIso: d.toISOString(), frames: 0, buf: [] };
  syncRelay(); renderChips();
}
async function renderCaptures() {
  const host = $('capList');
  let all = [];
  try { all = await req((await capStore('sessions', 'readonly')).getAll()); } catch (_) { host.innerHTML = '<p class="note">This browser cannot store captures.</p>'; return; }
  all.sort((a, b) => b.started.localeCompare(a.started));
  if (!all.length) { host.innerHTML = '<p class="note">No captures yet. Tap Record in the header.</p>'; return; }
  host.textContent = '';
  for (const c of all) {
    const row = document.createElement('div'); row.className = 'capitem';
    row.innerHTML = '<span></span><div class="row"><button class="btn bad">Delete</button><button class="btn push">Download</button></div>';
    row.firstChild.textContent = `${c.id} · ${nf(c.frames)} messages${c.demo ? ' · demo data' : ''}`;
    const [del, dl] = row.querySelectorAll('button');
    dl.onclick = () => downloadCapture(c.id);
    del.onclick = () => confirmBox(`Delete ${c.id}? The recorded messages are removed from this device.`, 'Delete', async () => {
      const keys = await req((await capStore('chunks', 'readonly')).index('sid').getAllKeys(c.id));
      const st = await capStore('chunks', 'readwrite'); keys.forEach((k) => st.delete(k));
      await req((await capStore('sessions', 'readwrite')).delete(c.id)); renderCaptures();
    }, { danger: true });
    host.appendChild(row);
  }
}
async function downloadCapture(id) {
  if (unit.rec && unit.rec.id === id) await flushCapture();
  const chunksOf = await req((await capStore('chunks', 'readonly')).index('sid').getAll(id));
  const blob = new Blob(chunksOf.map((c) => c.text), { type: 'text/plain' });
  const name = id + '.log';
  try { const file = new File([blob], name, { type: 'text/plain' }); if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; } } catch (_) {}
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// theme: System follows the device; Light or Dark is kept on this device
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]').content = dark ? '#111418' : '#ffffff';
}

// tabs
const TABS = ['live', 'fields', 'raw', 'bike', 'map', 'setup', 'log'];
function showTab(tab) {
  document.body.dataset.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  try { localStorage.setItem('esp28.tab', JSON.stringify(tab)); } catch (_) {}
  syncRelay();
  if (tab === 'map') startMap().catch((e) => status('Map failed: ' + e.message, 'bad'));
  if (tab === 'setup') { renderDetails(); renderUnitPage(); renderCaptures(); renderSaved(); renderGoogle(); renderAppearance(); renderFirmware(); fwCheck(); }
  unit.rawDirty = true; tick();
}
// one timer, and only the visible tab is drawn (about 4 times a second)
function tick() {
  renderChips();
  const tab = document.body.dataset.tab;
  if (tab === 'live') renderLive(); else if (tab === 'fields') renderFields(); else if (tab === 'raw') renderRaw();
  else if (tab === 'bike') renderBike(); else if (tab === 'setup') renderUnitPage();
}
setInterval(tick, 250);
const hdr = document.querySelector('.hdr');
const setHdr = () => document.documentElement.style.setProperty('--hdr', hdr.offsetHeight + 'px');
window.addEventListener('resize', setHdr); setHdr();

// ---------- wiring ----------
$('btnMe').onclick = () => { if (gps.fix && M) M.view(gps.fix.lat, gps.fix.lon, 16); };
$('q').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchT); search(true); } };
$('q').oninput = () => { clearTimeout(searchT); if (useGoogle('autocomplete', true) && useGoogle('details', true)) searchT = setTimeout(() => search(false), 400); };
$('gkey').onchange = (e) => { store.set('gkey', e.target.value.trim()); renderGoogle(); };
$('btnReload').onclick = () => location.reload();
$('btnTestKey').onclick = () => { testKey(); };
['optMode', 'optTolls', 'optHighways', 'optFerries'].forEach((id) => ($(id).onchange = () => {
  store.set('routeOptions', { mode: $('optMode').value, tolls: $('optTolls').checked, highways: $('optHighways').checked, ferries: $('optFerries').checked });
  if (nav.dest) setDestination(nav.dest);
}));
document.querySelectorAll('.js-link').forEach((b) => (b.onclick = () => $('btnLink').onclick()));
$('btnLink').onclick = async () => {
  if (link.dev && link.dev.gatt.connected) { if (gps.sharing) await setSharing(false); link.dev.gatt.disconnect(); return; }
  connect(false);
};
$('btnGps').onclick = () => setSharing(!gps.sharing);
$('btnSend').onclick = () => sendSelected(false);
$('btnSave').onclick = saveCurrent;
$('btnClear').onclick = () => { nav.dest = null; nav.choices = []; $('destBox').hidden = true; $('q').value = ''; if (M) { M.routes([], 0, selectRoute); M.dest(null); } render(); };
$('btnStop').onclick = () => confirmBox('Stop navigation? The cluster clears the route.', 'Stop navigation', async () => {
  await sendLine({ type: 'stop' }).catch(() => {});
  nav.line = null; nav.active = null; store.set('route', null);
  status('Navigation stopped', 'ok'); render();
}, { danger: true });
$('btnRegister').onclick = () => { closePages(); connect(true); };
$('btnForget').onclick = () => confirmBox('Erase this phone\'s pairing data? You will need to register again.', 'Erase', async () => {
  await kv('bikePub', null); await kv('phoneKey', null); log('Pairing data erased'); render();
}, { danger: true });
$('btnPreviewMode').onclick = () => { previewDay = !previewDay; renderAppearance(); };
$('slRoad').oninput = (e) => { appearance[previewDay ? 'dayRoad' : 'nightRoad'] = +e.target.value; renderAppearance(); };
$('slTerrain').oninput = (e) => { appearance[previewDay ? 'dayTerrain' : 'nightTerrain'] = +e.target.value; renderAppearance(); };
$('slRoad').onchange = $('slTerrain').onchange = saveAppearance;
$('btnResetMode').onclick = () => confirmBox(`Reset ${previewDay ? 'day' : 'night'} brightness to the defaults?`, 'Reset', () => {
  const D = APPEARANCE_DEFAULTS;
  if (previewDay) Object.assign(appearance, { dayRoad: D.dayRoad, dayTerrain: D.dayTerrain });
  else Object.assign(appearance, { nightRoad: D.nightRoad, nightTerrain: D.nightTerrain });
  renderAppearance(); saveAppearance();
}, { danger: true });
$('btnClusterTheme').onclick = () => { appearance.clusterThemeMode = (appearance.clusterThemeMode + 1) % 3; renderAppearance(); saveAppearance(); };
$('slSim').oninput = (e) => { appearance.simulationSpeedKph = +e.target.value; renderAppearance(); };
$('slSim').onchange = saveAppearance;
$('btnSimulate').onclick = () => confirmBox('Simulate this route? The cluster accelerates up to the maximum speed, slows for turns and arrival, and uses made-up readings. Not your real location: use only while stopped. Sending the route again returns to real GPS.',
  'Start simulation', () => { closePages(); sendSelected(true); });
$('btnLiveGps').onclick = async () => {
  if (!linked()) { status('Connect the cluster to change its navigation mode.', 'warn'); return; }
  await sendLine({ type: 'simulation', enabled: false }).catch(() => {});
  closePages(); setSharing(true);
};


document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$('showNotFitted').onchange = () => { fieldsLayout = ''; renderFields(); };
$('btnRawPause').onclick = () => { unit.rawPaused = !unit.rawPaused; $('btnRawPause').textContent = unit.rawPaused ? 'Resume' : 'Pause'; };
$('btnRawClear').onclick = () => { unit.raw = []; unit.rawDirty = true; renderRaw(true); };
$('rawHideFrequent').onchange = () => { unit.rawDirty = true; renderRaw(true); };
$('btnRecord').onclick = () => { toggleRecord().catch((e) => status('Capture failed: ' + e.message, 'bad')); };
$('unitProfile').innerHTML = Object.values(PROFILES).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
$('unitProfile').value = unit.profile.id;
$('unitProfile').onchange = (e) => setProfile(e.target.value);
$('unitLinkOn').onchange = (e) => { if (!linked()) return; sendLine(bikeLinkLine(e.target.checked)).then(() => sendLine(bikeQueryLine(), true)).catch(() => {}); };
$('demoOn').onchange = (e) => setDemo(e.target.checked);
$('btnUnitToFw').onclick = () => openPage('pgFirmware');
$('btnKeyShow').onclick = () => { const i = $('unitKey'); i.type = i.type === 'password' ? 'text' : 'password'; $('btnKeyShow').textContent = i.type === 'password' ? 'Show' : 'Hide'; };
$('btnKeySave').onclick = () => {
  const k = unit.profile.key, v = k.normalize($('unitKey').value);
  if (!k.valid(v)) { $('unitKeyMsg').textContent = `The ${k.label.toLowerCase()} must be ${k.hint}.`; return; }
  if (!linked()) { $('unitKeyMsg').textContent = 'Connect the cluster first.'; return; }
  sendLine(bikeConfigLine(unit.profile.id, v), true).then(() => {
    $('unitKey').value = ''; $('unitKeyMsg').textContent = 'Sent. Waiting for the cluster…';
    clearTimeout(unit.cfgT);
    unit.cfgT = setTimeout(() => { $('unitKeyMsg').textContent = 'Not stored: the cluster did not answer.'; }, 5000);
  }).catch((e) => { $('unitKeyMsg').textContent = 'Not sent: ' + e.message; });
};
$('btnKeyErase').onclick = () => confirmBox(`Erase the ${unit.profile.key.label.toLowerCase()} from the cluster? The cluster cannot log in to the bike unit until you send it again.`, 'Erase', () => {
  if (linked()) sendLine(bikeConfigLine(unit.profile.id, ''), true).catch(() => {});
}, { danger: true });
$('themeSel').value = store.get('theme', 'system');
$('themeSel').onchange = (e) => { store.set('theme', e.target.value); applyTheme(e.target.value); };
applyTheme(store.get('theme', 'system'));
// the stand-in cluster in tests feeds lines here (only with ?test in the address)
if (/[?&]test\b/.test(location.search)) {
  const sent = [], dec = new TextDecoder();
  window.__esp28 = { onLine, sent,
    // a stand-in link: what the app writes is collected as text lines in sent[]
    // { ota: true } adds the update channel: each frame goes to __esp28.onOta(frame); each line also to __esp28.onSent(msg)
    fakeLink({ ota = false } = {}) { let buf = ''; link.dev = { gatt: { connected: true, disconnect() {} } }; link.authed = true;
      link.rx = { writeValueWithResponse: async (c) => { buf += dec.decode(c); let i; while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); sent.push(m); buf = buf.slice(i + 1); if (window.__esp28.onSent) window.__esp28.onSent(m); } } };
      link.ota = ota ? { writeValueWithoutResponse: async (f) => { if (window.__esp28.onOta) window.__esp28.onOta(new Uint8Array(f)); } } : null;
      onLinked(); } };
}

$('ver').textContent = 'Web version ' + VERSION;
{ let t = 'live'; try { t = JSON.parse(localStorage.getItem('esp28.tab')) || 'live'; } catch (_) {} showTab(TABS.includes(t) ? t : 'live'); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!navigator.bluetooth) status(NO_BT, 'bad');
if (navigator.geolocation) startWatch();
log('Web version ' + VERSION);
watchGoogleConsole();

render();
