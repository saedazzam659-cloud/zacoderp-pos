// ZACOD POS — basic service worker for PWA installability.
//
// Cache strategy:
//   • App shell (index.html, main JS/CSS): network-first → fall back to cache
//   • Assets in /assets/* (Vite-hashed, immutable): cache-first
//   • API calls (/api/*): network-only (POS data must be fresh)
//
// Versioning: bump CACHE_VERSION whenever shipping a layout change so old
// cached shells get evicted on next visit.

const CACHE_VERSION = "zacod-pos-v0.2.2";
const APP_SHELL = ["./", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {
      /* ignore — installs proceed even if pre-cache fails (offline first visit) */
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // API calls always go to network — never cache POS data
  if (url.pathname.startsWith("/api/")) return;

  // Cache-first for hashed Vite assets (immutable)
  if (url.pathname.includes("/assets/")) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      })),
    );
    return;
  }

  // Network-first for everything else (app shell)
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./"))),
  );
});
