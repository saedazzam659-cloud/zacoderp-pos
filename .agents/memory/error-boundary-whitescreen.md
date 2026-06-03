---
name: Global ErrorBoundary prevents white-screen
description: Why the zatca-invoicing web app must keep a top-level ErrorBoundary
---

# Global ErrorBoundary is mandatory

The zatca-invoicing React app mounts `<App/>` wrapped in a top-level
`ErrorBoundary` (in `main.tsx`). Keep it there.

**Why:** The app previously had NO error boundary anywhere. A single render
error in any component (e.g. an authenticated-only path like the dashboard
inside `Layout`) unmounted the whole tree and showed a **blank white page** with
zero on-screen diagnostics. In production this looked like a total outage for
logged-in users while the logged-out landing page still rendered — making it
very hard to diagnose because the crash was invisible.

**How to apply:**
- Never remove the `ErrorBoundary` wrapper around `<App/>`.
- The boundary renders the real `error.message` + component stack on screen
  (RTL Arabic) so production crashes are visible and screenshot-able instead of
  blanking. When debugging a "blank page after login" report, the boundary's
  on-screen text is the fastest source of the actual error.
- A blank page that renders logged-out but blanks logged-in points at the
  authenticated render path (Layout/Dashboard + the libs they call at render:
  permissions.ts, companyModuleGate.ts, menuItems.ts), not at chunk-404/cache.
