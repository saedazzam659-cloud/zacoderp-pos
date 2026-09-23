---
name: Agent-domain white-label branding
description: How agent domains get rebranded HTML/OG/manifest instead of زاكود
---
Rule: on registered agent domains (agent_instances.brand_name), the static index.html and PWA manifest must be rebranded server-side — client JS cannot fix WhatsApp/OG previews.

**How it works:**
- Public `GET /api/branding/manifest` (agentPublicRouter, covered by the `/branding` AGENT_PUBLIC_PATHS prefix) returns a rebranded webmanifest; falls back to Zacode branding, so it's always safe to reference.
- `app.ts` registers `app.get(["/","/index.html","/login","/register"])` BEFORE `/api`: agent host (via resolveAgentRequestHost + lookupAgentByHost) → serve rebranded built index.html (candidates near process.argv[1] `public/index.html`, cwd dist/public, sibling zatca-invoicing/dist/public). Non-agent host or missing file → next() (platform static serving). A missing index.html is cached only 60s, never forever.
- Client fallback: agentBranding.ts auto-fetches at module load and rewrites document.title, description/og/twitter metas, and swaps `<link rel=manifest>` to /api/branding/manifest.

**Why:** WhatsApp/Telegram crawlers read raw HTML; the platform's prod static layer is not in the repo, so express routes on non-file SPA paths are the only server-side lever.

- Agent «full» servers: the deployed bundle's static layer answers "/" and SPA paths BEFORE express — per-request rewrite never runs. Fix: `rebrandSpaIndexOnDiskForAgent()` at boot rewrites dist/public/index.html on disk (agent detected via /opt/zacod/config.json domain → lookupAgentByHost; atomic tmp+rename; idempotent; no-op on dev/central).

- Non-«full» agents (frontend_only/full_shell) proxy everything to central, where the static layer serves HTML before express AND the release channel refuses them (403 not_full_edition) — server/boot rewrites can never reach them. Fix: public `GET /api/branding/index?host=` returns the rebranded SPA index; agent Caddy serves `/opt/zacod/www/index.html` locally for GET / /index.html /login /register (matcher falls through to proxy when the file is absent), heartbeat cron refreshes it every 5 min. Existing agents need their setup kit re-run (new Caddyfile+heartbeat) — new installs get it automatically.

**Traps:**
- Brand replacement must be token-ordered longest-first (`زاكود المحاسبي` → `زاكود`, `Zacoderp` → `Zacod ERP` → `Zacode`) or "Zacoderp" degrades to "<brand>rp"; lowercase zacoderp.com URLs must stay intact.
- JSON-LD `<script type="application/ld+json">` blocks are DROPPED on agent domains — HTML-escaped replacements corrupt the JSON, and Zacode org schema is wrong for the brand anyway.
- The prod platform wrapper serves existing static files first; only non-file paths (/login etc.) are guaranteed to reach express — verify "/" behavior on a real agent domain after publish.
- On the central monorepo deployment, branded HTML must be read from the root web artifact before any API-bundle `dist/public` snapshot. Otherwise the branded index can reference a hash absent from the static artifact; the missing module falls through to `index.html` (`text/html`) and produces a white screen.
- The public floating WhatsApp contact is also host-owned: central domains keep the central number; a resolved agent domain uses only that agent instance's public contact phone. Missing/invalid agent phone means no button—never leak or fall back to the central number on an agent brand.

**Why:** the API release may carry its own frontend snapshot for external-agent installation, but central production serves `/assets/*` from the separately built web artifact.

**How to apply:** resolve the web artifact relative to both monorepo cwd and the API runtime directory, prefer it when present, and verify the branded index's main asset exists in that same web `dist/public`.

Independent full-agent branding must come from the configured controller's public display data, not from an assumed local copy of the central agent registry. Keep local SuperAdmin authorization separate from remote branding.

**Why:** An independent database can correctly have no central registry rows; the resulting local branding fallback omitted saved logos/names. Central public branding deliberately does not grant local SuperAdmin permissions, so copying its policy would disable local access.

**How to apply:** Use installer-owned controller/domain identity, cache display fields with bounded network failures, and retain local enablement/screens on every response. Support the existing uploaded base64 logo size, not merely URL-length limits. Existing runtimes need an app-only update, never a database restore for this change.
