---
name: HijriDateField calendar popover
description: Hijri (Umm al-Qura) date field with dropdown month-grid picker in zatca-invoicing
---

`components/ui/hijri-date-field.tsx` is the ONE Hijri input for the web app (used in HR Employees for birthDateHijri and the iqamaExpiry Hijri companion).

- Two-way bound to a GREGORIAN ISO field: typing/picking a Hijri date converts via `lib/hijri.ts` (Umm al-Qura) and writes ISO; the Gregorian field stays the single source of truth.
- The popover calendar derives month length (29/30) by checking whether day 30 converts (`hijriToGregorianIso` non-null), pads the grid Sun-first via `getUTCDay` of day 1, year range 1300–1500 AH.
- **How to apply:** any new "هجري" field must reuse HijriDateField bound to the same ISO state as its Gregorian sibling — never store a separate Hijri string column.
- **Why:** dual-stored dates drift; conversion-on-render keeps ZATCA/reports on Gregorian ISO only.
