---
name: Print tax mode (السعر شامل الضريبة)
description: Invoice printouts must honor doc.priceIncludesVat; print modals re-derive line math locally in MANY templates.
---

Sales/Purchase print modals build HTML per template and each used to re-derive line math (qty×price + VAT-on-top) independently — ~10+ call sites per file plus separate thermal templates and a chunked template.

**Rule:** all per-line print math must go through one shared `lineFigures(l, inc)` helper (inc = `!!doc.priceIncludesVat`; when inc, net = gross/(1+rate), discounts divided too), and `linesTable` takes an `inc` param passed at EVERY template call site. Totals blocks show a "نوع التسعير" label row. Goods receipts/deliveries prints are safe — they print stored `lineTotal`/header totals computed at save time.

**Why:** inclusive-mode docs printed with VAT added on top overstated totals; a missed template silently prints wrong figures (no type error).

**How to apply:** when adding a print template or a new figure column, never write raw `Number(l.vatRate)` math — use `lineFigures`; grep for `Number(l.vatRate)` in both modals (only hit should be inside the helper). Purchase QR `buildTlvBase64` consumes FullTotals so it inherits correctness. ZATCA XML/hash untouched (print-only).
