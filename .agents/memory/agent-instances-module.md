---
name: Agent Instances module (سيرفرات الوكلاء)
description: Reseller deployment registry — domains, external DBs, license/heartbeat, branding, register-block. Invariants for extending it.
---

SA-only module: `agent_instances` + `agent_security_events` (routes/agentInstances.ts, screen pages/admin/AgentServers.tsx, /admin/agent-servers).

Rules:
- **Secrets are boolean-presence only.** DB URL / SSH secret are AES-GCM encrypted (lib/encryption.ts), write-only; API responses expose ONLY `dbUrlSet`/`sshSecretSet`. Never add `maskSecret` output to a response — review rejected even a 4-char masked tail of a connection string.
- **Heartbeat must validate ALL identity facets**: domain is required (missing domain = unknown_domain), and once a DB fingerprint is planted every heartbeat MUST present it. Optional checks = bypass.
- **Probes (test-db/init-db/test-ssh) run through `assertProbeTargetAllowed`** — blocks loopback/link-local/metadata + DNS-resolved re-check. Any new outbound probe path must reuse it (SSRF from SA panel into central infra).
- **Domain ownership is unique across main + extraDomains of ALL instances** (`findDomainConflict`); `lookupAgentByHost` (60s cache, `clearAgentHostCache()` after any domain/status write) is the single host→agent resolver, also used by the /register block and public `/api/branding`.
- /api/auth/register agent-domain block is a separate pre-handler middleware on the same path; superadmin bearer exempt; uses x-forwarded-host — same trust boundary as domainResolver.
- Fingerprint/license are HMAC(SESSION_SECRET)-derived and deterministic — re-derivable, never stored plaintext-secret.
- **Why:** agents get builds, never source; central API is the only logic holder, so every trust decision must be enforced server-side here.

Phase 2 (datasource routing) — done:
- `lib/db` exports `db`/`pool` as **AsyncLocalStorage proxies**: `runWithExternalDb(ctx, fn)` routes every db/pool usage in the async chain to an external PostgreSQL; `createExternalDb(url)` factory; `centralDb`/`centralPool` are the NON-proxied control-plane accessors.
- **Control-plane reads (agent registry, security events, host lookup, register guard) MUST use `centralDb`** — an agent's cloned DB has an empty registry, so proxied reads would silently disable suspend/register-block enforcement.
- `agentDataSourceRouter` (mounted after resolveDomainCompany): agent domain + active + dbStatus=initialized → whole request wrapped in runWithExternalDb; suspended → 403 (branding/heartbeat exempt). Pools cached per agent in lib/agentDb.ts keyed by encrypted URL blob; **evictAgentDb on URL change/delete/suspend**.
- init-db: fresh agent DB gets `pg_dump --schema-only` of central applied in ONE transaction (strip `\\`-meta lines — pg driver, not psql), then a NON-memoized heal pass `runSchemaHealOnActiveDb()` (ensureSchemaUpToDate is boot-single-flight and bound to central — never reuse it for external DBs). **Failure fails CLOSED: dbStatus=error + evict**, or routed traffic hits a half-built DB.
- /register accepts `agentInstanceId` (superadmin bearer ONLY → company created inside the agent DB); CompanyNew has a "وجهة إنشاء الشركة" selector.

