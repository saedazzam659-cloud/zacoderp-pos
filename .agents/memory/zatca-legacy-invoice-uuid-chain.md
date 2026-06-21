---
name: ZATCA legacy invoice UUID + PIH chain
description: Why the legacy invoices-table ZATCA flow needs a deterministic cbc:UUID and a submit-time hash re-persist, and the one edge case left unhandled by choice.
---

# ZATCA legacy invoice flow: UUID must be deterministic, hash chain is built at issuance

The legacy invoices-table ZATCA path (issuance in `routes/invoices.ts`, submit in
`routes/zatca.ts`) builds and **persists** `invoiceHash` at **issuance**, and the
PIH chain reads each prior invoice's PERSISTED `invoiceHash` as the next one's
`previousInvoiceHash`. The submit path historically did NOT re-persist the hash.

## Rules
- The `<cbc:UUID>` (and the matching ZATCA API-body `uuid`) MUST be a valid GUID;
  the human invoice number ("160") is rejected by clearance with
  "UUID format in the API body is not valid".
- The UUID is inside the hashed/signed XML, so it MUST be **deterministic** and
  **identical at issuance and submit** (and stable across retries) — otherwise the
  issuance-persisted hash and the submit-rebuilt hash diverge and the forward PIH
  chain breaks. Use a hash-derived GUID (sha256 of an immutable identity →
  8-4-4-4-12 with version/variant bits), NOT `randomUUID()`.
- The submit success path should re-persist `invoiceHash = built.invoiceHash`
  **only on accepted (CLEARED/REPORTED)** outcomes, never on rejection/gateway
  failure, and must leave `previousInvoiceHash` (backward link) untouched. This
  self-heals rows issued before the deterministic-UUID change.

**Why:** a previous `randomUUID()` attempt passed format validation but broke the
forward chain because the random submit hash never matched the issuance-persisted
hash that the next invoice chains from.

**How to apply:** any new path that builds/submits a ZATCA invoice in this legacy
flow must reuse the same deterministic-UUID helper at both build sites; never let
the mapper fall back to `invoiceNumber` for the UUID on a submitted document.

## Known unhandled edge case (left by user choice)
If invoice N was issued BEFORE the deterministic-UUID change and a successor N+1
was ALREADY issued (capturing N's old hash as its `previousInvoiceHash`) before N
is submitted/healed, N+1's PIH stays stale. Full robustness would require
recomputing `previousInvoiceHash` from the live predecessor at submit time
(chain-reconciliation), which changes chain semantics. User opted to handle any
such pending legacy rows operationally (re-issue before submit) instead. The real
production incident was the SALES flow (`routes/sales.ts`), fixed separately.
