/* BC Hydro planned outage finder — UI. Depends on parse.js (window.OutageParser). */
(function () {
  'use strict';
  const P = window.OutageParser;
  const M = window.OutageMatcher;
  const A = window.OutageAlerts || null; // push alerts (optional module)
  const API = window.OUTAGE_API || '/api/planned';
  const API_CURRENT = window.OUTAGE_API_CURRENT || '/api/current';
  const MAP = 'https://www.bchydro.com/power-outages/app/outage-map.html#outage=';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    header: $('.site-header'), form: $('#search-form'), q: $('#street-address'), muni: $('#city'), muniList: $('#muni-list'), past: $('#past'), clear: $('#clear'),
    freshness: $('#freshness'), status: $('#status'), results: $('#results'), updated: $('#updated'), home: $('#home'), install: $('#install'), dialog: $('#dialog'), sheet: $('#outage-dialog'), locate: $('#locate'),
  };

  const HOME_KEY = 'outage-finder.home';
  const SNAP_KEY = 'outage-finder.snapshot';
  const BASE_KEY = 'outage-finder.baseline';
  const HIST_KEY = 'outage-finder.history';
  const HIST_MAX = 300;
  const CHANGES_KEY = 'outage-finder.changes';
  const CHANGES_KEEP_MS = 7 * 24 * 3600 * 1000; // with auto-clear on, a change goes a week after its outage ends
  const DEFAULT_MUNI = ''; // nothing is prefilled; an empty municipality searches every municipality
  const GEO_MAX_KM = 60; // a centroid further than this is not a guess worth making
  const geocoderMeta = document.querySelector('meta[name="geocoder"]');
  const HAS_GEOCODER = !!(geocoderMeta && geocoderMeta.content); // set at build time when BC_GEOCODER_KEY exists

  const state = {
    outages: [], munis: [], byMuni: new Map(), updatedDate: 0, query: '', muni: '', past: false, loading: false, error: '',
    home: readJSON(localStorage, HOME_KEY), baseline: undefined, diff: null, history: [], changeLog: [], changeLogAuto: false, showSearch: false,
    alertsBusy: false, alertsMsg: '', showMore: false, installPrompt: null,
    current: [], currentError: '',
  };

  /**
   * Assign innerHTML only when it changes, so a render that produces the same page mutates nothing.
   * Compared with what was last written rather than the live DOM, which the column fitting adjusts.
   */
  function setHTML(el, html) {
    if (el._html === html) return;
    el._html = html;
    el.innerHTML = html;
    if (html.includes('addresses') && window.OutageColumns) window.OutageColumns.schedule();
  }

  function readJSON(store, key) { try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; } }
  function writeJSON(store, key, val) {
    try { if (val == null) store.removeItem(key); else store.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ }
  }

  // ------------------------------------------------------------ data

  // Feeds older than this are fetched again when the page comes back into view (the /api proxy caches for 2 minutes).
  const STALE_MS = 2 * 60e3;
  let loadedAt = 0;
  let loading = null;

  function load() {
    if (!loading) loading = loadFeeds().finally(() => { loading = null; });
    return loading;
  }
  async function loadFeeds() {
    state.loading = true; state.error = '';
    renderStatus();
    try {
      const [planned, current] = await Promise.allSettled([fetchJSON(API), fetchJSON(API_CURRENT)]);
      if (planned.status !== 'fulfilled') throw planned.reason;
      state.currentError = current.status === 'fulfilled' ? '' : String(current.reason && current.reason.message || current.reason);
      ingest(planned.value, current.status === 'fulfilled' ? current.value : null);
      loadedAt = Date.now();
    } catch (err) {
      state.error = 'Could not load the outage feed (' + (err.message || err) + '). Try again in a minute.';
    } finally {
      state.loading = false;
      render();
      document.documentElement.removeAttribute('data-boot');
      if (A) A.register().catch(() => {});
      if (A && state.home && !state.error) {
        A.sync(state.home, state.munis).then((changed) => { if (changed) render(); });
        maybeOfferAlerts(A.standalone() ? `Turn on alerts for ${homeLabel()} so this app can tell you when something changes.` : alertsIntro());
      }
    }
  }

  /*
   * Fetch the feeds again without blanking the page: the old results stay on screen until the new ones arrive,
   * and a failed refresh keeps them (they are still the latest known) rather than replacing them with an error.
   */
  function refresh() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const [planned, current] = await Promise.allSettled([fetchJSON(API), fetchJSON(API_CURRENT)]);
        if (planned.status !== 'fulfilled') return;
        state.currentError = current.status === 'fulfilled' ? '' : String(current.reason && current.reason.message || current.reason);
        ingest(planned.value, current.status === 'fulfilled' ? current.value : null);
        loadedAt = Date.now(); state.error = ''; checkFailed = false;
      } catch (e) { /* keep what is shown */ } finally { render(); }
    })().finally(() => { loading = null; });
    return loading;
  }

  /*
   * While the page is in view it refetches every STALE_MS for AUTO_MS after it was opened or came back into view
   * (a phone unlocked, the tab or app reopened). After that it stops, and a bar at the top says when the data is
   * from, with a button to check again, so a page left open does not poll forever.
   */
  const AUTO_MS = 10 * 60e3;
  let autoUntil = Date.now() + AUTO_MS;
  function onReturn() {
    if (document.visibilityState !== 'visible') return;
    autoUntil = Date.now() + AUTO_MS;
    if (!loadedAt) { if (state.error && !loading) load(); return; } // the first load is still running, or failed
    if (Date.now() - loadedAt > STALE_MS) refresh(); else render();
  }
  // Switching tabs, minimising, locking a phone: visibilitychange. Switching apps while the window stays on screen
  // only moves focus, so that counts too. Both can fire together; a refresh already running is reused.
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);
  window.addEventListener('pageshow', (e) => { if (e.persisted) onReturn(); }); // restored from the back/forward cache
  window.addEventListener('online', onReturn);
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (loadedAt && Date.now() < autoUntil && Date.now() - loadedAt > STALE_MS) refresh();
    else renderFreshness();
  }, 30e3);

  /** The "data from" bar: hidden while refreshing automatically, shown once that stops or keeps failing. */
  let checkFailed = false;
  function renderFreshness() {
    const show = !!loadedAt && (Date.now() >= autoUntil || Date.now() - loadedAt > 5 * 60e3);
    if (els.freshness.hidden !== !show) els.freshness.hidden = !show;
    if (!show) return;
    const at = `${fmtDateTime(loadedAt)} (${fmtAgo(Date.now() - loadedAt)})`;
    setHTML(els.freshness, loading
      ? `<span>Checking for updates…</span>`
      : `<span>${checkFailed ? 'Could not check for updates. ' : ''}Showing outage data from <b>${esc(at)}</b></span><button type="button" class="btn small primary" id="check-updates">Check for updates</button>`);
  }
  els.freshness.addEventListener('click', (e) => {
    if (!e.target.closest('#check-updates')) return;
    const before = loadedAt;
    const p = refresh();
    renderFreshness();
    p.then(() => {
      checkFailed = loadedAt === before;
      if (!checkFailed) autoUntil = Date.now() + AUTO_MS; // fresh data: back to refreshing on its own for a while
      renderFreshness();
    });
  });

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
    if (!state.past) list = list.filter((o) => !M.longFinished(o, now));
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
    const muniLabel = currentLabel || muniFilter || '';
    // Planned outages elsewhere in the municipality that the results above do not already show.
    const othersOf = (shown) => {
      if (!muniSet || !muniSet.size) return [];
      const ids = new Set(shown.map((i) => i.o.id));
      return list.filter((o) => !ids.has(o.id) && inMuni(o)).map((o) => ({ o, match: null, muniMatch: true }));
    };
    if (hits.length) return { mode: 'address', q, items: hits, current, currentLabel, others: othersOf(hits), muniLabel };

    // Fallback: plain text search over the area description, notes and municipality.
    const words = state.query.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1);
    const text = list.filter((o) => {
      const hay = (o.parsed.text + ' ' + o.parsed.notes.join(' ') + ' ' + o.municipality + ' ' + o.cause).toLowerCase();
      return words.length && words.every((w) => hay.includes(w));
    });
    const items = text.map((o) => ({ o, match: null, muniMatch: true }));
    return { mode: 'text', q, items, current, currentLabel, others: othersOf(items), muniLabel };
  }

  /**
   * The municipality's other planned outages, in an expandable section below the address's own: each a summary with a chip saying it
   * is not the address, and a "Details" button that opens the whole card in a dialog.
   */
  function othersBlock(r, q, now) {
    const where = r.muniLabel ? ` in ${esc(r.muniLabel)}` : '';
    const chip = state.home && queryIsHome() ? 'Not your address' : 'Not this address';
    // Collapsed under a heading with the count; opening it is kept across re-renders (setHTML leaves it alone).
    return `<details class="others-section"><summary class="others-head">Other planned outages${where} (${r.others.length})</summary><div class="results">${r.others.map((i) => card(i, q, now, null, { summary: true, chip, streets: true })).join('')}</div></details>`;
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


  /** One {id, line, end} per change; `end` is when the outage ends (null if unknown), for pruning the change log. */
  function diffEntries(d) {
    const out = [];
    if (!d) return out;
    const now = Date.now();
    // Each line is "<chip> — <what changed>", optionally followed by a newline and a line of context. The chip
    // text matches the chip the outage's card gets.
    const add = (id, chip, text, detail, end) => out.push({ id, line: `${chip} — ${text}${detail ? '\n' + detail : ''}`, end: Number.isFinite(end) ? end : null });
    const when = (x) => `${fmtWindow(x.dateOff, x.dateOn)} (${fmtDuration(x.dateOn - x.dateOff)})`;
    const startsIn = (x) => (x.dateOff > now ? `starts ${fmtRelative(x.dateOff - now)}` : x.dateOn > now ? 'in progress now' : 'finished');
    const people = (o) => (o.numCustomersOut == null ? '' : `${o.numCustomersOut < 5 ? 'fewer than 5' : fmtNum(o.numCustomersOut)} customers`);
    // Cause, customers and anything BC Hydro noted, as one line of context for a planned outage.
    const about = (o) => [o.cause, people(o)].concat(cardNotes(o).notes).filter(Boolean).join(' · ');
    const shift = (from, to) => {
      const ms = to - from;
      if (!ms) return '';
      const days = Math.round(Math.abs(ms) / 864e5);
      return days >= 1 ? `${days} day${days === 1 ? '' : 's'} ${ms > 0 ? 'later' : 'earlier'}` : `${fmtDuration(Math.abs(ms))} ${ms > 0 ? 'later' : 'earlier'}`;
    };
    const streets = (text) => new Set(P.parseArea(text || '', state.munis).segments.map((x) => x.label));

    for (const o of d.added) {
      if (o.kind === 'current') {
        add(o.id, o.plannedWork ? 'Planned work started' : 'New unplanned outage', `Power out since ${fmtDateTime(o.dateOff)}${o.dateOn ? `, expected back ${fmtDateTime(o.dateOn)}` : ', no restoration estimate yet'}`,
          [o.cause, people(o), o.crewStatusDescr].filter(Boolean).join(' · '), o.dateOn);
      } else add(o.id, 'New', `${when(o)}, ${startsIn(o)}`, about(o), o.dateOn);
    }
    for (const { o, was, wasId } of d.rescheduled) {
      if (wasId) {
        add(o.id, 'Rescheduled', `Moved from ${when(was)} to ${when(o)}, ${shift(was.dateOff, o.dateOff)}`, about(o), Math.max(o.dateOn, was.dateOn));
      } else {
        const moved = [shift(was.dateOff, o.dateOff) && `starts ${shift(was.dateOff, o.dateOff)}`, shift(was.dateOn, o.dateOn) && `ends ${shift(was.dateOn, o.dateOn)}`].filter(Boolean).join(', ');
        add(o.id, 'Time changed', `Now ${when(o)}, was ${when(was)}${moved ? ` (${moved})` : ''}`, about(o), Math.max(o.dateOn, was.dateOn));
      }
    }
    for (const o of d.cancelled) add(o.id, 'Now cancelled', `${when(o)} will not go ahead`, about(o), o.dateOn);
    for (const o of d.updated) {
      if (o.kind === 'current') {
        add(o.id, 'Updated', `${o.plannedWork ? 'Planned work' : 'Unplanned outage'} since ${fmtDateTime(o.dateOff)}: ${o.dateOn ? 'power expected back ' + fmtDateTime(o.dateOn) : 'no restoration estimate yet'}`,
          [o.crewStatusDescr, people(o)].filter(Boolean).join(' · '), o.dateOn);
        continue;
      }
      // Which streets came and went, from the listing's text then and now.
      const prev = d.prevText && d.prevText[o.id];
      const before = streets(prev), after = new Set(o.parsed.segments.map((x) => x.label));
      const added = [...after].filter((x) => !before.has(x)), removed = [...before].filter((x) => !after.has(x));
      const list = (a) => a.slice(0, 4).join(', ') + (a.length > 4 ? ` and ${a.length - 4} more` : '');
      const what = prev ? [added.length && `added ${list(added)}`, removed.length && `removed ${list(removed)}`].filter(Boolean).join('; ') : '';
      add(o.id, 'Street list changed', `${when(o)}: ${what || 'BC Hydro reworded the listing'}`, about(o), o.dateOn);
    }
    for (const p of d.removed) add(p.id, 'No longer listed', `${when(p)} was taken off BC Hydro's list before it happened, so it is probably cancelled`, '', p.dateOn);
    for (const p of d.finished) {
      if (p.kind === 'current') add(p.id, 'Power restored', `${p.plannedWork ? 'Planned work' : 'Unplanned outage'} from ${fmtDateTime(p.dateOff)} is over`, '', p.dateOn);
      else add(p.id, 'Finished', `${when(p)} has ended`, '', p.dateOn);
    }
    return out;
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
    updateChangeLog(matches.strong, now);
  }

  /**
   * Every change seen for the saved address. Kept until the user clears it, or, with auto-clear
   * ticked, until a week after the outage ends.
   * Diffs against its own snapshot of unfinished outages, so showing past outages logs nothing.
   */
  function updateChangeLog(strong, now) {
    const addrKey = state.home.address + '|' + (state.home.muni || '');
    const items = strong.filter((i) => statusOf(i.o, now) !== 'finished');
    let log = readJSON(localStorage, CHANGES_KEY);
    if (!log || log.address !== addrKey || !log.snap) log = { address: addrKey, entries: [] }; // first sight is the baseline
    else for (const e of diffEntries(computeDiff(log.snap, items, now))) log.entries.push({ at: now, ...e });
    log.snap = { at: now, items: snapshotOf(items) };
    if (log.autoClear) log.entries = log.entries.filter((e) => (e.end != null ? Math.max(e.end, e.at) : e.at) + CHANGES_KEEP_MS >= now);
    writeJSON(localStorage, CHANGES_KEY, log);
    state.changeLog = log.entries;
    state.changeLogAuto = !!log.autoClear;
  }

  /** Clear the change log now, or switch auto-clear on or off; the log's snapshot is kept either way. */
  function editChangeLog(edit) {
    const log = readJSON(localStorage, CHANGES_KEY);
    if (!log) return;
    if (edit.clear) log.entries = [];
    if ('autoClear' in edit) log.autoClear = edit.autoClear;
    writeJSON(localStorage, CHANGES_KEY, log);
    render(); // re-runs updateChangeLog, which applies auto-clear straight away
  }

  /** The change log behind a button, shown only when it holds more than the "since your last visit" list. */
  /**
   * One change as a chip and plain text: "Rescheduled — Sat, Nov 7 ..." becomes [Rescheduled] Sat, Nov 7 ....
   * Lines saved before the chips existed ("Finished: ...") are split the same way; anything else is shown as is.
   */
  function changeRow(line, at, id) {
    const m = line.match(/^(.+?)(?: — |: )([\s\S]+)$/);
    // The chip (and, in the history, when it was seen) on its own row above the text, with a button for the
    // outage's details while BC Hydro still lists it.
    const chip = m ? `<span class="badge new">${esc(m[1])}</span>` : '';
    const when = at ? `<span class="muted">${esc(fmtDateTime(at))}</span>` : '';
    const listed = id != null && state.outages.concat(state.current).some((o) => String(o.id) === String(id));
    const more = listed ? `<button type="button" class="btn small details-btn" data-details="${esc(String(id))}">Details</button>` : '';
    const head = chip || when || more ? `<span class="change-head">${chip}${when}${more}</span>` : '';
    const [text, detail] = (m ? m[2] : line).split('\n');
    return `<li>${head}${esc(text)}${detail ? `<span class="change-detail">${esc(detail)}</span>` : ''}</li>`;
  }

  /** What changed for the saved address: since the last visit (from the baseline), and earlier (from the log). */
  function changesSeen() {
    const base = state.baseline;
    const lines = state.diff && base && base.items ? diffEntries(state.diff) : [];
    const since = base && base.items && !base.first ? base.at : Infinity;
    const earlier = (state.changeLog || []).filter((e) => e.at <= since);
    return { base, lines, earlier };
  }

  /** The button under the alerts button that opens the changes dialog; only when there is something to show. */
  function changesButton() {
    const { lines, earlier } = changesSeen();
    if (!lines.length && !earlier.length) return '';
    const label = lines.length ? `${lines.length} change${lines.length === 1 ? '' : 's'}` : 'Change history';
    return `<button type="button" class="btn small changes-btn${lines.length ? ' new' : ''}" id="changes-open">${label}</button>`;
  }

  /** The changes dialog: changes since the last visit, then the earlier history with its clearing options. */
  function openChanges({ replace = false } = {}) {
    const { base, lines, earlier } = changesSeen();
    let html = '';
    if (lines.length) html += `<div class="changes"><strong>${lines.length} change${lines.length === 1 ? '' : 's'} since ${esc(fmtDateTime(base.at))}</strong><ul>${lines.map((l) => changeRow(l.line, null, l.id)).join('')}</ul></div>`;
    else if (base && base.items && !base.first) html += `<p class="hint">No changes since ${esc(fmtDateTime(base.at))}.</p>`;
    if (earlier.length) {
      const rows = earlier.slice().reverse().map((e) => changeRow(e.line, e.at, e.id)).join('');
      const controls = `<p class="changelog-controls"><label><input type="checkbox" id="changelog-auto"${state.changeLogAuto ? ' checked' : ''}> Automatically clear changes a week after the outage ends</label> <button type="button" class="btn small" id="changelog-clear">Clear history</button></p>`;
      html += `<div class="changes log"><strong>Earlier changes</strong><ul>${rows}</ul>${controls}</div>`;
    }
    openSheet('Changes', `<div class="sheet-pad">${html || '<p class="hint">No changes seen yet.</p>'}</div>`, { replace });
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
        id: o.id, kind: o.kind, regionId: o.regionId, gisId: o.gisId || null, dateOff: o.dateOff, dateOn: o.dateOn, municipality: o.municipality, cause: o.cause,
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
      const when = e.kind === 'current' ? `${/\bplanned work\b/i.test(e.cause || '') ? 'Planned work' : 'Unplanned'}, started ${esc(fmtDateTime(e.dateOff))}` : esc(fmtWindow(e.dateOff, e.dateOn));
      return `<li><span class="hist-when">${when}</span> <span class="badge muted">${st}</span>${resched}<br><span class="muted">${esc(e.segment)} · ${esc(e.cause || '')} · first seen ${esc(fmtDay(e.firstSeen))} · ${idLink(e)}</span></li>`;
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
      writeJSON(localStorage, CHANGES_KEY, null);
      state.baseline = undefined; state.diff = null; state.history = []; state.changeLog = []; state.alertsMsg = '';
    }
    render();
    if (A && changed) A.sync(state.home, state.munis).then((c) => { if (c) render(); }); // moves an existing alert subscription to the new street
    if (A && changed) maybeOfferAlerts(alertsIntro());
  }


  function forgetHome() {
    if (A) A.disable();
    state.home = null; state.baseline = undefined; state.diff = null; state.history = []; state.changeLog = []; state.showSearch = false; state.alertsMsg = '';
    writeJSON(localStorage, HOME_KEY, null); writeJSON(localStorage, SNAP_KEY, null); writeJSON(sessionStorage, BASE_KEY, null); writeJSON(localStorage, HIST_KEY, null); writeJSON(localStorage, CHANGES_KEY, null);
    state.query = ''; els.q.value = ''; state.muni = DEFAULT_MUNI; els.muni.value = state.muni;
    writeState();
    render();
    els.q.focus();
  }


  function summaryFor(matches, muni, whose) {
    const out = matches.strong.filter((i) => i.o.kind === 'current' && !i.o.plannedWork);
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
    const mentions = matches.weak.filter((i) => i.match.mention).length;
    const similar = matches.weak.length - mentions;
    if (similar) summary += ` ${similar} similar street name${similar === 1 ? '' : 's'} shown below.`;
    if (mentions) summary += ` ${mentions} outage notice${mentions === 1 ? ' mentions' : 's mention'} ${whose} street but could not be read for certain; check below.`;
    if (!out.length && matches.nearby.length && (whose !== 'your' || state.showMore)) summary += ` ${nearbyCount(matches.nearby)} elsewhere in ${esc(muni || matches.q.muni)}.`;
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
      const planned = o.kind === 'planned' || o.plannedWork;
      const rows = [];
      if (o.kind === 'current') {
        const idx = CREW_STEPS.indexOf(o.crewStatus);
        const bar = idx >= 0 ? `<span class="crew-bar" title="${esc(o.crewStatusDescr || '')}">${CREW_STEPS.map((s, i) => `<span class="${i <= idx ? 'done' : ''}"></span>`).join('')}</span>` : '';
        rows.push(['Crew', `<b>${esc(o.crewStatusDescr || 'No crew information')}</b>${bar}`]);
      }
      // A planned listing is only BC Hydro's schedule: say when the work is expected to start and end, not that power
      // went off then. The unplanned-feed copy of the same work (kind 'current') reports what actually happened.
      if (o.kind === 'planned') {
        rows.push(['Expected start', scheduledTime(o.dateOff, now, 'start')]);
        rows.push(['Expected end', o.dateOn ? scheduledTime(o.dateOn, now, 'end') : '<b>Not given</b>']);
        if (o.cause) rows.push(['Cause', esc(o.cause)]);
        rows.push(['Listed', `${o.numCustomersOut != null ? esc(fmtNum(o.numCustomersOut)) + ' customers · ' : ''}${esc(match.segment.label)}`]);
        return `<div class="live planned"><div class="live-top"><div class="live-head">Planned outage scheduled now on your street</div>${detailsBtn(o.id)}</div><dl class="live-rows">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></div>`;
      }
      let back;
      if (o.dateOn) back = backEstimate(o.dateOn, now);
      else back = `<b>No estimate yet</b>${o.crewEta && o.showEta !== false && o.kind === 'current' ? ` <span class="muted">· crew expected ${esc(fmtDateTime(o.crewEta))} (${esc(fmtRelative(o.crewEta - now))})</span>` : ''}`;
      rows.push(['Expected back', back]);
      rows.push(['Out since', `${esc(fmtDateTime(o.dateOff))} <span class="muted">(${esc(fmtAgo(now - o.dateOff))})</span>`]);
      if (o.cause) rows.push(['Cause', esc(o.cause)]);
      rows.push(['Affected', `${o.numCustomersOut != null ? esc(fmtNum(o.numCustomersOut)) + ' customers · ' : ''}${esc(match.segment.label)}`]);
      if (o.crewStatusNote) rows.push(['Note', esc(o.crewStatusNote)]);
      const head = planned ? 'Planned work in progress on your street' : 'Power is out on your street';
      return `<div class="live${planned ? ' planned' : ''}"><div class="live-top"><div class="live-head">${head}</div>${detailsBtn(o.id)}</div><dl class="live-rows">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></div>`;
    }).join('');
  }

  /*
   * BC Hydro's restoration time is an estimate, and it often stays in the feed after it passes while the crew works
   * on. "Power back 4pm" with 4pm gone reads as if power came back, so it is always worded as an estimate.
   */
  function backEstimate(on, now) {
    return on > now
      ? `<b>${esc(fmtDateTime(on))}</b> <span class="muted">(${esc(fmtRelative(on - now))}, BC Hydro's estimate)</span>`
      : `<b>${esc(fmtDateTime(on))}</b> <span class="muted">(estimate passed, not yet updated by BC Hydro)</span>`;
  }
  /** A planned outage's scheduled start or end: "Sat, Nov 21 9:30am (scheduled, 3 min ago)". */
  function scheduledTime(ms, now, which) {
    const rel = ms > now ? fmtRelative(ms - now) : fmtAgo(now - ms);
    return `<b>${esc(fmtDateTime(ms))}</b> <span class="muted">(scheduled ${which}, ${esc(rel)})</span>`;
  }
  function backEstimateText(on, now) {
    return on > now ? `expected back ${fmtDateTime(on)}` : `expected back ${fmtDateTime(on)}, estimate passed, not yet updated`;
  }

  function detailsBtn(id) { return `<button type="button" class="btn small details-btn" data-details="${esc(String(id))}">Details</button>`; }

  /** "2 unplanned outages", "1 planned outage in progress", or both joined with "and". */
  function nearbyCount(items) {
    const work = items.filter((i) => i.o.plannedWork).length, other = items.length - work;
    return [other && `${other} unplanned outage${other === 1 ? '' : 's'}`, work && `${work} planned outage${work === 1 ? '' : 's'} in progress`].filter(Boolean).join(' and ');
  }

  /**
   * Every outage happening now in the saved address's municipality (unplanned, or planned work under way), in a
   * collapsed section at the bottom of the address panel: a compact line each, with a Details button. Ones on the
   * saved street are also in the live box above, and are marked here.
   */
  function muniNowSection(matches, muni, now) {
    const mine = matches.strong.filter((i) => i.o.kind === 'current');
    const near = mine.concat(matches.nearby.filter((i) => i.o.kind === 'current'));
    if (!near.length) return '';
    const rows = near.map(({ o }) => {
      const where = o.parsed.segments.length ? o.parsed.segments.map((s) => s.label).join(', ') : o.parsed.text;
      const bits = [o.plannedWork ? 'Planned work' : 'Unplanned', o.crewStatusDescr || 'No crew information', `out ${fmtDuration(now - o.dateOff)}`];
      if (o.numCustomersOut != null) bits.push(`${fmtNum(o.numCustomersOut)} customer${o.numCustomersOut === 1 ? '' : 's'}`);
      if (o.dateOn) bits.push(backEstimateText(o.dateOn, now));
      const chip = mine.some((i) => i.o === o) ? '<span class="badge danger">Your street</span> ' : '';
      return `<li><div><span class="where">${chip}${esc(where)}</span><span class="sub">${esc(bits.join(' · '))}</span></div>${detailsBtn(o.id)}</li>`;
    });
    const where = muni || matches.q.muni;
    // Collapsed under a heading with the count; opening it is kept across re-renders (setHTML leaves it alone).
    return `<details class="others-section muni-now"><summary class="others-head">Outages now${where ? ' in ' + esc(where) : ' near you'} (${near.length})</summary><ul>${rows.join('')}</ul></details>`;
  }

  /** The matched outages' times, one line each; outages happening now are in the live box instead. */
  /**
   * The saved address's planned outages in the panel: each in the card format (chips, time, place, BC Hydro note)
   * without the street section, since the panel is about the saved street. Outages happening now are in the live box.
   */
  function upcomingList(matches, now) {
    const items = matches.strong.filter((i) => !isLive(i.o, now) && i.o.kind === 'planned');
    if (!items.length) return '';
    return `<div class="upcoming">${items.map((i) => card(i, matches.q, now, null, { summary: true })).join('')}</div>`;
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
    const summary = summaryFor(matches, state.home.muni, 'your');

    const headline = panelTitle(matches, now);
    // Each outage in the summary has its own "Details" button; this one is for hiding them again, or
    // for showing them when nothing is in the summary (an outage happening now is in the live box instead).
    const inSummary = matches.strong.some((i) => !isLive(i.o, now) && i.o.kind === 'planned');
    const more = state.showMore || !inSummary ? `<p class="home-more"><button type="button" class="btn small" id="home-more">${state.showMore ? 'Hide outage details' : 'Show outage details'}</button></p>` : '';
    // Alerts (or Install), with what changed in a dialog behind a button underneath.
    const button = titleButton() + changesButton();
    const install = button ? `<span class="install">${button}</span>` : '';
    setHTML(els.home, `<div class="home-card">
  <div class="title-row"><div><h2 class="home-title ${headline.cls}">${headline.text}</h2><p class="home-subtitle">${addr}</p></div>${install}</div>
  <p class="home-actions"><a href="#" id="home-search">Search another address</a> <a href="#" id="home-forget">Clear my address and history</a></p>
  ${liveStatus(matches, now)}
  <p class="home-summary">${summary}</p>
  ${upcomingList(matches, now)}
  ${alertsControl()}
  ${more}
  ${muniNowSection(matches, state.home.muni, now)}
</div>
${homeOthers(now)}`);
  }

  /** The municipality's other planned outages, under the address panel; on show from page load, details open or not. */
  function homeOthers(now) {
    const r = search();
    return r.others && r.others.length ? othersBlock(r, r.q, now) : '';
  }

  /** What the panel heading says: the state of the saved street in two words. */
  function panelTitle(matches, now) {
    const strong = matches.strong;
    if (strong.some((i) => i.o.kind === 'current' && !i.o.plannedWork)) return { text: 'Power out', cls: 'is-out' };
    if (strong.some((i) => i.o.plannedWork)) return { text: 'Planned outage now', cls: 'is-planned' };
    if (strong.some((i) => statusOf(i.o, now) === 'in progress')) return { text: 'Planned outage scheduled now', cls: 'is-planned' };
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
    renderFreshness();
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
    if (!atHome) parts.push(muniPicker(r));
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
    if (r.others && r.others.length && !atHome) parts.push(othersBlock(r, r.q, now)); // at home it sits under the address panel
    if (atHome) parts.push(renderHistory(now));
    setHTML(els.results, parts.join(''));
    if (atHome) setHTML(els.status, '');
    else summary(r);
  }

  /**
   * With no municipality given, a street search can match the same street name in several places. Then a row of
   * buttons, one per municipality with its count of matches, narrows the search to one (the overview's chips).
   */
  function muniPicker(r) {
    if (state.muni || r.q.muni || !r.q.key || (r.mode !== 'address' && r.mode !== 'text')) return '';
    const counts = muniCounts(r);
    if (counts.size < 2) return '';
    const chips = [...counts.entries()].map(([m, n]) => `<button type="button" class="chip" data-muni="${esc(m)}">${esc(m)}<span class="n">${n}</span></button>`).join('');
    return `<div class="muni-picker"><p class="group-head">${esc(r.q.street || state.query)} is in ${counts.size} municipalities. Pick yours:</p><div class="chips">${chips}</div></div>`;
  }

  /** The municipalities a search's results are in, with how many each, by name. */
  function muniCounts(r) {
    const counts = new Map();
    for (const { o } of r.items.concat(r.current || [])) {
      const names = o.municipalities && o.municipalities.length ? o.municipalities : String(o.municipality || '').split(/,\s*/);
      for (const m of new Set(names.filter(Boolean))) counts.set(m, (counts.get(m) || 0) + 1);
    }
    return new Map([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  }

  /**
   * Save Address with no municipality: ask for it first, since the same street name is used in many places.
   * Offers the municipalities where the street has outages listed, any municipality by name, or saving as is.
   */
  function askMuniDialog() {
    const r = search();
    const counts = r.q.key && (r.mode === 'address' || r.mode === 'text') ? muniCounts(r) : new Map();
    const chips = [...counts.keys()].map((m) => `<button type="button" class="chip" data-save-muni="${esc(m)}">${esc(m)}</button>`).join('');
    openDialog(`<h3>Which municipality?</h3>
<p>The same street name is used in many places, so the municipality makes sure only outages for <strong>${esc(state.query)}</strong> are shown.</p>
${chips ? `<p class="muted">${esc(r.q.street || state.query)} has outages listed in:</p><div class="chips">${chips}</div>` : ''}
<p><label for="dialog-muni">${chips ? 'Somewhere else' : 'Municipality'}</label><br><input id="dialog-muni" type="text" list="muni-list" placeholder="e.g. Bowen Island" autocomplete="address-level2" spellcheck="false"></p>
<div class="actions"><button type="button" class="btn link small" id="dialog-save-anyway">Save without</button> <button type="button" class="btn link small" id="dialog-close">Cancel</button> <button type="button" class="btn small primary" id="dialog-muni-save">Save</button></div>`);
  }

  /** Save the address with a municipality chosen in the dialog. */
  function saveWithMuni(muni) {
    closeDialog();
    state.muni = muni; els.muni.value = muni; writeState();
    saveHome(state.query, muni);
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
    const label = on ? 'Alerts on' : st === 'blocked' ? 'Alerts blocked' : 'Alerts off';
    // What the alerts cover goes in a chip under the button, keeping the button small.
    const scope = !on ? '' : tp.includes('muni') ? (tp.includes('street') ? 'street + town' : 'town') : tp.includes('street') ? 'street' : '';
    const chip = scope ? `<span class="alerts-scope">${scope}</span>` : '';
    return `<button type="button" class="btn small bell${on ? ' on' : ''}" id="alerts-toggle" aria-pressed="${on}" title="${on ? 'Change or turn off alerts' : 'Turn alerts on'}">${on ? BELL_ON : BELL_OFF}<span>${label}</span></button>${chip}`;
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
    // The ON/OFF badge follows the tick box, so the dialog always reads as what Save will do.
    const row = (key, label, detail, checked, disabled) => `<label class="opt${disabled ? ' off' : ''}"><input type="checkbox" name="topic" value="${key}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span><b>${label}</b> <span class="muted">${detail}</span><span class="state${checked ? ' on' : ''}">${checked ? 'on' : 'off'}</span></span></label>`;
    const options = `<div class="opts">
${row('street', esc(street), 'outages that list your street, and a reminder 24 hours and 1 hour before a planned one starts', on.includes('street'), blocked)}
${row('muni', muni ? 'All of ' + esc(muni) : 'Your municipality', muni ? 'every outage in ' + esc(muni) + ', planned or unplanned' : 'add a municipality to your address to use this', on.includes('muni'), blocked || !muni)}
</div>`;
    const note = blocked ? `<p class="alerts-msg">Notifications are blocked for this site in your browser settings. Allow them there, then come back.</p>` : '';
    const actions = blocked
      ? `<div class="actions"><button type="button" class="btn small primary" id="dialog-close">OK</button></div>`
      : `<div class="actions"><button type="button" class="btn link small" id="dialog-close">Cancel</button> <button type="button" class="btn small primary" id="home-alerts-go">${first ? 'Turn on alerts' : 'Save'}</button></div>`;
    openDialog(`<h3>Outage alerts</h3>${intro ? `<p>${intro}</p>` : ''}${options}${note}<details class="limits"${first ? ' open' : ''}><summary>What to expect</summary>${list(alertFacts(d))}</details>${actions}`);
  }

  const ASKED_KEY = 'outage-finder.alerts-offered';
  /** The one-time offer's opening line: what alerts do for the saved street. */
  function alertsIntro() {
    const q = P.parseQuery(state.home.address, state.munis);
    return `Alerts are off. Turn them on to get a notification when an outage on ${esc(q.street || state.home.address)} changes, and a reminder 24 hours and 1 hour before a planned one starts.`;
  }
  /**
   * Offer alerts once, without nagging: right after an install is accepted, and on the first open of the
   * installed app (that is the only way an iPhone can get them). The button in the dialog supplies the
   * user gesture the permission prompt needs. Also offered the first time an address is saved or opened;
   * whichever comes first is the only time it is ever shown on this device.
   */
  function maybeOfferAlerts(intro) {
    if (!A || !A.supported() || !state.home || A.status() !== 'off') return false;
    let asked = false;
    try { asked = !!localStorage.getItem(ASKED_KEY); } catch (e) { /* ignore */ }
    if (asked) return false;
    try { localStorage.setItem(ASKED_KEY, '1'); } catch (e) { /* ignore */ }
    if (A.needsInstall()) {
      // iPhone and iPad in Safari: alerts only work from the home screen app, so explain instead of offering them.
      openDialog(`<h3>Outage alerts</h3><p>${intro}</p><p>On iPhone and iPad, alerts only work from the home screen app: press Install, then turn alerts on from the app.</p><div class="actions"><button type="button" class="btn small primary" id="dialog-close">OK</button></div>`);
    } else alertsDialog(intro);
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
    const active = state.outages.filter((o) => state.past || !M.longFinished(o, now));
    const byRegion = new Map();
    for (const o of active.concat(state.current)) {
      if (!byRegion.has(o.regionName)) byRegion.set(o.regionName, new Map());
      const m = byRegion.get(o.regionName);
      m.set(o.municipality, (m.get(o.municipality) || 0) + 1);
    }
    const soon = active.filter((o) => statusOf(o, now) !== 'cancelled' && o.dateOff - now < 48 * 3600e3).length;
    const unplanned = state.current.filter((o) => !o.plannedWork);
    const cur = unplanned.length;
    const curCustomers = unplanned.reduce((a, o) => a + (o.numCustomersOut || 0), 0);
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

  /**
   * A planned outage. `summary` is the address panel's version: no match chips, original text or footer, and no
   * streets unless `streets` is set.
   */
  function card(item, q, now, changeTag, { summary = false, chip = '', streets = false } = {}) {
    if (item.o.kind === 'current') return currentCard(item, q, now, changeTag);
    const o = item.o;
    const st = statusOf(o, now);
    const m = item.match;
    const badges = [];
    if (changeTag) badges.push(`<span class="badge new">${esc(changeTag)}</span>`);
    if (m && !summary) {
      if (m.numberListed === true) { if (m.streetScore < 2) badges.push('<span class="badge hit">Address listed (similar street name)</span>'); }
      else if (m.numberListed === false) badges.push(`<span class="badge warn">Street listed, but ${q.number} is not in the listed numbers</span>`);
      else if (m.mention) badges.push('<span class="badge warn">Possible: street named in the notice</span>');
      else badges.push(`<span class="badge ${m.streetScore >= 2 ? 'hit' : ''}">${m.streetScore >= 2 ? 'Street listed' : 'Similar street name'}</span>`);
      if (!item.muniMatch) badges.push(`<span class="badge muted">${esc(o.municipality)}, not ${esc(state.muni || q.muni)}</span>`);
    }
    // The summary leaves out the match chips, but not this one: the street is listed, the house number is not.
    if (m && summary && m.numberListed === false && q && q.number) badges.push(`<span class="badge warn" title="${esc(q.number)} is not in the listed numbers">Near you: ${esc(m.segment.label.replace(/\s+/g, ' '))}</span>`);
    if (chip) badges.push(`<span class="badge muted">${esc(chip)}</span>`);
    badges.push(statusBadge(o, st, now));
    const notes = cardNotes(o);
    if (o.parsed.flags.rescheduled && !o.parsed.flags.cancelled) badges.push(`<span class="badge warn">Rescheduled${notes.from ? ' from ' + esc(notes.from) : ''}</span>`);
    if (o.parsed.flags.continued) badges.push('<span class="badge muted">Continuation of another listing</span>');

    // What BC Hydro wrote about the work (cause and notes), in one labelled box just above the full street list.
    // In a summary the Details button sits at the right of the time and place lines, taking no extra height.
    const details = summary ? `<button type="button" class="btn small details-btn" data-details="${o.id}">Details</button>` : '';
    const bcNote = `<p class="bc-note-head">BC Hydro note</p><div class="bc-note"><p class="bc-cause">${esc(o.cause || 'Planned work')}</p>${notes.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}</div>`;
    // A summary leaves out the streets unless asked (the other outages in town show theirs, below the note; the
    // address's own do not). The full card has the matching streets, then the note, then all the streets.
    const segs = summary ? bcNote + (streets ? addressList(o, null, q) : '') : addressList(o, m, q, bcNote);

    const customers = o.numCustomersOut < 5 ? 'fewer than 5' : fmtNum(o.numCustomersOut);
    const hitClass = m && m.numberListed === true && item.muniMatch && !summary ? ' hit' : '';
    const top = `
<article class="card${hitClass}${st === 'cancelled' ? ' cancelled' : ''}${summary ? ' summary' : ''}"${summary ? '' : ` id="o-${o.id}"`}>
  <div class="card-top">${badges.join('')}</div>
  ${summary ? '<div class="summary-head"><div>' : ''}<h3 class="when">${fmtWindow(o.dateOff, o.dateOn)} <span class="dur">(${fmtDuration(o.dateOn - o.dateOff)})</span></h3>
  <p class="meta"><b>${esc(o.municipality)}</b> · ${customers} customer${o.numCustomersOut === 1 ? '' : 's'}</p>${summary ? `</div>${details}</div>` : ''}
  ${segs}`;
    if (summary) return top + `\n</article>`;
    return top + `
  <details class="raw"><summary>Original area text from BC Hydro</summary><pre>${esc(o.parsed.text)}</pre></details>
  <p class="card-foot"><span>Outage ${idLink(o)}</span><span>Listing updated ${fmtDateTime(o.lastUpdated)}</span></p>
</article>`;
  }

  function currentCard(item, q, now, changeTag) {
    const o = item.o;
    const m = item.match;
    const badges = [];
    if (changeTag) badges.push(`<span class="badge new">${esc(changeTag)}</span>`);
    badges.push(o.plannedWork ? '<span class="badge warn">Planned work in progress</span>' : '<span class="badge danger">Unplanned outage</span>');
    if (m && m.streetScore >= 2 && !m.segment.boundary) badges.push(`<span class="badge hit">${m.numberListed === true ? 'Your address is in the affected block' : 'Your street is affected'}</span>`);
    else if (m && m.segment.boundary) badges.push('<span class="badge muted">Your street bounds the affected area</span>');
    if (o.crewStatusDescr) badges.push(`<span class="badge">${esc(o.crewStatusDescr)}</span>`);
    const segs = addressList(o, m, q);
    const customers = o.numCustomersOut < 5 ? 'fewer than 5' : fmtNum(o.numCustomersOut);
    const restore = o.dateOn ? `Estimated restoration <b>${esc(fmtDateTime(o.dateOn))}</b>` : 'No restoration estimate yet';
    const eta = !o.dateOn && o.crewEta && o.showEta ? ` · Crew expected ${esc(fmtDateTime(o.crewEta))}` : '';
    const dur = fmtDuration(now - o.dateOff);
    return `
<article class="card current${o.plannedWork ? ' planned-work' : ''}${m && m.streetScore >= 2 && !m.segment.boundary ? ' hit' : ''}" id="o-${o.id}">
  <div class="card-top">${badges.join('')}</div>
  <h3 class="when">Out since ${esc(fmtDateTime(o.dateOff))} <span class="dur">(${dur} so far)</span></h3>
  <p class="meta"><b>${esc(o.municipality)}</b> · ${customers} customer${o.numCustomersOut === 1 ? '' : 's'} · ${esc(o.cause || 'Cause not yet known')}</p>
  <p class="meta">${restore}${eta}${o.crewStatusNote ? ' · ' + esc(o.crewStatusNote) : ''}</p>
  ${segs}
  <p class="card-foot"><span>Outage ${idLink(o)}</span><span>Updated ${fmtDateTime(o.lastUpdated)}</span>${o.gisId ? `<a href="${MAP}${o.id}" rel="noopener" target="_blank">View on map</a>` : ''}</p>
</article>`;
  }

  /**
   * The outage's street list. When the card is the result of an address match, only the segments on that
   * street are shown and the rest sit behind a toggle; otherwise every segment is listed.
   */
  const NAME_COL_MAX = 30; // a longer street name wraps rather than forcing a single column
  const NUM_COL_MAX = 13; // longest house-number text kept in the number column ("12345-12399" fits)

  /** "101-113 Baker Rd" -> { nums: "101-113", name: "Baker Rd" }; labels without leading numbers have nums "". */
  function splitLabel(s) {
    if (s.street && s.label.endsWith(s.street) && s.label.length > s.street.length) {
      return { nums: s.label.slice(0, s.label.length - s.street.length).trim(), name: s.street };
    }
    return { nums: '', name: s.label };
  }

  /**
   * A planned outage's notes, sorted out so nothing repeats: the date it was rescheduled from goes in the
   * Rescheduled chip (shortened to "Nov 7"); bare "CANCELLED" markers are dropped, the Cancelled chip says it.
   * Everything else BC Hydro wrote ("Overnight outage", "Parts of Bowen Island") is kept as a note.
   */
  function cardNotes(o) {
    let from = '';
    const rest = [];
    for (const note of o.parsed.notes) {
      for (const raw of note.split(/\s*\|\s*/)) {
        const t = raw.replace(/\*+/g, '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
        if (!t) continue;
        const r = t.match(/^(?:outage\s+)?resched\w*\b.*?\bfrom\s+(.+)$/i);
        if (r && !from) {
          const d = r[1].match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/i);
          from = d ? `${d[1][0].toUpperCase()}${d[1].slice(1).toLowerCase()} ${Number(d[2])}` : r[1];
          continue;
        }
        if (/^(cancel(l?ed)?|resched\w*)$/i.test(t)) continue; // the chips already say so
        const c = t.match(/^cancel(?:l?ed)?\s*[-–:]?\s*(.+)$/i); // "CANCELLED - to be rescheduled"
        const text = c ? c[1][0].toUpperCase() + c[1].slice(1) : t;
        rest.push(text);
      }
    }
    return { from, notes: rest };
  }

  /** The streets of an outage; `after` (planned outages' BC Hydro note) goes below the matching streets. */
  function addressList(o, m, q, after = '') {
    let excluded = false;
    const item = (s, isMatch, numW) => {
      const loc = s.locality && s.locality !== o.municipality ? ` <span class="loc">(${esc(s.locality)})</span>` : '';
      const qual = s.qualifier ? ` <span class="qual">(${esc(s.qualifier)})</span>` : '';
      const cls = isMatch ? (excluded ? 'match excluded' : 'match') : '';
      if (!numW) return `<li class="${cls}">${esc(s.label)}${qual}${loc}</li>`;
      // House numbers right-aligned in their own column so the street names line up; a long list goes under the name.
      const { nums, name } = splitLabel(s);
      const short = nums.length <= NUM_COL_MAX;
      return `<li class="${cls}"><span class="num">${short ? esc(nums) : ''}</span><span class="name">${esc(name)}${qual}${loc}${short || !nums ? '' : `<span class="nums">${esc(nums)}</span>`}</span></li>`;
    };
    /** A list of streets; with any short house numbers present, laid out with a number column as wide as the widest. */
    const list = (segs, isMatch) => {
      const numW = Math.max(0, ...segs.map((s) => splitLabel(s).nums.length).filter((n) => n <= NUM_COL_MAX));
      // Columns sized to the entries, so the browser fits as many as it can with few names wrapping. In a longer
      // list the longest fifth may wrap rather than force fewer columns. Lengths are in ch, the width of "0".
      const extra = (s) => (s.qualifier ? s.qualifier.length + 3 : 0) + (s.locality && s.locality !== o.municipality ? s.locality.length + 3 : 0);
      const lens = segs.map((s) => (numW ? splitLabel(s).name : s.label).length + extra(s)).sort((a, b) => a - b);
      const nameW = Math.min(NAME_COL_MAX, Math.max(4, lens.length > 6 ? lens[Math.floor(lens.length * 0.8)] : lens[lens.length - 1]));
      // Letters average about 0.85 of a "0", so names need less than their length in ch.
      const vars = `--namew:${Math.round(nameW * 8.5) / 10}ch${numW ? `;--numw:${numW}ch` : ''}`;
      return `<ul class="addresses${numW ? ' aligned' : ''}" style="${vars}">${segs.map((s) => item(s, isMatch(s), numW)).join('')}</ul>`;
    };
    const box = (inner) => `<div class="addr-box">${inner}</div>`;
    // Alphabetical by street name, then by house number, so a street is easy to find down the columns.
    const byStreet = (a, b) => (a.street || a.label).localeCompare(b.street || b.label, 'en', { sensitivity: 'base' }) || a.label.localeCompare(b.label, 'en', { numeric: true });
    // A mention found only in the notice text is not one of the parsed streets; show it first.
    const sorted = o.parsed.segments.slice().sort(byStreet);
    const all = m && m.mention ? [m.segment].concat(sorted) : sorted;
    if (!all.length) return after;
    if (!m) return box(list(all, () => false)) + after;
    const onStreet = all.filter((s) => s === m.segment || (q && q.key && P.streetScore(q, s) >= 2));
    // The street is listed with house numbers, and the address's number is not among them: not shown as a hit.
    excluded = m.numberListed === false;
    // Above the matching streets, say how they matched.
    const how = excluded ? `Your street is listed, but not ${esc(q && q.number ? q.number : 'your house number')}` : m.numberListed === true ? 'Your address is listed' : m.mention ? 'Your street is named in the notice' : m.streetScore >= 2 ? 'Your street is listed' : 'Similar street name';
    let html = `<p class="addr-label${excluded ? ' excluded' : m.streetScore >= 2 && !m.mention ? '' : ' weak'}">${how}</p>${box(list(onStreet, (s) => s === m.segment))}`;
    html += after;
    // The full list keeps the matching streets in their alphabetical place, in bold.
    if (all.length > onStreet.length) {
      html += `<details class="more-streets"><summary>Streets in this outage (${all.length})</summary>${box(list(all, (s) => onStreet.includes(s)))}</details>`;
    }
    return html;
  }

  /**
   * An outage's number. A current outage with a map shape (gisId) links to it on BC Hydro's outage map, as BC
   * Hydro's own list does; BC Hydro has no working link for any other single outage, so those are plain text.
   */
  function idLink(o) {
    const id = `#${esc(String(o.id))}`;
    if (o.kind !== 'current' || !o.gisId) return id;
    return `<a class="outage-id" href="${esc(MAP + o.id)}" rel="noopener" target="_blank" title="This outage on BC Hydro's outage map">${id}</a>`;
  }

  function statusBadge(o, st, now) {
    if (st === 'cancelled') return '<span class="badge danger">Cancelled</span>';
    if (st === 'in progress') return '<span class="badge danger" title="BC Hydro\'s schedule puts this outage now; the work may start late or not at all">Scheduled now</span>';
    if (st === 'finished' && M.endedToday(o, now)) return `<span class="badge hit" title="Its scheduled end has passed; it stays listed until the end of the day">Ended ${fmtAgo(now - o.dateOn)}</span>`;
    if (st === 'finished') return '<span class="badge muted">Finished</span>';
    return `<span class="badge">Starts ${fmtRelative(o.dateOff - now)}</span>`;
  }

  // ------------------------------------------------------------ formatting

  // BC time, corrected on devices whose time zone data predates BC's 2026 change (see bcFormat in matcher.js).
  const dFmt = M.bcFormat({ weekday: 'short', month: 'short', day: 'numeric' });
  const dyFmt = M.bcFormat({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const tFmt = M.bcFormat({ hour: 'numeric', minute: '2-digit', hour12: true });
  const dayKey = M.bcFormat({ year: 'numeric', month: '2-digit', day: '2-digit' });

  /** Short time: "7am", "9:30pm". */
  function fmtTime(ms, fmt = tFmt) {
    const p = fmt.formatToParts(new Date(ms));
    const v = (t) => (p.find((x) => x.type === t) || {}).value || '';
    const min = v('minute');
    return `${v('hour')}${min && min !== '00' ? ':' + min : ''}${v('dayPeriod').replace(/[.\s]/g, '').toLowerCase()}`;
  }
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

  /*
   * The URL carries the address on screen (?q=…&muni=…), so a link opens on the same search. A link to an address
   * other than the saved one opens it as a search, with the saved address one click away.
   */
  function readState() {
    const u = new URLSearchParams(location.search);
    const past = u.get('past') === '1';
    let q = '', muni = '';
    const linked = u.get('q') != null || u.get('muni') != null;
    if (linked) { q = (u.get('q') || '').trim(); muni = (u.get('muni') || DEFAULT_MUNI).trim(); }
    if (state.home && (!linked || (normText(q) === normText(state.home.address) && normText(muni) === normText(state.home.muni)))) {
      q = state.home.address; muni = state.home.muni || ''; state.showSearch = false;
    } else if (state.home) state.showSearch = true;
    else if (!linked) muni = DEFAULT_MUNI;
    state.query = q; state.muni = muni; state.past = past;
    els.q.value = state.query; els.muni.value = state.muni; els.past.checked = state.past;
  }
  function writeState() {
    const u = new URLSearchParams();
    if (state.query) u.set('q', state.query);
    if (state.query && state.muni) u.set('muni', state.muni);
    if (state.past) u.set('past', '1');
    const qs = u.toString();
    const next = qs ? '?' + qs : '';
    if (location.search === next) return;
    try { history.replaceState(history.state, '', (next || location.pathname) + location.hash); lastSearch = location.search; } catch (e) { /* ignore */ }
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
    e.preventDefault(); clearTimeout(timer); clearTimeout(muniTimer);
    // Both boxes as they are now: typing (or autofill) only reaches the state after a short delay.
    state.query = els.q.value.trim(); state.muni = els.muni.value.trim(); absorbMuni(); writeState();
    if (state.query && queryIsAddress() && !(state.muni || '').trim()) { render(); askMuniDialog(); return; }
    if (state.query && queryIsAddress()) saveHome(state.query, state.muni);
    else {
      // Nothing to save: say what is missing and put the cursor where it goes, rather than doing nothing.
      render();
      setHTML(els.status, state.query
        ? `<strong>“${esc(state.query)}” is not a street address.</strong> Type your street, e.g. 123 Main St, then press Save Address.`
        : '<strong>Type your street address</strong>, e.g. 123 Main St, then press Save Address.');
      els.q.focus();
      return;
    }
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
  /** Clicks on outage cards' Details buttons, in both the results and the address panel. */
  function cardClick(e) {
    const details = e.target.closest('[data-details]');
    if (details) { showDetails(details.dataset.details); return true; }
    return false;
  }
  els.results.addEventListener('click', (e) => {
    if (cardClick(e)) return;
    const chip = e.target.closest('[data-muni]');
    if (chip) { state.muni = chip.dataset.muni; els.muni.value = state.muni; writeState(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  });
  /**
   * One outage in a dialog (full screen on phones): the whole card, streets and all. An outage listing the saved
   * address keeps its match (your street in green); any other, such as one of the municipality's others, has none.
   */
  function showDetails(id) {
    const now = Date.now();
    const matches = state.home ? homeMatches(now) : null;
    let item = matches && matches.strong.find((i) => String(i.o.id) === String(id));
    if (!item) {
      const o = state.outages.concat(state.current).find((x) => String(x.id) === String(id));
      if (!o) return;
      item = { o, match: null, muniMatch: true };
    }
    const q = matches ? matches.q : P.parseQuery(state.query, state.munis);
    const tag = state.diff ? state.diff.byId[item.o.id] : null;
    openSheet('Outage details', `<div class="results">${card(item, q, now, tag)}</div>`);
  }

  /*
   * The dialog (full screen on phones) holds a stack of pages, e.g. Changes, then one outage's details from it.
   * Each page has a history entry, so back (button, key or gesture) returns to the previous page and finally
   * closes the dialog; Close and Escape go back past all of them at once.
   */
  const sheetPages = [];
  let sheetClosingAll = false;
  function drawSheet() {
    const { title, body } = sheetPages[sheetPages.length - 1];
    els.sheet.setAttribute('aria-label', title);
    const back = sheetPages.length > 1 ? `<button type="button" class="btn small" id="sheet-back">Back</button>` : '';
    els.sheet.innerHTML = `<div class="sheet-bar"><span class="sheet-left">${back}</span><strong>${esc(title)}</strong><span class="sheet-right"><button type="button" class="btn small" id="sheet-close">Close</button></span></div>
<div class="sheet-body wrap">${body}</div>`;
    els.sheet.scrollTop = 0;
    if (window.OutageColumns) window.OutageColumns.fitAll(els.sheet);
  }
  /** Open the dialog on a page, or add a page to it; `replace` redraws the current page instead (after an edit). */
  function openSheet(title, body, { replace = false } = {}) {
    if (replace && sheetPages.length) { sheetPages[sheetPages.length - 1] = { title, body }; drawSheet(); return; }
    sheetPages.push({ title, body });
    try { history.pushState({ outageSheet: sheetPages.length }, ''); } catch (e) { /* ignore */ }
    if (!els.sheet.hasAttribute('open')) {
      if (typeof els.sheet.showModal === 'function') els.sheet.showModal(); else els.sheet.setAttribute('open', '');
    }
    drawSheet();
  }
  /** Close the whole dialog: step history back past its pages; popstate then closes it. */
  function closeSheet() {
    if (!sheetPages.length) return;
    sheetClosingAll = true;
    history.go(-sheetPages.length);
  }
  function dismissSheet() {
    sheetPages.length = 0;
    sheetClosingAll = false;
    if (typeof els.sheet.close === 'function') { if (els.sheet.open) els.sheet.close(); } else els.sheet.removeAttribute('open');
    els.sheet.innerHTML = '';
  }
  els.sheet.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); }); // Escape
  window.addEventListener('popstate', () => {
    if (!sheetPages.length) return;
    if (sheetClosingAll || sheetPages.length === 1) { dismissSheet(); return; }
    sheetPages.pop();
    drawSheet();
  });
  els.sheet.addEventListener('click', (e) => {
    if (e.target.closest('#sheet-close')) { closeSheet(); return; }
    if (e.target.closest('#sheet-back')) { history.back(); return; }
    const details = e.target.closest('[data-details]');
    if (details) { showDetails(details.dataset.details); return; }
    if (e.target.id === 'changelog-auto') { editChangeLog({ autoClear: e.target.checked }); openChanges({ replace: true }); return; }
    if (e.target.id === 'changelog-clear') { if (window.confirm('Clear the change history for this address?')) { editChangeLog({ clear: true }); openChanges({ replace: true }); } return; }
  });

  els.home.addEventListener('click', (e) => {
    if (cardClick(e)) return;
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
    else if (id === 'changes-open') openChanges();
    else if (id === 'home-more') {
      state.showMore = !state.showMore; render();
      if (state.showMore) els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    else if (id === 'home-show') { e.preventDefault(); state.showSearch = false; state.query = state.home.address; els.q.value = state.query; state.muni = state.home.muni || ''; els.muni.value = state.muni; writeState(); render(); }
  });
  // The details dialog's own history entries keep the URL, so only a real change of address in the URL is read back.
  let lastSearch = location.search;
  window.addEventListener('popstate', () => { if (location.search === lastSearch) return; lastSearch = location.search; readState(); render(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; render(); });
  window.addEventListener('appinstalled', () => { state.installPrompt = null; render(); });
  els.install.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'install-ask') startInstall();
    else if (b.id === 'alerts-toggle') toggleAlerts();
  });
  // Ticking an option flips its ON/OFF badge straight away, so the dialog reads as what Save will do.
  els.dialog.addEventListener('change', (e) => {
    const box = e.target;
    if (!box || box.name !== 'topic') return;
    const badge = box.parentElement.querySelector('.state');
    if (badge) { badge.textContent = box.checked ? 'on' : 'off'; badge.classList.toggle('on', box.checked); }
  });
  // Enter in the dialog's municipality box saves, as the Save button does.
  els.dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'dialog-muni') { e.preventDefault(); els.dialog.querySelector('#dialog-muni-save').click(); }
  });
  els.dialog.addEventListener('click', async (e) => {
    const id = e.target.id;
    const pick = e.target.closest('[data-save-muni]');
    if (pick) { saveWithMuni(pick.dataset.saveMuni); return; }
    if (id === 'dialog-close') closeDialog();
    else if (id === 'dialog-save-anyway') { closeDialog(); saveHome(state.query, ''); }
    else if (id === 'dialog-muni-save') {
      const text = els.dialog.querySelector('#dialog-muni').value.trim();
      const set = resolveMunis(text);
      const name = set && set.size === 1 ? state.munis.find((m) => m.toLowerCase() === [...set][0]) : '';
      if (name) { saveWithMuni(name); return; }
      let note = els.dialog.querySelector('.alerts-msg');
      if (!note) { note = document.createElement('p'); note.className = 'alerts-msg'; els.dialog.querySelector('.actions').before(note); }
      note.textContent = !text ? 'Type a municipality, or pick one above.' : set && set.size > 1 ? `“${text}” matches several municipalities: pick one from the list.` : `BC Hydro lists no municipality called “${text}”.`;
    }
    else if (id === 'home-alerts-go') {
      const wanted = [...els.dialog.querySelectorAll('input[name="topic"]:checked')].map((i) => i.value);
      if (!wanted.length && !A.topics().length) {
        // Nothing chosen and nothing on: say so instead of silently doing nothing.
        let note = els.dialog.querySelector('.alerts-msg');
        if (!note) { note = document.createElement('p'); note.className = 'alerts-msg'; els.dialog.querySelector('.actions').before(note); }
        note.textContent = 'Tick what you want alerts for.';
        return;
      }
      closeDialog();
      state.alertsBusy = true; state.alertsMsg = ''; render();
      const action = wanted.length ? A.enable(state.home, state.munis, wanted) : A.disable().then(() => { state.alertsMsg = 'Alerts off.'; });
      action
        .catch((err) => { state.alertsMsg = err && err.message ? err.message : 'Could not update alerts.'; })
        .then(() => { state.alertsBusy = false; render(); });
    }
  });

  // The time zone data here predates BC's 2026 change: say the times are corrected, and show the difference
  // between BC time as this system works it out and the correct time.
  // Dismissing it is remembered in this browser.
  const TZ_DISMISS_KEY = 'outage-finder.tz-warning-dismissed';
  if (M.tzOutdated && Date.now() >= Date.UTC(2026, 10, 1, 9) && !readJSON(localStorage, TZ_DISMISS_KEY)) {
    const now = Date.now();
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', hour: 'numeric', minute: '2-digit', hour12: true });
    const warn = document.createElement('p');
    warn.className = 'tz-warning';
    warn.setAttribute('role', 'note');
    warn.innerHTML = `<strong>Times on this page have been adjusted to correct BC time.</strong><span class="tz-times">This browser says ${esc(fmtTime(now, local))} but the correct BC time is ${esc(fmtTime(now))}.</span>`
      + '<button type="button" class="tz-dismiss" aria-label="Dismiss">×</button>';
    warn.querySelector('.tz-dismiss').addEventListener('click', () => { writeJSON(localStorage, TZ_DISMISS_KEY, true); warn.remove(); });
    document.querySelector('main').prepend(warn);
  }

  readState();
  load();
})();
