---
name: Web POS parked carts
description: Browser cashier held-cart persistence and numbering boundary.
---

In the web POS, parked carts are unfinished-sale scratchpad data stored on the cashier's device, scoped by company, cashier, branch, and terminal. They are not cloud invoices and must not consume invoice numbers. Resuming one while another cart is active must preserve the active cart as another parked entry.

**Why:** Only checkout should create a numbered, server-backed sales invoice; a cashier needs to switch between unfinished customers without losing either basket or creating fiscal records prematurely.

**How to apply:** Keep park/resume/delete operations local to the current cashier station. Send data through the sales-invoice API only during checkout. Keep this web behavior distinct from POS Desktop's session-scoped storage implementation.
