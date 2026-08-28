---
name: Full-agent manual update policy
description: Operational rules for announcing, approving, installing, and rolling back updates on multi-tenant full-agent servers.
---

Central publishing must only make a full-agent release available. It must never download, install, or restart an agent server automatically. Only the local agent-server superadmin may explicitly confirm installation; ordinary company users keep the frontend cache-refresh behavior.

Existing legacy agents move to this model once, during a maintenance window approved by that agent's administrator. Until migrated, their old manifest poll receives no version metadata, so it exits before download or restart.

Every approved update is tied to the complete release archive, authenticated without URL credentials, size/hash verified before swap, and health-checked after restart. A failed new release must automatically restore and start the previous release.

The update must also reconcile the managed Caddy SPA fallback and retain exactly one previous generation of native Vite assets. The client may reload once on `vite:preloadError`; a repeated error must reach the visible global error boundary rather than loop.

**Why:** one agent service hosts multiple companies, so an automatic central restart interrupts unrelated users. Also, an already-open browser can request an old lazy chunk after the atomic directory swap; deleting it immediately leaves that route blank even when Caddy deep-link fallback is correct.

**How to apply:** preserve the explicit local confirmation boundary in every full-agent release path, including custom uploaded packages; never reintroduce updater cron jobs or publish-triggered restarts. Keep only the immediately previous native asset generation so compatibility does not accumulate indefinitely.