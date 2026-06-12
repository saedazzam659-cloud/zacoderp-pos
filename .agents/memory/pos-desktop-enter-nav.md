---
name: POS Desktop Enter-to-advance field navigation
description: How keyboard Enter-navigation works across admin entry forms (SearchCombobox + native inputs) and the value-sentinel gotcha.
---

# POS Desktop Enter-to-advance navigation

Admin entry screens (e.g. SalesInvoicesAdmin) support fast keyboard entry: pressing
Enter jumps focus to the next field in DOM order. Implementation:

- A `formRef` wraps the form; `advanceFrom(el)` queries `[data-fnav]` nodes in DOM
  order and focuses the next one (selecting its text). It must **skip
  disabled/hidden non-focusable nodes** and verify `document.activeElement` landed
  before selecting, or focus stalls on locked/collapsed controls.
- Native inputs enrol via a `navInput` spread (`data-fnav` + onKeyDown). Shared
  components that wrap native inputs (e.g. `LineDiscountCell`) need their OWN
  opt-in nav props (`navAttr` / `inputClassName` / `onEnterNavigate`) forwarded to
  the inner input — they are NOT auto-enrolled.
- `SearchCombobox` takes `navAttr` / `inputClassName` / `onEnterNavigate`. Enter on
  a CLOSED combobox advances; Enter while OPEN picks the highlighted option then
  advances.

**Gotcha — value sentinel 0:** the "closed combobox already has a value → advance"
check must key off `selected != null` (a matching option exists), NOT a value
sentinel like `value !== 0`. Several pickers use `0` as a real selection
(`customerId=0` = "بدون عميل", default warehouse). Testing `value !== 0` strands
those on Enter (re-opens instead of advancing).

**Why:** this is keyboard-only behavior, never caught by typecheck or by the
architect reading code; only surfaces when a cashier hits Enter on a 0-valued
picker. Found in architect review of the Sales Invoice screen enhancement.
