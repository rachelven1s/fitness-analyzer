// Small readers for the files inside an export folder. Missing files and folders read as empty, so a
// source can ask for anything its export might hold.
import fs from 'node:fs';
import path from 'node:path';

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

export const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

export function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const rows = parseCsvText(readText(file));
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).filter((r) => r.length > 1).map((cols) => Object.fromEntries(head.map((h, i) => [h, cols[i] ?? ''])));
}

export function listFiles(dir, test) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(test).sort().map((f) => path.join(dir, f));
}
export const listCsv = (dir, prefix) => listFiles(dir, (f) => f.endsWith('.csv') && f.startsWith(prefix));
export const readAll = (dir, prefix) => listCsv(dir, prefix).flatMap(readCsv);
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const readJsonGlob = (dir, test) => listFiles(dir, test).flatMap((f) => {
  const v = readJson(f);
  return Array.isArray(v) ? v : [v];
});
export const readLines = (file) => {
  const lines = readText(file).split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

// The first folder in `dir` whose name starts with `prefix`, ignoring case, or null.
export function findFolder(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const name = fs.readdirSync(dir).find((f) => f.toLowerCase().startsWith(prefix) && fs.statSync(path.join(dir, f)).isDirectory());
  return name ? path.join(dir, name) : null;
}
