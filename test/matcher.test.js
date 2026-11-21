const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../public/matcher.js');

const feed = (outages, munis) => ({ regions: [{ id: 1, name: 'R', municipalities: munis, outages }] });
const o = (id, area, muni, extra) => ({ id, municipality: muni, area, dateOff: 1000, dateOn: 2000, numCustomersOut: 5, ...extra });

test('homeMatches: street-only listing is a strong match for any house number', () => {
  const fed = M.ingestFeeds(feed([o(1, '<b>Some premises on the following streets.\nAdams Rd, Cardena Dr/Rd</b>', 'Bowen Island'), o(2, '1-9 Adams Rd', 'Burnaby')], ['Bowen Island', 'Burnaby']), null);
  const m = M.homeMatches(fed.outages, fed.munis, { address: '1400 Adams Rd', muni: 'Bowen Island' }, 500, false);
  assert.deepEqual(m.strong.map((i) => i.o.id), [1]);
  assert.equal(m.strong[0].match.numberListed, null);
});

test('computeDiff flags new, rescheduled, cancelled, removed and finished outages', () => {
  const before = M.ingestFeeds(feed([o(1, '1-9 Adams Rd', 'B'), o(2, '1-9 Adams Rd', 'B'), o(3, '1-9 Adams Rd', 'B', { dateOff: 10, dateOn: 20 }), o(4, '1-9 Adams Rd', 'B')], ['B']), null);
  const home = { address: '5 Adams Rd', muni: 'B' };
  const snap = { at: 1, items: M.snapshotOf(M.homeMatches(before.outages, before.munis, home, 5, true).strong) };
  const after = M.ingestFeeds(feed([o(1, '1-9 Adams Rd', 'B', { dateOff: 1500 }), o(2, '<b>Cancelled</b><br/>1-9 Adams Rd', 'B'), o(5, '1-9 Adams Rd', 'B')], ['B']), null);
  const now = 500;
  const d = M.computeDiff(snap, M.homeMatches(after.outages, after.munis, home, now, true).strong, now);
  assert.deepEqual(d.added.map((x) => x.id), [5]);
  assert.deepEqual(d.rescheduled.map((x) => x.o.id), [1]);
  assert.deepEqual(d.cancelled.map((x) => x.id), [2]);
  assert.deepEqual(d.finished.map((x) => x.id), ['3']);
  assert.deepEqual(d.removed.map((x) => x.id), ['4']);
  assert.equal(M.countChanges(d), 5);
});

test('computeDiff reports a relisted outage as rescheduled, and a cancelled one dropping off as nothing', () => {
  const day = (d, h) => Date.UTC(2026, 10, d, h + 7); // BC time: UTC-7 all year from 2026
  const home = { address: '5 Adams Rd', muni: 'B' };
  const before = M.ingestFeeds(feed([o(10, '1-9 Adams Rd', 'B', { dateOff: day(7, 8), dateOn: day(7, 16) }), o(11, '<b>Cancelled</b><br/>1-9 Adams Rd', 'B', { dateOff: day(8, 8), dateOn: day(8, 16) })], ['B']), null);
  const snap = { at: 1, items: M.snapshotOf(M.homeMatches(before.outages, before.munis, home, day(6, 0), true).strong) };
  const after = M.ingestFeeds(feed([o(20, '<b>*Rescheduled from November 7, 2026*</b><br/>1-9 Adams Rd', 'B', { dateOff: day(19, 8), dateOn: day(19, 16) })], ['B']), null);
  const now = day(14, 0);
  const d = M.computeDiff(snap, M.homeMatches(after.outages, after.munis, home, now, true).strong, now);
  assert.deepEqual(d.rescheduled.map((x) => [x.o.id, x.wasId]), [[20, '10']]);
  assert.equal(d.byId[20], 'Rescheduled');
  assert.deepEqual([d.added.length, d.finished.length, d.removed.length], [0, 0, 0]);
});

test('bcFormat shows BC time as UTC-7 after the 2026 change, whatever the runtime time zone data', () => {
  const t = M.bcFormat({ hour: 'numeric', minute: '2-digit', hour12: true });
  assert.match(t.format(new Date(Date.UTC(2026, 10, 19, 15))), /^8:00/); // Nov 19 2026: UTC-7
  assert.match(t.format(new Date(Date.UTC(2026, 6, 1, 15))), /^8:00/); // Jul 1 2026: UTC-7
  assert.match(t.format(new Date(Date.UTC(2025, 11, 1, 16))), /^8:00/); // Dec 1 2025: still UTC-8
});

