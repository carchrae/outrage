// Local dev server. Serves ./public and proxies /api/* to BC Hydro, mirroring the redirect
// rules in netlify.toml. In production Netlify does this itself.
//
// Push alerts: the page needs a VAPID public key (VAPID_PUBLIC_KEY, as on Netlify). When none is
// set and the web-push package is installed, a throwaway key pair is generated at startup so the
// alert buttons and subscribe flow can be tried locally. Subscriptions are kept in memory and no
// pushes are sent; the hourly check only runs on Netlify.
const http = require('http');
const fs = require('fs');
const path = require('path');

// Local secrets live in .env (gitignored): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (e) { /* no .env, or an older Node */ }

const PORT = Number(process.env.PORT) || 3000;
let vapidPublicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
if (!vapidPublicKey) {
  try { vapidPublicKey = require('web-push').generateVAPIDKeys().publicKey; console.log('using a throwaway VAPID key for this run (set VAPID_PUBLIC_KEY to use your own)'); }
  catch (e) { console.log('no VAPID_PUBLIC_KEY and web-push not installed: alert buttons will be hidden'); }
}
const subs = new Map();
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
  if (url.pathname === '/api/subscribe') {
    // Stand-in for netlify/functions/subscribe.mjs: remembers subscriptions for this run only.
    let body = '';
    for await (const chunk of req) body += chunk;
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"bad json"}'); }
    if (req.method === 'POST' && data.subscription && data.subscription.endpoint) {
      subs.set(data.subscription.endpoint, { street: data.street, muni: data.muni });
      console.log(`subscribe: ${data.street} | ${data.muni} (${subs.size} total)`);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, street: data.street, muni: data.muni }));
    }
    if (req.method === 'DELETE' && data.endpoint) {
      subs.delete(data.endpoint);
      console.log(`unsubscribe (${subs.size} total)`);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}');
    }
    res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"expected POST {subscription, street, muni} or DELETE {endpoint}"}');
  }
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
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    if (file.endsWith('index.html') && vapidPublicKey) {
      // Same stamp scripts/stamp.js applies on Netlify, minus the asset versioning.
      data = Buffer.from(data.toString().replace(/<meta name="vapid-public-key" content="[^"]*">/, `<meta name="vapid-public-key" content="${vapidPublicKey}">`));
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
