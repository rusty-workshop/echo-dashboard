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

const POLL_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;
const VOLUME_DEBOUNCE_MS = 400;

// After this many consecutive failed polls, the status line switches from
// "reconnecting" to a more visible "offline" state.
const OFFLINE_AFTER_FAILURES = 3;

// Below this and not charging, the battery warning banner shows - matches
// Android's own default low-battery threshold.
const LOW_BATTERY_THRESHOLD = 15;

// Bumped whenever the /dashboard schema changes - an old cached response
// missing a newer field (e.g. soundMachine) would otherwise crash the
// renderer that expects it. A version bump just invalidates the old entry
// instead of trying to migrate it.
const CACHE_KEY = "aurora-dashboard:last-good-response:v5";
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
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  cloud:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 19a4.5 4.5 0 0 1-.5-8.98A6 6 0 0 1 17.6 8.03 4.5 4.5 0 0 1 17 19H6.5z"/></svg>',
  partlyCloudy:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="7" r="3.2"/><path d="M16 2.3v1.2M20.7 7h-1.2M12.9 3.9l.85.85M20.05 3.9l-.85.85" stroke-width="1.6"/><path d="M5.5 20a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 15.5 10.5 4 4 0 0 1 15 20H5.5z"/></svg>',
  rain:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 15a4.5 4.5 0 0 1-.5-8.98A6 6 0 0 1 17.6 4.03 4.5 4.5 0 0 1 17 15H6.5z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/></svg>',
  storm:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 15a4.5 4.5 0 0 1-.5-8.98A6 6 0 0 1 17.6 4.03 4.5 4.5 0 0 1 17 15H6.5z"/><path d="M13 15l-2.5 4h2.5l-1.5 3"/></svg>',
  snow:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 14a4.5 4.5 0 0 1-.5-8.98A6 6 0 0 1 17.6 3.03 4.5 4.5 0 0 1 17 14H6.5z"/><path d="M8 18v4M8 18l-1.5 1.5M8 18l1.5 1.5M12 18v4M12 18l-1.5 1.5M12 18l1.5 1.5M16 18v4M16 18l-1.5 1.5M16 18l1.5 1.5"/></svg>',
  fog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h13M3 12h18M3 16h13M8 20h8"/></svg>',
  battery:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 10v4"/><rect x="5" y="9.5" width="10" height="5" fill="currentColor" stroke="none"/></svg>',
  batteryCharging:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 10v4"/><path d="M12 9l-3 4h3l-1 4 4-5h-3z" fill="currentColor" stroke="none"/></svg>',
  batteryAlert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 10v4"/><path d="M11 9v3M11 15h.01" stroke-width="2.4"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  bellOff:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-9.33-5M6.26 6.26A6 6 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8v2.5M13.73 21a2 2 0 0 1-3.46 0"/><path d="M2 2l20 20"/></svg>',
  calendar:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
  alarm:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M5 3L3 5M19 3l2 2"/></svg>',
  speaker:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 5V4l-5 5H4z"/><path d="M17 8a5 5 0 0 1 0 8M19.5 5.5a9 9 0 0 1 0 13"/></svg>',
  volume:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 5V4l-5 5H4z"/><path d="M17 8a5 5 0 0 1 0 8"/></svg>',
  volumeMuted:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 5V4l-5 5H4z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 5.1A11 11 0 0 1 12 5c7 0 11 7 11 7a13.2 13.2 0 0 1-3.05 3.9M6.5 6.5A13.2 13.2 0 0 0 1 12s4 7 11 7a10.6 10.6 0 0 0 4.24-.87"/><path d="M9.5 9.5a3 3 0 0 0 4.24 4.24"/><path d="M2 2l20 20"/></svg>',
  radar:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5" stroke-width="1.4"/><path d="M12 12L12 4A8 8 0 0 1 18.5 16.8z" fill="currentColor" stroke="none" opacity="0.35"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  alertTriangle:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01" stroke-width="2.4"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 4 13c0-5 4.5-9 11-10 1 6.5-3 11-11 11"/><path d="M4 20c3-2 5.5-4.5 7-8"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a5 5 0 0 0-5 5c0 3.5 5 11 5 11s5-7.5 5-11a5 5 0 0 0-5-5z"/><circle cx="12" cy="7" r="2"/></svg>',
  focus:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
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

/** Same as setIcon, but plays a brief scale+fade "pop" on change - used
 *  just for the weather icon, since a real shape morph between conditions
 *  (sun -> cloud -> rain, ...) isn't practical for a handful of unrelated
 *  SVGs, but an instant swap reads as a jump-cut next to everything else
 *  on this dashboard that eases into its changes. */
function setWeatherIcon(id, iconName) {
  const el = byId(id);
  if (!el || el.dataset.icon === iconName) return;
  el.dataset.icon = iconName;
  el.innerHTML = ICONS[iconName] || "";
  el.classList.remove("icon-pop");
  void el.offsetWidth; // force reflow so the animation restarts cleanly
  el.classList.add("icon-pop");
}

// ---------------------------------------------------------------------------
// Rolling number animation - ties a numeric value's text to a smooth
// count-up/down tween instead of an instant jump-cut (weather temperatures,
// battery %). Reads the element's own currently-*displayed* value as the
// tween's start point, not whatever this function last set it to, so a
// stale/interrupted animation never causes a visible skip.
// ---------------------------------------------------------------------------

const NUMBER_ROLL_DURATION_MS = 650;
const numberRollHandles = new Map(); // elementId -> rAF id, so a re-trigger cancels the prior tween

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Animates [id]'s text between whatever number it currently shows and
 *  [targetValue], appending [suffix] (e.g. "°" or "%") - a plain
 *  instant-set (no tween) the first time, when there's no prior numeric
 *  value to animate from. */
