// Builds small zip files for tests, so no real export is needed.
import zlib from 'node:zlib';

// Writes a zip of { name: bytes or string } entries. A name ending in '/' is a folder. `zip64` writes the
// sizes, offsets and entry count through ZIP64 records, as an archive past 4 GB or 65,535 entries would.
export function makeZip(files, { deflate = true, zip64 = false } = {}) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const packed = deflate && data.length ? zlib.deflateRawSync(data) : data;
    const method = deflate && data.length ? 8 : 0;
    const nameBytes = enc.encode(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    local.push(head, nameBytes, packed);
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(packed.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 20);
    dir.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(extra.length, 30);
    dir.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(dir, nameBytes, extra);
    offset += 30 + nameBytes.length + packed.length;
  }
  const dirBytes = Buffer.concat(central);
  const count = Object.keys(files).length;
  const tail = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(dirBytes.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + dirBytes.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(rec, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : count, 8);
  end.writeUInt16LE(zip64 ? 0xffff : count, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : dirBytes.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return new Uint8Array(Buffer.concat([...local, dirBytes, ...tail, end]));
}
