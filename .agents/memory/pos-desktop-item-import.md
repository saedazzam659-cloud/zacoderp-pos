---
name: POS Desktop item price-list import
description: Offline import of items from Excel/text-PDF/paste with dedup + auto price update + brand tagging
---

# POS Desktop — استيراد الأصناف من ملف (item_import screen)

Offline-only (no AI/OCR) importer that ingests a price list from Excel, a
text-based PDF, or manual paste, and reconciles it against the local catalog.

## Match + dedup rules (the whole point of the feature)
- **Match precedence** code → barcode → name (normalised, whitespace-collapsed, lowercased).
- A matched row **AUTO-UPDATES the sale price** (price-only `updateItem` patch — never a full-row overwrite; other fields preserved) and refreshes its brand link. It is NEVER re-inserted.
- A genuinely new row is inserted ONCE.
- **In-batch dedup is mandatory**: the initial `existing`-catalog maps do NOT know about rows planned as new earlier in the SAME file. Without a per-file `planned{Code,Barcode,Name}` Set, `createItem`'s auto-code makes every blank-code insert unique → the same new item duplicates. Second occurrence is marked `invalid` "مكرر داخل نفس الملف".
- **Identifier-conflict guard**: resolve code/barcode/name INDEPENDENTLY; if they point at >1 distinct existing item, mark the row `invalid` "تعارض…" instead of silently mutating the first hit (dirty-supplier-list corruption hazard). Existing-match duplicates (two rows → same real id) are harmless (updateItem/setItemBrands are idempotent), so only the new-insert path is guarded.

## Brand tagging
- One import list → ONE brand; each brand carries its own price/barcode/cost on the item, so one item holds MANY brands. Link dedup is by `brandId` (find-then-update-or-append), reusing `listItemBrandLinks`/`setItemBrands` (LS-overlay, PRINT-ONLY, never ZATCA). New links omit `id` (setItemBrands mints the uuid).

## Parsing
- Arabic-Indic (٠-٩ and ۰-۹) digits normalised in `parseNum`; Arabic decimal sep ٫ → dot, thousands ٬ dropped.
- PDF has NO table structure: cluster text runs into rows by y (tol 4) and columns by gap-based x clustering (GAP 18). Scanned/image PDFs yield no text runs → explicit "لا يوجد نص" error (no OCR by design).
- `pdfjs-dist` (main build, NOT legacy) + worker via `import ...?url` — Tauri WebView2 Chromium supports the modern build.

**Why:** user explicitly required "reimport auto-updates price + never duplicate". The naive single-snapshot match satisfies existing-item dedup but silently duplicates repeated NEW rows and can mutate the wrong item on identifier conflict — both caught in code review, both must stay fixed.
