// Copies ./public to ./site for hosting, behind a password screen. The generated data moves to a
// folder named after the password's hash, so it can't be fetched without the password.
// This is light protection only: anyone with the password (or the folder name) can read the data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const SITE = path.join(ROOT, 'site');

const password = process.env.SITE_PASSWORD;
if (!password) {
  console.error('Set a password: SITE_PASSWORD=... npm run build:site');
  process.exit(1);
}
if (!fs.existsSync(path.join(PUBLIC, 'generated', 'summary.json'))) {
  console.error('No generated data yet. Run "npm run build:data" first.');
  process.exit(1);
}

const dir = crypto.createHash('sha256').update(password).digest('hex').slice(0, 32);
const skip = (src) => path.basename(src) === '.DS_Store';

fs.rmSync(SITE, { recursive: true, force: true });
fs.cpSync(PUBLIC, SITE, { recursive: true, filter: (src) => !skip(src) && src !== path.join(PUBLIC, 'generated') });
fs.cpSync(path.join(PUBLIC, 'generated'), path.join(SITE, dir), { recursive: true, filter: (src) => !skip(src) });

const index = path.join(SITE, 'index.html');
fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('<html lang="en">', '<html lang="en" data-locked>'));
// Chapter pages like /trends have no file of their own: the page shell routes them.
fs.writeFileSync(path.join(SITE, '_redirects'), '/*  /index.html  200\n');

console.log(`Built ./site. Deploy that folder, e.g. drag it onto https://app.netlify.com/drop`);
