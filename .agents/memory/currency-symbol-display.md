---
name: Currency symbol display convention
description: How amounts must show a currency SYMBOL (not code, not hardcoded ر.س) across zatca-invoicing, and the symbol-vs-code split.
---

# Currency symbol display (zatca-invoicing)

Amounts must render the currency **symbol** ($, €, ر.س …) of the document's
own currency — never a hardcoded `ر.س` and never the raw code (`USD`).

**Resolver:** `currencySymbol(code, currencies?)` in
`artifacts/zatca-invoicing/src/lib/format.ts`. Precedence:
currency-row `symbol` column → `CURRENCY_SYMBOLS` map → raw code as last resort.
`currencySymbol(undefined/null)` safely returns the SAR symbol, so missing
currency context degrades to ر.س (no `(undefined)` leaks).
`useFormatters().fmtMoney(n, currency, currencies?)` already renders the symbol,
so any list/detail that passes a currency code is auto-correct.

**Where to get it:**
- React components/screens → hooks in `hooks/useCurrencySymbol.ts`
  (`useResolveCurrencySymbol()` for per-row, `useBaseCurrencySymbol()` for base).
- Standalone print **HTML builder** functions are module-level (no React) →
  call the pure `currencySymbol(code)` directly. Examples: `lib/voucherPrint.ts`,
  `pages/sales/SalesPrintModal.tsx` (factory adds `currencySym` to `FullTotals`),
  `pages/purchasing/PurchasePrintModal.tsx`, `components/InvoicePrintDialog.tsx`
  (5 template builders, each computes `sym` from `inv.currencyCode`).

**Symbol vs CODE — keep the code in these spots (intentional):**
- An explicit "العملة:" / "Currency:" field that *names* the currency → show the
  CODE (e.g. "USD"), not the symbol.
- Amount-in-words lines that branch on `currency === "SAR"` → keep the code for
  the comparison.

**Why:** users (esp. م/كرم) reported a USD invoice still printing ر.س. The fix is
display-only; no schema/amount math changed. **How to apply:** when adding any new
amount display, resolve the symbol from the document's `currencyCode` (or base for
base-only screens) — do not type a literal ر.س.

**Scope deliberately excluded:** SaaS/platform billing screens are SAR-fixed
(Pricing, PlanSettings, Register, Company*, admin/*, License, systemModules);
ZATCA Saudi-context reports (ZatcaBridge/Report) are SAR; base-currency-only
vertical modules (hotel/hospital/maintenance/installments/contracting/
fixed-assets/production/online-store/crm/inventory) already show base = ر.س for a
SAR tenant, so they were left unless a literal needed routing to the base symbol.
