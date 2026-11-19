// Small readers for the files inside an export. Missing files and folders read as empty, so a source can ask
// for anything its export might hold.
//
// Exports are read through a folder, so the same build runs on a folder on disk (scripts/lib/disk-folder.mjs)
// and on a zip dropped into the browser (zip-folder.js). Paths are relative, joined with '/', and '' is the root.
//   folder.name             a label for messages
//   folder.list(dir)        the names directly inside dir, files and folders; [] if it doesn't exist
//   folder.isDir(path), folder.exists(path)
//   folder.read(path)       Promise of the file's bytes, a Uint8Array
//   folder.reader(path)     Promise of { size, read(offset, length) } over the file, for zips inside the export

export const join = (...parts) => parts.filter(Boolean).join('/');
export const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

const utf8 = new TextDecoder('utf-8');
export const decodeText = (bytes) => utf8.decode(bytes).replace(/^﻿/, '');

// Handles quoted fields containing newlines, which Strava descriptions do.
export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') {
      row.push(cur.endsWith('\r') ? cur.slice(0, -1) : cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export const readText = async (folder, file) => decodeText(await folder.read(file));

export async function readCsv(folder, file) {
  if (!folder.exists(file)) return [];
  const rows = parseCsvText(await readText(folder, file));
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).filter((r) => r.length > 1).map((cols) => Object.fromEntries(head.map((h, i) => [h, cols[i] ?? ''])));
}

export const listFiles = (folder, dir, test) => folder.list(dir).filter(test).sort().map((f) => join(dir, f));
export const listCsv = (folder, dir, prefix) => listFiles(folder, dir, (f) => f.endsWith('.csv') && f.startsWith(prefix));
export async function readAll(folder, dir, prefix) {
  const rows = [];
  for (const file of listCsv(folder, dir, prefix)) for (const row of await readCsv(folder, file)) rows.push(row);
  return rows;
}
export const readJson = async (folder, file) => JSON.parse(await readText(folder, file));
export async function readJsonGlob(folder, dir, test) {
  const out = [];
  for (const file of listFiles(folder, dir, test)) {
    const v = await readJson(folder, file);
    if (Array.isArray(v)) for (const x of v) out.push(x);
    else out.push(v);
  }
  return out;
}
export async function readLines(folder, file) {
  const lines = (await readText(folder, file)).split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// The first folder in `dir` whose name starts with `prefix`, ignoring case, or null.
export function findFolder(folder, dir, prefix) {
  const name = folder.list(dir).find((f) => f.toLowerCase().startsWith(prefix) && folder.isDir(join(dir, f)));
  return name != null ? join(dir, name) : null;
}
