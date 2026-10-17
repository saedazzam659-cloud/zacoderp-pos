---
name: Account-note numbering boundary
description: Fresh-company sequence behavior for customer credit and supplier debit notes.
---

**Rule:** Seed customer credit notes and supplier debit notes in separate fresh-company numbering series; each begins at 00001 with no different prefix.

**Why:** The user explicitly wants each note type to maintain its own counter and both to start at the same number, following the other document screens.

**How to apply:** Bind each transaction type to its own sequence for new companies, with start/current number 1 and five-digit padding. Existing companies' configured sequences must not be rewritten by this defaulting change.
