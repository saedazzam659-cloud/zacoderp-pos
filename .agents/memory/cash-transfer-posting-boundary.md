---
name: Cash-transfer posting boundary
description: Preserve the shared transfer/accounting lifecycle for cash-to-bank deposits and cashbox transfers.
---

Cash deposits must use the existing cash-transfer records and shared posting lifecycle. The user explicitly approved changing shared posting behavior, including transfers originating from the web UI. Do not create a parallel deposit table or route deposits through cash expenses.

**Why:** The existing transfer record is the product's source of truth, and the user emphasized that the shared-path change must be correct and suitable for existing workflows.

**How to apply:** Keep source-balance validation, tenant/branch checks, and journal-entry linkage/idempotency in the shared posting path. New mobile deposit behavior should remain additive and leave the existing web UI intact.
