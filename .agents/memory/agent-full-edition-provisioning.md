---
name: Agent full edition + one-click provisioning
description: Invariants for the «نسخة كاملة» agent edition, its release/update channel, and the SSH provision pipeline.
---

## Editions
`agent_instances.mode`: `frontend_only`, `full_shell`, `full`. `full` runs the whole api-server bundle locally on the agent server (systemd `zacod-app` on 127.0.0.1:8080, Caddy fronting it); the other two are served from central.

## Release channel
- `lib/agentRelease.ts` tars the server's OWN `dist/` (version = sha256(index.mjs)[:16]) → every central Publish is automatically a new agent release. `dist/public/` SPA assets ride along only in the PRODUCTION build — dev dist has no UI, so full-edition install tests must pull from prod.
- Public routes `/api/agent/release/manifest|bundle` auth by installationId+licenseKey and require mode=full, status=active, unexpired license — the kill-switch also stops updates. Updater = cron every 10 min comparing manifest version; heredoc for the updater must stay quoted (`<<'ZACOD_UPD'`).

## Provision pipeline invariants
**Why:** code-review found root shell-injection + races on first pass.
- Everything interpolated into root SSH scripts must pass `assertShellSafeHostLike` (host/domain) or `assertShellSafeDbUrl`; never rely on shQ alone for values inside unquoted heredocs.
- Claim (`deployStatus='deploying'` conditional UPDATE, 30-min stale reclaim) must happen BEFORE license auto-mint, then re-read the row — otherwise a concurrent request overwrites the key the pipeline uses and release downloads 403.
- UI: deploy + init-db + provision buttons all disable while `deployStatus==="deploying"` (they share the lease).
- Full-mode app env uses a LOOPBACK DATABASE_URL (rewrite host→127.0.0.1, drop sslmode); central keeps the public URL because schema init/fingerprint run from central — that is why the agent Postgres is remotely reachable (scram + strong hex password). Tightening exposure = known follow-up.
- Progress streams into deployLog (reused column, no DDL); UI polls the list every 3s while deploying.
