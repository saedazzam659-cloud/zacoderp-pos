---
name: Party master-data import — allow-duplicates mode
description: How the customer/supplier bulk-import dedup works and what allow-duplicates must do to avoid commingled AR ledgers.
---

# Party master-data import & allow-duplicates

`importPartyMasterData` (api-server `lib/partyMasterImport.ts`) upserts customers/suppliers
from a spreadsheet. Default precedence: customer = vatNumber → nameAr; supplier = code →
vatNumber → nameAr. A match → UPDATE, else INSERT.

**Allow-duplicates** (`allowDuplicates: true` opt) skips the whole match-resolution block so
EVERY row INSERTs as a separate party — used for multiple establishments that legitimately
share one group VAT number.

**Why the ledger detail matters:** an inserted customer with no branch/account column falls
back to `ensureCustomerLedger(cid, name)`, which is **idempotent by sibling name** — two
same-named establishments would otherwise SHARE one AR sub-account and their statements would
commingle. Allow-duplicates must pass `forceNew=true` (added to `ensureEntitySubAccount`) so
each gets its own ledger. The branch/account-column path already always mints fresh via the
importer's local `createPartySubAccount`, so only the no-parent fallback needed the flag.

**How to apply:** any new "insert every row" / bulk-clone path that auto-creates entity ledgers
must NOT route through the idempotent `ensure*Ledger` helpers without `forceNew`, or it silently
reuses accounts.

## UI location gotcha
The customer bulk-upload users actually use is `artifacts/zatca-invoicing/src/pages/GeneralSettings.tsx`
"بيانات العملاء" tab → `handlePartyDataUpload("customer")` → `POST /api/customers/import`.
This is NOT the `settings/DataImportExport.tsx` wizard (a separate entity-import path). Confirm
which upload screen the user means before adding import options.
