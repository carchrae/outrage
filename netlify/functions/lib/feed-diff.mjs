/*
 * Pure helpers for the 10-minute feed check: what changed between two copies of the BC Hydro
 * feeds, which streets each change touches, and which subscribers care. No I/O here so it
 * can be unit tested.
 */
import P from '../../../public/parse.js';

/** Keep only the fields needed to detect a change and name its streets. */
export function slimFeed(data, kind) {
  const out = [];
  for (const r of (data && data.regions) || []) {
    for (const o of r.outages || []) {
      const rec = { id: o.id, kind, municipality: o.municipality || '', area: o.area || '', dateOff: o.dateOff, dateOn: o.dateOn, lastUpdated: o.lastUpdated };
      if (kind === 'current') { rec.crew = o.crewStatusDescr || ''; rec.customers = o.numCustomersOut; rec.cause = o.cause || ''; }
      else if (/cancel/i.test(o.area)) rec.cancelled = true;
      out.push(rec);
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
  return a.dateOff === b.dateOff && a.dateOn === b.dateOn && a.area === b.area && a.lastUpdated === b.lastUpdated && (a.crew || '') === (b.crew || '');
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
    else if (!same(p, o)) out.push({ ...o, change: 'changed', was: { dateOff: p.dateOff, dateOn: p.dateOn, crew: p.crew, cancelled: p.cancelled } });
  }
  for (const [k, p] of prevBy) if (!nextBy.has(k)) out.push({ ...p, change: 'removed' });
  return out;
}

/** Street keys an outage lists: [{ key, core, locality }], plus its municipality, all lower case. */
export function streetsOf(o, munis) {
  const parsed = P.parseArea(o.area, munis);
  return parsed.segments.filter((s) => s.key && !s.boundary).map((s) => ({ key: s.key, core: s.core, street: s.street, locality: (s.locality || '').toLowerCase() }));
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
  const muni = String(body.muni || '').trim().toLowerCase().slice(0, 80);
  // Topics: 'street' (outages listing the street) and/or 'muni' (every outage in the municipality). Default: street.
  const asked = Array.isArray(body.topics) ? body.topics.filter((t) => t === 'street' || t === 'muni') : ['street'];
  const topics = [...new Set(asked)].filter((t) => (t === 'street' ? street && !/^\d+$/.test(street) : !!muni));
  if (!topics.length) return null;
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, street, core: street ? P.coreKey(street) : '', muni, topics };
}

const wantsStreet = (sub) => !sub.topics || sub.topics.includes('street');
const wantsMuni = (sub) => !!sub.topics && sub.topics.includes('muni');
const muniOf = (o) => (o.municipality || '').toLowerCase();

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
  const cores = new Set(subs.filter(wantsStreet).map((s) => s.core).filter(Boolean));
  const towns = new Set(subs.filter(wantsMuni).map((s) => s.muni).filter(Boolean));
  const inTown = (o) => [...towns].some((t) => muniOf(o).includes(t));
  const kept = outages.filter((o) => inTown(o) || streetsOf(o, munis).some((st) => cores.has(st.core)));
  // Keys the copy covers: a subscriber whose key is new since the last run has no baseline yet.
  const keys = [...cores].map((c) => 'street:' + c).concat([...towns].map((t) => 'muni:' + t)).sort();
  return { outages: kept, cores: keys };
}

/**
 * Which subscribers each change touches.
 * @param {object[]} subs normalised subscriber records (with an `id`)
 * @param {object[]} changed from diffFeeds
 * @param {string[]} munis known municipalities (for parsing)
 * @param {Set<string>} [knownCores] street cores the previous copy covered; subscribers outside it are skipped
 * @returns {Map<string, {sub:object, ids:number[], kinds:Set<string>}>}
 */
