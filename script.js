/**
 * Aurora Dashboard
 *
 * Vanilla JS, no build step, no framework. Two independent update loops:
 *  - the clock ticks every second, driven by the device's own local time
 *    (also refreshes the "Updated Xs ago" status line on the same tick)
 *  - the Aurora poll runs every 30s and re-renders every card plus the
 *    Morning Briefing
 *
 * The Sound Machine card is the one place this dashboard sends control
 * requests (POST), not just reads - see "Sound machine controls" below.
 * Every other card stays a pure, read-only reflection of /dashboard.
 *
 * FUTURE EXPANSION: to add a new data-driven card (Wi-Fi, volume mode,
 * quote of the day, smart home controls, ...):
 *   1. Add a <section class="card"> to index.html with its own ids.
 *   2. Add one renderX(data.x) function below, next to the others.
 *   3. Call it from renderDashboard().
 * The polling/caching/status-line machinery is already generic over
 * "whatever the last successful /dashboard response was" and shouldn't
 * need to change.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Edit these to Aurora's LAN address, or override per-load with
// ?host=192.168.1.130&port=8080 in the URL - the override is remembered in
// localStorage, so a kiosk browser only needs the query string once.
const DEFAULT_AURORA_HOST = "192.168.1.130";
const DEFAULT_AURORA_PORT = 8080;

// Same pattern as WeatherConfig's hardcoded coordinates on the Aurora side:
// the Morning Briefing needs a name, and that's a pure display concern with
// no Android-side data behind it, so it lives here rather than as a new
// Aurora API field.
const USER_NAME = "Rusty";

const POLL_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;
const VOLUME_DEBOUNCE_MS = 400;

// After this many consecutive failed polls, the status line switches from
// "reconnecting" to a more visible "offline" state.
const OFFLINE_AFTER_FAILURES = 3;

// Bumped whenever the /dashboard schema changes - an old cached response
// missing a newer field (e.g. soundMachine) would otherwise crash the
// renderer that expects it. A version bump just invalidates the old entry
// instead of trying to migrate it.
const CACHE_KEY = "aurora-dashboard:last-good-response:v3";
const HOST_OVERRIDE_KEY = "aurora-dashboard:host-override";

// ---------------------------------------------------------------------------
// Morning Overview tile layout - customizable from the Aurora phone app
// (order, visibility, size). Falls back to this same arrangement until the
// first successful /dashboard response arrives (or forever, if the phone
// app has never touched it - see LayoutRepository on the Aurora side).
// ---------------------------------------------------------------------------

const TILE_DOM_ID = {
  weather: "card-weather",
  phone: "card-phone",
  notifications: "card-notifications",
  schedule: "card-schedule",
  alarm: "card-alarm",
  sound: "card-sound",
};

const TILE_SIZE_WEIGHT = { small: 0.7, medium: 1, large: 1.5 };

const DEFAULT_TILE_LAYOUT = [
  { id: "weather", visible: true, size: "medium" },
  { id: "phone", visible: true, size: "medium" },
  { id: "notifications", visible: true, size: "large" },
  { id: "schedule", visible: true, size: "medium" },
  { id: "alarm", visible: true, size: "small" },
  { id: "sound", visible: true, size: "large" },
];

// ---------------------------------------------------------------------------
// Aurora host resolution
// ---------------------------------------------------------------------------

function resolveAuroraBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  const queryHost = params.get("host");
  const queryPort = params.get("port");

  if (queryHost) {
    const override = { host: queryHost, port: queryPort || DEFAULT_AURORA_PORT };
    localStorage.setItem(HOST_OVERRIDE_KEY, JSON.stringify(override));
  }

  let host = DEFAULT_AURORA_HOST;
  let port = DEFAULT_AURORA_PORT;

  try {
    const stored = localStorage.getItem(HOST_OVERRIDE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      host = parsed.host || host;
      port = parsed.port || port;
    }
  } catch (err) {
    // Corrupt localStorage value - fall back to the default silently.
  }

  return `http://${host}:${port}`;
}

const AURORA_BASE_URL = resolveAuroraBaseUrl();

// ---------------------------------------------------------------------------
// Icons - inline Material-style SVGs (currentColor, so they inherit the
// dynamic accent color), no icon font/CDN dependency.
// ---------------------------------------------------------------------------

const ICONS = {
  sunny:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  cloud:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 19a4.5 4.5 0 0 1-.5-8.98A6 6 0 0 1 17.6 8.03 4.5 4.5 0 0 1 17 19H6.5z"/></svg>',
  rain:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 15a4.5 4.5 0 0 1-.5-8.98A6 6 0 0 1 17.6 4.03 4.5 4.5 0 0 1 17 15H6.5z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/></svg>',
  storm:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 13a4.5 4.5 0 0 1-.5-8.98A6 6 0 0 1 17.6 2.03 4.5 4.5 0 0 1 17 13H6.5z"/><path d="M13 13l-3 5h3l-2 4"/></svg>',
  snow:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 14a4.5 4.5 0 0 1-.5-8.98A6 6 0 0 1 17.6 3.03 4.5 4.5 0 0 1 17 14H6.5z"/><path d="M8 18v4M8 18l-1.5 1.5M8 18l1.5 1.5M12 18v4M12 18l-1.5 1.5M12 18l1.5 1.5M16 18v4M16 18l-1.5 1.5M16 18l1.5 1.5"/></svg>',
  fog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h13M3 12h18M3 16h13M8 20h8"/></svg>',
  battery:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 10v4"/><rect x="5" y="9.5" width="10" height="5" fill="currentColor" stroke="none"/></svg>',
  batteryCharging:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 10v4"/><path d="M12 9l-3 4h3l-1 4 4-5h-3z" fill="currentColor" stroke="none"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  calendar:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
  alarm:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M5 3L3 5M19 3l2 2"/></svg>',
  speaker:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 5V4l-5 5H4z"/><path d="M17 8a5 5 0 0 1 0 8M19.5 5.5a9 9 0 0 1 0 13"/></svg>',
  volume:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 5V4l-5 5H4z"/><path d="M17 8a5 5 0 0 1 0 8"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12"/></svg>',
};

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function byId(id) {
  return document.getElementById(id);
}

/**
 * Sets an element's text content, and - only when the value actually
 * changed - briefly replays the value-pulse animation, so updates read as
 * a subtle "beat" instead of silently changing between polls.
 */
