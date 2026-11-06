// Yamaha Y-Connect CCU (Y08U-A00) data, relayed by the ESP 2.8 cluster.
// Decoder and field table ported from CCU Live v1.0 (yamaha_ccu_debug/web/index.html, 2026-11-06),
// verification status per field as in CAPABILITIES - CCU Live_v1.0.
//
// Relay contract (cluster <-> phone, MUTECH-BLE/2 JSON lines; the cluster implements it in firmware
// 0.1.5, see "SPEC - ESP 2.8 CCU relay_v1.0"):
//   phone -> cluster  {"type":"ccuConfig","phoneId":"<32 hex>"}  store the phone ID the CCU knows ("" erases)
//                     {"type":"ccuLink","on":true|false}          cluster connects to the CCU (kept across restarts)
//                     {"type":"ccuRelay","on":true|false}         forward CCU frames to this phone (off at each connect)
//                     {"type":"ccuQuery"}                         answer with ccuState now
//   cluster -> phone  {"type":"ccuConfig","ok":true,"idSet":true|false}
//                     {"type":"ccuState","state":"off|noId|scanning|connecting|streaming|reconnecting|rejected",
//                      "name":"YSCCU_…","rssi":-60,"frames":n,"heartbeats":n,"reconnects":n,"idSet":true}
//                     {"type":"ccuFrame","t":<cluster ms>,"h":"<the CCU notification in hex, checksum included>"}
// Frames go through unchanged, so the phone's decoder and captures are the same as CCU Live's.

export const CCU_STATES = {
  off: 'Off', noId: 'Phone ID not set', scanning: 'Looking for the CCU', connecting: 'Connecting',
  streaming: 'Streaming', reconnecting: 'Reconnecting', rejected: 'Login rejected',
};

export const ccuConfigLine = (phoneId) => ({ type: 'ccuConfig', phoneId });
export const ccuLinkLine = (on) => ({ type: 'ccuLink', on: !!on });
export const ccuRelayLine = (on) => ({ type: 'ccuRelay', on: !!on });
export const validPhoneId = (s) => /^[0-9a-f]{32}$/.test(s || '');

// verification status of a field
export const V = 'Verified', P = 'Plausible', U = 'Unit unknown', N = 'Not fitted', X = 'Not verified';

// Live engine block (local 0x0001), in wire order: key, label, bytes, scale, unit, status
const s30 = (r) => r - 30;
export const LIVE = [
  ['rpm', 'Engine speed', 2, null, 'rpm', V], ['speed', 'Vehicle speed', 1, null, 'km/h', X],
  ['inj', 'Injection time', 1, null, 'raw', U], ['ign', 'Ignition timing', 1, s30, 'degrees', P],
  ['isc', 'Idle air valve opening', 1, null, 'raw', P], ['batt', 'Battery voltage', 1, (r) => r * 18.75 / 256, 'V', V],
  ['tpsv', 'Throttle sensor voltage', 1, null, 'raw', P], ['thr', 'Throttle opening', 1, (r) => r * 125 / 256, '%', V],
  ['apsv', 'Grip sensor voltage', 1, null, 'raw', N], ['aps', 'Grip opening', 1, null, 'raw', N],
  ['o2a', 'Oxygen sensor voltage', 1, null, 'raw', U], ['o2b', 'Oxygen sensor voltage, bank 2', 1, null, 'raw', N],
  ['lean', 'Lean angle or oil pressure sensor voltage', 1, null, 'raw', N], ['eng', 'Engine temperature', 1, s30, '°C', P],
  ['iat', 'Intake air temperature', 1, s30, '°C', P], ['map', 'Intake pressure', 1, (r) => r * 127 / 256, 'kPa', V],
  ['map2', 'Intake pressure 2', 1, null, 'raw', N], ['baro', 'Atmospheric pressure', 1, (r) => r * 127 / 256, 'kPa', V],
  ['gear', 'Gear or neutral switch', 1, null, 'raw', N], ['mode', 'Drive mode', 1, null, 'raw', N],
  ['sw', 'Switch inputs', 1, null, 'hex', U], ['o2fb', 'Oxygen feedback correction', 1, null, 'raw', U],
  ['fcnt', 'Fault count', 1, null, 'count', P], ['dtc', 'Fault code', 2, null, 'hex', P],
  ['fsys', 'Fuel system status', 1, null, 'raw', U], ['load', 'Engine load', 1, null, 'raw', U],
  ['sec', 'Secondary air command', 1, null, 'raw', N], ['st1', 'Fuel trim, short term', 1, null, 'raw', U],
  ['lt1', 'Fuel trim, long term', 1, null, 'raw', U], ['st2', 'Fuel trim, short term, bank 2', 1, null, 'raw', N],
  ['lt2', 'Fuel trim, long term, bank 2', 1, null, 'raw', N],
];
export const LIVE_LEN = LIVE.reduce((n, f) => n + f[2], 0);   // 33

