---
name: Local visual capture routing
description: How authenticated browser captures reach both an artifact frontend and the shared API server locally.
---

For browser-based visual verification in this monorepo, use the shared local proxy on port 80 when the capture needs both the frontend artifact and API routes. The visual script's default port 19225 is the Vite server itself and does not proxy general `/api/*` requests. An explicit `http://127.0.0.1:80` is normalized by `URL` as the default HTTP port, so set `VISUAL_WEB_PORT=80` as well as `VISUAL_BASE_URL=http://127.0.0.1`.

**Why:** Direct Vite access served the SPA for API paths and broke fixture login; the shared proxy routed the real login and authenticated API requests correctly.

**How to apply:** When using `simple-manufacturing-visual.ts` locally, set `VISUAL_ALLOW_DEV_DB=1`, `VISUAL_BASE_URL=http://127.0.0.1`, and `VISUAL_WEB_PORT=80`; use the installed Chromium path if Playwright's bundled browser is unavailable.