function setText(id, value) {
  const el = byId(id);
  if (!el) return;

  const next = value == null ? "" : String(value);
  if (el.textContent === next) return;

  el.textContent = next;
  el.classList.remove("value-pulse");
  void el.offsetWidth; // force reflow so the animation restarts cleanly
  el.classList.add("value-pulse");
}

/** Swaps an icon-slot's SVG only when the icon actually changes. */
function setIcon(id, iconName) {
  const el = byId(id);
  if (!el || el.dataset.icon === iconName) return;
  el.dataset.icon = iconName;
  el.innerHTML = ICONS[iconName] || "";
}

/** Calendar event titles and app names come from the phone - untrusted
 *  user data - so escape before dropping anything into innerHTML. */
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Aurora returns 24-hour "HH:mm" strings; the display uses 12-hour + AM/PM. */
function formatTime12h(hhmm) {
  if (!hhmm) return null;
  const [hourStr, minuteStr] = hhmm.split(":");
  let hour = parseInt(hourStr, 10);
  if (Number.isNaN(hour)) return hhmm;

  const period = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minuteStr} ${period}`;
}

// Matches the exact condition strings Aurora's WeatherConditionMapper emits.
const WEATHER_ICON_BY_CONDITION = {
  Clear: "sunny",
  "Partly Cloudy": "cloud",
  Overcast: "cloud",
  Fog: "fog",
  Drizzle: "rain",
  Rain: "rain",
  "Rain Showers": "rain",
  Snow: "snow",
  "Snow Showers": "snow",
  Thunderstorm: "storm",
};

// v1.1: dynamic accent color by weather - warm for clear, gray for cloud,
// blue for anything wet. Applied as a CSS custom property so every element
// using var(--accent) (icons, highlighted numbers, the volume slider, ...)
// transitions together.
const ACCENT_BY_CONDITION = {
  Clear: "#ffb74d",
  "Partly Cloudy": "#9aa5b1",
  Overcast: "#9aa5b1",
  Fog: "#9aa5b1",
  Drizzle: "#5b9bf0",
  Rain: "#5b9bf0",
  "Rain Showers": "#5b9bf0",
  Snow: "#5b9bf0",
  "Snow Showers": "#5b9bf0",
  Thunderstorm: "#5b9bf0",
};

function applyAccentColor(condition) {
  document.documentElement.style.setProperty("--accent", ACCENT_BY_CONDITION[condition] || "#9aa5b1");
}

function greetingForHour(hour) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// ---------------------------------------------------------------------------
// Clock - independent of the Aurora poll loop, ticks every second. Also
// refreshes the status line's relative "Updated Xs ago" text on the same
// tick, since that needs to advance even between polls.
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function updateClock() {
  const now = new Date();

  let hour = now.getHours();
  const period = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  const minute = String(now.getMinutes()).padStart(2, "0");
  const timeText = `${hour}:${minute} ${period}`;
  const weekdayText = WEEKDAY_NAMES[now.getDay()];
  const monthdayText = `${MONTH_NAMES[now.getMonth()]} ${now.getDate()}`;

  // The clock appears twice - compact on the Morning Overview page, huge
  // on the dedicated Clock/Sound page - so both ids get every tick.
  setText("clock-time", timeText);
  setText("clock-weekday", weekdayText);
  setText("clock-monthday", monthdayText);
  setText("clock-time-lg", timeText);
  setText("clock-weekday-lg", weekdayText);
  setText("clock-monthday-lg", monthdayText);

  updateStatusLine();
}

function startClock() {
  updateClock();
  setInterval(updateClock, 1000);
}

// ---------------------------------------------------------------------------
// Rendering - one function per card, each safely no-ops on missing/null
// data, plus the Morning Briefing.
// ---------------------------------------------------------------------------

function renderWeather(weather) {
  if (!weather) {
    setIcon("weather-icon", "cloud");
    setText("weather-temp", "--°");
    setText("weather-condition", "No data");
    setText("weather-high", "--°");
    setText("weather-low", "--°");
    setIcon("weather-icon-lg", "cloud");
    setText("weather-temp-lg", "--°");
    setText("weather-condition-lg", "No data");
    setText("weather-high-lg", "--°");
    setText("weather-low-lg", "--°");
    return;
  }

  const icon = WEATHER_ICON_BY_CONDITION[weather.condition] || "cloud";
  const temp = `${Math.round(weather.temperature)}°`;
  const high = `${Math.round(weather.high)}°`;
  const low = `${Math.round(weather.low)}°`;

  // Weather appears twice - the compact Overview card and the big hero
  // tile on the Daily Info page - so both ids get updated together.
  setIcon("weather-icon", icon);
  setText("weather-temp", temp);
  setText("weather-condition", weather.condition);
  setText("weather-high", high);
  setText("weather-low", low);

  setIcon("weather-icon-lg", icon);
  setText("weather-temp-lg", temp);
  setText("weather-condition-lg", weather.condition);
  setText("weather-high-lg", high);
  setText("weather-low-lg", low);

  applyAccentColor(weather.condition);
}

function renderPhone(battery, charging) {
  const icon = charging ? "batteryCharging" : "battery";
  const chargingText = charging ? "Charging" : "Not charging";

  // Phone appears twice - the compact Overview card and the big hero tile
  // on the Phone page.
  setIcon("phone-battery-icon", icon);
  setText("phone-battery-level", `${battery}%`);
  setText("phone-charging", chargingText);

  setIcon("phone-battery-icon-lg", icon);
  setText("phone-battery-level-lg", `${battery}%`);
  setText("phone-charging-lg", chargingText);
}

function renderNotifications(groups) {
  setIcon("notifications-title-icon", "bell");
  setIcon("notifications-title-icon-lg", "bell");

  const html =
    !groups || groups.length === 0
      ? '<li class="notif-empty">All clear</li>'
      : groups
          .map(
            (group) => `<li class="notif-item">
        <span class="notif-app">${escapeHtml(group.app)}</span>
        <span class="notif-count">${group.count}</span>
      </li>`
          )
          .join("");

  // Notifications appears twice - the compact Overview card and the full
  // list on the Phone page - both get the same markup.
  const list = byId("notif-list");
  if (list) list.innerHTML = html;
  const listLg = byId("notif-list-lg");
  if (listLg) listLg.innerHTML = html;
}

function renderSchedule(events) {
  setIcon("schedule-title-icon", "calendar");
  setIcon("schedule-title-icon-lg", "calendar");

  const html =
    !events || events.length === 0
      ? '<li class="schedule-empty">No events</li>'
      : events
          .map((event) => {
            const time = escapeHtml(event.allDay ? "All day" : formatTime12h(event.start));
            const title = escapeHtml(event.title || "Untitled");
            return `<li class="schedule-item">
        <span class="schedule-time">${time}</span>
        <span class="schedule-title">${title}</span>
      </li>`;
          })
          .join("");

  const list = byId("schedule-list");
  if (list) list.innerHTML = html;
  const listLg = byId("schedule-list-lg");
  if (listLg) listLg.innerHTML = html;
}

function renderAlarm(nextAlarm) {
  const text = nextAlarm ? formatTime12h(nextAlarm.time) : "No alarm";

  // Alarm appears twice - the compact Overview card and the inline line
  // under the clock on the Clock/Sound page.
  setIcon("alarm-title-icon", "alarm");
  setText("alarm-time", text);
  setIcon("alarm-title-icon-lg", "alarm");
  setText("alarm-time-lg", text);
}

/** Sets a <input type=range>'s value from server state, unless the user is
 *  actively dragging it - same "don't fight the user mid-drag" rule as the
 *  picker sync below, just for whichever of the two volume sliders (compact
 *  Overview card or the big one on the Clock/Sound page) isn't in use. */
function syncRangeInputIfIdle(id, value) {
  const el = byId(id);
  if (el && document.activeElement !== el) {
    el.value = String(value);
  }
}

/** Same idea as syncRangeInputIfIdle, for the sound-picker <select>s. */
function syncPickerIfIdle(id, soundName) {
  const picker = byId(id);
  if (!picker || document.activeElement === picker || !soundName) return;
  const matching = Array.from(picker.options).find((opt) => opt.textContent === soundName);
  if (matching) picker.value = matching.value;
}

function renderSoundMachine(state) {
  // Defensive against a missing/malformed field - e.g. an old cached
  // /dashboard response from before this field existed. CACHE_KEY is
  // versioned to avoid this in practice, but a render function shouldn't
  // throw and abort the rest of the page over one bad field either way.
  if (!state) {
    setIcon("sound-icon", "speaker");
    setText("sound-name", "Off");
    setIcon("sound-icon-lg", "speaker");
    setText("sound-name-lg", "Off");
    return;
  }

  const nameText = state.sound
    ? state.sound + (state.sleepTimerMinutes != null ? ` · ${state.sleepTimerMinutes} min left` : "")
    : "Off";
  const playPauseIcon = state.playing ? "pause" : "play";
  const playPauseLabel = state.playing ? "Pause" : "Play";

  // Sound Machine appears twice - the compact Overview card and the full
  // control panel on the Clock/Sound page - both sets of controls get
  // updated together so either one reflects reality regardless of which
  // page was used to change it.
  setIcon("sound-icon", "speaker");
  setText("sound-name", nameText);
  setIcon("sound-play-pause-icon", playPauseIcon);
  byId("sound-play-pause")?.setAttribute("aria-label", playPauseLabel);
  setIcon("sound-stop-icon", "stop");
  setIcon("volume-icon", "volume");
  syncRangeInputIfIdle("sound-volume", state.volume);
  setText("sound-volume-label", `${state.volume}%`);
  syncPickerIfIdle("sound-picker", state.sound);

  setIcon("sound-icon-lg", "speaker");
  setText("sound-name-lg", nameText);
  setIcon("sound-play-pause-icon-lg", playPauseIcon);
  byId("sound-play-pause-lg")?.setAttribute("aria-label", playPauseLabel);
  setIcon("sound-stop-icon-lg", "stop");
  setIcon("volume-icon-lg", "volume");
  syncRangeInputIfIdle("sound-volume-lg", state.volume);
  setText("sound-volume-label-lg", `${state.volume}%`);
  syncPickerIfIdle("sound-picker-lg", state.sound);
}

function renderMorningBriefing(data) {
  const hour = new Date().getHours();
  setText("briefing-greeting", `${greetingForHour(hour)}, ${USER_NAME}.`);

  const weather = data.weather;
  setText(
    "briefing-weather",
    weather
      ? `${Math.round(weather.temperature)}°F and ${weather.condition.toLowerCase()}, reaching ${Math.round(weather.high)}° today.`
      : "Weather data isn't available yet."
  );

  const firstEvent = data.calendar && data.calendar.length > 0 ? data.calendar[0] : null;
  const eventPart = firstEvent
    ? `First event at ${firstEvent.allDay ? "all day" : formatTime12h(firstEvent.start)}`
    : "No events today";
  const notifPart = `${data.notifications} notification${data.notifications === 1 ? "" : "s"}`;
  const batteryPart = `Battery ${data.battery}%${data.charging ? " (charging)" : ""}`;

  setText("briefing-summary", `${eventPart} · ${notifPart} · ${batteryPart}`);
}

let lastAppliedLayoutJson = null;

/**
 * Rebuilds the Morning Overview's .card-row wrappers from a layout config:
 * groups visible tiles two per row in the given order, and sets each
 * row's/card's flex-grow from TILE_SIZE_WEIGHT. The <section class="card">
 * elements are moved, not cloned or recreated, so this never touches their
 * ids, listeners, or already-rendered content - only where they sit in the
 * grid. A hidden tile is simply left unattached; the render functions
 * below (e.g. renderNotifications) then safely no-op on it via their
 * existing "element not found" guards, no special-casing needed.
 *
 * Skips the rebuild entirely if the layout is unchanged since last call,
 * so a routine 30s poll doesn't replay the card-fade-in animation or touch
 * the DOM for no reason.
 */
function applyTileLayout(tiles) {
  const grid = document.querySelector(".card-grid");
  if (!grid) return;

  const layoutJson = JSON.stringify(tiles);
  if (layoutJson === lastAppliedLayoutJson) return;
  lastAppliedLayoutJson = layoutJson;

  // Grab references to the actual card elements before clearing the grid -
  // grid.innerHTML = "" below only destroys the throwaway .card-row
  // wrapper divs; these already-referenced card nodes get moved back in
  // below, not lost, since appendChild reattaches an existing node rather
  // than requiring a fresh one.
  const cardElements = {};
  for (const tileId of Object.keys(TILE_DOM_ID)) {
    const el = byId(TILE_DOM_ID[tileId]);
    if (el) cardElements[tileId] = el;
  }

  grid.innerHTML = "";

  const visibleTiles = tiles.filter((tile) => tile.visible && cardElements[tile.id]);
  for (let i = 0; i < visibleTiles.length; i += 2) {
    const rowTiles = visibleTiles.slice(i, i + 2);
    const row = document.createElement("div");
    row.className = "card-row";
    row.style.flexGrow = String(Math.max(...rowTiles.map((tile) => TILE_SIZE_WEIGHT[tile.size] ?? 1)));

    rowTiles.forEach((tile, indexInRow) => {
      const card = cardElements[tile.id];
      card.style.flexGrow = String(TILE_SIZE_WEIGHT[tile.size] ?? 1);
      card.style.animationDelay = `${(i + indexInRow) * 40}ms`;
      row.appendChild(card);
    });

    grid.appendChild(row);
  }
}

function renderDashboard(data) {
  applyTileLayout(data.layout && data.layout.length > 0 ? data.layout : DEFAULT_TILE_LAYOUT);
  renderMorningBriefing(data);
  renderWeather(data.weather);
  renderPhone(data.battery, data.charging);
  renderNotifications(data.notificationGroups);
  renderSchedule(data.calendar);
  renderAlarm(data.nextAlarm);
  renderSoundMachine(data.soundMachine);
}

// ---------------------------------------------------------------------------
// Sound machine - the actual audio engine.
//
// Aurora never plays audio - it tracks *desired* state and serves raw
// bytes (GET /sound/stream). This device (the Echo Show, via its kiosk
// browser) is what has speakers, so playback happens entirely here using
// the Web Audio API: fetch the file once, decode it to a PCM buffer, and
// loop that buffer with source.loop = true. That loop is sample-accurate -
// genuinely gapless, unlike <audio loop> re-triggering a compressed
// stream - and cheap on the Echo Show's modest hardware, since decoding
// happens once up front rather than continuously.
//
// Every control (play/pause/stop/volume/timer) does two things: acts on
// the local AudioContext immediately (so the UI feels instant), and POSTs
// to Aurora so /dashboard stays consistent with what's actually playing.
// reconcileSoundMachine() is the other direction - on every poll, it
// compares Aurora's desired state against local reality and corrects any
// mismatch. That's what makes playback resume automatically after this
// page reloads or the Echo Show reboots: Aurora remembers "should be
// playing rain", and the first poll after reload sees that and starts it.
//
// Browser autoplay policy note: starting audio with no prior user gesture
// on this page load (exactly the reboot-resume case) can be blocked by
// Chromium's autoplay policy. startLocalPlayback() below handles the
// rejection by queuing the request and retrying on the next touch
// anywhere on the screen (see the pointerdown listener) - if unattended
// resume after a reboot doesn't produce sound until the screen is
// touched, that's this policy, not a bug; check Fully Kiosk Browser's
// advanced web settings for an autoplay/media-gesture override if it
// needs to be fully unattended.
// ---------------------------------------------------------------------------

const SLEEP_TIMER_FADE_MS = 10_000;

let audioContext = null;
let gainNode = null;
let currentSource = null; // the AudioBufferSourceNode currently playing, or null
const bufferCache = new Map(); // soundId -> decoded AudioBuffer

let currentSoundId = null; // which sound is loaded locally (playing or paused)
let isLocallyPlaying = false;
let playbackOffsetSeconds = 0; // position within the loop, captured on pause
let playbackStartContextTime = 0; // audioContext.currentTime the current source effectively started at

let pendingAutoResume = null; // { soundId, offsetSeconds }, set if autoplay was blocked
let sleepTimerHandle = null;
let sleepTimerFadeHandle = null;

function ensureAudioContext() {
  if (!audioContext) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextCtor();
    gainNode = audioContext.createGain();
    gainNode.connect(audioContext.destination);
  }
  return audioContext;
}

async function loadSoundBuffer(soundId) {
  if (bufferCache.has(soundId)) return bufferCache.get(soundId);
  const ctx = ensureAudioContext();
  const response = await fetch(`${AURORA_BASE_URL}/sound/stream?id=${encodeURIComponent(soundId)}`);
  if (!response.ok) throw new Error(`Failed to fetch sound "${soundId}": HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  bufferCache.set(soundId, audioBuffer);
  return audioBuffer;
}

