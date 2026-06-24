---
name: Web hide-zeros numeric inputs
description: How the zatca-invoicing web app hides 0 in numeric input fields, and why it's safe/display-only.
---

# Web "hide zeros in numeric inputs" feature

The rule: numeric INPUT fields render blank + a faint "0" placeholder instead of "0"
when the company's `companies.show_zeros` is off. Default off (= hide) for existing
AND new companies. Toggle lives in General Settings (عرض الصفر / إخفاء الصفر).

**Where the logic lives:** the SHARED `components/ui/input.tsx`. One change covers
every screen using `<Input type="number">` (~72 files) — no per-form rollout.

**Why:** "across ALL screens" with least risk + consistency. Editing hundreds of
inputs individually is error-prone; a single shared-component hook is uniform and
reversible via the toggle.

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