// other locals: label, unit, status
export const LOCALS = {
  '0048': ['Odometer', 'km', V], '020a': ['Start switch and battery block', 'hex', U],
  '0216': ['Idle target and traction block', 'hex', U], '023a': ['Engine warning lamp (blink, on)', 'hex', P],
  '023e': ['Injection counter', 'count', U], '0245': ['Gear position', 'hex', N],
  'f190': ['VIN', 'text', V], 'f194': ['ECU software number', 'hex', V], 'f197': ['Model code', 'text', V],
  'f1a1': ['ECU powered time', 'raw', U], 'f1a2': ['Ignition-on count', 'count', P],
  'f421': ['Distance since warning lamp', 'raw', P], 'f44d': ['Engine time since warning lamp', 'raw', P],
  'f701': ['Cumulative injection', 'raw', U], 'f702': ['Lifetime distance', 'raw', U],
  'ff67': ['Lifetime statistics, distance', 'hex', V],
};
export const GROUPS = { 0x55: 'Live engine', 0x56: 'Engine status', 0x5b: 'Identity and lifetime', 0x59: 'Statistics (raw)', 0x5a: 'Link' };
export const GROUP_ORDER = ['Link', 'Live engine', 'Engine status', 'Identity and lifetime', 'Statistics (raw)'];

const hx = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const be = (a) => a.reduce((n, b) => n * 256 + b, 0);
export const checksum = (bytes) => { let s = 0; for (const x of bytes) s += x; return (256 - (s & 255)) & 255; };
export const withChecksum = (bytes) => Uint8Array.from([...bytes, checksum(bytes)]);

// Field store: key -> { group, label, value, unit, raw, status, min, max, n }
export class CcuFields {
  constructor() { this.rows = new Map(); this.frames = 0; this.bad = 0; }
  clear() { this.rows.clear(); this.frames = 0; this.bad = 0; }
  get(key) { const r = this.rows.get(key); return r ? r.value : undefined; }
  put(key, group, label, value, unit, raw, status) {
    let r = this.rows.get(key);
    if (!r) { r = { group, label, unit, status, min: null, max: null, n: 0 }; this.rows.set(key, r); }
    r.value = value; r.raw = raw; r.n++;
    if (typeof value === 'number') { r.min = r.min === null ? value : Math.min(r.min, value); r.max = r.max === null ? value : Math.max(r.max, value); }
  }
  // one CCU notification (bytes, checksum last)
  decode(b) {
    this.frames++;
    if (b.length < 4) return false;
    if (checksum(b.subarray(0, b.length - 1)) !== b[b.length - 1]) {
      this.bad++; this.put('_bad', 'Link', 'Checksum errors', this.bad, 'count', '', P); return false;
    }
    const mid = b[0], g = GROUPS[mid] || 'Message 0x' + mid.toString(16);
    if (mid === 0x5a) { this.put('auth', 'Link', 'Login', b[5] === 1 ? 'OK' : `Rejected (${b[5]})`, '', hx(b), V); return true; }
    let p = 2;
    for (let k = 0; k < b[1]; k++) {
      if (p + 3 > b.length - 1) break;
      const lid = hx(b.subarray(p, p + 2)), L = b[p + 2], d = b.subarray(p + 3, p + 3 + L);
      p += 3 + L;
      if (lid === '0001' && L >= LIVE_LEN) {
        let i = 0;
        for (const [key, label, n, sc, unit, st] of LIVE) {
          const r = be(d.subarray(i, i + n)); i += n;
          const val = unit === 'hex' ? '0x' + r.toString(16).padStart(2 * n, '0') : (sc ? Math.round(sc(r) * 100) / 100 : r);
          this.put(key, g, label, val, unit, r, st);
        }
        continue;
      }
      const [lab, unit, st] = LOCALS[lid] || ['Local 0x' + lid, 'hex', U];
      const n = be(d);
      let val;
      if (lid === '0048') val = n / 10;
      else if (unit === 'text') val = new TextDecoder().decode(d);
      else if ((unit === 'raw' || unit === 'count') && L <= 4) val = n;
      else val = hx(d);
      this.put('L' + lid, lid === '0048' ? 'Live engine' : g, lab, val, unit, hx(d), st);
    }
    return true;
  }
  // rows grouped in display order; hideNotFitted drops fields this bike does not have
  groups(hideNotFitted = true) {
    const out = {};
    for (const r of this.rows.values()) { if (hideNotFitted && r.status === N) continue; (out[r.group] = out[r.group] || []).push(r); }
    return [...GROUP_ORDER, ...Object.keys(out).filter((g) => !GROUP_ORDER.includes(g))].filter((g) => out[g]).map((g) => [g, out[g]]);
  }
  // engine warning: { level: 'ok'|'bad'|'unknown', text }
  warning() {
    const cnt = this.get('fcnt'), code = this.get('dtc');
    if (cnt === undefined) return { level: 'unknown', text: 'Fault status not read yet' };
    if (cnt > 0) return { level: 'bad', text: `${cnt} engine fault${cnt > 1 ? 's' : ''} · code ${code}` };
    return { level: 'ok', text: 'No fault codes' };
  }
}

