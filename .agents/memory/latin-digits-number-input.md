---
name: Latin digits in numeric inputs (Saudi/Arabic devices)
description: Why numeric form inputs must avoid type="number" to keep digits Latin on Arabic-locale devices
---

# Numeric inputs must force Latin digits

On Arabic-locale devices (Saudi Windows/Android/iOS), `<input type="number">` renders
its value in Arabic-Indic digits (٠١٢٣) following the OS locale, even when the stored
string is Latin. This looks inconsistent next to the rest of the app.

**Rule:** for money/quantity form fields use the app-wide pattern instead of `type="number"`:

```jsx
<Input type="text" inputMode="decimal" dir="ltr" value={...} onChange={...} />
```

Use `inputMode="numeric"` for integer-only fields (km, ids, counts) and
`inputMode="decimal"` for anything with fractions. Always add `dir="ltr"`.

**Why:** `type="number"` delegates digit rendering to the device locale (Arabic-Indic
on Saudi devices) and also fights RTL; `type="text" + inputMode + dir="ltr"` keeps the
displayed digits Latin everywhere while preserving the mobile numeric keypad. Values are
already handled as strings and parsed on save, so dropping native `step/min/max` is safe.

**How to apply:** this is the established pattern in the peer document forms
(SalesDocumentForm, PurchaseInvoiceForm, etc.). Any NEW numeric input — or any module
still on `type="number"` — should follow it. Display formatting is a separate concern:
use `toLocaleString("ar-EG-u-ca-gregory-nu-latn", …)` (the `-nu-latn` extension) so
formatted output stays Latin too.