function stopSourceNode() {
  if (!currentSource) return;
  try {
    currentSource.stop();
  } catch (err) {
    // Already stopped - fine.
  }
  currentSource.disconnect();
  currentSource = null;
}

async function startLocalPlayback(soundId, offsetSeconds = 0) {
  const ctx = ensureAudioContext();

  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (err) {
      pendingAutoResume = { soundId, offsetSeconds };
      return;
    }
  }
  if (ctx.state === "suspended") {
    // resume() can resolve without actually leaving "suspended" under some
    // autoplay policies - same fallback as the catch above.
    pendingAutoResume = { soundId, offsetSeconds };
    return;
  }

  const buffer = await loadSoundBuffer(soundId);
  stopSourceNode();

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(gainNode);

  const startOffset = buffer.duration > 0 ? offsetSeconds % buffer.duration : 0;
  source.start(0, startOffset);

  currentSource = source;
  currentSoundId = soundId;
  playbackStartContextTime = ctx.currentTime - startOffset;
  isLocallyPlaying = true;
  pendingAutoResume = null;
}

function pauseLocalPlayback() {
  if (!isLocallyPlaying) return;
  const buffer = bufferCache.get(currentSoundId);
  if (buffer && buffer.duration > 0) {
    playbackOffsetSeconds = (audioContext.currentTime - playbackStartContextTime) % buffer.duration;
  }
  stopSourceNode();
  isLocallyPlaying = false;
  cancelLocalSleepTimer();
}

