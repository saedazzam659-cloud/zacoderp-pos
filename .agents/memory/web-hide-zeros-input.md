---
name: Web hide-zeros numeric inputs
description: How the zatca-invoicing web app hides 0 in numeric input fields, and why it's safe/display-only.
---

# Web "hide zeros in numeric inputs" feature

The rule: numeric INPUT fields render blank + a faint "0" placeholder instead of "0"
when the company's `companies.show_zeros` is off. Default off (= hide) for existing
AND new companies. Toggle lives in General Settings (عرض الصفر / إخفاء الصفر).

**Where the logic lives:** the SHARED `components/ui/input.tsx`. One change covers
every screen using the shared `<Input>` — no per-form rollout.

**A "numeric" field is NOT only `type="number"`.** The line-item grids
(SalesDocumentForm / PurchaseDocumentForm — qty, freeQty, unitPrice, discount,
discountAmount, vatRate) use `type="text" inputMode="numeric|decimal"` with a
sanitizing onChange, NOT `type="number"`. The blank-zero condition must treat
`inputMode==="numeric"||"decimal"` as numeric too, or invoice/order/quotation/return
LINE zeros stay visible while the rest of the app hides them. (Route note:
`/sales/invoices/new` → SalesInvoiceForm → re-exports `SalesDocumentForm mode="invoice"`.)

**Why:** "across ALL screens" with least risk + consistency. Editing hundreds of
inputs individually is error-prone; a single shared-component hook is uniform and
reversible via the toggle.

**Typing must un-blank (critical):** the zero-blank must STOP as soon as the user
types during the current focus session (`typedSinceFocus` state: reset on focus, set
in onChange). Otherwise typing "0" on the way to "0.58" is swallowed → value ends up
".58". An untouched zero field stays blank on focus (no clearing needed) — only a
typed zero shows.

**How to keep it display-only (critical invariant):**
- Blank ONLY a *controlled* input: `value !== undefined && typeof onChange === "function"`.
  Controlled inputs submit from parent React state (which still holds 0), so blanking
  the box is purely cosmetic.
- NEVER blank uncontrolled / ref-driven fields (react-hook-form `register()` passes no
  `value`) — those are read from the DOM on submit, so blanking would corrupt the value.
- Read auth via `useContext(AuthContext)` (exported), NOT the throwing `useAuth`, so
  `<Input>` still renders on login / SuperAdmin-login pages OUTSIDE `AuthProvider`.

**Backend:** `showZeros` rides the existing `PATCH /companies/:id/general-settings`
handler (coerced with `!!` like its ~20 sibling auto-post toggles) and `/auth/me`
returns the full company row, so no extra select wiring. Column added via direct
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (not db push — see db-push-bundles-drift).

**Deliberate exemption:** the 4 raw `<input type="number">` in `PrintDesigner.tsx`
(page width/height mm, column width, element size) are layout-designer dimensions where
a literal 0 is meaningful and they never default to 0 — left untouched on purpose.

**Default quantity 1:** quantity inputs may opt into rendering the resting default
value `1` as blank. Keep this explicit and quantity-only; never infer it from
`inputMode`, because VAT/OTP/identifier and non-quantity numeric fields also use the
same modes and a real `1` must remain visible there. As with hidden zeros, an actively
typed `1` stays visible until blur so input remains predictable.

**Why:** invoice users found the prefilled `1` visually confusing, but the app still
needs quantity 1 in state for totals, stock, and save payloads.

**How to apply:** mark each controlled quantity field with the shared input's
quantity-default opt-in. Apply it whenever a new document quantity grid is added;
do not use it for prices, rates, conversion factors, or identifiers.
