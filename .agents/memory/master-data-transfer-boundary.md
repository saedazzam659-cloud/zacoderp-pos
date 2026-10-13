---
name: Company master-data transfer boundary
description: Scope and safety rules for copying setup data between companies.
---

SuperAdmins may copy approved setup data from any company location (central or agent) to any other company location, including central-to-agent, agent-to-central, and agent-to-agent. Copy chart of accounts, cost centers, branches, warehouses, cashboxes, banks, customers, suppliers, customer/supplier groups, items, units, users, and sales representatives. It must not transfer invoices, journal entries, opening balances, stock balances, or operational transactions.

For an existing destination, skip matching master records and add only missing ones. Match by company-local codes or stable business identity, never source-company database IDs. Preserve account parents by local account codes. New users are copied disabled until an administrator reviews them.

Different branch customer records may legitimately share one VAT number so each branch can keep a separate account. In the copy flow, duplicate customer names are conflicts; matching VAT numbers alone are not.

**Why:** The business tracks branch-level customer balances separately even when the branches share their parent organization's VAT registration.

**How to apply:** During copy, allow shared VAT values but block same-name customer records until the incoming copy is renamed or skipped. Do not overwrite target records silently; do not change ordinary customer validation without a separate request.

**Why:** The user needs setup data copied between central and agent-hosted companies in either direction, not transaction history. Importing operational records would be out of scope and could alter financial or inventory history.

**How to apply:** Keep copy flows within the eleven approved setup types and any strictly necessary catalog-group dependencies. Resolve both source and target database locations explicitly, reject copying a company to itself, and never include balances or transaction entities without explicit user approval.

Progress reported from inside the target transaction is provisional; show final success only after commit, and make clear that a failed stage rolls the whole copy back.

**Why:** Users can otherwise interpret an in-transaction progress update as data already saved even though a later error will roll back every row.

**How to apply:** For streamed or staged copy feedback, distinguish “processed” from “committed” and present the final result only after the transaction resolves.
