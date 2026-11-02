/* BC Hydro planned outage finder — UI. Depends on parse.js (window.OutageParser). */
(function () {
  'use strict';
  const P = window.OutageParser;
  const API = window.OUTAGE_API || '/api/planned';
  const OFFICIAL = 'https://www.bchydro.com/power-outages/app/outage-list-planned.html';
  const TZ = 'America/Vancouver';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    form: $('#search-form'), q: $('#q'), muni: $('#muni'), muniList: $('#muni-list'), past: $('#past'), clear: $('#clear'),
    status: $('#status'), results: $('#results'), updated: $('#updated'),
  };

  const state = { outages: [], munis: [], byMuni: new Map(), updatedDate: 0, query: '', muni: '', past: false, loading: false, error: '' };

  // ------------------------------------------------------------ data

  async function load() {
    state.loading = true; state.error = '';
    renderStatus();
    try {
      const res = await fetch(API, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      ingest(await res.json());
    } catch (err) {
      state.error = 'Could not load the outage feed (' + (err.message || err) + '). Try again in a minute.';
    } finally {
      state.loading = false;
      render();
    }
  }

  function ingest(data) {
    const regions = data.regions || [];
    const muniSet = new Set();
    for (const r of regions) {
      for (const m of r.municipalities || []) muniSet.add(typeof m === 'string' ? m : m.name);
      for (const o of r.outages || []) if (o.municipality) muniSet.add(o.municipality);
    }
    state.munis = [...muniSet].sort((a, b) => a.localeCompare(b));
    const outages = [];
    for (const r of regions) {
      for (const o of r.outages || []) {
        outages.push({ ...o, regionName: o.regionName || r.name, regionId: r.id, parsed: P.parseArea(o.area, state.munis) });
      }
    }
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

  function fillMuniSelect() {
    els.muniList.innerHTML = state.munis.map((m) => `<option value="${esc(m)}">${(state.byMuni.get(m) || []).length} outages</option>`).join('');
    els.muni.value = state.muni;
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
      return { mode: 'municipality', q, muni: label, items: list.map((o) => ({ o, match: null, muniMatch: true })) };
    }
    if (!q.key) return { mode: 'overview', q, items: [] };

    const hits = [];
    for (const o of list) {
      const match = P.matchOutage(q, o.parsed);
      if (!match) continue;
      const muniMatch = inMuni(o, match.segment);
      if (state.muni && !muniMatch) continue;
      hits.push({ o, match, muniMatch });
    }
    hits.sort((a, b) => (b.muniMatch - a.muniMatch) || (b.match.level - a.match.level) || (b.match.streetScore - a.match.streetScore) || (a.o.dateOff - b.o.dateOff));
    if (hits.length) return { mode: 'address', q, items: hits };

    // Fallback: plain text search over the area description, notes and municipality.
    const words = state.query.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1);
    const text = list.filter((o) => {
      const hay = (o.parsed.text + ' ' + o.parsed.notes.join(' ') + ' ' + o.municipality + ' ' + o.cause).toLowerCase();
      return words.length && words.every((w) => hay.includes(w));
    });
    return { mode: 'text', q, items: text.map((o) => ({ o, match: null, muniMatch: true })) };
  }

  // ------------------------------------------------------------ render

  function render() {
    renderStatus();
    if (state.error || state.loading) { els.results.innerHTML = ''; return; }
    const r = search();
    const now = Date.now();
    if (r.mode === 'overview') return renderOverview();
    const parts = [];
    if (r.mode === 'address') {
      const strong = r.items.filter((i) => i.muniMatch);
      const other = r.items.filter((i) => !i.muniMatch);
      parts.push(...strong.map((i) => card(i, r.q, now)));
      if (other.length) {
        parts.push(`<p class="group-head">Same street name in other municipalities</p>`);
        parts.push(...other.map((i) => card(i, r.q, now)));
      }
    } else {
      parts.push(...r.items.map((i) => card(i, r.q, now)));
    }
    els.results.innerHTML = parts.join('');
    summary(r);
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
    els.status.innerHTML = msg;
  }

  function renderStatus() {
    if (state.loading) els.status.innerHTML = 'Loading BC Hydro planned outages…';
    else if (state.error) els.status.innerHTML = `<div class="error">${esc(state.error)} <button type="button" class="btn link" id="retry">Retry</button></div>`;
    else els.status.innerHTML = '';
    const upd = state.updatedDate ? `Feed updated ${fmtDateTime(state.updatedDate)}.` : '';
    els.updated.textContent = upd;
    const retry = $('#retry');
    if (retry) retry.addEventListener('click', load);
  }

  function renderOverview() {
    const now = Date.now();
    const active = state.outages.filter((o) => state.past || statusOf(o, now) !== 'finished');
    const byRegion = new Map();
    for (const o of active) {
      if (!byRegion.has(o.regionName)) byRegion.set(o.regionName, new Map());
      const m = byRegion.get(o.regionName);
      m.set(o.municipality, (m.get(o.municipality) || 0) + 1);
    }
    const soon = active.filter((o) => statusOf(o, now) !== 'cancelled' && o.dateOff - now < 48 * 3600e3).length;
    els.status.innerHTML = `<strong>${active.length}</strong> planned outages listed across BC, <strong>${soon}</strong> starting within 48 hours. Search above, or browse a municipality:`;
    const html = [...byRegion.keys()].sort().map((region) => {
      const munis = [...byRegion.get(region).entries()].sort((a, b) => a[0].localeCompare(b[0]));
      return `<section class="overview"><h2>${esc(region)}</h2><div class="chips">` +
        munis.map(([m, n]) => `<button type="button" class="chip" data-muni="${esc(m)}">${esc(m)}<span class="n">${n}</span></button>`).join('') +
        `</div></section>`;
    }).join('');
    els.results.innerHTML = html;
  }

  function card(item, q, now) {
    const o = item.o;
    const st = statusOf(o, now);
    const m = item.match;
    const badges = [];
    if (m) {
      if (m.numberListed === true) badges.push(`<span class="badge hit">${m.streetScore >= 2 ? 'Your address is listed' : 'Address listed (similar street name)'}</span>`);
      else if (m.numberListed === false) badges.push(`<span class="badge warn">Street listed, but ${q.number} is not in the listed numbers</span>`);
      else badges.push(`<span class="badge ${m.streetScore >= 2 ? 'hit' : ''}">${m.streetScore >= 2 ? 'Street listed' : 'Similar street name'}</span>`);
      if (!item.muniMatch) badges.push(`<span class="badge muted">${esc(o.municipality)}, not ${esc(state.muni || q.muni)}</span>`);
    }
    badges.push(statusBadge(o, st, now));
    if (o.parsed.flags.rescheduled && !o.parsed.flags.cancelled) badges.push('<span class="badge warn">Rescheduled</span>');
    if (o.parsed.flags.continued) badges.push('<span class="badge muted">Continuation of another listing</span>');

    const segs = o.parsed.segments.map((s) => {
      const isMatch = m && s === m.segment;
      const loc = s.locality && s.locality !== o.municipality ? ` <span class="loc">(${esc(s.locality)})</span>` : '';
      const qual = s.qualifier ? ` <span class="qual">(${esc(s.qualifier)})</span>` : '';
      return `<li class="${isMatch ? 'match' : ''}">${esc(s.label)}${qual}${loc}</li>`;
    }).join('');

    const customers = o.numCustomersOut < 5 ? 'fewer than 5' : fmtNum(o.numCustomersOut);
    const hitClass = m && m.numberListed === true && item.muniMatch ? ' hit' : '';
    return `
<article class="card${hitClass}${st === 'cancelled' ? ' cancelled' : ''}" id="o-${o.id}">
  <div class="card-top">${badges.join('')}</div>
  <h3 class="when">${fmtWindow(o.dateOff, o.dateOn)} <span class="dur">(${fmtDuration(o.dateOn - o.dateOff)})</span></h3>
  <p class="meta"><b>${esc(o.municipality)}</b> · ${esc(o.regionName)} · ${customers} customer${o.numCustomersOut === 1 ? '' : 's'} · ${esc(o.cause || 'Planned work')}</p>
  ${o.parsed.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
  ${segs ? `<ul class="addresses">${segs}</ul>` : ''}
  <details class="raw"><summary>Original area text from BC Hydro</summary><pre>${esc(o.parsed.text)}</pre></details>
  ${o.related.length ? `<p class="related">Same time window in ${esc(o.municipality)} (likely the same job):${o.related.map((id) => `<button type="button" data-goto="${id}">#${id}</button>`).join('')}</p>` : ''}
  <p class="card-foot"><span>Outage #${o.id}</span><span>Listing updated ${fmtDateTime(o.lastUpdated)}</span><a href="${OFFICIAL}#planned-${o.regionId}" rel="noopener" target="_blank">View region on bchydro.com</a></p>
</article>`;
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
    let q = u.get('q'); let muni = u.get('muni'); const past = u.get('past') === '1';
    if (q == null && muni == null) {
      try { const saved = JSON.parse(localStorage.getItem('outage-finder') || '{}'); q = saved.q || ''; muni = saved.muni || ''; } catch (e) { /* ignore */ }
    }
    state.query = q || ''; state.muni = muni || ''; state.past = past;
    els.q.value = state.query; els.past.checked = state.past;
  }
  function writeState() {
    const u = new URLSearchParams();
    if (state.query) u.set('q', state.query);
    if (state.muni) u.set('muni', state.muni);
    if (state.past) u.set('past', '1');
    const qs = u.toString();
    history.replaceState(null, '', qs ? '?' + qs : location.pathname);
    try { localStorage.setItem('outage-finder', JSON.stringify({ q: state.query, muni: state.muni })); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ events

  let timer = 0;
  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = els.q.value.trim(); writeState(); render(); }, 180);
  }
  els.q.addEventListener('input', onInput);
  els.form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(timer); state.query = els.q.value.trim(); writeState(); render(); els.q.blur(); });
  let muniTimer = 0;
  const onMuni = () => { clearTimeout(muniTimer); muniTimer = setTimeout(() => { state.muni = els.muni.value.trim(); writeState(); render(); }, 180); };
  els.muni.addEventListener('input', onMuni);
  els.muni.addEventListener('change', onMuni);
  els.past.addEventListener('change', () => { state.past = els.past.checked; writeState(); render(); });
  els.clear.addEventListener('click', () => { state.query = ''; state.muni = ''; els.q.value = ''; els.muni.value = ''; writeState(); render(); els.q.focus(); });
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
  window.addEventListener('popstate', () => { readState(); render(); });

  readState();
  load();
  setInterval(load, 5 * 60 * 1000);
})();
