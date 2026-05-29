---
name: Date inputs — impossible combos & UTC default drift
description: Two recurring date-field traps in this ERP and the DD/MM/YYYY calendar field that avoids them.
---

# Date field traps (and the fix)

Two separate bugs bit the journal-entry date field:

1. **Native `<input type="date">` silently discards impossible day+month combos.**
   Changing only the month to February while the day is 29 (non-leap year) yields
   `2026-02-29`, which the control refuses WITHOUT firing a change event — so React
   state keeps the old date and any derived UI (e.g. a sequence "next number"
   badge's `{MM}` token) shows the wrong month. The bad value never reaches the
   server, so server-side clamping cannot help here.

2. **`today()` via `new Date().toISOString()` is UTC, not local.** In Saudi (UTC+3)
   before 03:00 local the UTC date is still "yesterday", so forms open a day behind.
   Always build a default date from LOCAL parts (getFullYear/getMonth/getDate).

**Fix / how to apply:** Use the reusable `SmartDateInput` instead of native date
inputs wherever the date drives derived UI or is persisted. It shows the familiar
`DD/MM/YYYY` form with a calendar popover as the primary editor (real days per
month → February and day-29 both behave correctly, no "stuck on 28"), accepts
Arabic-Indic digits when typed, clamps impossible days to month-end on commit, and
emits ISO `YYYY-MM-DD` (drop-in value/onChange; spread `fp.dateBounds("date")` for
min/max).

**Why:** Native date controls give no hook for invalid segment edits, and UTC date
math drifts a day for positive-offset timezones.

**Rollout:** Only the journal-entry form is migrated. Many other native
`type="date"` inputs share trap #1 — migrate them over time, prioritising any whose
date feeds a sequence number, fiscal period, or peeked/derived value.
