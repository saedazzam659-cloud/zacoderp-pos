# Durable memory indexes
- [Contracting accounting boundaries](contracting-accounting-boundaries.md) — optional cost-center snapshots, planning versus posting, and preservation of existing customer/bill data.

- [POS Desktop index](pos-desktop-index.md) — POS Desktop shell, local data, fiscal, inventory, printing, licensing, and offline/ZATCA implementation notes.
- [Accounting and ZATCA index](accounting-zatca-index.md) — accounting, numbering, settlement, reports, documents, imports, and ZATCA implementation notes.
- [Platform and security index](platform-ops-index.md) — tenant isolation, permissions, agents, mobile/HR, storage, infrastructure, and operational safeguards.
- [Web and shared UI index](web-shared-index.md) — browser forms, shared UI, dates, catalog, reports, and cross-cutting web behavior.
- [Invoice save retries](invoice-save-retry-safety.md) — stable per-form keys, immediate persisted-ID capture, and atomic finalized replay prevent repeated-save duplicates.
- [Web sale unpost provenance](web-sales-unpost-provenance.md) — preserve immutable costing references with compensating stock movements and shared balance locks.
- [OpenAPI generator compatibility](openapi-generator-compatibility.md) — external path-item references can fail bundling; use inline path items in the canonical spec.
- [Browser readiness](browser-readiness.md) — authenticated realtime connections require control-based waits, not network idleness.
- [New company defaults](new-company-defaults-boundary.md) — creation-only settings; never reset existing tenants or split shared document-number namespaces.