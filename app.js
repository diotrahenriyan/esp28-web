// ESP 2.8 Companion (web): the Android app's flow on Web Bluetooth (Bluefy on iPhone), with free
// OpenStreetMap services instead of Google. Link behaviour mirrors BleSpeedometerLink.kt and
// LocationStreamService.kt; the wire contract is speedo-idf/main/ble_link_proto.h + nav_lines.tsv.
import { PROTOCOL, SVC, RX, TX, DEVICE_NAME, LINE_MAX, toHex, fromHex, authText, LineAssembler, chunks,
  locationLine, osrmRouteLine, withRouteId, distanceToLine, metersBetween, RerouteDetector,
  APPEARANCE_DEFAULTS, appearanceLine, usesToll, OTA, OTA_MAX, appDesc, otaDecide, plainVersion, OtaSender } from './core.js';

const VERSION = '2.8-w0.4.0';
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
const STATUS_HINT = {
  'Phone not registered': 'The cluster does not know this phone. Register it again in Settings → Cluster pairing.',
  'Registration closed': 'Registration is closed. On the cluster open the phone page and hold BOOT for 2 seconds, then try again.',
  'Phone list full': 'The cluster already has the maximum of 3 phones.',
  'Bad key': "The cluster rejected this phone's key.",
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
  if (!navigator.bluetooth) { status('No Bluetooth in this browser. Open this page in Bluefy.', 'bad'); return; }
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
    status(register ? 'Pairing: tap Pair on the iPhone, then confirm the same code on the cluster.' : 'Authenticating…', register ? 'warn' : '');
    if (register) $('pairState').textContent = 'Pairing: confirm the code on the iPhone and on the cluster.';
    // an empty line is ignored by the cluster, but the encrypted RX makes iOS pair / encrypt first
    await write(enc.encode('\n'));
    log('Link secure');
    if (register) {
      const k = await phoneKey();
      await sendLine({ type: 'register', pub: k.pub, name: 'iPhone web' });
      status('Paired. Registering this phone…');
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
  if (fw.running && fw.sender && fw.sender.state !== 'done') fw.sender.fail('Disconnected');
  log('Disconnected');
  status('Cluster disconnected. Tap Connect cluster.', 'bad');
  render();
}

async function onLine(line) {
  let m;
  try { m = JSON.parse(line); } catch (_) { return; }
  if (!['challenge', 'deviceStatus', 'otaAck'].includes(m.type)) log('← ' + line.slice(0, 160));
  switch (m.type) {
    case 'registered':
      if (!link.register || m.protocol !== PROTOCOL || !/^04[0-9a-f]{128}$/i.test(m.bikePub || '')) return;
      await kv('bikePub', m.bikePub.toLowerCase());
      status('Phone registered. Authenticating…');
      $('pairState').textContent = 'Registered with the cluster';
      break;
    case 'challenge': {
      if (m.protocol !== PROTOCOL) { status(`Cluster link ${m.protocol} not supported`, 'bad'); return; }
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
      if (!ok) { status("The cluster's answer is wrong (another cluster?)", 'bad'); link.dev.gatt.disconnect(); return; }
      link.authed = true;
      link.since = Date.now();
      log('Authenticated');
      onLinked();
      break;
    }
    case 'deviceStatus': link.device = m; renderDetails(); checkUpdated(); renderFirmware(); break;
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

// TripRouteKeeper (free router): arrival at 100 m, reroute when off the route
async function keepRoute() {
  const f = gps.fix;
  if (!nav.active || rerouting || !f) return;
  const line = nav.active.geometry.coordinates;
  const end = line[line.length - 1];
  if (metersBetween(f.lat, f.lon, nav.active.latitude, nav.active.longitude) < 100 ||
      metersBetween(f.lat, f.lon, end[1], end[0]) < 100) {
    nav.active = null; status('Arrived · route updates off', 'ok'); return;
  }
  if (!detector.offer(distanceToLine(f.lat, f.lon, line), f.acc, Date.now())) return;
  rerouting = true;
  try {
    const rs = await osrm({ lat: f.lat, lon: f.lon }, nav.dest);
    const pick = rs.find((r) => !usesToll(r)) || rs[0];
    if (!pick || !nav.active) return;
    const l = await withRouteId(osrmRouteLine(pick, nav.dest));
    nav.active = l; nav.line = l; store.set('route', l);
    detector.routeReplaced(Date.now());
    await sendRouteLine(l);
    drawRoutes([{ r: pick, toll: usesToll(pick) }], 0);
    status(`Rerouted · ETA ${Math.ceil(pick.duration / 60)} min`, 'ok');
  } catch (e) { status('Reroute failed: ' + e.message, 'bad'); }
  finally { rerouting = false; }
}

// ---------- map ----------
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([-6.9147, 107.6098], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
let meMarker = null, followed = false, destMarker = null, routeLayers = [];
function drawMe() {
  const f = gps.fix;
  if (!f) return;
  if (!meMarker) meMarker = L.marker([f.lat, f.lon], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [22, 22] }), interactive: false }).addTo(map);
  else meMarker.setLatLng([f.lat, f.lon]);
  if (!followed) { followed = true; map.setView([f.lat, f.lon], 15); }
}
function drawRoutes(list, sel) {
  routeLayers.forEach((l) => l.remove());
  routeLayers = [];
  list.forEach(({ r }, i) => {
    if (i === sel) return;
    routeLayers.push(L.polyline(r.geometry.coordinates.map(([x, y]) => [y, x]), { color: '#8a93a3', weight: 5, opacity: 0.7 })
      .on('click', () => selectRoute(i)).addTo(map));
  });
  const s = list[sel];
  if (s) {
    const pl = L.polyline(s.r.geometry.coordinates.map(([x, y]) => [y, x]), { color: s.toll ? '#ff6b6b' : '#4c8dff', weight: 7 }).addTo(map);
    routeLayers.push(pl);
  }
}
map.on('contextmenu', (e) => setDestination({ name: 'Dropped pin', lat: e.latlng.lat, lon: e.latlng.lng }));

// ---------- destination, search and routes ----------
const nav = { dest: null, choices: [], sel: 0, line: store.get('route', null), active: null };

async function search() {
  const q = $('q').value.trim();
  if (q.length < 3) return;
  $('q').blur();
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.search = new URLSearchParams({ q, format: 'jsonv2', limit: '6', countrycodes: 'id', 'accept-language': 'en' });
  const c = map.getCenter();
  u.searchParams.set('viewbox', `${c.lng - 0.5},${c.lat + 0.5},${c.lng + 0.5},${c.lat - 0.5}`);
  try {
    const found = await fetch(u).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    const list = $('results');
    list.innerHTML = '';
    if (!found.length) status('Nothing found', 'bad');
    for (const p of found) {
      const name = p.name || p.display_name.split(',')[0];
      list.appendChild(resultButton(name, p.display_name, () => { list.innerHTML = ''; setDestination({ name, lat: +p.lat, lon: +p.lon }); }));
    }
  } catch (e) { status('Search failed: ' + e.message, 'bad'); }
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

async function osrm(from, to) {
  const u = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}` +
    '?overview=full&geometries=geojson&steps=true&alternatives=3';
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.code !== 'Ok') throw new Error(j.message || j.code || `HTTP ${r.status}`);
  return j.routes || [];
}

async function setDestination(d) {
  nav.dest = d;
  $('q').value = d.name;
  $('destName').textContent = d.name;
  $('destInfo').textContent = 'Planning the route…';
  $('routes').innerHTML = '';
  $('destBox').hidden = false;
  if (destMarker) destMarker.remove();
  destMarker = L.marker([d.lat, d.lon]).addTo(map);
  render();
  // a pending permission prompt never times out on its own: give up after 20 s
  const from = gps.fix || await new Promise((res) => {
    setTimeout(() => res(null), 20000);
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }), () => res(null),
      { enableHighAccuracy: true, timeout: 15000 });
  });
  if (!from) { $('destInfo').textContent = 'Location unavailable: allow location for this page.'; return; }
  try {
    nav.choices = (await osrm(from, d)).map((r) => ({ r, toll: usesToll(r) })).sort((a, b) => a.toll - b.toll);
    nav.sel = 0;
    if (!nav.choices.length) { $('destInfo').textContent = 'No route found'; return; }
    $('destInfo').textContent = nav.choices.every((c) => c.toll) ? 'Every route found uses a toll road' : 'No live traffic: times assume empty roads';
    renderChoices();
    map.fitBounds(L.polyline(nav.choices[0].r.geometry.coordinates.map(([x, y]) => [y, x])).getBounds(), { paddingTopLeft: [30, 90], paddingBottomRight: [30, document.querySelector('.sheet').offsetHeight + 20] });
  } catch (e) { $('destInfo').textContent = 'Route failed: ' + e.message; }
  render();
}
function renderChoices() {
  const box = $('routes');
  box.innerHTML = '';
  nav.choices.forEach(({ r, toll }, i) => {
    const b = resultButton(`Route ${i + 1}: ${Math.round(r.duration / 60)} min${toll ? '. Uses a toll road, not for motorbikes' : ''}`,
      `${(r.distance / 1000).toFixed(1)} km`, () => selectRoute(i));
    if (i === nav.sel) b.classList.add('sel');
    if (toll) b.classList.add('toll');
    box.appendChild(b);
  });
  drawRoutes(nav.choices, nav.sel);
}
function selectRoute(i) { nav.sel = i; renderChoices(); }

async function sendSelected(simulation) {
  if (!linked()) { status('Connect the cluster to send this route.', 'warn'); return; }
  const c = nav.choices[nav.sel];
  if (!c) return;
  const line = osrmRouteLine(c.r, nav.dest);
  line.simulation = simulation;
  const l = await withRouteId(line);
  try {
    await sendLine({ type: 'destination', name: l.name, latitude: l.latitude, longitude: l.longitude });
    await sendRouteLine(l);
    nav.line = l; store.set('route', l);
    nav.active = simulation ? null : l;
    detector.startTrip(Date.now());
    status(simulation ? 'Simulation requested · send the route again to return to real GPS'
      : `Route sent · ${gps.sharing ? 'phone GPS sharing stays on' : 'phone GPS sharing stays off'}`, 'ok');
  } catch (e) { status('Could not send the route: ' + e.message, 'bad'); }
  render();
}
async function sendRouteLine(l) {
  status('Sending the route…');
  await sendLine(l);
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
    card.className = 'card';
    card.innerHTML = '<b></b><div class="dim"></div><div class="row"><button>Drive here</button><button class="secondary">Rename</button><button class="danger">Delete</button></div>';
    card.querySelector('b').textContent = p.name;
    card.querySelector('.dim').textContent = `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;
    const [go, ren, del] = card.querySelectorAll('button');
    go.onclick = () => { closePages(); setDestination({ name: p.name, lat: p.latitude, lon: p.longitude }); };
    ren.onclick = () => askName('Rename place', p.name, (n) => { const a = saved(); a[i].name = n; store.set('saved', a); renderSaved(); });
    del.onclick = () => confirmBox(`Delete "${p.name}"?`, 'Delete', () => { const a = saved(); a.splice(i, 1); store.set('saved', a); renderSaved(); });
    list.appendChild(card);
  });
}
function saveCurrent() {
  if (!nav.dest) return;
  if (saved().length >= 50) { status('Save up to 50 places.', 'bad'); return; }
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
  $('lblSim').textContent = `Simulation max speed ${appearance.simulationSpeedKph} km/h`;
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
  $('btnFwInstall').disabled = !can || !linked() || !link.ota || fw.running;
  if (linked() && !link.ota) $('fwInstalled').textContent += '. This cluster has no update channel.';
}