function stopLocalPlaybackFully() {
  stopSourceNode();
  isLocallyPlaying = false;
  playbackOffsetSeconds = 0;
  cancelLocalSleepTimer();
}

function setLocalVolume(percent) {
  ensureAudioContext();
  gainNode.gain.value = percent / 100;
}

// Resolves autoplay-policy blocks: the first touch anywhere on the kiosk
// screen after a reboot/reload unblocks the AudioContext and completes
// whatever playback Aurora said should already be happening.
document.addEventListener(
  "pointerdown",
  () => {
    if (!audioContext || audioContext.state !== "suspended") return;
    audioContext.resume().then(() => {
      if (pendingAutoResume) {
        const { soundId, offsetSeconds } = pendingAutoResume;
        pendingAutoResume = null;
        startLocalPlayback(soundId, offsetSeconds);
      }
    });
  },
  { passive: true }
);

function cancelLocalSleepTimer() {
  if (sleepTimerHandle) {
    clearTimeout(sleepTimerHandle);
    sleepTimerHandle = null;
  }
  if (sleepTimerFadeHandle) {
    clearInterval(sleepTimerFadeHandle);
    sleepTimerFadeHandle = null;
  }
}

/** [totalMinutes] is Aurora's already-resolved remaining time (handles "until alarm" too). */
function startLocalSleepTimer(totalMinutes) {
  cancelLocalSleepTimer();
  if (totalMinutes == null) return;

  const totalMs = totalMinutes * 60_000;
  const fadeStartDelayMs = Math.max(totalMs - SLEEP_TIMER_FADE_MS, 0);
  sleepTimerHandle = setTimeout(() => {
    sleepTimerHandle = null;
    fadeOutAndStop();
  }, fadeStartDelayMs);
}

