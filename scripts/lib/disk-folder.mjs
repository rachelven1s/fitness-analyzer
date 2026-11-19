// A folder on disk, for the build engine (see public/js/engine/lib/files.js), and Node's decompression.
// Reads return bytes directly rather than Promises; the engine awaits them either way.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function diskFolder(root) {
  const abs = (p) => (p ? path.join(root, ...p.split('/')) : root);
  return {
    name: root,
    list(dir) {
      try { return fs.readdirSync(abs(dir)); } catch { return []; }
    },
    isDir(p) {
      try { return fs.statSync(abs(p)).isDirectory(); } catch { return false; }
    },
    exists: (p) => fs.existsSync(abs(p)),
    read: (p) => fs.readFileSync(abs(p)),
    // Reads ranges straight from the file, so a large zip inside the export is never loaded whole.
    reader(p) {
      const fd = fs.openSync(abs(p), 'r');
      return {
        size: fs.fstatSync(fd).size,
        read(offset, length) {
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, offset);
          return buf;
        },
        close: () => fs.closeSync(fd),
      };
    },
  };
}

export const nodePlatform = {
  inflateRaw: (bytes) => zlib.inflateRawSync(bytes),
  gunzip: (bytes) => zlib.gunzipSync(bytes),
};
