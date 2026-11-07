// Made-up ESP-IDF app images for the tests: header byte, esp_app_desc_t at 0x20 (version, project, date, ELF SHA-256).
import { createHash } from 'node:crypto';
export function fakeImage({ version = '2.8-0.1.7-fz', build = '71cd239d165cadda', project = 'speedo', size = 64 * 1024, seed = 1 } = {}) {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed * 7) & 0xff;
  b[0] = 0xe9;
  b.fill(0, 0x20, 0x20 + 176);
  b.set([0x32, 0x54, 0xcd, 0xab], 0x20);
  const put = (o, s) => b.set(new TextEncoder().encode(s), 0x20 + o);
  put(16, version); put(48, project); put(80, '10:15:00'); put(96, 'Nov  7 2026');
  b.set(Buffer.from(build.padEnd(64, '0'), 'hex'), 0x20 + 144);
  return b;
}
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const manifestOf = (b, { version = '2.8-0.1.7-fz', build = '71cd239d165cadda' } = {}) =>
  ({ target: 'app', version, build, size: b.length, sha256: sha256(b), file: `speedo-${version}-${build}.bin` });
