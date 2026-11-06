/*
 * POST   /api/subscribe  { subscription, street, muni, topics }  -> stores the push subscription
 *        topics: ['street'] (outages listing the street), ['muni'] (every outage in the municipality), or both
 * DELETE /api/subscribe  { endpoint }                    -> forgets it
 *
 * Records live in Netlify Blobs (store "push", key "sub/<sha256 of endpoint>"). The server never
 * receives a house number; the client matches the full address itself when a push arrives.
 */
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { normaliseSubscription } from './lib/feed-diff.mjs';

export const config = { path: '/api/subscribe' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export const idFor = (endpoint) => 'sub/' + createHash('sha256').update(endpoint).digest('hex');

export default async (req) => {
  let body;
  try { body = await req.json(); } catch (e) { return json(400, { error: 'Expected a JSON body' }); }
  const store = getStore('push');

  if (req.method === 'POST') {
    const rec = normaliseSubscription(body);
    if (!rec) return json(400, { error: 'Expected { subscription: {endpoint, keys}, street, muni, topics }' });
    const id = idFor(rec.endpoint);
    const prev = await store.get(id, { type: 'json' }).catch(() => null);
    await store.setJSON(id, { ...rec, createdAt: (prev && prev.createdAt) || Date.now(), updatedAt: Date.now(), failures: 0 });
    return json(200, { ok: true, street: rec.street, muni: rec.muni, topics: rec.topics });
  }

  if (req.method === 'DELETE') {
    const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint : '';
    if (!endpoint) return json(400, { error: 'Expected { endpoint }' });
    await store.delete(idFor(endpoint));
    return json(200, { ok: true });
  }

  return json(405, { error: 'Use POST or DELETE' });
};
