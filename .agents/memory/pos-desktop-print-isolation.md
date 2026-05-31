---
name: POS Desktop print must use an isolated iframe document
description: Why in-DOM "@media print + visibility:hidden overlay" printing is unreliable in the Tauri WebView2 shell, and the working pattern.
---

# POS Desktop printing — isolate via a standalone HTML iframe, not an in-DOM overlay

For any print feature in the Tauri desktop app (`artifacts/pos-desktop`), build a
complete self-contained HTML document and print it inside a hidden `<iframe>`
(`doc.open/write/close` → `iframe.contentWindow.print()`), NOT an in-page node
toggled with `@media print { body * { visibility:hidden } #area{...} }`.

**Why:** the in-DOM overlay approach was clipped at print time. The print node used
`position:absolute; inset:0`, but its containing block was a `PosShell` ancestor
with fixed height + `overflow:hidden/auto` (the flex shell + scroll panes). So the
printout came out cropped/short and app chrome (sidebar) bled through. The web app
(`zatca-invoicing`) already learned this — see `lib/voucherPrint.ts` /
`lib/export.ts`, which build a standalone document and print it (they use
`window.open`; in Tauri prefer an iframe since `window.open("","_blank")` can be
blocked by the webview).

**How to apply:**
- Mirror `JournalEntries.tsx` → `buildJePrintHtml()` + `printJournalEntry()`.
- Escape ALL interpolated data with an html-escaper (incl. the logo `src`
  attribute); constrain logo to `data:image/`/`https://` via `safeLogoSrc`.
- Wait for load before printing: `load` event + `readyState==="complete"` fast path
  + a ~1200ms fallback timer, guarded by a `done` flag so print() fires once.
- Remember currency/decimals come from `getDecimals()` (appSettings) via `fmt()`.
- A new print feature shipping a fix is invisible until a NEW MSI is built+installed
  (users run whatever version is on their machine — they were on 0.7.15 while the
  fix sat in source). See `pos-desktop-release-mechanism.md`.
