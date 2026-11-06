# Try it here

[outrage.bowenlift.com](https://outrage.bowenlift.com/)


# Planned outrage

A single-page app that makes BC Hydro's planned-outage list searchable by street address.
BC Hydro publishes each outage's affected area as free text such as
`7420-7591 Kraft Cres, 7470-7586 Kraft Pl, Burnaby`. This app parses that text into
street segments with house-number ranges, so you can type `7500 Kraft Crescent, Burnaby`
and see whether your house number falls inside a listed range, with the full
address list shown instead of clipped.

The municipality comes first and defaults to Bowen Island, since matching without one is poor.
Results appear as you type. Until an address is saved, a prompt under the search box asks you to
press Save Address (or Enter), which remembers the address in the browser. Every later visit opens on the saved
address, flags what changed since the previous visit (new, rescheduled, cancelled, updated or
no-longer-listed outages, plus unplanned outages that started or were resolved) and keeps a quiet
history of every outage ever seen for it. Searching something else shows a panel for that address
with the saved one underneath; Save Address switches to it, and "Clear my address and history"
wipes everything.

Unplanned outages come from BC Hydro's current-outage feed and are shown alongside planned ones:
on the saved address when they list its street or hundred-block, and under any municipality search.

The app checks the feeds when the page loads; reload to refresh. "Alert me when this changes" on the saved
address turns on push alerts: an hourly check on Netlify diffs the feeds and pushes to the browsers whose
street is touched, and the service worker then matches the full address locally and shows a notification.
See "Push alerts" below and `docs/push-alerts.md` for the design.

The site itself is plain HTML, CSS and JavaScript in `public/` with no build step. The two dependencies
(`web-push`, `@netlify/blobs`) are only used by the Netlify functions.

## Browser storage

Everything stays in the browser; nothing is sent anywhere except the outage feed request, and, only
when alerts are turned on, the street name and municipality (see "Push alerts").

| localStorage key | Contents |
|---|---|
| `outage-finder.home` | saved address and municipality |
| `outage-finder.snapshot` | matches seen on the last visit, used to detect changes |
| `outage-finder.history` | every outage ever matched for the saved address (capped at 300) |
| `outage-finder.alerts` | street, municipality and push endpoint registered for alerts |

The address and snapshot are also mirrored into IndexedDB (database `outrage`, store `kv`) because
the service worker cannot read localStorage.

The "since your last visit" baseline is pinned in sessionStorage so a reload does not clear the
notice. Changing or clearing the address resets the snapshot and history. The page always opens on
the saved address; a `?q=` in the URL is only honoured when no address is saved.

## Data source

- Planned outages: `https://www.bchydro.com/power-outages/app/outages-list-data-planned.json`
- Current (unplanned) outages: `https://www.bchydro.com/power-outages/app/outages-list-data-current.json`

Both have the same shape (`regions[].outages[]` with a free-text `area`). Unplanned outages
describe areas as hundred-blocks (`3700 block BEAVER VALLEY RD`) or boundaries (`North of 64 AVE`),
which the parser understands; a boundary street never counts as a strong match.

The feed does not send CORS headers, so the browser cannot fetch it directly.
The app requests `/api/planned` on its own origin and relies on a server-side proxy.

## Deploying on Netlify

`netlify.toml` already contains everything: it runs `node scripts/stamp.js` as the
build command (which rewrites the asset URLs in `index.html` to `app.js?v=<commit>`
and sets long-lived cache headers, so each deploy is picked up on the next visit
without a hard reload), publishes `public/` and proxies
`/api/planned` and `/api/current` to BC Hydro with a 200 rewrite. Connect the repo to
Netlify, or run `netlify deploy --prod` from this directory.

## Push alerts

Turning alerts on asks for notification permission, subscribes the browser to push, and sends the
server the normalised street name and municipality (for example `adams rd` and `bowen island`) with
the push subscription. The house number, unit, snapshot and history never leave the browser.

- `netlify/functions/subscribe.mjs` serves `POST` and `DELETE /api/subscribe` and keeps one record
  per push endpoint in Netlify Blobs (store `push`).
- `netlify/functions/check-feeds.mjs` runs hourly. It fetches both feeds, diffs them against the
  copy from the previous run, works out which streets each added, changed or removed outage lists,
  and pushes only to subscriptions on those streets. The payload is just outage ids. A 404 or 410
  from the push service, or three failures in a row, deletes the record.
- `public/sw.js` handles the push: it fetches the feeds through `/api`, matches the saved address
  with the same `matcher.js` the page uses, diffs against the last snapshot and shows one
  notification describing the changes. Clicking it opens the site, which shows the same changes.
- Subscriptions are re-sent on every visit when the street changed or the record is a week old, and
  removed when the address is cleared.

Setup, once per site:

```sh
npm install
npm run vapid       # prints a VAPID public/private key pair
```

In the Netlify site settings, add the environment variables `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
and `VAPID_SUBJECT` (a `mailto:` address or the site URL), then redeploy. The build stamps the public
key into `index.html`; without it the alert toggle is simply not shown. Scheduled functions only run
on deployed sites, not in `netlify dev`.

iPhone and iPad only receive Web Push from a site added to the Home Screen (iOS 16.4 and later), so
the page shows an "Add to Home Screen" hint there instead of the toggle until it is opened from the
installed icon. Android and desktop browsers work from a normal tab.

## Local development

```sh
npm start          # serves public/ on http://localhost:3000 and proxies /api/* like Netlify does
npm test           # parser, matcher and feed-diff unit tests (node:test)
npm run check-live # fetches the live feed and reports how well the parser handles every entry
```

`npm start` generates a throwaway VAPID key for the run (when `web-push` is installed) and keeps
push subscriptions in memory, so the Install and alerts buttons can be tried locally; set
`VAPID_PUBLIC_KEY` to use your own key. No pushes are sent locally, since the hourly check only
runs on Netlify. `netlify dev` also works if you have the Netlify CLI installed.

## How matching works

`public/parse.js` is shared between the browser and the tests.

- **Area parsing**: bold `<b>` notes (rescheduled, cancelled, duration caveats) are split out
  from the address list. Semicolons and line breaks separate groups, and a run of numbers or
  ranges followed by a street name becomes one segment. Parenthetical qualifiers such as
  `(Units 1-21)` and `(evens only)` are kept, and trailing municipality names become the
  segment's locality. Listings whose text starts with `Cont'd` are flagged as continuations.
- **Street normalisation**: `15th Avenue`, `15 Ave` and `15TH AVE.` all map to `15 ave`.
  Common abbreviations (Cres/Crs/Crescent, Crt/Ct/Court, Dr/Drive, ...) are canonicalised.
- **Query parsing**: unit numbers (`204-7730 ...`, `#204`), postal codes and `BC` are stripped.
  A trailing municipality is recognised with or without a comma.
- **Ranking**: address listed in a range > street listed without a number > street listed but
  number outside the ranges > similar street name (one or two character typos). Results in
  other municipalities are shown in a separate section. If nothing matches as an address, a
  plain-text search over the descriptions runs instead.

Matching can only be as good as BC Hydro's text. Entries such as "Traffic signals at 72 Ave
and 194A St" or "Parts of Heffley Creek" have no house numbers and only match by text.
# outrage
