import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFit, fitTimeToMs } from '../public/js/engine/lib/fit.js';
import { fitRoute } from '../public/js/engine/lib/fit-activity.js';

// Builds a FIT file from definition and data messages. Each definition is
// { local, global, little, fields: [[num, size, baseType]] }; each record is { local, bytes }.
function makeFit(parts) {
  const body = [];
  for (const p of parts) {
    if (p.fields) {
      // header, reserved, architecture, global message number (2 bytes), field count, then 3 bytes a field.
      const def = Buffer.alloc(6 + p.fields.length * 3);
      def[0] = 0x40 | p.local;
      def[2] = p.little === false ? 1 : 0;
      if (p.little === false) def.writeUInt16BE(p.global, 3); else def.writeUInt16LE(p.global, 3);
      def[5] = p.fields.length;
      p.fields.forEach(([num, size, type], i) => { def[6 + i * 3] = num; def[7 + i * 3] = size; def[8 + i * 3] = type; });
      body.push(def);
    } else body.push(Buffer.from([p.header ?? p.local]), p.bytes);
  }
  const data = Buffer.concat(body);
  const head = Buffer.alloc(12);
  head[0] = 12;
  head[1] = 0x10;
  head.writeUInt32LE(data.length, 4);
  head.write('.FIT', 8, 'latin1');
  return new Uint8Array(Buffer.concat([head, data]));
}

const decodeAll = (buf, wanted) => {
  const out = [];
  const ok = decodeFit(buf, (global, fields, compressedTs) => out.push({ global, fields, compressedTs }), wanted);
  return { ok, out };
};

test('decodes integers, floats, strings and arrays, and drops invalid values', () => {
  const rec = Buffer.alloc(1 + 2 + 4 + 4 + 8 + 4 + 2 + 1);
  let p = 0;
  rec.writeUInt8(150, p); p += 1; // u8
  rec.writeInt16LE(-300, p); p += 2; // i16
  rec.writeUInt32LE(4000000000, p); p += 4; // u32
  rec.writeFloatLE(1.5, p); p += 4; // f32
  rec.write('Run\0\0\0\0\0', p, 'utf8'); p += 8; // string
  rec.writeUInt16LE(10, p); rec.writeUInt16LE(0xffff, p + 2); p += 4; // u16 array, second invalid
  rec.writeUInt16LE(0xffff, p); p += 2; // invalid u16
  rec.writeInt8(-5, p); // i8
  const fit = makeFit([
    { local: 0, global: 20, fields: [[0, 1, 0x02], [1, 2, 0x83], [2, 4, 0x86], [3, 4, 0x88], [4, 8, 0x07], [5, 4, 0x84], [6, 2, 0x84], [7, 1, 0x01]] },
    { local: 0, bytes: rec },
  ]);
  const { ok, out } = decodeAll(fit);
  assert.equal(ok, true);
  assert.deepEqual(out, [{ global: 20, fields: { 0: 150, 1: -300, 2: 4000000000, 3: 1.5, 4: 'Run', 5: [10, null], 7: -5 }, compressedTs: null }]);
});

test('reads big-endian definitions', () => {
  const rec = Buffer.alloc(6);
  rec.writeUInt16BE(513, 0);
  rec.writeInt32BE(-70000, 2);
  const { out } = decodeAll(makeFit([
    { local: 1, global: 300, little: false, fields: [[0, 2, 0x84], [1, 4, 0x85]] },
    { local: 1, bytes: rec },
  ]));
  assert.deepEqual(out, [{ global: 300, fields: { 0: 513, 1: -70000 }, compressedTs: null }]);
});

test('compressed timestamps count on from the last full timestamp', () => {
  const full = Buffer.alloc(5);
  full.writeUInt32LE(1000, 0); // 1000 = 31 * 32 + 8
  full[4] = 60;
  const { out } = decodeAll(makeFit([
    { local: 0, global: 20, fields: [[253, 4, 0x86], [3, 1, 0x02]] },
    { local: 0, bytes: full },
    { local: 1, global: 20, fields: [[3, 1, 0x02]] },
    { header: 0x80 | (1 << 5) | 12, bytes: Buffer.from([61]) }, // offset 12: 1000 - 8 + 12
    { header: 0x80 | (1 << 5) | 2, bytes: Buffer.from([62]) }, // offset 2 wraps past 32
  ]));
  assert.deepEqual(out.map((m) => [m.fields[3], m.fields[253] ?? m.compressedTs]), [[60, 1000], [61, 1004], [62, 1026]]);
});

test('skips messages it was not asked for, and keeps what came before a truncation', () => {
  const fit = makeFit([
    { local: 0, global: 20, fields: [[3, 1, 0x02]] },
    { local: 1, global: 55, fields: [[3, 4, 0x86]] },
    { local: 1, bytes: Buffer.from([1, 0, 0, 0]) },
    { local: 0, bytes: Buffer.from([70]) },
    { local: 1, bytes: Buffer.from([2, 0]) }, // cut short
  ]);
  const wanted = decodeAll(fit, new Set([20]));
  assert.deepEqual(wanted.out.map((m) => m.global), [20]);
  const truncated = decodeAll(fit);
  assert.equal(truncated.ok, true);
  assert.deepEqual(truncated.out.map((m) => m.fields[3]), [1, 70]);
});

test('rejects files without the .FIT signature', () => {
  assert.equal(decodeFit(new Uint8Array(20), () => {}), false);
});

test('works on a Uint8Array that is a view into a larger buffer', () => {
  const rec = Buffer.alloc(8);
  rec.writeInt32LE(Math.round((45 / 180) * 2147483648), 0);
  rec.writeInt32LE(Math.round((-73.5 / 180) * 2147483648), 4);
  const fit = makeFit([{ local: 0, global: 20, fields: [[0, 4, 0x85], [1, 4, 0x85]] }, { local: 0, bytes: rec }]);
  const padded = new Uint8Array(fit.length + 10);
  padded.set(fit, 7);
  const route = fitRoute(padded.subarray(7, 7 + fit.length));
  assert.ok(Math.abs(route.lat[0] - 45) < 1e-6 && Math.abs(route.lon[0] + 73.5) < 1e-6);
  assert.equal(fitTimeToMs(0), Date.UTC(1989, 11, 31));
});
