// Builds the site's data from the exports in ./data (or DATA_DIR) and writes it to ./public/generated.
// People listed in datasets.json get their own build in ./public/generated/people/<id>, for the toggle in the
// top bar; see datasets.example.json. The analysis itself is public/js/engine/build.js, which the browser also
// runs on an imported zip. Raw files are never served.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../public/js/engine/build.js';
import { diskFolder, exportFolder, nodePlatform } from './lib/disk-folder.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'public', 'generated');
const PEOPLE = path.join(OUT, 'people');

const readOptional = (name) => {
  const file = path.join(ROOT, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
};

const t0 = Date.now();
const log = (...a) => console.log(`[build +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function buildInto(folder, out, options = {}) {
  const { summary, intraday, avatar } = await build({ folder, platform: nodePlatform, log, ...options });
  fs.mkdirSync(out, { recursive: true });
  if (avatar) fs.writeFileSync(path.join(out, 'profile.jpg'), avatar);
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary));
  fs.writeFileSync(path.join(out, 'intraday.json'), JSON.stringify(intraday));
  const size = (f) => (fs.statSync(path.join(out, f)).size / 1048576).toFixed(2);
  log(`wrote ${path.relative(ROOT, out)}: summary.json ${size('summary.json')} MB, intraday.json ${size('intraday.json')} MB`);
}

// Your own exports, with your events and exclusions.
await buildInto(diskFolder(DATA), OUT, { exclusions: readOptional('exclusions.json'), events: readOptional('events.json') });

// Everyone in datasets.json. Their builds are replaced whole, so someone removed from the list disappears.
const people = [];
fs.rmSync(PEOPLE, { recursive: true, force: true });
for (const person of readOptional('datasets.json')) {
  if (!/^[a-z0-9-]+$/.test(person.id || '')) throw new Error(`datasets.json: "${person.id}" isn't a valid id (use lowercase letters, digits and dashes)`);
  log(`building ${person.label} from ${person.dir}`);
  await buildInto(await exportFolder(path.resolve(ROOT, person.dir)), path.join(PEOPLE, person.id));
  people.push({ id: person.id, label: person.label });
}
fs.writeFileSync(path.join(OUT, 'people.json'), JSON.stringify(people));
