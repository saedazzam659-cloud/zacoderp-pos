---
name: Account delete guard + entity relink self-heal
description: COA account deletion must be reference-guarded; entity (supplier/customer) account links need repair + edit self-heal, never silent NULL.
---

**Rule:** Deleting a COA account must be blocked (409, Arabic reason) while anything references it — child accounts, JE lines, linked suppliers, linked customers. Entity edit (PUT) must never silently NULL an accounting link: explicit pick wins → else keep existing IF the account still exists → else re-mint via the ensure*Ledger helper. A `POST /repair-accounts` style endpoint (registered BEFORE `/:id`) heals historical dangling links; ensure*SubAccount is idempotent by same-name sibling reuse, so repair relinks orphaned minted accounts instead of duplicating.

**Why:** Prod company had 18/29 suppliers with account_id pointing at DELETED accounts — users deleted supplier sub-accounts one-by-one from the COA screen (DELETE had no guard), which broke "الربط المحاسبي" everywhere (balances, statements, JE aggregation). The delete guard checks only a subset of referencing tables — other modules referencing account ids remain unguarded (known residual gap; extend the guard when a new module links accounts).

**How to apply:** Same pattern for customers or any entity carrying account_id. Frontend: AccountCombobox `excludeIds` hides accounts already linked to OTHER entities (server 409s them anyway); never hide the currently-selected value. Prod healing goes through the published repair endpoint (prod SQL is read-only) — run twice, second run must report broken=0.
