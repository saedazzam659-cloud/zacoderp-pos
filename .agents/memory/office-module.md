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
- **Excel grid MUST virtualize rows.** Every cell renders as a controlled
  `<input>`; rendering the whole sheet at once (`rows.map`) mounts tens/hundreds
  of thousands of inputs and HARD-FREEZES the browser on a large .xlsx. The grid
  windows rows (only viewport ± overscan rendered, top/bottom spacer `<tr>`s keep
  the scrollbar correct). Spacer math needs a real row height — measure it at
  runtime (probe ref) + header/viewport via ResizeObserver, don't trust a CSS
  guess. Edits index by ABSOLUTE row (`startRow + i`); save/export must read the
  FULL `sheets` state, never the visible slice. Any new big-grid render path
  (Word tables, future sheets) must window too.
