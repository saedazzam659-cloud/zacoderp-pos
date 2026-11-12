---
name: Item history party scope
description: Keep item price history tied to the currently selected customer or supplier.
---

Inside sales invoices, item history is for the customer currently selected on that invoice. Inside purchase invoices, it is for the supplier currently selected. POS Desktop quotations may show the same customer's posted sales-invoice history; quotations themselves and draft invoices are not realized-price history. Do not silently show all-party history or alter the current line's price from this read-only view.

**Why:** The history is meant to help review prior prices with the current customer or supplier. A quotation is not a completed sale, and applying a historical price automatically could silently change a document.

**How to apply:** Require a selected party before requesting history and scope it to the current item and party. For POS Desktop quotes, use posted sales invoices only; keep prices informational and never apply one automatically. Do not change the web ERP or cashier POS unless explicitly requested.
