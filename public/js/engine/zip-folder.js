// An export zip as a folder for the build (see lib/files.js), and the browser's decompression. Only the zip's
// directory is read up front; each file is read and decompressed when the build asks for it.
import { openZip, memoryReader } from './lib/zip.js';

// A File (or Blob) read in ranges, so a large export is never loaded whole.
export const fileReader = (file) => ({
  size: file.size,
  read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
});

const decompress = async (bytes, format) => {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};
export const browserPlatform = {
  inflateRaw: (bytes) => decompress(bytes, 'deflate-raw'),
  gunzip: (bytes) => decompress(bytes, 'gzip'),
};

export async function zipFolder(reader, platform, name = 'zip') {
  const zip = await openZip(reader, platform.inflateRaw, name);
  const files = new Map();
  const children = new Map([['', new Set()]]);
  for (const entry of zip.entries) {
    // macOS adds __MACOSX/ copies of every file's metadata when it zips a folder.
    if (entry.name.startsWith('__MACOSX/')) continue;
    const parts = entry.name.split('/').filter(Boolean);
    if (!parts.length) continue;
    const isDir = entry.name.endsWith('/');
    if (!isDir) files.set(parts.join('/'), entry);
    // Every folder along the way exists, even when the zip lists only the files inside it.
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!children.has(dir)) children.set(dir, new Set());
      children.get(dir).add(parts[i]);
    }
    if (isDir && !children.has(parts.join('/'))) children.set(parts.join('/'), new Set());
  }
  const read = (p) => {
    const entry = files.get(p);
    if (!entry) throw new Error(`Not in the zip: ${p}`);
    return zip.read(entry);
  };
  return {
    name,
    list: (dir) => [...(children.get(dir) ?? [])],
    isDir: (p) => children.has(p),
    exists: (p) => files.has(p) || children.has(p),
    read,
    // A zip inside the export is decompressed into memory and read from there.
    reader: async (p) => memoryReader(await read(p)),
  };
}
