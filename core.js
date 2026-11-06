// Pure parts of the ESP 2.8 web companion: hex, the MUTECH-BLE/2 auth texts, the line
// assembler, nav lines and the Google Routes -> cluster route conversion.
// Wire contract: speedo-idf/main/ble_link_proto.h and companion-app/contract/nav_lines.tsv.

export const PROTOCOL = 'MUTECH-BLE/2';
export const SVC = '6d757465-6368-4c4e-4b00-000000000001';
export const RX = '6d757465-6368-4c4e-4b00-000000000002';
export const TX = '6d757465-6368-4c4e-4b00-000000000003';
export const DEVICE_NAME = 'ESP 2.8 Cluster';
export const CHUNK = 180;                 // bytes per GATT write (MTU 185 on iPhone, minus 3, margin)
export const LINE_MAX = 256 * 1024;       // the cluster drops longer lines (BLE build)

export const toHex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h) {
  if (typeof h !== 'string' || h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// "MUTECH-BLE/2|role|<bike nonce>|<phone nonce>" (the bike nonce as received)
export const authText = (role, bikeNonce, phoneNonce) => `${PROTOCOL}|${role}|${bikeNonce}|${phoneNonce}`;

// Notifications arrive in pieces; complete lines come out (CR dropped, empty lines skipped).
export class LineAssembler {
  constructor(onLine) { this.buf = ''; this.onLine = onLine; this.dec = new TextDecoder(); }
  feed(bytes) {
    this.buf += this.dec.decode(bytes, { stream: true });
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line.length) this.onLine(line);
    }
    if (this.buf.length > LINE_MAX) this.buf = '';
  }
}

export function chunks(bytes, size = CHUNK) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

// ---- nav lines (nav_lines.tsv) ----
const r5 = (x) => Math.round(x * 1e5) / 1e5;

export function locationLine(c, ts) {
  const o = { type: 'location', latitude: c.latitude, longitude: c.longitude,
    accuracyMeters: Math.max(0, c.accuracy || 0), timestampMillis: Math.round(ts) };
  if (Number.isFinite(c.speed) && c.speed >= 0) o.speedMetersPerSecond = c.speed;
  if (Number.isFinite(c.heading)) o.bearingDegrees = c.heading;
  return o;
}

// Google encoded polyline -> [[lon, lat], ...]
export function decodePolyline(s) {
  const pts = [];
  let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (const k of [0, 1]) {
      let shift = 0, res = 0, b;
      do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([r5(lon / 1e5), r5(lat / 1e5)]);
  }
  return pts;
}

// Google Routes maneuver -> the Mapbox-style type / modifier the cluster draws (ui_portrait.c)
const MAN = {
  DEPART: ['depart'], STRAIGHT: ['continue', 'straight'], NAME_CHANGE: ['new name', 'straight'],
  TURN_LEFT: ['turn', 'left'], TURN_RIGHT: ['turn', 'right'],
  TURN_SLIGHT_LEFT: ['turn', 'slight left'], TURN_SLIGHT_RIGHT: ['turn', 'slight right'],
  TURN_SHARP_LEFT: ['turn', 'sharp left'], TURN_SHARP_RIGHT: ['turn', 'sharp right'],
  UTURN_LEFT: ['turn', 'uturn'], UTURN_RIGHT: ['turn', 'uturn'],
  RAMP_LEFT: ['on ramp', 'left'], RAMP_RIGHT: ['on ramp', 'right'],
  FORK_LEFT: ['fork', 'left'], FORK_RIGHT: ['fork', 'right'], MERGE: ['merge', 'straight'],
  ROUNDABOUT_LEFT: ['roundabout', 'left'], ROUNDABOUT_RIGHT: ['roundabout', 'right'],
  FERRY: ['notification', 'straight'], FERRY_TRAIN: ['notification', 'straight'],
};
const secs = (d) => (typeof d === 'string' ? parseFloat(d) : 0) || 0;

