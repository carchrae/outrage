/*
 * Service worker for Outage: shows the notification the 10-minute feed check pushes, and keeps
 * an offline copy of the page. The push carries its own title and text (street level only; the
 * server never knows a house number), so nothing is fetched or matched here. The page works out
 * the exact changes for the saved address when it is opened.
 */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { /* not JSON */ }
  e.waitUntil(self.registration.showNotification(d.title || 'Outage', {
    body: d.body || 'Outage information for your street changed. Open to see the latest.',
    tag: 'outage-alert', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png',
    data: { url: d.url || '/', ids: d.ids || [] },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.focus(); return; } }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

// ---------------------------------------------------------------- offline shell
// The page and its assets are kept in a cache so the installed app opens without a network, and
// the last copy of each feed is kept so an outage with no connectivity still shows something.
// Chrome on Android also wants a fetch handler before it offers a real install.
const CACHE = 'outage-v1';
const SHELL = ['/', '/style.css', '/parse.js', '/matcher.js', '/alerts.js', '/app.js', '/manifest.webmanifest', '/munis.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Network first, falling back to the cache: fresh when online, last known copy when not.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) || (req.mode === 'navigate' ? await cache.match('/') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
