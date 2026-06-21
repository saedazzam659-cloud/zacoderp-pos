---
name: POS Desktop fiscal-year seed starts at install month
description: Why the auto-seeded fiscal year on first run spans install-month..31-Dec, not 1-Jan..31-Dec
---

`seed_fiscal_year` (db.rs) runs once on first DB open (fresh install). It seeds
the fiscal year + its monthly periods from the **first day of the install month**
through **31 December** of the same year — NOT a full 1-Jan..31-Dec year.

**Rule:** start = `{year}-{install_month:02}-01`, end = `{year}-12-31`; generate
one monthly period for `m in install_month..=12`. Use `chrono::Local::now()` (the
machine wall clock), never `Utc::now()` — in UTC+3 (Saudi/Egypt) a late-evening
install can read the previous day/month under UTC and seed the wrong month.

**Why:** a mid-year install previously created empty already-past months
(Jan..May) that cluttered reports and the period picker. User chose: start from
the **1st of the install month** (not the exact install day) so same-month
back-dated entries (e.g. an opening balance dated the 5th when installed on the
21st) are still inside an open period — the exact-day option would reject them.

**How to apply:** only the auto-seed path changed. Manual `fiscal_year_create`
already honours the user-entered start/end via `month_periods` (which also handles
a partial first month). The next fiscal year (e.g. the following January) is the
user's job to create manually from the fiscal screen.
