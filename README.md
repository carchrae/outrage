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

The app checks the feeds when the page loads; reload to refresh. Background alerts are deliberately not
built; `docs/push-alerts.md` holds the plan for doing it with Web Push without storing addresses server-side.

No build step, no dependencies. Plain HTML, CSS and JavaScript in `public/`.

## Browser storage

Everything stays in the browser; nothing is sent anywhere except the outage feed request.

| localStorage key | Contents |
|---|---|
| `outage-finder.home` | saved address and municipality |
| `outage-finder.snapshot` | matches seen on the last visit, used to detect changes |
| `outage-finder.history` | every outage ever matched for the saved address (capped at 300) |

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

`netlify.toml` already contains everything: it publishes `public/` and proxies
`/api/planned` and `/api/current` to BC Hydro with a 200 rewrite. Connect the repo to
Netlify, or run `netlify deploy --prod` from this directory. No functions are needed.

## Local development

```sh
npm start          # serves public/ on http://localhost:3000 and proxies /api/* like Netlify does
npm test           # parser unit tests (node:test)
npm run check-live # fetches the live feed and reports how well the parser handles every entry
```

`netlify dev` also works if you have the Netlify CLI installed.

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
