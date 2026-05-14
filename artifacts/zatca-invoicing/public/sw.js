// Minimal service worker — required for PWA "Add to Home Screen" prompt
// on Android/Chrome. Intentionally does NOT cache assets to avoid breaking
// app updates; a real fetch handler is required for installability.
self.addEventListener("install", (e) => {
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  // Network-first passthrough; do not intercept or cache anything.
  // Presence of this listener is enough to satisfy PWA install criteria.
  return;
});
