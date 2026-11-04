---
name: Negative-stock cost settlement
description: Accounting and batch-provenance boundaries for reconciling negative-stock sales against later purchases.
---

For FIFO/FEFO shortages, only automatic lot allocation may create an unbatched provisional layer; explicit manual lot selections remain exact. Later purchase receipts consume pending layers in order and post the cost difference through a separate journal entry. Never edit a posted sales journal or its original stock movement.

Linked sales returns reverse the settled cost proportionally. Unpost posted returns before purchases that settled their cost; unpost those purchases before the source sale. Retain adjustment-journal identity across unpost/repost, and keep all reversal and stock changes atomic.

When a batched receipt covers a previously unbatched shortage, reattribute the covered units with equal-and-opposite batch ledger movements. This preserves total quantity and value while preventing the received lot from appearing fully available again.

Historical preview is read-only: show currently negative stock not represented by pending layers, estimate value from the current average cost, and do not post or backfill journals without explicit approval. This does not claim to identify shortages already covered by later receipts.

**Why:** Rewriting posted sales or losing the link between provisional layers and receipt costs breaks fiscal history, batch availability, and unpost/repost idempotency.

**How to apply:** Preserve company and warehouse scope, existing negative-stock precedence, period guards, line provenance, and additive schema reconciliation in any related inventory-cost change. Treat preview estimates as advisory, not as posted valuation.
