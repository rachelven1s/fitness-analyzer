// Local-only static server. Binds to loopback and serves ./public, never ./data.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4173;
const HOST = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
};

if (!fs.existsSync(path.join(PUBLIC, 'generated', 'summary.json'))) {
  console.log('No generated data yet. Building from ./data (about 20 seconds)...');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-data.mjs')], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const file = path.normalize(path.join(PUBLIC, decoded === '/' ? 'index.html' : decoded));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  // Chapter pages like /heart have no file of their own: the page shell routes them.
  const target = path.extname(file) ? file : path.join(PUBLIC, 'index.html');
  fs.readFile(target, (err, body) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Try: PORT=4174 npm start`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => console.log(`Fitness Analyzer running at http://${HOST}:${PORT}`));