// One Google route (computeRoutes, see FIELD_MASK) -> the cluster's "route" line object.
export function routeLine(g, dest) {
  const geometry = decodePolyline(g.polyline.encodedPolyline);
  const steps = [];
  const gsteps = (g.legs || []).flatMap((l) => l.steps || []);
  gsteps.forEach((s, idx) => {
    const ni = s.navigationInstruction || {};
    const [type, modifier] = MAN[ni.maneuver] || (idx === 0 ? ['depart'] : ['continue', 'straight']);
    const ll = s.startLocation && s.startLocation.latLng;
    const loc = ll ? [r5(ll.longitude), r5(ll.latitude)] : decodePolyline(s.polyline.encodedPolyline)[0];
    const m = { type: idx === 0 ? 'depart' : type, location: loc, instruction: (ni.instructions || '').slice(0, 120) };
    if (idx !== 0 && modifier) m.modifier = modifier;
    steps.push({ maneuver: m, name: '', distance: s.distanceMeters || 0, duration: secs(s.staticDuration) });
  });
  const end = geometry[geometry.length - 1];
  steps.push({ maneuver: { type: 'arrive', location: end, instruction: 'Arrive at your destination' },
    name: '', distance: 0, duration: 0 });
  const o = { type: 'route', name: (dest.name || 'Destination').slice(0, 60), latitude: dest.lat, longitude: dest.lon,
    distanceMeters: g.distanceMeters || 0, durationSeconds: secs(g.duration), simulation: false,
    geometry: { type: 'LineString', coordinates: geometry }, steps };
  return o;
}

// ---- OpenStreetMap: OSRM route (Mapbox v5 steps, geometries=geojson) -> the cluster's "route" ----
const word = (m) => (m ? m.replace('uturn', 'U-turn').replace(/^slight (\w+)/, 'slightly $1') : '');
function instruction(type, mod, name) {
  const onto = name ? ` onto ${name}` : '';
  switch (type) {
    case 'depart': return `Head out${name ? ` on ${name}` : ''}`;
    case 'arrive': return 'Arrive at your destination';
    case 'turn': case 'end of road': return mod === 'uturn' ? 'Make a U-turn' : `Turn ${word(mod)}${onto}`;
    case 'roundabout': case 'rotary': case 'roundabout turn': return `Take the roundabout${onto}`;
    case 'fork': return `Keep ${word(mod)}${onto}`;
    case 'merge': return `Merge${onto}`;
    case 'on ramp': return `Take the ramp${onto}`;
    case 'off ramp': return `Take the exit${onto}`;
    default: return `Continue${onto}`;
  }
}
export function osrmRouteLine(r, dest) {
  const steps = (r.legs || []).flatMap((l) => l.steps || []).map((s) => {
    const m = s.maneuver;
    const o = { type: m.type, location: [r5(m.location[0]), r5(m.location[1])],
      instruction: instruction(m.type, m.modifier, s.name).slice(0, 120) };
    if (m.modifier) o.modifier = m.modifier;
    const st = { maneuver: o, name: (s.name || '').slice(0, 60), distance: s.distance || 0, duration: s.duration || 0 };
    if (s.driving_side) st.driving_side = s.driving_side;
    return st;
  });
  return { type: 'route', name: (dest.name || 'Destination').slice(0, 60), latitude: dest.lat, longitude: dest.lon,
    distanceMeters: r.distance || 0, durationSeconds: r.duration || 0, simulation: false,
    geometry: { type: 'LineString', coordinates: r.geometry.coordinates.map(([x, y]) => [r5(x), r5(y)]) }, steps };
}

export const FIELD_MASK = [
  'routes.distanceMeters', 'routes.duration', 'routes.polyline.encodedPolyline',
  'routes.legs.steps.distanceMeters', 'routes.legs.steps.staticDuration',
  'routes.legs.steps.polyline.encodedPolyline', 'routes.legs.steps.startLocation',
  'routes.legs.steps.navigationInstruction',
].join(',');

// ---- route identity (RouteIdentity.kt): first 16 bytes of SHA-256 of the line without "routeId" ----
export async function withRouteId(line) {
  const o = { ...line };
  delete o.routeId;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(o)));
  o.routeId = toHex(new Uint8Array(d).slice(0, 16));
  return o;
}

