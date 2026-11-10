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

test('a semicolon list of bare street names inside a bold note is parsed, not kept as a note', () => {
  const area = "<b>*Rescheduled from November 7, 2026* | Some premises on the following Streets will be impacted by this outage.\r\nAdams; Amelia; Anastasia; Arbutus Bay; Baker; Cates Hill; Elrond's; Forecastle</b><br/>Hilltop Pl, Woods Rd.";
  const p = P.parseArea(area, ['Bowen Island']);
  assert.deepEqual(p.notes, ['*Rescheduled from November 7, 2026* | Some premises on the following Streets will be impacted by this outage.']);
  assert.ok(p.flags.rescheduled);
  assert.deepEqual(p.segments.map((s) => s.label), ['Adams', 'Amelia', 'Anastasia', 'Arbutus Bay', 'Baker', 'Cates Hill', "Elrond's", 'Forecastle', 'Hilltop Pl', 'Woods Rd']);
  assert.equal(P.matchOutage(P.parseQuery('1400 Adams Rd', ['Bowen Island']), p).streetScore, 2);
  // A bold note whose sentences happen to be short is still a note.
  const n = P.parseArea('<b>Note: Crews on site; Expect delays; Bring a flashlight; Stay clear; Thank you</b><br/>1-9 Adams Rd', []);
  assert.equal(n.segments.length, 1);
});

test('a list of bare street names does not treat the last name as a locality', () => {
  const p = P.parseArea('<b>Parts of Bowen Island</b><br/>Adams, Amelia, Anastasia, Blue Sky Cir, Eagle Tree Rd, Windjammer', ['Bowen Island']);
  assert.deepEqual(p.segments.map((s) => s.label), ['Adams', 'Amelia', 'Anastasia', 'Blue Sky Cir', 'Eagle Tree Rd', 'Windjammer']);
  assert.ok(p.segments.every((s) => s.locality === ''));
  assert.equal(P.matchOutage(P.parseQuery('1400 Windjammer Rd', ['Bowen Island']), p).streetScore, 2);
  // A trailing municipality after numbered streets is still a locality.
  const q = P.parseArea('2232, 2261, 2820 108 Mile Rd, 4880 Bells Lake Rd, 5457 Kornelson Dr, Horsefly', []);
  assert.equal(q.segments.length, 3);
  assert.ok(q.segments.every((s) => s.locality === 'Horsefly'));
});

test('block ranges: "9500 - 9600 block X" covers 9500-9699', () => {
  const p = P.parseArea('9500 - 9600 block SHELEST DR, 700 - 800 block HORNBY RD, 0 block STUART DR', []);
  assert.deepEqual(p.segments.map((s) => [s.street, s.numbers[0].lo, s.numbers[0].hi]), [['SHELEST DR', 9500, 9699], ['HORNBY RD', 700, 899], ['STUART DR', 0, 99]]);
  assert.equal(P.matchOutage(P.parseQuery('9550 Shelest Dr', []), p).level, 5);
  assert.equal(P.matchOutage(P.parseQuery('9750 Shelest Dr', []), p).level, 3);
});

test('safety net: a street named only in notice text is a possible match, unless it names another street', () => {
  // The street list is buried in a note the parser keeps as prose.
  const p = P.parseArea('<b>Crews will replace a pole near Adams and Cates Hill. Expect a short outage.</b><br/>1-9 Miller Rd', ['Bowen Island']);
  const m = P.matchOutage(P.parseQuery('1400 Adams Rd', ['Bowen Island']), p);
  assert.ok(m && m.mention, 'Adams in a note should be a possible match');
  assert.equal(m.level, 1);
  assert.ok(m.streetScore < 2, 'never a strong match');
  assert.ok(P.matchOutage(P.parseQuery('Adams Road', []), P.parseArea('<b>Work on Adams Rd. today</b>', [])).mention);
  // Another street type or a longer name is a different street.
  for (const area of ['<b>Work near Adams St today</b>', '<b>Work near Adams Lake Rd today</b>', '<b>Work near Adamson today</b>']) {
    assert.equal(P.matchOutage(P.parseQuery('1400 Adams Rd', []), P.parseArea(area, [])), null, area);
  }
  // A bare number is not a numbered street.
  assert.equal(P.matchOutage(P.parseQuery('15 Ave', []), P.parseArea('<b>About 15 customers affected</b>', [])), null);
  // A parsed match always wins over a mention.
  assert.ok(!P.matchOutage(P.parseQuery('1400 Adams Rd', []), P.parseArea('1-9 Adams Rd', [])).mention);
});

test('safety net catches a street list the parser kept as a note', () => {
  // Before the bare-name list fix this whole list was a note; the mention still finds Adams.
  const p = { segments: [], text: '', notes: ['Some premises will be impacted by this outage. Adams Amelia'], prose: 'Some premises will be impacted by this outage. Adams; Amelia; Forecastle' };
  assert.ok(P.matchOutage(P.parseQuery('1400 Adams Rd', []), p).mention);
  assert.ok(P.matchOutage(P.parseQuery('Forecastle Rd', []), p).mention);
});
