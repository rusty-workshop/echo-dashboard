# Echo Dashboard

A static, dark-themed morning dashboard for a rooted Amazon Echo Show 5
(1st gen) running in kiosk mode, consuming [Aurora](../Aurora)'s
`/dashboard` API over the LAN.

No build tools, no frameworks, no dependencies - just `index.html`,
`style.css`, and `script.js`, served as-is.

## Configuring Aurora's address

Edit the two constants at the top of `script.js`:

```js
const DEFAULT_AURORA_HOST = "192.168.1.130";
const DEFAULT_AURORA_PORT = 8080;
```

Or, without editing the file, load the page once with `?host=` (and
optionally `&port=`) in the URL - e.g.
`http://<this-server>/?host=192.168.1.130&port=8080`. The override is
saved to `localStorage`, so a kiosk browser only needs the query string
on its very first load.

## Running locally

Any static file server works:

```
python3 -m http.server 8090
```

then open `http://localhost:8090/`.

## Deploying to the Echo Show

Serve these three files from wherever the kiosk browser is pointed - a
tiny local HTTP server on the Echo Show itself, or a `file://` URL if the
kiosk setup allows it. Either way, make sure the URL loads
`index.html`, `style.css`, and `script.js` from the same directory.

## Requires CORS on Aurora's side

Aurora's `/dashboard` and `/health` responses must include
`Access-Control-Allow-Origin`, or the browser will silently refuse to let
this page's JS read them (the request itself succeeds - only reading the
response is blocked). Aurora already sends this (see
`AuroraHttpServer.kt`); if you're pointing this dashboard at a different
or older Aurora build, confirm that's still the case.

## How it behaves

- **Two independent update loops.** The clock ticks every second, driven
  by the browser's own local time. `/dashboard` is polled every 30
  seconds. Changing the poll interval doesn't affect the clock, and vice
  versa.
- **Never blank.** The last successful `/dashboard` response is cached in
  `localStorage` and rendered immediately on load, before the first fetch
  even completes. If Aurora becomes unreachable, the dashboard keeps
  showing that cached data - it never reverts to an empty/error state.
- **Quiet about connectivity.** A small status pill (bottom-right) is
  invisible while data is fresh. After a few consecutive failed polls it
  fades in with "Reconnecting to Aurora…", then "Offline - showing data
  from X min ago" if the outage continues - subtle, not alarming.
- **Value changes pulse briefly** (a CSS animation, `.value-pulse`) so an
  update reads as a small "beat" rather than a silent jump-cut. Only
  fields whose value actually changed animate.

## Adding a future card

Aurora's roadmap includes per-app notifications, phone volume mode,
Wi-Fi status, a morning greeting, quote of the day, and smart home
controls. To add any of these once Aurora exposes the data:

1. Add a `<section class="card">` to `index.html`, following the shape of
   the existing four (a `card-title` heading + whatever elements you need,
   each with a unique `id`).
2. Add one `renderX(data.x)` function in `script.js`, next to
   `renderWeather`/`renderPhone`/etc., and call it from `renderDashboard()`.
3. No changes should be needed to the polling, caching, or
   connection-status code - all of that is already generic over "whatever
   the last successful `/dashboard` response was."

The grid is `repeat(4, 1fr)` in `style.css` (`.card-grid`), tuned for four
cards in one row on the Echo Show's 960px-wide screen. A fifth card will
need that changed - see the comment directly above it.
