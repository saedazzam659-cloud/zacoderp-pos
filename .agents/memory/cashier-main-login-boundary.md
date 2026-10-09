---
name: Station-bound cashier entry from company login
description: Cashier-role users use company login only as a one-step route into their assigned POS station.
---

Cashier-role users may authenticate through the main company login only when explicitly linked to an active POS terminal in their company. After authentication, redirect them directly into the POS Cashier screen and never leave the ERP interface available to that role.

Use the linked terminal's branch as the cashier session branch. Do not require a duplicate user-branch assignment or show a branch picker for this station-bound flow. The terminal link is not a substitute for screen permissions or the company POS module gate; those checks still apply before the cashier screen opens.

If the cashier has no active linked terminal, or no linked station is available, fail clearly without opening a manual session or selecting an unrelated terminal.

**Why:** The company login is the user's expected entry point, while the terminal assignment already identifies the POS station and branch. Rejecting the main login prevents the intended one-step workflow.

**How to apply:** When changing authentication, redirects, or POS bootstrap, preserve the active-terminal check, direct full-page transition to the POS artifact, cashier-screen authorization, and station-derived branch. Keep ordinary ERP users' optional screen preferences independent of cashier role.
