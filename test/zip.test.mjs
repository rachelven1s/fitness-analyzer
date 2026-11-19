import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { openZip, memoryReader } from '../public/js/engine/lib/zip.js';
import { zipFolder, browserPlatform } from '../public/js/engine/zip-folder.js';
import { nodePlatform } from '../scripts/lib/disk-folder.mjs';
import { makeZip } from './helpers/make-zip.mjs';

const text = (bytes) => new TextDecoder().decode(bytes);
const FILES = { 'a.txt': 'hello', 'dir/b.json': '{"x":1}', 'dir/sub/c.csv': 'h\n1\n'.repeat(200), 'empty.txt': '' };

for (const [label, opts] of [['deflated', {}], ['stored', { deflate: false }], ['zip64', { zip64: true }]]) {
  test(`reads every entry of a ${label} zip`, async () => {
    const zip = await openZip(memoryReader(makeZip(FILES, opts)), nodePlatform.inflateRaw);
    assert.deepEqual(zip.entries.map((e) => e.name), Object.keys(FILES));
    for (const entry of zip.entries) assert.equal(text(await zip.read(entry)), FILES[entry.name]);
  });
}

test('rejects bytes that are not a zip', async () => {
  await assert.rejects(openZip(memoryReader(new Uint8Array(100)), nodePlatform.inflateRaw, 'x.bin'), /Not a zip file: x\.bin/);
});

test('the browser decompression gives the same bytes as zlib', async () => {
  const data = new TextEncoder().encode('steps,heart rate\n'.repeat(500));
  assert.deepEqual(await browserPlatform.inflateRaw(zlib.deflateRawSync(data)), new Uint8Array(data));
  assert.deepEqual(await browserPlatform.gunzip(zlib.gzipSync(data)), new Uint8Array(data));
});

test('a zip folder lists folders implied by file paths and reads zips inside the zip', async () => {
  const inner = makeZip({ 'one.fit': 'FIT1', 'two.fit': 'FIT2' });
  const folder = await zipFolder(memoryReader(makeZip({
    'export/DI_CONNECT/x.json': '[]',
    'export/DI_CONNECT/Uploaded/files.zip': inner,
    'export/explicit/': '',
    '__MACOSX/export/DI_CONNECT/._x.json': 'junk',
  })), nodePlatform, 'test.zip');
  assert.deepEqual(folder.list(''), ['export']);
  assert.deepEqual(folder.list('export').sort(), ['DI_CONNECT', 'explicit']);
  assert.ok(folder.isDir('export/DI_CONNECT') && folder.isDir('export/explicit') && !folder.isDir('export/DI_CONNECT/x.json'));
  assert.ok(folder.exists('export/DI_CONNECT/x.json') && !folder.exists('export/nope'));
  assert.ok(!folder.exists('__MACOSX'));
  const nested = await openZip(await folder.reader('export/DI_CONNECT/Uploaded/files.zip'), nodePlatform.inflateRaw);
  assert.deepEqual(await Promise.all(nested.entries.map(async (e) => text(await nested.read(e)))), ['FIT1', 'FIT2']);
});
