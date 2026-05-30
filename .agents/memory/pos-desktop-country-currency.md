---
name: POS Desktop country → currency symbol
description: How the desktop POS picks its display currency symbol, and why it piggybacks on the VAT country key.
---

The POS Desktop display currency symbol (e.g. Egypt → ج.م) is derived from the
SAME `localStorage["pos_desktop_country"]` ISO-2 key that already drives the
default VAT rate. There is ONE country source of truth, not two.

**Why:** A separate currency setting would drift from the VAT country and let an
Egyptian install show 14% VAT but ر.س, or vice-versa. Writing the country fires
the shared `"pos-desktop-tax-changed"` event so VAT default AND currency symbol
recompute together.

**How to apply:**
- Read the symbol reactively in components via `useCurrencySymbol()` (lib/currency.ts).
- Module-level/pure formatters (e.g. a report's `fmtSar`, `_adminUi.fmtCurrency`)
  call the synchronous `currencySymbol()` — they do NOT subscribe, so a view that
  must live-update on a mid-session country change has to itself call
  `useCurrencySymbol()` in its component body to force a re-render (DailyReport
  does this).
- Display-only: this never touches the SQLite accounting base-currency code
  (Rust can't compile in Replit). It only swaps the shown symbol.
- First-run gate lives in App.tsx as a `needs-country` boot phase AFTER vertical
  and BEFORE the cloud/standalone mode boot, gated on `hasChosenCountry()`
  (non-empty key). Returning users — including legacy "ALL"/other-country
  installs — skip the picker by design; unknown ISO falls back to SA symbol.
