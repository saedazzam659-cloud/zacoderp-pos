---
name: POS Desktop document-form layout
description: Why back-office doc forms must use natural page flow, not a fixed-height internal-scroll shell.
---

The 4 shared-helper document forms (SalesInvoicesAdmin, PurchasesAdmin, SalesReturnsAdmin, PurchaseReturnsAdmin) render inside PosShell `pagePad`, which already owns the vertical scroll (`overflowY:auto`). Their shared layout helpers live in `_adminUi.tsx` (`docFormShell`, `linesPanel`, `contentPanel`, `linesScroll`) and MUST be plain natural block flow — the page wrapper scrolls the whole form as one, web-parity.

**Rule:** never give these doc-form helpers a fixed viewport height + internal scroll.

**Why:** a `docFormShell: height calc(100vh-200px) + overflow:hidden` with `linesScroll: flex:1/overflow:auto` collapsed the lines grid to a tiny header-only scroll box on the (shorter) Windows window — the title + add-line button + totals ate the height and flexbox shrank the flex:1 grid first. Two nested scroll owners (pagePad + inner shell) fight; the inner one wins and starves the grid. Users saw "شكل بايظ".

**How to apply:** keep `linesScroll` to `overflowX:auto` only (the table is ~1290px wide → needs horizontal scroll); let vertical scrolling belong to `pagePad`. The POS register (SalesScreen/ReturnsScreen) uses its OWN local `S.linesScroll`, so it is unaffected by these shared helpers — don't confuse the two.

Doc forms open with ~10 blank rows (`Array.from({length:10}, ()=>blankLine())`); this is safe because save filters empties (`lines.filter(l=>l.itemId && (l.qty||0)>0)`) and `collectDocIssues` ignores fully-blank rows.
