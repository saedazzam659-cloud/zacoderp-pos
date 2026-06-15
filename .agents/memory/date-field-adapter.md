---
name: DateField adapter replaces native date inputs (zatca-invoicing)
description: Convention — all date inputs use DateField/SmartDateInput, never native <input type=date>
---

Native `<input type="date">` renders a garbled Hijri/Arabic placeholder
("ض/ا/ض…") on some Saudi devices and looks inconsistent across OS locales. The
whole zatca-invoicing web app was migrated off it.

**Convention:** every date field uses `<DateField>`
(`components/ui/date-field.tsx`), a thin adapter over `SmartDateInput`
(`components/ui/smart-date-input.tsx`). SmartDateInput shows a locale-independent
`DD/MM/YYYY` field + calendar popover + Arabic-Indic digit input, but stores /
emits ISO `YYYY-MM-DD`.

**Why DateField exists separately from SmartDateInput:** DateField keeps the
*native* event-style contract — `value` is a string, `onChange={(e)=>e.target.value}`
— so the migration was a mechanical rename of `<Input type="date" …>` →
`<DateField …>` with zero call-site logic changes. SmartDateInput's own onChange
is `(isoString) => void`.

**How to apply:**
- Never reintroduce native `<input type="date">` anywhere in zatca-invoicing — use `<DateField>`.
- DateField forwards `ref`, `onBlur`, `data-*`, `onFocus`, `tabIndex`, etc. through to the inner input (needed for React Hook Form `{...field}` touched-state + focus-on-error and for `data-testid` test hooks). It intentionally drops native-only `dir`/`step`/`autoComplete`/`inputMode` (SmartDateInput sets its own).
- SmartDateInput is a `forwardRef` whose props extend `InputHTMLAttributes` (minus value/onChange/min/max/type), so it accepts arbitrary native attrs and spreads them onto the base `<Input>` (rest spread BEFORE the component's own date-specific attrs so the latter win).
