const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/parse.js');

const MUNIS = ['Burnaby', 'Mackenzie', 'Prince George', 'Abbotsford', 'Coldstream', '100 Mile House'];

test('splits comma lists and ranges into street segments', () => {
  const p = P.parseArea('2818, 2823 Crossley Dr; 31435 - 31482 Jean Crt; 3040, 3008 Townline Rd, Abbotsford', MUNIS);
  assert.equal(p.segments.length, 3);
  assert.deepEqual(p.segments[0].numbers.map((n) => [n.lo, n.hi]), [[2818, 2818], [2823, 2823]]);
  assert.deepEqual(p.segments[1].numbers.map((n) => [n.lo, n.hi]), [[31435, 31482]]);
  assert.equal(p.segments[2].street, 'Townline Rd');
  assert.equal(p.segments[2].locality, 'Abbotsford');
  assert.equal(p.notes.length, 0);
});

test('extracts bold notes and flags', () => {
  const p = P.parseArea('<b>*CANCELLED*</b><br/>26770 29th Ave, Aldergrove', MUNIS);
  assert.deepEqual(p.notes, ['*CANCELLED*']);
  assert.equal(p.flags.cancelled, true);
  assert.equal(p.segments.length, 1);
  assert.equal(p.segments[0].key, '29 ave');
  const r = P.parseArea('<b>Rescheduled from Sep 25</b><br/>268,270,272 Beddis Rd', MUNIS);
  assert.equal(r.flags.rescheduled, true);
  assert.equal(r.segments[0].numbers.length, 3);
});

test('bold text that is itself an address list is parsed, and Cont\'d is flagged', () => {
  const p = P.parseArea("<b>Cont'd..12845-12941 Lakeview Dr, 12839-12914 Grouse Crs", MUNIS);
  assert.equal(p.flags.continued, true);
  assert.equal(p.notes.length, 0);
  assert.equal(p.segments[0].street, 'Lakeview Dr');
  assert.equal(p.segments[1].key, 'grouse cres');
});

test('bold operational notes starting with a number stay notes', () => {
  const p = P.parseArea('<b>1 to 2 Short Duration Outages - Approximately 15 minutes each</b><br/>17340 Kennedy Rd', MUNIS);
  assert.equal(p.notes.length, 1);
  assert.equal(p.segments.length, 1);
});

test('parenthetical qualifiers and multi-line unit lists', () => {
  const p = P.parseArea('15401 Kalamalka Lake Rd., Coldstream \r\n(Unit 150, 202, 203)', MUNIS);
  assert.equal(p.segments.length, 1);
  assert.equal(p.segments[0].qualifier, 'Unit 150, 202, 203');
  assert.equal(p.segments[0].locality, 'Coldstream');
  const q = P.parseArea('3410 - 3456 Boundary Rd (evens only); 3717 - 3737 Linwood St (odds only)', MUNIS);
  assert.equal(P.numberListed(3412, q.segments[0]), true);
  assert.equal(P.numberListed(3413, q.segments[0]), false);
  assert.equal(P.numberListed(3719, q.segments[1]), true);
});

test('newlines inside a list are soft wraps', () => {
  const p = P.parseArea('10640, 10651, \r\n10680, 10691 Ashcroft Ave', MUNIS);
  assert.equal(p.segments.length, 1);
  assert.equal(p.segments[0].numbers.length, 4);
});

test('street key normalisation', () => {
  assert.equal(P.streetKey('15th Avenue'), '15 ave');
  assert.equal(P.streetKey('Kraft Crescent'), P.streetKey('Kraft Cres'));
  assert.equal(P.streetKey('Yorston Crt'), P.streetKey('Yorston Court'));
  assert.equal(P.streetKey('N. Greeny Lake Rd'), 'n greeny lake rd');
  assert.equal(P.coreKey('w 42 ave'), '42');
});

test('parseQuery handles units, postal codes and municipalities', () => {
  let q = P.parseQuery('204-7730 15th Ave, Burnaby BC V5E 1A1', MUNIS);
  assert.equal(q.unit, '204');
  assert.equal(q.number, 7730);
  assert.equal(q.key, '15 ave');
  assert.equal(q.muni, 'Burnaby');
  q = P.parseQuery('Kraft Cres Burnaby', MUNIS);
  assert.equal(q.number, null);
  assert.equal(q.key, 'kraft cres');
  assert.equal(q.muni, 'Burnaby');
  q = P.parseQuery('30 Ave', MUNIS);
  assert.equal(q.number, null);
  assert.equal(q.key, '30 ave');
  q = P.parseQuery('Prince George', MUNIS);
  assert.equal(q.muni, 'Prince George');
  assert.equal(q.key, '');
});

