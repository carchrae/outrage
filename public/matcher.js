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

  /** Compare the current matches with a saved snapshot ({items}). */
  function computeDiff(base, items, now) {
    const changes = { added: [], rescheduled: [], cancelled: [], updated: [], finished: [], removed: [], byId: {} };
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
      else if (p.text !== o.parsed.text) { changes.updated.push(o); changes.byId[o.id] = 'Address list updated'; }
    }
    const currentIds = new Set(items.map((i) => String(i.o.id)));
    for (const id of Object.keys(prev)) {
      if (currentIds.has(id)) continue;
      const p = prev[id];
      if (p.kind === 'current' || p.dateOn < now) changes.finished.push({ id, ...p });
      else changes.removed.push({ id, ...p });
    }
    return changes;
  }

  function countChanges(d) {
    return d.added.length + d.rescheduled.length + d.cancelled.length + d.updated.length + d.finished.length + d.removed.length;
  }

  return { collectMunis, ingestFeeds, statusOf, resolveMunis, homeMatches, snapshotOf, computeDiff, countChanges };
});
