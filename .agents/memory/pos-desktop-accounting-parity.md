---
name: POS Desktop accounting parity scope
description: The target application and reference surface for general-accounting parity work.
---

For this requested accounting-parity work, modify POS Desktop for Windows only and use the web ERP as the feature reference. Do not change the web ERP or cashier POS unless explicitly requested.

**Why:** The user reiterated that the requested change belongs in the Windows program and supplied a screenshot of its General Accounts menu and journal-entry screen.

**How to apply:** Keep parity implementation in the POS Desktop artifact; compare each accounting capability with the web ERP before porting it.

For the current parity scope, monthly adjustments mean prepaid/accrued expense schedules, not inventory stock adjustments or the maintenance module. Do not port maintenance unless the user asks for it.

**Why:** The user explicitly said to continue without bringing maintenance over; the offline app must keep the feature local and use its existing journal ledger.

**How to apply:** Keep schedule runs linked to their generated local journal entries, respect auto-post settings and fiscal-period locks, and make due processing an explicit user action while offline. Preserve generated runs when an entry is unposted; do not delete a linked journal entry independently.