export function pickSubscribers(subs, changed, munis, knownKeys) {
  const hits = new Map();
  if (!subs.length || !changed.length) return hits;
  // A key that was not in the previous copy has no baseline yet: its outages only look "added".
  const known = (k) => !knownKeys || knownKeys.has(k) || knownKeys.has(k.replace(/^street:/, '')); // older copies stored bare cores
  const byCore = new Map();
  const byTown = [];
  for (const sub of subs) {
    if (wantsStreet(sub) && sub.core && known('street:' + sub.core)) {
      if (!byCore.has(sub.core)) byCore.set(sub.core, []);
      byCore.get(sub.core).push(sub);
    }
    if (wantsMuni(sub) && sub.muni && known('muni:' + sub.muni)) byTown.push(sub);
  }
  const add = (sub, o, street, via) => {
    if (!hits.has(sub.id)) hits.set(sub.id, { sub, ids: [], kinds: new Set(), outages: [], street: street ? street.street : '' });
    const h = hits.get(sub.id);
    if (h.ids.includes(o.id)) return;
    h.ids.push(o.id); h.kinds.add(o.kind);
    h.outages.push({ ...o, via, label: street ? street.street : firstStreet(o, munis) });
    if (via === 'street' && !h.street) h.street = street.street;
  };
  for (const o of changed) {
    const streets = streetsOf(o, munis);
    for (const street of streets) {
      for (const sub of byCore.get(street.core) || []) if (muniMatches(sub.muni, o, street)) add(sub, o, street, 'street');
    }
    for (const sub of byTown) if (muniOf(o).includes(sub.muni) || streets.some((st) => st.locality.includes(sub.muni))) add(sub, o, null, 'muni');
  }
  return hits;
}

function firstStreet(o, munis) {
  const parsed = P.parseArea(o.area, munis);
  const seg = parsed.segments.find((s) => s.street);
  if (seg) return seg.label + (parsed.segments.length > 1 ? ` +${parsed.segments.length - 1}` : '');
  return parsed.text.slice(0, 40) || o.municipality;
}

// ---------------------------------------------------------------- notification text

const TZ = 'America/Vancouver';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtTime = (ms) => (Number.isFinite(ms) ? timeFmt.format(new Date(ms)).replace(/\./g, '').replace(/\s?([ap])m/i, ' $1.m.') : '?');
const fmtDateTime = (ms) => (Number.isFinite(ms) ? `${dayFmt.format(new Date(ms))} ${fmtTime(ms)}` : 'unknown time');
function fmtWindow(off, on) {
  if (!Number.isFinite(on)) return fmtDateTime(off);
  const sameDay = dayFmt.format(new Date(off)) === dayFmt.format(new Date(on));
  return sameDay ? `${dayFmt.format(new Date(off))} ${fmtTime(off)} – ${fmtTime(on)}` : `${fmtDateTime(off)} – ${fmtDateTime(on)}`;
}
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** One short line per changed outage, in plain words. Street-level only: the server never knows the house number. */
export function describeChange(o) {
  const w = o.was || {};
  if (o.kind === 'current') {
    const crew = o.crew ? `, ${o.crew.toLowerCase()}` : '';
    const n = o.customers != null ? `, ${o.customers} customer${o.customers === 1 ? '' : 's'}` : '';
    if (o.change === 'removed') return 'Unplanned outage resolved';
    if (o.change === 'added') return `Power out: unplanned outage${crew}${n}`;
    if (o.dateOn && o.dateOn !== w.dateOn) return `Unplanned outage: power expected back ${fmtDateTime(o.dateOn)}${crew}`;
    if (o.crew && o.crew !== w.crew) return `Unplanned outage: ${o.crew.toLowerCase()}${o.dateOn ? ', power expected back ' + fmtDateTime(o.dateOn) : ''}`;
    return `Unplanned outage updated${crew}${n}`;
  }
  const when = fmtWindow(o.dateOff, o.dateOn);
  if (o.change === 'removed') return `No longer listed: planned outage ${when}`;
  if (o.change === 'added') return `New planned outage: ${when}`;
  if (o.cancelled && !w.cancelled) return `Cancelled: planned outage ${when}`;
  if (o.dateOff !== w.dateOff || o.dateOn !== w.dateOn) return `Time changed: planned outage now ${when}`;
  return `Planned outage updated: ${when}`;
}

/** Title and body for one subscriber's push: the street and municipality, then up to four lines. */
export function notificationFor(hit) {
  const muni = hit.outages[0] && hit.outages[0].municipality ? hit.outages[0].municipality : titleCase(hit.sub.muni);
  const onStreet = hit.outages.some((o) => o.via !== 'muni');
  const street = titleCase(hit.street || hit.sub.street);
  const title = onStreet ? (muni ? `${street}, ${muni}` : street) : muni;
  // Street alerts first; municipality-wide ones name the street they are about.
  const ordered = hit.outages.slice().sort((a, b) => (a.via === 'muni') - (b.via === 'muni'));
  const lines = ordered.map((o) => (o.via === 'muni' ? `${titleCase(o.label)}: ${describeChange(o)}` : describeChange(o)));
  const body = lines.slice(0, 4).join('\n') + (lines.length > 4 ? `\n+${lines.length - 4} more` : '');
  return { title, body };
}
