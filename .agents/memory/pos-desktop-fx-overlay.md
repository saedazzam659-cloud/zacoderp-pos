---
name: POS Desktop foreign-currency on invoice forms
description: How the 4 desktop invoice CreateForms handle currency + exchange rate without any Rust/SQLite change.
---

The 4 desktop invoice CreateForms (sales invoice, purchase, sales return, purchase return) let the user pick a currency + exchange rate, but Rust/SQLite store and recompute totals in the **base currency only** (qty × unitPrice|unitCost), ignoring any currency field.

**Rule:** foreign-currency unit prices are CONVERTED to base before save — `net = discountedNet × effRate` is baked into the payload unitPrice/unitCost (same channel discounts already use). The currency code + rate breakdown is stashed in the discount LS overlay (`saveDocDiscount`) purely for Detail re-display. `effRate = currency===base ? 1 : exchangeRate`.

**Why:** keeping the database single-currency means every downstream report, JE, and stock-cost stays correct without schema/Rust work; the overlay only re-labels what the user originally typed.

**How to apply:**
- Detect "foreign currency" by **currency identity** (`code !== baseCurrencyCode()`), NEVER by `rate !== 1` — a foreign currency pegged or left at the default rate 1 must still persist + display, else it silently vanishes.
- Validate `exchangeRate > 0` for foreign docs at save time; do not silently fall back to 1 (silent mispricing).
- `baseCurrencyCode()` is driven by the `pos_desktop_country` LS key (see `lib/currency.ts`).