function fadeOutAndStop() {
  if (!isLocallyPlaying) return;

  const steps = 20;
  const stepMs = SLEEP_TIMER_FADE_MS / steps;
  const startGain = gainNode.gain.value;
  let step = 0;

  sleepTimerFadeHandle = setInterval(() => {
    step += 1;
    gainNode.gain.value = startGain * Math.max(1 - step / steps, 0);

    if (step >= steps) {
      clearInterval(sleepTimerFadeHandle);
      sleepTimerFadeHandle = null;
      stopLocalPlaybackFully();
      gainNode.gain.value = startGain; // restored for the next play()
      postSoundAction("/sound/stop");
      poll();
    }
  }, stepMs);
}

/**
 * Reconciles local playback against Aurora's desired state. This is the
 * whole "survives a reload/reboot" mechanism: called on every poll, so
 * the very first poll after this page loads fresh (nobody clicked
 * anything) will notice "Aurora says rain should be playing" and start it.
 */
function reconcileSoundMachine(state) {
  if (!state) return;

  setLocalVolume(state.volume);

  const desiredSoundId = resolveSoundIdFromDisplayName(state.sound);

  if (state.playing && desiredSoundId) {
    if (!isLocallyPlaying || currentSoundId !== desiredSoundId) {
      const offset = currentSoundId === desiredSoundId ? playbackOffsetSeconds : 0;
      startLocalPlayback(desiredSoundId, offset);
    }
    if (state.sleepTimerMinutes != null && !sleepTimerHandle) {
      startLocalSleepTimer(state.sleepTimerMinutes);
    }
  } else if (!state.playing && isLocallyPlaying) {
    pauseLocalPlayback();
  }
}

