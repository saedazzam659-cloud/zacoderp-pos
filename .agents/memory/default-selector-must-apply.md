---
name: Default-selector auto-load must apply, not just set id
description: A header picker that auto-selects a company default must run the same apply/broadcast handler manual selection uses, or dependent line defaults stay stale.
---

When a document/entry form has a header-level picker (tax, warehouse, etc.)
that broadcasts its value down to every line via an `applyHeaderX(v)` handler,
the effect that AUTO-selects the company default on a NEW document must call
that same `applyHeaderX(String(default.id))` — NOT just `setHeaderXId(...)`.

**Why:** Setting only the header id leaves each line on its hardcoded default
(e.g. line `vatRate: "15"`), so a company whose default differs (e.g. 14% tax)
silently persists the wrong value unless the user manually re-picks the header.
This bit the Dynamic Tax Management work: the default-tax effect set the id but
never broadcast the rate, so new docs saved 15% even when the default was 14%.

**How to apply:** For any "auto-select default" effect feeding a header picker:
1. Call the broadcast handler, guarded against re-runs (`if (headerXId) return`).
2. Also make `addLine` inherit the current header value (e.g.
   `const r = percentRateOf(headerXId); if (r !== null) l.vatRate = String(r);`)
   so lines ADDED after load use the default too, not the hardcoded constant.
3. Server-side fallback (resolveTaxRate) only helps when the line value is
   empty/falsy — an explicit hardcoded "15" defeats it, so the client must
   pre-fill correctly.
