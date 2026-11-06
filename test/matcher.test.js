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
