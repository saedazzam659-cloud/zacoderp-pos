---
name: POS Desktop document-form layout
description: Why back-office doc forms must use natural page flow, not a fixed-height internal-scroll shell.
---

Back-office document forms normally use natural page flow inside PosShell `pagePad`; don't impose a fixed-height inner shell on all of them.

**Rule:** the Windows sales-invoice create/edit screen is an explicit exception: it must fit the available viewport with no outer vertical scroll, and only the invoice-items grid may scroll vertically. Keep its heading and posting note together in the blue header. Sales and purchase returns, quotations, and sales and purchase orders use one continuous form without Basic / Items / Payments tabs, but retain natural page scrolling.

**Why:** on November 11, 2026, the user explicitly asked that Windows invoices appear complete without an outer scrollbar and that scrolling stay inside the item grid. The previous shared fixed-height approach was rejected because it collapsed the grid on shorter windows.

**How to apply:** scope the bounded flex layout to the sales-invoice screen only; use `min-height:0` through its flex ancestors and give the invoice items grid flexible `overflow:auto`. Keep the named quotation, order, and return forms in natural flow, with all sections visible in sequence. The POS register (SalesScreen/ReturnsScreen) has its own local `S.linesScroll`.

New item tabs should open with no editable blank lines and a calm empty-state area about six item-row heights tall. Add an actual line only when the user requests one; preserve real prefilled lines when editing or converting a source document.

**Why:** The repeated empty input rows made a new invoice look like a broken, prefilled grid. The user explicitly chose a clean six-row-height space without row lines.

**How to apply:** Use the shared empty item-state presentation for invoice, order, receipt/delivery, quotation, and return forms. Keep the line arrays empty for new documents, retain existing lines for edits/prefills, and leave calculations and save validation based on real rows unchanged.
