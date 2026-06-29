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