function resolveSoundIdFromDisplayName(displayName) {
  if (!displayName) return null;
  const picker = byId("sound-picker");
  if (!picker) return null;
  const match = Array.from(picker.options).find((opt) => opt.textContent === displayName);
  return match ? match.value : null;
}

async function postSoundAction(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetch(`${AURORA_BASE_URL}${path}`, { method: "POST", signal: controller.signal });
  } catch (err) {
    // Best-effort - local playback already reflects the action; the next
    // poll/reconcile corrects Aurora's state if this request was dropped.
  } finally {
    clearTimeout(timeout);
  }
}

let soundLibraryLoaded = false;

async function ensureSoundLibraryLoaded() {
  if (soundLibraryLoaded) return;
  const picker = byId("sound-picker");
  const pickerLg = byId("sound-picker-lg");
  if (!picker && !pickerLg) return;

  try {
    const response = await fetch(`${AURORA_BASE_URL}/sound/library`, { cache: "no-store" });
    if (!response.ok) return;
    const entries = await response.json();
    const optionsHtml = entries
      .map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.displayName)}</option>`)
      .join("");
    if (picker) picker.innerHTML = optionsHtml;
    if (pickerLg) pickerLg.innerHTML = optionsHtml;
    soundLibraryLoaded = entries.length > 0;
  } catch (err) {
    // Aurora unreachable at startup - retried after the next successful poll.
  }
}

/**
 * Wires one set of Sound Machine controls to the shared playback engine
 * above. Called twice - once for the compact Overview card's ids, once
 * for the "-lg" ids on the dedicated Clock/Sound page - since both sets
 * of controls act on the exact same local playback state and the same
 * Aurora endpoints, just with a different id suffix.
 */
function setupSoundControlsFor(idSuffix) {
  const playPauseButton = byId(`sound-play-pause${idSuffix}`);
  const stopButton = byId(`sound-stop${idSuffix}`);
  const volumeInput = byId(`sound-volume${idSuffix}`);
  const soundPicker = byId(`sound-picker${idSuffix}`);
  const timerPicker = byId(`timer-picker${idSuffix}`);

  playPauseButton?.addEventListener("click", async () => {
    if (isLocallyPlaying) {
      pauseLocalPlayback();
      await postSoundAction("/sound/pause");
    } else {
      const soundId = soundPicker?.value || currentSoundId;
      if (!soundId) return;
      await startLocalPlayback(soundId, currentSoundId === soundId ? playbackOffsetSeconds : 0);
      await postSoundAction(`/sound/play?id=${encodeURIComponent(soundId)}`);
    }
    poll();
  });

  stopButton?.addEventListener("click", async () => {
    stopLocalPlaybackFully();
    await postSoundAction("/sound/stop");
    poll();
  });

  soundPicker?.addEventListener("change", async () => {
    const soundId = soundPicker.value;
    if (!soundId) return;
    await startLocalPlayback(soundId, 0);
    await postSoundAction(`/sound/play?id=${encodeURIComponent(soundId)}`);
    poll();
  });

  timerPicker?.addEventListener("change", async () => {
    await postSoundAction(`/sound/timer?preset=${encodeURIComponent(timerPicker.value)}`);
    // Don't guess locally - clear any old countdown and let reconcile()
    // pick up Aurora's freshly-resolved value (handles "until alarm",
    // which only Aurora can compute) on the very next poll.
    cancelLocalSleepTimer();
    poll();
  });

  let volumeDebounceHandle = null;
  volumeInput?.addEventListener("input", () => {
    const percent = Number(volumeInput.value);
    setText(`sound-volume-label${idSuffix}`, `${percent}%`);
    setLocalVolume(percent);
    clearTimeout(volumeDebounceHandle);
    volumeDebounceHandle = setTimeout(() => {
      postSoundAction(`/sound/volume?value=${percent}`);
    }, VOLUME_DEBOUNCE_MS);
  });
}

function setupSoundControls() {
  setupSoundControlsFor("");
  setupSoundControlsFor("-lg");
}

// ---------------------------------------------------------------------------
// Local cache - shows the last known state immediately on load, and keeps
// showing it if Aurora becomes unreachable later.
// ---------------------------------------------------------------------------

function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, savedAt: Date.now() }));
  } catch (err) {
    // Storage full/unavailable - not fatal, just no cache for next load.
  }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function formatRelativeTime(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

// ---------------------------------------------------------------------------
// Status line - "Updated Xs ago" while healthy (quiet, low-contrast);
// "Reconnecting…"/"Offline" only after real trouble. A premium display
// shouldn't nag about connectivity, but a persistent freshness indicator
// (v1.1) is different from an error state - it's useful even when nothing
// is wrong.
// ---------------------------------------------------------------------------

let consecutiveFailures = 0;
let lastSuccessAt = null;

function updateStatusLine() {
  const el = byId("status-line");
  const textEl = byId("status-text");
  if (!el || !textEl) return;

  el.classList.remove("state-reconnecting", "state-offline");

  if (consecutiveFailures === 0) {
    textEl.textContent = lastSuccessAt ? `Updated ${formatRelativeTime(lastSuccessAt)}` : "";
    return;
  }

  if (consecutiveFailures < OFFLINE_AFTER_FAILURES) {
    textEl.textContent = "Reconnecting to Aurora…";
    el.classList.add("state-reconnecting");
    return;
  }

  textEl.textContent = lastSuccessAt
    ? `Offline - showing data from ${formatRelativeTime(lastSuccessAt)}`
    : "Offline - no data yet";
  el.classList.add("state-offline");
}

// ---------------------------------------------------------------------------
// Aurora polling
// ---------------------------------------------------------------------------

async function fetchDashboard() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${AURORA_BASE_URL}/dashboard`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Aurora returned HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function poll() {
  try {
    const data = await fetchDashboard();
    consecutiveFailures = 0;
    lastSuccessAt = Date.now();
    saveCache(data);
    renderDashboard(data);
    await ensureSoundLibraryLoaded();
    reconcileSoundMachine(data.soundMachine);
  } catch (err) {
    consecutiveFailures += 1;
  }
  updateStatusLine();
}

