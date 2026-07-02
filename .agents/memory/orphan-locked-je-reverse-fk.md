---
name: Orphan locked-JE detection via reverse FK
description: Why source-doc existence for a locked journal entry must be checked by reverse FK, not doc_number match, plus the orphan rescue path.
---

# Orphaned locked journal entries

A source-generated JE (invoice/voucher/…) is locked (entry_type ∈ LOCKED_ENTRY_TYPES) — no manual edit/unpost/delete; the user must unwind the source doc. When the source doc was deleted by an old bug, the JE is stuck forever (an "orphan").

**Rule:** decide whether a locked JE still has a live source document by the **reverse FK** `source.journal_entry_id = je.id` FIRST, not by matching `journal_entries.doc_number` against the source's code/docNumber.

**Why:** a company can run a SEPARATE numbering sequence for journal entries vs. the source document. e.g. JE `QYD/06/1366` links to voucher code `PYB-202600015` — the strings never match, so doc_number matching returns null even for VALID linked entries (false orphan). The FK is definitive.

**How to apply:**
- `sourceDocExists(entryType, docNumber, jeId, cid)` in `journalEntries.ts`: reverse FK (REVERSE_SOURCE map) → `LOAN-{id}` parse (employee_loan) → doc_number/code fallback. ANY hit ⇒ source-backed.
- The GET `/` list runs a reverse-FK batch pass that OVERRIDES the doc_number-derived `sourceId`, and emits `isOrphanLocked = LOCKED_ENTRY_TYPES.includes(entryType) && sourceId==null`.
- Rescue path (chosen over delete to keep numbering gap-free): `POST /:id/convert-to-general` flips entry_type→`general`, status→`draft`, KEEPS doc_number. Guards: 404 missing, 400 not-locked-type, 409 if `sourceDocExists`, 423 closed period. Does NOT loosen edit/unpost/delete guards.

**Caveat:** tables WITHOUT a `journal_entry_id` column (customer_settlement, supplier_settlement, payroll_run) still rely on doc_number/code fallback — they can be mis-flagged in UI if their numbering ever diverges, but the endpoint still refuses conversion when the source exists.