function setRollingNumber(id, targetValue, suffix = "") {
  const el = byId(id);
  if (!el || targetValue == null || Number.isNaN(targetValue)) return;

  const startValue = parseInt(el.textContent, 10);
  if (Number.isNaN(startValue)) {
    el.textContent = `${targetValue}${suffix}`;
    return;
  }
  if (startValue === targetValue) return;

  const existingHandle = numberRollHandles.get(id);
  if (existingHandle) cancelAnimationFrame(existingHandle);

  const startTime = performance.now();
  const step = (now) => {
    const progress = Math.min((now - startTime) / NUMBER_ROLL_DURATION_MS, 1);
    const value = Math.round(startValue + (targetValue - startValue) * easeOutCubic(progress));
    el.textContent = `${value}${suffix}`;
    if (progress < 1) {
      numberRollHandles.set(id, requestAnimationFrame(step));
    } else {
      numberRollHandles.delete(id);
    }
  };
  numberRollHandles.set(id, requestAnimationFrame(step));
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

/** Aurora returns 24-hour "HH:mm" strings; the display uses whichever
 *  format the Settings page's clock-format toggle currently picks (see
 *  clock24h) - kept in sync with the big clock rather than a separate
 *  per-feature choice, so sunrise/sunset/alarm times never disagree with
 *  the clock about which format is "on" right now. */
function formatTimeOfDay(hhmm) {
  if (!hhmm) return null;
  const [hourStr, minuteStr] = hhmm.split(":");
  let hour = parseInt(hourStr, 10);
  if (Number.isNaN(hour)) return hhmm;

  if (clock24h) return `${hourStr.padStart(2, "0")}:${minuteStr}`;

  const period = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minuteStr} ${period}`;
}

// Matches the exact condition strings Aurora's WeatherConditionMapper emits.
const WEATHER_ICON_BY_CONDITION = {
  Clear: "sunny",
  "Partly Cloudy": "partlyCloudy",
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

// One of 8 ambient background treatments - each condition gets its own
// look (see style.css's "Ambient weather backgrounds" section). Night
// wins over a clear sky (stars, not a sun glow) but rain/snow/storm keep
// their own look even after dark - rain is still rain at 2am.
const WEATHER_BG_BY_CONDITION = {
  Clear: "sunny",
  "Partly Cloudy": "partlycloudy",
  Overcast: "clouds",
  Fog: "fog",
  Drizzle: "rain",
  Rain: "rain",
  "Rain Showers": "rain",
  Snow: "snow",
  "Snow Showers": "snow",
  Thunderstorm: "storm",
};

function setWeatherBackground(condition, nightOverride) {
  const el = byId("weather-bg");
  if (!el) return;
  const overrideEffect = computeActiveWeatherBgEffect();
  const name = overrideEffect || (nightOverride ? "night" : WEATHER_BG_BY_CONDITION[condition] || "clouds");
  if (el.dataset.bg === name) return;
  el.dataset.bg = name;
  el.className = `weather-bg weather-bg--${name}`;
}

// ---------------------------------------------------------------------------
// Weather Background override (Settings page) - forces one of the 8
// effects above regardless of the real weather condition, either
// immediately ("on demand") or on a recurring daily schedule. Pure
// localStorage, no Aurora involvement, same reasoning as the theme picker:
// this is a display conceit, not real weather data.
// ---------------------------------------------------------------------------

const WEATHER_BG_EFFECT_LABELS = {
  sunny: "Sunny",
  partlycloudy: "Partly Cloudy",
  clouds: "Overcast",
  fog: "Fog",
  rain: "Rain",
  snow: "Snow",
  storm: "Storm",
  night: "Night",
};

const WEATHER_BG_MANUAL_KEY = "aurora-dashboard:weatherbg-manual";
const WEATHER_BG_SCHEDULE_KEY = "aurora-dashboard:weatherbg-schedule";

/** {effect, expiresAt} | null. expiresAt is an epoch-ms number, or null for
 *  an indefinite override - computed once at activation time (see
 *  computeWeatherBgExpiresAt()) rather than re-derived from a stored
 *  duration on every check, so "rest of day" only has to resolve what
 *  "today" means once. */
let weatherBgManualOverride = null;
try {
  weatherBgManualOverride = JSON.parse(localStorage.getItem(WEATHER_BG_MANUAL_KEY) || "null");
} catch (err) {
  weatherBgManualOverride = null;
}

/** [{id, effect, time: "HH:MM", duration}]. duration is "15"/"30"/"60"/
 *  "120"/"240" (minutes), "restofday" (until local midnight), or
 *  "indefinite" (treated as a full 24h window - see
 *  activeScheduledWeatherBgEffect() - so it's always superseded by the
 *  next real entry rather than genuinely never-ending). */
let weatherBgSchedule = [];
try {
  weatherBgSchedule = JSON.parse(localStorage.getItem(WEATHER_BG_SCHEDULE_KEY) || "[]");
} catch (err) {
  weatherBgSchedule = [];
}

function saveWeatherBgManualOverride() {
  if (weatherBgManualOverride) {
    localStorage.setItem(WEATHER_BG_MANUAL_KEY, JSON.stringify(weatherBgManualOverride));
  } else {
    localStorage.removeItem(WEATHER_BG_MANUAL_KEY);
  }
}

function saveWeatherBgSchedule() {
  localStorage.setItem(WEATHER_BG_SCHEDULE_KEY, JSON.stringify(weatherBgSchedule));
}

/** Resolved once at activation time against "now", rather than stored as a
 *  raw duration - see weatherBgManualOverride's doc comment. */
function computeWeatherBgExpiresAt(duration) {
  if (duration === "indefinite") return null;
  if (duration === "restofday") {
    const nowMinutes = currentMinutesInTimezone(currentTimezone || undefined);
    return Date.now() + (1440 - nowMinutes) * 60 * 1000;
  }
  const minutes = parseInt(duration, 10) || 60;
  return Date.now() + minutes * 60 * 1000;
}

function activateWeatherBgOverride(effect, duration) {
  weatherBgManualOverride = { effect, expiresAt: computeWeatherBgExpiresAt(duration) };
  saveWeatherBgManualOverride();
  if (lastWeatherData) renderWeather(lastWeatherData);
}

function stopWeatherBgOverride() {
  weatherBgManualOverride = null;
  saveWeatherBgManualOverride();
  if (lastWeatherData) renderWeather(lastWeatherData);
}

/** [entries] sorted by time ascending. Each entry is "live" for its own
 *  duration window starting at its time-of-day; on overlap, whichever
 *  entry started most recently wins - same "most recently passed" rule
 *  activeScheduledPhotoId() uses for the wallpaper schedule. Returns null
 *  (meaning "Auto") when no entry's window currently contains "now". */
function activeScheduledWeatherBgEffect() {
  if (weatherBgSchedule.length === 0) return null;
  const nowMinutes = currentMinutesInTimezone(currentTimezone || undefined);
  const sorted = [...weatherBgSchedule].sort((a, b) => minutesFromHHMM(a.time) - minutesFromHHMM(b.time));
  let active = null;
  for (const entry of sorted) {
    const start = minutesFromHHMM(entry.time);
    const windowMinutes =
      entry.duration === "restofday" ? 1440 - start : entry.duration === "indefinite" ? 1440 : parseInt(entry.duration, 10) || 60;
    const end = start + windowMinutes;
    const inWindow = nowMinutes >= start && nowMinutes < end;
    const wrapped = end > 1440 && nowMinutes < end - 1440;
    if (inWindow || wrapped) active = entry;
  }
  return active ? active.effect : null;
}

/** The single source of truth setWeatherBackground() defers to: a live
 *  manual override wins outright (clearing itself here once expired), then
 *  the schedule, then null ("Auto" - follow the real weather as before). */
function computeActiveWeatherBgEffect() {
  if (weatherBgManualOverride) {
    if (weatherBgManualOverride.expiresAt != null && Date.now() >= weatherBgManualOverride.expiresAt) {
      weatherBgManualOverride = null;
      saveWeatherBgManualOverride();
    } else {
      return weatherBgManualOverride.effect;
    }
  }
  return activeScheduledWeatherBgEffect();
}

// ---------------------------------------------------------------------------
// Dashboard wallpaper's accent-color extraction. The rotation itself lives
// further down, next to Ambient Mode's photo-cycling code, since both now
// share the same Aurora photo library - these two helpers (color math) are
// general-purpose enough to stay up here with the rest of the weather/
// accent logic they feed into.
// ---------------------------------------------------------------------------

let wallpaperAccentColor = null; // null = no wallpaper photos configured, weather drives the accent as before

// Settings-page override: force a plain black background instead of
// whatever Aurora's wallpaperMode says, without touching the photo
// library itself - Ambient Mode's own separate photo layer (see
// ambient-photo-a/b below) is entirely unaffected. Pure localStorage,
// same reasoning as the weather background override: a display
// preference, not something Aurora needs to know about.
const WALLPAPER_BLACK_KEY = "aurora-dashboard:wallpaper-black";
let wallpaperForcedBlack = localStorage.getItem(WALLPAPER_BLACK_KEY) === "true";

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / delta) % 6;
        break;
      case g:
        h = (b - r) / delta + 2;
        break;
      default:
        h = (r - g) / delta + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Averages a downsampled draw of [imageEl] and boosts saturation/
 *  lightness to a comfortable UI range - a plain pixel average from a
 *  real photo reads as muddy gray, not a usable accent color. */
function extractWallpaperAccentColor(imageEl) {
  const size = 40;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imageEl, 0, 0, size, size);

  let data;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch (err) {
    return null; // Tainted canvas - shouldn't happen for a same-CORS-policy Aurora fetch.
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue; // skip mostly-transparent pixels
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  if (count === 0) return null;
  r = Math.round(r / count);
  g = Math.round(g / count);
  b = Math.round(b / count);

  const [h, s] = rgbToHsl(r, g, b);
  const [ar, ag, ab] = hslToRgb(h, Math.max(s, 0.5), 0.62);
  return `rgb(${ar}, ${ag}, ${ab})`;
}

// Past this hour (and before NIGHT_WEATHER_OVERRIDE_END_HOUR the next
// morning), the Weather card shows a moon and switches to silver
// regardless of the actual condition - even a clear, 90°+ night shouldn't
// show a bright sun icon. A fixed clock-hour override, not tied to actual
// sunset/sunrise like applyDayNightMode()'s dimming - those are two
// different concerns that just happen to both be about nighttime.
const NIGHT_WEATHER_OVERRIDE_START_HOUR = 20; // 8:00 PM
const NIGHT_WEATHER_OVERRIDE_END_HOUR = 6; // 6:00 AM
const NIGHT_WEATHER_ACCENT = "#c7ccd6"; // silver

function isPastNightWeatherThreshold(timeZone) {
  const hour = currentHourInTimezone(timeZone);
  return hour >= NIGHT_WEATHER_OVERRIDE_START_HOUR || hour < NIGHT_WEATHER_OVERRIDE_END_HOUR;
}

function greetingForHour(hour) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good night";
}

/** Same timezone the clock uses (see currentTimezone below) - so "9pm" in
 *  the greeting means 9pm wherever the phone actually is, not wherever
 *  this display's own system clock happens to be set. */
function currentHourInTimezone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).formatToParts(
    new Date()
  );
  const raw = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
  return Number.isNaN(raw) ? new Date().getHours() : raw;
}

/** Same idea as currentHourInTimezone, but minute-precise - needed to dim/
 *  brighten at the actual sunrise/sunset minute rather than only on the hour. */
function currentMinutesInTimezone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }
  return hour * 60 + minute;
}

function minutesFromHHMM(hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  return hour * 60 + minute;
}

// ---------------------------------------------------------------------------
// Clock - independent of the Aurora poll loop, ticks every second. Also
// refreshes the status line's relative "Updated Xs ago" text on the same
// tick, since that needs to advance even between polls.
//
// Follows wherever Aurora's phone actually is, not just whatever system
// timezone this display happens to be set to: Open-Meteo resolves an IANA
// timezone (e.g. "America/New_York") for whatever coordinate the weather
// request used, Aurora passes it through on WeatherSnapshot, and
// renderWeather() below stores it in currentTimezone. Until the first
// successful weather fetch, currentTimezone is null and Intl.DateTimeFormat
// falls back to this device's own system timezone - the same behavior the
// clock always had before this existed.
// ---------------------------------------------------------------------------

let currentTimezone = null;

// Fallback dim/brighten window, used only until the first successful
// weather fetch provides real sunrise/sunset - same "known data beats a
// guess, but a guess beats nothing" pattern as currentTimezone above.
const NIGHT_MODE_FALLBACK_START_MIN = 21 * 60; // 9:00 PM
const NIGHT_MODE_FALLBACK_END_MIN = 7 * 60; // 7:00 AM

// If Fully Kiosk's JS interface is enabled, these also dim/restore the
// actual hardware backlight, not just this page's own contents - purely
// cosmetic (CSS-only) if it isn't, see applyDayNightMode() below.
const NIGHT_SCREEN_BRIGHTNESS = 20;
const DAY_SCREEN_BRIGHTNESS = 100;

let latestSunrise = null; // "HH:mm", set by renderWeather()
let latestSunset = null;
let isNightMode = null; // null = not yet determined

// Manual nudge on top of the sunrise/sunset schedule (see the Settings
// page's Display section) - shifts both edges of the dim window by the
// same amount, since "darker earlier tonight" naturally also means
// "stay dark later in the morning" for a bedside display, not two
// independently-tuned thresholds.
const DIM_OFFSET_KEY = "aurora-dashboard:dim-offset-minutes";
let dimOffsetMinutes = parseInt(localStorage.getItem(DIM_OFFSET_KEY), 10) || 0;

// Aurora always reports temperature in °F (see WeatherSnapshot on that
// side) - this is purely a display-time conversion, nothing round-trips to
// Aurora in Celsius. Kept as a bare "°" everywhere except the Morning
// Briefing sentence (the one spot that already spelled out a literal "F"),
// matching the dashboard's existing minimalist temperature style.
const TEMP_UNIT_KEY = "aurora-dashboard:temp-unit";
let tempUnit = localStorage.getItem(TEMP_UNIT_KEY) === "C" ? "C" : "F";

function displayTemp(fahrenheit) {
  if (fahrenheit == null) return null;
  return tempUnit === "C" ? Math.round(((fahrenheit - 32) * 5) / 9) : Math.round(fahrenheit);
}

// 24h format skips the AM/PM suffix entirely rather than just switching
// hour12 - see clockTimeParts()/updateClock().
const CLOCK_FORMAT_KEY = "aurora-dashboard:clock-format";
let clock24h = localStorage.getItem(CLOCK_FORMAT_KEY) === "24h";

/**
 * Dims the whole display at night for bedside comfort, brightens it back
 * for the morning - prefers actual sunrise/sunset (accounts for season and
 * latitude) once weather data is in, falls back to a fixed 9pm-7pm window
 * until then. Only touches the DOM/JS bridge on an actual day/night
 * transition, not every tick, so this is cheap to call from updateClock().
 */
function applyDayNightMode() {
  const nowMinutes = currentMinutesInTimezone(currentTimezone || undefined);
  const sunriseMinutes =
    (latestSunrise ? minutesFromHHMM(latestSunrise) : NIGHT_MODE_FALLBACK_END_MIN) + dimOffsetMinutes;
  const sunsetMinutes =
    (latestSunset ? minutesFromHHMM(latestSunset) : NIGHT_MODE_FALLBACK_START_MIN) + dimOffsetMinutes;

  const night = nowMinutes >= sunsetMinutes || nowMinutes < sunriseMinutes;
  if (night === isNightMode) return;
  isNightMode = night;

  document.body.classList.toggle("dimmed", night);

  if (window.fully && typeof window.fully.setScreenBrightness === "function") {
    window.fully.setScreenBrightness(night ? NIGHT_SCREEN_BRIGHTNESS : DAY_SCREEN_BRIGHTNESS);
  }
}

function formatDimOffsetLabel(minutes) {
  if (minutes === 0) return "On time";
  return minutes < 0 ? `${-minutes}m earlier` : `${minutes}m later`;
}

function setupDimOffsetSlider() {
  const slider = byId("dim-offset-slider");
  const label = byId("dim-offset-value");
  if (!slider || !label) return;

  slider.value = String(dimOffsetMinutes);
  label.textContent = formatDimOffsetLabel(dimOffsetMinutes);

  slider.addEventListener("input", () => {
    dimOffsetMinutes = parseInt(slider.value, 10) || 0;
    label.textContent = formatDimOffsetLabel(dimOffsetMinutes);
    localStorage.setItem(DIM_OFFSET_KEY, String(dimOffsetMinutes));
    // applyDayNightMode() normally only acts on an actual night/day
    // transition, not every call - forcing isNightMode back to
    // "undetermined" makes a slider drag take visible effect immediately
    // instead of waiting for the next real sunrise/sunset crossing.
    isNightMode = null;
    applyDayNightMode();
  });
}

// How dark "dimmed" actually gets, as a percentage - separate from
// dimOffsetMinutes above (which controls *when* dimming starts/ends, not
// how dark it goes). 45% matches the value this was hardcoded to before
// this setting existed, so anyone who's never touched the slider sees no
// change (see body.dimmed's var() fallback in style.css).
const DIM_INTENSITY_KEY = "aurora-dashboard:dim-intensity-percent";
let dimIntensityPercent = parseInt(localStorage.getItem(DIM_INTENSITY_KEY), 10) || 45;

function applyDimIntensity() {
  document.documentElement.style.setProperty("--dim-intensity", String(dimIntensityPercent / 100));
}

function setupDimIntensitySlider() {
  const slider = byId("dim-intensity-slider");
  const label = byId("dim-intensity-value");
  if (!slider || !label) return;

  slider.value = String(dimIntensityPercent);
  label.textContent = `${dimIntensityPercent}%`;
  applyDimIntensity();

  slider.addEventListener("input", () => {
    dimIntensityPercent = parseInt(slider.value, 10) || 45;
    label.textContent = `${dimIntensityPercent}%`;
    localStorage.setItem(DIM_INTENSITY_KEY, String(dimIntensityPercent));
    applyDimIntensity();
  });
}

function setupClockFormatSetting() {
  const segmented = byId("clock-format-segmented");
  if (!segmented) return;

  const sync = () => {
    segmented.querySelectorAll(".settings-segment").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.format === (clock24h ? "24h" : "12h"));
    });
  };
  sync();

  segmented.addEventListener("click", (event) => {
    const btn = event.target.closest(".settings-segment");
    if (!btn) return;
    clock24h = btn.dataset.format === "24h";
    localStorage.setItem(CLOCK_FORMAT_KEY, clock24h ? "24h" : "12h");
    sync();
    updateClock();
  });
}

function setupTempUnitSetting() {
  const segmented = byId("temp-unit-segmented");
  if (!segmented) return;

  const sync = () => {
    segmented.querySelectorAll(".settings-segment").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.unit === tempUnit);
    });
  };
  sync();

  segmented.addEventListener("click", (event) => {
    const btn = event.target.closest(".settings-segment");
    if (!btn) return;
    tempUnit = btn.dataset.unit;
    localStorage.setItem(TEMP_UNIT_KEY, tempUnit);
    sync();
    // Re-render from the last-known weather rather than waiting up to 30s
    // for the next poll - same "instant feedback" reasoning as every other
    // Settings control on this page.
    if (lastWeatherData) renderWeather(lastWeatherData);
  });
}

/** Populates the name field from /dashboard's userName on every poll -
 *  skipped while the field is focused so a live poll never overwrites
 *  what's mid-typing (same reasoning as every other "don't clobber active
 *  input" check on this page). */
function renderProfileSettings(data) {
  const input = byId("settings-name-input");
  if (!input || document.activeElement === input) return;
  input.value = data.userName || "";
}

/** Commits on blur, not per keystroke - typing "R", "Ru", "Rus"... would
 *  otherwise fire a POST per character. Empty values are left alone rather
 *  than clearing the name server-side, since SetUserNameRoute rejects a
 *  blank value anyway (see SettingsRoutes.kt). */
function setupProfileSettings() {
  const input = byId("settings-name-input");
  if (!input) return;

  input.addEventListener("blur", () => {
    const value = input.value.trim();
    if (value) postAction(`/settings/name?value=${encodeURIComponent(value)}`);
  });
}

// ---------------------------------------------------------------------------
// Auto-enter Bedside Mode on a schedule - pure localStorage, checked on
// every clock tick (see updateClock()) rather than a separate timer, since
// the clock already ticks every second regardless. Fires at most once per
// calendar day so the matching minute's ~60 ticks don't re-trigger it
// repeatedly, and won't fire again the same night after a manual exit.
// ---------------------------------------------------------------------------

const AUTO_BEDSIDE_ENABLED_KEY = "aurora-dashboard:auto-bedside-enabled";
const AUTO_BEDSIDE_TIME_KEY = "aurora-dashboard:auto-bedside-time";
let autoBedsideEnabled = localStorage.getItem(AUTO_BEDSIDE_ENABLED_KEY) === "true";
let autoBedsideTime = localStorage.getItem(AUTO_BEDSIDE_TIME_KEY) || "22:00";
let autoBedsideLastFiredDateKey = null;

// Whether entering Bedside Mode (manually or automatically) should start
// the rain sound the way it always has - a plain on/off since some people
// want the dimming/DND/brightness-ramp side of Bedside Mode without any
// sound. Defaults on (the original, only) behavior.
const BEDSIDE_AUTO_SOUND_KEY = "aurora-dashboard:bedside-auto-sound";
let bedsideAutoSoundEnabled = localStorage.getItem(BEDSIDE_AUTO_SOUND_KEY) !== "false";

function setupBedsideAutoSoundSetting() {
  const toggle = byId("bedside-auto-sound-toggle");
  if (!toggle) return;

  toggle.setAttribute("aria-checked", String(bedsideAutoSoundEnabled));
  toggle.addEventListener("click", () => {
    bedsideAutoSoundEnabled = !bedsideAutoSoundEnabled;
    toggle.setAttribute("aria-checked", String(bedsideAutoSoundEnabled));
    localStorage.setItem(BEDSIDE_AUTO_SOUND_KEY, String(bedsideAutoSoundEnabled));
  });
}

function maybeAutoEnterBedside() {
  if (!autoBedsideEnabled) return;
  if (document.body.classList.contains("bedside-active")) return;
  if (isAlarmRinging) return;

  const timeZone = currentTimezone || undefined;
  const nowMinutes = currentMinutesInTimezone(timeZone);
  if (nowMinutes !== minutesFromHHMM(autoBedsideTime)) return;

  const dateKey = new Date().toLocaleDateString("en-US", { timeZone });
  if (autoBedsideLastFiredDateKey === dateKey) return;
  autoBedsideLastFiredDateKey = dateKey;
  enterBedsideMode();
}

function setupAutoBedsideSetting() {
  const toggle = byId("auto-bedside-toggle");
  const timeInput = byId("auto-bedside-time");
  if (!toggle || !timeInput) return;

  toggle.setAttribute("aria-checked", String(autoBedsideEnabled));
  timeInput.value = autoBedsideTime;
  timeInput.disabled = !autoBedsideEnabled;

  toggle.addEventListener("click", () => {
    autoBedsideEnabled = !autoBedsideEnabled;
    toggle.setAttribute("aria-checked", String(autoBedsideEnabled));
    timeInput.disabled = !autoBedsideEnabled;
    localStorage.setItem(AUTO_BEDSIDE_ENABLED_KEY, String(autoBedsideEnabled));
  });

  timeInput.addEventListener("change", () => {
    if (!timeInput.value) return;
    autoBedsideTime = timeInput.value;
    localStorage.setItem(AUTO_BEDSIDE_TIME_KEY, autoBedsideTime);
  });
}

// ---------------------------------------------------------------------------
// Sticky notes - short dashboard-only reminders shown on the Overview page,
// one at a time (cycling if there's more than one), until dismissed. Pure
// localStorage, no Aurora involved. Managed from a popover opened via the
// pin icon next to Bedside Mode's trigger (see .hero-panel-actions) rather
// than Settings, since these are meant to be jotted down and cleared in a
// couple of taps, not buried a few screens deep.
// ---------------------------------------------------------------------------

const STICKY_NOTES_KEY = "aurora-dashboard:sticky-notes";
const STICKY_NOTES_DISMISSED_KEY = "aurora-dashboard:sticky-notes-dismissed";
const STICKY_NOTES_MAX = 5;
const STICKY_NOTE_CYCLE_MS = 6000;

let stickyNotes = [];
try {
  stickyNotes = JSON.parse(localStorage.getItem(STICKY_NOTES_KEY) || "[]");
} catch (err) {
  stickyNotes = [];
}

// One-time migration from the old single-note format (a plain string under
// "aurora-dashboard:sticky-note") - only runs if the new list is still
// empty, so it can never clobber notes already added under the new format.
if (stickyNotes.length === 0) {
  const legacyText = (localStorage.getItem("aurora-dashboard:sticky-note") || "").trim();
  if (legacyText) {
    stickyNotes = [{ id: `${Date.now()}`, text: legacyText, addedAt: Date.now() }];
    localStorage.setItem(STICKY_NOTES_KEY, JSON.stringify(stickyNotes));
  }
  localStorage.removeItem("aurora-dashboard:sticky-note");
  localStorage.removeItem("aurora-dashboard:sticky-note-dismissed");
}

let stickyNotesDismissed = localStorage.getItem(STICKY_NOTES_DISMISSED_KEY) === "true";
let stickyNoteCycleIndex = 0;
let stickyNoteCycleHandle = null;

function saveStickyNotes() {
  localStorage.setItem(STICKY_NOTES_KEY, JSON.stringify(stickyNotes));
}

function renderStickyNote() {
  const banner = byId("sticky-note-banner");
  if (!banner) return;
  const show = stickyNotes.length > 0 && !stickyNotesDismissed;
  banner.classList.toggle("hidden", !show);
  if (!show) return;

  if (stickyNoteCycleIndex >= stickyNotes.length) stickyNoteCycleIndex = 0;
  setText("sticky-note-text", stickyNotes[stickyNoteCycleIndex].text);

  const count = byId("sticky-note-count");
  if (count) {
    count.classList.toggle("hidden", stickyNotes.length <= 1);
    count.textContent = `${stickyNoteCycleIndex + 1}/${stickyNotes.length}`;
  }
}

/** Runs continuously (harmless no-op while there's 0-1 notes) rather than
 *  being started/stopped as notes come and go - one fewer piece of state
 *  to keep in sync with stickyNotes.length. */
function startStickyNoteCycle() {
  stickyNoteCycleHandle = setInterval(() => {
    if (stickyNotes.length <= 1) return;
    stickyNoteCycleIndex = (stickyNoteCycleIndex + 1) % stickyNotes.length;
    renderStickyNote();
  }, STICKY_NOTE_CYCLE_MS);
}

function timeAgoLabel(ms) {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function renderStickyNoteList() {
  const list = byId("sticky-note-list");
  if (!list) return;
  if (stickyNotes.length === 0) {
    list.innerHTML = '<div class="sticky-note-empty">No notes yet</div>';
    return;
  }
  list.innerHTML = stickyNotes
    .map(
      (note) => `<div class="sticky-note-item" data-id="${escapeHtml(note.id)}">
        <span class="sticky-note-item-text">${escapeHtml(note.text)}</span>
        <span class="sticky-note-item-time">${escapeHtml(timeAgoLabel(note.addedAt))}</span>
        <button class="sticky-note-item-remove" type="button" aria-label="Delete note">&times;</button>
      </div>`
    )
    .join("");
}

function openStickyNoteEditor() {
  byId("sticky-note-editor")?.classList.remove("hidden");
  byId("sticky-note-editor-backdrop")?.classList.remove("hidden");
  renderStickyNoteList();
  byId("sticky-note-add-input")?.focus();
}

function closeStickyNoteEditor() {
  byId("sticky-note-editor")?.classList.add("hidden");
  byId("sticky-note-editor-backdrop")?.classList.add("hidden");
}

/** Adding a note always un-dismisses the banner (same "any edit clears a
 *  dismissal" rule the single-note version had) and jumps the cycle to
 *  show the note you just wrote, not whatever it happened to be showing. */
function addStickyNote(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  stickyNotes = [...stickyNotes, { id: `${Date.now()}`, text: trimmed, addedAt: Date.now() }].slice(-STICKY_NOTES_MAX);
  saveStickyNotes();
  stickyNotesDismissed = false;
  localStorage.setItem(STICKY_NOTES_DISMISSED_KEY, "false");
  stickyNoteCycleIndex = stickyNotes.length - 1;
  renderStickyNote();
  renderStickyNoteList();
}

function removeStickyNote(id) {
  stickyNotes = stickyNotes.filter((note) => note.id !== id);
  saveStickyNotes();
  if (stickyNoteCycleIndex >= stickyNotes.length) stickyNoteCycleIndex = 0;
  renderStickyNote();
  renderStickyNoteList();
}

function setupStickyNote() {
  setIcon("sticky-note-icon", "pin");
  setIcon("sticky-note-trigger-icon", "pin");
  renderStickyNote();
  startStickyNoteCycle();

  byId("sticky-note-trigger-btn")?.addEventListener("click", openStickyNoteEditor);
  byId("sticky-note-editor-close")?.addEventListener("click", closeStickyNoteEditor);
  byId("sticky-note-editor-backdrop")?.addEventListener("click", closeStickyNoteEditor);

  // Tapping the banner itself also opens the editor - the dedicated pin
  // icon is what makes this discoverable with zero notes, but once a note
  // is showing, tapping straight on it to manage it is the more obvious
  // gesture.
  byId("sticky-note-banner")?.addEventListener("click", (event) => {
    if (event.target.closest(".sticky-note-dismiss")) return;
    openStickyNoteEditor();
  });

  const addInput = byId("sticky-note-add-input");
  const submitNewNote = () => {
    if (!addInput) return;
    addStickyNote(addInput.value);
    addInput.value = "";
    addInput.focus();
  };
  byId("sticky-note-add-btn")?.addEventListener("click", submitNewNote);
  addInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitNewNote();
  });

  byId("sticky-note-list")?.addEventListener("click", (event) => {
    const removeBtn = event.target.closest(".sticky-note-item-remove");
    if (!removeBtn) return;
    const id = removeBtn.closest(".sticky-note-item")?.dataset.id;
    if (id) removeStickyNote(id);
  });

  byId("sticky-note-dismiss")?.addEventListener("click", (event) => {
    event.stopPropagation();
    stickyNotesDismissed = true;
    localStorage.setItem(STICKY_NOTES_DISMISSED_KEY, "true");
    renderStickyNote();
  });
}

// ---------------------------------------------------------------------------
// Reading Mode - dims and warms whichever page is showing without taking
// it over, unlike Bedside/Ambient Mode (no photo cycling, no clock
// takeover, cards stay fully visible). Pure localStorage/CSS, no Aurora
// involved. Entering Bedside or Ambient Mode exits this automatically
// (see enterBedsideMode()/enterAmbientMode()) rather than trying to make
// the three stack sensibly together.
// ---------------------------------------------------------------------------

const READING_MODE_KEY = "aurora-dashboard:reading-mode";
let readingModeActive = localStorage.getItem(READING_MODE_KEY) === "true";

function renderReadingMode() {
  document.body.classList.toggle("reading-mode-active", readingModeActive);
  byId("reading-mode-trigger-btn")?.setAttribute("aria-pressed", String(readingModeActive));
}

function exitReadingMode() {
  if (!readingModeActive) return;
  readingModeActive = false;
  localStorage.setItem(READING_MODE_KEY, "false");
  renderReadingMode();
}

function setupReadingMode() {
  setIcon("reading-mode-trigger-icon", "book");
  renderReadingMode();
  byId("reading-mode-trigger-btn")?.addEventListener("click", () => {
    readingModeActive = !readingModeActive;
    localStorage.setItem(READING_MODE_KEY, String(readingModeActive));
    renderReadingMode();
  });
}

// ---------------------------------------------------------------------------
// Sleep time tracking - logs how long each Bedside Mode session ran, shown
// as a small 7-day chart in Settings. Pure localStorage, no Aurora
// involved - this is purely "how long was Bedside Mode active," not real
// sleep-stage tracking (no sensor to base that on anyway). The session
// start is persisted too, not just held in memory, so a kiosk reload
// mid-session doesn't silently lose that night's data - endSleepSession()
// still needs a real exitBedsideMode() call to actually log it, a reload
// alone just preserves the start time until one happens.
// ---------------------------------------------------------------------------

const SLEEP_SESSIONS_KEY = "aurora-dashboard:sleep-sessions";
const SLEEP_SESSION_START_KEY = "aurora-dashboard:sleep-session-start";
const SLEEP_SESSIONS_MAX = 30;

let sleepSessions = [];
try {
  sleepSessions = JSON.parse(localStorage.getItem(SLEEP_SESSIONS_KEY) || "[]");
} catch (err) {
  sleepSessions = [];
}
let sleepSessionStartAt = Number(localStorage.getItem(SLEEP_SESSION_START_KEY)) || null;

function startSleepSession() {
  sleepSessionStartAt = Date.now();
  localStorage.setItem(SLEEP_SESSION_START_KEY, String(sleepSessionStartAt));
}

function endSleepSession() {
  if (!sleepSessionStartAt) return;
  const durationMinutes = Math.round((Date.now() - sleepSessionStartAt) / 60000);
  if (durationMinutes >= 1) {
    const dateKey = new Date(sleepSessionStartAt).toLocaleDateString("en-CA", { timeZone: currentTimezone || undefined });
    sleepSessions = [...sleepSessions, { date: dateKey, durationMinutes }].slice(-SLEEP_SESSIONS_MAX);
    localStorage.setItem(SLEEP_SESSIONS_KEY, JSON.stringify(sleepSessions));
  }
  sleepSessionStartAt = null;
  localStorage.removeItem(SLEEP_SESSION_START_KEY);
  renderSleepHistory();
}

/** Last 7 calendar days, oldest to newest - multiple sessions landing on
 *  the same night (e.g. exited and re-entered Bedside Mode) sum together
 *  rather than only keeping the last one. */
function renderSleepHistory() {
  const chart = byId("sleep-history-chart");
  if (!chart) return;

  const byDate = new Map();
  sleepSessions.forEach((session) => {
    byDate.set(session.date, (byDate.get(session.date) || 0) + session.durationMinutes);
  });

  const timeZone = currentTimezone || undefined;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const dateKey = d.toLocaleDateString("en-CA", { timeZone });
    const label = d.toLocaleDateString("en-US", { timeZone, weekday: "narrow" });
    days.push({ label, minutes: byDate.get(dateKey) || 0 });
  }

  const maxMinutes = Math.max(600, ...days.map((d) => d.minutes)); // scale to at least 10h
  chart.innerHTML = days
    .map((d) => {
      const heightPct = Math.round((d.minutes / maxMinutes) * 100);
      const hours = Math.floor(d.minutes / 60);
      const mins = d.minutes % 60;
      const title = d.minutes ? `${hours}h ${mins}m` : "No data";
      return `<div class="sleep-bar-col">
          <div class="sleep-bar" style="height:${heightPct}%" title="${escapeHtml(title)}"></div>
          <span class="sleep-bar-label">${escapeHtml(d.label)}</span>
        </div>`;
    })
    .join("");

  const nightsWithData = days.filter((d) => d.minutes > 0);
  const avgMinutes = nightsWithData.length
    ? Math.round(nightsWithData.reduce((sum, d) => sum + d.minutes, 0) / nightsWithData.length)
    : 0;
  setText(
    "sleep-history-avg",
    avgMinutes ? `${Math.floor(avgMinutes / 60)}h ${avgMinutes % 60}m average this week` : "No Bedside Mode sessions yet this week"
  );
}

/** Not part of /dashboard (it only matters on this page, same reasoning as
 *  GET /notifications/apps) - lazily fetched once the first time the
 *  Settings page is scrolled to (see ensureNotificationAppsLoaded()'s
 *  sibling hook in setActivePage()). Aurora itself validates/normalizes
 *  the prefix (see normalizeSubnetPrefix() on that side) - this just shows
 *  whatever comes back. */
let homeNetworkLoaded = false;

async function ensureHomeNetworkLoaded() {
  if (homeNetworkLoaded) return;
  const input = byId("settings-network-input");
  if (!input) return;
  homeNetworkLoaded = true;

  try {
    const response = await fetch(`${AURORA_BASE_URL}/settings/home-network`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (document.activeElement !== input) {
      input.value = (data.prefix || "").replace(/\.$/, "");
    }
  } catch (err) {
    homeNetworkLoaded = false; // allow a retry next time the page is visited
  }
}

/** Commits on blur, same shape as setupProfileSettings() - a malformed
 *  value is silently rejected by SetHomeNetworkRoute (400, no change
 *  applied) rather than validated here too, avoiding two copies of the
 *  same octet-parsing logic. */
function setupHomeNetworkSettings() {
  const input = byId("settings-network-input");
  if (!input) return;

  input.addEventListener("blur", () => {
    const value = input.value.trim();
    if (value) postAction(`/settings/home-network?prefix=${encodeURIComponent(value)}`);
  });
}

function clockTimeParts(now, timeZone) {
  // hourCycle: "h23" (not just hour12: false) - some engines default
  // hour12:false to hourCycle "h24" (1-24), which would show "24:15"
  // instead of "00:15" right after midnight on a bedside clock.
  const options = clock24h
    ? { timeZone, hour: "numeric", minute: "2-digit", hourCycle: "h23" }
    : { timeZone, hour: "numeric", minute: "2-digit", hour12: true };
  const parts = new Intl.DateTimeFormat("en-US", options).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return { hour: get("hour"), minute: get("minute"), period: get("dayPeriod") };
}

function clockDateParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: get("weekday"), month: get("month"), day: get("day") };
}

function updateClock() {
  const now = new Date();
  const timeZone = currentTimezone || undefined; // undefined = Intl's own "use system default"

  const { hour, minute, period } = clockTimeParts(now, timeZone);
  const { weekday, month, day } = clockDateParts(now, timeZone);
  const timeText = clock24h ? `${hour}:${minute}` : `${hour}:${minute} ${period}`;
  const monthdayText = `${month} ${day}`;

  // The clock appears four times - compact on the Morning Overview page,
  // huge on the dedicated Clock/Sound page, huge again in Bedside Mode,
  // and huge (time only, no date) in Ambient Mode - so all four get
  // every tick.
  setText("clock-time", timeText);
  setText("clock-weekday", weekday);
  setText("clock-monthday", monthdayText);
  setText("clock-time-lg", timeText);
  setText("clock-weekday-lg", weekday);
  setText("clock-monthday-lg", monthdayText);
  setText("clock-time-bedside", timeText);
  setText("clock-weekday-bedside", weekday);
  setText("clock-monthday-bedside", monthdayText);
  setText("clock-time-ambient", timeText);
  if (isAlarmRinging) setText("alarm-ringing-time", timeText);

  updateStatusLine();
  applyDayNightMode();
  maybeAutoEnterBedside();

  // Catches a manual override expiring or a schedule window opening/
  // closing between /dashboard polls (every 30s) - setWeatherBackground()
  // itself is a cheap no-op when the resolved effect hasn't changed, so
  // this is fine to re-check every tick rather than adding a second timer.
  // renderWeatherBgActiveHint() keeps the Settings page's "Forcing X
  // until..." line in sync with the same expiry, not just the background
  // layer itself - both a no-op when the Settings page isn't visible.
  if (lastWeatherData) {
    setWeatherBackground(lastWeatherData.condition, isPastNightWeatherThreshold(timeZone));
  }
  renderWeatherBgActiveHint();
  checkQuickDurationExpiry();

  // Last line on purpose (see the watchdog below) - only reached once
  // every render call above has actually run to completion, so it's a
  // real "the clock is genuinely still working" signal, not just "the
  // interval fired."
  lastClockTickAt = Date.now();
}

// ---------------------------------------------------------------------------
// Stale-clock watchdog - this is meant to run 24/7 on a kiosk device that
// nobody's going to notice froze until they're trying to use it. A plain
// setInterval keeps firing on schedule even if one call throws, so this
// isn't guarding against an ordinary one-off exception - it's guarding
// against updateClock() hitting a PERSISTENT broken state (an exception on
// every single call, so nothing after the failure point - including this
// function's own last line - ever runs again) or the WebView/renderer
// itself degrading badly enough that ticks stop landing on schedule. A
// genuinely deadlocked main thread can't run its own watchdog either way
// (this code wouldn't fire), so this is a defense-in-depth layer against
// the survivable failure modes, not a guarantee against every one.
// ---------------------------------------------------------------------------

let lastClockTickAt = Date.now();
const CLOCK_WATCHDOG_STALE_MS = 5 * 60 * 1000;
const CLOCK_WATCHDOG_CHECK_MS = 30 * 1000;

function checkClockWatchdog() {
  if (Date.now() - lastClockTickAt > CLOCK_WATCHDOG_STALE_MS) {
    location.reload();
  }
}

function startClock() {
  updateClock();
  setInterval(checkClockWatchdog, CLOCK_WATCHDOG_CHECK_MS);
  setInterval(updateClock, 1000);
}

// ---------------------------------------------------------------------------
// Moon phase - pure date math, no Aurora involvement (unlike sunrise/sunset,
// which come from Open-Meteo since they depend on location; the lunar cycle
// doesn't). Standard synodic-month approximation against a known new moon,
// good to within about a day either side of an exact phase boundary - fine
// for a glanceable bedside label, not an almanac.
// ---------------------------------------------------------------------------

const MOON_SYNODIC_MONTH_DAYS = 29.530588853;
const MOON_KNOWN_NEW_MOON_UTC = Date.UTC(2000, 0, 6, 18, 14, 0);
const MOON_PHASE_EMOJI = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
const MOON_PHASE_NAMES = [
  "New Moon",
  "Waxing Crescent",
  "First Quarter",
  "Waxing Gibbous",
  "Full Moon",
  "Waning Gibbous",
  "Last Quarter",
  "Waning Crescent",
];

function moonPhaseLabel(date) {
  const daysSinceNew = (date.getTime() - MOON_KNOWN_NEW_MOON_UTC) / 86400000;
  let age = daysSinceNew % MOON_SYNODIC_MONTH_DAYS;
  if (age < 0) age += MOON_SYNODIC_MONTH_DAYS;
  const index = Math.round((age / MOON_SYNODIC_MONTH_DAYS) * 8) % 8;
  return `${MOON_PHASE_EMOJI[index]} ${MOON_PHASE_NAMES[index]}`;
}

// ---------------------------------------------------------------------------
// Rendering - one function per card, each safely no-ops on missing/null
// data, plus the Morning Briefing.
// ---------------------------------------------------------------------------

let lastWeatherData = null;

function renderWeather(weather) {
  lastWeatherData = weather;
  if (!weather) {
    setIcon("weather-icon", "cloud");
    setText("weather-temp", "--°");
    setText("weather-condition", "No data");
    setText("weather-high", "--°");
    setText("weather-low", "--°");
    byId("weather-rain")?.classList.add("hidden");
    setIcon("weather-icon-lg", "cloud");
    setText("weather-temp-lg", "--°");
    setText("weather-condition-lg", "No data");
    setText("weather-high-lg", "--°");
    setText("weather-low-lg", "--°");
    setText("weather-sunrise-lg", "--:--");
    setText("weather-sunset-lg", "--:--");
    byId("weather-rain-lg")?.classList.add("hidden");
    return;
  }

  const nightOverride = isPastNightWeatherThreshold(currentTimezone || undefined);
  const icon = nightOverride ? "moon" : WEATHER_ICON_BY_CONDITION[weather.condition] || "cloud";
  const temp = displayTemp(weather.temperature);
  const high = displayTemp(weather.high);
  const low = displayTemp(weather.low);

  // Weather appears twice - the compact Overview card and the big hero
  // tile on the Daily Info page - so both ids get updated together.
  setWeatherIcon("weather-icon", icon);
  setRollingNumber("weather-temp", temp, "°");
  setText("weather-condition", weather.condition);
  setRollingNumber("weather-high", high, "°");
  setRollingNumber("weather-low", low, "°");

  setWeatherIcon("weather-icon-lg", icon);
  setRollingNumber("weather-temp-lg", temp, "°");
  setText("weather-condition-lg", weather.condition);
  setRollingNumber("weather-high-lg", high, "°");
  setRollingNumber("weather-low-lg", low, "°");
  setText("weather-sunrise-lg", weather.sunrise ? formatTimeOfDay(weather.sunrise) : "--:--");
  setText("weather-sunset-lg", weather.sunset ? formatTimeOfDay(weather.sunset) : "--:--");

  // Same "bring an umbrella" signal the Morning Briefing already surfaces
  // (see renderMorningBriefing) - shown here too since the Weather card is
  // where you'd actually look for it once the briefing's scrolled by.
  const rainText = weather.rainExpectedAt ? `Rain expected ${formatTimeOfDay(weather.rainExpectedAt)}` : "";
  setIcon("weather-rain-icon", "rain");
  setText("weather-rain-text", rainText);
  byId("weather-rain")?.classList.toggle("hidden", !rainText);
  setIcon("weather-rain-icon-lg", "rain");
  setText("weather-rain-text-lg", rainText);
  byId("weather-rain-lg")?.classList.toggle("hidden", !rainText);

  // A set wallpaper wins outright - see showWallpaperPhoto()'s doc
  // comment for why the accent has to follow the wallpaper once one
  // exists, rather than keep chasing the weather.
  if (wallpaperAccentColor) {
    document.documentElement.style.setProperty("--accent", wallpaperAccentColor);
  } else if (nightOverride) {
    document.documentElement.style.setProperty("--accent", NIGHT_WEATHER_ACCENT);
  } else {
    applyAccentColor(weather.condition);
  }
  setWeatherBackground(weather.condition, nightOverride);

  // Drives the clock's timezone too - see the comment above updateClock().
  if (weather.timezone) currentTimezone = weather.timezone;
  // Drives applyDayNightMode()'s dim/brighten thresholds too.
  latestSunrise = weather.sunrise || null;
  latestSunset = weather.sunset || null;
}

// Standard EPA breakpoints - a pure function of the number, so this stays
// client-side rather than Aurora computing and sending a label.
function aqiCategory(aqi) {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

/** Daily Info page only, same as sunrise/sunset - hidden entirely rather
 *  than showing a stale/placeholder reading when Aurora hasn't resolved
 *  one yet (e.g. right after boot, before the first weather refresh). */
function renderAirQuality(weather) {
  const el = byId("weather-aqi-lg");
  if (!el) return;

  const aqi = weather && weather.airQualityIndex;
  if (aqi == null) {
    el.classList.add("hidden");
    return;
  }

  el.classList.remove("hidden");
  setIcon("weather-aqi-icon-lg", "leaf");
  setText("weather-aqi-text-lg", `AQI ${aqi} - ${aqiCategory(aqi)}`);
}

/** Daily Info page only - a single compact line rather than one row per
 *  metric (see .weather-details-lg's comment), and each piece is
 *  independently optional, same "degrade gracefully" reasoning as
 *  everything else on WeatherSnapshot. */
function renderWeatherDetails(weather) {
  const el = byId("weather-details-lg");
  if (!el) return;

  const parts = [];
  if (weather?.feelsLike != null && Math.abs(weather.feelsLike - Math.round(weather.temperature)) >= 3) {
    parts.push(`Feels ${displayTemp(weather.feelsLike)}°`);
  }
  if (weather?.windSpeedMph != null) parts.push(`Wind ${weather.windSpeedMph} mph`);
  if (weather?.humidityPercent != null) parts.push(`Humidity ${weather.humidityPercent}%`);
  if (weather?.uvIndex != null) parts.push(`UV ${weather.uvIndex}`);
  // Only worth a mention above a "might actually matter" threshold - most
  // days sit in the 0-20% range, and showing that every time would just be
  // noise (same reasoning as RAIN_PROBABILITY_THRESHOLD's own umbrella nudge).
  if (weather?.precipitationProbability != null && weather.precipitationProbability >= 20) {
    parts.push(`Rain ${weather.precipitationProbability}%`);
  }

  if (parts.length === 0) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.textContent = parts.join(" · ");
}

/** Today plus the next few days (see WeatherConfig.FORECAST_DAYS on the
 *  Aurora side) - Daily Info page only, same reasoning as the radar panel
 *  for why it doesn't also try to fit in the compact Overview card. */
function renderDailyForecast(weather) {
  const strip = byId("forecast-strip");
  if (!strip) return;

  const days = (weather && weather.dailyForecast) || [];
  if (days.length === 0) {
    strip.classList.add("hidden");
    return;
  }

  strip.classList.remove("hidden");
  strip.innerHTML = days
    .map((day, index) => {
      const label = index === 0 ? "Today" : new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" });
      const icon = WEATHER_ICON_BY_CONDITION[day.condition] || "cloud";
      return `<div class="forecast-day">
          <div class="forecast-day-label">${escapeHtml(label)}</div>
          <span class="icon-slot" data-icon="${icon}">${ICONS[icon] || ""}</span>
          <div class="forecast-day-temps"><b>${displayTemp(day.high)}°</b><span>${displayTemp(day.low)}°</span></div>
        </div>`;
    })
    .join("");
}

const RADAR_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // don't hammer radar.weather.gov every 30s poll
let lastRadarStation = null;
let lastRadarRefreshAt = 0;

/** Fetched directly from radar.weather.gov by the browser, not proxied
 *  through Aurora - an <img src> load isn't subject to CORS (unlike a JS
 *  fetch() reading the response body), so no backend involvement is
 *  needed beyond Aurora resolving which station covers the current
 *  location (see WeatherSnapshot.radarStation). Refreshed at most every
 *  RADAR_REFRESH_INTERVAL_MS regardless of the 30s dashboard poll cadence -
 *  the image is a few hundred KB and the underlying loop only updates
 *  every few minutes anyway, so polling it every 30s would be wasteful.
 *  setupRadar()'s onerror handler (not this function) is what hides the
 *  panel if the image fails to load - see its comment. */
function renderRadar(weather) {
  const panel = byId("panel-radar");
  const img = byId("radar-image");
  if (!panel || !img) return;

  const station = weather && weather.radarStation;
  if (!station) {
    panel.classList.add("hidden");
    lastRadarStation = null;
    return;
  }

  panel.classList.remove("hidden");
  setIcon("radar-title-icon", "radar");

  const now = Date.now();
  const stationChanged = station !== lastRadarStation;
  if (stationChanged || now - lastRadarRefreshAt >= RADAR_REFRESH_INTERVAL_MS) {
    img.src = `https://radar.weather.gov/ridge/standard/${station}_loop.gif?t=${now}`;
    lastRadarStation = station;
    lastRadarRefreshAt = now;
  }
}

