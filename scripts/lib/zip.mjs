// Minimal read-only ZIP reader. Entries are returned as buffers and never written to disk.
import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

export function openZip(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const tailLen = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);

  let at = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) { at = i; break; }
  }
  if (at < 0) throw new Error(`Not a zip file: ${file}`);
  const count = tail.readUInt16LE(at + 10);
  const dirSize = tail.readUInt32LE(at + 12);
  const dirOffset = tail.readUInt32LE(at + 16);

  const dir = Buffer.alloc(dirSize);
  fs.readSync(fd, dir, 0, dirSize, dirOffset);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= dirSize; i++) {
    if (dir.readUInt32LE(p) !== CENTRAL) throw new Error(`Corrupt zip directory: ${file}`);
    const method = dir.readUInt16LE(p + 10);
    const compressedSize = dir.readUInt32LE(p + 20);
    const size_ = dir.readUInt32LE(p + 24);
    const nameLen = dir.readUInt16LE(p + 28);
    const extraLen = dir.readUInt16LE(p + 30);
    const commentLen = dir.readUInt16LE(p + 32);
    const offset = dir.readUInt32LE(p + 42);
    entries.push({ name: dir.toString('utf8', p + 46, p + 46 + nameLen), method, compressedSize, size: size_, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    read(entry) {
      const head = Buffer.alloc(30);
      fs.readSync(fd, head, 0, 30, entry.offset);
      const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      const raw = Buffer.alloc(entry.compressedSize);
      fs.readSync(fd, raw, 0, entry.compressedSize, start);
      if (entry.method === 0) return raw;
      if (entry.method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`Unsupported zip compression ${entry.method} for ${entry.name}`);
    },
    close() { fs.closeSync(fd); },
  };
}
