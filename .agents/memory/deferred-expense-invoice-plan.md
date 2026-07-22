---
name: Deferred-expense purchase-invoice plan
description: Item-group categoryType deferred_expense — split shape contract, post idempotency, amount basis
---

Purchase-invoice lines of item groups with `categoryType='deferred_expense'` carry a plan (start/end, periodicity, optional multi-cost-center % split) and, on post, auto-create ONE linked `accounting_adjustments` row (type prepaid) per line.

Rules:
- **Split shape is canonical `{costCenterId:int, pct:number}` end-to-end** — same contract as `parseCcSplit` in adjustmentPosting. Frontend dialog options key on cc **id** (display resolves id→code). Never send `{costCenter: code, percent}` — parse silently nulls it.
- **Why:** the adjustments engine stores the canonical shape and resolves codes only at run time; two shapes in flight = silently dropped splits.
- /post pre-validation must parseCcSplit + verify every id belongs to the tenant (present-but-invalid split blocks posting with an explicit message, no silent null).
- **Post race**: /post has many sequential writes without one tx — guarded by a process-local `Set` single-flight lock (api-server is single-process) + per-line skip when `deferredAdjustmentId` already set. Unpost deletes the adjustment and nulls the link, so repost re-creates cleanly.
- **Amount basis is qty-aware**: `finalCost || lineTotal || qty*unitPrice` — bare `unitPrice` ignores quantity.
