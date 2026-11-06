const test = require('node:test');
const assert = require('node:assert/strict');

const planned = (outages) => ({ regions: [{ id: 1, name: 'Lower Mainland', municipalities: ['Bowen Island', 'Burnaby'], outages }] });
const o = (id, area, muni, extra) => ({ id, municipality: muni, area, dateOff: 100, dateOn: 200, lastUpdated: 50, ...extra });
const sub = (endpoint, street, muni) => ({ subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, street, muni });

test('diffFeeds reports added, changed and removed outages', async () => {
  const L = await import('../netlify/functions/lib/feed-diff.mjs');
  const prev = L.slimFeed(planned([o(1, '1-9 Adams Rd', 'Bowen Island'), o(2, '5 Elm St', 'Burnaby'), o(3, '7 Oak St', 'Burnaby')]), 'planned');
  const next = L.slimFeed(planned([o(1, '1-9 Adams Rd', 'Bowen Island'), o(2, '5 Elm St', 'Burnaby', { dateOff: 150 }), o(4, '9 Ash St', 'Burnaby')]), 'planned');
  const changed = L.diffFeeds(prev, next);
  assert.deepEqual(changed.map((c) => [c.id, c.change]).sort(), [[2, 'changed'], [3, 'removed'], [4, 'added']]);
});

test('pickSubscribers matches by street core and municipality, including removed outages', async () => {
  const L = await import('../netlify/functions/lib/feed-diff.mjs');
  const munis = ['Bowen Island', 'Burnaby'];
  const subs = [
    { ...L.normaliseSubscription(sub('https://p/1', 'adams rd', 'Bowen Island')), id: 'a' },
    { ...L.normaliseSubscription(sub('https://p/2', 'Adams Road', 'bowen')), id: 'b' },
    { ...L.normaliseSubscription(sub('https://p/3', 'adams rd', 'Burnaby')), id: 'c' },
    { ...L.normaliseSubscription(sub('https://p/4', 'elm st', '')), id: 'd' },
  ];
  const changed = [
    { ...L.slimFeed(planned([o(1, '<b>Some premises on the following streets.\nAdams Rd, Cardena Dr/Rd</b>', 'Bowen Island')]), 'planned')[0], change: 'changed' },
    { ...L.slimFeed(planned([o(2, '5 Elm St', 'Burnaby')]), 'planned')[0], change: 'removed' },
  ];
  const hits = L.pickSubscribers(subs, changed, munis);
  assert.deepEqual([...hits.keys()].sort(), ['a', 'b', 'd']);
  assert.deepEqual(hits.get('a').ids, [1]);
  assert.deepEqual(hits.get('d').ids, [2]);
});

test('normaliseSubscription rejects bad records and never keeps a house number', async () => {
  const L = await import('../netlify/functions/lib/feed-diff.mjs');
  assert.equal(L.normaliseSubscription(sub('http://p/1', 'adams rd', '')), null);
  assert.equal(L.normaliseSubscription(sub('https://p/1', '1400', '')), null);
  assert.equal(L.normaliseSubscription({ subscription: { endpoint: 'https://p/1' }, street: 'adams rd' }), null);
  const rec = L.normaliseSubscription(sub('https://p/1', 'Adams Road', ' Bowen Island '));
  assert.deepEqual([rec.street, rec.core, rec.muni], ['adams rd', 'adams', 'bowen island']);
});

test('pruneToSubscribers keeps only outages on subscribed streets; new subscribers get no alert until a baseline exists', async () => {
  const L = await import('../netlify/functions/lib/feed-diff.mjs');
  const munis = ['Bowen Island', 'Burnaby'];
  const all = L.slimFeed(planned([o(1, '1-9 Adams Rd', 'Bowen Island'), o(2, '5 Elm St', 'Burnaby'), o(3, '7 Oak St', 'Burnaby')]), 'planned');
  const subs = [{ ...L.normaliseSubscription(sub('https://p/1', 'adams rd', '')), id: 'a' }];
  const pruned = L.pruneToSubscribers(all, subs, munis);
  assert.deepEqual(pruned.outages.map((x) => x.id), [1]);
  assert.deepEqual(pruned.cores, ['street:adams']);
  const changed = [{ ...all[0], change: 'added' }];
  assert.equal(L.pickSubscribers(subs, changed, munis, new Set()).size, 0, 'street not in the previous copy');
  assert.equal(L.pickSubscribers(subs, changed, munis, new Set(['street:adams'])).size, 1);
  assert.equal(L.pickSubscribers(subs, changed, munis, new Set(['adams'])).size, 1, 'copies from before the key prefix still count');
  assert.equal(L.pickSubscribers(subs, changed, munis).size, 1, 'no baseline set given: no filtering');
});

