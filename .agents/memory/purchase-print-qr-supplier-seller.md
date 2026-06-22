---
name: Purchase print QR uses supplier as seller
description: Why PurchasePrintModal builds its ZATCA TLV QR from the supplier, not the company
---

On a PURCHASE document the seller is the SUPPLIER, not our own company. So
`PurchasePrintModal.handlePrint` builds the phase‑1 TLV QR from `data.supplier`
(name + vatNumber) — NOT from `company` like the sales modal does.

**Why:** A ZATCA phase‑1 QR encodes seller name + seller VAT (tags 1–2) + timestamp +
total + VAT. The buyer's purchase reprint should faithfully reproduce the SUPPLIER's
QR, so seller=supplier. Passing `company` (the buyer) would encode the wrong party
and produce a semantically invalid QR — even though `buildTlvBase64(company,…)` is
named "company", on this screen we deliberately pass the supplier object (same
`{nameAr, vatNumber}` shape).

**How to apply:** The QR helpers (`buildTlvBase64`, `buildZatcaQrDataUrl`, `qrImgHtml`)
existed in PurchasePrintModal but `handlePrint` never generated/injected `_qrDataUrl`,
so ALL QR templates (incl. the original template5 "ZATCA رسمي") silently rendered the
dashed placeholder. The fix: make `handlePrint` async, compute totals with the same
2‑arg `computeFullTotals(doc, lines)` the templates use (so the QR total matches the
printed total), `await buildZatcaQrDataUrl(data.supplier, …)`, then render with
`{...data, _qrDataUrl}`. Keep failure non‑fatal (try/catch → placeholder) so printing
never breaks. Do NOT switch the seller to `company` to "match sales".
