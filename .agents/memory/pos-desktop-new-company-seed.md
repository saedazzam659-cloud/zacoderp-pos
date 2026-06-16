---
name: POS Desktop new-company auto-seed
description: How a fresh offline pos.db is seeded (COA, fiscal year, masters) and how base currency is set/rebased by country.
---

# New-company auto-seed (offline pos.db)

All seeding runs from `db::ensure_schema` (db.rs) on every `db::open()`, but each
seed fn is idempotent (count-guarded), so it only populates a fresh/empty DB.

- COA enrichment lives in `seed_default_accounts` and is **purely additive**.
  **Why:** the offline JE engine (`accounting.rs`) resolves accounts by HARDCODED
  codes via `account_id_by_code(...)` which ERRORS if a code is missing. So the
  engine codes (1000/1100/1101/1200/1300/1400/1500/11091/2000/2100/2200/3000/
  4000/4100/5000/5100/5200, plus seed_currencies 4900/5900, seed_inventory
  1310/5300) must stay present; new accounts must not collide and parents must be
  listed before children (by_code map is built in array order).
- Fiscal year + 12 monthly periods: `seed_fiscal_year` (current calendar year).
- Default masters: `seed_company_masters` (walk-in customer + one supplier).

## Base currency by country
- `currency_for_country(iso)` in db.rs MUST mirror `ARAB_COUNTRIES` in
  `src/lib/currency.ts` (all 22 Arab states). **Why:** any ISO missing from the
  Rust map silently no-ops the rebase and leaves base = SAR for that operator.
  If you add/edit a country in currency.ts, update this map in lockstep.
- `rebase_currency_for_country(conn, iso)` flips `currencies_local.is_base` to the
  country's currency — but is a **no-op once `journal_entries_local` OR
  `offline_invoices` has any row** (rebasing an active ledger corrupts the books),
  and a no-op if it's already the base. It inserts the currency row first if the
  6-currency seed didn't include it.
- It is triggered two ways: at boot from `ensure_schema` if `pos_desktop_country`
  was already persisted (e.g. cloud activation), and from `standalone_set_setting`
  when the operator picks `pos_desktop_country`. Note this is the SQLite
  accounting base — separate from the display-symbol piggyback documented in
  pos-desktop-country-currency.md.