// ---- geometry (RouteGeometry.kt): metres, lines as [[lon, lat], ...] ----
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export function metersBetween(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function distanceToLine(lat, lon, line) {
  if (!line.length) return Infinity;
  if (line.length === 1) return metersBetween(lat, lon, line[0][1], line[0][0]);
  const k = Math.cos(rad(lat));
  const xy = ([x, y]) => [rad(x - lon) * k * R, rad(y - lat) * R];   // local plane around the fix
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = xy(line[i]); const [bx, by] = xy(line[i + 1]);
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// ---- RerouteDetector.kt: 3 accurate fixes > max(50 m, 1.5 x accuracy) off, 30 s grace, 60 s apart, 5 per trip ----
export class RerouteDetector {
  constructor() { this.startTrip(0); }
  startTrip(now) { this.count = 0; this.last = null; this.streak = 0; this.grace = now; }
  routeReplaced(now) { this.streak = 0; this.grace = now; }
  offer(dist, acc, now) {
    if (acc > 30) return false;
    if (dist > Math.max(50, 1.5 * acc)) this.streak++; else { this.streak = 0; return false; }
    if (this.streak < 3 || this.count >= 5) return false;
    if (now - this.grace < 30000) return false;
    if (this.last !== null && now - this.last < 60000) return false;
    this.count++; this.last = now; this.streak = 0;
    return true;
  }
}

// ---- MapAppearance.kt ----
export const APPEARANCE_DEFAULTS = { dayRoad: 62, dayTerrain: 88, nightRoad: 82, nightTerrain: 16, simulationSpeedKph: 20, clusterThemeMode: 0 };
export function appearanceLine(a) {
  const c = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const D = APPEARANCE_DEFAULTS;
  return { type: 'mapAppearance', dayRoad: c(a.dayRoad, 0, 100, D.dayRoad), dayTerrain: c(a.dayTerrain, 0, 100, D.dayTerrain),
    nightRoad: c(a.nightRoad, 0, 100, D.nightRoad), nightTerrain: c(a.nightTerrain, 0, 100, D.nightTerrain),
    simulationSpeedKph: c(a.simulationSpeedKph, 5, 300, D.simulationSpeedKph),
    clusterThemeMode: [0, 1, 2].includes(a.clusterThemeMode) ? a.clusterThemeMode : 0 };
}

// Indonesian toll roads are named "Jalan Tol ..."; OSRM classes when the server sends them
export function usesToll(r) {
  return (r.legs || []).some((l) => (l.steps || []).some((st) => /\btol\b/i.test(st.name || '') ||
    (st.intersections || []).some((x) => (x.classes || []).some((c) => c === 'toll' || c === 'motorway'))));
}

// ---- firmware update over BLE (ota_proto.h, FirmwareUpdate.kt) ----
export const OTA = '6d757465-6368-4c4e-4b00-000000000004';
export const OTA_MAX = { app: 0x300000, updater: 0x180000 };
export const OTA_PAYLOAD = 176;   // frame 180 bytes: fits the iPhone's ATT MTU (185) minus 3

// esp_app_desc_t at 0x20 of an ESP-IDF image: version, project name, build date, ELF SHA-256
export function appDesc(bytes) {
  if (bytes.length < 0x20 + 176 || bytes[0] !== 0xe9) return null;
  const d = new DataView(bytes.buffer, bytes.byteOffset + 0x20, 176);
  if (d.getUint32(0, true) !== 0xabcd5432) return null;
  const str = (o, n) => new TextDecoder().decode(bytes.subarray(0x20 + o, 0x20 + o + n)).replace(/\0.*$/s, '');
  return { version: str(16, 32), project: str(48, 32), time: str(80, 16), date: str(96, 16),
    build: toHex(bytes.subarray(0x20 + 144, 0x20 + 152)) };
}

// the cluster's build id (9 or 16 hex) is a prefix of the image's (UpdateCheck.buildMatches)
export const buildMatches = (board, image) => {
  const b = (board || '').trim().toLowerCase(), m = (image || '').trim().toLowerCase();
  return b.length >= 9 && b.length <= m.length && /^[0-9a-f]+$/.test(b) && m.startsWith(b);
};
export const plainVersion = (v) => { const t = (v || '').trim(); return /^v\d/.test(t) ? t.slice(1) : t; };

// UpdateCheck.decide: 'update' | 'rebuild' | 'current' | 'unknown'
export function otaDecide(desc, target, status) {
  if (!status) return 'unknown';
  if (target === 'updater') return plainVersion(status.updaterVersion) === plainVersion(desc.version) ? 'current' : 'update';
  const v = plainVersion(status.clusterVersion);
  if (!v) return 'unknown';
  if (v !== plainVersion(desc.version)) return 'update';
  if (status.build && desc.build && !buildMatches(status.build, desc.build)) return 'rebuild';
  return 'current';
}

export function otaFrame(data, offset, payload) {
  const len = Math.min(payload, data.length - offset);
  const f = new Uint8Array(4 + len);
  new DataView(f.buffer).setUint32(0, offset, true);
  f.set(data.subarray(offset, offset + len), 4);
  return f;
}

// OtaSender (FirmwareUpdate.kt): window from otaReady, progress / retry acks, stall resend, timeouts
export class OtaSender {
  constructor(data, payload = OTA_PAYLOAD) {
    Object.assign(this, { data, payload, state: 'waitReady', error: null, sent: 0, acked: 0, window: 0,
      startedAt: 0, lastAckAt: 0, endSentAt: 0, endSent: false });
  }
  start(now) { this.startedAt = now; this.lastAckAt = now; }
  percent() { return Math.max(0, Math.min(100, Math.floor((this.acked * 100) / this.data.length))); }
  nextFrame() {
    if (this.state !== 'sending' || this.sent >= this.data.length) return null;
    const len = Math.min(this.payload, this.data.length - this.sent);
    if (this.sent - this.acked + len > this.window) return null;
    const f = otaFrame(this.data, this.sent, this.payload);
    this.sent += len;
    return f;
  }
  endDue() { return this.state === 'sending' && this.acked >= this.data.length && !this.endSent; }
  markEndSent(now) { if (!this.endDue()) return; this.endSent = true; this.endSentAt = now; this.lastAckAt = now; this.state = 'waitDone'; }
  onMessage(m, now) {
    if (m.type === 'otaReady') {
      if (this.state !== 'waitReady') return;
      if (!(m.window >= this.payload)) return this.fail("The cluster's transfer window is too small");
      this.window = m.window; this.state = 'sending'; this.lastAckAt = now;
    } else if (m.type === 'otaAck') {
      if (this.state !== 'sending' && this.state !== 'waitDone') return;
      const x = m.offset;
      if (!(x >= 0) || x > this.sent) return;
      if (m.retry) { this.sent = x; this.acked = Math.min(this.acked, x); this.lastAckAt = now; this.endSent = false; this.state = 'sending'; }
      else if (x > this.acked) { this.acked = x; this.lastAckAt = now; }
    } else if (m.type === 'otaDone') {
      if (this.state === 'waitDone') this.state = 'done'; else if (this.state !== 'done') this.fail('Unexpected reply from the cluster');
    } else if (m.type === 'otaError') this.fail(m.text || 'The cluster refused the update');
  }
  tick(now) {
    if (this.state === 'waitReady' && now - this.startedAt > 10000) this.fail('The cluster did not accept the update');
    else if (this.state === 'sending') {
      if (now - this.lastAckAt > 20000) { this.fail('The cluster stopped answering'); return; }
      const len = Math.min(this.payload, this.data.length - this.sent);
      if (this.sent < this.data.length && this.sent - this.acked + len > this.window && now - this.lastAckAt > 4000) { this.sent = this.acked; this.lastAckAt = now; }
    } else if (this.state === 'waitDone' && now - this.endSentAt > 120000) this.fail('The cluster did not finish the update');
  }
  fail(reason) { if (this.state === 'done' || this.state === 'failed') return; this.state = 'failed'; this.error = reason; }
}
