---
name: Journal-entry reversals
description: Business and accounting boundaries for reversing journal entries.
---

A reversal creates a new, independent draft with debit and credit swapped; it never edits the original. Keep the action limited to eligible manually-created entries. Source-generated journal entries must be reversed through their source document because reversing only the ledger row does not reverse inventory, settlement, tax, or source-document state.

**Why:** The user wants to review the reversal before posting, while source documents own non-ledger effects that a standalone journal reversal cannot undo.

**How to apply:** Keep eligibility enforced on the server, not just by hiding the UI action. Link the reversal to its original, prevent duplicate reversals, and do not allow the original to be unposted while a linked reversal exists. Use the same document lock for reversal creation and original unposting.