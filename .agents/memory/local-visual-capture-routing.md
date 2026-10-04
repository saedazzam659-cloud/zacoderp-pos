---
name: Local visual capture routing
description: How authenticated browser captures reach both an artifact frontend and the shared API server locally.
---

For browser-based visual verification in this monorepo, use the shared local proxy on port 80 when the capture needs both the frontend artifact and API routes. The visual script's default port 19225 is the Vite server itself and does not proxy general `/api/*` requests. An explicit `http://127.0.0.1:80` is normalized by `URL` as the default HTTP port, so set `VISUAL_WEB_PORT=80` as well as `VISUAL_BASE_URL=http://127.0.0.1`.

**Why:** Direct Vite access served the SPA for API paths and broke fixture login; the shared proxy routed the real login and authenticated API requests correctly.

**How to apply:** When using a local browser capture that needs authenticated API routes, set `VISUAL_ALLOW_DEV_DB=1`, `VISUAL_BASE_URL=http://127.0.0.1`, and `VISUAL_WEB_PORT=80`; use the installed Chromium path if Playwright's bundled browser is unavailable.

For disposable capture tenants, cleanup must prove ownership using the unique company, admin, and child-row markers. Permit the expected partial state where capture failed before creating its warehouse; delete the warehouse only when exactly one matching owned row exists, then delete the exact branch and company. Remove only audit/session rows scoped to that company. Any mismatch must stop cleanup rather than widen the delete.

**Why:** A browser capture can fail after creating its company and branch but before warehouse setup. Cleanup that assumes every child exists leaves an orphan; broad cleanup risks unrelated tenant data.

**How to apply:** Make capture teardown idempotent across each expected partial setup stage, verify affected-row counts, and fail closed when ownership or child markers do not match.