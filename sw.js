// Caches the app shell (this same handful of static files) so a brief
// network drop doesn't blank the dashboard - everything actually shown
// (weather, Aurora's own /dashboard data) is fetched live, this only
// ever protects the shell that draws it. Deliberately leaves every
// cross-origin request (Open-Meteo, weather.gov, and Aurora's own LAN
// server on a different host:port) untouched below - those need to stay
// live, never cached.
//
// Note: service workers require a secure context (https:, or
// http://localhost) and don't register at all under a file: origin -
// this dashboard's real deployment on the Echo Show loads via a file://
// startURL in Fully Kiosk, where this file simply never activates. Still
// worth having: local dev/testing and any future http(s)-served
// deployment get the benefit for free, and a file:// deployment is
// entirely unaffected either way.

const CACHE_NAME = "aurora-dashboard-shell-v1";
const SHELL_FILES = [
  "./",
  "index.html",
  "style.css",
  "script.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Network-first, falling back to cache - a normal load always gets
// whatever's actually on the server (this dashboard is redeployed by
// overwriting these files directly, not through a build/version bump, so
// the cache should never be preferred over a reachable network), and the
// cached copy only ever kicks in once the network genuinely fails.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("index.html")))
  );
});
