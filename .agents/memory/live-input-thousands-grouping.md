---
name: Live input thousands grouping
description: Excel-style live comma grouping INSIDE amount inputs (shared Input) — gating rules, comma-strip-before-onChange, caret restore
---

The shared web `Input` component paints live thousands separators (100000 → "100,000") for amount fields, display-only.

**Rule**: grouping activates ONLY when ALL hold: controlled (value + onChange), `inputMode="decimal"`, `type` undefined/"text", no `data-no-group` attr. `inputMode="numeric"` is deliberately EXCLUDED (shared by OTP / VAT numbers / postal codes / phone ids / qty), and `type="number"` is excluded (browser rejects commas in the value).

**Why:** amounts app-wide use the `type="text" inputMode="decimal"` pattern with parent parseFloat sanitizers; grouping any wider corrupts identifier fields, and type=number silently drops comma values.

**How to apply:**
- `handleChange` strips commas from `e.target.value` BEFORE calling parent onChange — parents must always receive the RAW string (covers typing AND paste of "1,234.56").
- Caret preserved as "count of non-comma chars before caret" (caretRef) and restored in a `useLayoutEffect` after the grouped repaint, only if the input is still `document.activeElement`.
- Grouping is applied AFTER hide-zeros + trimTrailingZeros display transforms.
- `onChange={handleChange}` must stay AFTER `{...props}` in the JSX spread or the parent's onChange wins.
- Never add `maxLength` to a groupable decimal field — commas consume slots. Opt out per-field with `data-no-group`.
