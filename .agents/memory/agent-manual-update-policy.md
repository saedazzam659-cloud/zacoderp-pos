---
name: Full-agent manual update policy
description: Operational rules for announcing, approving, installing, and rolling back updates on multi-tenant full-agent servers.
---

Central publishing must only make a full-agent release available. It must never download, install, or restart an agent server automatically. Only the local agent-server superadmin may explicitly confirm installation; ordinary company users keep the frontend cache-refresh behavior.

Existing legacy agents move to this model once, during a maintenance window approved by that agent's administrator. Until migrated, their old manifest poll receives no version metadata, so it exits before download or restart.

Every approved update is tied to the complete release archive, authenticated without URL credentials, size/hash verified before swap, and health-checked after restart. A failed new release must automatically restore and start the previous release.

**Why:** one agent service hosts multiple companies, so an automatic central restart interrupts unrelated users and cannot be treated like a per-browser cache update.

**How to apply:** preserve the explicit local confirmation boundary in every future full-agent release path, including custom uploaded packages; never reintroduce updater cron jobs or publish-triggered restarts.