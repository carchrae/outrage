/*
 * Shared matching and change-detection logic for Outage.
 *
 * Used by the page (app.js), the service worker (sw.js) and tests, so the
 * notification a push produces agrees with what the page shows.
 *
 * Works in the browser (window.OutageMatcher), in a worker (self.OutageMatcher)
 * and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./parse.js'));
  else root.OutageMatcher = factory(root.OutageParser);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  /** Every municipality named by either feed, sorted. */
  function collectMunis(planned, current) {
    const set = new Set();
    for (const data of [planned, current]) {
      for (const r of (data && data.regions) || []) {
        for (const m of r.municipalities || []) set.add(typeof m === 'string' ? m : m.name);
        for (const o of r.outages || []) if (o.municipality) set.add(o.municipality);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /** Flatten both feeds into tagged, parsed outage lists. */
  function ingestFeeds(planned, current) {
    const munis = collectMunis(planned, current);
    const flat = (data, kind) => {
      const out = [];
      for (const r of (data && data.regions) || []) {
        for (const o of r.outages || []) out.push({ ...o, kind, regionName: o.regionName || r.name, regionId: r.id, related: [], parsed: P.parseArea(o.area, munis) });
      }
      return out;
    };
    return { munis, outages: flat(planned, 'planned'), current: flat(current, 'current') };
  }

  function statusOf(o, now) {
    if (o.kind === 'current') return 'in progress';
    if (o.parsed.flags.cancelled) return 'cancelled';
    if (now < o.dateOff) return 'upcoming';
    if (now <= o.dateOn) return 'in progress';
    return 'finished';
  }

  /** Municipality names matching free text: exact name first, otherwise any name containing the text. */
  function resolveMunis(munis, text) {
    const t = (text || '').trim().toLowerCase();
    if (!t) return null;
    const exact = munis.filter((m) => m.toLowerCase() === t);
    if (exact.length) return new Set(exact.map((m) => m.toLowerCase()));
    const partial = munis.filter((m) => m.toLowerCase().includes(t));
    return new Set(partial.map((m) => m.toLowerCase()));
  }

  /**
   * Match a saved address against every outage.
   * @param {object[]} all planned and current outages (from ingestFeeds)
   * @param {string[]} munis known municipalities
   * @param {{address:string, muni?:string}} home
   * @param {number} now
   * @param {boolean} includePast keep finished planned outages
   * @returns {{q:object, strong:object[], weak:object[], nearby:object[]}}
   */
  function homeMatches(all, munis, home, now, includePast) {
    const q = P.parseQuery(home.address, munis);
    const muniSet = resolveMunis(munis, home.muni || q.muni);
    const strong = [], weak = [], nearby = [];
    for (const o of all) {
      if (!includePast && statusOf(o, now) === 'finished') continue;
      const match = P.matchOutage(q, o.parsed);
      const muniMatch = !!muniSet && (muniSet.has(o.municipality.toLowerCase()) || (match && muniSet.has(match.segment.locality.toLowerCase())));
      if (!match) { if (o.kind === 'current' && muniMatch) nearby.push({ o, match: null, muniMatch: true }); continue; }
      if (muniSet && !muniMatch) continue;
      if (match.streetScore >= 2 && !match.segment.boundary) strong.push({ o, match, muniMatch: true });
      else if (o.kind === 'current' && muniMatch) nearby.push({ o, match, muniMatch: true });
      else weak.push({ o, match, muniMatch: true });
    }
    strong.sort((a, b) => ((a.o.kind === 'current' ? 0 : 1) - (b.o.kind === 'current' ? 0 : 1)) || (b.match.level - a.match.level) || (a.o.dateOff - b.o.dateOff));
    return { q, strong, weak, nearby };
  }

  /** What is remembered about each matched outage so a later visit can tell what changed. */
  function snapshotOf(items) {
    const out = {};
    for (const { o, match } of items) {
      out[o.id] = { kind: o.kind, dateOff: o.dateOff, dateOn: o.dateOn, cancelled: o.parsed.flags.cancelled, listed: match.numberListed, text: o.parsed.text };
    }
    return out;
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  /*
   * British Columbia time. BC stopped changing clocks in 2026: since 2026-03-08 it stays on UTC-7 all year
   * (IANA tzdata 2026b). Older time zone data (an outdated phone, or a Node build with old ICU) still turns the
   * clocks back on 2026-11-01, an hour wrong. That is detected by asking for Vancouver's offset after that date;
   * when outdated, times from the change on are formatted in a fixed UTC-7 zone instead.
   */
  const BC_PERMANENT = Date.UTC(2026, 2, 8, 10); // 2am PST, Sunday Mar 8 2026
  const tzOutdated = (() => {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', hourCycle: 'h23' }).format(new Date(Date.UTC(2026, 11, 1, 20))) === '12'; } catch (e) { return false; }
  })();
  /** Like new Intl.DateTimeFormat('en-CA', options) in BC time, correct even with outdated time zone data. */
  function bcFormat(options) {
    const live = new Intl.DateTimeFormat('en-CA', Object.assign({}, options, { timeZone: 'America/Vancouver' }));
    const fixed = tzOutdated ? new Intl.DateTimeFormat('en-CA', Object.assign({}, options, { timeZone: 'Etc/GMT+7' })) : live;
    const pick = (d) => (+d >= BC_PERMANENT ? fixed : live);
    return { format: (d) => pick(d).format(d), formatToParts: (d) => pick(d).formatToParts(d) };
  }
  const dayFmt = bcFormat({ month: 'numeric', day: 'numeric' });

  /** The day a listing says it was rescheduled from ("*Rescheduled from November 7, 2026*"), as "11-7"; '' if none. */
  function rescheduledFrom(o) {
    for (const n of (o.parsed && o.parsed.notes) || []) {
      const r = n.replace(/\*+/g, '').match(/resched\w*\b.*?\bfrom\s+(.+)/i);
      const d = r && r[1].match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/i);
      if (d) return `${MONTHS.indexOf(d[1].toLowerCase()) + 1}-${Number(d[2])}`;
    }
    return '';
  }
  function dayOf(ms) {
    const parts = dayFmt.formatToParts(new Date(ms));
    return `${Number(parts.find((x) => x.type === 'month').value)}-${Number(parts.find((x) => x.type === 'day').value)}`;
  }

  /**
   * Compare the current matches with a saved snapshot ({items}).
   * BC Hydro reschedules by listing a new outage ("Rescheduled from November 7") and dropping the old one; that
   * pair is reported once, as rescheduled with `wasId`, not as a new outage plus a finished one.
   * A cancelled listing that drops off is not news (its cancellation was), so it is not reported as finished.
   */
  function computeDiff(base, items, now) {
    const changes = { added: [], rescheduled: [], cancelled: [], updated: [], finished: [], removed: [], byId: {}, prevText: {} };
    if (!base || !base.items) return changes;
    const prev = base.items;
    for (const { o } of items) {
      const p = prev[o.id];
      if (!p) { changes.added.push(o); changes.byId[o.id] = o.kind === 'current' ? 'New unplanned outage' : 'New'; continue; }
      if (o.kind === 'current') {
        if (p.dateOn !== o.dateOn || p.text !== o.parsed.text) { changes.updated.push(o); changes.byId[o.id] = 'Updated'; }
        continue;
      }
      if (!p.cancelled && o.parsed.flags.cancelled) { changes.cancelled.push(o); changes.byId[o.id] = 'Now cancelled'; }
      else if (p.dateOff !== o.dateOff || p.dateOn !== o.dateOn) { changes.rescheduled.push({ o, was: p }); changes.byId[o.id] = 'Time changed'; }
      else if (p.text !== o.parsed.text) { changes.updated.push(o); changes.prevText[o.id] = p.text; changes.byId[o.id] = 'Street list changed'; }
    }
    const currentIds = new Set(items.map((i) => String(i.o.id)));
    const gone = Object.keys(prev).filter((id) => !currentIds.has(id)).map((id) => ({ id, ...prev[id] }));
    // Pair a new "rescheduled from <day>" listing with a dropped listing that was on that day.
    for (const o of changes.added.slice()) {
      const from = o.kind === 'planned' && rescheduledFrom(o);
      const k = from ? gone.findIndex((p) => p.kind === 'planned' && dayOf(p.dateOff) === from) : -1;
      if (k < 0) continue;
      const [p] = gone.splice(k, 1);
      changes.added.splice(changes.added.indexOf(o), 1);
      changes.rescheduled.push({ o, was: p, wasId: p.id });
      changes.byId[o.id] = 'Rescheduled';
    }
    for (const p of gone) {
      if (p.kind === 'planned' && p.cancelled) continue;
      if (p.kind === 'current' || p.dateOn < now) changes.finished.push(p);
      else changes.removed.push(p);
    }
    return changes;
  }

  function countChanges(d) {
    return d.added.length + d.rescheduled.length + d.cancelled.length + d.updated.length + d.finished.length + d.removed.length;
  }

  return { collectMunis, ingestFeeds, statusOf, resolveMunis, homeMatches, snapshotOf, computeDiff, countChanges, rescheduledFrom, bcFormat, tzOutdated };
});
