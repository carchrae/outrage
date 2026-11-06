#!/usr/bin/env node
/*
 * Build public/munis.json: a centroid for every municipality named by the BC Hydro feeds, so the
 * page can guess the municipality from the device's location without calling any service at
 * runtime. Geocoding uses OpenStreetMap's Nominatim at one request per second (its usage policy)
 * and only for names not already in the file, so re-running after new names appear is cheap.
 *
 *   node scripts/geocode-munis.js            # add missing names
 *   node scripts/geocode-munis.js --refresh  # re-geocode everything
 */
const fs = require('fs');
const path = require('path');

const FEEDS = [
  'https://www.bchydro.com/power-outages/app/outages-list-data-planned.json',
  'https://www.bchydro.com/power-outages/app/outages-list-data-current.json',
];
const OUT = path.join(__dirname, '..', 'public', 'munis.json');
const UA = 'bchydro-outage-finder geocode script (https://github.com/carchrae/outrage)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function names() {
  const set = new Set();
  for (const url of FEEDS) {
    const data = await (await fetch(url)).json();
    for (const r of data.regions || []) {
      for (const m of r.municipalities || []) set.add(typeof m === 'string' ? m : m.name);
      for (const o of r.outages || []) if (o.municipality) set.add(o.municipality);
    }
  }
  // "North Vancouver, West Vancouver" style combined names are not places.
  return [...set].flatMap((n) => n.split(',').map((s) => s.trim())).filter(Boolean);
}

async function geocode(name) {
  const q = encodeURIComponent(`${name}, British Columbia`);
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ca&q=${q}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const hits = await res.json();
  if (!hits.length) return null;
  return { lat: Math.round(parseFloat(hits[0].lat) * 1e4) / 1e4, lon: Math.round(parseFloat(hits[0].lon) * 1e4) / 1e4 };
}

(async () => {
  const refresh = process.argv.includes('--refresh');
  let existing = {};
  try { existing = refresh ? {} : JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* first run */ }
  const out = { ...existing };
  const todo = [...new Set(await names())].sort().filter((n) => !out[n]);
  console.log(`${Object.keys(out).length} known, ${todo.length} to geocode`);
  for (const name of todo) {
    try {
      const hit = await geocode(name);
      if (hit) { out[name] = hit; console.log('ok   ', name, hit.lat, hit.lon); }
      else console.log('miss ', name);
    } catch (e) { console.log('fail ', name, e.message); }
    await sleep(1100);
  }
  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  fs.writeFileSync(OUT, JSON.stringify(sorted, null, 1) + '\n');
  console.log(`wrote ${OUT} with ${Object.keys(sorted).length} municipalities`);
})();
