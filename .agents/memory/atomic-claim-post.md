---
name: Atomic claim-and-post in PostgreSQL
description: Why a "claim" UPDATE that only filters on status but doesn't change it is NOT race-safe under READ COMMITTED.
---

Rule: when implementing a "first-caller-wins" claim on a status-gated row, the UPDATE's `SET` clause MUST flip the gating column itself — not just `updated_at`. Then wrap the rest of the work in `db.transaction(...)` so a failure rolls back the claim.

**Why:** Under PG's default READ COMMITTED isolation, two concurrent `UPDATE ... WHERE status='draft'` statements that only touch `updated_at` both succeed. T1 acquires the row lock and commits; T2 waits, then re-evaluates `WHERE` against the new tuple version — which still has `status='draft'` because T1 never changed it — and updates a second time. Both callers see `claim.length > 0`, both create journal entries, you get duplicate postings. Changing `SET` to include `status='posted'` makes T2's re-evaluation fail (`status` is no longer 'draft'), and the UPDATE matches zero rows — exactly the deterministic rejection you want.

**How to apply:** For any "post / submit / close / finalize" endpoint that should run exactly once per row:
1. Open a `db.transaction(async tx => …)`.
2. First statement: `tx.update(table).set({ status: <terminal-or-in-flight> , updatedAt: new Date() }).where(and(eq(id, …), eq(companyId, …), eq(status, <starting>))).returning()`.
3. If `returning()` is empty, throw a sentinel (e.g. `Error("ALREADY_CLAIMED")`) — the catch outside the tx maps it to 409.
4. Do the side-effect work (JE insert, etc.) inside the same tx so a failure rolls the claim back.

Verify the fix by firing 5 parallel POST requests against the same row and asserting exactly one 2xx + N−1 conflict responses and a single side-effect row in the database.

**Cross-connection variant (when the heavy work opens its OWN connection/tx):** Sometimes the side-effect can't share the claimer's transaction — e.g. a doc→invoice conversion where the invoice-creation routine opens its own DB connection. Then: (1) claim with a compare-and-set UPDATE that flips the gating column (`SET status='converted' WHERE id=? AND status<>'converted'`), reject if it affected 0 rows; (2) run the heavy work; (3) on success patch the link column (`converted_invoice_id`), on failure REVERT the claim back to its prior status so the doc stays retryable. The claim still guarantees single-winner; the explicit revert replaces the rollback you'd otherwise get for free inside one tx.
