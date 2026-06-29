---
name: ZATCA rejection reason capture
description: Why the ZATCA bridge showed "0 خطأ" on rejected invoices and the shape rules for capturing a real reason.
---

# ZATCA rejection capture — never store a reasonless rejection

The ZATCA clearance/reporting gateway does NOT always return validation
detail at top-level `errorMessages`. On a rejection it commonly returns:

- detail nested under `validationResults.errorMessages` / `.warningMessages`
- a flat `{ message, code }` body on an HTTP 400
- a **non-JSON** body (HTML error page / empty) — calling `response.json()`
  directly then throws and falls into the catch → a generic
  `فشل الاتصال` 500 with NOTHING stored.

Any of these made the bridge UI show a rejected invoice with "0 خطأ" and no
reason.

**Rules for every submit path (sales `/sales-invoices/:id/zatca-submit`,
legacy `zatca.ts`):**
1. Read `await response.text()` FIRST, then `JSON.parse` inside try/catch —
   never `response.json()` directly.
2. Normalize messages from BOTH `data.*Messages` and
   `data.validationResults.*Messages`.
3. On reject, ALWAYS synthesize a fallback reason when no structured errors
   exist: `data.message` → trimmed raw body → `رفضت بوابة ZATCA الفاتورة (رمز <status>) …`.
   Persist that so `zatcaErrorMessages` is never null on a rejected row.

**Why:** a rejected invoice with no stored reason is undebuggable for the
tenant and looks like a system bug. The fallback guarantees actionable text.

**How to apply:** when adding/altering any ZATCA submit handler, mirror this
text-first + dual-shape + fallback pattern. (As of this writing the sales path
has it; the legacy `zatca.ts` path still reads only top-level `errorMessages`
and would benefit from the same treatment.)

## Bridge UI status contract: approved/rejected/pending only

The ZATCA bridge screen (`ZatcaBridge.tsx`) renders badges, stat counters AND
the filter off `zatcaStatus ∈ {approved, rejected, pending, null}`. But the
submit handler persists the DETAILED success status `cleared`/`reported` to
`sales_invoices.zatca_status`. A cleared invoice therefore showed NO badge and
was counted in NEITHER the approved nor rejected totals (looked like "nothing
happened").

**Rule:** the bridge GET (`/sales-invoices-zatca-bridge`) MUST normalize each
row's status to the 3 UI buckets (`cleared|reported|approved → approved`,
`rejected → rejected`, else `pending`) before responding; and the submit
success response's top-level `status` must be `"approved"` (the detailed
cleared/reported value travels in a separate `zatcaStatus` field).
**Why:** the DB keeps the precise ZATCA verdict, but the UI speaks a coarser
3-state vocabulary — never leak the DB enum straight to this screen.