test('ingestFeeds: planned work that has started, listed in the current feed, is flagged as planned work', () => {
  const cur = feed([
    o(1, 'North of WILLIES WAY, South-East of ADAMS RD', 'Bowen Island', { cause: 'Planned work being done on our equipment' }),
    o(2, 'ADAMS RD', 'Bowen Island', { cause: 'Tree down' }),
    o(3, 'COWAN RD', 'Bowen Island', { cause: 'Unplanned work' }),
  ], ['Bowen Island']);
  const fed = M.ingestFeeds(feed([], ['Bowen Island']), cur);
  assert.deepEqual(fed.current.map((x) => x.plannedWork), [true, false, false]);
});

test('a planned outage stays listed until the end of the day it ended, then is hidden', () => {
  const end = Date.UTC(2026, 10, 19, 23); // 4pm BC time (UTC-7)
  const fed = M.ingestFeeds(feed([o(1, '1-9 Adams Rd', 'B', { dateOff: end - 8 * 3600e3, dateOn: end })], ['B']), null);
  const ids = (now, past) => M.homeMatches(fed.outages, fed.munis, { address: '5 Adams Rd', muni: 'B' }, now, past).strong.map((i) => i.o.id);
  const lateEvening = Date.UTC(2026, 10, 20, 6, 59); // 11:59pm BC time
  assert.equal(M.statusOf(fed.outages[0], end + 3600e3), 'finished');
  assert.deepEqual(ids(end + 3600e3, false), [1]);
  assert.deepEqual(ids(lateEvening, false), [1]);
  assert.deepEqual(ids(lateEvening + 120e3, false), []); // 12:01am the next day
  assert.deepEqual(ids(lateEvening + 120e3, true), [1]);
});

test('homeMatches: a live outage spanning several municipalities counts as in each of them', () => {
  const cur = feed([o(2869531, 'South of CARTER RD, West of GLENWYND PL', 'Bowen Island, West Vancouver', { municipalities: ['Bowen Island', 'West Vancouver'], cause: 'Planned work being done on our equipment' })], ['Bowen Island', 'West Vancouver']);
  const fed = M.ingestFeeds(feed([], ['Bowen Island', 'West Vancouver']), cur);
  const m = M.homeMatches(fed.outages.concat(fed.current), fed.munis, { address: '5 Adams Rd', muni: 'Bowen Island' }, 500, false);
  assert.deepEqual(m.nearby.map((i) => i.o.id), [2869531]);
});

test('collectMunis: an outage spanning municipalities adds each one, not the joined name', () => {
  const cur = { regions: [{ id: 1, name: 'R', municipalities: [], outages: [{ id: 1, municipality: 'Delta, Richmond', municipalities: ['Delta', 'Richmond'] }, { id: 2, municipality: 'Coquitlam, Port Moody' }] }] };
  assert.deepEqual(M.collectMunis(null, cur), ['Coquitlam', 'Delta', 'Port Moody', 'Richmond']);
});

test('insidePolygon and outagesAt: inside, near the edge within the accuracy, or not at all', () => {
  // A square about 1.1 km a side near Snug Cove, as BC Hydro sends it: flat [lon, lat, ...].
  const sq = [-123.34, 49.38, -123.325, 49.38, -123.325, 49.39, -123.34, 49.39, -123.34, 49.38];
  assert.equal(M.insidePolygon(sq, -123.33, 49.385), true);
  assert.equal(M.insidePolygon(sq, -123.30, 49.385), false);
  assert.equal(M.insidePolygon([], -123.33, 49.385), false);
  const outages = [{ id: 1, polygon: sq }, { id: 2, polygon: [] }, { id: 3 }];
  assert.deepEqual(M.outagesAt(outages, 49.385, -123.33, 20).map((x) => [x.o.id, x.where]), [[1, 'inside']]);
  // 0.003 degrees of longitude east of the edge is about 220 m: near with a 300 m accuracy, not with 50 m.
  assert.deepEqual(M.outagesAt(outages, 49.385, -123.322, 300).map((x) => [x.o.id, x.where]), [[1, 'near']]);
  assert.deepEqual(M.outagesAt(outages, 49.385, -123.322, 50), []);
  assert.deepEqual(M.outagesAt(outages, 49.385, -123.20, 50000), [], 'accuracy is capped at 1 km');
});