/** The Echo Show may have no route to the public internet even when it
 *  can reach Aurora fine over the LAN (or radar.weather.gov itself may be
 *  down) - unlike Aurora going offline, there's no cached fallback for an
 *  image, so a load failure just hides the whole panel rather than
 *  leaving a broken-image glyph on a kiosk display. */
function setupRadar() {
  byId("radar-image")?.addEventListener("error", () => {
    byId("panel-radar")?.classList.add("hidden");
  });
}

/** Ambient Mode's "tiny weather" line - just a plain text summary, not
 *  the full icon/high/low card treatment the other pages use. */
function renderAmbientWeather(weather) {
  setText("ambient-weather", weather ? `${displayTemp(weather.temperature)}° ${weather.condition}` : "");
  setText("ambient-moon", moonPhaseLabel(new Date()));
}

// Cached for maybeShowBedsideBatteryNudge() below, which needs the latest
// reading at the moment Bedside Mode is entered - a one-off check outside
// the regular render cycle, not something renderDashboard() itself drives.
let latestBattery = null;
let latestCharging = false;

function renderBatteryWarning(battery, charging) {
  latestBattery = battery;
  latestCharging = charging;

  const banner = byId("battery-warning");
  if (!banner) return;

  const low = battery < LOW_BATTERY_THRESHOLD && !charging;
  banner.classList.toggle("hidden", !low);
  if (!low) return;

  setIcon("battery-warning-icon", "batteryAlert");
  setText("battery-warning-text", `Phone battery at ${battery}% - plug it in`);
}

