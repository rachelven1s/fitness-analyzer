// A folder on disk, for the build engine (see public/js/engine/lib/files.js), and Node's decompression.
// Reads return bytes directly rather than Promises; the engine awaits them either way.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { zipFolder } from '../../public/js/engine/zip-folder.js';

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

// An export as Garmin (or Google) sends it: a folder holding the unzipped files, a folder holding just the
// .zip, or the .zip itself. A zip is read in place, the way the browser reads one dropped on the page.
export async function exportFolder(p) {
  let zip = /\.zip$/i.test(p) && fs.statSync(p).isFile() ? p : null;
  if (!zip) {
    const names = fs.readdirSync(p).filter((f) => !f.startsWith('.'));
    if (names.length === 1 && /\.zip$/i.test(names[0])) zip = path.join(p, names[0]);
  }
  if (!zip) return diskFolder(p);
  const reader = diskFolder(path.dirname(zip)).reader(path.basename(zip));
  return zipFolder(reader, nodePlatform, zip);
}