$('fwFile').onchange = async (e) => {
  const f = e.target.files[0];
  fw.image = null; fw.desc = null;
  if (f) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const d = appDesc(bytes);
    if (!d) { status('Not an ESP32 firmware image', 'bad'); }
    else { fw.image = bytes; fw.desc = d; fw.name = f.name; fw.target = d.project === 'updater' ? 'updater' : 'app'; }
  }
  renderFirmware();
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
$('btnFwCancel').onclick = () => { if (fw.sender && fw.running) fw.sender.fail('Cancelled'); };

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

// ---------- pages, dialogs ----------
const stack = [];
function openPage(id) { $(id).hidden = false; stack.push(id); if (id === 'pgSaved') renderSaved(); if (id === 'pgDetails') renderDetails(); if (id === 'pgFirmware') renderFirmware(); if (id === 'pgAppearance' || id === 'pgDebug') renderAppearance(); render(); }
function closePages() { while (stack.length) $(stack.pop()).hidden = true; }
document.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => { const id = stack.pop(); if (id) $(id).hidden = true; }));
document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openPage(b.dataset.open)));
function modal(build) {
  const body = $('modalBody');
  body.innerHTML = '';
  build(body, () => { $('modal').hidden = true; });
  $('modal').hidden = false;
}
function confirmBox(text, okLabel, ok) {
  modal((b, close) => {
    b.innerHTML = '<div style="font-size:17px"></div><button></button><button class="secondary">Cancel</button>';
    b.firstChild.textContent = text;
    const [y, n] = b.querySelectorAll('button');
    y.textContent = okLabel; y.onclick = () => { close(); ok(); };
    n.onclick = close;
  });
}
function askName(title, value, ok) {
  modal((b, close) => {
    b.innerHTML = '<b></b><input maxlength="80"><div class="dim"></div><button>Save</button><button class="secondary">Cancel</button>';
    b.querySelector('b').textContent = title;
    const inp = b.querySelector('input'); inp.value = value;
    const [y, n] = b.querySelectorAll('button');
    y.onclick = () => { const v = inp.value.trim(); if (v.length < 1 || v.length > 80) { b.querySelector('.dim').textContent = 'Use a name between 1 and 80 characters.'; return; } close(); ok(v); };
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
    ['Phone GPS sharing', gps.sharing ? 'On' : 'Off'],
    ['Last route', link.routeAck || '-'],
    ['Web app', VERSION],
  ];
  $('details').innerHTML = '';
  for (const [k, v] of rows) { const a = document.createElement('span'); a.textContent = k; const b = document.createElement('span'); b.textContent = v; $('details').append(a, b); }
}

async function render() {
  const reg = !!(await kv('bikePub'));
  const on = !!(link.dev && link.dev.gatt.connected);
  $('btnLink').textContent = on ? 'Disconnect cluster' : (reg ? 'Connect cluster' : 'Register this iPhone');
  $('btnLink').className = on && link.authed ? 'on' : '';
  $('btnGps').textContent = gps.sharing ? 'GPS sharing on' : 'Share GPS';
  $('btnGps').className = gps.sharing ? 'on' : 'secondary';
  $('btnGps').disabled = !linked();
  $('btnSend').disabled = !linked() || !nav.choices.length;
  $('btnStop').hidden = !(linked() && nav.line);
  $('btnSimulate').disabled = !nav.choices.length || !linked();
  $('simHint').hidden = nav.choices.length > 0;
  $('pairState').textContent = reg ? 'This phone is registered with a cluster.' : 'Not registered yet.';
  if (stack.includes('pgDetails')) renderDetails();
}

// ---------- wiring ----------
$('btnMenu').onclick = () => openPage('pgSettings');
$('btnMe').onclick = () => { if (gps.fix) map.setView([gps.fix.lat, gps.fix.lon], 16); };
$('q').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
$('btnLink').onclick = async () => {
  if (link.dev && link.dev.gatt.connected) { if (gps.sharing) await setSharing(false); link.dev.gatt.disconnect(); return; }
  connect(false);
};
$('btnGps').onclick = () => setSharing(!gps.sharing);
$('btnSend').onclick = () => sendSelected(false);
$('btnSave').onclick = saveCurrent;
$('btnClear').onclick = () => { nav.dest = null; nav.choices = []; $('destBox').hidden = true; $('q').value = ''; drawRoutes([], 0); if (destMarker) destMarker.remove(); render(); };
$('btnStop').onclick = async () => {
  await sendLine({ type: 'stop' }).catch(() => {});
  nav.line = null; nav.active = null; store.set('route', null);
  status('Navigation stopped', 'ok'); render();
};
$('btnRegister').onclick = () => { closePages(); connect(true); };
$('btnForget').onclick = () => confirmBox('Erase this phone\'s pairing data? You will need to register again.', 'Erase', async () => {
  await kv('bikePub', null); await kv('phoneKey', null); log('Pairing data erased'); render();
});
$('btnPreviewMode').onclick = () => { previewDay = !previewDay; renderAppearance(); };
$('slRoad').oninput = (e) => { appearance[previewDay ? 'dayRoad' : 'nightRoad'] = +e.target.value; renderAppearance(); };
$('slTerrain').oninput = (e) => { appearance[previewDay ? 'dayTerrain' : 'nightTerrain'] = +e.target.value; renderAppearance(); };
$('slRoad').onchange = $('slTerrain').onchange = saveAppearance;
$('btnResetMode').onclick = () => {
  const D = APPEARANCE_DEFAULTS;
  if (previewDay) Object.assign(appearance, { dayRoad: D.dayRoad, dayTerrain: D.dayTerrain });
  else Object.assign(appearance, { nightRoad: D.nightRoad, nightTerrain: D.nightTerrain });
  renderAppearance(); saveAppearance();
};
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

$('ver').textContent = 'Web version ' + VERSION;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!navigator.bluetooth) status('No Bluetooth in this browser. Open this page in Bluefy.', 'bad');
if (navigator.geolocation) startWatch();
render();
