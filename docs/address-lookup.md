# Address lookup from "Use my location"

Written 2026-11-06. The code is wired and committed; it stays dormant until a BC Address Geocoder
key is configured. This is what is in place and what remains.

## Behaviour

- Location is read only when the visitor presses **Use my location** under the search form. The
  page never asks on its own, and a saved address is never changed by the lookup.
- Step 1, always: the nearest municipality is picked from `public/munis.json` (bundled centroids,
  no network call) and put in the Municipality field.
- Step 2, only with a key: the coordinates go to `GET /api/locate?lat=&lon=`, which asks the BC
  Address Geocoder for the nearest civic address and returns `{ address, number, street,
  locality }`. The page fills the Address field (and the municipality from the geocoder's locality
  when the feeds know it), shows "Nearest address from the BC Address Geocoder. Check it, then
  press Save Address.", and focuses the field. Nothing is saved until the visitor presses Save.
- Without a key the build leaves `<meta name="geocoder">` empty, the button is not shown at all,
  and the function answers 501 if anything calls it.

## What is wired

| Piece | File |
|---|---|
| Geocoder call and response parsing (pure, tested) | `netlify/functions/lib/geocode.mjs` |
| Netlify function at `/api/locate`, validates coordinates are inside BC | `netlify/functions/locate.mjs` |
| Local stand-in for the function, reads `BC_GEOCODER_KEY` from `.env` | `server.js` |
| Build stamp sets the `geocoder` meta tag when the key exists | `scripts/stamp.js` |
| Button handler: location, municipality, optional lookup, form fill | `locate()` in `public/app.js` |
| Tests for parsing, bounds and the request shape | `test/feed-diff.test.js` |

The browser only ever sends latitude and longitude, rounded to five decimals, to this site's own
function; the key never leaves the server and the browser never talks to the geocoder.

## When the key arrives

1. Get it from the API Services Portal (https://api.gov.bc.ca/devportal/api-directory, "Address
   Geocoder", public plan, sent as the `apikey` header).
2. Put it in `.env` as `BC_GEOCODER_KEY=...` and run `npm start`. The startup log stops saying
   "no BC_GEOCODER_KEY", and `curl "http://localhost:3000/api/locate?lat=49.3768&lon=-123.3695"`
   should return an address on Bowen Island.
3. Press **Use my location** on the local page and confirm the Address field fills and the status
   line names the geocoder. Check the result against the real street; the geocoder returns the
   nearest known site, which on rural roads can be a neighbour.
4. Add `BC_GEOCODER_KEY` to the Netlify site's environment variables and redeploy. The deploy log
   from `scripts/stamp.js` should mention the geocoder; the live page's `Use my location` then
   does the lookup.
5. Optional follow-ups once it is seen working: verify the exact field names in a real
   `sites/nearest.json` response against `parseNearest` (written from the developer guide, not a
   live response), and decide whether to show the distance when it is large, as a hint that the
   match may be a neighbour.
