---
name: Deferred-expense purchase-invoice plan
description: Item-group categoryType deferred_expense — split shape contract, post idempotency, amount basis
---

Purchase-invoice lines of item groups with `categoryType='deferred_expense'` carry a plan (start/end, periodicity, optional multi-cost-center % split) and, on post, auto-create ONE linked `accounting_adjustments` row (type prepaid) per line.

Rules:
- **Split shape is canonical `{costCenterId:int, pct:number}` end-to-end** — same contract as `parseCcSplit` in adjustmentPosting. Frontend dialog options key on cc **id** (display resolves id→code). Never send `{costCenter: code, percent}` — parse silently nulls it.
- **Why:** the adjustments engine stores the canonical shape and resolves codes only at run time; two shapes in flight = silently dropped splits.
- /post pre-validation must parseCcSplit + verify every id belongs to the tenant (present-but-invalid split blocks posting with an explicit message, no silent null).
- **Post race**: /post has many sequential writes without one tx — guarded by a process-local `Set` single-flight lock (api-server is single-process) + per-line skip when `deferredAdjustmentId` already set.
- **Unpost/repost lifecycle (sequence-preserving)**: unpost with existing runs DOES NOT delete — it flips run JEs to DRAFT (docNumbers + run rows + adjustments + line links kept) AND sets `autoGenerate=false` (freezes the hourly adj-auto scheduler while the invoice is a draft). Run-less adjustments are still deleted. Repost flips line-linked adjustments' draft run JEs back to posted, restores `autoGenerate=true`, then calls `runDueAdjustmentsForCompany` per adjustment (due months auto-generate+post right after invoice post; failures collected into `adjustmentRunWarnings` on the 200 response, surfaced as destructive toasts).
- **Line-orphan guard**: PUT rebuilds lines wholesale — old `{itemId, deferredAdjustmentId}` links are captured pre-delete and re-attached to the first unclaimed same-item deferred line. On repost, source-linked adjustments NOT referenced by any current line are CANCELLED (+autoGenerate=false), never re-run — else a removed deferred line would keep posting monthly JEs.
- **Amount basis is qty-aware**: `finalCost || lineTotal || qty*unitPrice` — bare `unitPrice` ignores quantity.
- **itemType `prepaid_expense` (مصروف مقدم)** exists in the `item_type` pg enum; it must be treated as NON-STOCK everywhere `itemType === "service"` is checked — backend purchase post, sales invoice post, sales return post, and the purchase/sales form line helpers. Adding another non-stock type means touching ALL of those spots (grep `=== "service"` in routes + forms).
- **Item-group default cost/revenue accounts** are persisted by the group POST/PUT via `parseGroupDefaultAccounts` (tenant-validated); the deferred posting expense fallback is `item.costAccountId ?? group.costAccountId`.
- **Combobox id trap**: SearchCombobox option values are strings — edit-loaders must `String()` numeric ids (groupId/unitId) or the picker shows the placeholder even though the value IS saved.
