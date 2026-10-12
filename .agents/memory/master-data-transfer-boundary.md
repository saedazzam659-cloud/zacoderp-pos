---
name: Company master-data transfer boundary
description: Scope and safety rules for copying setup data between companies.
---

The approved SuperAdmin direction is central database source → existing agent-hosted company. Copy chart of accounts, cost centers, branches, warehouses, cashboxes, banks, customers, suppliers, customer/supplier groups, items, units, users, and sales representatives. It must not transfer invoices, journal entries, opening balances, stock balances, or operational transactions.

For an existing destination, skip matching master records and add only missing ones. Match by company-local codes or stable business identity, never source-company database IDs. Preserve account parents by local account codes. New users are copied disabled until an administrator reviews them.

**Why:** The owner needs central setup copied into agent-hosted companies, not transaction history. Importing operational records would be out of scope and could alter financial or inventory history.

**How to apply:** Keep copy flows within the eleven approved setup types and any strictly necessary catalog-group dependencies. Never include balances or transaction entities without explicit user approval.

Progress reported from inside the target transaction is provisional; show final success only after commit, and make clear that a failed stage rolls the whole copy back.

**Why:** Users can otherwise interpret an in-transaction progress update as data already saved even though a later error will roll back every row.

**How to apply:** For streamed or staged copy feedback, distinguish “processed” from “committed” and present the final result only after the transaction resolves.
