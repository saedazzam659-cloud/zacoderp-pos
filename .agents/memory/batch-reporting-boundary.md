---
name: Batch reporting boundary
description: Preserve optional tracking and historical uncertainty when extending batch and expiry reports.
---

Batch reporting must reuse existing stock-ledger attribution and manufacturing batch identifiers, without introducing a parallel tracking subsystem or changing posting, costing, or expiry-sale policy.

**Why:** The approved scope is reporting and unification without disrupting existing document cycles. Historical untagged movements cannot be attributed reliably by matching names or document numbers.

**How to apply:** Keep missing batch identities explicit, retain negative and exhausted buckets in historical reports, and distinguish on-hand expiry views from full history. Do not silently backfill old movements, enforce mandatory batch capture, or block expired sales as part of a reporting change.

Purchase invoice forms already capture optional batch numbers and expiry dates. Preserve those recorded values in single-invoice and detailed bulk printouts; show only the saved values and never infer missing historical lot data.

**Why:** Users need the receiving document to carry the same traceability details entered on its stock lines, while old untagged stock must remain explicitly unknown.

**How to apply:** When changing purchase invoice print templates, include the line's actual batch number and expiry date when present, and leave either detail blank when it was not recorded.