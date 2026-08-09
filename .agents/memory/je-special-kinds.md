---
name: JE special kinds (نوع القيد)
description: Journal-entry form's create-mode special-kind selector that reuses existing modules after save.
---

The JE form (zatca-invoicing) has a create-mode-only «نوع القيد» selector (state `specialKind`, panel after the fieldset): عادي / افتتاحي / أصل ثابت / مصروف مقدم / إيراد مقدم / مصروف مستحق / إيراد مستحق.

**Rule:** special kinds must REUSE existing endpoints after the JE saves — never duplicate module logic:
- افتتاحي → just sets `entryType="opening"` (same mechanism as the opening-balances screen).
- أصل ثابت → POST `/api/fixed-assets/assets` with `sourceType:"journal_entry"`, `sourceDocumentId=savedId`; the server forces `skipAcquisitionJe` so no second acquisition JE.
- المقدم/المستحق → POST `/api/adjustments` with `type:"prepaid"|"accrued"` only (the engine has no revenue-specific types). Revenue kinds map onto the same debit/credit contract: engine always debits `expenseAccountId`, credits `contraAccountId` monthly — deferred revenue = DR unearned / CR revenue, accrued revenue = DR receivable / CR revenue. Accrued kinds use start=end=due date (single installment).

**Why:** user requirement «بدون تغيير في اللوجيك»; the adjustments engine and FA source-link dedup already handle scheduling/idempotency.

**How to apply:** the follow-on call runs in save onSuccess (capture `{...spec}` BEFORE the auto-mode form reset); failure is non-atomic by design — toast tells the user to create the record manually in the module. End-date math must clamp day-of-month (31st rollover). The old edit-mode «الأصول الثابتة المرتبطة بالقيد» panel was removed at user request.
