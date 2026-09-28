---
name: Batch reporting boundary
description: Preserve optional tracking and historical uncertainty when extending batch and expiry reports.
---

Batch reporting must reuse existing stock-ledger attribution and manufacturing batch identifiers, without introducing a parallel tracking subsystem or changing posting, costing, or expiry-sale policy.

**Why:** The approved scope is reporting and unification without disrupting existing document cycles. Historical untagged movements cannot be attributed reliably by matching names or document numbers.

**How to apply:** Keep missing batch identities explicit, retain negative and exhausted buckets in historical reports, and distinguish on-hand expiry views from full history. Do not silently backfill old movements, enforce mandatory batch capture, or block expired sales as part of a reporting change.