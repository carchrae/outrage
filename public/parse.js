/*
 * Parser for BC Hydro planned-outage "area" strings.
 *
 * The feed describes each outage's affected area as free text such as
 *   "<b>Rescheduled from Oct 27</b><br/>2818, 2823 Crossley Dr; 31435 - 31482 Jean Crt, Abbotsford"
 * This module turns that into structured street segments with house-number
 * ranges so an address can be matched against it.
 *
 * Works both in the browser (window.OutageParser) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OutageParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Canonical short forms for street-type and direction words.
  const WORD_MAP = {
    avenue: 'ave', av: 'ave', ave: 'ave',
    street: 'st', st: 'st', saint: 'st',
    drive: 'dr', dr: 'dr', drv: 'dr',
    road: 'rd', rd: 'rd',
    crescent: 'cres', cres: 'cres', crs: 'cres', cre: 'cres', cresc: 'cres', cr: 'cres',
    court: 'crt', crt: 'crt', ct: 'crt',
    place: 'pl', pl: 'pl',
    lane: 'ln', ln: 'ln', la: 'ln',
    boulevard: 'blvd', blvd: 'blvd', blv: 'blvd', bvd: 'blvd',
    highway: 'hwy', hwy: 'hwy', hw: 'hwy',
    way: 'way', wy: 'way',
    trail: 'trail', trl: 'trail', tr: 'trail',
    trunk: 'trunk', trk: 'trunk',
    terrace: 'terr', terr: 'terr', ter: 'terr', tce: 'terr',
    circle: 'cir', cir: 'cir', circ: 'cir',
    close: 'close', cl: 'close',
    gate: 'gate', gte: 'gate',
    walk: 'walk', wlk: 'walk',
    parkway: 'pkwy', pkwy: 'pkwy', pky: 'pkwy',
    square: 'sq', sq: 'sq',
    grove: 'grv', grv: 'grv',
    heights: 'hts', hts: 'hts', hgts: 'hts',
    point: 'pt', pt: 'pt',
    island: 'isl', isl: 'isl', is: 'isl',
    mount: 'mt', mt: 'mt', mountain: 'mtn', mtn: 'mtn',
    north: 'n', n: 'n', nth: 'n',
    south: 's', s: 's', sth: 's',
    east: 'e', e: 'e',
    west: 'w', w: 'w',
    frontage: 'frontage', frtg: 'frontage',
    subdivision: 'sub', sub: 'sub', subdiv: 'sub',
    extension: 'ext', ext: 'ext',
    bypass: 'bypass', byp: 'bypass',
    crossing: 'xing', xing: 'xing',
    estates: 'est', est: 'est',
    landing: 'lndg', lndg: 'lndg',
    ridge: 'rdg', rdg: 'rdg',
    cove: 'cove', cv: 'cove',
    bay: 'bay',
  };

  // Words that describe the street type, stripped to get the "core" name.
  const SUFFIXES = new Set([
    'ave', 'st', 'dr', 'rd', 'cres', 'crt', 'pl', 'ln', 'blvd', 'hwy', 'way', 'trail',
    'terr', 'cir', 'close', 'gate', 'walk', 'pkwy', 'sq', 'grv', 'hts', 'pt', 'loop',
    'row', 'mews', 'rise', 'view', 'green', 'frontage', 'sub', 'ext', 'bypass', 'xing',
    'est', 'lndg', 'rdg', 'cove', 'bay', 'fsr', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw',
  ]);

  const NUM = '[a-z]?\\d+[a-z]?';
  const NUM_RE = new RegExp('^' + NUM + '$', 'i');
  const RANGE_RE = new RegExp('^(' + NUM + ')\\s*-\\s*(' + NUM + ')$', 'i');
  const LEAD_RE = new RegExp('^((?:' + NUM + ')(?:\\s*-\\s*(?:' + NUM + '))?)\\s+(\\S.*)$', 'i');
  const DASH_LEAD_RE = new RegExp('^-\\s*(' + NUM + ')\\s+(\\S.*)$', 'i');
  const LOCALITY_RE = /mile house$/i;

  function decodeEntities(s) {
    return s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;|&rsquo;|&#8217;/gi, "'")
      .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
  }

  function stripTags(s) {
    return s.replace(/<[^>]+>/g, '');
  }

  /** Normalise a street name into a comparable key, e.g. "15th Avenue" -> "15 ave". */
  function streetKey(name) {
    if (!name) return '';
    let s = name.toLowerCase();
    s = s.replace(/forest\s+service\s+(road|rd)/g, 'fsr');
    s = s.replace(/[.,'’"()]/g, ' ');
    s = s.replace(/-/g, ' ');
    const words = s.split(/\s+/).filter(Boolean).map((w) => {
      const ord = w.match(/^(\d+)(st|nd|rd|th)$/);
      if (ord) return ord[1];
      return WORD_MAP[w] || w;
    });
    return words.join(' ');
  }

  /** Key with street-type and direction words removed: "kraft cres" -> "kraft". */
  function coreKey(key) {
    const words = key.split(' ').filter((w) => !SUFFIXES.has(w));
    return words.length ? words.join(' ') : key;
  }

  function numVal(s) {
    const m = String(s).match(/\d+/);
    return m ? parseInt(m[0], 10) : NaN;
  }

  function parseNumberToken(tok) {
    const r = tok.match(RANGE_RE);
    if (r) {
      let lo = numVal(r[1]);
      let hi = numVal(r[2]);
      if (lo > hi) [lo, hi] = [hi, lo];
      return { lo, hi, label: r[1].replace(/\s+/g, '') + '-' + r[2].replace(/\s+/g, '') };
    }
    if (NUM_RE.test(tok)) {
      const v = numVal(tok);
      return { lo: v, hi: v, label: tok };
    }
    return null;
  }

  function cleanToken(tok) {
    return tok.replace(/^[\s.]+|[\s.]+$/g, '').replace(/\s+/g, ' ');
  }

  /**
   * Parse an outage "area" string.
   * @param {string} area raw HTML-ish area text from the feed
   * @param {string[]} [municipalities] known municipality names (for locality detection)
   */
  function parseArea(area, municipalities) {
    const muniSet = new Set((municipalities || []).map((m) => m.toLowerCase()));
    const notes = [];
    const flags = { continued: false, cancelled: false, rescheduled: false };
    let s = decodeEntities(area || '');
    s = s.replace(/\r\n|\r|\n/g, ' ');
    s = s.replace(/<br\s*\/?>/gi, ' ; ');

    // Pull out <b>...</b> notes. Bold text that is itself an address list stays in the stream.
    s = s.replace(/<b>([\s\S]*?)(?:<\/b>|$)/gi, (m, inner) => {
      let t = stripTags(inner).trim();
      if (/^cont'?d\b/i.test(t)) {
        flags.continued = true;
        t = t.replace(/^cont'?d\.*\s*/i, '');
      }
      const startsWithNumber = new RegExp('^(impact area:?\\s*;?\\s*)?' + NUM + '(\\s*-\\s*' + NUM + ')?[\\s,]', 'i').test(t);
      const readsLikeNote = /\b(outage|outages|minutes|minute|between|approximately|customers|rescheduled|cancelled|note)\b/i.test(t);
      const looksLikeAddresses = /^impact area/i.test(t) || (startsWithNumber && hasSuffix(t) && !readsLikeNote);
      if (looksLikeAddresses) return t.replace(/^impact area:?\s*;?\s*/i, '');
      if (t) notes.push(t.replace(/\s*;\s*/g, ' '));
      return ' ; ';
    });
    s = stripTags(s);

    for (const n of notes) {
      if (/cancel/i.test(n)) flags.cancelled = true;
      if (/reschedul/i.test(n)) flags.rescheduled = true;
    }

    // Commas and semicolons inside parentheses are not separators: "(Unit 150, 202, 203)".
    s = s.replace(/\([^)]*\)/g, (m) => m.replace(/,/g, '\u0001').replace(/;/g, '\u0002'));

    const segments = [];
    let currentLocality = '';
    const chunks = s.split(';');
    for (const chunk of chunks) {
      let pending = [];
      let lastSegsInChunk = [];
      const tokens = chunk.split(',');
      for (const rawTok of tokens) {
        let tok = cleanToken(rawTok.replace(/\u0001/g, ',').replace(/\u0002/g, ';'));
        if (!tok) continue;
        if (/^impact area\b/i.test(tok) || (/cont'?d\b/i.test(tok) && !/\d/.test(tok))) continue;
        tok = tok.replace(/^(?:and|&)\s+/i, '');
        // "Posted in ORS: 370-476 W 42nd Ave" -> drop the label when a number follows the colon.
        tok = tok.replace(/^[^:()]{1,40}:\s*(?=[a-z]?\d)/i, '');
        tok = cleanToken(tok);
        if (!tok) continue;

        // Parenthetical qualifiers e.g. "(Units 1-21)", "(evens only)".
        let qualifier = '';
        tok = tok.replace(/\(([^)]*)\)/g, (m, q) => { qualifier = (qualifier ? qualifier + '; ' : '') + q.trim(); return ' '; });
        tok = cleanToken(tok);

        if (!tok) {
          if (qualifier && lastSegsInChunk.length) lastSegsInChunk[lastSegsInChunk.length - 1].qualifier += (lastSegsInChunk[lastSegsInChunk.length - 1].qualifier ? '; ' : '') + qualifier;
          continue;
        }

        // Pure number or range: queue it.
        const numTok = parseNumberToken(tok);
        if (numTok) { pending.push(numTok); continue; }

        // "- 1268 Eagles Nest Rd" following a pending "351": treat as range.
        const dash = tok.match(DASH_LEAD_RE);
        if (dash && pending.length) {
          const lo = pending.pop();
          const hi = numVal(dash[1]);
          pending.push({ lo: Math.min(lo.lo, hi), hi: Math.max(lo.lo, hi), label: lo.label + '-' + dash[1] });
          tok = dash[1] + ' ' + dash[2];
        }

        const lead = tok.match(LEAD_RE);
        if (lead && !LOCALITY_RE.test(lead[2]) && !muniSet.has(tok.toLowerCase())) {
          const numbers = pending.concat([parseNumberToken(lead[1].replace(/\s+/g, ''))].filter(Boolean));
          pending = [];
          const street = cleanToken(lead[2]);
          const seg = makeSegment(street, numbers, qualifier);
          segments.push(seg);
          lastSegsInChunk.push(seg);
          continue;
        }

        // "6 Ave., SE": a token made only of street-type/direction words extends the previous street.
        if (lastSegsInChunk.length && !pending.length && isOnlySuffixWords(tok)) {
          const last = lastSegsInChunk[lastSegsInChunk.length - 1];
          extendSegment(last, tok);
          continue;
        }

        // Pure text token: a locality (municipality) or a named place.
        const lower = tok.toLowerCase();
        const isLocality = muniSet.has(lower) || LOCALITY_RE.test(tok) || !hasSuffix(tok);
        if (isLocality) {
          currentLocality = tok;
          for (const seg of lastSegsInChunk) if (!seg.locality) seg.locality = tok;
          if (qualifier && lastSegsInChunk.length) {
            const last = lastSegsInChunk[lastSegsInChunk.length - 1];
            last.qualifier += (last.qualifier ? '; ' : '') + qualifier;
          }
          if (!lastSegsInChunk.length && !pending.length && !muniSet.has(lower) && !LOCALITY_RE.test(tok)) {
            // Named place with no numbers (e.g. "Dragon Mountain Tower").
            segments.push(makeSegment(tok, [], qualifier));
          }
          continue;
        }

        // Street with no leading number (e.g. "Whatcom Rd" after pending numbers).
        const seg = makeSegment(tok, pending, qualifier);
        pending = [];
        segments.push(seg);
        lastSegsInChunk.push(seg);
      }
      if (pending.length) {
        segments.push(makeSegment('', pending, ''));
      }
    }

    for (const seg of segments) if (!seg.locality) seg.locality = currentLocality;

    const text = cleanToken(s.replace(/\s*;\s*/g, '; ').replace(/\s+,/g, ',').replace(/;\s*;/g, ';').replace(/^;\s*|\s*;$/g, ''));
    return { notes, flags, segments, text };
  }

  function isOnlySuffixWords(tok) {
    const words = streetKey(tok).split(' ').filter(Boolean);
    return words.length > 0 && words.every((w) => SUFFIXES.has(w));
  }

  function extendSegment(seg, extra) {
    seg.street = cleanToken(seg.street + ' ' + extra);
    seg.key = streetKey(seg.street);
    seg.core = coreKey(seg.key);
    seg.label = formatSegment(seg.street, seg.numbers);
  }

  function hasSuffix(tok) {
    const key = streetKey(tok);
    return key.split(' ').some((w) => SUFFIXES.has(w) && w.length > 1);
  }

  function makeSegment(street, numbers, qualifier) {
    const key = streetKey(street);
    return {
      street,
      key,
      core: coreKey(key),
      numbers: numbers.slice(),
      qualifier: qualifier || '',
      locality: '',
      label: formatSegment(street, numbers),
    };
  }

  function formatSegment(street, numbers) {
    const nums = numbers.map((n) => n.label).join(', ');
    return nums && street ? nums + ' ' + street : nums || street;
  }

  // ---------------------------------------------------------------- queries

  const POSTAL_RE = /\b[a-z]\d[a-z]\s?\d[a-z]\d\b/i;

  /**
   * Parse a user-entered address such as "204-7730 15th Ave, Burnaby BC V5E 1A1".
   * @returns {{number:number|null, unit:string, street:string, key:string, core:string, muni:string, raw:string}}
   */
  function parseQuery(q, municipalities) {
    const raw = (q || '').trim();
    let s = raw.replace(POSTAL_RE, ' ');
    s = s.replace(/\b(british columbia|canada|bc|b\.c\.)\b/gi, ' ');
    s = s.replace(/\s+/g, ' ').trim();

    let unit = '';
    const unitLead = s.match(/^(?:(?:unit|suite|apt|apartment|#)\s*)?([a-z]?\d+[a-z]?)\s*[-–]\s*(?=[a-z]?\d+[a-z]?\s+\S)/i);
    if (unitLead) { unit = unitLead[1]; s = s.slice(unitLead[0].length); }
    const unitTail = s.match(/,?\s*(?:unit|suite|apt|apartment|#)\s*([a-z]?\d+[a-z]?)\s*$/i);
    if (unitTail) { unit = unit || unitTail[1]; s = s.slice(0, unitTail.index); }

    let number = null;
    const numM = s.match(/^([a-z]?\d+[a-z]?)\s+(?=\S)/i);
    if (numM) {
      const rest = s.slice(numM[0].length);
      const restStreet = rest.split(',')[0];
      // "30 Ave" is a street, not house number 30 on a street called "Ave".
      const restCore = coreKey(streetKey(restStreet));
      const onlySuffix = !restCore || streetKey(restStreet).split(' ').every((w) => SUFFIXES.has(w));
      if (!onlySuffix) { number = numVal(numM[1]); s = rest; }
    }

    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    let street = parts.shift() || '';
    let muni = parts.join(' ').trim();

    // "Kraft Cres Burnaby" without a comma: peel a known municipality off the end.
    if (!muni && municipalities && municipalities.length) {
      const lower = street.toLowerCase();
      let best = '';
      for (const m of municipalities) {
        const ml = m.toLowerCase();
        if (lower !== ml && lower.endsWith(' ' + ml) && ml.length > best.length) best = m;
      }
      if (best) { muni = best; street = street.slice(0, street.length - best.length).trim(); }
      else if (municipalities.some((m) => m.toLowerCase() === lower)) { muni = street; street = ''; }
    }

    const key = streetKey(street);
    return { raw, number, unit, street, key, core: coreKey(key), muni };
  }

  // ---------------------------------------------------------------- matching

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
  function streetType(key) {
    return key.split(' ').filter((w) => SUFFIXES.has(w) && !DIRECTIONS.has(w)).join(' ');
  }

  /** Street similarity: 3 exact key, 2 same core name, 1 fuzzy/partial, 0 none. */
  function streetScore(query, seg) {
    if (!query.key || !seg.key) return 0;
    if (seg.key === query.key) return 3;
    // "Adams Crescent" vs "Adams Rd": same name but both sides name a different street type.
    const qt = streetType(query.key);
    const st = streetType(seg.key);
    const typeConflict = qt && st && qt !== st;
    if (seg.core === query.core) return typeConflict ? 1 : 2;
    const qWords = query.core.split(' ');
    const sWords = seg.core.split(' ');
    if (qWords.every((w) => sWords.includes(w))) return 1.5;
    const joinedQ = query.core.replace(/ /g, '');
    const joinedS = seg.core.replace(/ /g, '');
    if (joinedQ === joinedS) return typeConflict ? 1 : 2;
    if (joinedQ.length >= 4) {
      const tol = joinedQ.length >= 8 ? 2 : 1;
      if (levenshtein(joinedQ, joinedS) <= tol) return 1;
    }
    return 0;
  }

  function numberListed(number, seg) {
    if (number == null || !seg.numbers.length) return null;
    const q = seg.qualifier.toLowerCase();
    if (/\beven/.test(q) && number % 2 !== 0) return false;
    if (/\bodd/.test(q) && number % 2 !== 1) return false;
    return seg.numbers.some((n) => !isNaN(n.lo) && number >= n.lo && number <= n.hi);
  }

  /**
   * Match a parsed query against a parsed outage area.
   * @returns {null|{level:number, segment:object, numberListed:boolean|null, streetScore:number}}
   */
  function matchOutage(query, parsed) {
    let best = null;
    for (const seg of parsed.segments) {
      const ss = streetScore(query, seg);
      if (!ss) continue;
      const listed = numberListed(query.number, seg);
      let level;
      if (listed === true) level = ss >= 2 ? 5 : 3;
      else if (listed === null) level = ss >= 2 ? 4 : 2;
      else level = ss >= 2 ? 3 : 1;
      if (!best || level > best.level || (level === best.level && ss > best.streetScore)) {
        best = { level, segment: seg, numberListed: listed, streetScore: ss };
      }
    }
    return best;
  }

  return { parseArea, parseQuery, matchOutage, streetKey, coreKey, streetScore, numberListed, levenshtein };
});
