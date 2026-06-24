---
name: POS Desktop hide-zeros preference
description: Global "blank instead of 0" input preference — how it's wired and how to extend it
---

# Hide-zeros input preference

A global device preference (`pos_desktop_hide_zeros`, default ON) renders numeric
INPUT fields blank instead of a literal `0`, so the cashier types over an empty
box instead of clearing a leading zero.

- API in `lib/appSettings.ts`: `getHideZeros()` (absent key ⇒ ON), `setHideZeros()`,
  reactive `useHideZeros()`, and pure `blankIfZero(n, hide)` → returns `""` for a
  zero amount when on, else the value.
- Toggle UI lives in `SettingsGuide.tsx` (دليل الإعدادات, التحكم العام group),
  persisted on Save alongside profile/decimals (not immediate-toggle).
- Applied so far to the highest-traffic ENTRY forms only: Sales Invoice line inputs
  (qty/freeQty/unitPrice) and Item form (salePrice/pricePerKg).

**Why:** users complained that every numeric box showed `0` and they had to delete
it before typing. It's input-only ergonomics, NOT a formatting/display change.

**How to apply elsewhere:** call `const hideZeros = useHideZeros()` at the top of
the form component, wrap the input `value={blankIfZero(x, hideZeros)}`, and leave
`onChange` as `Number(e.target.value) || 0` so cleared fields still persist `0`
(never NaN/string). Do NOT touch report/print formatters — those use the decimals
setting, not this.
