---
name: Adjustment JE branch bucket
description: Auto-generated JEs must issue numbers from the company's real branch counter, resolved date-aware per sequence.
---

Rule: any auto-generated JE (adjustments, schedulers) calling `nextSequenceNumber` with `branchId: null` draws from the branch-0 sentinel bucket — a FRESH counter starting at 0001 — while the tenant's manual JE stream lives on a real-branch counter (e.g. QYD-1258). Numbers fork into a parallel series.

**Why:** prepaid/accrued adjustment JEs came out QYD-0004… while the company's real series was at QYD-1258 (2025) / QYD/07/2027 (2026).

**How to apply:** use `resolveJeIssuingBranch(cid, docDate)` (adjustmentPosting.ts). It must be DATE-AWARE: first mirror the engine's sequence selection (fiscal-period-scoped sequence for the doc date wins over universal, ties by lowest id), then pick the branch bucket with the highest `current_number` within THAT sequence only. A global max across all sequences picks the wrong branch in multi-branch/period-scoped setups. Counter value = NEXT number to issue (not last used).
