/* BC Hydro planned outage finder — UI. Depends on parse.js (window.OutageParser). */
(function () {
  'use strict';
  const P = window.OutageParser;
  const API = window.OUTAGE_API || '/api/planned';
  const API_CURRENT = window.OUTAGE_API_CURRENT || '/api/current';
  const OFFICIAL = 'https://www.bchydro.com/power-outages/app/outage-list-planned.html';
  const OFFICIAL_CURRENT = 'https://www.bchydro.com/power-outages/app/outage-list.html';
  const MAP = 'https://www.bchydro.com/power-outages/app/outage-map.html#outage=';
  const TZ = 'America/Vancouver';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    header: $('.site-header'), form: $('#search-form'), q: $('#street-address'), muni: $('#city'), muniList: $('#muni-list'), past: $('#past'), clear: $('#clear'),
    status: $('#status'), results: $('#results'), updated: $('#updated'), home: $('#home'),
  };

  const HOME_KEY = 'outage-finder.home';
  const SNAP_KEY = 'outage-finder.snapshot';
  const BASE_KEY = 'outage-finder.baseline';
  const HIST_KEY = 'outage-finder.history';
  const HIST_MAX = 300;
  const DEFAULT_MUNI = 'Bowen Island';

  const state = {
    outages: [], munis: [], byMuni: new Map(), updatedDate: 0, query: '', muni: '', past: false, loading: false, error: '',
    home: readJSON(localStorage, HOME_KEY), baseline: undefined, diff: null, history: [], showSearch: false,
    current: [], currentError: '',
  };

  /** Assign innerHTML only when it changes, so a render that produces the same page mutates nothing. */
  function setHTML(el, html) { if (el.innerHTML !== html) el.innerHTML = html; }

  function readJSON(store, key) { try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; } }
  function writeJSON(store, key, val) { try { if (val == null) store.removeItem(key); else store.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ } }

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
    }
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function ingest(data, currentData) {
    const regions = data.regions || [];
    const currentRegions = (currentData && currentData.regions) || [];
    const muniSet = new Set();
    for (const r of regions.concat(currentRegions)) {
      for (const m of r.municipalities || []) muniSet.add(typeof m === 'string' ? m : m.name);
      for (const o of r.outages || []) if (o.municipality) muniSet.add(o.municipality);
    }
    state.munis = [...muniSet].sort((a, b) => a.localeCompare(b));
    const outages = [];
    for (const r of regions) {
      for (const o of r.outages || []) {
        outages.push({ ...o, kind: 'planned', regionName: o.regionName || r.name, regionId: r.id, parsed: P.parseArea(o.area, state.munis) });
      }
    }
    const current = [];
    for (const r of currentRegions) {
      for (const o of r.outages || []) {
        current.push({ ...o, kind: 'current', regionName: o.regionName || r.name, regionId: r.id, related: [], parsed: P.parseArea(o.area, state.munis) });
      }
    }
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
  function resolveMunis(text) {
    const t = (text || '').trim().toLowerCase();
    if (!t) return null;
    const exact = state.munis.filter((m) => m.toLowerCase() === t);
    if (exact.length) return new Set(exact.map((m) => m.toLowerCase()));
    const partial = state.munis.filter((m) => m.toLowerCase().includes(t));
    return new Set(partial.map((m) => m.toLowerCase()));
  }

  // ------------------------------------------------------------ search

  function statusOf(o, now) {
    if (o.kind === 'current') return 'in progress';
    if (o.parsed.flags.cancelled) return 'cancelled';
    if (now < o.dateOff) return 'upcoming';
    if (now <= o.dateOn) return 'in progress';
    return 'finished';
  }

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
    hits.sort((a, b) => (b.muniMatch - a.muniMatch) || (b.match.level - a.match.level) || (b.match.streetScore - a.match.streetScore) || (a.o.dateOff - b.o.dateOff));
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
    const q = P.parseQuery(home.address, state.munis);
    const muniSet = resolveMunis(home.muni || q.muni);
    const strong = [], weak = [], nearby = [];
    for (const o of state.outages.concat(state.current)) {
      if (!state.past && statusOf(o, now) === 'finished') continue;
      const match = P.matchOutage(q, o.parsed);
      const muniMatch = !!muniSet && (muniSet.has(o.municipality.toLowerCase()) || (match && muniSet.has(match.segment.locality.toLowerCase())));
      if (!match) { if (o.kind === 'current' && muniMatch) nearby.push({ o, match: null, muniMatch: true }); continue; }
      if (muniSet && !muniMatch) continue;
      if (match.streetScore >= 2 && !match.segment.boundary) strong.push({ o, match, muniMatch: true });
      else if (o.kind === 'current' && muniMatch) nearby.push({ o, match, muniMatch: true });
      else weak.push({ o, match, muniMatch: true });
    }
    strong.sort((a, b) => ((a.o.kind === 'current' ? 0 : 1) - (b.o.kind === 'current' ? 0 : 1)) || (b.match.level - a.match.level) || (a.o.dateOff - b.o.dateOff));
    return { q, strong, weak, nearby };
  }

  function snapshotOf(items) {
    const out = {};
    for (const { o, match } of items) {
      out[o.id] = { kind: o.kind, dateOff: o.dateOff, dateOn: o.dateOn, cancelled: o.parsed.flags.cancelled, listed: match.numberListed, text: o.parsed.text };
    }
    return out;
  }

  /** Compare the current matches with the snapshot saved on the previous visit. */
  function computeDiff(base, items, now) {
    const changes = { added: [], rescheduled: [], cancelled: [], updated: [], finished: [], removed: [], byId: {} };
    if (!base || !base.items) return changes;
    const prev = base.items;
    for (const { o } of items) {
      const p = prev[o.id];
      if (!p) { changes.added.push(o); changes.byId[o.id] = o.kind === 'current' ? 'New unplanned outage' : 'New'; continue; }
      if (o.kind === 'current') {
        if (p.dateOn !== o.dateOn || p.text !== o.parsed.text) { changes.updated.push(o); changes.byId[o.id] = 'Updated'; }
        continue;
      }
      if (!p.cancelled && o.parsed.flags.cancelled) { changes.cancelled.push(o); changes.byId[o.id] = 'Now cancelled'; }
      else if (p.dateOff !== o.dateOff || p.dateOn !== o.dateOn) { changes.rescheduled.push({ o, was: p }); changes.byId[o.id] = 'Time changed'; }
      else if (p.text !== o.parsed.text) { changes.updated.push(o); changes.byId[o.id] = 'Address list updated'; }
    }
    const currentIds = new Set(items.map((i) => String(i.o.id)));
    for (const id of Object.keys(prev)) {
      if (currentIds.has(id)) continue;
      const p = prev[id];
      if (p.kind === 'current' || p.dateOn < now) changes.finished.push({ id, ...p });
      else changes.removed.push({ id, ...p });
    }
    return changes;
  }

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
      state.baseline = undefined; state.diff = null; state.history = [];
    }
    render();
  }


  function forgetHome() {
    state.home = null; state.baseline = undefined; state.diff = null; state.history = []; state.showSearch = false;
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
    if (out.length) summary += `<strong class="danger">An unplanned outage is affecting ${whose} street right now.</strong> `;
    else if (matches.nearby.length) summary += `${matches.nearby.length} unplanned outage${matches.nearby.length === 1 ? '' : 's'} elsewhere in ${esc(muni || matches.q.muni)} right now, none listing ${whose} street. `;
    if (!n) summary += `No planned outage lists ${whose} street.`;
    else if (listed) summary += `<strong>${listed}</strong> planned outage${listed === 1 ? '' : 's'} list${listed === 1 ? 's' : ''} ${whose} address${n > listed ? `, and ${n - listed} more list${n - listed === 1 ? 's' : ''} ${whose} street` : ''}.`;
    else summary += `<strong>${n}</strong> planned outage${n === 1 ? '' : 's'} list${n === 1 ? 's' : ''} ${whose} street${matches.q.number ? `, but not ${whose} house number` : ''}.`;
    if (matches.weak.length) summary += ` ${matches.weak.length} similar street name${matches.weak.length === 1 ? '' : 's'} shown below.`;
    return summary;
  }

  /** The matched outages' times, one line each, newest first for unplanned then soonest planned. */
  function upcomingList(matches, now) {
    if (!matches.strong.length) return '';
    const rows = matches.strong.map(({ o, match }) => {
      const tag = state.diff && state.diff.byId[o.id] ? ` <span class="badge new">${esc(state.diff.byId[o.id])}</span>` : '';
      const where = `<span class="muted">${esc(match.segment.label)}</span>`;
      if (o.kind === 'current') {
        const restore = o.dateOn ? `, estimated restoration ${esc(fmtDateTime(o.dateOn))}` : ', no restoration estimate yet';
        return `<li><span class="danger"><b>Unplanned outage</b> out since ${esc(fmtDateTime(o.dateOff))}${restore}</span>${tag}<br>${where}</li>`;
      }
      const st = statusOf(o, now);
      let when = `<b>${esc(fmtWindow(o.dateOff, o.dateOn))}</b> (${esc(fmtDuration(o.dateOn - o.dateOff))})`;
      if (st === 'upcoming') when += `, starts ${esc(fmtRelative(o.dateOff - now))}`;
      else if (st === 'in progress') when += `, <span class="danger">in progress now</span>`;
      else if (st === 'cancelled') when = `<s>${when}</s> cancelled`;
      else when += ', finished';
      const note = o.parsed.notes.length ? ` <span class="muted">· ${esc(o.parsed.notes[0])}</span>` : '';
      return `<li>${when}${tag}<br>${where}${note}</li>`;
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
    const addr = `<span class="addr">${esc(state.home.address)}${state.home.muni ? ` <span class="muni">· ${esc(state.home.muni)}</span>` : ''}</span>`;
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
      const since = base.first ? `since you saved this address (${esc(fmtDateTime(base.at))})` : `since your last visit (${esc(fmtDateTime(base.at))})`;
      if (lines.length) changes = `<div class="changes"><strong>${lines.length} change${lines.length === 1 ? '' : 's'} ${since}:</strong><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul></div>`;
      else if (!base.first) changes = `<p class="hint">No changes ${since}.</p>`;
    }

    setHTML(els.home, `<div class="home-card">
  <h2 class="home-title">Outage information for ${addr}</h2>
  <p class="home-summary">${summary}</p>
  ${upcomingList(matches, now)}
  ${changes}
  <p class="home-actions"><a href="#" id="home-search">Search another address</a> <a href="#" id="home-forget">Clear my address and history</a></p>
</div>`);
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
    const r = search();
    if (r.mode === 'overview') return renderOverview();
    const atHome = queryIsHome();
    const tags = atHome && state.diff ? state.diff.byId : {};
    const parts = [];
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
    if (r.current && r.current.length) {
      const label = r.currentLabel ? ` in ${esc(r.currentLabel)}` : '';
      parts.push(`<p class="group-head">Unplanned outages right now${label}</p>`);
      parts.push(...r.current.map((i) => card(i, r.q, now, tags[i.o.id])));
    } else if (state.currentError) {
      parts.push(`<p class="hint">Unplanned outages could not be loaded (${esc(state.currentError)}).</p>`);
    }
    if (atHome) parts.push(renderHistory(now));
    setHTML(els.results, parts.join(''));
    if (atHome) setHTML(els.status, '');
    else summary(r);
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
  <p class="meta"><b>${esc(o.municipality)}</b> · ${esc(o.regionName)} · ${customers} customer${o.numCustomersOut === 1 ? '' : 's'} · ${esc(o.cause || 'Planned work')}</p>
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
  <p class="meta"><b>${esc(o.municipality)}</b> · ${esc(o.regionName)} · ${customers} customer${o.numCustomersOut === 1 ? '' : 's'} · ${esc(o.cause || 'Cause not yet known')}</p>
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
  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const v = els.q.value.trim();
      if (v === state.query) return;
      state.query = v; writeState(); render();
    }, DEBOUNCE_MS);
  }
  els.q.addEventListener('input', onInput);
  els.form.addEventListener('submit', (e) => {
    e.preventDefault(); clearTimeout(timer);
    state.query = els.q.value.trim(); writeState();
    if (state.query && queryIsAddress()) saveHome(state.query, state.muni);
    else render();
    els.q.blur();
  });
  els.q.addEventListener('blur', () => { const v = els.q.value.trim(); if (v !== state.query) { clearTimeout(timer); state.query = v; writeState(); render(); } });
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
    const id = e.target.id;
    if (id === 'home-forget') {
      e.preventDefault();
      if (window.confirm(`Clear your saved address (${state.home.address}) and its outage history from this browser?`)) forgetHome();
    }
    else if (id === 'home-search') {
      e.preventDefault();
      state.showSearch = true; state.query = ''; els.q.value = ''; state.muni = state.home.muni || DEFAULT_MUNI; els.muni.value = state.muni;
      writeState(); render(); els.q.focus();
    }
    else if (id === 'home-show') { e.preventDefault(); state.showSearch = false; state.query = state.home.address; els.q.value = state.query; state.muni = state.home.muni || ''; els.muni.value = state.muni; writeState(); render(); }
  });
  window.addEventListener('popstate', () => { readState(); render(); });

  readState();
  load();
})();
