# echo-dashboard

![Vanilla JS](https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?logo=javascript&logoColor=black)
![No build step](https://img.shields.io/badge/build%20step-none-success)
![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)

A dark, swipeable bedside dashboard for a repurposed Amazon Echo Show,
built entirely in vanilla HTML/CSS/JS — no framework, no bundler, no
`node_modules`. It pulls from [**Aurora**](https://github.com/rustyisacat/Aurora) v3.0, a
companion Android app, over your home Wi-Fi and turns an old smart display
into a self-hosted phone status board, morning briefing, bedside alarm
clock, bedside sound machine, and an idle-screensaver photo frame — themed
however you like, right down to matching your own wallpaper's colors.

<p align="center">
  <img src="docs/screenshot-overview.png" width="49%" alt="Morning Overview page" />
  <img src="docs/screenshot-sound.png" width="49%" alt="Clock and Sound Machine page" />
</p>

## Features

- **Six swipeable pages** (CSS scroll-snap, real touch scrolling, tap-to-jump
  dot indicators): a Morning Overview, a dedicated Phone page, a Daily Info
  page, a Clock/Alarm/Sound Machine page, a Wake Alarms page, and a
  Settings page for picking a theme. Two more full-screen views live
  outside that swipeable set entirely, summoned rather than swiped to —
  see Bedside Mode and Ambient Mode below.
- **Morning Briefing**: a one-glance summary composed client-side from
  weather, calendar, and rain forecast — a greeting, today's conditions
  (with an umbrella warning if rain is expected), and a countdown to your
  next calendar event.
- **Wake Alarms**: set, edit, and delete Aurora's own alarms right from
  this display — time, repeat days, and which sound rings. When one
  fires, a full-screen overlay takes over (any page, not just wherever you
  left it) with a looped alarm sound and Dismiss/Snooze, and automatically
  stops whatever the ambient sound machine was doing so the two don't
  overlap.
- **Bedside Sound Machine**: built-in and custom ambient sounds, looped
  gaplessly via the Web Audio API and played through the display's own
  speakers — control it from the dashboard itself or from the Aurora phone
  app, they stay in sync.
- **Bedside Mode**: one tap (the moon icon next to the clock) starts rain,
  dims the display to a comfortable 50% (adjustable live via an on-screen
  slider), and arms any disabled wake alarms — then summons a dedicated
  full-screen view with a huge centered clock, tomorrow's first event, and
  the Sound Machine controls, until you tap the exit button.
- **Ambient Mode**: after 30 minutes with no touch (never while Bedside
  Mode is active), a screensaver-style view takes over — huge clock, tiny
  weather line, dimmed — cycling your Aurora-picked photos with a slow
  crossfade, or a twinkling starfield if you haven't picked any yet. Any
  touch exits it instantly.
- **Rotating main-UI wallpaper**: the same photo library you pick for
  Ambient Mode also cycles slowly behind the main dashboard (scrimmed for
  legibility), crossfading every few minutes; its dominant color, extracted
  client-side, becomes the dashboard's accent color, taking over from the
  weather-driven default.
- **Do Not Disturb toggle**: silence the phone straight from the
  Notifications card — it flips Android's real system DND, so calls and
  notifications stay quiet until you toggle it back.
- **Notification icons and previews**: each app in the Notifications card
  shows its real launcher icon plus a one-line preview of its latest
  notification, not just a bare count — which apps show up at all is
  controlled from the Aurora phone app's Notification Apps card.
- **Charging ETA**: the Phone card shows "Full in ~X min" once Aurora has
  enough recent charge-rate history to estimate it.
- **8 Dashboard Themes** (Material You, Nothing OS, Pixel, Retro CRT, OLED
  Minimal, Catppuccin, Nord, Gruvbox), switchable from the Settings page —
  each swaps palette, typography, shape, and shadow style over the same
  shared layout, no separate frontends to maintain.
- **Animated weather backgrounds**: a subtle, condition-specific ambient
  layer behind every page — sun glow, drifting clouds, falling rain or
  snow, thunderstorm flashes, or a starfield at night — all CSS, no JS
  per-frame cost.
- **Polish animations throughout**: rolling numbers for temperature and
  battery, a filling battery gauge, a weather-icon transition on change, a
  scroll-driven page-transition effect while swiping, and a livelier
  alarm-ringing pulse.
- **Low battery banner**: a red warning appears on the Overview page if
  the phone is genuinely low and not charging — a bedside device dying
  overnight defeats the point.
- **Auto-dim at night, brightens in the morning**: the whole display dims
  itself for bedside comfort using actual sunrise/sunset (falls back to a
  fixed 9pm–7am window until the first weather fetch), and nudges the real
  hardware backlight too if Fully Kiosk Browser's JS interface is enabled.
- **Customizable layout**: the Morning Overview's card order, visibility,
  and size are controlled from the Aurora phone app and picked up here
  automatically, no code changes needed.
- **Dynamic accent color** that shifts with the current weather condition
  by default, or follows the rotating wallpaper's colors once your photo
  library has photos (see above) — every theme keeps this behavior, it's
  not something themes override.
- **Resilient by default**: the last good response is cached and shown
  immediately on load, survives Aurora going offline, and quietly shows a
  reconnecting/offline status instead of ever going blank.

## Requirements

- [Aurora](https://github.com/rustyisacat/Aurora) v3.0+ running on a phone on the
  same Wi-Fi network as whatever device will display this. Ambient Mode's
  photo rotation and the dashboard wallpaper both need Aurora v3.0
  specifically (earlier versions don't have the Photo Picker endpoints);
  everything else works against v2.0 too.
- Any modern browser. Built and tested for a kiosk browser (e.g.
  [Fully Kiosk Browser](https://www.fully-kiosk.com/)) on a rooted/sideloaded
  Amazon Echo Show 5 (1st gen), but nothing here is Echo-Show-specific —
  it renders fine in any browser window.

No build tools, no package manager, no dependencies: just `index.html`,
`style.css`, and `script.js`, served as static files.

## Installation

1. **Clone the repo:**

   ```
   git clone https://github.com/rustyisacat/echo-dashboard.git
   cd echo-dashboard
   ```

2. **Point it at your Aurora instance** — edit the two constants at the
   top of `script.js`:

   ```js
   const DEFAULT_AURORA_HOST = "192.168.1.130";
   const DEFAULT_AURORA_PORT = 8080;
   ```

   Or skip editing the file entirely and load the page once with a query
   string — e.g. `http://<this-server>/?host=192.168.1.130&port=8080` —
   the override is remembered in `localStorage`, so a kiosk browser only
   needs it on the very first load.

3. **Serve the three files.** Any static file server works:

   ```
   python3 -m http.server 8090
   ```

   then open `http://localhost:8090/`.

4. **Point your display's browser at that URL** and set it to kiosk/full-screen
   mode. On Fully Kiosk Browser, either serve these files from a small local
   HTTP server on the device itself, or use a `file://` URL if your kiosk
   setup allows it — either way, keep all three files in the same directory.

5. **Confirm Aurora sends CORS headers.** `/dashboard` and `/health`
   responses need `Access-Control-Allow-Origin`, or the browser will
   silently block this page's JS from reading them (the request itself
   still succeeds — only reading the response is blocked). Aurora sends
   this by default; only relevant if you're pointing this at a modified
   or much older Aurora build.

6. **(Optional) Enable Fully Kiosk's JS interface** if you want the
   night auto-dim feature to control the actual screen backlight, not
   just this page's own contents. Without it, auto-dim still works, just
   as a CSS-only effect.

## How it behaves

- **Two independent update loops.** The clock ticks every second off the
  browser's own local time; `/dashboard` is pulled every 30 seconds.
  Neither affects the other.
- **Never blank.** The last successful `/dashboard` response is cached in
  `localStorage` and rendered immediately on load, before the first fetch
  even completes. If Aurora becomes unreachable, the dashboard keeps
  showing that cached data instead of going empty.
- **Quiet about connectivity.** A small status line is invisible while
  data is fresh. After a few consecutive failed pulls it shows
  "Reconnecting to Aurora…", then "Offline - showing data from X min ago"
  if the outage continues.
- **Values pulse briefly** on change (a CSS animation) so an update reads
  as a small "beat" rather than a silent jump-cut — only fields that
  actually changed animate.
- **Sound Machine survives reloads and reboots.** Aurora remembers what
  *should* be playing; the very first pull after this page loads (or the
  whole display reboots) notices and resumes it automatically. A ringing
  Wake Alarm is reconciled the same way, so a reload that happens to land
  mid-ring picks it right back up.
- **Theme choice persists locally** (`localStorage`, applied synchronously
  before the page paints, so there's no flash of the wrong theme on
  reload) — it's a display preference, not something Aurora needs to know
  about.

## Adding a new card

1. Add a `<section class="card">` to `index.html`'s Morning Overview page
   (a `card-title` heading + whatever elements you need, each with a
   unique `id`), and an entry in `TILE_DOM_ID`/`DEFAULT_TILE_LAYOUT` in
   `script.js`.
2. Add one `renderX(data.x)` function in `script.js`, next to
   `renderWeather`/`renderPhone`/etc., and call it from `renderDashboard()`.
3. No changes should be needed to the pulling, caching, layout, or
   connection-status code — all of it is already generic over "whatever
   the current `/dashboard` response and layout say."

## AI Disclaimer

Parts of this project were assisted or written by AI. If that's something
you're not comfortable with, no hard feelings, I understand and I don't
force anyone to use it. The code may have flaws. If you spot something
that could be better, contributions are very welcome. I'm still learning
and would appreciate the help.

## License

[AGPL v3](LICENSE)
