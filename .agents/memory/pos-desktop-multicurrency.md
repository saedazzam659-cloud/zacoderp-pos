---
name: POS Desktop multi-currency model
description: Currencies / exchange-rates / treasury-transfers data flow and FX-diff JE posting rules.
---

POS Desktop stores **native-currency balances** on every treasury endpoint (cash boxes + banks each have their own `currency_code`), but all JEs are posted in the **base currency**. The conversion happens at JE-post time using the most-recent rate in `currency_rates_local`.

**Why:** Mixing currencies inside a single JE would break trial-balance invariants; native-currency balances let UI show "you have $500" without re-converting on every read.

**How to apply:**
- Treasury transfer between two currencies = balanced JE in base currency:
  - `DR dest_account = amount_to × dest_rate`
  - `CR source_account = amount_from × source_rate`
  - any `fx_diff` (gain → `CR 4900 fx_gain`, loss → `DR 5900 fx_loss`)
- Native shadow balances on `cash_boxes_local.balance` / `banks_local.balance` are updated **in their own currency** (not converted), so balance displays are always exact.
- Same-currency transfer must enforce `amount_from == amount_to`; if you let the UI mismatch them the fx_gain/fx_loss path will silently absorb the difference and corrupt reporting.
- Changing the `currency_code` on a cash box/bank with non-zero balance is **rejected** in the Rust command — you must zero it out via a transfer first; the lock indicator is plumbed through `EditState.lockedCurrency` in the admin form.

**Rate lookup contract** (`current_rate_to_base` in accounting.rs): returns 1.0 for the base currency; errors with a friendly Arabic message if no rate row exists. Any new code that converts must go through this helper, never read `currency_rates_local` directly.
