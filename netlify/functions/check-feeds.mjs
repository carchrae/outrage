/*
 * Scheduled function, every 10 minutes: fetch both BC Hydro feeds, diff them against the copy kept from
 * the previous run, and push to the subscribers whose street is listed by an outage that was
 * added, changed or removed. The push payload only carries outage ids; the service worker on
 * the device does the real matching against the saved address.
 *
 * Needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (a mailto: or https: URL) in the
 * site's environment. Generate a key pair with `npm run vapid`.
 */
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { slimFeed, collectMunis, diffFeeds, pickSubscribers, pruneToSubscribers } from './lib/feed-diff.mjs';

export const config = { schedule: '*/10 * * * *' };

const FEEDS = {
  planned: 'https://www.bchydro.com/power-outages/app/outages-list-data-planned.json',
  current: 'https://www.bchydro.com/power-outages/app/outages-list-data-current.json',
};
const LAST_KEY = 'feeds/last';
const MAX_FAILURES = 3;
const CONCURRENCY = 8;

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

export async function run({ store, send, log = console.log, now = Date.now() }) {
  const [planned, current] = await Promise.all([fetchJSON(FEEDS.planned), fetchJSON(FEEDS.current).catch((e) => { log('current feed failed: ' + e.message); return null; })]);
  const munis = collectMunis(planned, current);
  const all = slimFeed(planned, 'planned').concat(current ? slimFeed(current, 'current') : []);

  const { blobs } = await store.list({ prefix: 'sub/' });
  const subs = (await mapLimit(blobs, CONCURRENCY, async (b) => {
    const rec = await store.get(b.key, { type: 'json' }).catch(() => null);
    return rec && rec.endpoint ? { ...rec, id: b.key } : null;
  })).filter(Boolean);

  // Only outages on subscribed streets are kept between runs; the copy records which streets it covers.
  const next = pruneToSubscribers(all, subs, munis);
  const prev = await store.get(LAST_KEY, { type: 'json' }).catch(() => null);
  await store.setJSON(LAST_KEY, { at: now, outages: next.outages, cores: next.cores });
  if (!prev || !Array.isArray(prev.outages)) { log('first run: stored feed copy, nothing to compare'); return { changed: 0, pushed: 0, first: true }; }

  // When the unplanned feed failed this run, do not report every unplanned outage as removed.
  const prevOutages = current ? prev.outages : prev.outages.filter((o) => o.kind !== 'current');
  const changed = diffFeeds(prevOutages, next.outages);
  if (!changed.length) { log(`no changes on ${next.cores.length} subscribed streets`); return { changed: 0, pushed: 0 }; }

  const hits = pickSubscribers(subs, changed, munis, new Set(prev.cores || []));
  log(`${changed.length} changed outages, ${subs.length} subscribers, ${hits.size} to notify`);

  let pushed = 0, dropped = 0;
  await mapLimit([...hits.values()], CONCURRENCY, async ({ sub, ids, kinds }) => {
    const payload = JSON.stringify({ ids: ids.slice(0, 50), kinds: [...kinds], at: now });
    try {
      await send({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      pushed++;
      if (sub.failures) await store.setJSON(sub.id, { ...stripId(sub), failures: 0 });
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410 || (sub.failures || 0) + 1 >= MAX_FAILURES) { await store.delete(sub.id); dropped++; }
      else await store.setJSON(sub.id, { ...stripId(sub), failures: (sub.failures || 0) + 1, lastError: String(code || err.message) });
    }
  });
  log(`pushed ${pushed}, dropped ${dropped}`);
  return { changed: changed.length, pushed, dropped };
}

function stripId(sub) { const { id, ...rest } = sub; return rest; }

export default async () => {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  const store = getStore('push');
  let send;
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    send = (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'normal' });
  } else {
    console.log('VAPID keys not configured: tracking feed changes but not pushing');
    send = async () => {};
  }
  const result = await run({ store, send });
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
