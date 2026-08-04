---
name: Balance sheet current-period net income line
description: Synthetic صافي ربح/خسارة الفترة الحالية equity line in the web balance-sheet report — sign convention and as-of-date rule
---

- `/api/accounting-reports/balance-sheet` injects a SYNTHETIC equity row (`id:-1, synthetic:true`) = residual revenues − expenses up to asOfDate. It is computed at report time only — never stored as a JE.
- **Rule:** inclusion is based on the RESIDUAL P&L as of the date, NOT the fiscal year's current status flag. Closing entries dated ≤ asOfDate zero the P&L → the line self-hides; historical dates before closing still show it, keeping old sheets balanced.
- **Sign convention:** all balances from `getAccountBalances` are signed debit−credit (assets positive, liabilities/equity negative). Profit ⇒ row balance = −netIncome. The balancing invariant is `assets + liabilities + equity ≈ 0` — never `assets − (liab+equity)` (opposite signs).
- Frontend `BalanceSheet.tsx` filterGroup must keep `r.synthetic` rows regardless of parent/level/zero filters (they have no COA tree node).

**How to apply:** any new consumer of /balance-sheet or new synthetic report lines must follow the same signed convention + sum-to-zero check.