Phase 3 (SSH deploy + setup kit) — done:
- `/:id/setup-kit` + `/:id/deploy`: generated idempotent root bootstrap (Caddy reverse proxy agent-domain→central origin, /opt/zacod config + heartbeat cron every 5min with 403→stop-caddy kill-switch). Bootstrap is HARD-FAIL: caddy install/validate/enable/is-active must all succeed before `ZACOD_BOOTSTRAP_DONE`; API stores ok only on exit 0 + marker.
- **Original-host proof**: edge proxies overwrite X-Forwarded-Host, so the deployed Caddyfile sends `X-Zacod-Agent-Host` + `X-Zacod-Agent-Token` = per-agent random 64-hex secret (encrypted at rest, rotatable via /:id/rotate-proxy-token, NEVER HMAC-derived from a shared key). `resolveAgentRequestHost` verifies via timingSafeEqual against the cached host hit; mismatch logs `proxy_token_mismatch` and falls back to standard headers.
- Deploy safety invariants: **domains are interpolated into a root shell heredoc + Caddyfile → assertSafeDomain (strict DNS regex) on create/update AND kit generation**; atomic deploy claim (conditional UPDATE, stale `deploying` >10min reclaimable); SSH output capped 64KB; **SSH host-key pinned** (TOFU on first successful deploy → sshHostKeyFp, mismatch aborts + security event); deploy failure fails closed to deployStatus=error.
- publicRow must keep stripping proxySecretEnc + sshHostKeyFp (presence flag proxyTokenSet only).

Brand identity UX: logo is stored as a data URL in brandLogoUrl but MUST travel as separate brandLogoB64+brandLogoMime fields (prod WAF blocks `data:` URIs in bodies; server rebuilds); edit-form save must re-split an echoed data URL the same way. Color palette + native picker in الهوية tab.

Email delivery: POST /:id/email-package emails the setup kit + license/install codes (+ schema-only db-init.sql for full_shell) via lib/email sendEmail attachments. Package holds agent secrets (proxy token, license key) → sending to an email ≠ stored contactEmail requires confirmOverride:true (409 needsConfirm otherwise), updates contactEmail, and both actions are audit-logged.

SA panel is FULLY blocked on agent domains, two layers: backend — agentDataSourceRouter stamps `req.agentDomainHit`, then blockSuperadminOnAgentDomains 404s `/admin/*` + `/auth/superadmin` (+ security event `sa_panel_blocked`); frontend — App.tsx useIsAgentDomain (module-cached /api/branding) forces rawIsSuperAdmin=false, hiding all SA routes/menus. The hook must stay ABOVE AppRoutes' early returns (hooks rule).

Deferred: cross-DB leak integration tests + ALS-inheritance audit for request-spawned background work.

Domain diagnostics: POST /:id/check-domains (read-only, no state writes) — per domain: assertProbeTargetAllowed, DNS, onServer = intersect(domain IPs, sshHost IPs), HTTPS liveness+latency. **The HTTPS probe must PIN the connection to the pre-validated IP via node:https custom `lookup` (servername=domain for SNI) — plain fetch re-resolves DNS = rebinding SSRF.** IP literals detected via net.isIP, never regex heuristics.

esbuild externals trap: api-server prod ships ONLY the bundle (no node_modules) — ssh2 was in build.mjs `external` → prod "Cannot find package 'ssh2'" while dev worked. ssh2 core is pure-JS: bundle it; keep "*.node"/"cpu-features" external (its optional native addons are try/catch-required). Any new dep used by provisioning must NOT be externalized unless truly unbundleable.

**Heartbeat kill-switch flap:** install writes config.json (step 3) BEFORE init-db plants the fingerprint (step 4) → heartbeat sends fingerprint:"" → 403 db_fingerprint_mismatch → kill-switch stops Caddy every 5 min while the watchdog restarts it (site flaps, Cloudflare 521). Fix: after init-db, sync the planted fingerprint into /opt/zacod/config.json over SSH + rm SUSPENDED; watchdog must skip when /opt/zacod/SUSPENDED exists. Diagnose by reading /tmp/zacod_hb.json on the server — "Stopped Caddy" every 5 min in journal = heartbeat 403, not a crash.

## Agent-hosted companies in SA admin screens
Companies on full_shell agents are merged into /api/companies tagged agentInstanceId/agentName; ids COLLIDE with central ids. Any SA screen managing them must (1) key selection/lookups by `${agentInstanceId??0}:${id}` composite, (2) send `?agent=<id>` on every write so the handler wraps in runWithAgentScope, (3) skip emitSessionRefresh when agent-scoped (it targets central sessions by numeric id). Missing the ?agent wrap surfaces as «الشركة غير موجودة» 404.
