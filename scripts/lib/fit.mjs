// Minimal decoder for Garmin FIT files. Returns raw messages keyed by global message number,
// with fields keyed by field number. Corrupt or truncated files return what was read before the fault.

const FIT_EPOCH_S = 631065600; // 1989-12-31T00:00:00Z

export const fitTimeToMs = (t) => (t + FIT_EPOCH_S) * 1000;

const BASE = {
  0x00: [1, 'u8', 0xff], 0x01: [1, 'i8', 0x7f], 0x02: [1, 'u8', 0xff],
  0x83: [2, 'i16', 0x7fff], 0x84: [2, 'u16', 0xffff],
  0x85: [4, 'i32', 0x7fffffff], 0x86: [4, 'u32', 0xffffffff],
  0x07: [1, 'str', null],
  0x88: [4, 'f32', null], 0x89: [8, 'f64', null],
  0x0a: [1, 'u8', 0x00], 0x8b: [2, 'u16', 0x0000], 0x8c: [4, 'u32', 0x00000000],
  0x0d: [1, 'u8', 0xff],
  0x8e: [8, 'skip', null], 0x8f: [8, 'skip', null], 0x90: [8, 'skip', null],
};

function readValue(buf, at, kind, little) {
  switch (kind) {
    case 'u8': return buf[at];
    case 'i8': return buf.readInt8(at);
    case 'i16': return little ? buf.readInt16LE(at) : buf.readInt16BE(at);
    case 'u16': return little ? buf.readUInt16LE(at) : buf.readUInt16BE(at);
    case 'i32': return little ? buf.readInt32LE(at) : buf.readInt32BE(at);
    case 'u32': return little ? buf.readUInt32LE(at) : buf.readUInt32BE(at);
    case 'f32': return little ? buf.readFloatLE(at) : buf.readFloatBE(at);
    case 'f64': return little ? buf.readDoubleLE(at) : buf.readDoubleBE(at);
    default: return null;
  }
}

// onMessage(globalNum, fields, timestampFromCompressedHeader) lets callers skip retaining huge files.
export function decodeFit(buf, onMessage, wanted) {
  if (buf.length < 12 || buf.toString('latin1', 8, 12) !== '.FIT') return false;
  const headerSize = buf[0];
  const dataSize = buf.readUInt32LE(4);
  const end = Math.min(buf.length, headerSize + dataSize);
  const defs = new Map();
  let p = headerSize;
  let lastTs = 0;

  try {
    while (p < end) {
      const header = buf[p++];
      if (header & 0x80) {
        // Compressed timestamp data message
        const local = (header >> 5) & 0x03;
        const offset = header & 0x1f;
        const def = defs.get(local);
        if (!def) return true;
        let ts = (lastTs & ~0x1f) + offset;
        if (offset < (lastTs & 0x1f)) ts += 0x20;
        lastTs = ts;
        readMessage(def, ts);
      } else if (header & 0x40) {
        const local = header & 0x0f;
        const hasDev = header & 0x20;
        const little = buf[p + 1] === 0;
        const global = little ? buf.readUInt16LE(p + 2) : buf.readUInt16BE(p + 2);
        const n = buf[p + 4];
        p += 5;
        const fields = [];
        let total = 0;
        for (let i = 0; i < n; i++) {
          fields.push({ num: buf[p], size: buf[p + 1], type: buf[p + 2] });
          total += buf[p + 1];
          p += 3;
        }
        let dev = 0;
        if (hasDev) {
          const m = buf[p++];
          for (let i = 0; i < m; i++) { dev += buf[p + 1]; p += 3; }
        }
        defs.set(local, { global, little, fields, total, dev });
      } else {
        const def = defs.get(header & 0x0f);
        if (!def) return true;
        readMessage(def, null);
      }
    }
  } catch {
    return true; // truncated file: keep what was decoded
  }
  return true;

  function readMessage(def, compressedTs) {
    if (wanted && !wanted.has(def.global)) { p += def.total + def.dev; return; }
    const out = {};
    let at = p;
    for (const f of def.fields) {
      const base = BASE[f.type];
      if (base && base[1] !== 'skip') {
        const [width, kind, invalid] = base;
        if (kind === 'str') {
          const raw = buf.toString('utf8', at, at + f.size);
          const zero = raw.indexOf('\0');
          out[f.num] = zero >= 0 ? raw.slice(0, zero) : raw;
        } else if (f.size === width) {
          const v = readValue(buf, at, kind, def.little);
          if (v !== invalid) out[f.num] = v;
        } else if (width && f.size % width === 0) {
          const list = [];
          for (let i = 0; i < f.size / width; i++) {
            const v = readValue(buf, at + i * width, kind, def.little);
            list.push(v === invalid ? null : v);
          }
          out[f.num] = list;
        }
      }
      at += f.size;
    }
    p += def.total + def.dev;
    if (out[253] != null) lastTs = out[253];
    onMessage(def.global, out, compressedTs);
  }
}
