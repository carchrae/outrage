# Push alerts for Planned outrage

Written 2026-11-02, implemented 2026-11-05. The design below was built as described, with these adjustments:

- The page keeps localStorage as its store and mirrors the address and snapshot into IndexedDB for the
  worker (`alerts.js`), rather than moving everything to IndexedDB. Nothing in `app.js` became async.
- The worker does not update the snapshot after a push. The page still computes "changes since your last
  visit" from the snapshot on the next open, so the notification and the page agree; a second push before a
  visit repeats the earlier changes along with the new ones.
- Matching and diffing moved from `app.js` into `public/matcher.js`, shared by the page, the worker and tests.
- Finished planned outages are not pushed on their own; the server pushes on any feed change to a listed
  street and the worker reports whatever the diff shows, which includes a finished outage only alongside
  something else. Three consecutive push failures, or a 404/410, delete the subscription. The page re-sends
  the street on each visit when it changed or the record is over a week old. Email was not built.

Setup is in the README under "Push alerts".

## Goal

Tell people when an outage affecting their saved address changes, even when the site is closed, without storing
their address on a server. A tab-based hourly check was tried and removed: desktop browsers throttle background
tabs and mobile browsers suspend them, so nobody gets alerted unless they are looking at the page.

## Why a tab or a plain service worker cannot do it

A web page only runs while its tab is open and in the foreground. A service worker is event-driven: the browser
starts it to handle an event and stops it after about 30 seconds idle, so it cannot keep an hourly timer. The one
API built for this, Periodic Background Sync, exists only in Chrome and Edge, needs the site installed as an app,
and runs when the browser decides, typically every 12 hours or less often. Something outside the browser has to
wake the device, and on the web that is Web Push.

## The silent-push constraint

A push must produce a visible notification. If the service worker receives one, checks the feed, finds nothing
relevant and shows nothing, Chrome shows its own "This site has been updated in the background" notice, and
Firefox counts a quota of silent pushes and then drops the subscription. BC Hydro's feeds change many times a day
and almost every change is irrelevant to any one address, so "push everyone whenever the JSON changes" would
either spam people with generic notices or unsubscribe them. The server has to filter before it pushes, which
means it must know something about where each subscriber is.

## Proposed design: subscribe by street, match by house number locally

When someone saves an address, the page sends the server only a normalized street-and-municipality key, such as
`15 ave|burnaby`, together with the push subscription. House number, unit, snapshot and history stay in the
browser. The hourly job diffs the feeds, works out which streets each added, changed or removed outage lists, and
pushes only to subscriptions on those streets, with the affected outage ids as the payload. The service worker
then fetches the feeds through the existing `/api` proxy, runs the full matcher against the locally stored
address, diffs against the local snapshot, and shows a notification like the on-page notice. Because the server
has already filtered by street, nearly every push is relevant; when the street matches but the house number does
not, the worker still shows a quieter "an outage on your street changed" notice rather than nothing.

```
On the device                                        On the device
+----------------------------+                       +------------------------------------+
| Page                       |                       | Service worker                     |
| saves address, snapshot    |                       | on push: fetch feeds, match house  |
| and history in IndexedDB   |                       | number locally, show notification  |
+-------------+--------------+                       +---------+--------------------------+
              | street key + push subscription                 ^ push: changed outage ids   | fetch feeds
              v                                                |                            v
On Netlify                                                     |
+----------------------------+   reads subscriptions   +-------+----------------------+     |
| Subscribe function         | ----------------------> | Hourly cron function         |     |
| stores push endpoint and   |                         | fetch feeds, diff vs last    |     |
| street key in Netlify Blobs|                         | copy, push to matching streets|    |
+----------------------------+                         +-------+----------------------+     |
                                                               ^ hourly fetch                |
External                                                       |                            |
                                                       +-------+----------------------------+
                                                       | BC Hydro feeds (planned + current JSON, no CORS, via /api) |
                                                       +------------------------------------+
```

The subscribe step runs once per saved address; the cron step repeats hourly and only pushes when a listed street
changed.

## Server side on Netlify

- **Scheduled function** `netlify/functions/check-feeds.mjs` on an hourly cron. It fetches both feeds, loads the
  previous copy from Blobs, and computes added, changed and removed outages by id and by their `lastUpdated`,
  `dateOff`, `dateOn` and `area` fields.
- **Street extraction** reuses `public/parse.js` unchanged: each affected outage's segments give the street keys
  and localities; the municipality comes from the outage.
- **Subscription store** in Netlify Blobs, one record per push endpoint:
  `{ endpoint, keys, streetKey, municipality, createdAt }`, keyed by a hash of the endpoint so records can be
  replaced and deleted.
- **Subscribe function** `subscribe.mjs` accepts POST with the subscription and street key, and DELETE to
  unsubscribe. It validates the street key with `parse.js` and never accepts a house number.
- **Push** with the `web-push` package and VAPID keys stored as `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
  `VAPID_SUBJECT` environment variables. Payload is `{ ids: [...], kind: 'planned' | 'current' }`, well under the
  4 KB limit. A 404 or 410 from the push service deletes the record.
- The last feed copy is stored in Blobs too; the first run after a deploy stores it and pushes nothing.

## Client side

- **Web app manifest** and `public/sw.js` registered from `app.js`, making the site installable, which iOS
  requires.
- **Storage moves to IndexedDB**: service workers cannot read localStorage, so the saved address, snapshot and
  history move to a small IndexedDB store that the page and the worker both read. The `readJSON` / `writeJSON`
  helpers in `app.js` become async.
- **Opt-in control** in the address panel: "Alert me when this changes". It requests notification permission,
  calls `pushManager.subscribe` with the VAPID public key, and POSTs the subscription plus the street key.
  Clearing the address sends the DELETE.
- **Push handler** in the worker: `importScripts('parse.js')`, fetch `/api/planned` and `/api/current`, run
  `matchOutage` for the stored address, diff against the stored snapshot, show one notification summarising the
  changes, update the snapshot and history. Always show something, even a quiet "outage on your street changed"
  notice, to satisfy the silent-push rule.
- **Notification click** focuses or opens the page, which then renders the same change notice from the updated
  snapshot.

## What the server holds

A push endpoint, which is an opaque URL generated by the browser's push service, and a street name with a
municipality. No house number, unit, name, email or history. Hashing the street key adds nothing, since the
server could hash any street itself, so the honest statement on the page is "we keep your street name so we only
send alerts that matter; your house number never leaves your browser". Unsubscribing deletes the record.

## Mobile

Android Chrome, Firefox and Samsung Internet receive pushes with no install step. iPhone and iPad support Web
Push from iOS 16.4, but only after the person adds the site to the Home Screen and grants notification permission
from that installed copy; a page in a Safari tab never receives pushes. The page should detect iOS and show an
"Add to Home Screen" hint before offering the alert toggle. Desktop Chrome, Edge, Firefox and Safari 16 and later
all work.

## Effort and open questions

About half a day: two Netlify functions, the Blobs store, the service worker, the IndexedDB migration and the
opt-in UI. `web-push` would be the project's first dependency and `@netlify/blobs` the second. Netlify's free
tier covers an hourly function and a few hundred subscriptions.

- [ ] Should planned-outage "finished" events push, or only new, rescheduled, cancelled and unplanned ones?
      Proposed: not finished.
- [ ] Rate limit: at most one push per subscriber per hour, batching several changes into one notification.
- [ ] Subscriptions that fail twice in a row are deleted; should the page re-subscribe silently on the next
      visit? Proposed: yes.
- [ ] Email as an alternative for people who refuse notifications: same server job, but then the server holds an
      email address instead of a street.
