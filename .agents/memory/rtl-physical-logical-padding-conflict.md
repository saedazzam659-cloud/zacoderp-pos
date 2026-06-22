---
name: RTL physical+logical padding conflict
description: Mixing Tailwind physical px-*/pl-*/pr-* with logical ps-*/pe-* on the same element silently collapses reserved gutters in RTL.
---

# RTL physical + logical padding conflict

Never combine a physical padding utility (`px-3`, `pl-*`, `pr-*`) with a logical
one (`ps-*`, `pe-*`) on the same element when the element can render RTL. In RTL,
`pe-*` (padding-inline-end) resolves to the **left** physical side — the same side
`px-*` already sets via `padding-left`. They are different CSS longhands targeting
the same computed side, so the winner is decided by Tailwind's emitted source
order, not by which class you wrote last. The physical rule often wins and quietly
overrides the logical one.

**Why:** SearchCombobox reserves a 3.5rem inline-end gutter (`pe-14`) for its
absolutely-positioned clear(×)+chevron icons (`end-2`). It also had `px-3`. In the
RTL Arabic app, `px-3`'s `padding-left:0.75rem` beat `pe-14`'s 3.5rem, collapsing
the gutter so selected labels rendered *under* the icons and looked cropped
(e.g. "تداول مجموعة" → "تدوي مجموعة"). LTR happened to look fine, masking it.

**How to apply:** On any direction-aware control, use a single padding system —
prefer purely logical (`ps-3 pe-14`). If you see an absolutely-positioned
trailing-icon control whose text overlaps the icons only in RTL, suspect a
`px-*` + `pe-*` (or `pl-*`/`ps-*`) clash before touching the icon positioning.
