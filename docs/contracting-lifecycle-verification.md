# Contracting lifecycle verification

## Isolation and evidence boundaries

Verification used a disposable PostgreSQL cluster bound to loopback, with a
new database directory and child-process-only connection configuration. It
did not use the production or existing development database. The runner
destroys its cluster on exit.

Browser verification used the actual application with intercepted HTTP
responses and synthetic fixtures, with service workers blocked. This proves
the browser interactions and generated files, not live backend integration.
The real PostgreSQL regression independently exercises accounting services
and the production bill-create HTTP router.

No deployment or production financial activation was performed.

## Repeatable checks

```sh
CONTRACTING_ISOLATED_LIFECYCLE=1 \
  sh artifacts/api-server/scripts/run-isolated-contracting-lifecycle.sh

cd artifacts/zatca-invoicing
node --import tsx --test \
  __tests__/contracting-save-retry.test.ts \
  __tests__/contracting-print-export.test.ts \
  __tests__/contracting-settlement-reversal-ui.test.ts
pnpm typecheck
```

Do not substitute the general API `test` command: legacy integration suites
can use the current database connection.

## Verified scenarios

- Owner/subcontract creation replay and independently priced BOQ.
- Two successive owner bills with previous/current/cumulative snapshots.
- Actual posted advance recovery; retention limited by the adjusted contract
  cap, including an approved variation.
- Owner receivables and subcontract payables; posted balanced journals and
  incoming project cost.
- Partial/full payments, concurrent same-key payment replay, settlement
  reversal and duplicate reversal replay.
- Reversal journals preserve accounts/cost centers and flip debit/credit.
- Posted correction creates a linked draft atomically, preserves BOQ,
  additions and advance policy, and permits replacement approval.
- Concurrent 60+60 certification against 100 units admits one request,
  rejects the other without accounting artifacts, then permits a 40-unit
  revision with final 60/40/100 snapshots.
- Actual bill-create route replays an auto-numbered committed request after
  its response is discarded; deleting a draft does not leave a blocking claim.
- Schema reconciliation creates replay storage in both the central and a
  second isolated datasource in the same process, without sharing readiness.
- Browser lost-response retry keeps the same request key and displays one
  saved bill. Gateway-failure classification also has focused regression tests.
- New detail editor preserves A-01/B-01 order and displays quantity/value
  columns and financial additions.
- Actual XLSX and PDF downloads were captured and their file signatures
  checked; workbook contents include the company, bill and line details.
- Model 14 print popup renders the contracting title, company and additions,
  without sales/tax-invoice titles.
- Production export-row and HTML tests distinguish retention from ordinary
  deductions, preventing duplicate presentation.
- Browser settlement reversal requires confirmation, posts the request,
  removes the reversal action and displays the reversing journal reference.

## Findings corrected during verification

Server-side bill-create replay, auto-number allocation timing, gateway retry
handling, replay-table deletion/reconciliation behavior, concurrent settlement
replay, correction-copy fidelity, and retention/deduction export mapping were
corrected. The initial browser editor failure came from a fixture addition
missing its required ID; the fixture was corrected and the blocked steps
completed successfully.

Passing evidence: 36 focused backend checks, 10 focused frontend checks,
frontend typechecking, and the real-database lifecycle scenario (approximately
6.1 seconds in its final run). The browser create/retry pass and its
fixture-corrected continuation both produced the required interaction evidence.

## Limits

The browser was not connected to the disposable PostgreSQL service for one
continuous end-to-end run. Its evidence must not be described as production
verification. Advance and retention-release reversals are separate accounting
operations; the added settlement reversal supports bill receipts/payments only.
The API repository has unrelated existing typecheck errors; targeted isolated
runtime tests and frontend typechecking are the relevant passing checks here.