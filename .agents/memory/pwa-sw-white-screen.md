---
name: PWA service-worker white-screen traps
description: Why a PWA web artifact shows a recurring blank white screen and how to make it impossible
---

# PWA service-worker recurring blank white screen

Two independent causes, both seen in `artifacts/pos-desktop`:

1. **`new URL(rel, base)` with a non-absolute base throws.** The inline SW
   registration used `new URL("sw.js", location.pathname)`. The 2nd arg MUST be
   an absolute URL — a bare path like `/pos-desktop/` throws
   `Failed to construct 'URL': Invalid base URL` on every load. Use
   `document.baseURI` (always absolute) and wrap the whole SW block in try/catch.

2. **A stale service worker serves an outdated app shell.** After redeploys the
   hashed JS chunks change; an old SW that cached the previous `index.html` keeps
   handing back a shell that points at deleted chunks → blank page. In the Replit
   dev/preview the SW also fights HMR ("server connection lost" loops).

**Why:** the user kept hitting a white screen that "comes back even in the future"
— it was the stale SW + the per-load URL exception, neither of which a code edit
to React components would fix.

**How to apply (canonical pattern for any PWA web artifact here):**
- Skip SW entirely in Tauri (`window.__TAURI__`).
- In dev/preview hosts (`localhost`, `127.0.0.1`, `*.replit.dev`, `*.repl.co`,
  host containing `picard`): `getRegistrations().then(unregister)` + `caches.keys().then(delete)`
  and DO NOT register. This purges any stale SW so the preview is always fresh.
- In production only: register via `new URL("sw.js", document.baseURI).href` inside
  a `load` listener, all inside try/catch.
- Bump the SW `CACHE_VERSION` whenever the shell changes so the `activate` handler
  evicts old caches on existing installs (it deletes every key !== current version).
- Add a root React `ErrorBoundary` (getDerivedStateFromError + componentDidCatch)
  wrapping `<App/>` in `main.tsx` so a render-time throw shows a fallback + reload
  button instead of a blank page. This is the universal "never white again" net.
