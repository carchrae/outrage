/* BC Hydro planned outage finder — UI. Depends on parse.js (window.OutageParser). */
(function () {
  'use strict';
  const P = window.OutageParser;
  const M = window.OutageMatcher;
  const A = window.OutageAlerts || null; // push alerts (optional module)
  const API = window.OUTAGE_API || '/api/planned';
  const API_CURRENT = window.OUTAGE_API_CURRENT || '/api/current';
  const OFFICIAL = 'https://www.bchydro.com/power-outages/app/outage-list-planned.html';
  const OFFICIAL_CURRENT = 'https://www.bchydro.com/power-outages/app/outage-list.html';
  const MAP = 'https://www.bchydro.com/power-outages/app/outage-map.html#outage=';
  const TZ = 'America/Vancouver';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    header: $('.site-header'), form: $('#search-form'), q: $('#street-address'), muni: $('#city'), muniList: $('#muni-list'), past: $('#past'), clear: $('#clear'),
    status: $('#status'), results: $('#results'), updated: $('#updated'), home: $('#home'), install: $('#install'), dialog: $('#dialog'), locate: $('#locate'),
  };

  const HOME_KEY = 'outage-finder.home';
  const SNAP_KEY = 'outage-finder.snapshot';
  const BASE_KEY = 'outage-finder.baseline';
  const HIST_KEY = 'outage-finder.history';
  const HIST_MAX = 300;
  const DEFAULT_MUNI = ''; // nothing is prefilled; an empty municipality searches every municipality
  const GEO_MAX_KM = 60; // a centroid further than this is not a guess worth making
  const geocoderMeta = document.querySelector('meta[name="geocoder"]');
  const HAS_GEOCODER = !!(geocoderMeta && geocoderMeta.content); // set at build time when BC_GEOCODER_KEY exists

  const state = {
    outages: [], munis: [], byMuni: new Map(), updatedDate: 0, query: '', muni: '', past: false, loading: false, error: '',
    home: readJSON(localStorage, HOME_KEY), baseline: undefined, diff: null, history: [], showSearch: false,
    alertsBusy: false, alertsMsg: '', showMore: false, installPrompt: null,
    current: [], currentError: '',
  };

  /** Assign innerHTML only when it changes, so a render that produces the same page mutates nothing. */
  function setHTML(el, html) { if (el.innerHTML !== html) el.innerHTML = html; }

  function readJSON(store, key) { try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; } }
  function writeJSON(store, key, val) {
    try { if (val == null) store.removeItem(key); else store.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ }
  }

  // ------------------------------------------------------------ data

  async function load() {
    state.loading = true; state.error = '';
    renderStatus();
    try {
      const [planned, current] = await Promise.allSettled([fetchJSON(API), fetchJSON(API_CURRENT)]);
      if (planned.status !== 'fulfilled') throw planned.reason;
      state.currentError = current.status === 'fulfilled' ? '' : String(current.reason && current.reason.message || current.reason);
      ingest(planned.value, current.status === 'fulfilled' ? current.value : null);
    } catch (err) {
      state.error = 'Could not load the outage feed (' + (err.message || err) + '). Try again in a minute.';
    } finally {
      state.loading = false;
      render();
      document.documentElement.removeAttribute('data-boot');
      if (A) A.register().catch(() => {});
      if (A && state.home && !state.error) {
        A.sync(state.home, state.munis);
        if (A.standalone()) maybeOfferAlerts(`Turn on alerts for ${homeLabel()} so this app can tell you when something changes.`);
      }
    }
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function ingest(data, currentData) {
    const fed = M.ingestFeeds(data, currentData);
    state.munis = fed.munis;
    const outages = fed.outages;
    const current = fed.current;
    current.sort((a, b) => b.numCustomersOut - a.numCustomersOut);
    state.current = current;
    // Outages sharing municipality + time window are usually one job split over several listings ("Cont'd").
    const groups = new Map();
    for (const o of outages) {
      const key = o.municipality + '|' + o.dateOff + '|' + o.dateOn;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    }
    for (const o of outages) {
      const g = groups.get(o.municipality + '|' + o.dateOff + '|' + o.dateOn);
      o.related = g.length > 1 ? g.filter((x) => x !== o).map((x) => x.id) : [];
    }
    outages.sort((a, b) => a.dateOff - b.dateOff);
    state.outages = outages;
    state.byMuni = new Map();
    for (const o of outages) {
      if (!state.byMuni.has(o.municipality)) state.byMuni.set(o.municipality, []);
      state.byMuni.get(o.municipality).push(o);
    }
    state.updatedDate = data.updatedDate || Date.now();
    fillMuniSelect();
  }

  // ------------------------------------------------------------ location

  let muniCentroids = null;
  async function loadCentroids() {
    if (muniCentroids) return muniCentroids;
    try { muniCentroids = await (await fetch('/munis.json')).json(); } catch (e) { muniCentroids = {}; }
    return muniCentroids;
  }

  function nearestMuni(lat, lon, centroids) {
    const toRad = (d) => (d * Math.PI) / 180;
    let best = null;
    for (const [name, c] of Object.entries(centroids)) {
      const dLat = toRad(c.lat - lat), dLon = toRad(c.lon - lon);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(c.lat)) * Math.sin(dLon / 2) ** 2;
      const km = 2 * 6371 * Math.asin(Math.sqrt(a));
      if (!best || km < best.km) best = { name, km };
    }
    return best && best.km <= GEO_MAX_KM ? best.name : null;
  }

  /**
   * "Use my location": asks for the device's location (never automatically), picks the nearest municipality
   * from the bundled centroids, and, when the deploy has a BC Geocoder key, asks the server for the nearest
   * civic address and puts it in the form for the visitor to check and save. A saved address is never touched.
   */
  async function locate() {
    if (!('geolocation' in navigator)) return;
    const note = (html) => setHTML(els.status, html);
    note('<span class="muted">Finding your location…</span>');
    let pos;
    try {
      pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 300e3 }));
    } catch (err) {
      note(`<span class="muted">Could not get your location${err && err.code === 1 ? ': permission was refused' : ''}.</span>`);
      return;
    }
    const { latitude: lat, longitude: lon } = pos.coords;
    const name = nearestMuni(lat, lon, await loadCentroids());
    if (name && state.munis.some((m) => m === name)) { state.muni = name; els.muni.value = name; }
    let hit = null;
    if (HAS_GEOCODER) {
      try {
        const res = await fetch(`/api/locate?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
        if (res.ok) hit = await res.json();
      } catch (e) { /* offline or the function is unavailable */ }
    }
    if (hit && hit.address) {
      state.query = hit.address; els.q.value = hit.address;
      if (hit.locality && state.munis.some((m) => m.toLowerCase() === hit.locality.toLowerCase())) { state.muni = state.munis.find((m) => m.toLowerCase() === hit.locality.toLowerCase()); els.muni.value = state.muni; }
      writeState(); render();
      note(`<span class="muted">Nearest address from the BC Address Geocoder. Check it, then press Save Address.</span>`);
      els.q.focus();
    } else {
      writeState(); render();
      note(name ? `<span class="muted">Municipality set to ${esc(name)}. Type your address to continue.</span>` : '<span class="muted">You seem to be outside the areas BC Hydro lists.</span>');
    }
  }

  let muniListSig = '';
  function fillMuniSelect() {
    // Touch the inputs and the suggestion list only when they really change: Chrome closes an open
    // autofill popup whenever a field's value is assigned or nearby form DOM is rewritten.
    const sig = state.munis.join('|');
    if (sig !== muniListSig) {
      muniListSig = sig;
      els.muniList.innerHTML = state.munis.map((m) => `<option value="${esc(m)}"></option>`).join('');
    }
    if (els.muni.value !== state.muni && document.activeElement !== els.muni) els.muni.value = state.muni;
  }

  /** Municipality names matching free text: exact name first, otherwise any name containing the text. */
  function resolveMunis(text) { return M.resolveMunis(state.munis, text); }

  // ------------------------------------------------------------ search

  function statusOf(o, now) { return M.statusOf(o, now); }

  function search() {
    const now = Date.now();
    const q = P.parseQuery(state.query, state.munis);
    let list = state.outages;
    if (!state.past) list = list.filter((o) => statusOf(o, now) !== 'finished');
    const muniFilter = state.muni || q.muni;
    const muniSet = resolveMunis(muniFilter);
    const inMuni = (o, seg) => !muniSet || muniSet.has(o.municipality.toLowerCase()) ||
      (seg ? muniSet.has(seg.locality.toLowerCase()) : o.parsed.segments.some((s) => muniSet.has(s.locality.toLowerCase())));
    if (muniFilter && !q.key) {
      const mf = muniFilter.toLowerCase();
      list = muniSet.size ? list.filter((o) => inMuni(o)) : list.filter((o) => o.parsed.segments.some((s) => s.locality.toLowerCase().includes(mf)));
      const label = muniSet.size === 1 ? [...muniSet][0].replace(/\b\w/g, (c) => c.toUpperCase()) : muniFilter;
      const current = state.current.filter((o) => inMuni(o)).map((o) => ({ o, match: null, muniMatch: true }));
      return { mode: 'municipality', q, muni: label, items: list.map((o) => ({ o, match: null, muniMatch: true })), current, currentLabel: label };
    }
    if (!q.key) return { mode: 'overview', q, items: [], current: [] };
    const current = currentMatches(q, muniSet, inMuni);

    const hits = [];
    for (const o of list) {
      const match = P.matchOutage(q, o.parsed);
      if (!match) continue;
      const muniMatch = inMuni(o, match.segment);
      if (state.muni && !muniMatch) continue;
      hits.push({ o, match, muniMatch });
    }
    // In time order: what is happening now first, then by start time; match quality only breaks ties.
    hits.sort((a, b) => (b.muniMatch - a.muniMatch) || (a.o.dateOff - b.o.dateOff) || (b.match.level - a.match.level) || (b.match.streetScore - a.match.streetScore));
    const currentLabel = muniSet && muniSet.size === 1 ? [...muniSet][0].replace(/\b\w/g, (c) => c.toUpperCase()) : '';
    if (hits.length) return { mode: 'address', q, items: hits, current, currentLabel };

    // Fallback: plain text search over the area description, notes and municipality.
    const words = state.query.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1);
    const text = list.filter((o) => {
      const hay = (o.parsed.text + ' ' + o.parsed.notes.join(' ') + ' ' + o.municipality + ' ' + o.cause).toLowerCase();
      return words.length && words.every((w) => hay.includes(w));
    });
    return { mode: 'text', q, items: text.map((o) => ({ o, match: null, muniMatch: true })), current, currentLabel };
  }

  /**
   * Unplanned outages relevant to an address: any in the same municipality, with street matches first.
   * Without a known municipality only street matches are returned.
   */
  function currentMatches(q, muniSet, inMuni) {
    const out = [];
    for (const o of state.current) {
      const match = P.matchOutage(q, o.parsed);
      const sameMuni = muniSet ? inMuni(o, match ? match.segment : null) : false;
      if (!match && !sameMuni) continue;
      if (match && muniSet && !sameMuni && match.streetScore < 2) continue;
      out.push({ o, match, muniMatch: sameMuni || !muniSet });
    }
    out.sort((a, b) => ((b.match ? b.match.level : 0) - (a.match ? a.match.level : 0)) || (b.o.numCustomersOut - a.o.numCustomersOut));
    return out;
  }

  // ------------------------------------------------------------ your address

  /** Outages that list the saved address: strong = street definitely listed, weak = similar street only. */
  function homeMatches(now, address, muni) {
    const home = address != null ? { address, muni } : state.home;
    return M.homeMatches(state.outages.concat(state.current), state.munis, home, now, state.past);
  }

  function snapshotOf(items) { return M.snapshotOf(items); }
  function computeDiff(base, items, now) { return M.computeDiff(base, items, now); }

  function diffLines(d) {
    const lines = [];
    if (!d) return lines;
    for (const o of d.added) lines.push(o.kind === 'current' ? `Unplanned outage on your street, started ${fmtDateTime(o.dateOff)} (#${o.id})` : `New: ${fmtWindow(o.dateOff, o.dateOn)} (#${o.id})`);
    for (const { o, was } of d.rescheduled) lines.push(`Time changed: was ${fmtWindow(was.dateOff, was.dateOn)}, now ${fmtWindow(o.dateOff, o.dateOn)} (#${o.id})`);
    for (const o of d.cancelled) lines.push(`Cancelled: ${fmtWindow(o.dateOff, o.dateOn)} (#${o.id})`);
    for (const o of d.updated) lines.push(o.kind === 'current' ? `Unplanned outage updated: ${o.dateOn ? 'restoration estimated ' + fmtDateTime(o.dateOn) : 'no restoration estimate yet'} (#${o.id})` : `Address list updated: ${fmtWindow(o.dateOff, o.dateOn)} (#${o.id})`);
    for (const p of d.removed) lines.push(`No longer listed: ${fmtWindow(p.dateOff, p.dateOn)} (#${p.id})`);
    for (const p of d.finished) lines.push(p.kind === 'current' ? `Unplanned outage resolved, started ${fmtDateTime(p.dateOff)} (#${p.id})` : `Finished: ${fmtWindow(p.dateOff, p.dateOn)} (#${p.id})`);
    return lines;
  }





  function updateHomeSnapshot(matches, now) {
    if (state.baseline === undefined) {
      // Baseline is fixed for this browser session so a reload does not wipe the "since last visit" notice.
      // With no earlier visit, the baseline is what the address matched when it was saved, so later polls still diff.
      state.baseline = readJSON(sessionStorage, BASE_KEY) || readJSON(localStorage, SNAP_KEY) || { at: now, items: snapshotOf(matches.strong), first: true };
      writeJSON(sessionStorage, BASE_KEY, state.baseline);
    }
    state.diff = computeDiff(state.baseline, matches.strong, now);
    writeJSON(localStorage, SNAP_KEY, { at: now, items: snapshotOf(matches.strong), address: state.home.address, muni: state.home.muni || '' });
    updateHistory(matches.strong, now);
  }

  /** Long-term record of every outage ever seen for the saved address. Kept per address. */
  function updateHistory(items, now) {
    let hist = readJSON(localStorage, HIST_KEY);
    const addrKey = state.home.address + '|' + (state.home.muni || '');
    if (!hist || hist.address !== addrKey) hist = { address: addrKey, entries: [] };
    const byId = new Map(hist.entries.map((e) => [String(e.id), e]));
    for (const { o, match } of items) {
      const prev = byId.get(String(o.id));
      const entry = {
        id: o.id, kind: o.kind, dateOff: o.dateOff, dateOn: o.dateOn, municipality: o.municipality, cause: o.cause,
        customers: o.numCustomersOut, cancelled: o.parsed.flags.cancelled, listed: match.numberListed,
        segment: match.segment.label, firstSeen: prev ? prev.firstSeen : now, lastSeen: now,
      };
      if (prev && (prev.dateOff !== o.dateOff || prev.dateOn !== o.dateOn)) entry.rescheduledFrom = prev.rescheduledFrom || { dateOff: prev.dateOff, dateOn: prev.dateOn };
      else if (prev && prev.rescheduledFrom) entry.rescheduledFrom = prev.rescheduledFrom;
      byId.set(String(o.id), entry);
    }
    hist.entries = [...byId.values()].sort((a, b) => b.dateOff - a.dateOff).slice(0, HIST_MAX);
    writeJSON(localStorage, HIST_KEY, hist);
    state.history = hist.entries;
  }

  function renderHistory(now) {
    const entries = state.history || [];
    if (!entries.length) return '';
    const rows = entries.map((e) => {
      let st;
      const stillOut = e.kind === 'current' && state.current.some((o) => o.id === e.id);
      if (e.kind === 'current') st = stillOut ? 'in progress' : 'resolved';
      else if (e.cancelled) st = 'cancelled';
      else if (now < e.dateOff) st = 'upcoming';
      else if (now <= e.dateOn) st = 'in progress';
      else st = 'finished';
      const resched = e.rescheduledFrom ? ` <span class="muted">(moved from ${esc(fmtWindow(e.rescheduledFrom.dateOff, e.rescheduledFrom.dateOn))})</span>` : '';
      const when = e.kind === 'current' ? `Unplanned, started ${esc(fmtDateTime(e.dateOff))}` : esc(fmtWindow(e.dateOff, e.dateOn));
      return `<li><span class="hist-when">${when}</span> <span class="badge muted">${st}</span>${resched}<br><span class="muted">${esc(e.segment)} · ${esc(e.cause || '')} · first seen ${esc(fmtDay(e.firstSeen))} · #${e.id}</span></li>`;
    }).join('');
    return `<details class="history"><summary>History for this address (${entries.length} outage${entries.length === 1 ? '' : 's'} seen)</summary><ul>${rows}</ul><p class="hint">Recorded in this browser each time you visit, starting from when you saved the address.</p></details>`;
  }

  function normText(t) { return (t || '').trim().toLowerCase().replace(/\s+/g, ' '); }

  /** Does the current search box hold the saved address? */
  function queryIsHome() {
    return !!state.home && normText(state.query) === normText(state.home.address) && normText(state.muni) === normText(state.home.muni);
  }

  /** The current query counts as an address when it names a street (house number optional). */
  function queryIsAddress() {
    const q = P.parseQuery(state.query, state.munis);
    return !!q.key;
  }

  function saveHome(address, muni) {
    const a = (address || '').trim();
    if (!a) return;
    const changed = !state.home || normText(state.home.address) !== normText(a) || normText(state.home.muni) !== normText(muni);
    state.home = { address: a, muni: (muni || '').trim(), savedAt: Date.now() };
    state.showSearch = false;
    writeJSON(localStorage, HOME_KEY, state.home);
    if (changed) {
      // A new address has no history: start a fresh baseline so nothing is reported as "new".
      writeJSON(localStorage, SNAP_KEY, null);
      writeJSON(sessionStorage, BASE_KEY, null);
      state.baseline = undefined; state.diff = null; state.history = []; state.alertsMsg = '';
    }
    render();
    if (A && changed) A.sync(state.home, state.munis); // moves an existing alert subscription to the new street
  }


  function forgetHome() {
    if (A) A.disable();
    state.home = null; state.baseline = undefined; state.diff = null; state.history = []; state.showSearch = false; state.alertsMsg = '';
    writeJSON(localStorage, HOME_KEY, null); writeJSON(localStorage, SNAP_KEY, null); writeJSON(sessionStorage, BASE_KEY, null); writeJSON(localStorage, HIST_KEY, null);
    state.query = ''; els.q.value = ''; state.muni = DEFAULT_MUNI; els.muni.value = state.muni;
    writeState();
    render();
    els.q.focus();
  }


  function summaryFor(matches, muni, whose) {
    const out = matches.strong.filter((i) => i.o.kind === 'current');
    const planned = matches.strong.filter((i) => i.o.kind === 'planned');
    const n = planned.length;
    const listed = planned.filter((i) => i.match.numberListed === true).length;
    let summary = '';
    if (out.length && whose !== 'your') summary += `<strong class="danger">An unplanned outage is affecting ${whose} street right now.</strong> `;
    if (!n) summary += `No planned outage lists ${whose} street.`;
    else if (listed) summary += `<strong>${listed}</strong> planned outage${listed === 1 ? '' : 's'} list${listed === 1 ? 's' : ''} ${whose} address${n > listed ? `, and ${n - listed} more list${n - listed === 1 ? 's' : ''} ${whose} street` : ''}.`;
    else {
      // Street-only listings (no house numbers given) should not claim the number is excluded.
      const excluded = planned.some((i) => i.match.numberListed === false);
      summary += `<strong>${n}</strong> planned outage${n === 1 ? '' : 's'} list${n === 1 ? 's' : ''} ${whose} street${matches.q.number && excluded ? `, but not ${whose} house number` : ''}.`;
    }
    if (matches.weak.length) summary += ` ${matches.weak.length} similar street name${matches.weak.length === 1 ? '' : 's'} shown below.`;
    if (!out.length && matches.nearby.length && (whose !== 'your' || state.showMore)) summary += ` ${matches.nearby.length} unplanned outage${matches.nearby.length === 1 ? '' : 's'} elsewhere in ${esc(muni || matches.q.muni)}.`;
    return summary;
  }

  const CREW_STEPS = ['NEW', 'ASSIGNED', 'ENROUTE', 'ONSITE'];

  /** Is this matched outage happening right now (unplanned, or a planned one inside its window)? */
  function isLive(o, now) { return o.kind === 'current' || statusOf(o, now) === 'in progress'; }

  /** A prominent box for each outage affecting the street right now: crew status, when power is expected back. */
  function liveStatus(matches, now) {
    let live = matches.strong.filter((i) => isLive(i.o, now));
    // Planned work in progress shows up in both feeds; keep the unplanned-feed copy, which carries crew status.
    const current = live.filter((i) => i.o.kind === 'current');
    live = live.filter((i) => i.o.kind === 'current' || !current.some((c) => c.o.municipality === i.o.municipality && (Math.abs((c.o.dateOn || 0) - (i.o.dateOn || 1)) < 3600e3 || Math.abs(c.o.dateOff - i.o.dateOff) < 3600e3)));
    return live.map(({ o, match }) => {
      const planned = o.kind === 'planned' || /planned work/i.test(o.cause || '');
      const rows = [];
      if (o.kind === 'current') {
        const idx = CREW_STEPS.indexOf(o.crewStatus);
        const bar = idx >= 0 ? `<span class="crew-bar" title="${esc(o.crewStatusDescr || '')}">${CREW_STEPS.map((s, i) => `<span class="${i <= idx ? 'done' : ''}"></span>`).join('')}</span>` : '';
        rows.push(['Crew', `<b>${esc(o.crewStatusDescr || 'No crew information')}</b>${bar}`]);
      }
      let back;
      if (o.dateOn) back = `<b>${esc(fmtDateTime(o.dateOn))}</b> <span class="muted">(${o.dateOn > now ? esc(fmtRelative(o.dateOn - now)) : 'past the estimate'})</span>`;
      else back = `<b>No estimate yet</b>${o.crewEta && o.showEta !== false && o.kind === 'current' ? ` <span class="muted">· crew expected ${esc(fmtDateTime(o.crewEta))} (${esc(fmtRelative(o.crewEta - now))})</span>` : ''}`;
      rows.push(['Power back', back]);
      rows.push(['Out since', `${esc(fmtDateTime(o.dateOff))} <span class="muted">(${esc(fmtAgo(now - o.dateOff))})</span>`]);
      if (o.cause) rows.push(['Cause', esc(o.cause)]);
      rows.push(['Affected', `${o.numCustomersOut != null ? esc(fmtNum(o.numCustomersOut)) + ' customers · ' : ''}${esc(match.segment.label)}`]);
      if (o.crewStatusNote) rows.push(['Note', esc(o.crewStatusNote)]);
      const head = planned ? 'Planned outage in progress on your street' : 'Power is out on your street';
      return `<div class="live${planned ? ' planned' : ''}"><div class="live-head">${head}</div><dl class="live-rows">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></div>`;
    }).join('');
  }

  /** Unplanned outages elsewhere in the municipality: a compact line each, shown while details are hidden. */
  function nearbyBox(matches, now) {
    const near = matches.nearby.filter((i) => i.o.kind === 'current');
    if (!near.length) return '';
    const rows = near.map(({ o }) => {
      const where = o.parsed.segments.length ? o.parsed.segments.map((s) => s.label).join(', ') : o.parsed.text;
      const bits = [o.crewStatusDescr || 'No crew information', `out ${fmtDuration(now - o.dateOff)}`];
      if (o.numCustomersOut != null) bits.push(`${fmtNum(o.numCustomersOut)} customer${o.numCustomersOut === 1 ? '' : 's'}`);
      if (o.dateOn) bits.push(`power back ${fmtDateTime(o.dateOn)}`);
      return `<li><span class="where">${esc(where)}</span><span class="sub">${esc(bits.join(' · '))}</span></li>`;
    });
    return `<div class="nearby card current"><div class="nearby-head">${near.length} unplanned outage${near.length === 1 ? '' : 's'} near you</div><ul>${rows.join('')}</ul></div>`;
  }

  /** The matched outages' times, one line each; outages happening now are in the live box instead. */
  function upcomingList(matches, now) {
    const items = matches.strong.filter((i) => !isLive(i.o, now));
    if (!items.length) return '';
    const rows = items.map(({ o, match }) => {
      const tag = state.diff && state.diff.byId[o.id] ? ` <span class="badge new">${esc(state.diff.byId[o.id])}</span>` : '';
      const where = `<span class="muted">${esc(match.segment.label)}</span>`;
      if (o.kind === 'current') {
        const restore = o.dateOn ? `, estimated restoration ${esc(fmtDateTime(o.dateOn))}` : ', no restoration estimate yet';
        return `<li><span class="danger"><b>Unplanned outage</b> out since ${esc(fmtDateTime(o.dateOff))}${restore}</span>${tag}<br>${where}</li>`;
      }
      const st = statusOf(o, now);
      let when = `<b>${esc(fmtWindow(o.dateOff, o.dateOn))}</b>`;
      let sub = esc(fmtDuration(o.dateOn - o.dateOff));
      if (st === 'upcoming') sub += ` · starts ${esc(fmtRelative(o.dateOff - now))}`;
      else if (st === 'in progress') sub += ` · <span class="danger">in progress now</span>`;
      else if (st === 'cancelled') { when = `<s>${when}</s>`; sub += ' · cancelled'; }
      else sub += ' · finished';
      // Short notes ("Rescheduled from Oct 6") are worth a line; long boilerplate is on the card below.
      const note = o.parsed.notes.length && o.parsed.notes[0].length <= 60 ? ` · ${esc(o.parsed.notes[0])}` : '';
      return `<li>${when}${tag}<span class="sub">${sub}</span><span class="sub">${where}${note}</span></li>`;
    });
    return `<ul class="upcoming">${rows.join('')}</ul>`;
  }

  function renderHome(matches, now) {
    if (!state.home) {
      if (state.query && queryIsAddress()) {
        setHTML(els.home, `<div class="save-alert" role="alert">
  <div>Press <b>Save Address</b> to remember “${esc(state.query)}${state.muni ? ', ' + esc(state.muni) : ''}”. The page will open on it next time and flag anything that changed.</div>
</div>`);
      } else {
        setHTML(els.home, `<p class="hint">Search for your address once and save it. Each visit then opens on it, checks the latest outages and tells you what changed.</p>`);
      }
      return;
    }
    const addr = `<span class="addr">${esc(state.home.address)}${state.home.muni ? ` <span class="muni"><span class="sep">· </span>${esc(state.home.muni)}</span>` : ''}</span>`;
    const savedBar = `<p class="home-actions"><span class="muted">Saved address:</span> ${addr} <a href="#" id="home-show">Show</a> <a href="#" id="home-forget">Clear my address and history</a></p>`;
    if (!queryIsHome()) {
      if (!state.query || !queryIsAddress()) { setHTML(els.home, `<div class="home-card compact">${savedBar}</div>`); return; }
      const other = homeMatches(now, state.query, state.muni);
      setHTML(els.home, `<div class="home-card">
  <h2>Searched address</h2>
  <div><span class="addr">${esc(state.query)}${state.muni ? ` <span class="muni">· ${esc(state.muni)}</span>` : ''}</span></div>
  <p class="home-summary">${summaryFor(other, state.muni, 'this')}</p>
  <p class="hint">Press Save Address to make this your saved address.</p>
  ${savedBar}
</div>`);
      return;
    }
    const d = state.diff;
    const summary = summaryFor(matches, state.home.muni, 'your');

    let changes = '';
    const base = state.baseline;
    if (d && base && base.items) {
      const lines = diffLines(d).map(esc);
      const since = `since ${esc(fmtDateTime(base.at))}`;
      if (lines.length) changes = `<div class="changes"><strong>${lines.length} change${lines.length === 1 ? '' : 's'} ${since}:</strong><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul></div>`;
      else if (!base.first) changes = `<p class="hint">No changes ${since}.</p>`;
    }

    const headline = panelTitle(matches, now);
    const more = `<p class="home-more"><button type="button" class="btn small" id="home-more">${state.showMore ? 'Hide outage details' : 'Show outage details'}</button></p>`;
    const button = titleButton();
    const install = button ? `<span class="install">${button}</span>` : '';
    setHTML(els.home, `<div class="home-card">
  <div class="title-row"><div><h2 class="home-title ${headline.cls}">${headline.text}</h2><p class="home-subtitle">${addr}</p></div>${install}</div>
  <p class="home-actions"><a href="#" id="home-search">Search another address</a> <a href="#" id="home-forget">Clear my address and history</a></p>
  ${liveStatus(matches, now)}
  <p class="home-summary">${summary}</p>
  ${upcomingList(matches, now)}
  ${changes}
  ${alertsControl()}
  ${more}
</div>
${state.showMore ? '' : nearbyBox(matches, now)}`);
  }

  /** What the panel heading says: the state of the saved street in two words. */
  function panelTitle(matches, now) {
    const strong = matches.strong;
    if (strong.some((i) => i.o.kind === 'current')) return { text: 'Power out', cls: 'is-out' };
    if (strong.some((i) => statusOf(i.o, now) === 'in progress')) return { text: 'Planned outage now', cls: 'is-planned' };
    if (strong.some((i) => statusOf(i.o, now) === 'upcoming')) return { text: 'Planned outage', cls: 'is-planned' };
    return { text: 'No outage', cls: 'is-clear' };
  }

  /** The push-alert toggle for the saved address. Empty when the browser or the deploy cannot do push. */
  function alertsControl() {
    if (!A || !A.supported()) return '';
    const st = A.status();
    let html = '';
    if (state.alertsBusy) html = `<span class="muted">Turning on alerts…</span>`;
    else if (!bellShown()) {
      if (st === 'blocked') html = `<span class="muted">Alerts are blocked for this site in your browser's notification settings.</span>`;
      else if (st === 'on') html = `<span class="alerts-on">Alerts on</span> <span class="muted">·</span> <a href="#" id="home-alerts-off">Turn off</a>`;
      else if (A.needsInstall()) html = `<span class="muted">For alerts on iPhone or iPad, press Install above and follow the steps.</span>`;
      else html = `<a href="#" id="home-alerts-on">Get alerts when this changes</a>`;
    }
    const msg = state.alertsMsg ? ` <span class="alerts-msg">${esc(state.alertsMsg)}</span>` : '';
    if (!html && !msg) return '';
    return `<p class="home-alerts">${html}${msg}</p>`;
  }

  // ------------------------------------------------------------ render

  function render() {
    const hideForm = !!state.home && !state.showSearch;
    if (els.form.hidden !== hideForm) els.form.hidden = hideForm;
    if (els.header.hidden !== hideForm) els.header.hidden = hideForm;
    renderStatus();
    if (state.error || state.loading) { setHTML(els.results, ''); setHTML(els.home, ''); return; }
    const now = Date.now();
    let home = null;
    if (state.home) { home = homeMatches(now); updateHomeSnapshot(home, now); }
    renderHome(home, now);
    renderInstall();
    const atHome = queryIsHome();
    if (atHome && !state.showSearch && !state.showMore) { setHTML(els.results, ''); setHTML(els.status, ''); return; }
    const r = search();
    if (r.mode === 'overview') return renderOverview();
    const tags = atHome && state.diff ? state.diff.byId : {};
    const parts = [];
    // Unplanned outages are happening right now, so they come before anything scheduled.
    const hasPlanned = r.items.length > 0;
    if (r.current && r.current.length) {
      const label = r.currentLabel ? ` in ${esc(r.currentLabel)}` : '';
      parts.push(`<p class="group-head">Happening now${label}</p>`);
      parts.push(...r.current.map((i) => card(i, r.q, now, tags[i.o.id])));
      if (hasPlanned) parts.push(`<p class="group-head">Planned</p>`);
    } else if (state.currentError) {
      parts.push(`<p class="hint">Unplanned outages could not be loaded (${esc(state.currentError)}).</p>`);
    }
    if (r.mode === 'address') {
      const strong = r.items.filter((i) => i.muniMatch);
      const other = r.items.filter((i) => !i.muniMatch);
      parts.push(...strong.map((i) => card(i, r.q, now, tags[i.o.id])));
      if (other.length && !atHome) {
        parts.push(`<p class="group-head">Same street name in other municipalities</p>`);
        parts.push(...other.map((i) => card(i, r.q, now)));
      }
    } else {
      parts.push(...r.items.map((i) => card(i, r.q, now)));
    }
    if (atHome) parts.push(renderHistory(now));
    setHTML(els.results, parts.join(''));
    if (atHome) setHTML(els.status, '');
    else summary(r);
  }

  /** Offer to install the page as an app where that is possible and not yet done. */
  /** The header only ever offers Install; the alerts bell belongs to the saved-address panel. */
  function renderInstall() {
    const d = device();
    const html = d.phone && !d.standalone && installable() ? installButton() : '';
    setHTML(els.install, html);
    if (els.install.hidden !== !html) els.install.hidden = !html;
  }

  const BELL_ON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';
  const BELL_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.6 3.3A6 6 0 0 1 18 8c0 3.5.8 5.6 1.6 7M6.3 6.3C6.1 6.8 6 7.4 6 8c0 7-3 9-3 9h14"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

  /** Does this page show the alerts bell (rather than Install, or nothing) in its title row? */
  function bellShown() {
    const d = device();
    if (d.phone && !d.standalone && installable()) return false;
    return !!(A && A.supported() && state.home);
  }

  /** The button at the top right of the title: Install on a phone that has not installed the site, else the alerts bell. */
  function titleButton() {
    const d = device();
    if (d.phone && !d.standalone && installable()) return installButton();
    if (!bellShown()) return '';
    const st = A.status();
    const on = st === 'on';
    const tp = on ? A.topics() : [];
    const label = on ? (tp.includes('muni') ? (tp.includes('street') ? 'Alerts: street + town' : 'Alerts: town') : 'Alerts on') : st === 'blocked' ? 'Alerts blocked' : 'Alerts off';
    return `<button type="button" class="btn small bell${on ? ' on' : ''}" id="alerts-toggle" aria-pressed="${on}" title="${on ? 'Turn alerts off' : 'Turn alerts on'}">${on ? BELL_ON : BELL_OFF}<span>${label}</span></button>`;
  }

  /** The bell was pressed: turn alerts off, or open the dialog that turns them on. */
  /** The bell always opens the options dialog; turning everything off there is what disables alerts. */
  function toggleAlerts() { state.alertsMsg = ''; alertsDialog(); }

  function installable() {
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    return !standalone && !!(state.installPrompt || (A && A.needsInstall()));
  }
  function installButton() { return `<button type="button" class="btn small primary" id="install-ask">Install</button>`; }

  /** What this device is, so dialogs only say what applies to it. */
  function device() {
    const ua = navigator.userAgent;
    const ios = !!(A && A.isIOS());
    const android = /android/i.test(ua);
    return { ios, android, phone: ios || android, standalone: !!(A && A.standalone()) };
  }

  const ALERT_FACTS = {
    cadence: 'We check BC Hydro every 10 minutes, so an alert can be up to 10 minutes behind their website.',
    what: 'You get an alert when an outage listing your street is added, changed, cancelled or removed.',
    street: 'BC Hydro sometimes lists a whole street, so an alert does not always mean your house is affected. Open the page to see the details.',
    privacy: 'Your street name and town are kept on our server so we know what to send you. Your house number stays on this device.',
    unofficial: 'This is not BC Hydro. For anything important, check bchydro.com too.',
  };

  /** Alert limitations for this device only. */
  function alertFacts(d) {
    const facts = [ALERT_FACTS.cadence, ALERT_FACTS.what, ALERT_FACTS.street];
    if (d.ios) facts.push('If you do not open the app for a few weeks, iPhone may stop the alerts. Opening it again turns them back on.');
    else if (d.android) facts.push('Your browser needs permission to show notifications. Battery saver settings can delay alerts by a few hours.');
    else facts.push('Your browser needs permission to show notifications for this site.');
    facts.push(ALERT_FACTS.privacy, ALERT_FACTS.unofficial);
    return facts;
  }

  function list(items) { return `<ul>${items.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`; }
  function homeLabel() { return state.home ? esc(state.home.address) : ''; }

  /**
   * Install on the first tap. Android and desktop get the browser's own install prompt straight away;
   * once it is accepted the alerts offer follows, carrying the limitations. iPhone and iPad have no
   * prompt, so they get the Add to Home Screen steps.
   */
  async function startInstall() {
    const p = state.installPrompt;
    if (!p) { installDialog(); return; }
    state.installPrompt = null; render();
    let accepted = false;
    try { p.prompt(); const choice = await p.userChoice; accepted = !!choice && choice.outcome === 'accepted'; } catch (err) { /* dismissed */ }
    render();
    if (accepted && !maybeOfferAlerts(`Installed. Now turn on alerts for ${homeLabel()}.`) && !state.home) {
      openDialog(`<h3>Installed</h3><p>Save your address to get outage alerts on this device.</p><div class="actions"><button type="button" class="btn small primary" id="dialog-close">OK</button></div>`);
    }
  }

  /** The Add to Home Screen steps for iPhone and iPad, which have no install prompt. */
  function installDialog() {
    const d = device();
    const facts = [
      'This adds Outage to your home screen as a shortcut to this website. It opens full screen like an app.',
      'On iPhone and iPad, alerts only work from the home screen copy, not from Safari. The first time you open it from the icon it will offer to turn alerts on.',
    ].concat(alertFacts(d));
    openDialog(`<h3>Install on ${/ipad/i.test(navigator.userAgent) ? 'iPad' : 'iPhone'}</h3>
<p><b>How:</b> tap the Share button <span aria-hidden="true">(the square with an arrow)</span>, choose <b>Add to Home Screen</b>, then open Outage from the new icon.</p>
${list(facts)}<div class="actions"><button type="button" class="btn small primary" id="dialog-close">Got it</button></div>`);
  }

  /** The alert options for the saved address, with what is currently on, and the limitations for this device. */
  function alertsDialog(intro) {
    const d = device();
    const on = A.topics();
    const first = !on.length;
    const q = P.parseQuery(state.home.address, state.munis);
    const street = q.street || state.home.address;
    const muni = state.home.muni || q.muni || '';
    const st = A.status();
    const blocked = st === 'blocked';
    const row = (key, label, detail, checked, disabled) => `<label class="opt${disabled ? ' off' : ''}"><input type="checkbox" name="topic" value="${key}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span><b>${label}</b> <span class="muted">${detail}</span><span class="state">${checked ? 'on' : 'off'}</span></span></label>`;
    const options = `<div class="opts">
${row('street', esc(street), 'outages that list your street', first ? true : on.includes('street'), blocked)}
${row('muni', muni ? 'All of ' + esc(muni) : 'Your municipality', muni ? 'every outage in ' + esc(muni) + ', planned or unplanned' : 'add a municipality to your address to use this', first ? false : on.includes('muni'), blocked || !muni)}
</div>`;
    const note = blocked ? `<p class="alerts-msg">Notifications are blocked for this site in your browser settings. Allow them there, then come back.</p>` : '';
    const actions = blocked
      ? `<div class="actions"><button type="button" class="btn small primary" id="dialog-close">OK</button></div>`
      : `<div class="actions"><button type="button" class="btn link small" id="dialog-close">Cancel</button> <button type="button" class="btn small primary" id="home-alerts-go">${first ? 'Turn on alerts' : 'Save'}</button></div>`;
    openDialog(`<h3>Outage alerts</h3>${intro ? `<p>${intro}</p>` : ''}${options}${note}<details class="limits"${first ? ' open' : ''}><summary>What to expect</summary>${list(alertFacts(d))}</details>${actions}`);
  }

  const ASKED_KEY = 'outage-finder.alerts-offered';
  /**
   * Offer alerts once, without nagging: right after an install is accepted, and on the first open of the
   * installed app (that is the only way an iPhone can get them). The button in the dialog supplies the
   * user gesture the permission prompt needs.
   */
  function maybeOfferAlerts(intro) {
    if (!A || !A.supported() || !state.home || A.status() !== 'off') return false;
    let asked = false;
    try { asked = !!localStorage.getItem(ASKED_KEY); } catch (e) { /* ignore */ }
    if (asked) return false;
    try { localStorage.setItem(ASKED_KEY, '1'); } catch (e) { /* ignore */ }
    alertsDialog(intro);
    return true;
  }

  function openDialog(html) {
    els.dialog.innerHTML = html;
    if (typeof els.dialog.showModal === 'function') { if (!els.dialog.open) els.dialog.showModal(); }
    else els.dialog.setAttribute('open', '');
  }
  function closeDialog() {
    if (typeof els.dialog.close === 'function' && els.dialog.open) els.dialog.close();
    else els.dialog.removeAttribute('open');
    els.dialog.innerHTML = '';
  }

  function summary(r) {
    const n = r.items.length;
    const scope = state.past ? '' : ' upcoming or in-progress';
    let msg;
    if (r.mode === 'municipality') msg = `<strong>${n}</strong>${scope} planned outage${n === 1 ? '' : 's'} in <strong>${esc(r.muni)}</strong>.`;
    else if (r.mode === 'text') msg = n ? `No street match for “${esc(state.query)}”. Showing <strong>${n}</strong> outage${n === 1 ? '' : 's'} whose description mentions it.` : `Nothing listed for “${esc(state.query)}”${scope ? ' among' + scope + ' outages' : ''}. ${state.past ? '' : 'Try “Include finished outages”, or '}check the spelling of the street.`;
    else {
      const listed = r.items.filter((i) => i.muniMatch && (i.match.numberListed === true || (i.match.numberListed === null && i.match.streetScore >= 2))).length;
      const what = r.q.number ? `${r.q.number} ${esc(r.q.street)}` : esc(r.q.street);
      const where = state.muni || r.q.muni;
      msg = listed
        ? `<strong>${listed}</strong> planned outage${listed === 1 ? '' : 's'} list${listed === 1 ? 's' : ''} <strong>${what}</strong>${where ? ' in ' + esc(where) : ''}.`
        : `No outage lists ${what} exactly${where ? ' in ' + esc(where) : ''}. <strong>${n}</strong> outage${n === 1 ? '' : 's'} mention${n === 1 ? 's' : ''} a matching or similar street.`;
    }
    setHTML(els.status, msg);
  }

  function renderStatus() {
    if (state.loading) setHTML(els.status, 'Loading BC Hydro planned outages…');
    else if (state.error) setHTML(els.status, `<div class="error">${esc(state.error)} <button type="button" class="btn link" id="retry">Retry</button></div>`);
    else setHTML(els.status, '');
    const upd = state.updatedDate ? `Feed updated ${fmtDateTime(state.updatedDate)}.` : '';
    if (els.updated.textContent !== upd) els.updated.textContent = upd;
    const retry = $('#retry');
    if (retry) retry.addEventListener('click', load);
  }


  function renderOverview(target) {
    const now = Date.now();
    const active = state.outages.filter((o) => state.past || statusOf(o, now) !== 'finished');
    const byRegion = new Map();
    for (const o of active.concat(state.current)) {
      if (!byRegion.has(o.regionName)) byRegion.set(o.regionName, new Map());
      const m = byRegion.get(o.regionName);
      m.set(o.municipality, (m.get(o.municipality) || 0) + 1);
    }
    const soon = active.filter((o) => statusOf(o, now) !== 'cancelled' && o.dateOff - now < 48 * 3600e3).length;
    const cur = state.current.length;
    const curCustomers = state.current.reduce((a, o) => a + (o.numCustomersOut || 0), 0);
    const intro = `<strong>${active.length}</strong> planned outages listed across BC, <strong>${soon}</strong> starting within 48 hours. <strong>${cur}</strong> unplanned outage${cur === 1 ? '' : 's'} right now affecting ${fmtNum(curCustomers)} customers.`;
    if (!target) setHTML(els.status, intro + ' Search above, or browse a municipality:');
    const html = [...byRegion.keys()].sort().map((region) => {
      const munis = [...byRegion.get(region).entries()].sort((a, b) => a[0].localeCompare(b[0]));
      return `<section class="overview"><h2>${esc(region)}</h2><div class="chips">` +
        munis.map(([m, n]) => `<button type="button" class="chip" data-muni="${esc(m)}">${esc(m)}<span class="n">${n}</span></button>`).join('') +
        `</div></section>`;
    }).join('');
    if (target) setHTML(target, `<p class="hint">${intro}</p>` + html);
    else setHTML(els.results, html);
  }

  function card(item, q, now, changeTag) {
    if (item.o.kind === 'current') return currentCard(item, q, now, changeTag);
    const o = item.o;
    const st = statusOf(o, now);
    const m = item.match;
    const badges = [];
    if (changeTag) badges.push(`<span class="badge new">${esc(changeTag)}</span>`);
    if (m) {
      if (m.numberListed === true) { if (m.streetScore < 2) badges.push('<span class="badge hit">Address listed (similar street name)</span>'); }
      else if (m.numberListed === false) badges.push(`<span class="badge warn">Street listed, but ${q.number} is not in the listed numbers</span>`);
      else badges.push(`<span class="badge ${m.streetScore >= 2 ? 'hit' : ''}">${m.streetScore >= 2 ? 'Street listed' : 'Similar street name'}</span>`);
      if (!item.muniMatch) badges.push(`<span class="badge muted">${esc(o.municipality)}, not ${esc(state.muni || q.muni)}</span>`);
    }
    badges.push(statusBadge(o, st, now));
    if (o.parsed.flags.rescheduled && !o.parsed.flags.cancelled) badges.push('<span class="badge warn">Rescheduled</span>');
    if (o.parsed.flags.continued) badges.push('<span class="badge muted">Continuation of another listing</span>');

    const segs = addressList(o, m, q);

    const customers = o.numCustomersOut < 5 ? 'fewer than 5' : fmtNum(o.numCustomersOut);
    const hitClass = m && m.numberListed === true && item.muniMatch ? ' hit' : '';
    return `
<article class="card${hitClass}${st === 'cancelled' ? ' cancelled' : ''}" id="o-${o.id}">
  <div class="card-top">${badges.join('')}</div>
  <h3 class="when">${fmtWindow(o.dateOff, o.dateOn)} <span class="dur">(${fmtDuration(o.dateOn - o.dateOff)})</span></h3>
  <p class="meta"><b>${esc(o.municipality)}</b> · ${customers} customer${o.numCustomersOut === 1 ? '' : 's'} · ${esc(o.cause || 'Planned work')}</p>
  ${o.parsed.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
  ${segs}
  <details class="raw"><summary>Original area text from BC Hydro</summary><pre>${esc(o.parsed.text)}</pre></details>
  ${o.related.length ? `<p class="related">Same time window in ${esc(o.municipality)} (likely the same job):${o.related.map((id) => `<button type="button" data-goto="${id}">#${id}</button>`).join('')}</p>` : ''}
  <p class="card-foot"><span>Outage #${o.id}</span><span>Listing updated ${fmtDateTime(o.lastUpdated)}</span><a href="${OFFICIAL}#planned-${o.regionId}" rel="noopener" target="_blank">View region on bchydro.com</a></p>
</article>`;
  }

  function currentCard(item, q, now, changeTag) {
    const o = item.o;
    const m = item.match;
    const badges = [];
    if (changeTag) badges.push(`<span class="badge new">${esc(changeTag)}</span>`);
    badges.push('<span class="badge danger">Unplanned outage</span>');
    if (m && m.streetScore >= 2 && !m.segment.boundary) badges.push(`<span class="badge hit">${m.numberListed === true ? 'Your address is in the affected block' : 'Your street is affected'}</span>`);
    else if (m && m.segment.boundary) badges.push('<span class="badge muted">Your street bounds the affected area</span>');
    if (o.crewStatusDescr) badges.push(`<span class="badge">${esc(o.crewStatusDescr)}</span>`);
    const segs = addressList(o, m, q);
    const customers = o.numCustomersOut < 5 ? 'fewer than 5' : fmtNum(o.numCustomersOut);
    const restore = o.dateOn ? `Estimated restoration <b>${esc(fmtDateTime(o.dateOn))}</b>` : 'No restoration estimate yet';
    const eta = !o.dateOn && o.crewEta && o.showEta ? ` · Crew expected ${esc(fmtDateTime(o.crewEta))}` : '';
    const dur = fmtDuration(now - o.dateOff);
    return `
<article class="card current${m && m.streetScore >= 2 && !m.segment.boundary ? ' hit' : ''}" id="o-${o.id}">
  <div class="card-top">${badges.join('')}</div>
  <h3 class="when">Out since ${esc(fmtDateTime(o.dateOff))} <span class="dur">(${dur} so far)</span></h3>
  <p class="meta"><b>${esc(o.municipality)}</b> · ${customers} customer${o.numCustomersOut === 1 ? '' : 's'} · ${esc(o.cause || 'Cause not yet known')}</p>
  <p class="meta">${restore}${eta}${o.crewStatusNote ? ' · ' + esc(o.crewStatusNote) : ''}</p>
  ${segs}
  <p class="card-foot"><span>Outage #${o.id}</span><span>Updated ${fmtDateTime(o.lastUpdated)}</span><a href="${MAP}${o.id}" rel="noopener" target="_blank">View on map</a><a href="${OFFICIAL_CURRENT}#current-${o.regionId}" rel="noopener" target="_blank">bchydro.com</a></p>
</article>`;
  }

  /**
   * The outage's street list. When the card is the result of an address match, only the segments on that
   * street are shown and the rest sit behind a toggle; otherwise every segment is listed.
   */
  function addressList(o, m, q) {
    const item = (s, isMatch) => {
      const loc = s.locality && s.locality !== o.municipality ? ` <span class="loc">(${esc(s.locality)})</span>` : '';
      const qual = s.qualifier ? ` <span class="qual">(${esc(s.qualifier)})</span>` : '';
      return `<li class="${isMatch ? 'match' : ''}">${esc(s.label)}${qual}${loc}</li>`;
    };
    const all = o.parsed.segments;
    if (!all.length) return '';
    if (!m) return `<ul class="addresses">${all.map((s) => item(s, false)).join('')}</ul>`;
    const onStreet = all.filter((s) => s === m.segment || (q && q.key && P.streetScore(q, s) >= 2));
    const rest = all.filter((s) => !onStreet.includes(s));
    let html = `<ul class="addresses">${onStreet.map((s) => item(s, s === m.segment)).join('')}</ul>`;
    if (rest.length) {
      html += `<details class="more-streets"><summary>${rest.length} other street${rest.length === 1 ? '' : 's'} in this outage</summary><ul class="addresses">${rest.map((s) => item(s, false)).join('')}</ul></details>`;
    }
    return html;
  }

  function statusBadge(o, st, now) {
    if (st === 'cancelled') return '<span class="badge danger">Cancelled</span>';
    if (st === 'in progress') return '<span class="badge danger">In progress now</span>';
    if (st === 'finished') return '<span class="badge muted">Finished</span>';
    return `<span class="badge">Starts ${fmtRelative(o.dateOff - now)}</span>`;
  }

  // ------------------------------------------------------------ formatting

  const dFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
  const dyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const tFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

  function fmtTime(ms) { return tFmt.format(new Date(ms)).replace(/\./g, '').replace(/\s?([ap])m/i, ' $1.m.'); }
  function fmtDay(ms) {
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return (sameYear ? dFmt : dyFmt).format(d).replace(/\.,?/g, '').replace(/,\s*$/, '');
  }
  function fmtWindow(off, on) {
    if (dayKey.format(new Date(off)) === dayKey.format(new Date(on))) return `${fmtDay(off)}, ${fmtTime(off)} – ${fmtTime(on)}`;
    return `${fmtDay(off)}, ${fmtTime(off)} – ${fmtDay(on)}, ${fmtTime(on)}`;
  }
  function fmtDateTime(ms) { return `${fmtDay(ms)} ${fmtTime(ms)}`; }
  function fmtDuration(ms) {
    const h = ms / 3600e3;
    if (h < 1) return Math.round(ms / 60e3) + ' min';
    if (h < 24) return (Math.round(h * 10) / 10).toString().replace(/\.0$/, '') + ' h';
    const d = Math.floor(h / 24); const rem = Math.round(h - d * 24);
    return `${d} day${d === 1 ? '' : 's'}${rem ? ' ' + rem + ' h' : ''}`;
  }
  function fmtRelative(ms) {
    const h = ms / 3600e3;
    if (h < 1) return 'in ' + Math.max(1, Math.round(ms / 60e3)) + ' min';
    if (h < 36) return 'in ' + Math.round(h) + ' h';
    const d = Math.round(h / 24);
    return `in ${d} day${d === 1 ? '' : 's'}`;
  }
  function fmtAgo(ms) {
    const h = ms / 3600e3;
    if (h < 1) return Math.max(1, Math.round(ms / 60e3)) + ' min ago';
    if (h < 36) return Math.round(h) + ' h ago';
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }
  function fmtNum(n) { return Number(n).toLocaleString('en-CA'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ------------------------------------------------------------ state <-> URL/storage

  function readState() {
    const u = new URLSearchParams(location.search);
    const past = u.get('past') === '1';
    let q = '', muni = '';
    if (state.home) { q = state.home.address; muni = state.home.muni || ''; }
    else if (u.get('q') != null || u.get('muni') != null) { q = u.get('q') || ''; muni = u.get('muni') || DEFAULT_MUNI; }
    else muni = DEFAULT_MUNI;
    state.query = q; state.muni = muni; state.past = past;
    els.q.value = state.query; els.muni.value = state.muni; els.past.checked = state.past;
  }
  function writeState() {
    // The saved address, not the URL, decides what the page opens on; only the "finished" toggle is kept in the URL.
    const u = new URLSearchParams();
    if (state.past) u.set('past', '1');
    const qs = u.toString();
    const next = qs ? '?' + qs : '';
    if (location.search === next) return;
    try { history.replaceState(null, '', next || location.pathname); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ events

  const DEBOUNCE_MS = 400;
  let timer = 0;
  /**
   * A full address typed, pasted or autofilled into the address line ("742 Evergreen Terrace, Bowen Island, BC V0N 1G0")
   * carries its municipality: move that into the Municipality field and keep only the street part.
   * Only a municipality the feeds know is moved, so a street called "Hope" or an unknown town is left alone.
   */
  function absorbMuni() {
    const q = P.parseQuery(state.query, state.munis);
    if (!q.muni || !q.key) return false;
    const known = state.munis.find((m) => m.toLowerCase() === q.muni.toLowerCase());
    if (!known) return false;
    const address = `${q.unit ? q.unit + '-' : ''}${q.number != null ? q.number + ' ' : ''}${q.street}`.trim();
    state.query = address; state.muni = known;
    if (els.q.value !== address) els.q.value = address;
    if (els.muni.value !== known) els.muni.value = known;
    return true;
  }

  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const v = els.q.value.trim();
      if (v === state.query) return;
      state.query = v; absorbMuni(); writeState(); render();
    }, DEBOUNCE_MS);
  }
  els.q.addEventListener('input', onInput);
  els.form.addEventListener('submit', (e) => {
    e.preventDefault(); clearTimeout(timer);
    state.query = els.q.value.trim(); absorbMuni(); writeState();
    if (state.query && queryIsAddress()) saveHome(state.query, state.muni);
    else render();
    els.q.blur();
  });
  els.q.addEventListener('blur', () => { const v = els.q.value.trim(); if (v !== state.query) { clearTimeout(timer); state.query = v; absorbMuni(); writeState(); render(); } });
  let muniTimer = 0;
  const onMuni = () => {
    clearTimeout(muniTimer);
    muniTimer = setTimeout(() => {
      const v = els.muni.value.trim();
      if (v === state.muni) return;
      state.muni = v; writeState(); render();
    }, DEBOUNCE_MS);
  };
  els.muni.addEventListener('input', onMuni);
  els.muni.addEventListener('change', onMuni);
  els.past.addEventListener('change', () => { state.past = els.past.checked; writeState(); render(); });
  // Offered only when the deploy can turn a location into an address; the municipality guess alone is not worth a button.
  if ('geolocation' in navigator && HAS_GEOCODER) els.locate.hidden = false;
  els.locate.addEventListener('click', () => locate());
  els.clear.addEventListener('click', () => { state.query = ''; state.muni = DEFAULT_MUNI; els.q.value = ''; els.muni.value = state.muni; writeState(); render(); els.q.focus(); });
  els.results.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-muni]');
    if (chip) { state.muni = chip.dataset.muni; els.muni.value = state.muni; writeState(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const go = e.target.closest('[data-goto]');
    if (go) {
      let target = document.getElementById('o-' + go.dataset.goto);
      if (!target) { state.past = true; els.past.checked = true; state.muni = ''; els.muni.value = ''; state.query = ''; els.q.value = ''; writeState(); render(); target = document.getElementById('o-' + go.dataset.goto); }
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); target.classList.add('hit'); }
    }
  });
  els.home.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const id = b ? b.id : e.target.id;
    if (id === 'install-ask') startInstall();
    else if (id === 'alerts-toggle') toggleAlerts();
    else if (id === 'home-forget') {
      e.preventDefault();
      if (window.confirm(`Clear your saved address (${state.home.address}) and its outage history from this browser?`)) forgetHome();
    }
    else if (id === 'home-search') {
      e.preventDefault();
      state.showSearch = true; state.query = ''; els.q.value = ''; state.muni = state.home.muni || DEFAULT_MUNI; els.muni.value = state.muni;
      writeState(); render(); els.q.focus();
    }
    else if (id === 'home-alerts-on') { e.preventDefault(); state.alertsMsg = ''; alertsDialog(); }
    else if (id === 'home-alerts-off') {
      e.preventDefault();
      state.alertsMsg = '';
      A.disable().then(() => render());
      render();
    }
    else if (id === 'home-more') {
      state.showMore = !state.showMore; render();
      if (state.showMore) els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    else if (id === 'home-show') { e.preventDefault(); state.showSearch = false; state.query = state.home.address; els.q.value = state.query; state.muni = state.home.muni || ''; els.muni.value = state.muni; writeState(); render(); }
  });
  window.addEventListener('popstate', () => { readState(); render(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; render(); });
  window.addEventListener('appinstalled', () => { state.installPrompt = null; render(); });
  els.install.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'install-ask') startInstall();
    else if (b.id === 'alerts-toggle') toggleAlerts();
  });
  els.dialog.addEventListener('click', async (e) => {
    const id = e.target.id;
    if (id === 'dialog-close') closeDialog();
    else if (id === 'home-alerts-go') {
      const wanted = [...els.dialog.querySelectorAll('input[name="topic"]:checked')].map((i) => i.value);
      closeDialog();
      state.alertsBusy = true; state.alertsMsg = ''; render();
      const action = wanted.length ? A.enable(state.home, state.munis, wanted) : A.disable().then(() => { state.alertsMsg = 'Alerts off.'; });
      action
        .catch((err) => { state.alertsMsg = err && err.message ? err.message : 'Could not update alerts.'; })
        .then(() => { state.alertsBusy = false; render(); });
    }
  });

  readState();
  load();
})();
