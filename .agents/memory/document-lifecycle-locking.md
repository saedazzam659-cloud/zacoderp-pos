---
name: Document lifecycle locking
description: Cross-process serialization rules for posting, issuing, cancellation, and restoration of financial documents.
---

Use a PostgreSQL advisory lock keyed by mutation type, company, and document ID for every multi-query posting or lifecycle path. A local in-process queue is only an optimization; it is not the cross-instance safety mechanism. Keep database row locks and conditional updates inside transactional handlers.

**Why:** A status check by itself cannot prevent an older multi-query posting handler from racing cancellation and creating ledger, inventory, or fiscal side effects after the document is cancelled.

**How to apply:** Posting, issuing, editing, cancelling, and restoring the same document must use the exact same lock type/company/document key. When a source document also changes its linked journal entry, acquire the journal-entry lock while holding the source lock and keep the existing transaction and row locks. The helper reserves a pool connection while the handler runs, so database pools used by these routes need at least two available connections; if a one-connection pool is required, redesign the lock/query execution together.