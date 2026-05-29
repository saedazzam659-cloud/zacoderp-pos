---
name: Native date input silently drops impossible dates
description: Why <input type="date"> caused a wrong sequence-number month, and the reusable SmartDateInput clamp fix + gradual rollout plan.
---

# Native `<input type="date">` silently discards impossible date combos

When a user edits only ONE segment of a native `<input type="date">` (e.g. changes
the month to February while the day stays at 29 in a non-leap year → `2026-02-29`),
the browser control **refuses the impossible value and fires NO change event**.
The React state therefore keeps the previously-valid date, and any UI derived from
it goes stale. In this app that surfaced as the journal-entry "next number" badge
showing the OLD month's `{MM}` token (only February broke, because day 29 is valid
in every other month), and risked SAVING the record with the wrong date.

**Why:** This is a browser limitation, not a server bug. The invalid string never
reaches the server, so server-side date clamping is pointless here. Verified:
`new Date("2026-02-29")` rolls over to Mar 1 (not Invalid); the bad combo simply
never commits client-side.

**How to apply:** Use the reusable `SmartDateInput`
(`artifacts/zatca-invoicing/src/components/ui/smart-date-input.tsx`) instead of a
native `<input type="date">` wherever a date feeds derived UI or gets persisted.
It clamps the day to the month's last valid day on full `YYYY-MM-DD` entry, offers
a real-days-only calendar popover, clamps into optional `[min,max]` policy bounds,
and reverts incomplete input on blur. It's a drop-in: same `value` / `onChange(v)` /
`readOnly` / `required` / `{min,max}` (spread `fp.dateBounds("date")`) / `title` props.

**Rollout status:** Only the journal-entry form is migrated (user chose gradual
rollout). ~131 other native `type="date"` inputs across the app carry the SAME
latent bug — migrate them to `SmartDateInput` over time, prioritising forms whose
date drives a sequence number, period selection, or any peeked/derived value.
