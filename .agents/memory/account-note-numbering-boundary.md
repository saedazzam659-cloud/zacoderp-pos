---
name: Account-note numbering boundary
description: Fresh-company sequence behavior for customer credit and supplier debit notes.
---

**Rule:** Seed customer credit notes and supplier debit notes in one shared fresh-company numbering series.

**Why:** Both note types store their document number in the same account-note table, so separate default counters starting at 1 could generate duplicate document numbers.

**How to apply:** Keep both transaction types bound to the same default counter for new companies. Existing companies' configured sequences must not be rewritten by this defaulting change.
