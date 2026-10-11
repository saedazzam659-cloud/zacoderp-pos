---
name: External DB storage routing
description: External Postgres routing boundaries and schema-heal constraints for agent databases
---

- SA screen «قواعد البيانات الخارجية» (/admin/external-databases) + api routes `/api/admin/external-databases` (extractAuth + explicit superadmin check — router-level, domains.ts pattern).
- `external_databases` + `storage_routings` tables are NOT created by ensureSchema (it only adds COLUMNS to existing tables; missing tables just warn). They are created lazily by `ensureExternalDbTables()` (CREATE TABLE IF NOT EXISTS on central) — keep that in place for prod.
- Conn strings: AES-256-GCM (`extdb1:` prefix, key = sha256(SESSION_SECRET+"::extdb")), write-only; API returns only a redacted host/db display. **Why:** secrets never leave the server (agent-instances rule).
- `getRoutedDb(moduleKey)` (api-server lib/externalDbRouting.ts) returns the routed drizzle instance or the plain proxied `db` when unrouted (so agent-DB ALS contexts keep working). Fails CLOSED if a routing points to a missing DB. **How to apply:** every consumer of a routed table must go through it — document_archives has TWO consumers: document-archives.ts AND delivery-receipt-documents.ts attachmentCount.
- Migrate = two-pass batched copy (full + delta) with ON CONFLICT (id) DO NOTHING + setval + count-verify before flipping routing. External→external rerouting is rejected (go central first). Routing back to central intentionally leaves data on the external DB (SA-confirmed flow).
- Company archive POLICY (companies.archive_settings) always reads central; only document_archives rows are routed. Core tables/SA panel never routable by design (user requirement).

Required business tables in externally routed agent databases should have complete, idempotent DDL in the shared pre-validation heal. Generic schema reconciliation adds columns to existing tables; request readiness is strict by default. Cached ensure promises must remain scoped by active database context.

One owner-approved exception applies to a single designated registry ID on the agent-domain request path: missing tables may be logged and tolerated so an unrelated new table cannot block all ERP traffic. For that same agent only, a failed retry of initialization may preserve existing availability when the exact registered installation ID and fingerprint are re-verified against its DB; first setup, unreachable DBs, identity mismatches, and other agents remain fail-closed. A feature that needs an absent table may still fail until its migration runs.

**Why:** The owner requires the designated agent's existing companies to remain available across central Publish, even if a retry of initialization fails. Preserving service is safe only while the DB proves the same installation and fingerprint; otherwise fail-closed identity protection takes priority.

**How to apply:** Resolve the exception through the authoritative agent registry. Tolerate missing tables only during request readiness; after a failed re-init, preserve the initialized status only after verifying the same registered DB identity and fingerprint. Keep first initialization fail-closed, do not generalize this to other agents, and preserve diagnostics.
