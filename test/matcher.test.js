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
