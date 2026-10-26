---
name: Company-specific invoice import formats
description: Keep source invoice layouts company-specific while sharing the safe normalized historical-import flow.
---

Each ERP company may receive invoices in a different source layout. Keep each format profile or parser isolated and normalize its output into the existing historical invoice row contract. Preserve review, validation, existing-master matching, and the common commit flow; do not change generic data import/export behavior to accommodate one source layout.

Large uploads should use a bounded queue with visible progress and per-file failures. Preserve successful extractions for review, stop cleanly when a configured AI quota is reached, and never post imported documents without the existing confirmation path.

**Why:** The user stated that every company will have its own way of uploading invoices and asked to process 500 or more PDFs from one format in a single selection without losing the shared invoice table.

**How to apply:** When supporting another source layout, add a selectable/company-scoped adapter that emits the canonical invoice fields. Keep source mapping isolated, make partial batch failures explicit, and leave the general data import/export module unchanged.
