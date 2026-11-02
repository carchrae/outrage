// Fetches the live planned-outage feed (or reads a local JSON file) and reports how well the parser handles it.
// Usage: node scripts/check-live.js [path/to/planned.json]
const fs = require('fs');
const P = require('../public/parse.js');

async function load(file) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch('https://www.bchydro.com/power-outages/app/outages-list-data-planned.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return res.json();
}

(async () => {
  const data = await load(process.argv[2]);
  const munis = [...new Set(data.regions.flatMap((r) => r.municipalities.map((m) => (typeof m === 'string' ? m : m.name))))];
  const outages = data.regions.flatMap((r) => r.outages);
  let segs = 0, noStreet = 0, noNumbers = 0, empty = 0;
  const weird = [];
  for (const o of outages) {
    const p = P.parseArea(o.area, munis);
    segs += p.segments.length;
    if (!p.segments.length) { empty++; weird.push(['EMPTY', o.id, o.area]); }
    for (const s of p.segments) {
      if (!s.street) { noStreet++; weird.push(['NOSTREET', o.id, s.label]); }
      if (!s.numbers.length) { noNumbers++; weird.push(['NONUM', o.id, s.label]); }
    }
  }
  console.log({ outages: outages.length, segments: segs, empty, noStreet, noNumbers, munis: munis.length });
  for (const w of weird.slice(0, 60)) console.log(w.join(' | ').slice(0, 220));
  if (process.argv[3]) {
    const q = P.parseQuery(process.argv[3], munis);
    console.log('query', q);
    const hits = [];
    for (const o of outages) {
      const m = P.matchOutage(q, P.parseArea(o.area, munis));
      if (m) hits.push([m.level, o.id, o.municipality, m.segment.label, m.numberListed]);
    }
    hits.sort((a, b) => b[0] - a[0]);
    console.log(hits.slice(0, 15));
  }
})();
