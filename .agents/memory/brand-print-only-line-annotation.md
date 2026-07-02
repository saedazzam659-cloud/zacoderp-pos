---
name: Brand (print-only line annotation) ZATCA-safety + integrity
description: How the optional per-line "brand" annotation stays out of ZATCA and why it still needs server-side validation.
---

# Brand as a print-only sales-invoice line annotation

An item can be sold under many brands, each with its own price/cost/barcode/part-number
(`brands` + `item_brands` tables, reuses `item_groups` as categories). A brand picker
appears in **sales invoices ONLY** and snapshots `brandId`/`brandName` onto the invoice line.

## Rule: brand is PRINT-ONLY, never in the ZATCA chain
`brandName` must NEVER enter the UBL XML / invoiceHash / QR TLV / ICV-PIH. The guarantee
is structural: the ZATCA builders read explicit fields only, so the string "brand" appears
nowhere in them and the XML is byte-identical whether `brandId` is null or set.

**Why:** any invoice-line addition on the ZATCA path risks changing the signed hash and
breaking the reporting/clearance chain. Keeping brand columns unread by the builders is
the safety proof — prove it with `rg -i brand` across the `zatca-*` builders, not by eye.

**How to apply:** when adding ANY new optional invoice-line column, confirm it is absent
from the ZATCA builder files before shipping.

## Rule: print-only ≠ trust-the-client
Even though brand never reaches ZATCA, the invoice POST/PUT must validate each line's
`brandId` belongs to the tenant AND is linked to that line's `itemId` in `item_brands`
(`validateBrandLinesBelongToCompany` in sales.ts, mirrors `validateOffersBelongToCompany`).
Invalid pairs are normalized to null in-place (drop, don't 400 — brand is cosmetic).

**Why:** the invoice GET joins/returns the stored name; a crafted payload could otherwise
print a foreign or non-canonical brand name back on the document.
