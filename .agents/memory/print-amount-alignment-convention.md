---
name: Print amount alignment convention
description: All print-template amount cells align RIGHT; beware .end class vs tbody selector specificity in RTL
---

**Rule:** In every HTML print template, amount cells (`td.num`) must be `text-align:right` in BOTH tbody and tfoot — the system-wide "international" convention the user requested. Never use a shared `.end { text-align:left }` (RTL flip) class for numbers.

**Why:** The JE print sheet showed totals (tfoot `.num end`) left-aligned while body amounts were right-aligned: `table.lines tbody td { text-align:right }` (specificity 0,1,3) outranked `.end` (0,1,0) in tbody, but tfoot had no text-align rule so `.end` won there → footer numbers flipped sides. User flagged it as broken formatting.

**How to apply:** When adding/editing a print template, add explicit `tbody td.num, tfoot td.num { text-align:right; }` (high enough specificity to beat generic cell rules). Label cells with `text-align:left` next to the amount column are intentional in several doc templates (quotations/orders/receipts) — don't "fix" those. cashVoucherPrint centers `.num` uniformly by design. Templates already normalized: journalPrint.ts, JournalEntries.tsx legacy template, bulkPrint.tsx, TaxDeclaration.tsx.