// Aurora has no stable alert id (see WeatherAlert.kt - just event/headline/
// severity), so "which alert" is identified by that pair - good enough
// since a genuinely new or updated alert always changes at least one of
// them. Dismissing is per-alert, not "severe alerts in general": once the
// NWS alert changes or clears and a different one (or none) comes in, the
// stored key no longer matches and the banner is free to show again.
const SEVERE_ALERT_DISMISSED_KEY = "aurora-dashboard:severe-alert-dismissed";
let dismissedSevereAlertKey = localStorage.getItem(SEVERE_ALERT_DISMISSED_KEY) || "";
let lastSevereAlert = null;

function severeAlertKey(alert) {
  return alert ? `${alert.event}|${alert.headline}` : "";
}

/** NWS-sourced severe weather alert (see WeatherAlertRepository on the
 *  Aurora side) - shown on both the Overview and Daily Info pages, unlike
 *  most render* functions which only touch one page's worth of ids, since
 *  this needs to be visible no matter which page is currently swiped to. */
function renderSevereAlert(alert) {
  lastSevereAlert = alert;
  const dismissed = Boolean(alert) && severeAlertKey(alert) === dismissedSevereAlertKey;
  const shown = dismissed ? null : alert;

  [
    { banner: "severe-alert-banner", icon: "severe-alert-icon", event: "severe-alert-event", headline: "severe-alert-headline" },
    { banner: "severe-alert-banner-lg", icon: "severe-alert-icon-lg", event: "severe-alert-event-lg", headline: "severe-alert-headline-lg" }
  ].forEach((ids) => {
    const banner = byId(ids.banner);
    if (!banner) return;
    banner.classList.toggle("hidden", !shown);
    if (!shown) return;

    setIcon(ids.icon, "alertTriangle");
    setText(ids.event, shown.event);
    setText(ids.headline, shown.headline);
  });
}

function setupSevereAlertDismiss() {
  ["severe-alert-dismiss", "severe-alert-dismiss-lg"].forEach((id) => {
    byId(id)?.addEventListener("click", () => {
      dismissedSevereAlertKey = severeAlertKey(lastSevereAlert);
      localStorage.setItem(SEVERE_ALERT_DISMISSED_KEY, dismissedSevereAlertKey);
      renderSevereAlert(lastSevereAlert);
    });
  });
}

function renderPhone(battery, charging, chargingEtaMinutes) {
  const icon = charging ? "batteryCharging" : "battery";
  const chargingText = charging ? "Charging" : "Not charging";
  const etaText = charging && chargingEtaMinutes != null ? `Full in ~${formatDuration(chargingEtaMinutes)}` : "";

  // Phone appears twice - the compact Overview card and the big hero tile
  // on the Phone page.
  setIcon("phone-battery-icon", icon);
  setRollingNumber("phone-battery-level", battery, "%");
  setText("phone-charging", chargingText);
  const fillBar = byId("phone-battery-fill");
  if (fillBar) fillBar.style.width = `${battery}%`;
  const eta = byId("phone-charging-eta");
  if (eta) {
    eta.textContent = etaText;
    eta.classList.toggle("hidden", !etaText);
  }

  setIcon("phone-battery-icon-lg", icon);
  setRollingNumber("phone-battery-level-lg", battery, "%");
  setText("phone-charging-lg", chargingText);
  const fillBarLg = byId("phone-battery-fill-lg");
  if (fillBarLg) fillBarLg.style.width = `${battery}%`;
  const etaLg = byId("phone-charging-eta-lg");
  if (etaLg) {
    etaLg.textContent = etaText;
    etaLg.classList.toggle("hidden", !etaText);
  }
}

// Purely a display preference (never sent to Aurora) - persisted so a
// reboot/reload doesn't quietly flip previews back on.
let hideNotificationPreviews = localStorage.getItem("hideNotificationPreviews") === "true";
// Last groups rendered, kept only so toggling privacy can re-render
// instantly instead of waiting for the next poll.
let lastNotificationGroups = null;

function renderNotifications(groups) {
  lastNotificationGroups = groups;
  setIcon("notifications-title-icon", "bell");
  setIcon("notifications-title-icon-lg", "bell");

  // Focus mode hides real content regardless of what groups actually
  // holds - the phone itself is still buzzing normally the whole time,
  // this is purely what the display shows.
  const html = focusModeActive
    ? '<li class="notif-empty">Focus mode - notifications hidden</li>'
    : !groups || groups.length === 0
      ? '<li class="notif-empty">All clear</li>'
      : groups.map(notificationItemHtml).join("");

  // Notifications appears twice - the compact Overview card and the full
  // list on the Phone page - both get the same markup.
  const list = byId("notif-list");
  if (list) list.innerHTML = html;
  const listLg = byId("notif-list-lg");
  if (listLg) listLg.innerHTML = html;
}

/** Icon fetched straight from Aurora (GET /notifications/icon) - fades out
 *  in place rather than collapsing on error, so a missing icon (e.g. the
 *  app was since uninstalled) doesn't throw the row's alignment off. The
 *  preview line is the latest notification's title/text, omitted entirely
 *  for a group that somehow has neither (e.g. a silent/data-only post), or
 *  whenever the privacy toggle is on - count and app name still show either
 *  way, since those aren't the sensitive part. */
function notificationItemHtml(group) {
  const iconUrl = `${AURORA_BASE_URL}/notifications/icon?package=${encodeURIComponent(group.packageName)}`;
  const preview = [group.latestTitle, group.latestText].filter(Boolean).join(" — ");
  const previewHtml =
    preview && !hideNotificationPreviews ? `<div class="notif-preview">${escapeHtml(preview)}</div>` : "";
  return `<li class="notif-item">
      <img class="notif-icon" src="${iconUrl}" alt="" onerror="this.style.opacity='0'" />
      <div class="notif-item-main">
        <div class="notif-item-header">
          <span class="notif-app">${escapeHtml(group.app)}</span>
          <span class="notif-count">${group.count}</span>
        </div>
        ${previewHtml}
      </div>
    </li>`;
}

/** Toggles whether notification previews (title/text) render at all - just
 *  a local display preference, nothing to tell Aurora about. Re-renders
 *  immediately from the last-known groups so the effect is instant rather
 *  than waiting for the next poll. */
function renderPrivacyToggle() {
  ["privacy-toggle-btn", "privacy-toggle-btn-lg"].forEach((id) => {
    byId(id)?.classList.toggle("dnd-active", hideNotificationPreviews);
    byId(id)?.setAttribute("aria-pressed", String(hideNotificationPreviews));
  });
  setIcon("privacy-toggle-icon", hideNotificationPreviews ? "eyeOff" : "eye");
  setIcon("privacy-toggle-icon-lg", hideNotificationPreviews ? "eyeOff" : "eye");
}

function setupPrivacyToggle() {
  renderPrivacyToggle();
  const toggle = () => {
    hideNotificationPreviews = !hideNotificationPreviews;
    localStorage.setItem("hideNotificationPreviews", String(hideNotificationPreviews));
    renderPrivacyToggle();
    renderNotifications(lastNotificationGroups);
  };
  byId("privacy-toggle-btn")?.addEventListener("click", toggle);
  byId("privacy-toggle-btn-lg")?.addEventListener("click", toggle);
}

/**
 * "Clear All" dismisses every notification on the phone, the same as
 * swiping them from the notification shade - a real, immediate action on
 * the phone, not just clearing this display's own count. Shown on both
 * the compact Overview card and the dedicated Phone page's full panel -
 * the icon-only button is small enough to fit at any tile size.
 */
function setupNotificationClearButtons() {
  setIcon("notif-clear-icon", "trash");
  setIcon("notif-clear-icon-lg", "trash");

  const clearAll = () => postAction("/notifications/clear").then(poll);
  byId("notif-clear-btn")?.addEventListener("click", clearAll);
  byId("notif-clear-btn-lg")?.addEventListener("click", clearAll);
}

/** Settings page only - the full "every app that's ever notified, with a
 *  switch" list, GET /notifications/apps rather than folded into the
 *  regular /dashboard poll since it only matters here (see
 *  KnownNotificationAppsRoute's doc comment on the Aurora side). Loaded
 *  once, lazily, the first time the Settings page is actually scrolled to
 *  (see setActivePage() in setupPager()) - re-fetched on every visit after
 *  that isn't needed since a toggle here already updates its own row
 *  optimistically. */
let notificationAppsLoaded = false;

function notificationAppRowHtml(app) {
  const iconUrl = `${AURORA_BASE_URL}/notifications/icon?package=${encodeURIComponent(app.packageName)}`;
  const shown = !app.blocked;
  return `<div class="settings-app-row" data-package="${escapeHtml(app.packageName)}">
      <img class="settings-app-icon" src="${iconUrl}" alt="" onerror="this.style.opacity='0'" />
      <span class="settings-app-label">${escapeHtml(app.label)}</span>
      <button class="settings-switch" role="switch" aria-checked="${shown}" aria-label="Show ${escapeHtml(app.label)} notifications"></button>
    </div>`;
}

