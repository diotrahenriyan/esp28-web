import { PROTOCOL, SVC, RX, TX, DEVICE_NAME, LINE_MAX, toHex, fromHex, authText, LineAssembler,
  chunks, locationLine, routeLine, FIELD_MASK } from './core.js';

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

// ---------- Google: places and routes ----------
const key = () => localStorage.getItem('gkey') || '';
let session = crypto.randomUUID();
let picked = null;   // {name, lat, lon}
let routes = [];     // Google routes
let here = null;

async function gfetch(url, body, mask) {
  const r = await fetch(url, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key(), ...(mask ? { 'X-Goog-FieldMask': mask } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
  return j;
}

function myPosition() {
  return new Promise((res, rej) => navigator.geolocation.getCurrentPosition(
    (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude, heading: p.coords.heading }), rej,
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }));
}

let searchT;
async function search(q) {
  if (!key()) { status('Add your Google key in Settings first.', 'bad'); return; }
  const body = { input: q, sessionToken: session, languageCode: 'en', includedRegionCodes: ['id'] };
  if (here) body.locationBias = { circle: { center: { latitude: here.lat, longitude: here.lon }, radius: 30000 } };
  try {
    const j = await gfetch('https://places.googleapis.com/v1/places:autocomplete', body);
    const list = $('results');
    list.innerHTML = '';
    for (const s of (j.suggestions || []).filter((s) => s.placePrediction).slice(0, 6)) {
      const p = s.placePrediction;
      const b = document.createElement('button');
      b.className = 'result';
      b.innerHTML = `<b></b><span></span>`;
      b.querySelector('b').textContent = p.structuredFormat ? p.structuredFormat.mainText.text : p.text.text;
      b.querySelector('span').textContent = p.structuredFormat && p.structuredFormat.secondaryText ? p.structuredFormat.secondaryText.text : '';
      b.onclick = () => pick(p.placeId, b.querySelector('b').textContent);
      list.appendChild(b);
    }
  } catch (e) { status('Search failed: ' + e.message, 'bad'); log('Places: ' + e.message); }
}

async function pick(id, name) {
  $('results').innerHTML = '';
  try {
    const p = await fetch(`https://places.googleapis.com/v1/places/${id}?sessionToken=${session}`, {
      headers: { 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': 'displayName,location' } }).then((r) => r.json());
    session = crypto.randomUUID();
    if (!p.location) throw new Error((p.error && p.error.message) || 'no location');
    picked = { name: (p.displayName && p.displayName.text) || name, lat: p.location.latitude, lon: p.location.longitude };
    $('q').value = picked.name;
    await previewRoutes();
  } catch (e) { status('Place failed: ' + e.message, 'bad'); }
}

async function previewRoutes() {
  status('Planning the route…');
  try {
    here = await myPosition();
    const origin = { location: { latLng: { latitude: here.lat, longitude: here.lon } } };
    if (Number.isFinite(here.heading)) origin.location.heading = Math.round(here.heading);
    const j = await gfetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      origin, destination: { location: { latLng: { latitude: picked.lat, longitude: picked.lon } } },
      travelMode: $('mode').value, routingPreference: 'TRAFFIC_AWARE', computeAlternativeRoutes: true,
      languageCode: 'en', units: 'METRIC' }, FIELD_MASK);
    routes = j.routes || [];
    const box = $('routes');
    box.innerHTML = '';
    routes.forEach((r, i) => {
      const b = document.createElement('button');
      b.className = 'result';
      const min = Math.round(parseFloat(r.duration) / 60);
      b.innerHTML = `<b>Route ${i + 1}: ${min} min</b><span>${(r.distanceMeters / 1000).toFixed(1)} km. Tap to send to the cluster</span>`;
      b.onclick = () => sendRoute(routeLine(r, picked));
      box.appendChild(b);
    });
    status(routes.length ? 'Pick a route' : 'No route found', routes.length ? '' : 'bad');
  } catch (e) { status('Route failed: ' + e.message, 'bad'); log('Routes: ' + e.message); }
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
  $('gkey').value = key();
}

$('btnRegister').onclick = () => connect(true);
$('btnConnect').onclick = () => connect(false);
$('btnDisconnect').onclick = () => { stopGps(); link.dev.gatt.disconnect(); };
$('btnGps').onclick = () => (gps.watch !== null ? stopGps() : startGps());
$('btnStop').onclick = () => { sendLine({ type: 'stop' }).then(() => status('Navigation stopped', 'ok')); };
$('q').oninput = (e) => { clearTimeout(searchT); const v = e.target.value.trim(); if (v.length > 2) searchT = setTimeout(() => search(v), 350); };
$('gkey').onchange = (e) => { localStorage.setItem('gkey', e.target.value.trim()); log('Google key saved'); };
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
