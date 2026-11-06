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
    assert.deepEqual(await C.run({ store, send, log }), { changed: 0, pushed: 0 });
    feeds.planned = planned([o(1, '1-9 Adams Rd', 'Bowen Island', { dateOff: 300, dateOn: 400 })]);
    const r = await C.run({ store, send, log });
    assert.deepEqual([r.changed, r.pushed, r.dropped], [1, 1, 1]);
    assert.deepEqual(sent.map(([e, p]) => [e, p.ids]), [['https://p/a', [1]]]);
    assert.ok(!blobs.has('sub/gone'), 'dead endpoint deleted');
    assert.ok(blobs.has('sub/elm'), 'untouched subscriber kept');
  } finally { global.fetch = realFetch; }
});
