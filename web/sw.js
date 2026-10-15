// Offline support. The app shell is cached on install; the menu is fetched fresh when online
// and falls back to the last copy when Phelps Wi-Fi drops out.
// The deploy workflow replaces VERSION with the commit hash so phones pick up new versions.
const VERSION = "v1";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "config.js",
  "cloud.js",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;

  if (url.pathname.endsWith("/phelps_menu.json")) {
    // Network first, so the menu is never stale when there's a connection.
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request)));
    return;
  }

  // Shell: cache first, then network.
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request)));
});
