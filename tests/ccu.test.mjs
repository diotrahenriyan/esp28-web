// CCU decoder (ccu.js): node tests/ccu.test.mjs
import assert from 'node:assert/strict';
import { CcuFields, liveFrame, identityFrame, loginFrame, demoValues, DEMO_ID, checksum, withChecksum, LIVE_LEN,
  captureLine, validPhoneId, N } from '../ccu.js';

let n = 0;
const t = (name, f) => { f(); n++; console.log('PASS', name); };

t('live block is 33 bytes (CCU Live)', () => assert.equal(LIVE_LEN, 33));
t('checksum: bytes plus checksum sum to 0 mod 256', () => {
  const f = withChecksum([0x55, 1, 2, 3]); assert.equal(f.reduce((a, b) => a + b, 0) % 256, 0);
});
t('live frame round trip', () => {
  const v = { ...demoValues(0), rpm: 7350, thr: 41.5, batt: 13.8, eng: 84, iat: 31, map: 52, baro: 92.6, fcnt: 0, dtc: 0, odo: 18420.4 };
  const c = new CcuFields(); assert.ok(c.decode(liveFrame(v)));
  assert.equal(c.get('rpm'), 7350);
  assert.ok(Math.abs(c.get('thr') - 41.5) < 0.5);
  assert.ok(Math.abs(c.get('batt') - 13.8) < 0.08);
  assert.equal(c.get('eng'), 84);
  assert.equal(c.get('L0048'), 18420.4);
  assert.equal(c.warning().level, 'ok');
});
t('known frame decodes exactly like CCU Live (hand-built bytes)', () => {
  // rpm 0x0672 = 1650, batt raw 190 -> 13.92 V, eng raw 115 -> 85 °C
  const d = new Array(33).fill(0); d[0] = 0x06; d[1] = 0x72; d[6] = 190; d[14] = 115;
  const c = new CcuFields(); c.decode(withChecksum([0x55, 1, 0x00, 0x01, 33, ...d]));
  assert.equal(c.get('rpm'), 1650); assert.equal(c.get('batt'), 13.92); assert.equal(c.get('eng'), 85);
});
t('bad checksum counted, not decoded', () => {
  const f = liveFrame(demoValues(1)); f[f.length - 1] ^= 1;
  const c = new CcuFields(); assert.equal(c.decode(f), false); assert.equal(c.get('_bad'), 1); assert.equal(c.get('rpm'), undefined);
});
t('fault shows count and code', () => {
  const c = new CcuFields(); c.decode(liveFrame({ ...demoValues(0), fcnt: 1, dtc: 0x0012 }));
  assert.deepEqual(c.warning(), { level: 'bad', text: '1 engine fault · code 0x0012' });
});
t('identity frame: VIN, model code, ignition count', () => {
  const c = new CcuFields(); c.decode(identityFrame(DEMO_ID));
  assert.equal(c.get('Lf190'), DEMO_ID.vin); assert.equal(c.get('Lf197'), 'DEMO'); assert.equal(c.get('Lf1a2'), 1234);
});
t('login frame', () => {
  const c = new CcuFields(); c.decode(loginFrame(true)); assert.equal(c.get('auth'), 'OK');
  c.decode(loginFrame(false)); assert.equal(c.get('auth'), 'Rejected (0)');
});
t('groups: order, not-fitted hidden', () => {
  const c = new CcuFields(); c.decode(loginFrame(true)); c.decode(liveFrame(demoValues(0))); c.decode(identityFrame(DEMO_ID));
  const g = c.groups(true).map(([x]) => x); assert.deepEqual(g, ['Link', 'Live engine', 'Identity and lifetime']);
  assert.ok(c.groups(true).every(([, rows]) => rows.every((r) => r.status !== N)));
  assert.ok(c.groups(false)[1][1].some((r) => r.status === N));
});
t('capture line format matches CCU Live', () => assert.equal(captureLine(1730900000123, 'abcd'), '1730900000.123 abcd\n'));
t('phone ID check', () => { assert.ok(validPhoneId('0123456789abcdef0123456789abcdef')); assert.ok(!validPhoneId('XYZ')); assert.ok(!validPhoneId('0123456789ABCDEF0123456789ABCDEF')); });
console.log(`all passed (${n})`);