async function ensureNotificationAppsLoaded() {
  if (notificationAppsLoaded) return;
  const list = byId("settings-app-list");
  if (!list) return;
  notificationAppsLoaded = true;

  try {
    const response = await fetch(`${AURORA_BASE_URL}/notifications/apps`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const apps = await response.json();
    list.innerHTML =
      apps.length === 0
        ? '<div class="settings-app-empty">No apps have posted notifications yet</div>'
        : apps.map(notificationAppRowHtml).join("");
  } catch (err) {
    notificationAppsLoaded = false; // allow a retry next time the page is visited
  }
}

function setupNotificationAppToggles() {
  const list = byId("settings-app-list");
  if (!list) return;

  list.addEventListener("click", (event) => {
    const button = event.target.closest(".settings-switch");
    if (!button) return;
    const row = button.closest(".settings-app-row");
    const packageName = row?.dataset.package;
    if (!packageName) return;

    const nowShown = button.getAttribute("aria-checked") !== "true";
    button.setAttribute("aria-checked", String(nowShown));
    postAction(
      `/notifications/block?package=${encodeURIComponent(packageName)}&blocked=${!nowShown}`
    ).then(poll);
  });
}

/** Reflects the phone's actual Do Not Disturb state (see dndEnabled in
 *  the /dashboard response) - swaps the bell icon and a persistent accent
 *  tint, not just a momentary press effect. */
function renderDnd(dndEnabled) {
  ["dnd-toggle-btn", "dnd-toggle-btn-lg"].forEach((id) => {
    byId(id)?.classList.toggle("dnd-active", dndEnabled);
    byId(id)?.setAttribute("aria-pressed", String(dndEnabled));
  });
  setIcon("dnd-toggle-icon", dndEnabled ? "bellOff" : "bell");
  setIcon("dnd-toggle-icon-lg", dndEnabled ? "bellOff" : "bell");
}

let latestDndEnabled = false;

// ---------------------------------------------------------------------------
// Quick-duration popover (shared by DND and Focus mode) - both need the
// same "pick how long, a dashboard-side timer flips it back off
// automatically" shape, so both grew out of one small popover instead of
// two near-identical ones. Turning DND/Focus *off* stays a single
// instant tap on the same button, same as before - the popover only
// appears when turning one *on*, where "how long" is a real decision.
// ---------------------------------------------------------------------------

const DND_AUTO_OFF_KEY = "aurora-dashboard:dnd-auto-off-at";
let dndAutoOffAt = Number(localStorage.getItem(DND_AUTO_OFF_KEY)) || null;

const FOCUS_ACTIVE_KEY = "aurora-dashboard:focus-active";
const FOCUS_AUTO_OFF_KEY = "aurora-dashboard:focus-auto-off-at";
let focusModeActive = localStorage.getItem(FOCUS_ACTIVE_KEY) === "true";
let focusAutoOffAt = Number(localStorage.getItem(FOCUS_AUTO_OFF_KEY)) || null;

/** "Until morning" resolves off the Bedside Mode auto-schedule (see
 *  autoBedsideTime/autoBedsideEnabled) plus a flat 8-hour sleep offset,
 *  not literally "whenever the next wake alarm fires" - wake alarms are
 *  their own independently-editable list, not a single canonical "the"
 *  wake time to anchor to. Falls back to a flat 7:00 AM when no bedtime
 *  is set at all. */
function untilMorningHHMM() {
  if (!autoBedsideEnabled) return "07:00";
  const wakeMinutes = (minutesFromHHMM(autoBedsideTime) + 8 * 60) % 1440;
  return `${String(Math.floor(wakeMinutes / 60)).padStart(2, "0")}:${String(wakeMinutes % 60).padStart(2, "0")}`;
}

function untilMorningEpoch() {
  const targetMinutes = minutesFromHHMM(untilMorningHHMM());
  const nowMinutes = currentMinutesInTimezone(currentTimezone || undefined);
  const minutesUntil = targetMinutes > nowMinutes ? targetMinutes - nowMinutes : 1440 - nowMinutes + targetMinutes;
  return Date.now() + minutesUntil * 60 * 1000;
}

function closeQuickDurationPopover() {
  byId("quick-duration-popover")?.classList.add("hidden");
  byId("quick-duration-backdrop")?.classList.add("hidden");
}

function activateDnd(autoOffAt) {
  dndAutoOffAt = autoOffAt;
  if (autoOffAt) localStorage.setItem(DND_AUTO_OFF_KEY, String(autoOffAt));
  else localStorage.removeItem(DND_AUTO_OFF_KEY);
  postAction("/dnd/set?enabled=true").then(poll);
  closeQuickDurationPopover();
}

function deactivateDnd() {
  dndAutoOffAt = null;
  localStorage.removeItem(DND_AUTO_OFF_KEY);
  postAction("/dnd/set?enabled=false").then(poll);
}

function openDndPopover() {
  setText("quick-duration-title", "Do Not Disturb");
  const options = byId("quick-duration-options");
  if (!options) return;
  options.innerHTML = `
    <button class="quick-duration-option" type="button" data-action="dnd-indefinite">Indefinite</button>
    <button class="quick-duration-option" type="button" data-action="dnd-1h">1 hour</button>
    <button class="quick-duration-option" type="button" data-action="dnd-morning">Until ${escapeHtml(formatTimeOfDay(untilMorningHHMM()))}</button>
    <button class="quick-duration-option quick-duration-cancel" type="button" data-action="close">Cancel</button>
  `;
  byId("quick-duration-popover")?.classList.remove("hidden");
  byId("quick-duration-backdrop")?.classList.remove("hidden");
}

/** Dashboard-only "hide notification content from the display" - not a
 *  real phone mute, the phone still buzzes/rings exactly as normal. See
 *  renderNotifications()'s focusModeActive check for the actual hiding. */
function activateFocus(minutes) {
  focusModeActive = true;
  focusAutoOffAt = Date.now() + minutes * 60 * 1000;
  localStorage.setItem(FOCUS_ACTIVE_KEY, "true");
  localStorage.setItem(FOCUS_AUTO_OFF_KEY, String(focusAutoOffAt));
  renderFocusToggle();
  renderNotifications(lastNotificationGroups);
  closeQuickDurationPopover();
}

function deactivateFocus() {
  focusModeActive = false;
  focusAutoOffAt = null;
  localStorage.setItem(FOCUS_ACTIVE_KEY, "false");
  localStorage.removeItem(FOCUS_AUTO_OFF_KEY);
  renderFocusToggle();
  renderNotifications(lastNotificationGroups);
}

function openFocusPopover() {
  setText("quick-duration-title", "Focus Mode");
  const options = byId("quick-duration-options");
  if (!options) return;
  options.innerHTML = `
    <button class="quick-duration-option" type="button" data-action="focus-30">30 minutes</button>
    <button class="quick-duration-option" type="button" data-action="focus-1h">1 hour</button>
    <button class="quick-duration-option" type="button" data-action="focus-2h">2 hours</button>
    <button class="quick-duration-option quick-duration-cancel" type="button" data-action="close">Cancel</button>
  `;
  byId("quick-duration-popover")?.classList.remove("hidden");
  byId("quick-duration-backdrop")?.classList.remove("hidden");
}

function renderFocusToggle() {
  ["focus-toggle-btn", "focus-toggle-btn-lg"].forEach((id) => {
    byId(id)?.classList.toggle("dnd-active", focusModeActive);
    byId(id)?.setAttribute("aria-pressed", String(focusModeActive));
  });
}

function setupQuickDurationPopover() {
  byId("quick-duration-close")?.addEventListener("click", closeQuickDurationPopover);
  byId("quick-duration-backdrop")?.addEventListener("click", closeQuickDurationPopover);

  byId("quick-duration-options")?.addEventListener("click", (event) => {
    const btn = event.target.closest(".quick-duration-option");
    if (!btn) return;
    switch (btn.dataset.action) {
      case "dnd-indefinite":
        activateDnd(null);
        break;
      case "dnd-1h":
        activateDnd(Date.now() + 60 * 60 * 1000);
        break;
      case "dnd-morning":
        activateDnd(untilMorningEpoch());
        break;
      case "focus-30":
        activateFocus(30);
        break;
      case "focus-1h":
        activateFocus(60);
        break;
      case "focus-2h":
        activateFocus(120);
        break;
      default:
        closeQuickDurationPopover();
    }
  });

  renderFocusToggle();
  setIcon("focus-toggle-icon", "focus");
  setIcon("focus-toggle-icon-lg", "focus");

  const toggleFocus = () => (focusModeActive ? deactivateFocus() : openFocusPopover());
  byId("focus-toggle-btn")?.addEventListener("click", toggleFocus);
  byId("focus-toggle-btn-lg")?.addEventListener("click", toggleFocus);
}

/** Checked every clock tick (see updateClock()) - catches a DND/Focus
 *  preset expiring between /dashboard polls, same pattern as the weather
 *  background override's own expiry check. */
function checkQuickDurationExpiry() {
  if (dndAutoOffAt && Date.now() >= dndAutoOffAt) deactivateDnd();
  if (focusAutoOffAt && Date.now() >= focusAutoOffAt) deactivateFocus();
}

/** Tapping DND toggles off the *current known* state instantly, same as
 *  before, but only when it's already on - turning it on now opens the
 *  duration popover instead of enabling indefinitely outright, since
 *  "how long" is worth a beat of intentionality for something that
 *  silences real phone calls. The next poll always corrects the visual
 *  state if Aurora's actual state ends up different (e.g. DND flipped
 *  manually on the phone itself). */
function setupDndToggle() {
  const toggle = () => (latestDndEnabled ? deactivateDnd() : openDndPopover());
  byId("dnd-toggle-btn")?.addEventListener("click", toggle);
  byId("dnd-toggle-btn-lg")?.addEventListener("click", toggle);
}

function renderSchedule(events, showsTomorrow) {
  setIcon("schedule-title-icon", "calendar");
  setIcon("schedule-title-icon-lg", "calendar");

  const titleText = showsTomorrow ? "Tomorrow's Schedule" : "Today's Schedule";
  setText("schedule-title-text", titleText);
  setText("schedule-title-text-lg", titleText);

  const html =
    !events || events.length === 0
      ? '<li class="schedule-empty">No events</li>'
      : events
          .map((event) => {
            const time = escapeHtml(event.allDay ? "All day" : formatTimeOfDay(event.start));
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

// ---------------------------------------------------------------------------
// Week view - a popover glance at the next 7 days (see weekCalendar in the
// /dashboard response, Aurora's CalendarRepository.getWeekEvents), opened
// from the new calendar icon on the Schedule card. Independent of
// renderSchedule()'s own today-or-tomorrow window above.
// ---------------------------------------------------------------------------

let lastWeekCalendar = [];

/** yyyy-MM-dd, built from local Y/M/D directly rather than through
 *  Date's own ISO-string parsing (`new Date("yyyy-MM-dd")` parses as UTC
 *  midnight, which can format one day off in a timezone-aware
 *  toLocaleDateString call) - Aurora computes each day's date the same
 *  local-calendar way on its own end, so this keeps both sides looking
 *  at the same day with no timezone math needed at all. */
function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderWeekView() {
  const container = byId("week-view-days");
  if (!container) return;
  const todayKey = localDateKey(new Date());

  container.innerHTML = lastWeekCalendar
    .map((day) => {
      const [year, month, dayOfMonth] = day.date.split("-").map(Number);
      const localDate = new Date(year, month - 1, dayOfMonth);
      const isToday = day.date === todayKey;
      const weekdayLabel = isToday ? "Today" : localDate.toLocaleDateString("en-US", { weekday: "long" });
      const monthDayLabel = localDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

      const eventsHtml =
        !day.events || day.events.length === 0
          ? '<div class="week-view-empty">No events</div>'
          : day.events
              .map((event) => {
                const time = event.allDay ? "All day" : formatTimeOfDay(event.start);
                return `<div class="week-view-event">
                  <span class="week-view-event-time">${escapeHtml(time)}</span>
                  <span>${escapeHtml(event.title || "Untitled")}</span>
                </div>`;
              })
              .join("");

      return `<div class="week-view-day${isToday ? " is-today" : ""}">
          <div class="week-view-day-header">
            <span>${escapeHtml(weekdayLabel)}</span>
            <span class="week-view-day-date">${escapeHtml(monthDayLabel)}</span>
          </div>
          ${eventsHtml}
        </div>`;
    })
    .join("");
}

function openWeekView() {
  renderWeekView();
  byId("week-view-popover")?.classList.remove("hidden");
  byId("week-view-backdrop")?.classList.remove("hidden");
}

function closeWeekView() {
  byId("week-view-popover")?.classList.add("hidden");
  byId("week-view-backdrop")?.classList.add("hidden");
}

function setupWeekView() {
  setIcon("week-view-trigger-icon", "calendar");
  byId("week-view-trigger-btn")?.addEventListener("click", openWeekView);
  byId("week-view-close")?.addEventListener("click", closeWeekView);
  byId("week-view-backdrop")?.addEventListener("click", closeWeekView);
}

/** The same today/tomorrow-aware first-event field the Morning Briefing
 *  reads (see renderMorningBriefing()) - in the common case Bedside Mode
 *  is used at night, when calendarShowsTomorrow is already true, so this
 *  naturally shows tomorrow's first event without a separate backend
 *  field. */
function renderBedsideTomorrow(data) {
  const el = byId("bedside-tomorrow");
  if (!el) return;
  const firstEvent = data.calendar && data.calendar.length > 0 ? data.calendar[0] : null;
  if (!firstEvent) {
    el.textContent = "";
    return;
  }
  const dayWord = data.calendarShowsTomorrow ? "Tomorrow" : "Today";
  const time = firstEvent.allDay ? "all day" : formatTimeOfDay(firstEvent.start);
  el.textContent = `${dayWord}: ${firstEvent.title || "Untitled"} at ${time}`;
}

function renderAlarm(nextAlarm) {
  const text = nextAlarm ? formatTimeOfDay(nextAlarm.time) : "No alarm";

  // Alarm appears three times - the compact Overview card, the inline
  // line under the clock on the Clock/Sound page, and again in Bedside
  // Mode.
  setIcon("alarm-title-icon", "alarm");
  setText("alarm-time", text);
  setIcon("alarm-title-icon-lg", "alarm");
  setText("alarm-time-lg", text);
  setIcon("alarm-title-icon-bedside", "alarm");
  setText("alarm-time-bedside", text);
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

// Sound Machine appears three times - the compact Overview card, the full
// control panel on the Clock/Sound page, and again in Bedside Mode - all
// three sets of controls get updated together so any of them reflects
// reality regardless of which one was used to change it.
const SOUND_MACHINE_ID_SUFFIXES = ["", "-lg", "-bedside"];

function renderSoundMachine(state) {
  // Defensive against a missing/malformed field - e.g. an old cached
  // /dashboard response from before this field existed. CACHE_KEY is
  // versioned to avoid this in practice, but a render function shouldn't
  // throw and abort the rest of the page over one bad field either way.
  if (!state) {
    SOUND_MACHINE_ID_SUFFIXES.forEach((suffix) => {
      setIcon(`sound-icon${suffix}`, "speaker");
      setText(`sound-name${suffix}`, "Off");
    });
    return;
  }

  const nameText = state.sound
    ? state.sound + (state.sleepTimerMinutes != null ? ` · ${state.sleepTimerMinutes} min left` : "")
    : "Off";
  const playPauseIcon = state.playing ? "pause" : "play";
  const playPauseLabel = state.playing ? "Pause" : "Play";

  SOUND_MACHINE_ID_SUFFIXES.forEach((suffix) => {
    setIcon(`sound-icon${suffix}`, "speaker");
    setText(`sound-name${suffix}`, nameText);
    setIcon(`sound-play-pause-icon${suffix}`, playPauseIcon);
    byId(`sound-play-pause${suffix}`)?.setAttribute("aria-label", playPauseLabel);
    setIcon(`sound-stop-icon${suffix}`, "stop");
    setIcon(`volume-icon${suffix}`, state.volume === 0 ? "volumeMuted" : "volume");
    syncRangeInputIfIdle(`sound-volume${suffix}`, state.volume);
    setText(`sound-volume-label${suffix}`, `${state.volume}%`);
    syncPickerIfIdle(`sound-picker${suffix}`, state.sound);
  });
  renderRecentSounds();
}

/** null if [minutesUntil] is negative or unknown - "in 45 min" / "in 3
 *  hrs" otherwise. Rounds to the hour past 60 minutes out; nobody needs
 *  "in 3 hrs 12 min" at a glance. */
function formatCountdown(minutesUntil) {
  if (minutesUntil == null || minutesUntil < 0) return null;
  if (minutesUntil < 1) return "now";
  if (minutesUntil < 60) return `in ${minutesUntil} min`;
  const hours = Math.round(minutesUntil / 60);
  return `in ${hours} hr${hours === 1 ? "" : "s"}`;
}

/** Bare duration, no "in"/"until" framing - "45 min" / "2 hrs" - for
 *  slotting into a sentence that already supplies its own preposition
 *  (e.g. "Full in ~${formatDuration(...)}"). */
function formatDuration(minutes) {
  if (minutes == null || minutes < 0) return null;
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr${hours === 1 ? "" : "s"}`;
}

/**
 * A genuine at-a-glance summary, not a restatement of the cards sitting
 * right below it - dropped the old notification-count/battery clause
 * entirely (already on the Phone/Notifications cards, and battery has its
 * own dedicated low-battery banner for when it's actually worth flagging).
 * Weather gets an umbrella heads-up when rain's actually forecast, and
 * the first event shows a countdown instead of a flat clock time - both
 * are things you'd otherwise have to compute yourself.
 */
function renderMorningBriefing(data) {
  const hour = currentHourInTimezone(currentTimezone || undefined);
  const greeting = greetingForHour(hour);
  setText("briefing-greeting", data.userName ? `${greeting}, ${data.userName}.` : `${greeting}.`);

  const weather = data.weather;
  let weatherLine = "Weather data isn't available yet.";
  if (weather) {
    weatherLine = `${displayTemp(weather.temperature)}°${tempUnit} and ${weather.condition.toLowerCase()}, reaching ${displayTemp(weather.high)}° today.`;
    if (weather.rainExpectedAt) {
      weatherLine += ` Bring an umbrella - rain expected around ${formatTimeOfDay(weather.rainExpectedAt)}.`;
    }
  }
  setText("briefing-weather", weatherLine);

  const firstEvent = data.calendar && data.calendar.length > 0 ? data.calendar[0] : null;
  const dayWord = data.calendarShowsTomorrow ? "tomorrow" : "today";
  let eventLine = `No events ${dayWord}`;
  if (firstEvent && firstEvent.allDay) {
    eventLine = `${firstEvent.title} - all day ${dayWord}`;
  } else if (firstEvent) {
    const nowMinutes = currentMinutesInTimezone(currentTimezone || undefined);
    const eventMinutes = minutesFromHHMM(firstEvent.start);
    const minutesUntil = data.calendarShowsTomorrow ? 24 * 60 - nowMinutes + eventMinutes : eventMinutes - nowMinutes;
    const countdown = formatCountdown(minutesUntil);
    eventLine = countdown ? `${firstEvent.title} ${countdown}` : `${firstEvent.title} at ${formatTimeOfDay(firstEvent.start)}`;
  }
  setText("briefing-summary", eventLine);
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
    // flex-basis: 0 forces each row's/card's share of the grid to come
    // purely from its flex-grow ratio, not its content's natural size -
    // without this, a row with unusually tall content (e.g. today's
    // notification list) can claim more than its fair share and push
    // later rows past the page's clipped height, since flex-shrink
    // pulling a content-sized item back down isn't reliably supported by
    // the Echo Show's WebView across this many nested flex levels.
    row.style.flexGrow = String(Math.max(...rowTiles.map((tile) => TILE_SIZE_WEIGHT[tile.size] ?? 1)));
    row.style.flexBasis = "0";

    rowTiles.forEach((tile, indexInRow) => {
      const card = cardElements[tile.id];
      card.style.flexGrow = String(TILE_SIZE_WEIGHT[tile.size] ?? 1);
      card.style.flexBasis = "0";
      card.style.animationDelay = `${(i + indexInRow) * 40}ms`;
      row.appendChild(card);
    });

    grid.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Dashboard Layout settings (Settings page) - the write side of the same
// `layout` field applyTileLayout() above already reads every poll. See
// LayoutRepository/TileConfig on the Aurora side (POST /layout).
// ---------------------------------------------------------------------------

const TILE_LABELS = {
  weather: "Weather",
  phone: "Phone",
  notifications: "Notifications",
  schedule: "Today's Schedule",
  alarm: "Next Alarm",
  sound: "Sound Machine",
};

let lastLayoutTiles = null;

function layoutRowHtml(tile, index, tiles) {
  const label = TILE_LABELS[tile.id] || tile.id;
  const sizes = ["small", "medium", "large"];
  const sizeButtons = sizes
    .map(
      (size) =>
        `<button class="settings-size-btn${tile.size === size ? " active" : ""}" type="button" data-size="${size}">${size[0].toUpperCase()}</button>`
    )
    .join("");
  return `<div class="settings-layout-row" data-tile-id="${tile.id}">
      <span class="settings-app-label">${escapeHtml(label)}</span>
      <div class="settings-size-segmented">${sizeButtons}</div>
      <button class="settings-reorder-btn" type="button" data-dir="up" aria-label="Move ${escapeHtml(label)} up"${index === 0 ? " disabled" : ""}>&uarr;</button>
      <button class="settings-reorder-btn" type="button" data-dir="down" aria-label="Move ${escapeHtml(label)} down"${index === tiles.length - 1 ? " disabled" : ""}>&darr;</button>
      <button class="settings-switch" role="switch" aria-checked="${tile.visible}" aria-label="Show ${escapeHtml(label)} tile"></button>
    </div>`;
}

function renderLayoutSettings(data) {
  const list = byId("settings-layout-list");
  if (!list) return;
  const tiles = data.layout && data.layout.length > 0 ? data.layout : DEFAULT_TILE_LAYOUT;
  lastLayoutTiles = tiles;
  list.innerHTML = tiles.map(layoutRowHtml).join("");
}

async function postLayoutUpdate(tiles) {
  lastLayoutTiles = tiles;
  renderLayoutSettings({ layout: tiles });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetch(`${AURORA_BASE_URL}/layout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tiles),
      signal: controller.signal,
    });
  } catch (err) {
    // Best-effort, same reasoning as postAction().
  } finally {
    clearTimeout(timeout);
  }
  poll(); // also re-applies the layout to the actual Overview grid
}

function setupLayoutSettings() {
  const list = byId("settings-layout-list");
  if (!list) return;

  list.addEventListener("click", (event) => {
    if (!lastLayoutTiles) return;
    const row = event.target.closest(".settings-layout-row");
    if (!row) return;
    const index = lastLayoutTiles.findIndex((t) => t.id === row.dataset.tileId);
    if (index === -1) return;

    const sizeBtn = event.target.closest(".settings-size-btn");
    const reorderBtn = event.target.closest(".settings-reorder-btn");
    const switchBtn = event.target.closest(".settings-switch");

    const tiles = lastLayoutTiles.map((t) => ({ ...t }));
    if (sizeBtn) {
      tiles[index].size = sizeBtn.dataset.size;
    } else if (reorderBtn) {
      const swapWith = reorderBtn.dataset.dir === "up" ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= tiles.length) return;
      [tiles[index], tiles[swapWith]] = [tiles[swapWith], tiles[index]];
    } else if (switchBtn) {
      tiles[index].visible = !tiles[index].visible;
    } else {
      return;
    }

    postLayoutUpdate(tiles);
  });
}

