// Minimal read-only ZIP reader. Entries are returned as bytes and never written anywhere.
// It reads through `reader`, { size, read(offset, length) } returning a Uint8Array or a Promise of one, so the
// same code reads a file on disk, a File dropped into the browser, or a zip held in memory. `inflateRaw(bytes)`
// decompresses a deflated entry; it comes from the platform (zlib in Node, DecompressionStream in the browser).

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const ZIP64_EXTRA = 0x0001;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u64 = (dv, at) => Number(dv.getBigUint64(at, true));
const utf8 = new TextDecoder('utf-8');

// A reader over bytes already in memory.
export const memoryReader = (bytes) => ({ size: bytes.length, read: (offset, length) => bytes.subarray(offset, offset + length) });

export async function openZip(reader, inflateRaw, name = 'zip') {
  const size = reader.size;
  const tailLen = Math.min(size, 65557);
  const tail = await reader.read(size - tailLen, tailLen);
  const tv = view(tail);

  let at = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === EOCD) { at = i; break; }
  }
  if (at < 0) throw new Error(`Not a zip file: ${name}`);
  let count = tv.getUint16(at + 10, true);
  let dirSize = tv.getUint32(at + 12, true);
  let dirOffset = tv.getUint32(at + 16, true);
  // ZIP64: past 65,535 entries or 4 GB, the real numbers live in a second end record found through a locator.
  if ((count === MAX16 || dirSize === MAX32 || dirOffset === MAX32) && at >= 20 && tv.getUint32(at - 20, true) === EOCD64_LOCATOR) {
    const rec = view(await reader.read(u64(tv, at - 12), 56));
    if (rec.getUint32(0, true) !== EOCD64) throw new Error(`Corrupt zip64 record: ${name}`);
    count = u64(rec, 32);
    dirSize = u64(rec, 40);
    dirOffset = u64(rec, 48);
  }

  const dir = await reader.read(dirOffset, dirSize);
  const dv = view(dir);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= dirSize; i++) {
    if (dv.getUint32(p, true) !== CENTRAL) throw new Error(`Corrupt zip directory: ${name}`);
    const method = dv.getUint16(p + 10, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let size_ = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const extraStart = p + 46 + nameLen;
    // The zip64 extra field holds, in order, whichever of the three values overflowed.
    for (let e = extraStart; e + 4 <= extraStart + extraLen;) {
      const id = dv.getUint16(e, true);
      const len = dv.getUint16(e + 2, true);
      if (id === ZIP64_EXTRA) {
        let q = e + 4;
        if (size_ === MAX32) { size_ = u64(dv, q); q += 8; }
        if (compressedSize === MAX32) { compressedSize = u64(dv, q); q += 8; }
        if (offset === MAX32) offset = u64(dv, q);
      }
      e += 4 + len;
    }
    entries.push({ name: utf8.decode(dir.subarray(p + 46, extraStart)), method, compressedSize, size: size_, offset });
    p = extraStart + extraLen + commentLen;
  }

  return {
    entries,
    async read(entry) {
      const head = view(await reader.read(entry.offset, 30));
      const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
      const raw = await reader.read(start, entry.compressedSize);
      if (entry.method === 0) return raw;
      if (entry.method === 8) return inflateRaw(raw);
      throw new Error(`Unsupported zip compression ${entry.method} for ${entry.name}`);
    },
    close() { reader.close?.(); },
  };
}
