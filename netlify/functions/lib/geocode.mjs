/*
 * Reverse geocoding through the BC Address Geocoder (geocoder.api.gov.bc.ca), the provincial
 * government's own address service. Used only when the visitor presses "Use my location", and
 * only when a BC_GEOCODER_KEY is configured; the browser never talks to the geocoder itself.
 */
const BASE = 'https://geocoder.api.gov.bc.ca/sites/nearest.json';

/** Rough bounding box of BC; anything outside is not worth a lookup. */
export function inBC(lat, lon) {
  return lat >= 48 && lat <= 60.5 && lon >= -140 && lon <= -114;
}

/** Turn the geocoder's nearest-site response into the fields the form needs. */
export function parseNearest(data) {
  const p = (data && (data.properties || data)) || {};
  const number = p.civicNumber != null && p.civicNumber !== '' ? String(p.civicNumber) + (p.civicNumberSuffix || '') : '';
  const street = [p.streetName, p.streetType, p.streetDirection].filter(Boolean).join(' ').trim();
  const locality = p.localityName || '';
  let line = [number, street].filter(Boolean).join(' ');
  if (!line && p.fullAddress) line = String(p.fullAddress).replace(/,\s*BC\s*$/i, '').replace(new RegExp(',\\s*' + locality.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'), '');
  if (!line) return null;
  return { address: line, number, street, locality, full: p.fullAddress || '', distance: typeof p.distance === 'number' ? p.distance : null };
}

/** Look up the nearest civic address to a point. Returns null when nothing usable comes back. */
export async function nearestAddress(lat, lon, apiKey, fetchImpl = fetch) {
  const url = `${BASE}?point=${encodeURIComponent(lon + ',' + lat)}`;
  const res = await fetchImpl(url, { headers: { apikey: apiKey, Accept: 'application/json' } });
  if (!res.ok) throw new Error('geocoder HTTP ' + res.status);
  return parseNearest(await res.json());
}
