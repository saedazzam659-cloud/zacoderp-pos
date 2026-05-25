---
name: POS Desktop sticky-footer cart layout
description: How SalesScreen keeps payment buttons pinned regardless of cart length.
---

The cart pane in `artifacts/pos-desktop/src/pages/SalesScreen.tsx` is a
`flex column` with three children: header (flex-shrink:0), `linesScroll`
(flex:1, overflowY:auto, minHeight:0), and footer (flex-shrink:0). The
**only** scrolling region inside the cart is `linesScroll`. The outer
`wrap` container has `overflow:hidden` and a fixed `height:100%` from the
parent shell so the inner flex math works.

**Why:** A previous layout let the page scroll, so adding ~6 items pushed
the "نقداً / بطاقة" buttons below the fold and cashiers had to scroll to
complete a sale.

**How to apply:** When adding new sections to the cart pane, put scrolling
content inside `linesScroll` and pinned content inside `footer`. Never
remove `overflow:hidden` from `wrap` or `minHeight:0` from `linesScroll`
— either change re-opens the bug.
