---
name: JE-linked record edit lock
description: How to safely allow editing of records that have posted a journal entry, without desyncing the GL.
---

# Editing records that posted a journal entry

When a record (sales/purchase invoice, employee loan, production order, voucher…)
has already posted a journal entry, its JE-relevant fields (amount, party,
date, type — anything the JE debited/credited) MUST become read-only on edit.
Schedule / descriptive fields (installment plan, reason, notes) may stay
editable.

**Why:** the posted JE captured the original values; silently changing the
principal/party/date afterward leaves the GL pointing at numbers that no longer
match the source document, and downstream postings (e.g. payroll deduction,
completion JE) drift.

**How to apply:**
- Detect "locked" state by the record's own marker, not a guess: disbursed
  employee loans carry a `JE#…` token in `notes`; invoices use `status==='posted'`;
  production orders use `status==='in_production'/'completed'`.
- On the backend PUT handler, reject a change only when the submitted value
  **actually differs** from the stored value (compare numerically for money/ints,
  string-compare the rest) — NOT merely when the field is present. The edit form
  resends every field, so presence-based rejection would block editing the
  allowed fields too.
- Mirror the same lock in the UI (disable the locked inputs + show a note) so the
  user understands before hitting a 409.
- Terminal states (cancelled/completed) freeze the whole record except notes.
- Quick status/payment patches (cancel → `{status}`, payroll → `{paidAmount}`)
  send none of the locked fields, so they pass the guard untouched.

See also replit.md gotchas: "Posted Invoice Lock", "Production Order Post-Issue Lock".
