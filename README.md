# Planned outrage

A single-page app that makes BC Hydro's planned-outage list searchable by street address.
BC Hydro publishes each outage's affected area as free text such as
`7420-7591 Kraft Cres, 7470-7586 Kraft Pl, Burnaby`. This app parses that text into
street segments with house-number ranges, so you can type `7500 Kraft Crescent, Burnaby`
and see whether your house number falls inside a listed range, with the full
address list shown instead of clipped.

No build step, no dependencies. Plain HTML, CSS and JavaScript in `public/`.

## Data source

- Planned outages: `https://www.bchydro.com/power-outages/app/outages-list-data-planned.json`
- Current (unplanned) outages, not used by the UI yet: `.../outages-list-data-current.json`

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