test('check-feeds run(): stores the first copy, then pushes only to touched streets and drops dead endpoints', async () => {
  const C = await import('../netlify/functions/check-feeds.mjs');
  const L = await import('../netlify/functions/lib/feed-diff.mjs');
  const feeds = { planned: planned([o(1, '1-9 Adams Rd', 'Bowen Island')]), current: { regions: [] } };
  const realFetch = global.fetch;
  global.fetch = async (url) => ({ ok: true, json: async () => (url.includes('current') ? feeds.current : feeds.planned) });
  const blobs = new Map();
  const store = {
    get: async (k) => (blobs.has(k) ? blobs.get(k) : null),
    setJSON: async (k, v) => { blobs.set(k, JSON.parse(JSON.stringify(v))); },
    delete: async (k) => { blobs.delete(k); },
    list: async ({ prefix }) => ({ blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
  };
  const sent = [];
  const send = async (s, payload) => { if (s.endpoint.endsWith('/gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; } sent.push([s.endpoint, JSON.parse(payload)]); };
  const log = () => {};
  try {
    assert.deepEqual(await C.run({ store, send, log }), { changed: 0, pushed: 0, first: true });
    blobs.set('sub/a', L.normaliseSubscription(sub('https://p/a', 'adams rd', 'Bowen Island')));
    blobs.set('sub/gone', L.normaliseSubscription(sub('https://p/gone', 'adams rd', '')));
    blobs.set('sub/elm', L.normaliseSubscription(sub('https://p/elm', 'elm st', '')));
    // The subscribers are new, so their outage now enters the copy; it is a change but not an alert.
    assert.deepEqual(await C.run({ store, send, log }), { changed: 1, pushed: 0, dropped: 0 });
    assert.deepEqual(blobs.get('feeds/last').outages.map((x) => x.id), [1]);
    assert.deepEqual(blobs.get('feeds/last').cores, ['street:adams', 'street:elm']);
    assert.deepEqual(await C.run({ store, send, log }), { changed: 0, pushed: 0 });
    feeds.planned = planned([o(1, '1-9 Adams Rd', 'Bowen Island', { dateOff: 300, dateOn: 400 })]);
    const r = await C.run({ store, send, log });
    assert.deepEqual([r.changed, r.pushed, r.dropped], [1, 1, 1]);
    assert.deepEqual(sent.map(([e, p]) => [e, p.ids]), [['https://p/a', [1]]]);
    assert.equal(sent[0][1].title, 'Adams Rd, Bowen Island');
    assert.match(sent[0][1].body, /^Time changed: planned outage now /);
    assert.ok(!blobs.has('sub/gone'), 'dead endpoint deleted');
    assert.ok(blobs.has('sub/elm'), 'untouched subscriber kept');
  } finally { global.fetch = realFetch; }
});

test('geocode: parseNearest builds an address line from the BC Geocoder response', async () => {
  const G = await import('../netlify/functions/lib/geocode.mjs');
  const hit = G.parseNearest({ type: 'Feature', properties: { fullAddress: '13450 104 Ave, Surrey, BC', civicNumber: 13450, streetName: '104', streetType: 'Ave', streetDirection: '', localityName: 'Surrey', distance: 12.5 } });
  assert.deepEqual([hit.address, hit.locality, hit.distance], ['13450 104 Ave', 'Surrey', 12.5]);
  const noNumber = G.parseNearest({ properties: { fullAddress: 'Adams Rd, Bowen Island, BC', streetName: 'Adams', streetType: 'Rd', localityName: 'Bowen Island' } });
  assert.equal(noNumber.address, 'Adams Rd');
  assert.equal(G.parseNearest({ properties: {} }), null);
  assert.ok(G.inBC(49.37, -123.37) && !G.inBC(45, -75));
  const calls = [];
  const fake = async (url, opts) => { calls.push([url, opts.headers.apikey]); return { ok: true, json: async () => ({ properties: { civicNumber: 1, streetName: 'Adams', streetType: 'Rd', localityName: 'Bowen Island' } }) }; };
  const r = await G.nearestAddress(49.37, -123.37, 'KEY', fake);
  assert.equal(r.address, '1 Adams Rd');
  assert.ok(calls[0][0].includes('point=-123.37%2C49.37'), 'longitude first');
  assert.equal(calls[0][1], 'KEY');
});

test('notification text: one plain line per change, street level only', async () => {
  const L = await import('../netlify/functions/lib/feed-diff.mjs');
  const planned = (change, extra) => ({ kind: 'planned', change, dateOff: Date.UTC(2026, 10, 7, 16), dateOn: Date.UTC(2026, 10, 8, 0), ...extra });
  assert.equal(L.describeChange(planned('added')), 'New planned outage: Sat, Nov 7 8:00 a.m. – 4:00 p.m.');
  assert.equal(L.describeChange(planned('removed')), 'No longer listed: planned outage Sat, Nov 7 8:00 a.m. – 4:00 p.m.');
  assert.equal(L.describeChange(planned('changed', { was: { dateOff: 1, dateOn: 2 } })), 'Time changed: planned outage now Sat, Nov 7 8:00 a.m. – 4:00 p.m.');
  assert.equal(L.describeChange(planned('changed', { cancelled: true, was: { dateOff: Date.UTC(2026, 10, 7, 16), dateOn: Date.UTC(2026, 10, 8, 0) } })), 'Cancelled: planned outage Sat, Nov 7 8:00 a.m. – 4:00 p.m.');
  const current = (change, extra) => ({ kind: 'current', change, dateOff: Date.UTC(2026, 10, 6, 14, 20), dateOn: null, crew: 'Crew assigned', customers: 73, ...extra });
  assert.equal(L.describeChange(current('added')), 'Power out: unplanned outage, crew assigned, 73 customers');
  assert.equal(L.describeChange(current('changed', { crew: 'Crew on-site', was: { crew: 'Crew assigned' } })), 'Unplanned outage: crew on-site');
  assert.equal(L.describeChange(current('changed', { dateOn: Date.UTC(2026, 10, 6, 23), was: { crew: 'Crew assigned' } })), 'Unplanned outage: power expected back Fri, Nov 6 3:00 p.m., crew assigned');
  assert.equal(L.describeChange(current('removed')), 'Unplanned outage resolved');
  const n = L.notificationFor({ sub: { street: 'adams rd', muni: 'bowen island' }, street: 'ADAMS RD', outages: [current('added', { municipality: 'Bowen Island' }), planned('added'), planned('removed'), planned('added'), planned('added')] });
  assert.equal(n.title, 'Adams Rd, Bowen Island');
  assert.equal(n.body.split('\n').length, 5);
  assert.match(n.body, /\+1 more$/);
  assert.ok(!/1261|house/.test(n.body));
});

test('municipality topic: every outage in the town, named by street; street topic unchanged', async () => {
  const L = await import('../netlify/functions/lib/feed-diff.mjs');
  const munis = ['Bowen Island', 'Burnaby'];
  const subTown = { ...L.normaliseSubscription({ ...sub('https://p/t', '', 'Bowen Island'), topics: ['muni'] }), id: 't' };
  const subBoth = { ...L.normaliseSubscription({ ...sub('https://p/b', 'adams rd', 'Bowen Island'), topics: ['street', 'muni'] }), id: 'b' };
  const subStreet = { ...L.normaliseSubscription(sub('https://p/s', 'adams rd', 'Bowen Island')), id: 's' };
  assert.deepEqual([subTown.topics, subBoth.topics, subStreet.topics], [['muni'], ['street', 'muni'], ['street']]);
  assert.equal(L.normaliseSubscription({ ...sub('https://p/x', '', ''), topics: ['muni'] }), null, 'municipality topic needs a municipality');
  const all = L.slimFeed(planned([o(1, '1-9 Adams Rd', 'Bowen Island'), o(2, '5 Cardena Dr', 'Bowen Island'), o(3, '7 Oak St', 'Burnaby')]), 'planned');
  const pruned = L.pruneToSubscribers(all, [subTown, subBoth, subStreet], munis);
  assert.deepEqual(pruned.outages.map((x) => x.id), [1, 2]);
  assert.deepEqual(pruned.cores, ['muni:bowen island', 'street:adams']);
  const changed = all.slice(0, 2).map((x) => ({ ...x, change: 'added' }));
  const hits = L.pickSubscribers([subTown, subBoth, subStreet], changed, munis, new Set(pruned.cores));
  assert.deepEqual([...hits.keys()].sort(), ['b', 's', 't']);
  assert.deepEqual(hits.get('s').ids, [1]);
  assert.deepEqual(hits.get('t').ids, [1, 2]);
  assert.deepEqual(hits.get('b').ids, [1, 2]);
  const town = L.notificationFor(hits.get('t'));
  assert.equal(town.title, 'Bowen Island');
  assert.match(town.body, /^1-9 Adams Rd: New planned outage/);
  assert.match(town.body, /\n5 Cardena Dr: New planned outage/);
  const both = L.notificationFor(hits.get('b'));
  assert.equal(both.title, 'Adams Rd, Bowen Island');
  assert.match(both.body, /^New planned outage: [^\n]+\n5 Cardena Dr: New planned outage/);
});
