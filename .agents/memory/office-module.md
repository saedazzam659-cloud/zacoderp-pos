---
name: Zacode Office module (in-browser Word + Excel editor)
description: How the client-side Office editor module is gated and the file-IO / sanitization invariants that keep it safe.
---

# Zacode Office (أوفيس زاكود)

A fully client-side in-browser editor module in `zatca-invoicing`: Word (DOCX/TXT) +
Excel (XLSX/CSV), opens/reads AND saves/writes EXTERNAL files. Pages in
`artifacts/zatca-invoicing/src/pages/office/` (`OfficeHub`, `WordEditor`,
`ExcelEditor`, shared `fileIo.ts`). No backend, no DB — purely browser.

## Gating
Single module/permission key `office`, default-OFF, mirrors the `sister_companies`
wiring exactly (company module gate + per-user RBAC + sidebar accordion group +
3 PermRoutes `/office`, `/office/word`, `/office/excel`). See `module-gate-sync`
and `group-permission-keys-sync` for the lists that must stay in lockstep.

## Heavy libs
`mammoth` (DOCX→HTML read), `docx` (build DOCX on save), `xlsx` (SheetJS read/write),
`dompurify` (sanitize). All the heavy ones are loaded via dynamic `await import(...)`
INSIDE handlers to keep the main bundle light — keep new file-format paths the same.

## Invariants (non-obvious, learned in review)
- **Sanitize external HTML before DOM insertion.** mammoth output (untrusted DOCX
  HTML) MUST go through `DOMPurify.sanitize(..., {USE_PROFILES:{html:true}})` before
  `innerHTML`. `printHtml()` in `fileIo.ts` ALSO sanitizes because it writes into a
  same-origin iframe where scripts can run. Any NEW ingestion path (e.g. paste,
  another importer) must sanitize too.
  **Why:** unsanitized doc HTML = XSS in the authenticated ERP origin.
- **saveFile error semantics.** `fileIo.saveFile` only does the anchor-download
  fallback when the File System Access API is ABSENT. A non-Abort failure from
  `showSaveFilePicker`/write must THROW so the caller's try/catch shows an error
  toast — never silently "succeed" via download.
  **Why:** a swallowed write error misleads the user about where data was saved.
- **Write-back to the opened file.** `openFile` returns a `FileSystemFileHandle`
  (when supported); `saveFile` writes straight back to it unless Save-As or the
  format differs. This is what makes it edit external files in place.
- **Excel state.** Grid is array-of-arrays per sheet. Cell/sheet mutations read the
  active-sheet index from a ref (`activeRef`), NOT the render closure, to avoid
  stale-closure writes to the wrong sheet under rapid tab-switch + edit.
- **PDF import = ONE continuous sheet, never page-per-sheet.** `handleImportPdf`
  concatenates every page's lines into a single sheet (`pages.flatMap`). A real
  document is hundreds of pages (e.g. a 298-page journal-entries report); the old
  page-per-sheet output produced hundreds of unusable sheet-tabs. Any future
  PDF-ingest tweak must keep the single-sheet output.
  **Why:** users edit one table, not 298 tabs — page-per-sheet was reported as «غير مناسب».
- **Grid column direction is user-toggleable (`gridDir`).** The grid `<table dir>`
  is RTL by default for Arabic (column A on the right, natural for Arabic docs)
  with a toolbar toggle to LTR. Don't hard-code `dir="ltr"` on the grid again.
- **Excel grid MUST virtualize rows.** Every cell renders as a controlled
  `<input>`; rendering the whole sheet at once (`rows.map`) mounts tens/hundreds
  of thousands of inputs and HARD-FREEZES the browser on a large .xlsx. The grid
  windows rows (only viewport ± overscan rendered, top/bottom spacer `<tr>`s keep
  the scrollbar correct). Spacer math needs a real row height — measure it at
  runtime (probe ref) + header/viewport via ResizeObserver, don't trust a CSS
  guess. Edits index by ABSOLUTE row (`startRow + i`); save/export must read the
  FULL `sheets` state, never the visible slice. Any new big-grid render path
  (Word tables, future sheets) must window too.

## PDF → journal-entries feature (fileIo.ts + ExcelEditor → Data Import Wizard)
- **JE-PDF extraction uses GLOBAL column-boundary detection, not per-row.**
  `extractPdfTable` derives ONE set of vertical column bounds from whitespace
  shared across ALL rows, so a blank debit/credit cell keeps its column position
  (a per-row split would shift a 3-cell row left and misalign مدين/دائن).
  `splitRowByGaps` is only the FALLBACK; it RTL-detects per row, so in rare
  mixed-script rows its direction can diverge from the global path and drop JE
  lines — degrades capture quality, never crashes.
  **Why:** the source is a column-aligned JE report (الحساب/البيان/مدين/دائن);
  losing blank-cell position scrambles the debit/credit columns.
- **`flattenJournalEntries(table)` is pure + null-degrading.** It reads the
  report's OWN header row to find the account/desc/debit/credit columns and
  returns the fixed headers `["رقم القيد","التاريخ","الحساب","البيان","مدين","دائن"]`.
  Returns `null` for any non-JE table → the caller falls back to the raw
  `rectify(table)` sheet. Keep it side-effect-free and null-safe.
- **"إرسال إلى القيود المحاسبية" handoff = sessionStorage, not props.** Excel
  editor stages the active sheet as JSON in `sessionStorage["office_je_import"]`
  then `navigate("/settings/data-io?tab=import")`. The ImportWizard one-shot
  effect (a `seededRef` guard + `token` gate) reads-and-removes it, forces
  `entity="journalEntries"`, runs `analyzeImport`, and lands the user on the
  mapping/review step. The manual commit gate is UNCHANGED — nothing writes
  without explicit confirmation.
  **Why / invariant:** the seed payload is untrusted/stale-able, so the effect
  MUST `Array.isArray`-guard both `headers` and `rows` (and coerce cells) before
  `setRows`/`analyzeImport`; loose `?.length` checks let a malformed value through
  and throw downstream (white-screen via ErrorBoundary).
