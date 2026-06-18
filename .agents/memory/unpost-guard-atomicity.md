---
name: Block-on-child unpost guard atomicity
description: Why "block unpost if a child references the parent" guards must live inside the claim transaction, and why the child's post path must require the parent posted.
---

When an unpost endpoint blocks if a child record references the parent (e.g. sister-company transfer unpost blocked when any return references the transfer), the "has referencing child?" check must run INSIDE the same transaction, AFTER the race-safe `posted→draft` claim — not as an out-of-transaction pre-check.

**Why:** An out-of-tx pre-check is a TOCTOU window: a concurrent request can create the child row between the pre-check and the claim, so the transfer unposts anyway and the child is left dangling against a draft parent (corrupts AR + stock ledger). Re-checking after the claim, then throwing to roll back the claim, makes block-or-proceed atomic with the status flip.

**Also harden the child's post path:** require the parent be `status='posted'` before posting the child (e.g. return-post must reject when the original transfer is not posted). A return/child only makes accounting+stock sense against a posted parent, and it keeps the unpost block-on-child guard consistent from the other direction.

**How to apply:** Pattern for any parent/child reversal pair (transfers↔returns, invoices↔credit notes, etc.): claim parent inside tx → re-SELECT referencing children inside tx → throw (with a custom `err.httpStatus`, honored in catch via `res.status(e?.httpStatus ?? 500)`) if any exist. Separately, child `/post` must assert `parent.status === 'posted'`.
