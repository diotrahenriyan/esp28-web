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

export const FIELD_MASK = [
  'routes.distanceMeters', 'routes.duration', 'routes.polyline.encodedPolyline',
  'routes.legs.steps.distanceMeters', 'routes.legs.steps.staticDuration',
  'routes.legs.steps.polyline.encodedPolyline', 'routes.legs.steps.startLocation',
  'routes.legs.steps.navigationInstruction',
].join(',');
