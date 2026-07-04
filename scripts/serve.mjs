// Minimal static file server (no dependencies) so fetch() works (file:// can't fetch JSON).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PORT = process.env.PORT || 8080;
const TYPES = {
  '.html':'text/html', '.css':'text/css', '.js':'text/javascript',
  '.json':'application/json', '.otf':'font/otf', '.ttf':'font/ttf', '.svg':'image/svg+xml',
  '.gif':'image/gif', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.ico':'image/x-icon',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
    await stat(file);
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',   // always serve fresh in dev
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`\n  RuneScape Music Player → http://localhost:${PORT}\n`));
