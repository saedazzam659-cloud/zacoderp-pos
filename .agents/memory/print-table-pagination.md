---
name: Print table pagination vs overflow wrapper
description: Why a long invoice/report lines table must not sit inside an overflow:hidden/border-radius wrapper when printed.
---

A bordered "real table" look for a printed lines table must come from borders on the
`<table>` + `th/td` themselves (with `border-collapse:collapse` and an outer table
`border`), NOT from wrapping the table in a `div { overflow:hidden; border-radius }`.

**Why:** In Chromium print (Tauri WebView2 / iframe print), an `overflow:hidden`
clipping container around content that fragments across pages can clip or truncate
the continued rows on page 2+. Tables fragment cleanly on their own; a clipping
wrapper fights that. Rounded corners need the wrapper, so they are sacrificed — a
crisp rectangular grid is the correct trade for reliable multi-page printing.

**How to apply:** For any printable lines table (e.g. `buildA4Html` in
`pos-desktop/src/lib/invoicePrint.ts`), give `th`/`td` full `border:1px` gridlines +
the table an outer `border`; never frame it with an overflow/`border-radius` div. A
table with only faint `border-bottom` hairlines (no column separators, no frame)
reads to users as "no table at all" (بدون جدول) — full gridlines are what makes it
look نموذجي.
