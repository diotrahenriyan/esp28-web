import { PROTOCOL, SVC, RX, TX, DEVICE_NAME, LINE_MAX, toHex, fromHex, authText, LineAssembler,
  chunks, locationLine, osrmRouteLine } from './core.js';

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

// ---------- log ----------
function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  const el = $('log');
  el.textContent = `${t} ${msg}\n` + el.textContent.slice(0, 20000);
  console.log(msg);
}
function status(text, cls = '') { const s = $('status'); s.textContent = text; s.className = 'status ' + cls; }

// ---------- storage (IndexedDB: the phone key stays non-extractable) ----------
const db = new Promise((res, rej) => {
  const r = indexedDB.open('esp28', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function kv(key, val) {
  const d = await db;
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', val === undefined ? 'readonly' : 'readwrite');
    const st = tx.objectStore('kv');
    const r = val === undefined ? st.get(key) : (val === null ? st.delete(key) : st.put(val, key));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function phoneKey() {
  let k = await kv('phoneKey');
  if (!k) {
    const pair = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']);
    const pub = toHex(await crypto.subtle.exportKey('raw', pair.publicKey));
    k = { priv: pair.privateKey, pub };
    await kv('phoneKey', k);
    log('New phone key made');
  }
  return k;
}

// ---------- BLE link ----------
const link = { dev: null, rx: null, tx: null, chain: Promise.resolve(), authed: false,
  mode: null, bikeNonce: null, phoneNonce: null, wantRegister: false, pendingRoute: null };

function write(bytes) {
  // GATT operations one at a time; with response so iOS starts pairing on the encrypted RX
  const p = link.chain.then(async () => {
    const w = link.rx.writeValueWithResponse ? (c) => link.rx.writeValueWithResponse(c) : (c) => link.rx.writeValue(c);
    for (const c of chunks(bytes)) await w(c);
  });
  link.chain = p.catch(() => {});
  return p;
}
function sendLine(obj) {
  const b = enc.encode(JSON.stringify(obj) + '\n');
  if (b.length > LINE_MAX) throw new Error('Line too long for the cluster');
  if (obj.type !== 'location') log(`→ ${obj.type} (${b.length} bytes)`);
  return write(b);
}

async function connect(register) {
  if (!navigator.bluetooth) {
    status('This browser has no Bluetooth. Open this page in Bluefy.', 'bad');
    return;
  }
  link.wantRegister = register;
  link.authed = false;
  link.bikeNonce = null;
  try {
    status('Choose "ESP 2.8 Cluster" in the list…');
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ name: DEVICE_NAME }, { namePrefix: 'ESP 2.8' }], optionalServices: [SVC] });
    link.dev = dev;
    dev.addEventListener('gattserverdisconnected', onDisconnect);
    status('Connecting…');
    const server = await dev.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    link.rx = await svc.getCharacteristic(RX);
    link.tx = await svc.getCharacteristic(TX);
    const asm = new LineAssembler(onLine);
    link.tx.addEventListener('characteristicvaluechanged', (e) =>
      asm.feed(new Uint8Array(e.target.value.buffer, e.target.value.byteOffset, e.target.value.byteLength)));
    await link.tx.startNotifications();
    log('Connected, notifications on');
    if (register) status('Pairing: accept the code on the iPhone, then confirm it on the cluster.', 'warn');
    else status('Securing the link…');
    // an empty line: harmless to the cluster, but the encrypted RX makes iOS pair / encrypt first
    await write(enc.encode('\n'));
    log('Link secure');
    if (register) {
      const k = await phoneKey();
      await sendLine({ type: 'register', pub: k.pub, name: 'iPhone (web)' });
      status('Registering…');
    } else {
      status('Waiting for the cluster…');
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
  log('Disconnected');
  status('Disconnected. Tap Connect.', 'bad');
  stopGps(false);
  render();
}

async function onLine(line) {
  let m;
  try { m = JSON.parse(line); } catch (_) { log('← (not JSON) ' + line.slice(0, 80)); return; }
  if (m.type !== 'challenge') log('← ' + line.slice(0, 160));
  switch (m.type) {
    case 'registered':
      await kv('bikePub', m.bikePub);
      log('Registered with the cluster');
      break;
    case 'challenge':
      if (m.protocol !== PROTOCOL || m.nonce === link.bikeNonce) return; // a repeat of the same one
      link.bikeNonce = m.nonce;
      try { await authenticate(m.nonce); } catch (e) { log('Auth failed: ' + e.message); status('Sign-in failed: ' + e.message, 'bad'); }
      break;
    case 'authenticated': {
      const ok = await verifyBike(m.sig);
      if (!ok) { status('The cluster failed its own check. Disconnected.', 'bad'); link.dev.gatt.disconnect(); return; }
      link.authed = true;
      status('Connected to the cluster', 'ok');
      render();
      if (link.pendingRoute) { const r = link.pendingRoute; link.pendingRoute = null; sendRoute(r); }
      break;
    }
    case 'deviceStatus':
      $('fw').textContent = `Firmware ${m.clusterVersion || '?'}`;
      break;
    case 'routeAck':
      status(`Route delivered: ${m.points} points, ${m.steps} steps, ${(m.meters / 1000).toFixed(1)} km`, 'ok');
      break;
    case 'status':
      status(m.text, /not registered/i.test(m.text) ? 'bad' : '');
      if (/not registered/i.test(m.text)) { await kv('bikePub', null); log('Cluster forgot this phone: register again'); }
      break;
  }
}

async function authenticate(bikeNonce) {
  const k = await kv('phoneKey');
  if (!k) throw new Error('no phone key, register first');
  link.phoneNonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const sig = await crypto.subtle.sign(SIGN, k.priv, enc.encode(authText('phone', bikeNonce, link.phoneNonce)));
  await sendLine({ type: 'authenticate', nonce: link.phoneNonce, sig: toHex(sig) });
}

async function verifyBike(sigHex) {
  const pubHex = await kv('bikePub');
  if (!pubHex) { log('No stored cluster key: trusting this first answer'); return true; }
  const pub = await crypto.subtle.importKey('raw', fromHex(pubHex), ECDSA, false, ['verify']);
  return crypto.subtle.verify(SIGN, pub, fromHex(sigHex), enc.encode(authText('bike', link.bikeNonce, link.phoneNonce)));
}

// ---------- Share GPS ----------
const gps = { watch: null, lock: null, last: 0 };
async function startGps() {
  if (!link.authed) return;
  await sendLine({ type: 'gpsSharing', enabled: true });
  gps.watch = navigator.geolocation.watchPosition((p) => {
    if (!link.authed || Date.now() - gps.last < 900) return;
    gps.last = Date.now();
    write(enc.encode(JSON.stringify(locationLine(p.coords, p.timestamp)) + '\n')).catch((e) => log('GPS send: ' + e.message));
    $('gpsInfo').textContent = `±${Math.round(p.coords.accuracy)} m`;
  }, (e) => { log('GPS: ' + e.message); $('gpsInfo').textContent = 'GPS error: ' + e.message; },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  try { gps.lock = await navigator.wakeLock.request('screen'); log('Screen kept on'); }
  catch (_) { log('Screen lock not available: keep the screen on yourself'); }
  render();
}
function stopGps(tell = true) {
  if (gps.watch !== null) navigator.geolocation.clearWatch(gps.watch);
  gps.watch = null;
  if (gps.lock) { gps.lock.release().catch(() => {}); gps.lock = null; }
  if (tell && link.authed) sendLine({ type: 'gpsSharing', enabled: false }).catch(() => {});
  $('gpsInfo').textContent = '';
  render();
}

// ---------- OpenStreetMap: Nominatim search and OSRM routes (free, no key) ----------
let picked = null;   // {name, lat, lon}
let here = null;

function myPosition() {
  return new Promise((res, rej) => navigator.geolocation.getCurrentPosition(
    (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }), rej,
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }));
}

async function search() {
  const q = $('q').value.trim();
  if (q.length < 3) return;
  status('Searching…');
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.search = new URLSearchParams({ q, format: 'jsonv2', limit: '6', countrycodes: 'id', 'accept-language': 'en' });
  if (here) u.searchParams.set('viewbox', `${here.lon - 0.5},${here.lat + 0.5},${here.lon + 0.5},${here.lat - 0.5}`);
  try {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = $('results');
    list.innerHTML = '';
    const found = await r.json();
    for (const p of found) {
      const b = document.createElement('button');
      b.className = 'result';
      b.innerHTML = '<b></b><span></span>';
      const name = p.name || p.display_name.split(',')[0];
      b.querySelector('b').textContent = name;
      b.querySelector('span').textContent = p.display_name;
      b.onclick = () => { list.innerHTML = ''; picked = { name, lat: +p.lat, lon: +p.lon }; $('q').value = name; previewRoutes(); };
      list.appendChild(b);
    }
    status(found.length ? 'Pick a place' : 'Nothing found', found.length ? '' : 'bad');
  } catch (e) { status('Search failed: ' + e.message, 'bad'); log('Search: ' + e.message); }
}

async function osrm(from, to, exclude) {
  const u = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}` +
    `?overview=full&geometries=geojson&steps=true&alternatives=true${exclude ? '&exclude=toll' : ''}`;
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.code !== 'Ok') throw new Error(j.message || j.code || `HTTP ${r.status}`);
  return j.routes || [];
}

async function previewRoutes() {
  status('Planning the route…');
  try {
    here = await myPosition();
    let routes;
    try { routes = await osrm(here, picked, true); }
    catch (e) { log('Route without tolls failed (' + e.message + '), trying without the toll rule'); routes = await osrm(here, picked, false); }
    const box = $('routes');
    box.innerHTML = '';
    routes.forEach((r, i) => {
      const b = document.createElement('button');
      b.className = 'result';
      b.innerHTML = `<b>Route ${i + 1}: ${Math.round(r.duration / 60)} min</b><span>${(r.distance / 1000).toFixed(1)} km, no traffic data. Tap to send to the cluster</span>`;
      b.onclick = () => sendRoute(osrmRouteLine(r, picked));
      box.appendChild(b);
    });
    status(routes.length ? 'Pick a route' : 'No route found', routes.length ? '' : 'bad');
  } catch (e) { status('Route failed: ' + e.message, 'bad'); log('Route: ' + e.message); }
}

async function sendRoute(line) {
  if (!link.authed) { link.pendingRoute = line; status('Route ready. Connect to send it.', 'warn'); return; }
  try {
    status('Sending the route…');
    await sendLine({ type: 'destination', name: line.name, latitude: line.latitude, longitude: line.longitude });
    await sendLine(line);
  } catch (e) { status('Send failed: ' + e.message, 'bad'); }
}

// ---------- UI ----------
async function render() {
  const reg = !!(await kv('bikePub'));
  const on = !!(link.dev && link.dev.gatt.connected);
  $('btnRegister').hidden = on;
  $('btnConnect').hidden = on || !reg;
  $('btnDisconnect').hidden = !on;
  $('regHint').hidden = reg || on;
  $('btnGps').textContent = gps.watch !== null ? 'Stop sharing GPS' : 'Share GPS';
  $('btnGps').disabled = !link.authed;
  $('btnStop').disabled = !link.authed;
}

$('btnRegister').onclick = () => connect(true);
$('btnConnect').onclick = () => connect(false);
$('btnDisconnect').onclick = () => { stopGps(); link.dev.gatt.disconnect(); };
$('btnGps').onclick = () => (gps.watch !== null ? stopGps() : startGps());
$('btnStop').onclick = () => { sendLine({ type: 'stop' }).then(() => status('Navigation stopped', 'ok')); };
$('btnSearch').onclick = search;
$('q').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
$('btnForget').onclick = async () => { await kv('bikePub', null); await kv('phoneKey', null); log('Pairing data erased'); render(); };
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && gps.watch !== null && !gps.lock) {
    try { gps.lock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!navigator.bluetooth) status('No Bluetooth in this browser. Open this page in Bluefy.', 'bad');
myPosition().then((p) => { here = p; }).catch(() => {});
render();
