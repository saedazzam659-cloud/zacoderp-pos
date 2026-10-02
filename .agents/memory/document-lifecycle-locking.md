---
name: Document lifecycle locking
description: Cross-process serialization rules for posting, issuing, cancellation, and restoration of financial documents.
---

Use a PostgreSQL advisory lock keyed by mutation type, company, and document ID for every multi-query posting or lifecycle path. A local in-process queue is only an optimization; it is not the cross-instance safety mechanism. Keep database row locks and conditional updates inside transactional handlers.

Keep the cancel/restore feature limited to the document families already surfaced in Posting Center. Do not expand it to quotations or settlement workflows without a new explicit request.

**Why:** A status check by itself cannot prevent an older multi-query posting handler from racing cancellation and creating ledger, inventory, or fiscal side effects after the document is cancelled.

**How to apply:** Posting, issuing, editing, cancelling, and restoring the same document must use the exact same lock type/company/document key. When a source document also changes its linked journal entry, acquire the journal-entry lock while holding the source lock and keep the existing transaction and row locks. Keep other document families on their existing workflows. The helper reserves a pool connection while the handler runs, so database pools used by these routes need at least two available connections; if a one-connection pool is required, redesign the lock/query execution together.

**Why:** The user confirmed that this release should cover only the current Posting Center families; broadening to additional business documents could bypass their separate dependencies or fiscal correction paths.