test('matchOutage ranks listed address above street-only and fuzzy', () => {
  const parsed = P.parseArea('7420-7591 Kraft Cres, 7470-7586 Kraft Pl, 7260 Winston St', MUNIS);
  const listed = P.matchOutage(P.parseQuery('7500 Kraft Crescent', MUNIS), parsed);
  assert.equal(listed.level, 5);
  assert.equal(listed.segment.street, 'Kraft Cres');
  const notListed = P.matchOutage(P.parseQuery('7000 Kraft Cres', MUNIS), parsed);
  assert.equal(notListed.level, 3);
  assert.equal(notListed.numberListed, false);
  const streetOnly = P.matchOutage(P.parseQuery('Kraft Pl', MUNIS), parsed);
  assert.equal(streetOnly.level, 4);
  const typo = P.matchOutage(P.parseQuery('7270 Winstin St', MUNIS), parsed);
  assert.ok(typo && typo.level < 5);
  assert.equal(P.matchOutage(P.parseQuery('Main St', MUNIS), parsed), null);
});

test('house numbers match anywhere inside a listed range, and Road/Rd are equivalent', () => {
  const parsed = P.parseArea('1160-1705 Adams Rd, Bowen Island', MUNIS);
  for (const q of ['1400 Adams Road', '1160 Adams Rd', '1705 ADAMS RD.', '1400 adams road']) {
    const m = P.matchOutage(P.parseQuery(q, MUNIS), parsed);
    assert.equal(m.level, 5, q);
    assert.equal(m.numberListed, true, q);
  }
  assert.equal(P.matchOutage(P.parseQuery('1706 Adams Road', MUNIS), parsed).numberListed, false);
  // Same name but a different street type is only a weak match.
  const cres = P.matchOutage(P.parseQuery('1400 Adams Crescent', MUNIS), parsed);
  assert.ok(cres.level < 5);
  // A bare name without a type still matches fully.
  assert.equal(P.matchOutage(P.parseQuery('1400 Adams', MUNIS), parsed).level, 5);
});

test('unplanned-outage area styles: hundred blocks and boundary streets', () => {
  const p = P.parseArea('3700 block BEAVER VALLEY RD, BEAVER VALLEY RD-P117', MUNIS);
  assert.equal(p.segments[0].key, 'beaver valley rd');
  assert.deepEqual([p.segments[0].numbers[0].lo, p.segments[0].numbers[0].hi], [3700, 3799]);
  assert.equal(P.matchOutage(P.parseQuery('3750 Beaver Valley Road', MUNIS), p).level, 5);
  assert.equal(P.matchOutage(P.parseQuery('3850 Beaver Valley Road', MUNIS), p).numberListed, false);
  const b = P.parseArea('North of 64 AVE, East of KILBURN PL, South of COMBER WAY, West of KING GEORGE BLV', MUNIS);
  assert.equal(b.segments.length, 4);
  assert.equal(b.segments[0].boundary, 'North');
  assert.equal(b.segments[0].key, '64 ave');
  assert.equal(b.segments[0].label, 'North of 64 AVE');
  // A boundary street is never a strong match.
  assert.ok(P.matchOutage(P.parseQuery('6400 64 Ave', MUNIS), b).level <= 2);
});

test('street-only list inside a bold note: any house number matches, slashes expand', () => {
  const area = "<b>Some premises on the following Streets will be impacted by this outage.\r\nAdams Rd, Arbutus Bay Ln/Rd, Cardena Dr/Rd, Park Rd/View Ln, Radar Hill, Grafton Rd, Green Rd, Highland Trail,</b><br/>Hilltop Pl, Sunset Dr/Ln/Rd";
  const p = P.parseArea(area, ['Bowen Island']);
  assert.deepEqual(p.notes, ['Some premises on the following Streets will be impacted by this outage.']);
  const labels = p.segments.map((s) => s.label);
  assert.deepEqual(labels, ['Adams Rd', 'Arbutus Bay Ln', 'Arbutus Bay Rd', 'Cardena Dr', 'Cardena Rd', 'Park Rd', 'Park View Ln', 'Radar Hill', 'Grafton Rd', 'Green Rd', 'Highland Trail', 'Hilltop Pl', 'Sunset Dr', 'Sunset Ln', 'Sunset Rd']);
  assert.ok(p.segments.every((s) => s.numbers.length === 0 && s.locality === ''));
  for (const q of ['1400 Adams Rd', '99 Adams Road', 'Adams Rd', '1 Cardena Rd', 'Park View Ln', 'Radar Hill']) {
    const m = P.matchOutage(P.parseQuery(q, ['Bowen Island']), p);
    assert.ok(m, q + ' should match');
    assert.equal(m.level, 4, q);
    assert.equal(m.streetScore, 3, q);
    assert.equal(m.numberListed, null, q);
  }
  // Numbered listings still work exactly as before.
  const p2 = P.parseArea('1160-1705 Adams Rd, Bowen Island', ['Bowen Island']);
  assert.equal(P.matchOutage(P.parseQuery('1400 Adams Road', ['Bowen Island']), p2).level, 5);
  assert.equal(P.matchOutage(P.parseQuery('1800 Adams Road', ['Bowen Island']), p2).level, 3);
});
