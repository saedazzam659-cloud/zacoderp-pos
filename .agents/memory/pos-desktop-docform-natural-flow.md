---
name: POS Desktop document-form layout
description: Why back-office doc forms must use natural page flow, not a fixed-height internal-scroll shell.
---

The 4 shared-helper document forms (SalesInvoicesAdmin, PurchasesAdmin, SalesReturnsAdmin, PurchaseReturnsAdmin) render inside PosShell `pagePad`, which already owns the vertical scroll (`overflowY:auto`). Their shared layout helpers live in `_adminUi.tsx` (`docFormShell`, `linesPanel`, `contentPanel`, `linesScroll`) and MUST be plain natural block flow — the page wrapper scrolls the whole form as one, web-parity.

**Rule:** never give these doc-form helpers a fixed viewport height + internal scroll.

**Why:** a `docFormShell: height calc(100vh-200px) + overflow:hidden` with `linesScroll: flex:1/overflow:auto` collapsed the lines grid to a tiny header-only scroll box on the (shorter) Windows window — the title + add-line button + totals ate the height and flexbox shrank the flex:1 grid first. Two nested scroll owners (pagePad + inner shell) fight; the inner one wins and starves the grid. Users saw "شكل بايظ".

**How to apply:** keep `linesScroll` to `overflowX:auto` only (the table is ~1290px wide → needs horizontal scroll); let vertical scrolling belong to `pagePad`. The POS register (SalesScreen/ReturnsScreen) uses its OWN local `S.linesScroll`, so it is unaffected by these shared helpers — don't confuse the two.

New item tabs should open with no editable blank lines and a calm empty-state area about six item-row heights tall. Add an actual line only when the user requests one; preserve real prefilled lines when editing or converting a source document.

**Why:** The repeated empty input rows made a new invoice look like a broken, prefilled grid. The user explicitly chose a clean six-row-height space without row lines.

**How to apply:** Use the shared empty item-state presentation for invoice, order, receipt/delivery, quotation, and return forms. Keep the line arrays empty for new documents, retain existing lines for edits/prefills, and leave calculations and save validation based on real rows unchanged.
