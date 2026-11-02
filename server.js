// Zero-dependency local dev server. Serves ./public and proxies /api/* to BC Hydro,
// mirroring the redirect rules in netlify.toml. In production Netlify does this itself.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const FEEDS = {
  '/api/planned': 'https://www.bchydro.com/power-outages/app/outages-list-data-planned.json',
  '/api/current': 'https://www.bchydro.com/power-outages/app/outages-list-data-current.json',
};
const CACHE_MS = 2 * 60 * 1000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const cache = new Map();

async function proxy(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (bchydro-outage-finder dev proxy)' } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const body = await res.text();
  cache.set(url, { at: Date.now(), body });
  return body;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (FEEDS[url.pathname]) {
    try {
      const body = await proxy(FEEDS[url.pathname]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' });
      return res.end(body);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(err.message || err) }));
    }
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
