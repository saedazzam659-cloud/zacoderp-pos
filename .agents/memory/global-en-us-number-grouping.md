---
name: Global en-US number grouping (web)
description: All displayed amounts in zatca-invoicing web use en-US comma grouping via format.ts helpers; raw values everywhere else.
---

**Rule:** Every on-screen/print amount in the zatca-invoicing web app is formatted international-style (en-US: `1,000` / `100,000.34`). `getNumberLocale()` always returns `en-US` (no ar-SA grouping marks). Use the pure helpers in `src/lib/format.ts` — `fmt2` (money, 2dp), `fmtNum(n, d)`, `fmtInt0` (counts), `fmtQty` — or the `useFormatters()` hook.

**Why:** User explicitly requires Excel-style comma separators globally; Arabic-locale grouping (٬/NBSP) reads ambiguously.

**How to apply:** New display cells/totals/print HTML → grouped helpers. NEVER group: `<Input>` values/state, API payloads, rounding before save, CSV/Excel cell values (commas corrupt CSV), ZATCA XML/QR/TLV/hash, IDs/years/VAT numbers/percentages, anything parsed back via `Number()`/`parseFloat`. Date `toLocaleString/…Date/…Time` calls keep their own locales.
