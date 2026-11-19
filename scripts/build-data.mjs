// Builds the site's data from the exports in ./data (or DATA_DIR) and writes it to ./public/generated.
// The analysis itself is public/js/engine/build.js, which the browser also runs on an imported zip.
// Raw files are never served.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../public/js/engine/build.js';
import { diskFolder, nodePlatform } from './lib/disk-folder.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'public', 'generated');

const readOptional = (name) => {
  const file = path.join(ROOT, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
};

const t0 = Date.now();
const log = (...a) => console.log(`[build +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const { summary, intraday, avatar } = await build({
  folder: diskFolder(DATA),
  platform: nodePlatform,
  exclusions: readOptional('exclusions.json'),
  events: readOptional('events.json'),
  log,
});

fs.mkdirSync(OUT, { recursive: true });
if (avatar) fs.writeFileSync(path.join(OUT, 'profile.jpg'), avatar);
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary));
fs.writeFileSync(path.join(OUT, 'intraday.json'), JSON.stringify(intraday));
const size = (f) => (fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(2);
log(`wrote summary.json ${size('summary.json')} MB, intraday.json ${size('intraday.json')} MB`);
