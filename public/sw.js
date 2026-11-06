/*
 * Service worker for Planned outrage: turns a push from the hourly feed check into a notification.
 *
 * The server only knows the subscriber's street. On a push the worker fetches both feeds through the
 * site's own /api proxy, matches the full saved address (read from IndexedDB, mirrored there by the
 * page) and diffs against the snapshot from the last visit, so the notification says what changed.
 * It always shows something: a push that produced no notification would be reported by the browser
 * as a generic "updated in the background" notice or count against a silent-push quota.
 */
/* global importScripts, OutageParser, OutageMatcher */
importScripts('/parse.js', '/matcher.js');
const M = self.OutageMatcher;
const TZ = 'America/Vancouver';
const DB_NAME = 'outrage';
const STORE = 'kv';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch (err) { /* not JSON */ }
  e.waitUntil(notify(payload));
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

function idbGet(key) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const get = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
          get.onsuccess = () => { resolve(get.result == null ? null : get.result); db.close(); };
          get.onerror = () => { resolve(null); db.close(); };
        } catch (e) { resolve(null); db.close(); }
      };
    } catch (e) { resolve(null); }
  });
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function notify(payload) {
  let title = 'Planned outrage';
  let body = 'Outage information for your street changed. Open to see the latest.';
  const home = await idbGet('home');
  if (home && home.address) {
    try {
      const [planned, current] = await Promise.all([fetchJSON('/api/planned'), fetchJSON('/api/current').catch(() => null)]);
      const fed = M.ingestFeeds(planned, current);
      const now = Date.now();
      const matches = M.homeMatches(fed.outages.concat(fed.current), fed.munis, home, now, false);
      const snap = await idbGet('snapshot');
      const lines = describe(M.computeDiff(snap, matches.strong, now));
      if (lines.length) {
        title = `${lines.length} outage change${lines.length === 1 ? '' : 's'} for ${home.address}`;
        body = lines.slice(0, 4).join('\n') + (lines.length > 4 ? `\n+${lines.length - 4} more` : '');
      } else if (matches.strong.length) {
        const next = matches.strong[0];
        title = `Outage update for ${home.address}`;
        body = next.o.kind === 'current'
          ? `An unplanned outage on your street is in progress${next.o.dateOn ? ', restoration estimated ' + fmtDateTime(next.o.dateOn) : ''}.`
          : `A planned outage listing your street was updated. Next: ${fmtWindow(next.o.dateOff, next.o.dateOn)}.`;
      } else {
        title = `Outage update near ${home.address}`;
        body = 'An outage listing on your street was updated or removed. Open to see the latest.';
      }
    } catch (err) {
      body = 'Could not check the latest details. Open to see what changed.';
    }
  }
  await self.registration.showNotification(title, {
    body, tag: 'outrage-alert', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png',
    data: { url: '/', ids: payload.ids || [] },
  });
}

function describe(d) {
  const lines = [];
  for (const o of d.added) lines.push(o.kind === 'current' ? `Unplanned outage on your street, started ${fmtDateTime(o.dateOff)}` : `New: ${fmtWindow(o.dateOff, o.dateOn)}`);
  for (const { o, was } of d.rescheduled) lines.push(`Time changed: now ${fmtWindow(o.dateOff, o.dateOn)} (was ${fmtWindow(was.dateOff, was.dateOn)})`);
  for (const o of d.cancelled) lines.push(`Cancelled: ${fmtWindow(o.dateOff, o.dateOn)}`);
  for (const o of d.updated) lines.push(o.kind === 'current' ? `Unplanned outage updated${o.dateOn ? ': restoration estimated ' + fmtDateTime(o.dateOn) : ''}` : `Address list updated: ${fmtWindow(o.dateOff, o.dateOn)}`);
  for (const p of d.removed) lines.push(`No longer listed: ${fmtWindow(p.dateOff, p.dateOn)}`);
  for (const p of d.finished) lines.push(p.kind === 'current' ? 'Unplanned outage resolved' : `Finished: ${fmtWindow(p.dateOff, p.dateOn)}`);
  return lines;
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
function fmtTime(ms) { return timeFmt.format(new Date(ms)).replace(/\./g, '').replace(/\s?([ap])m/i, ' $1.m.'); }
function fmtDateTime(ms) { return `${dayFmt.format(new Date(ms))} ${fmtTime(ms)}`; }
function fmtWindow(off, on) {
  if (!on) return fmtDateTime(off);
  const sameDay = dayFmt.format(new Date(off)) === dayFmt.format(new Date(on));
  return sameDay ? `${dayFmt.format(new Date(off))} ${fmtTime(off)} – ${fmtTime(on)}` : `${fmtDateTime(off)} – ${fmtDateTime(on)}`;
}