// capture line, same format as CCU Live and decode_log.py: "<seconds> <hex>\n"
export const captureLine = (ms, h) => `${(ms / 1000).toFixed(3)} ${h}\n`;

// ---- synthetic frames: tests and the demo stream (no real bike data) ----
function liveBytes(v) {
  const raw = {
    rpm: v.rpm, speed: v.speed, inj: 40, ign: v.ign + 30, isc: 22, batt: Math.round(v.batt * 256 / 18.75), tpsv: 51,
    thr: Math.round(v.thr * 256 / 125), apsv: 0, aps: 0, o2a: 90, o2b: 0, lean: 0, eng: v.eng + 30, iat: v.iat + 30,
    map: Math.round(v.map * 256 / 127), map2: 0, baro: Math.round(v.baro * 256 / 127), gear: 0, mode: 0, sw: 0x10,
    o2fb: 128, fcnt: v.fcnt, dtc: v.dtc, fsys: 2, load: 30, sec: 0, st1: 128, lt1: 128, st2: 0, lt2: 0,
  };
  const out = [];
  for (const [key, , n] of LIVE) { const x = raw[key] >>> 0; if (n === 2) out.push((x >> 8) & 255, x & 255); else out.push(x & 255); }
  return out;
}
export function liveFrame(v) {
  const d = liveBytes(v), odo = Math.round(v.odo * 10);
  return withChecksum([0x55, 2, 0x00, 0x01, d.length, ...d, 0x00, 0x48, 4, (odo >>> 24) & 255, (odo >> 16) & 255, (odo >> 8) & 255, odo & 255]);
}
export function identityFrame(id) {
  const t = (s) => [...new TextEncoder().encode(s)];
  const vin = t(id.vin), model = t(id.model);
  const u32 = (x) => [(x >>> 24) & 255, (x >> 16) & 255, (x >> 8) & 255, x & 255];
  return withChecksum([0x5b, 4, 0xf1, 0x90, vin.length, ...vin, 0xf1, 0x97, model.length, ...model,
    0xf1, 0x94, 4, 0x12, 0x34, 0x56, 0x78, 0xf1, 0xa2, 4, ...u32(id.ignitions)]);
}
export const loginFrame = (ok) => withChecksum([0x5a, 1, 0x7f, 0x00, 1, ok ? 1 : 0]);

// demo values at time t (seconds): idle, a short blip, warming engine
export function demoValues(t) {
  const blip = Math.max(0, Math.sin(t / 3)) ** 4;
  return { rpm: Math.round(1650 + 5200 * blip + 40 * Math.sin(t * 7)), speed: 0, thr: Math.round(blip * 62 * 10) / 10,
    ign: 12 + Math.round(18 * blip), batt: 13.9 - 0.3 * blip, eng: Math.min(88, 52 + Math.round(t / 4)), iat: 33,
    map: 36 + 50 * blip, baro: 92.6, fcnt: 0, dtc: 0, odo: 18420.4 };
}
export const DEMO_ID = { vin: 'DEMO0000000000000', model: 'DEMO', ignitions: 1234 };
