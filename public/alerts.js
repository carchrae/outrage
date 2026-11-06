/*
 * Push alerts for the saved address.
 *
 * Manages the push subscription. The server only ever receives the normalised street name and
 * municipality, never the house number; the notification text it pushes is street-level.
 */
(function () {
  'use strict';
  const P = window.OutageParser;
  const FLAG_KEY = 'outage-finder.alerts';
  const RESYNC_MS = 7 * 24 * 3600 * 1000;
  const metaKey = document.querySelector('meta[name="vapid-public-key"]');
  const publicKey = (window.VAPID_PUBLIC_KEY || (metaKey && metaKey.content) || '').trim();

  // ---------------------------------------------------------------- state

  function readFlag() { try { return JSON.parse(localStorage.getItem(FLAG_KEY) || 'null'); } catch (e) { return null; } }
  function writeFlag(v) { try { if (v == null) localStorage.removeItem(FLAG_KEY); else localStorage.setItem(FLAG_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ } }

  function supported() {
    return !!publicKey && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && /safari/i.test(navigator.userAgent) && !/chrome/i.test(navigator.userAgent));
  }
  function standalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }
  /** iPhone and iPad only deliver pushes to a site added to the Home Screen. */
  function needsInstall() { return isIOS() && !standalone(); }

  /** 'unsupported' | 'blocked' | 'on' | 'off' */
  function status() {
    if (!supported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    return readFlag() ? 'on' : 'off';
  }

  // ---------------------------------------------------------------- subscription

  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function register() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    return reg;
  }

  function streetOf(home, munis) {
    const q = P.parseQuery(home.address, munis);
    return { street: q.key, muni: (home.muni || q.muni || '').trim() };
  }

  /** Tell the server which street this subscription cares about. Replaces any earlier record for the endpoint. */
  async function post(sub, home, munis) {
    const { street, muni } = streetOf(home, munis);
    if (!street) throw new Error('Alerts need a street name in the saved address.');
    const res = await fetch('/api/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), street, muni }),
    });
    if (!res.ok) throw new Error('Could not register for alerts (HTTP ' + res.status + ').');
    writeFlag({ street, muni, endpoint: sub.endpoint, at: Date.now() });
  }

  async function subscribe(reg) {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    return sub;
  }

  /** Ask for permission, subscribe, and register the street with the server. Throws with a readable message. */
  async function enable(home, munis) {
    if (!supported()) throw new Error('This browser does not support push alerts.');
    if (needsInstall()) throw new Error('On iPhone and iPad, add this page to your Home Screen first, then turn alerts on from there.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : 'Notifications were not allowed.');
    const reg = await register();
    const sub = await subscribe(reg);
    await post(sub, home, munis);
  }

  /** Remove the server record and the browser subscription. Never throws. */
  async function disable() {
    const flag = readFlag();
    writeFlag(null);
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      const endpoint = (sub && sub.endpoint) || (flag && flag.endpoint);
      if (endpoint) await fetch('/api/subscribe', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) });
      if (sub) await sub.unsubscribe();
    } catch (e) { /* best effort */ }
  }

  /**
   * Keep an existing alert subscription healthy: re-register the worker, re-subscribe if the browser
   * dropped the subscription, and re-send the street when the saved address changed or the record is old.
   */
  async function sync(home, munis) {
    if (status() !== 'on') return;
    if (!home) { await disable(); return; }
    try {
      const reg = await register();
      if (Notification.permission !== 'granted') { writeFlag(null); return; }
      const sub = await subscribe(reg);
      const flag = readFlag() || {};
      const { street, muni } = streetOf(home, munis);
      if (flag.street !== street || flag.muni !== muni || flag.endpoint !== sub.endpoint || Date.now() - (flag.at || 0) > RESYNC_MS) await post(sub, home, munis);
    } catch (e) { /* offline or server unavailable; try again next visit */ }
  }

  window.OutageAlerts = { supported, status, needsInstall, isIOS, standalone, enable, disable, sync, register };
})();