function startPolling() {
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Pager - four pages swiped through via native touch scrolling + CSS
// scroll-snap (see .pager/.page in style.css). This just keeps the dot
// indicators in sync with whichever page is currently snapped into view,
// and lets tapping a dot jump there without swiping.
// ---------------------------------------------------------------------------

function setupPager() {
  const pager = byId("pager");
  const dots = Array.from(document.querySelectorAll(".page-dot"));
  if (!pager || dots.length === 0) return;

  const pages = Array.from(pager.children);

  const setActivePage = (index) => {
    dots.forEach((dot, i) => dot.classList.toggle("active", i === index));
  };
  setActivePage(0);

  dots.forEach((dot) => {
    dot.addEventListener("click", () => {
      const page = pages[Number(dot.dataset.page)];
      page?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
    });
  });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          setActivePage(pages.indexOf(entry.target));
        }
      });
    },
    { root: pager, threshold: 0.5 }
  );
  pages.forEach((page) => observer.observe(page));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  // Lays out the card grid immediately, before any cached or live data
  // exists - without this, the six cards would render as one plain
  // full-width column (their static markup has no .card-row wrappers any
  // more; those are only built by applyTileLayout) for a brief moment on
  // first paint, or indefinitely on a fresh install with Aurora
  // unreachable and no cache yet.
  applyTileLayout(DEFAULT_TILE_LAYOUT);

  const cached = loadCache();
  if (cached) {
    renderDashboard(cached.data);
    lastSuccessAt = cached.savedAt;
  }

  setupPager();
  setupSoundControls();
  ensureSoundLibraryLoaded();
  startClock();
  startPolling();
}

document.addEventListener("DOMContentLoaded", init);
