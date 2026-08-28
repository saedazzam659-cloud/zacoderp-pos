// Minimal service worker for the PWA install lifecycle. It deliberately has no
// fetch handler and no cache: all navigation/update freshness is owned by the
// server's Cache-Control policy.
self.addEventListener("install", (e) => {
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});
