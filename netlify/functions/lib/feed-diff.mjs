/*
 * Pure helpers for the hourly feed check: what changed between two copies of the BC Hydro
 * feeds, which streets each change touches, and which subscribers care. No I/O here so it
 * can be unit tested.
 */
import P from '../../../public/parse.js';

/** Keep only the fields needed to detect a change and name its streets. */
export function slimFeed(data, kind) {
  const out = [];
  for (const r of (data && data.regions) || []) {
    for (const o of r.outages || []) {
      out.push({ id: o.id, kind, municipality: o.municipality || '', area: o.area || '', dateOff: o.dateOff, dateOn: o.dateOn, lastUpdated: o.lastUpdated });
    }
  }
  return out;
}

export function collectMunis(...feeds) {
  const set = new Set();
  for (const data of feeds) {
    for (const r of (data && data.regions) || []) {
      for (const m of r.municipalities || []) set.add(typeof m === 'string' ? m : m.name);
      for (const o of r.outages || []) if (o.municipality) set.add(o.municipality);
    }
  }
  return [...set];
}

function same(a, b) {
  return a.dateOff === b.dateOff && a.dateOn === b.dateOn && a.area === b.area && a.lastUpdated === b.lastUpdated;
}

/**
 * Outages that were added, changed or removed between two slim lists.
 * @returns {Array<object & {change:'added'|'changed'|'removed'}>}
 */
export function diffFeeds(prev, next) {
  const key = (o) => o.kind + ':' + o.id;
  const prevBy = new Map(prev.map((o) => [key(o), o]));
  const nextBy = new Map(next.map((o) => [key(o), o]));
  const out = [];
  for (const [k, o] of nextBy) {
    const p = prevBy.get(k);
    if (!p) out.push({ ...o, change: 'added' });
    else if (!same(p, o)) out.push({ ...o, change: 'changed' });
  }
  for (const [k, p] of prevBy) if (!nextBy.has(k)) out.push({ ...p, change: 'removed' });
  return out;
}

/** Street keys an outage lists: [{ key, core, locality }], plus its municipality, all lower case. */
export function streetsOf(o, munis) {
  const parsed = P.parseArea(o.area, munis);
  return parsed.segments.filter((s) => s.key && !s.boundary).map((s) => ({ key: s.key, core: s.core, locality: (s.locality || '').toLowerCase() }));
}

/**
 * Normalise a subscriber record from the subscribe endpoint. Returns null when the street is unusable.
 * The street arrives already normalised by parse.js on the client; it is re-normalised here anyway.
 */
export function normaliseSubscription(body) {
  if (!body || typeof body !== 'object') return null;
  const sub = body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 2048) return null;
  if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return null;
  const street = P.streetKey(String(body.street || '').slice(0, 120));
  if (!street || /^\d+$/.test(street)) return null;
  const muni = String(body.muni || '').trim().toLowerCase().slice(0, 80);
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, street, core: P.coreKey(street), muni };
}

function muniMatches(subMuni, o, street) {
  if (!subMuni) return true;
  const m = (o.municipality || '').toLowerCase();
  return m.includes(subMuni) || (street.locality && street.locality.includes(subMuni));
}

/**
 * Keep only the outages that list a street someone subscribes to. The stored copy is then a few
 * outages rather than the whole province, and the diff only ever looks at streets that matter.
 * @returns {{outages: object[], cores: string[]}} the pruned list and the street cores it covers
 */
export function pruneToSubscribers(outages, subs, munis) {
  const cores = new Set(subs.map((s) => s.core));
  const kept = outages.filter((o) => streetsOf(o, munis).some((st) => cores.has(st.core)));
  return { outages: kept, cores: [...cores].sort() };
}

/**
 * Which subscribers each change touches.
 * @param {object[]} subs normalised subscriber records (with an `id`)
 * @param {object[]} changed from diffFeeds
 * @param {string[]} munis known municipalities (for parsing)
 * @param {Set<string>} [knownCores] street cores the previous copy covered; subscribers outside it are skipped
 * @returns {Map<string, {sub:object, ids:number[], kinds:Set<string>}>}
 */
export function pickSubscribers(subs, changed, munis, knownCores) {
  const hits = new Map();
  if (!subs.length || !changed.length) return hits;
  const byCore = new Map();
  for (const sub of subs) {
    // A street that was not in the previous copy has no baseline yet: its outages only look "added".
    if (knownCores && !knownCores.has(sub.core)) continue;
    if (!byCore.has(sub.core)) byCore.set(sub.core, []);
    byCore.get(sub.core).push(sub);
  }
  for (const o of changed) {
    for (const street of streetsOf(o, munis)) {
      for (const sub of byCore.get(street.core) || []) {
        if (!muniMatches(sub.muni, o, street)) continue;
        if (!hits.has(sub.id)) hits.set(sub.id, { sub, ids: [], kinds: new Set() });
        const h = hits.get(sub.id);
        if (!h.ids.includes(o.id)) { h.ids.push(o.id); h.kinds.add(o.kind); }
      }
    }
  }
  return hits;
}
