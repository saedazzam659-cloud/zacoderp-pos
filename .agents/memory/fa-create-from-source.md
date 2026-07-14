---
name: FA create-from-source linkage
description: Rules for "create fixed asset from purchase invoice / JE" source linkage
---
- One LIVE asset per (company, source_type, source_document_id, COALESCE(source_line_id,0)) — partial unique index `uq_fixed_assets_source` excluding sold/scrapped. The index is created via ensureSchema extra step (indexes do NOT auto-propagate to prod like columns do).
- **Why:** app-level dup pre-check alone races; ensureSchema only reconciles columns/enums from the drizzle schema, never indexes.
- **How to apply:** any new "create X from doc" linkage needs (1) DB partial unique index registered in ensureSchema, (2) 23505/constraint-name → 409 mapping in the create route, (3) ownership validation: source doc must belong to the tenant AND sourceLineId must belong to that doc (else forged links can block unpost flows on other tenants' docs), (4) unpost routes of the source doc 409-block while a live linked asset exists.
- Sourced assets force skipAcquisitionJe (source doc already carries the GL — a second acquisition JE double-counts). Depreciation stays in the FA module.
- JE lines FK column is `entryId` (not journalEntryId).