function renderDashboard(data) {
  applyTileLayout(data.layout && data.layout.length > 0 ? data.layout : DEFAULT_TILE_LAYOUT);
  renderLayoutSettings(data);
  renderMorningBriefing(data);
  renderProfileSettings(data);
  renderWeather(data.weather);
  renderRadar(data.weather);
  renderAirQuality(data.weather);
  renderWeatherDetails(data.weather);
  renderDailyForecast(data.weather);
  renderAmbientWeather(data.weather);
  renderPhone(data.battery, data.charging, data.chargingEtaMinutes);
  renderBatteryWarning(data.battery, data.charging);
  renderSevereAlert(data.weatherAlert);
  renderNotifications(data.notificationGroups);
  latestDndEnabled = data.dndEnabled;
  renderDnd(data.dndEnabled);
  renderSchedule(data.calendar, data.calendarShowsTomorrow);
  lastWeekCalendar = data.weekCalendar || [];
  renderBedsideTomorrow(data);
  renderAlarm(data.nextAlarm);
  renderSoundMachine(data.soundMachine);
  renderWakeAlarms(data.wakeAlarms);
  syncDefaultAlarmSoundPicker(data.defaultAlarmSoundId);
  reconcileWakeAlarm(data.wakeAlarmRinging);
  applyWallpaperMode(data);
  renderWallpaperSettings(data);
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

/**
 * Never gates on ctx.state - a source can be created and start()'d on a
 * suspended AudioContext perfectly validly, it just stays silent (queued)
 * until the context actually resumes. Earlier this bailed out entirely
 * when resume() didn't synchronously leave "suspended" (a real, fairly
 * common outcome of autoplay policy on this kiosk WebView), which told
 * Aurora "playing" while nothing local had actually started - the
 * dashboard needed a second, unrelated touch (via the pointerdown
 * fallback below) to notice and actually begin sound. Finishing the setup
 * unconditionally means the very next resume - from this call's own
 * attempt, or any later touch - makes the already-queued source audible
 * immediately, with no second startLocalPlayback() call needed.
 */
// A gentle rise instead of the sound snapping straight to full volume the
// instant playback starts - purely cosmetic to the ear, but reads as a
// lot less jarring for something meant to help you fall asleep.
const SOUND_FADE_IN_SECONDS = 2.5;

async function startLocalPlayback(soundId, offsetSeconds = 0) {
  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const buffer = await loadSoundBuffer(soundId);
  stopSourceNode();

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(gainNode);

  const startOffset = buffer.duration > 0 ? offsetSeconds % buffer.duration : 0;
  source.start(0, startOffset);

  // Whatever setLocalVolume() last set is the real target - ramp up to
  // it rather than starting there outright. Cancels any in-flight ramp
  // first so rapid stop/start doesn't leave two competing schedules.
  const targetGain = gainNode.gain.value;
  const now = ctx.currentTime;
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.linearRampToValueAtTime(targetGain, now + SOUND_FADE_IN_SECONDS);

  currentSource = source;
  currentSoundId = soundId;
  playbackStartContextTime = ctx.currentTime - startOffset;
  isLocallyPlaying = true;
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

// Resolves autoplay-policy blocks: startLocalPlayback()/startWakeAlarmSound()
// already create and start() their source nodes unconditionally, so a
// suspended AudioContext just means the source is queued but silent - the
// first touch anywhere on the kiosk screen only needs to resume() the
// context(s) for whatever's queued to become audible, nothing needs to be
// restarted.
document.addEventListener(
  "pointerdown",
  () => {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }
    if (wakeAlarmAudioContext && wakeAlarmAudioContext.state === "suspended") {
      wakeAlarmAudioContext.resume().catch(() => {});
    }
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
      postAction("/sound/stop");
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
  // A ringing wake alarm always wins - reconcileWakeAlarm() already stops
  // ambient playback (locally and on Aurora) the moment it starts ringing,
  // but this guard is what stops it from ever starting back up mid-ring
  // too, regardless of poll ordering (e.g. a fresh page load that hasn't
  // played anything locally yet has nothing to stop, but must still not
  // start).
  if (isAlarmRinging) return;

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

/** Generic fire-and-forget POST to Aurora - despite the name's origin
 *  (Sound Machine controls were the first user), this is now the shared
 *  helper for every simple query-string POST across the dashboard. */
async function postAction(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetch(`${AURORA_BASE_URL}${path}`, { method: "POST", signal: controller.signal });
  } catch (err) {
    // Best-effort - local state already reflects the action; the next
    // poll/reconcile corrects Aurora's state if this request was dropped.
  } finally {
    clearTimeout(timeout);
  }
}

let soundLibraryLoaded = false;
let soundDisplayNameById = new Map();

// Last few distinct sounds actually chosen (via the picker or a recent
// chip) - most-recent-first, deduped, capped short since this is meant to
// be a handful of quick-tap favorites, not a full history. Clock/Sound
// page only, see .sound-recent's comment in style.css.
const RECENT_SOUNDS_KEY = "aurora-dashboard:recent-sounds";
const RECENT_SOUNDS_MAX = 4;
let recentSoundIds = [];
try {
  recentSoundIds = JSON.parse(localStorage.getItem(RECENT_SOUNDS_KEY) || "[]");
} catch (err) {
  recentSoundIds = [];
}

function renderRecentSounds() {
  const container = byId("sound-recent");
  if (!container) return;
  if (recentSoundIds.length === 0) {
    container.classList.add("hidden");
    return;
  }
  container.innerHTML = recentSoundIds
    .map((id) => {
      const name = soundDisplayNameById.get(id) || id;
      const active = id === currentSoundId && isLocallyPlaying;
      return `<button class="sound-recent-chip${active ? " active" : ""}" type="button" data-sound-id="${escapeHtml(id)}">${escapeHtml(name)}</button>`;
    })
    .join("");
  container.classList.remove("hidden");
}

function recordRecentSound(soundId) {
  if (!soundId) return;
  recentSoundIds = [soundId, ...recentSoundIds.filter((id) => id !== soundId)].slice(0, RECENT_SOUNDS_MAX);
  localStorage.setItem(RECENT_SOUNDS_KEY, JSON.stringify(recentSoundIds));
  renderRecentSounds();
}

function setupRecentSounds() {
  const container = byId("sound-recent");
  if (!container) return;
  container.addEventListener("click", async (event) => {
    const chip = event.target.closest(".sound-recent-chip");
    if (!chip) return;
    const soundId = chip.dataset.soundId;
    if (!soundId) return;
    await startLocalPlayback(soundId, 0);
    await postAction(`/sound/play?id=${encodeURIComponent(soundId)}`);
    recordRecentSound(soundId);
    poll();
  });
}

async function ensureSoundLibraryLoaded() {
  if (soundLibraryLoaded) return;
  const picker = byId("sound-picker");
  const pickerLg = byId("sound-picker-lg");
  const pickerBedside = byId("sound-picker-bedside");
  const wakeAlarmPicker = byId("wakealarm-sound-picker");
  const defaultAlarmSoundPicker = byId("wakealarm-default-sound-picker");
  if (!picker && !pickerLg && !pickerBedside && !wakeAlarmPicker && !defaultAlarmSoundPicker) return;

  try {
    const response = await fetch(`${AURORA_BASE_URL}/sound/library`, { cache: "no-store" });
    if (!response.ok) return;
    const entries = await response.json();
    const optionsHtml = entries
      .map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.displayName)}</option>`)
      .join("");
    if (picker) picker.innerHTML = optionsHtml;
    if (pickerLg) pickerLg.innerHTML = optionsHtml;
    if (pickerBedside) pickerBedside.innerHTML = optionsHtml;
    // Alarms fall back to the default alarm sound when nothing's chosen
    // (see WakeAlarm.soundId), so this picker gets an explicit "Default"
    // option the ambient pickers above don't need.
    if (wakeAlarmPicker) wakeAlarmPicker.innerHTML = `<option value="">Default</option>${optionsHtml}`;
    // The default-sound picker itself has no "Default" option - it IS the
    // thing being set.
    if (defaultAlarmSoundPicker) defaultAlarmSoundPicker.innerHTML = optionsHtml;
    soundDisplayNameById = new Map(entries.map((entry) => [entry.id, entry.displayName]));
    renderRecentSounds();
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
      await postAction("/sound/pause");
    } else {
      const soundId = soundPicker?.value || currentSoundId;
      if (!soundId) return;
      await startLocalPlayback(soundId, currentSoundId === soundId ? playbackOffsetSeconds : 0);
      await postAction(`/sound/play?id=${encodeURIComponent(soundId)}`);
    }
    poll();
  });

  stopButton?.addEventListener("click", async () => {
    stopLocalPlaybackFully();
    await postAction("/sound/stop");
    poll();
  });

  soundPicker?.addEventListener("change", async () => {
    const soundId = soundPicker.value;
    if (!soundId) return;
    await startLocalPlayback(soundId, 0);
    await postAction(`/sound/play?id=${encodeURIComponent(soundId)}`);
    recordRecentSound(soundId);
    poll();
  });

  timerPicker?.addEventListener("change", async () => {
    await postAction(`/sound/timer?preset=${encodeURIComponent(timerPicker.value)}`);
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
      postAction(`/sound/volume?value=${percent}`);
    }, VOLUME_DEBOUNCE_MS);
  });
}

// Mute is just "volume 0, remember what it was" - derived from
// state.volume === 0 for the icon (see renderSoundMachine above) rather
// than a separate tracked boolean, so it can never disagree with what
// Aurora actually reports. Shared across all three UI surfaces (Overview
// card, Clock/Sound page, Bedside overlay) since they all reflect the same
// underlying volume, not three independent ones.
let volumeBeforeMute = null;

function setupMuteButtons() {
  SOUND_MACHINE_ID_SUFFIXES.forEach((suffix) => {
    const muteBtn = byId(`sound-mute${suffix}`);
    const volumeInput = byId(`sound-volume${suffix}`);
    if (!muteBtn || !volumeInput) return;

    muteBtn.addEventListener("click", () => {
      const current = Number(volumeInput.value);
      const target = current > 0 ? 0 : volumeBeforeMute || 50;
      if (current > 0) volumeBeforeMute = current;

      volumeInput.value = String(target);
      setText(`sound-volume-label${suffix}`, `${target}%`);
      setIcon(`volume-icon${suffix}`, target === 0 ? "volumeMuted" : "volume");
      setLocalVolume(target);
      postAction(`/sound/volume?value=${target}`);
    });
  });
}

function setupSoundControls() {
  setupSoundControlsFor("");
  setupSoundControlsFor("-lg");
  setupSoundControlsFor("-bedside");
  setupMuteButtons();
  setupRecentSounds();
}

// ---------------------------------------------------------------------------
// Wake Alarms - Aurora's own alarm clock rather than the phone's stock one
// (see the "Page 5" comment in index.html for why). Two independent
// pieces: managing the alarm list (this section), and actually ringing one
// when Aurora says it's time (further below, next to the ambient sound
// engine it borrows loadSoundBuffer()/AURORA_BASE_URL from).
// ---------------------------------------------------------------------------

const DAY_ABBREVIATIONS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]; // index 0 = Calendar.SUNDAY(1)

let selectedWakeAlarmDays = new Set(); // Calendar.DAY_OF_WEEK values (1-7)

function buildWakeAlarmDayToggle() {
  const container = byId("wakealarm-days");
  if (!container) return;

  container.innerHTML = DAY_ABBREVIATIONS.map(
    (abbrev, index) =>
      `<button type="button" class="wakealarm-day-btn" data-day="${index + 1}" aria-label="${abbrev}">${abbrev[0]}</button>`
  ).join("");

  container.querySelectorAll(".wakealarm-day-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const day = Number(btn.dataset.day);
      if (selectedWakeAlarmDays.has(day)) {
        selectedWakeAlarmDays.delete(day);
      } else {
        selectedWakeAlarmDays.add(day);
      }
      btn.classList.toggle("active");
    });
  });
}

function formatWakeAlarmDays(daysOfWeek) {
  if (!daysOfWeek || daysOfWeek.length === 0) return "Once";
  if (daysOfWeek.length === 7) return "Every day";
  return daysOfWeek
    .slice()
    .sort((a, b) => a - b)
    .map((day) => DAY_ABBREVIATIONS[day - 1])
    .join(", ");
}

function renderWakeAlarms(alarms) {
  const list = byId("wakealarm-list");
  if (!list) return;

  if (!alarms || alarms.length === 0) {
    list.innerHTML = '<li class="wakealarm-empty">No alarms set</li>';
    return;
  }

  const sorted = alarms.slice().sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  list.innerHTML = sorted
    .map((alarm) => {
      const time = formatTimeOfDay(`${String(alarm.hour).padStart(2, "0")}:${String(alarm.minute).padStart(2, "0")}`);
      const labelHtml = alarm.label ? `<span class="wakealarm-item-label">${escapeHtml(alarm.label)}</span>` : "";
      return `<li class="wakealarm-item${alarm.enabled ? "" : " disabled"}" data-id="${escapeHtml(alarm.id)}">
        <input type="checkbox" class="wakealarm-toggle" ${alarm.enabled ? "checked" : ""} aria-label="Enabled" />
        <div class="wakealarm-item-info">
          <span class="wakealarm-item-time">${time}</span>
          ${labelHtml}
          <span class="wakealarm-item-days">${escapeHtml(formatWakeAlarmDays(alarm.daysOfWeek))}</span>
        </div>
        <button class="icon-button wakealarm-delete" type="button" aria-label="Delete alarm">
          <span class="icon-slot" aria-hidden="true">${ICONS.trash}</span>
        </button>
      </li>`;
    })
    .join("");

  // Full alarm objects by id, so the enabled-toggle handler below can
  // resend a complete WakeAlarm to /wakealarms/set (which upserts by id)
  // without reconstructing every field from the DOM.
  latestWakeAlarmsById = new Map(alarms.map((alarm) => [alarm.id, alarm]));
}

let latestWakeAlarmsById = new Map();

function setupWakeAlarmList() {
  const list = byId("wakealarm-list");
  if (!list) return;

  list.addEventListener("change", (event) => {
    if (!event.target.classList.contains("wakealarm-toggle")) return;
    const id = event.target.closest("[data-id]")?.dataset.id;
    const alarm = id && latestWakeAlarmsById.get(id);
    if (!alarm) return;
    setWakeAlarm({ ...alarm, enabled: event.target.checked });
  });

  list.addEventListener("click", (event) => {
    if (!event.target.closest(".wakealarm-delete")) return;
    const id = event.target.closest("[data-id]")?.dataset.id;
    if (!id) return;
    postAction(`/wakealarms/delete?id=${encodeURIComponent(id)}`).then(poll);
  });
}

function setWakeAlarm(alarm) {
  const params = new URLSearchParams({
    id: alarm.id || "",
    hour: String(alarm.hour),
    minute: String(alarm.minute),
    days: (alarm.daysOfWeek || []).join(","),
    enabled: String(alarm.enabled),
    label: alarm.label || "",
    soundId: alarm.soundId || "",
  });
  return postAction(`/wakealarms/set?${params.toString()}`).then(poll);
}

/** Reflects Aurora's currently-configured default alarm sound in the
 *  picker, unless the user is mid-selection (same "don't fight an active
 *  interaction" rule as syncRangeInputIfIdle/syncPickerIfIdle above) -
 *  this one syncs by option value (a sound id) rather than display name,
 *  since data.defaultAlarmSoundId is already an id, not a name to resolve. */
function syncDefaultAlarmSoundPicker(defaultAlarmSoundId) {
  const picker = byId("wakealarm-default-sound-picker");
  if (!picker || document.activeElement === picker || !defaultAlarmSoundId) return;
  if ([...picker.options].some((opt) => opt.value === defaultAlarmSoundId)) {
    picker.value = defaultAlarmSoundId;
  }
}

function setupWakeAlarmForm() {
  setIcon("wakealarms-title-icon", "alarm");
  setIcon("wakealarm-add-icon", "plus");
  buildWakeAlarmDayToggle();
  setupWakeAlarmList();

  // This kiosk's WebView doesn't paint an empty <input type="time">'s
  // placeholder digits at all (unlike desktop Chrome's "--:-- --") - it
  // just renders a blank box until a value exists, which reads as broken
  // rather than as an unset field. A sensible starting value sidesteps
  // that entirely; the native picker (confirmed working - tapping it
  // opens the OS clock dialog) is how the user actually changes it.
  const timeInput = byId("wakealarm-time-input");
  if (timeInput && !timeInput.value) timeInput.value = "07:00";

  byId("wakealarm-default-sound-picker")?.addEventListener("change", (event) => {
    postAction(`/wakealarms/default-sound?id=${encodeURIComponent(event.target.value)}`);
  });

  byId("wakealarm-add-btn")?.addEventListener("click", () => {
    const timeInput = byId("wakealarm-time-input");
    const labelInput = byId("wakealarm-label-input");
    const soundPicker = byId("wakealarm-sound-picker");
    const [hour, minute] = (timeInput?.value || "").split(":").map(Number);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return;

    setWakeAlarm({
      id: null,
      hour,
      minute,
      daysOfWeek: Array.from(selectedWakeAlarmDays),
      enabled: true,
      label: labelInput?.value.trim() || "",
      soundId: soundPicker?.value || null,
    });

    if (labelInput) labelInput.value = "";
    selectedWakeAlarmDays = new Set();
    byId("wakealarm-days")
      ?.querySelectorAll(".wakealarm-day-btn.active")
      .forEach((btn) => btn.classList.remove("active"));
  });
}

// ---- Ringing --------------------------------------------------------------
// A separate AudioContext/gain from the ambient sound engine below, on
// purpose: an alarm needs to ring at a fixed, reliably loud volume
// regardless of whatever the ambient volume slider is set to, and must
// never be silently paused/overridden by reconcileSoundMachine()'s own
// bookkeeping, which only knows about the ambient sound machine's state.

let wakeAlarmAudioContext = null;
let wakeAlarmGainNode = null;
let wakeAlarmSource = null;
let isAlarmRinging = false;

// Starts quiet rather than snapping to full volume - a real bedside alarm
// clock rings, it doesn't blast - and ramps up over this long, so even a
// deep sleeper who misses the first few seconds still gets full volume
// well before it'd be worth ignoring the whole point of an alarm.
const WAKE_ALARM_START_GAIN = 0.08;
const WAKE_ALARM_RAMP_SECONDS = 45;

function ensureWakeAlarmAudioContext() {
  if (!wakeAlarmAudioContext) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    wakeAlarmAudioContext = new AudioContextCtor();
    wakeAlarmGainNode = wakeAlarmAudioContext.createGain();
    wakeAlarmGainNode.connect(wakeAlarmAudioContext.destination);
    wakeAlarmGainNode.gain.value = WAKE_ALARM_START_GAIN;
  }
  return wakeAlarmAudioContext;
}

/** Same "never gate on ctx.state" fix as startLocalPlayback() above - see
 *  its doc comment. An alarm silently failing to sound until a second,
 *  unrelated touch is an even worse outcome than the ambient sound
 *  machine doing the same, so this gets the identical treatment. */
async function startWakeAlarmSound(soundId) {
  const ctx = ensureWakeAlarmAudioContext();
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const buffer = await loadSoundBuffer(soundId || DEFAULT_ALARM_SOUND_ID);
  stopWakeAlarmSound();

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(wakeAlarmGainNode);
  source.start(0);
  wakeAlarmSource = source;

  const now = ctx.currentTime;
  wakeAlarmGainNode.gain.cancelScheduledValues(now);
  wakeAlarmGainNode.gain.setValueAtTime(WAKE_ALARM_START_GAIN, now);
  wakeAlarmGainNode.gain.linearRampToValueAtTime(1, now + WAKE_ALARM_RAMP_SECONDS);
}

// Screen brightness ramps alongside the audio gain ramp above - same
// motivation (a jarring full-brightness flash is as rude a wake-up as a
// blast of full-volume sound), same duration, just driven by setInterval
// since Fully's setScreenBrightness is a plain imperative call, not a Web
// Audio param that supports its own scheduling.
const WAKE_ALARM_BRIGHTNESS_START = 15;
const WAKE_ALARM_BRIGHTNESS_TICK_MS = 1000;
let wakeAlarmBrightnessInterval = null;

function startAlarmBrightnessRamp() {
  if (!window.fully || typeof window.fully.setScreenBrightness !== "function") return;
  stopAlarmBrightnessRamp();
  const startTime = Date.now();
  const durationMs = WAKE_ALARM_RAMP_SECONDS * 1000;
  window.fully.setScreenBrightness(WAKE_ALARM_BRIGHTNESS_START);
  wakeAlarmBrightnessInterval = setInterval(() => {
    const progress = Math.min((Date.now() - startTime) / durationMs, 1);
    const brightness = Math.round(
      WAKE_ALARM_BRIGHTNESS_START + (DAY_SCREEN_BRIGHTNESS - WAKE_ALARM_BRIGHTNESS_START) * progress
    );
    window.fully.setScreenBrightness(brightness);
    if (progress >= 1) stopAlarmBrightnessRamp();
  }, WAKE_ALARM_BRIGHTNESS_TICK_MS);
}

function stopAlarmBrightnessRamp() {
  if (!wakeAlarmBrightnessInterval) return;
  clearInterval(wakeAlarmBrightnessInterval);
  wakeAlarmBrightnessInterval = null;
}

function stopWakeAlarmSound() {
  if (!wakeAlarmSource) return;
  try {
    wakeAlarmSource.stop();
  } catch (err) {
    // Already stopped - fine.
  }
  wakeAlarmSource.disconnect();
  wakeAlarmSource = null;
}

// Last-resort only - Aurora now always resolves a concrete soundId before
// an alarm rings (the alarm's own sound, falling back to the configured
// default alarm sound, falling back to the sound library's first entry -
// see WakeAlarmRepositoryImpl.handleFired()). This should never actually
// fire in practice.
const DEFAULT_ALARM_SOUND_ID = "rain";

function showAlarmRingingOverlay(label) {
  const overlay = byId("alarm-ringing-overlay");
  if (!overlay) return;
  setText("alarm-ringing-label", label || "Alarm");
  overlay.classList.remove("hidden");
}

function hideAlarmRingingOverlay() {
  byId("alarm-ringing-overlay")?.classList.add("hidden");
}

/**
 * Reconciles local ringing state against Aurora's - same "poll drives
 * reality" pattern as reconcileSoundMachine(), so a fresh page load or
 * reboot that happens to land mid-ring picks the alarm right back up.
 *
 * Actually stops the ambient sound machine - locally, unconditionally on
 * Aurora too via POST /sound/stop (not just when this page instance
 * happened to be playing something locally - a fresh page load has
 * nothing local to stop but Aurora's own reported state still needs to
 * say "stopped", both so its own UI is honest about it and so
 * reconcileSoundMachine() doesn't have stale "should be playing" state to
 * act on once the alarm ends. reconcileSoundMachine() itself also refuses
 * to start anything while isAlarmRinging is true (see its own guard),
 * which is what actually prevents a same-cycle restart race - this stop
 * call is about correctness of Aurora's reported state, not preventing
 * the race by itself.
 */
function reconcileWakeAlarm(ringingState) {
  const shouldRing = Boolean(ringingState && ringingState.ringing);

  if (shouldRing && !isAlarmRinging) {
    isAlarmRinging = true;
    stopLocalPlaybackFully();
    postAction("/sound/stop");
    startWakeAlarmSound(ringingState.soundId);
    startAlarmBrightnessRamp();
    showAlarmRingingOverlay(ringingState.label);
    // A ringing alarm needs the full-screen dismiss/snooze overlay visible
    // and audible - staying in Bedside Mode's own dim, quiet view would bury
    // it, so an active bedside session ends automatically the moment an
    // alarm goes off.
    if (document.body.classList.contains("bedside-active")) {
      exitBedsideMode();
    }
  } else if (!shouldRing && isAlarmRinging) {
    isAlarmRinging = false;
    stopWakeAlarmSound();
    stopAlarmBrightnessRamp();
    // Re-evaluate day/night brightness from scratch rather than leaving
    // the screen wherever the ramp left it - if it's still nighttime, this
    // puts it back to the dim level instead of stuck bright post-dismiss.
    isNightMode = null;
    applyDayNightMode();
    hideAlarmRingingOverlay();
  }
}

const SNOOZE_DURATION_KEY = "aurora-dashboard:snooze-duration";

/** Tells Aurora, then poll() picks up the resulting !ringing state on its
 *  next round-trip and reconcileWakeAlarm() above tears down the UI. */
function dismissWakeAlarm() {
  postAction("/wakealarms/dismiss").then(poll);
}

function snoozeWakeAlarm() {
  const minutes = byId("alarm-snooze-duration")?.value || "9";
  postAction(`/wakealarms/snooze?minutes=${encodeURIComponent(minutes)}`).then(poll);
}

function setupWakeAlarmRingingControls() {
  setIcon("alarm-ringing-icon", "alarm");

  const durationPicker = byId("alarm-snooze-duration");
  const savedDuration = localStorage.getItem(SNOOZE_DURATION_KEY);
  if (durationPicker && savedDuration) durationPicker.value = savedDuration;
  durationPicker?.addEventListener("change", () => {
    localStorage.setItem(SNOOZE_DURATION_KEY, durationPicker.value);
  });

  byId("alarm-dismiss-btn")?.addEventListener("click", dismissWakeAlarm);
  byId("alarm-snooze-btn")?.addEventListener("click", snoozeWakeAlarm);

  // Tap-ANYTHING-to-snooze - the whole point of a ringing alarm is that
  // you're half-asleep in the dark, exactly the condition under which
  // aiming for a specific small button is hardest. Dismiss stays a
  // deliberate, separate tap on its own (much larger, but still distinct)
  // button, so a stray touch snoozes rather than accidentally killing the
  // alarm outright. Excludes the dismiss button, snooze button, and
  // duration picker themselves so this doesn't double-fire alongside
  // their own click handlers above.
  byId("alarm-ringing-overlay")?.addEventListener("click", (event) => {
    if (event.target.closest("#alarm-dismiss-btn, #alarm-snooze-btn, #alarm-snooze-duration")) return;
    snoozeWakeAlarm();
  });
}

// ---------------------------------------------------------------------------
// Timer & Stopwatch (own page) - dashboard-only, no Aurora involvement.
// Both track an epoch (when the current run started/will end) and compute
// elapsed/remaining from Date.now() on every tick, rather than
// incrementing/decrementing a counter each time the interval fires - that
// way neither drifts if a tick ever runs late (a throttled tab, a slow
// frame), since the displayed value is always freshly derived from real
// wall-clock time.
// ---------------------------------------------------------------------------

/** A short, fixed-volume beep for the countdown timer finishing - reuses
 *  the Sound Machine's shared AudioContext (see ensureAudioContext())
 *  rather than opening a second one, but its own GainNode straight to the
 *  destination, so muting/lowering the ambient sound doesn't also
 *  silence the timer alert. */
function playTimerBeep() {
  const ctx = ensureAudioContext();
  const beepGain = ctx.createGain();
  beepGain.gain.value = 0.25;
  beepGain.connect(ctx.destination);
  [0, 0.35, 0.7].forEach((offset) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 880;
    osc.connect(beepGain);
    const startAt = ctx.currentTime + offset;
    osc.start(startAt);
    osc.stop(startAt + 0.25);
  });
}

function formatClockDisplay(totalSeconds, tenths) {
  const clamped = Math.max(0, totalSeconds);
  const seconds = clamped % 60;
  const minutes = Math.floor(clamped / 60);
  const hours = Math.floor(minutes / 60);
  const mm = String(hours > 0 ? minutes % 60 : minutes).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  const base = hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  return tenths == null ? base : `${base}.${tenths}`;
}

let timerDurationSeconds = 300;
let timerRemainingSeconds = 300;
let timerEndAt = null;
let timerHandle = null;

function renderTimerDisplay() {
  const display = byId("timer-display");
  if (!display) return;
  display.textContent = formatClockDisplay(timerRemainingSeconds);
  display.classList.toggle("timer-running", Boolean(timerHandle));
  display.classList.toggle("timer-done", timerRemainingSeconds === 0 && !timerHandle && timerEndAt === null);
}

function stopTimerInterval() {
  clearInterval(timerHandle);
  timerHandle = null;
}

function tickTimer() {
  timerRemainingSeconds = Math.max(0, Math.round((timerEndAt - Date.now()) / 1000));
  if (timerRemainingSeconds === 0) {
    stopTimerInterval();
    timerEndAt = null;
    setText("timer-start-btn", "Start");
    playTimerBeep();
  }
  renderTimerDisplay();
}

function startTimer() {
  if (timerRemainingSeconds === 0) timerRemainingSeconds = timerDurationSeconds;
  timerEndAt = Date.now() + timerRemainingSeconds * 1000;
  timerHandle = setInterval(tickTimer, 250);
  setText("timer-start-btn", "Pause");
  renderTimerDisplay();
}

function pauseTimer() {
  timerRemainingSeconds = Math.max(0, Math.round((timerEndAt - Date.now()) / 1000));
  stopTimerInterval();
  timerEndAt = null;
  setText("timer-start-btn", "Start");
  renderTimerDisplay();
}

function resetTimer() {
  stopTimerInterval();
  timerEndAt = null;
  timerRemainingSeconds = timerDurationSeconds;
  setText("timer-start-btn", "Start");
  renderTimerDisplay();
}

function setupTimer() {
  renderTimerDisplay();

  byId("timer-presets")?.addEventListener("click", (event) => {
    const btn = event.target.closest(".timer-preset-btn");
    if (!btn) return;
    timerDurationSeconds = Number(btn.dataset.minutes) * 60;
    resetTimer();
    byId("timer-presets")
      ?.querySelectorAll(".timer-preset-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
  });

  byId("timer-start-btn")?.addEventListener("click", () => (timerHandle ? pauseTimer() : startTimer()));
  byId("timer-reset-btn")?.addEventListener("click", resetTimer);
}

let stopwatchElapsedMs = 0;
let stopwatchStartedAt = null;
let stopwatchHandle = null;
let stopwatchLaps = [];

function currentStopwatchElapsedMs() {
  return stopwatchElapsedMs + (stopwatchStartedAt ? Date.now() - stopwatchStartedAt : 0);
}

function renderStopwatchDisplay() {
  const display = byId("stopwatch-display");
  if (!display) return;
  const ms = currentStopwatchElapsedMs();
  display.textContent = formatClockDisplay(Math.floor(ms / 1000), Math.floor((ms % 1000) / 100));
  display.classList.toggle("timer-running", Boolean(stopwatchStartedAt));
}

function renderStopwatchLaps() {
  const list = byId("stopwatch-laps");
  if (!list) return;
  list.innerHTML = stopwatchLaps
    .map((lapMs, index) => {
      const label = formatClockDisplay(Math.floor(lapMs / 1000), Math.floor((lapMs % 1000) / 100));
      return `<li><span>Lap ${index + 1}</span><span>${escapeHtml(label)}</span></li>`;
    })
    .join("");
}

function setupStopwatch() {
  renderStopwatchDisplay();

  byId("stopwatch-start-btn")?.addEventListener("click", () => {
    const lapBtn = byId("stopwatch-lap-btn");
    if (stopwatchStartedAt) {
      stopwatchElapsedMs = currentStopwatchElapsedMs();
      stopwatchStartedAt = null;
      clearInterval(stopwatchHandle);
      stopwatchHandle = null;
      setText("stopwatch-start-btn", "Start");
      if (lapBtn) lapBtn.disabled = true;
    } else {
      stopwatchStartedAt = Date.now();
      stopwatchHandle = setInterval(renderStopwatchDisplay, 100);
      setText("stopwatch-start-btn", "Pause");
      if (lapBtn) lapBtn.disabled = false;
    }
    renderStopwatchDisplay();
  });

  byId("stopwatch-lap-btn")?.addEventListener("click", () => {
    if (!stopwatchStartedAt) return;
    stopwatchLaps.push(currentStopwatchElapsedMs());
    renderStopwatchLaps();
  });

  byId("stopwatch-reset-btn")?.addEventListener("click", () => {
    clearInterval(stopwatchHandle);
    stopwatchHandle = null;
    stopwatchStartedAt = null;
    stopwatchElapsedMs = 0;
    stopwatchLaps = [];
    setText("stopwatch-start-btn", "Start");
    const lapBtn = byId("stopwatch-lap-btn");
    if (lapBtn) lapBtn.disabled = true;
    renderStopwatchDisplay();
    renderStopwatchLaps();
  });
}

function setupTimerPage() {
  setupTimer();
  setupStopwatch();

  const segmented = byId("timer-mode-segmented");
  segmented?.addEventListener("click", (event) => {
    const btn = event.target.closest(".settings-segment");
    if (!btn) return;
    segmented.querySelectorAll(".settings-segment").forEach((b) => b.classList.toggle("active", b === btn));
    byId("timer-view")?.classList.toggle("hidden", btn.dataset.mode !== "timer");
    byId("stopwatch-view")?.classList.toggle("hidden", btn.dataset.mode !== "stopwatch");
  });
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

const MANUAL_REFRESH_COOLDOWN_MS = 3000;
let manualRefreshCooldownUntil = 0;

/** Tapping the status line forces an immediate poll instead of waiting
 *  for the next 30s tick - for "did that notification actually come
 *  through yet" moments. A short cooldown (rather than disabling the
 *  element) keeps repeated taps from hammering Aurora while still never
 *  leaving the control in a visibly "broken" disabled state. */
function setupManualRefresh() {
  byId("status-line")?.addEventListener("click", () => {
    if (Date.now() < manualRefreshCooldownUntil) return;
    manualRefreshCooldownUntil = Date.now() + MANUAL_REFRESH_COOLDOWN_MS;

    const el = byId("status-line");
    el?.classList.remove("refreshing");
    void el?.offsetWidth; // force reflow so the animation restarts cleanly
    el?.classList.add("refreshing");

    poll();
  });
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
    if (pages[index]?.id === "page-settings") {
      ensureNotificationAppsLoaded();
      ensureHomeNetworkLoaded();
    }
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

// Subtle scale+fade on whichever page is mid-swipe, driven directly off
// scroll position rather than a fixed-duration transition - it needs to
// track the finger 1:1, not ease on its own schedule. Skipped entirely
// under prefers-reduced-motion since it's a continuous transform effect,
// not a CSS animation/transition the global reduced-motion rule catches.
function setupPageScrollEffect() {
  const pager = byId("pager");
  if (!pager) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const pages = Array.from(pager.children);
  let ticking = false;

  const update = () => {
    ticking = false;
    const pagerRect = pager.getBoundingClientRect();
    const center = pagerRect.left + pagerRect.width / 2;
    pages.forEach((page) => {
      const rect = page.getBoundingClientRect();
      const pageCenter = rect.left + rect.width / 2;
      const progress = Math.min(Math.abs(pageCenter - center) / rect.width, 1);
      page.style.transform = `scale(${1 - progress * 0.06})`;
      page.style.opacity = String(1 - progress * 0.35);
    });
  };

  pager.addEventListener("scroll", () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });

  update();
}

// ---------------------------------------------------------------------------
// Theme picker - one shared layout/markup for every theme; each theme is
// just a [data-theme] CSS block (see the end of style.css) swapping
// palette/typography/shape, not a different frontend. The actual
// application already happened synchronously in index.html's inline
// <head> script (to avoid a flash of the wrong theme on load) - this
// just keeps the Settings page's swatches in sync and handles taps.
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = "echo-dashboard-theme";

function applyTheme(themeId) {
  if (themeId && themeId !== "default") {
    document.documentElement.dataset.theme = themeId;
  } else {
    delete document.documentElement.dataset.theme;
    themeId = "default";
  }
  document.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeValue === themeId);
  });
}

function setupThemePicker() {
  const grid = byId("theme-grid");
  if (!grid) return;

  applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || "default");

  grid.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      const themeId = btn.dataset.themeValue;
      localStorage.setItem(THEME_STORAGE_KEY, themeId);
      applyTheme(themeId);
    });
  });
}

// ---------------------------------------------------------------------------
// Bedside Mode - a one-tap "going to sleep" action: starts rain, dims the
// display further than the ordinary night dim (see body.bedside-active in
// style.css), and makes sure any wake alarms are actually armed, instead
// of several manual steps. The overlay itself (huge clock, alarm/tomorrow
// caption, Sound Machine) lives outside the pager, like the alarm-ringing
// overlay - it's a summoned view, not one more page to swipe to.
// ---------------------------------------------------------------------------

const BEDSIDE_RAIN_SOUND_ID = "rain";
const BEDSIDE_DEFAULT_BRIGHTNESS_PERCENT = 50;

/** Live-updates the --bedside-brightness custom property style.css's
 *  body.bedside-active reads (see the comment there) - purely a local
 *  display preference, nothing to send to Aurora. */
function setBedsideBrightness(percent) {
  document.documentElement.style.setProperty("--bedside-brightness", String(percent / 100));
  setText("bedside-brightness-label", `${percent}%`);
}

/** Checked once, at the moment of tapping the moon icon - "going to bed"
 *  is a much more specific, deliberate signal than the ambient day/night
 *  dim transition (which just means the room got dark, not that anyone's
 *  actually about to sleep), so this is tied to enterBedsideMode() rather
 *  than applyDayNightMode(). Reuses .battery-warning's existing look
 *  rather than inventing a new banner style for what's the same "phone's
 *  low and not charging" fact, just surfaced at a different moment. */
function showBedsideBatteryNudgeIfLow() {
  const banner = byId("bedside-battery-nudge");
  if (!banner) return;
  const low = latestBattery != null && latestBattery < LOW_BATTERY_THRESHOLD && !latestCharging;
  banner.classList.toggle("hidden", !low);
  if (!low) return;
  setIcon("bedside-battery-nudge-icon", "batteryAlert");
  setText("bedside-battery-nudge-text", `Phone at ${latestBattery}% and not charging - plug it in`);
}

async function enterBedsideMode() {
  // Mutually exclusive with Ambient Mode - see setupAmbientMode()'s doc
  // comment for why idle-triggered ambient viewing never fires while
  // this deliberate "going to sleep" mode is active.
  exitAmbientMode();
  clearTimeout(ambientIdleTimer);
  exitReadingMode();
  startSleepSession();

  byId("bedside-overlay")?.classList.remove("hidden");
  document.body.classList.add("bedside-active");
  showBedsideBatteryNudgeIfLow();

  const slider = byId("bedside-brightness-slider");
  if (slider) slider.value = String(BEDSIDE_DEFAULT_BRIGHTNESS_PERCENT);
  setBedsideBrightness(BEDSIDE_DEFAULT_BRIGHTNESS_PERCENT);

  if (bedsideAutoSoundEnabled) {
    await startLocalPlayback(BEDSIDE_RAIN_SOUND_ID, 0);
    await postAction(`/sound/play?id=${BEDSIDE_RAIN_SOUND_ID}`);
  }

  const disabledAlarms = Array.from(latestWakeAlarmsById.values()).filter((alarm) => !alarm.enabled);
  await Promise.all(disabledAlarms.map((alarm) => setWakeAlarm({ ...alarm, enabled: true })));

  // Going to bed means the phone should stay quiet too - same as tapping
  // the DND toggle by hand, just automatic. exitBedsideMode() below
  // undoes this unconditionally on the way out, same as it does for
  // brightness/sound - Bedside Mode owns DND for the duration, it isn't
  // tracking whether you'd already turned it on yourself beforehand.
  await postAction("/dnd/set?enabled=true");

  poll();
}

function exitBedsideMode() {
  byId("bedside-overlay")?.classList.add("hidden");
  document.body.classList.remove("bedside-active");
  resetAmbientIdleTimer();
  postAction("/dnd/set?enabled=false").then(poll);
  endSleepSession();
}

function setupBedsideMode() {
  setIcon("bedside-trigger-icon", "moon");
  setIcon("bedside-exit-icon", "close");
  setIcon("bedside-brightness-icon", "sunny");
  byId("bedside-trigger-btn")?.addEventListener("click", enterBedsideMode);
  byId("bedside-exit-btn")?.addEventListener("click", exitBedsideMode);
  byId("bedside-brightness-slider")?.addEventListener("input", (event) => {
    setBedsideBrightness(Number(event.target.value));
  });
}

// ---------------------------------------------------------------------------
// Ambient Mode - a screensaver-style idle view: after 30 minutes with no
// touch anywhere on the dashboard, it takes over with a huge clock, a
// tiny weather line, and the user's photos cycling with a slow crossfade
// (Aurora's Photo Picker - see PhotoRepository there) - or the same
// twinkling starfield the "Night" weather background uses, if no photos
// are configured yet. Any touch exits it immediately. Never triggers
// while Bedside Mode is active - that's already a deliberate minimal
// state, not an idle one.
// ---------------------------------------------------------------------------

// Configurable from the Settings page (see setupAmbientTimeoutSetting()) -
// a plain localStorage setting, no Aurora involvement, since idle timeout
// is purely this dashboard's own behavior.
const AMBIENT_IDLE_TIMEOUT_KEY = "aurora-dashboard:ambient-idle-minutes";
let ambientIdleMinutes = parseInt(localStorage.getItem(AMBIENT_IDLE_TIMEOUT_KEY), 10) || 30;
const AMBIENT_PHOTO_INTERVAL_MS = 30 * 1000;
const AMBIENT_DEFAULT_BRIGHTNESS_PERCENT = 60;

let ambientIdleTimer = null;
let ambientPhotoIds = [];
let ambientPhotosLoaded = false;
let ambientCycleHandle = null;
let ambientPhotoIndex = -1;
let ambientActiveLayer = "a";

async function ensureAmbientPhotosLoaded() {
  if (ambientPhotosLoaded) return;
  try {
    const response = await fetch(`${AURORA_BASE_URL}/photos/library`, { cache: "no-store" });
    if (!response.ok) return;
    const entries = await response.json();
    ambientPhotoIds = entries.map((entry) => entry.id);
    ambientPhotosLoaded = true;
  } catch (err) {
    // Aurora unreachable - the starfield fallback covers this gracefully.
  }
}

function preloadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/** Crossfades to the next photo across two stacked layers - preloads
 *  before swapping so a slow/failed fetch never shows a blank frame. */
async function showNextAmbientPhoto() {
  if (ambientPhotoIds.length === 0) return;
  ambientPhotoIndex = (ambientPhotoIndex + 1) % ambientPhotoIds.length;
  const url = `${AURORA_BASE_URL}/photos/stream?id=${encodeURIComponent(ambientPhotoIds[ambientPhotoIndex])}`;
  const loaded = await preloadImage(url);
  if (!loaded) return;

  const nextLayer = byId(ambientActiveLayer === "a" ? "ambient-photo-b" : "ambient-photo-a");
  const prevLayer = byId(ambientActiveLayer === "a" ? "ambient-photo-a" : "ambient-photo-b");
  if (!nextLayer || !prevLayer) return;

  nextLayer.style.backgroundImage = `url("${url}")`;
  nextLayer.classList.add("visible");
  prevLayer.classList.remove("visible");
  ambientActiveLayer = ambientActiveLayer === "a" ? "b" : "a";
}

function stopAmbientPhotoCycle() {
  clearInterval(ambientCycleHandle);
  ambientCycleHandle = null;
}

function startAmbientPhotoCycle() {
  stopAmbientPhotoCycle();
  if (ambientPhotoIds.length === 0) return;
  showNextAmbientPhoto();
  ambientCycleHandle = setInterval(showNextAmbientPhoto, AMBIENT_PHOTO_INTERVAL_MS);
}

// Dashboard wallpaper - same photo library and crossfade technique as
// Ambient Mode just above, but its own layers/timer, much slower (this is
// glanced at while actually using the dashboard, not stared at idle), and
// re-extracts the accent color (see extractWallpaperAccentColor() earlier
// in this file) on every swap. Three modes (see Aurora's
// WallpaperConfigRepository, reported fresh on every /dashboard poll):
// "rotating" cycles the whole library on a slow timer (the original
// behavior, still the default), "single" always shows one fixed photo,
// "scheduled" shows whichever entry's time-of-day has most recently
// passed - see applyWallpaperMode().
const WALLPAPER_ROTATION_INTERVAL_MS = 5 * 60 * 1000;

let wallpaperPhotoIndex = -1;
let wallpaperActiveLayer = "a";
let wallpaperRotationHandle = null;
let currentWallpaperPhotoId = null;

/** Crossfades to [photoId] - a no-op if it's already showing, so calling
 *  this every poll cycle (single/scheduled modes) doesn't restart the
 *  fade or re-fetch the same image. Shared by rotating/single/scheduled
 *  so there's exactly one crossfade + accent-color implementation. */
async function showWallpaperPhoto(photoId) {
  if (!photoId || photoId === currentWallpaperPhotoId) return;
  const url = `${AURORA_BASE_URL}/photos/stream?id=${encodeURIComponent(photoId)}`;

  const img = new Image();
  img.crossOrigin = "anonymous";
  const loaded = await new Promise((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
  if (!loaded) return;

  const nextLayer = byId(wallpaperActiveLayer === "a" ? "wallpaper-bg-b" : "wallpaper-bg-a");
  const prevLayer = byId(wallpaperActiveLayer === "a" ? "wallpaper-bg-a" : "wallpaper-bg-b");
  if (!nextLayer || !prevLayer) return;

  nextLayer.style.backgroundImage = `url("${url}")`;
  nextLayer.classList.add("visible");
  prevLayer.classList.remove("visible");
  wallpaperActiveLayer = wallpaperActiveLayer === "a" ? "b" : "a";
  currentWallpaperPhotoId = photoId;

  wallpaperAccentColor = extractWallpaperAccentColor(img);
  if (wallpaperAccentColor) {
    document.documentElement.style.setProperty("--accent", wallpaperAccentColor);
  }
}

async function showNextWallpaperPhoto() {
  if (ambientPhotoIds.length === 0) return;
  wallpaperPhotoIndex = (wallpaperPhotoIndex + 1) % ambientPhotoIds.length;
  await showWallpaperPhoto(ambientPhotoIds[wallpaperPhotoIndex]);
}

function stopWallpaperRotation() {
  clearInterval(wallpaperRotationHandle);
  wallpaperRotationHandle = null;
}

async function startWallpaperRotation() {
  await ensureAmbientPhotosLoaded();
  if (ambientPhotoIds.length === 0) return; // No photos configured - leave the layer empty.
  if (wallpaperRotationHandle) return; // Already rotating - a re-poll shouldn't reset the timer.
  showNextWallpaperPhoto();
  wallpaperRotationHandle = setInterval(showNextWallpaperPhoto, WALLPAPER_ROTATION_INTERVAL_MS);
}

/** [entries] must already be sorted by time ascending (Aurora stores them
 *  that way). Picks whichever entry's time-of-day has most recently
 *  passed, wrapping around to the last entry if none have fired yet
 *  today - so a schedule always covers the full 24 hours with no gaps to
 *  configure by hand. */
function activeScheduledPhotoId(entries) {
  if (!entries || entries.length === 0) return null;
  const nowMinutes = currentMinutesInTimezone(currentTimezone || undefined);
  let active = entries[entries.length - 1];
  for (const entry of entries) {
    if (minutesFromHHMM(entry.time) > nowMinutes) break;
    active = entry;
  }
  return active.photoId;
}

/** Hides whatever photo is currently showing and drops the wallpaper-
 *  driven accent color back to weather-driven - shared by the black-
 *  background override (below) and by toggling it back off, so turning
 *  it off doesn't need to wait for the next photo to load before the
 *  wallpaper looks right again. */
function clearWallpaperLayers() {
  byId("wallpaper-bg-a")?.classList.remove("visible");
  byId("wallpaper-bg-b")?.classList.remove("visible");
  currentWallpaperPhotoId = null;
  wallpaperAccentColor = null;
}

/** Called on every /dashboard poll - applies whichever wallpaper mode
 *  Aurora currently reports, switching cleanly if the mode itself has
 *  changed since the last poll (e.g. stopping the rotation timer once
 *  it's no longer "rotating"). The black-background override short-
 *  circuits all of that - Aurora's own wallpaperMode is left completely
 *  alone, so turning the override off resumes exactly where it was. */
async function applyWallpaperMode(data) {
  if (wallpaperForcedBlack) {
    stopWallpaperRotation();
    clearWallpaperLayers();
    return;
  }
  if (data.wallpaperMode === "single") {
    stopWallpaperRotation();
    await ensureAmbientPhotosLoaded();
    showWallpaperPhoto(data.wallpaperSinglePhotoId);
  } else if (data.wallpaperMode === "scheduled") {
    stopWallpaperRotation();
    await ensureAmbientPhotosLoaded();
    showWallpaperPhoto(activeScheduledPhotoId(data.wallpaperSchedule));
  } else {
    startWallpaperRotation();
  }
}

// ---------------------------------------------------------------------------
// Wallpaper settings (Settings page) - the write side of the same mode/
// single-photo/schedule fields applyWallpaperMode() above already reads
// every poll. Shares ambientPhotoIds rather than fetching the library
// again, since it's genuinely the same photo set Ambient Mode uses.
// ---------------------------------------------------------------------------

let lastWallpaperData = null;
// Which photo the schedule "Add" row will use next - a photo grid tap
// means something different depending on mode (see setupWallpaperSettings):
// an immediate single-photo POST in Single mode, vs just staging a
// selection here in Scheduled mode until a time is picked and "Add" is
// pressed.
let wallpaperPendingPhotoId = null;

function renderWallpaperPhotoGrid(data) {
  const grid = byId("wallpaper-photo-grid");
  if (!grid) return;
  if (ambientPhotoIds.length === 0) {
    grid.innerHTML = '<div class="settings-photo-empty">No photos yet - choose some from the Aurora phone app</div>';
    return;
  }
  const selectedId = data.wallpaperMode === "single" ? data.wallpaperSinglePhotoId : wallpaperPendingPhotoId;
  grid.innerHTML = ambientPhotoIds
    .map((id) => {
      // &thumb=1 asks Aurora for a small downsampled JPEG instead of the
      // original camera-resolution file - these buttons only ever render
      // at ~70px, and decoding N full-size photos at once here was the
      // main cause of the Settings page lagging in.
      const url = `${AURORA_BASE_URL}/photos/stream?id=${encodeURIComponent(id)}&thumb=1`;
      const active = id === selectedId;
      return `<button class="settings-photo-thumb${active ? " active" : ""}" type="button" data-photo-id="${escapeHtml(id)}" style="background-image:url('${url}')" aria-label="Select photo"></button>`;
    })
    .join("");
}

function renderWallpaperSchedule(entries) {
  const list = byId("wallpaper-schedule-list");
  if (!list) return;
  if (!entries || entries.length === 0) {
    list.innerHTML = '<div class="settings-photo-empty">No scheduled entries yet</div>';
    return;
  }
  list.innerHTML = entries
    .map((entry) => {
      const url = `${AURORA_BASE_URL}/photos/stream?id=${encodeURIComponent(entry.photoId)}&thumb=1`;
      return `<div class="settings-schedule-row" data-photo-id="${escapeHtml(entry.photoId)}" data-time="${escapeHtml(entry.time)}">
          <span class="settings-photo-thumb" style="background-image:url('${url}')"></span>
          <span class="settings-schedule-time">${escapeHtml(entry.time)}</span>
          <button class="settings-schedule-remove" type="button" aria-label="Remove scheduled entry">&times;</button>
        </div>`;
    })
    .join("");
}

// Tracks what the grid/schedule list were last built from, so a poll tick
// that changed nothing about the wallpaper (the overwhelmingly common
// case) skips rebuilding them entirely - this used to run unconditionally
// every 30s regardless of which page was visible, tearing down and
// recreating every thumbnail (and forcing a fresh image decode of each)
// for no reason.
let lastWallpaperGridSignature = null;

function renderWallpaperSettings(data) {
  const segmented = byId("wallpaper-mode-segmented");
  if (!segmented) return;
  lastWallpaperData = data;

  segmented.querySelectorAll(".settings-segment").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === data.wallpaperMode);
  });

  const isScheduled = data.wallpaperMode === "scheduled";
  byId("wallpaper-schedule-add-row")?.classList.toggle("hidden", !isScheduled);
  byId("wallpaper-schedule-list")?.classList.toggle("hidden", !isScheduled);

  const signature = JSON.stringify({
    mode: data.wallpaperMode,
    single: data.wallpaperSinglePhotoId,
    pending: wallpaperPendingPhotoId,
    schedule: data.wallpaperSchedule,
    photoIds: ambientPhotoIds,
  });
  if (signature === lastWallpaperGridSignature) return;
  lastWallpaperGridSignature = signature;

  // The library may not be loaded yet on the very first render - re-render
  // the grid once it is, rather than blocking renderDashboard on it.
  ensureAmbientPhotosLoaded().then(() => renderWallpaperPhotoGrid(data));
  renderWallpaperSchedule(data.wallpaperSchedule);
}

/** The one place this dashboard POSTs a JSON body rather than query
 *  params - a list of {photoId, time} entries doesn't fit a query string
 *  (see SetWallpaperScheduleRoute's doc comment on the Aurora side for the
 *  matching backend note). */
async function postWallpaperSchedule(entries) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetch(`${AURORA_BASE_URL}/photos/wallpaper/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entries),
      signal: controller.signal,
    });
  } catch (err) {
    // Best-effort, same reasoning as postAction().
  } finally {
    clearTimeout(timeout);
  }
  poll();
}

