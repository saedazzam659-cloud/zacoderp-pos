---
name: Extension Platform Publish Engine
description: Phase-3 one-click publish pipeline — staged blocking gates, no-code-ingest invariant, AI fallback
---

The publish pipeline (`artifacts/api-server/src/extensions/publish.ts`, routes
`/api/admin/publish/*`, SuperAdmin-only) runs fixed staged gates:
build → security_scan → ai_review → package → sign → deploy → monitor.
Blocking gates = build, security_scan, ai_review, sign. A blocking fail halts the
pipeline and never deploys; a clear `report.errors` + `report.blockedAt` is returned.
Runs persist to `extension_publishes`; every run writes an audit_log row.

**Core invariant — never ingest code.** The engine validates/signs/deploys only the
DECLARATIVE manifest. Executable handlers stay in the in-process BUILTINS map
(registry.ts). A deployed manifest with no matching builtin handler is intentionally
a `deploy:warn` (declarative-only), NOT a hard fail.

**security_scan IS the privilege-escalation guard.** It validates every requested
`resource:action` permission against the live `listCoreResources()` registry
(coreDataApi.ts), not just the manifest schema. An unknown resource or an action the
resource doesn't allow HARD-fails the scan. It also scans ALL manifest strings for
dangerous patterns (`<script`, `javascript:`, `eval(`, `../`, etc.).
**Why:** the schema's `.max()`/regex can't know which resources actually exist, so
schema-valid-but-over-privileged manifests must be caught here.

**ai_review must fall back to rule-based.** `isAIAvailable()`/`chatJSON` can 503 (it
does, often, on the Gemini proxy). The gate uses a deterministic rule-based verdict
(`ruleBasedReview`) whenever AI is unavailable or returns junk, so an AI outage can
never block all publishes. Only a `verdict==="reject"` blocks.
**Why:** without the fallback, every publish would fail whenever the AI proxy is down.

**How to apply:** when adding a new core resource, the security_scan gate auto-picks it
up via `listCoreResources()` — no change needed. When adding a new gate, decide
blocking vs non-blocking by adding (or not) its stage to `BLOCKING_STAGES`.
