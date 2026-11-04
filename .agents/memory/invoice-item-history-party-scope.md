---
name: Invoice item history party scope
description: Keep item price and movement history tied to the currently selected invoice party.
---

Inside sales invoices, item history is for the customer currently selected on that invoice. Inside purchase invoices, it is for the supplier currently selected. Do not silently show all-party history or alter the current line's price from this read-only view.

**Why:** The user explicitly clarified that the purpose is to review the history for the selected customer or supplier, not general item activity.

**How to apply:** Require a selected party before requesting history, scope the query to that party and the active company, and preserve normal document visibility permissions. Keep displayed history informational unless the user separately asks for price application.
