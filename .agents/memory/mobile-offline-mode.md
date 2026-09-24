---
name: Mobile offline mode
description: Expo companion app offline layer — AsyncStorage cache + outbox; scoping and data-safety invariants.
---

`artifacts/mobile/lib/offline.ts` + hooks in `lib/api.ts` (network-failure fallback + refresh-cache-on-GET-success), toggle/sync UI in more.tsx, AppState+60s sync in _layout.tsx.

Invariants (from architect review — keep on any change):
- **Scope every cache/outbox key by server domain + FULL path incl. query** (query carries companyId). Never strip the query from the cache key or tenants mix on one device.
- **Cached GETs are exact list paths only** (no /:id) — otherwise a list is returned where a document is expected.
- **Never silently drop outbox entries.** Server-rejected ops get `tries`; after 5 they're marked `failed` and KEPT for manual review (UI shows count + explicit destructive discard). Network failure (status 0) stops the pass and keeps everything.
- Outbox bodies carry `offlineOpId` for traceability/future server dedupe.
- Intentional logout/server switching must block while pending or failed financial operations remain; never silently discard them. Clear remaining offline cache only after that guard for multi-user safety.
- `syncOutbox` is single-flight; queueable POSTs are whitelisted (sales-invoices, receipt-vouchers, customers) — a queued create returns `{ id: null, offline: true, ... }`, callers must tolerate null id.

**Why:** offline financial ops are irrecoverable if dropped, and shared caches are a cross-tenant leak.
