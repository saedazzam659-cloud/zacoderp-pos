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

**Traps:**
- Brand replacement must be token-ordered longest-first (`زاكود المحاسبي` → `زاكود`, `Zacoderp` → `Zacod ERP` → `Zacode`) or "Zacoderp" degrades to "<brand>rp"; lowercase zacoderp.com URLs must stay intact.
- JSON-LD `<script type="application/ld+json">` blocks are DROPPED on agent domains — HTML-escaped replacements corrupt the JSON, and Zacode org schema is wrong for the brand anyway.
- The prod platform wrapper serves existing static files first; only non-file paths (/login etc.) are guaranteed to reach express — verify "/" behavior on a real agent domain after publish.
