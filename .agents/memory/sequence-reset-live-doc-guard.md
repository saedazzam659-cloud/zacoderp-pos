---
name: Sequence reset live-doc guard
description: How "reset a sequence to start" decides it is safe — checks the linked document still EXISTS, not just that a log row exists.
---

# Sequence reset live-doc guard

A sequence (مسلسل) may rewind to its start number ONLY when no **existing** document
still references a number it issued. The link lives in `sequence_logs(ref_table, ref_id)`,
and logs PERSIST after a document is deleted — so "linked" must verify the row still
exists in its real table, never just that a log row is present.

**Why:** deleted test documents must NOT block a clean reset; an old log-existence check
(with an `acknowledgeReuse` override) wrongly blocked on any historical log. The override
was dropped — the guard is now hard (409) and self-evident.

**How to apply:**
- `liveLinkedDocs(dbx, cid, seqId)` in `routes/sequences.ts` is the single source of truth;
  both `POST /:id/reset` and `GET /:id/reset-eligibility` call it. The 409 body is the
  final authority — the frontend eligibility query only drives the dialog UX.
- Security boundary is `REF_TABLE_WHITELIST` (snake_case real tables) — only whitelisted
  `ref_table`s are interpolated via `sql.raw`. Everything is scoped by `company_id` on BOTH
  the logs and the target table.
- **Fail-closed in three ways:** unknown `ref_table` (not in whitelist) counts its logged
  ref_ids as linked; missing physical table (`to_regclass` null) is skipped only because it
  can't exist; a whitelisted table with a NON-numeric `ref_id` (legacy/import/corruption)
  also counts as linked/unverifiable — never silently passes.
- All doc tables use integer PKs; `ref_id` is stored TEXT and cast `::int` after a
  `~ '^[0-9]+$'` filter for the live JOIN.