function setupWallpaperSettings() {
  const segmented = byId("wallpaper-mode-segmented");
  if (!segmented) return;

  segmented.addEventListener("click", (event) => {
    const btn = event.target.closest(".settings-segment");
    if (!btn) return;
    postAction(`/photos/wallpaper/mode?mode=${encodeURIComponent(btn.dataset.mode)}`).then(poll);
  });

  byId("wallpaper-photo-grid")?.addEventListener("click", (event) => {
    const thumb = event.target.closest(".settings-photo-thumb");
    if (!thumb) return;
    const photoId = thumb.dataset.photoId;
    if (lastWallpaperData?.wallpaperMode === "scheduled") {
      wallpaperPendingPhotoId = photoId;
      renderWallpaperPhotoGrid(lastWallpaperData);
    } else {
      postAction(`/photos/wallpaper/single?photoId=${encodeURIComponent(photoId)}`).then(poll);
    }
  });

  byId("wallpaper-schedule-add-btn")?.addEventListener("click", () => {
    const time = byId("wallpaper-schedule-time")?.value;
    if (!time || !wallpaperPendingPhotoId) return;
    const entries = [...(lastWallpaperData?.wallpaperSchedule || []), { photoId: wallpaperPendingPhotoId, time }].sort(
      (a, b) => a.time.localeCompare(b.time)
    );
    postWallpaperSchedule(entries);
  });

  byId("wallpaper-schedule-list")?.addEventListener("click", (event) => {
    const removeBtn = event.target.closest(".settings-schedule-remove");
    if (!removeBtn) return;
    const row = removeBtn.closest(".settings-schedule-row");
    const entries = (lastWallpaperData?.wallpaperSchedule || []).filter(
      (entry) => !(entry.photoId === row.dataset.photoId && entry.time === row.dataset.time)
    );
    postWallpaperSchedule(entries);
  });

  const blackToggle = byId("wallpaper-black-toggle");
  if (blackToggle) {
    blackToggle.setAttribute("aria-checked", String(wallpaperForcedBlack));
    blackToggle.addEventListener("click", () => {
      wallpaperForcedBlack = !wallpaperForcedBlack;
      blackToggle.setAttribute("aria-checked", String(wallpaperForcedBlack));
      localStorage.setItem(WALLPAPER_BLACK_KEY, String(wallpaperForcedBlack));
      if (wallpaperForcedBlack) {
        stopWallpaperRotation();
        clearWallpaperLayers();
        if (lastWeatherData) renderWeather(lastWeatherData);
      } else if (lastWallpaperData) {
        applyWallpaperMode(lastWallpaperData);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Weather Background settings (Settings page) - the write side of
// weatherBgManualOverride/weatherBgSchedule above. The effect grid +
// duration select are a shared "staging area" for both actions below
// them (Activate now / Schedule), the same shape as the wallpaper
// schedule's photo grid + time input + Add button.
// ---------------------------------------------------------------------------

let weatherBgSelectedEffect = "rain";

function weatherBgDurationLabel(duration) {
  if (duration === "restofday") return "Rest of day";
  if (duration === "indefinite") return "Indefinite";
  const minutes = parseInt(duration, 10) || 60;
  return minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} min`;
}

/** Same idea as currentMinutesInTimezone, in reverse - needed to show a
 *  manual override's expiry in the same timezone the rest of the clock
 *  uses, not the display's raw system time. */
function hhmmFromEpoch(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

function renderWeatherBgActiveHint() {
  const hint = byId("weatherbg-active-hint");
  const stopBtn = byId("weatherbg-stop-btn");
  if (!hint || !stopBtn) return;
  if (!weatherBgManualOverride) {
    hint.classList.add("hidden");
    stopBtn.classList.add("hidden");
    return;
  }
  const label = WEATHER_BG_EFFECT_LABELS[weatherBgManualOverride.effect] || weatherBgManualOverride.effect;
  const untilText =
    weatherBgManualOverride.expiresAt == null
      ? "indefinitely"
      : `until ${formatTimeOfDay(hhmmFromEpoch(weatherBgManualOverride.expiresAt, currentTimezone || undefined))}`;
  hint.textContent = `Forcing ${label} ${untilText}`;
  hint.classList.remove("hidden");
  stopBtn.classList.remove("hidden");
}

function renderWeatherBgSchedule() {
  const list = byId("weatherbg-schedule-list");
  if (!list) return;
  list.innerHTML = weatherBgSchedule
    .map((entry) => {
      const label = WEATHER_BG_EFFECT_LABELS[entry.effect] || entry.effect;
      return `<div class="settings-schedule-row" data-id="${escapeHtml(entry.id)}">
          <span class="settings-schedule-time">${escapeHtml(formatTimeOfDay(entry.time))} · ${escapeHtml(label)} · ${escapeHtml(weatherBgDurationLabel(entry.duration))}</span>
          <button class="settings-schedule-remove" type="button" aria-label="Remove scheduled entry">&times;</button>
        </div>`;
    })
    .join("");
}

function setupWeatherBgSettings() {
  const grid = byId("weatherbg-effect-grid");
  const durationSelect = byId("weatherbg-duration-select");
  if (!grid) return;

  grid.querySelectorAll(".weatherbg-effect-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.effect === weatherBgSelectedEffect);
  });
  renderWeatherBgActiveHint();
  renderWeatherBgSchedule();

  grid.addEventListener("click", (event) => {
    const btn = event.target.closest(".weatherbg-effect-btn");
    if (!btn) return;
    const effect = btn.dataset.effect;
    // "Auto" is an immediate action (go back to the real weather), not a
    // staged pick like every other button here - it has nothing to do
    // with the Activate/Schedule buttons below.
    if (effect === "auto") {
      stopWeatherBgOverride();
      renderWeatherBgActiveHint();
      return;
    }
    weatherBgSelectedEffect = effect;
    grid.querySelectorAll(".weatherbg-effect-btn").forEach((b) => b.classList.toggle("active", b.dataset.effect === effect));
  });

  byId("weatherbg-activate-btn")?.addEventListener("click", () => {
    activateWeatherBgOverride(weatherBgSelectedEffect, durationSelect?.value || "60");
    renderWeatherBgActiveHint();
  });

  byId("weatherbg-stop-btn")?.addEventListener("click", () => {
    stopWeatherBgOverride();
    renderWeatherBgActiveHint();
  });

  byId("weatherbg-schedule-add-btn")?.addEventListener("click", () => {
    const time = byId("weatherbg-schedule-time")?.value;
    if (!time) return;
    weatherBgSchedule = [
      ...weatherBgSchedule,
      { id: `${Date.now()}`, effect: weatherBgSelectedEffect, time, duration: durationSelect?.value || "60" },
    ].sort((a, b) => minutesFromHHMM(a.time) - minutesFromHHMM(b.time));
    saveWeatherBgSchedule();
    renderWeatherBgSchedule();
  });

  byId("weatherbg-schedule-list")?.addEventListener("click", (event) => {
    const removeBtn = event.target.closest(".settings-schedule-remove");
    if (!removeBtn) return;
    const id = removeBtn.closest(".settings-schedule-row")?.dataset.id;
    weatherBgSchedule = weatherBgSchedule.filter((entry) => entry.id !== id);
    saveWeatherBgSchedule();
    renderWeatherBgSchedule();
  });
}

async function enterAmbientMode() {
  if (document.body.classList.contains("bedside-active")) return;
  exitReadingMode();
  await ensureAmbientPhotosLoaded();

  byId("ambient-overlay")?.classList.remove("hidden");
  document.body.classList.add("ambient-active");
  document.documentElement.style.setProperty(
    "--ambient-brightness",
    String(AMBIENT_DEFAULT_BRIGHTNESS_PERCENT / 100)
  );

  byId("ambient-starfield")?.classList.toggle("active", ambientPhotoIds.length === 0);
  startAmbientPhotoCycle();
}

function exitAmbientMode() {
  byId("ambient-overlay")?.classList.add("hidden");
  document.body.classList.remove("ambient-active");
  stopAmbientPhotoCycle();
}

function isAmbientModeActive() {
  return !(byId("ambient-overlay")?.classList.contains("hidden") ?? true);
}

function resetAmbientIdleTimer() {
  clearTimeout(ambientIdleTimer);
  ambientIdleTimer = setTimeout(() => {
    if (!document.body.classList.contains("bedside-active")) enterAmbientMode();
  }, ambientIdleMinutes * 60 * 1000);
}

function setupAmbientTimeoutSetting() {
  const select = byId("settings-ambient-timeout");
  if (!select) return;
  select.value = String(ambientIdleMinutes);
  select.addEventListener("change", () => {
    ambientIdleMinutes = parseInt(select.value, 10) || 30;
    localStorage.setItem(AMBIENT_IDLE_TIMEOUT_KEY, String(ambientIdleMinutes));
  });
}

function setupAmbientMode() {
  if (!byId("ambient-overlay")) return;

  ["pointerdown", "keydown"].forEach((eventName) => {
    document.addEventListener(
      eventName,
      () => {
        if (isAmbientModeActive()) exitAmbientMode();
        resetAmbientIdleTimer();
      },
      { passive: true }
    );
  });

  resetAmbientIdleTimer();
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
  setupPageScrollEffect();
  setupThemePicker();
  setupBedsideMode();
  setupAmbientMode();
  setupSoundControls();
  setupWakeAlarmForm();
  setupWakeAlarmRingingControls();
  setupNotificationClearButtons();
  setupDndToggle();
  setupQuickDurationPopover();
  setupTimerPage();
  setupReadingMode();
  setupWeekView();
  renderSleepHistory();
  setupPrivacyToggle();
  setupNotificationAppToggles();
  setupRadar();
  setupManualRefresh();
  setupDimOffsetSlider();
  setupDimIntensitySlider();
  setupClockFormatSetting();
  setupTempUnitSetting();
  setupProfileSettings();
  setupStickyNote();
  setupSevereAlertDismiss();
  setupAutoBedsideSetting();
  setupBedsideAutoSoundSetting();
  setupWallpaperSettings();
  setupLayoutSettings();
  setupWeatherBgSettings();
  setupAmbientTimeoutSetting();
  setupHomeNetworkSettings();
  ensureSoundLibraryLoaded();
  // No explicit startWallpaperRotation() call here - applyWallpaperMode()
  // (called from renderDashboard, both for the cached render just above
  // and every live poll after) decides rotating/single/scheduled and
  // starts rotation itself when that's the mode in effect.
  startClock();
  startPolling();
}

/** Service workers require a secure context (https:, or http://localhost)
 *  and simply don't register at all under a file: origin - this
 *  dashboard's real deployment loads via a file:// startURL in Fully
 *  Kiosk, where register() rejects and this silently no-ops. Still worth
 *  calling unconditionally: local dev/testing and any future http(s)
 *  deployment get a cached app shell (survives a brief network drop,
 *  "Add to Home Screen"-installable) for free, and nothing breaks either
 *  way under file://. */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch(() => {
    // Expected under file: or any other unsupported context - nothing to
    // recover from, the dashboard works identically either way.
  });
}

document.addEventListener("DOMContentLoaded", init);
window.addEventListener("load", registerServiceWorker);
