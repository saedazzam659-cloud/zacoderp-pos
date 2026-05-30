---
name: POS Desktop add-to-cart safety gates
description: Every cart-add path in SalesScreen must reuse the same safety gates; new paths silently bypass them otherwise.
---

# POS Desktop — every add-to-cart path must reuse the shared gates

SalesScreen has more than one way to push a line into the cart (base tap →
`addToCart`, unit tap / unit-barcode scan → `addUnitToCart`, weighed →
`pushWeighedLine`). The pharmacy expiry / supervisor-override check lives in a
shared `ensureExpiryAllowed(item)` helper.

**Rule:** any NEW add-to-cart entry point must call `ensureExpiryAllowed` (and
any future cart-gates) before pushing the line.

**Why:** multi-unit pricing first shipped `addUnitToCart` without the expiry
gate, so a carton of an expired medicine could be sold even though the same item
was blocked when added as a single piece. Caught in code review.

**How to apply:** when adding a cart path, route it through the existing guarded
helpers rather than duplicating the `setCart` push. Keep the gate in one place so
it can't drift between paths.

# Multi-unit pricing data model (overlay-only)

Items carry an optional `units: ItemUnit[]` ({id,name,factor,price,barcode?}) on
`LocalItem`. Units live in the **LS overlay only** — never SQLite/Rust (Rust
can't compile in Replit). Stock is kept in the BASE unit (pieces); a non-base
line deducts `qty × unit.factor` in every adjust site (client pre-commit,
rollback, host/single post-save). `findItemUnitByBarcode` is overlay-aware
(reads `listItems`) and unit barcodes win over the base barcode.
