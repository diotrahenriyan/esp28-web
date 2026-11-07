// Firmware versions, channels, manifest shape and image checks (core.js, TRD §14.2, §14.4, §14.5): node tests/fw-version.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVersion, compareVersion, channelOf, checkManifest, checkImage, IMAGE_REASONS, OTA_MAX } from '../core.js';
import { fakeImage, manifestOf } from './fake-image.mjs';

const table = JSON.parse(readFileSync(new URL('./fw-versions.json', import.meta.url)));
let n = 0;
const t = async (name, f) => { await f(); n++; console.log('PASS', name); };

await t('TRD §14.4 table: channel and trial of every valid version', () => {
  for (const r of table.valid) { const p = parseVersion(r.v); assert.ok(p, r.v); assert.equal(channelOf(r.v), r.channel, r.v); assert.equal(p.trial, r.trial, r.v); }
});
await t('unparseable versions rejected (older naming, empty tag, tag ending in t, upper case)', () => {
  for (const v of table.invalid) { assert.equal(parseVersion(v), null, v); assert.equal(channelOf(v), null, v); }
});
await t('order table (compareVersion), symmetric', () => {
  for (const [a, b, r] of table.order) { assert.equal(compareVersion(a, b), r, `${a} vs ${b}`); assert.equal(compareVersion(b, a), r === null ? null : -r || 0, `${b} vs ${a}`); }
});
await t('2.8-0.1.7-fzt1 < 2.8-0.1.7-fz', () => assert.equal(compareVersion('2.8-0.1.7-fzt1', '2.8-0.1.7-fz'), -1));
await t('2.8-0.1.6-fz < 2.8-0.1.7-fzt1', () => assert.equal(compareVersion('2.8-0.1.6-fz', '2.8-0.1.7-fzt1'), -1));
await t('more than 15 characters rejected', () => {
  assert.equal('2.8-0.1.7-fzt12'.length, 15); assert.ok(parseVersion('2.8-0.1.7-fzt12'));
  assert.equal(parseVersion('2.8-0.1.7-fzt123'), null); assert.equal(parseVersion('2.8-1000.100.100'), null);
});
await t('main and fz are never compared', () => {
  assert.equal(compareVersion('2.8-0.1.4', '2.8-0.1.7-fz'), null); assert.equal(compareVersion('2.8-0.1.7-fz', '2.8-0.1.4'), null);
});
const img = fakeImage();
const man = manifestOf(img);
await t('manifest shape (§14.2): good accepted, bad fields rejected', () => {
  assert.deepEqual(checkManifest(man), man);
  const bad = [{ target: 'updater' }, { version: 'v2.8-0.1.7' }, { build: 'XYZ' }, { build: '71cd239d' }, { sha256: 'ab' }, { size: '64' }, { size: 0 },
    { file: '../speedo-2.8-0.1.7-fz.bin' }, { file: 'speedo-2.8/x.bin' }, { file: 'evil.bin' }];
  for (const b of bad) assert.equal(checkManifest({ ...man, ...b }), null, JSON.stringify(b));
  assert.equal(checkManifest(null), null); assert.equal(checkManifest('x'), null);
});
await t('checkImage: good image ok', async () => { const r = await checkImage(img, man); assert.equal(r.ok, true); assert.equal(r.desc.version, '2.8-0.1.7-fz'); });
await t('checkImage: each failure has its own reason, in order', async () => {
  const cases = [
    ['size', img.subarray(0, img.length - 1), man],
    ['sha256', (() => { const c = img.slice(); c[5000] ^= 1; return c; })(), man],
    ['kind', (() => { const c = img.slice(); c[0] = 0; return c; })(), null],
    ['updater', fakeImage({ project: 'updater' }), null],
    ['version', fakeImage({ version: '2.8-0.1.8-fz' }), null],
    ['build', fakeImage({ build: '0000000000000001' }), null],
  ];
  for (const [code, bytes, m0] of cases) {
    const m = m0 || { ...manifestOf(bytes), version: man.version, build: man.build };
    const r = await checkImage(bytes, m); assert.equal(r.ok, false, code); assert.equal(r.code, code); assert.equal(r.reason, IMAGE_REASONS[code]);
  }
  const r = await checkImage(img, man, img.length - 1); assert.equal(r.code, 'large');
  assert.equal(new Set(Object.values(IMAGE_REASONS)).size, 7);
  assert.match(IMAGE_REASONS.sha256, /^The downloaded file does not match the published one \(SHA-256\)\. Nothing was sent to the cluster\.$/);
  assert.equal(OTA_MAX.app, 0x300000);
});
console.log(`all passed (${n})`);
