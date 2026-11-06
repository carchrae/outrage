/*
 * GET /api/locate?lat=..&lon=..  ->  { address, number, street, locality }
 *
 * The browser sends only coordinates, and only when the visitor presses "Use my location".
 * Without BC_GEOCODER_KEY in the environment this answers 501 and the page does not offer it.
 */
import { inBC, nearestAddress } from './lib/geocode.mjs';

export const config = { path: '/api/locate' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default async (req) => {
  const key = (process.env.BC_GEOCODER_KEY || '').trim();
  if (!key) return json(501, { error: 'Address lookup is not configured' });
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  if (!isFinite(lat) || !isFinite(lon) || !inBC(lat, lon)) return json(400, { error: 'Expected lat and lon inside BC' });
  try {
    const hit = await nearestAddress(lat, lon, key);
    return json(200, hit || { address: '' });
  } catch (err) {
    return json(502, { error: String(err.message || err) });
  }
};
