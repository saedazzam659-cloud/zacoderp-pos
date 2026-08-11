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

Deferred (phase 2+): per-request host→external-DB query routing, CompanyNew agent-domain field, SSH deploy engine.
