/**
 * Aurora Dashboard
 *
 * Vanilla JS, no build step, no framework. Two independent update loops:
 *  - the clock ticks every second, driven by the device's own local time
 *  - the Aurora poll runs every 30s and re-renders the four data cards
 *
 * FUTURE EXPANSION: to add a new data-driven card (Wi-Fi, volume mode,
 * morning greeting, quote of the day, smart home controls, ...):
 *   1. Add a <section class="card"> to index.html with its own ids.
 *   2. Add one renderX(data.x) function below, next to the others.
 *   3. Call it from renderDashboard().
 * The polling/caching/connection-status machinery is already generic over
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

// After this many consecutive failed polls, the connection-status pill
// switches from "reconnecting" to a more visible "offline" state.
const OFFLINE_AFTER_FAILURES = 3;

const CACHE_KEY = "aurora-dashboard:last-good-response";
const HOST_OVERRIDE_KEY = "aurora-dashboard:host-override";

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

/** Calendar event titles come from the phone's calendar - untrusted user
 *  data - so escape before dropping anything into innerHTML. */
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
const WEATHER_ICONS = {
  Clear: "☀️",
  "Partly Cloudy": "⛅",
  Overcast: "☁️",
  Fog: "🌫️",
  Drizzle: "🌦️",
  Rain: "🌧️",
  "Rain Showers": "🌦️",
  Snow: "❄️",
  "Snow Showers": "🌨️",
  Thunderstorm: "⛈️",
};

function weatherIconFor(condition) {
  return WEATHER_ICONS[condition] || "🌡️";
}

// ---------------------------------------------------------------------------
// Clock - independent of the Aurora poll loop, ticks every second
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

  setText("clock-time", `${hour}:${minute} ${period}`);
  setText("clock-weekday", WEEKDAY_NAMES[now.getDay()]);
  setText("clock-monthday", `${MONTH_NAMES[now.getMonth()]} ${now.getDate()}`);
}

function startClock() {
  updateClock();
  setInterval(updateClock, 1000);
}

// ---------------------------------------------------------------------------
// Rendering - one function per card. Each takes its own slice of the
// /dashboard response and safely no-ops on missing/null data.
// ---------------------------------------------------------------------------

function renderWeather(weather) {
  if (!weather) {
    setText("weather-icon", "–");
    setText("weather-temp", "--°");
    setText("weather-condition", "No data");
    setText("weather-high", "--°");
    setText("weather-low", "--°");
    return;
  }

  setText("weather-icon", weatherIconFor(weather.condition));
  setText("weather-temp", `${Math.round(weather.temperature)}°`);
  setText("weather-condition", weather.condition);
  setText("weather-high", `${Math.round(weather.high)}°`);
  setText("weather-low", `${Math.round(weather.low)}°`);
}

function renderPhone(battery, charging, notifications) {
  setText("phone-battery-level", `${battery}%`);
  setText("phone-battery-icon", charging ? "🔌" : "🔋");
  setText("phone-charging", charging ? "Charging" : "Not charging");
  setText(
    "phone-notif-count",
    `${notifications} notification${notifications === 1 ? "" : "s"}`
  );
}

function renderSchedule(events) {
  const list = byId("schedule-list");
  if (!list) return;

  if (!events || events.length === 0) {
    list.innerHTML = '<li class="schedule-empty">No events</li>';
    return;
  }

  list.innerHTML = events
    .map((event) => {
      const time = escapeHtml(event.allDay ? "All day" : formatTime12h(event.start));
      const title = escapeHtml(event.title || "Untitled");
      return `<li class="schedule-item">
        <span class="schedule-time">${time}</span>
        <span class="schedule-title">${title}</span>
      </li>`;
    })
    .join("");
}

function renderAlarm(nextAlarm) {
  setText("alarm-time", nextAlarm ? formatTime12h(nextAlarm.time) : "No alarm");
}

function renderDashboard(data) {
  renderWeather(data.weather);
  renderPhone(data.battery, data.charging, data.notifications);
  renderSchedule(data.calendar);
  renderAlarm(data.nextAlarm);
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
// Connection status - quiet by design, see style.css
// ---------------------------------------------------------------------------

function setConnectionState(state, message) {
  const el = byId("connection-status");
  const textEl = byId("connection-text");
  if (!el || !textEl) return;

  el.classList.remove("state-reconnecting", "state-offline", "visible");

  if (state === "connected") {
    return; // fresh data: no need to draw attention to the status pill
  }

  textEl.textContent = message;
  el.classList.add("visible");
  el.classList.add(state === "offline" ? "state-offline" : "state-reconnecting");
}

// ---------------------------------------------------------------------------
// Aurora polling
// ---------------------------------------------------------------------------

let consecutiveFailures = 0;

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
    saveCache(data);
    renderDashboard(data);
    setConnectionState("connected");
  } catch (err) {
    consecutiveFailures += 1;

    if (consecutiveFailures < OFFLINE_AFTER_FAILURES) {
      setConnectionState("reconnecting", "Reconnecting to Aurora…");
      return;
    }

    const cached = loadCache();
    setConnectionState(
      "offline",
      cached
        ? `Offline - showing data from ${formatRelativeTime(cached.savedAt)}`
        : "Offline - no data yet"
    );
  }
}

function startPolling() {
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  const cached = loadCache();
  if (cached) {
    renderDashboard(cached.data);
  }

  startClock();
  startPolling();
}

document.addEventListener("DOMContentLoaded", init);
