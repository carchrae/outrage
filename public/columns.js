/*
 * Street lists (ul.addresses) in as many columns as fit, measured in the browser.
 *
 * Each entry's real width is measured, then the list gets the most columns in
 * which no entry wraps. Going from two columns to one is a big loss on a phone,
 * so two columns are still used when only a few long names (up to 15%) wrap.
 * Lists inside a closed <details> have no width; they are fitted when opened.
 *
 * Exposes window.OutageColumns.fitAll(root).
 */
(function (root) {
  'use strict';
  const TWO_COLUMN_WRAP_SHARE = 0.15;

  function textWidth(range, from, before) {
    range.selectNodeContents(from);
    if (before) range.setEndBefore(before);
    return range.getBoundingClientRect().width;
  }

  function fit(ul) {
    const cs = getComputedStyle(ul);
    const avail = ul.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const lis = Array.from(ul.children);
    if (avail <= 0 || !lis.length) return;
    const gap = parseFloat(cs.columnGap) || 0;
    ul.style.columns = '1'; // measure on full-width lines
    const range = document.createRange();

    // Number column: as wide as the widest short number list in this list.
    let numPx = 0, inner = 0;
    const aligned = ul.classList.contains('aligned');
    if (aligned) {
      for (const li of lis) {
        const n = li.querySelector('.num');
        if (n && n.textContent) numPx = Math.max(numPx, textWidth(range, n));
      }
      numPx = Math.ceil(numPx);
      ul.style.setProperty('--numpx', numPx + 'px');
      inner = parseFloat(getComputedStyle(lis[0]).columnGap) || 0;
    }
    const widths = lis.map((li) => {
      const name = aligned && li.querySelector('.name');
      if (!name) return textWidth(range, li);
      // A long house-number list sits on its own line under the name and may wrap freely.
      return numPx + inner + textWidth(range, name, name.querySelector('.nums'));
    });

    const fits = (k) => {
      const col = (avail - (k - 1) * gap) / k;
      const wraps = widths.filter((w) => w > col + 0.5).length;
      return wraps <= (k === 2 ? Math.floor(widths.length * TWO_COLUMN_WRAP_SHARE) : 0);
    };
    const most = Math.max(1, Math.min(lis.length, Math.floor((avail + gap) / (Math.min(...widths) + gap))));
    let n = 1;
    for (let k = most; k >= 2; k--) if (fits(k)) { n = k; break; }
    ul.style.columns = String(n);
  }

  function fitAll(scope) {
    if (typeof getComputedStyle !== 'function' || !document.createRange) return;
    (scope || document).querySelectorAll('ul.addresses').forEach(fit);
  }

  let pending = 0;
  function schedule() {
    if (pending) return;
    const raf = root.requestAnimationFrame || ((f) => setTimeout(f, 16));
    pending = raf(() => { pending = 0; fitAll(document); });
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    // A <details> opening gives its list a width; toggle does not bubble, so listen while capturing.
    document.addEventListener('toggle', (e) => { if (e.target.open) fitAll(e.target); }, true);
    if (root.addEventListener) root.addEventListener('resize', schedule);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  }

  root.OutageColumns = { fitAll, schedule };
})(typeof self !== 'undefined' ? self : this);
