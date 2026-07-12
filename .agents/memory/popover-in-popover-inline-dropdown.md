---
name: Popover-in-Popover needs inline dropdown
description: A portaled Radix Popover (e.g. SearchCombobox) nested inside another Popover closes the outer one; render nested dropdowns inline instead.
---

**Rule:** Never nest a portaled Radix Popover (like `SearchCombobox`) inside another Popover's content (e.g. the SmartDateInput calendar). The nested content portals to `<body>`, so the outer Popover's dismissable layer sees clicks in it as "outside interaction" and closes the whole thing.

**Why:** Hit while adding searchable month/year comboboxes to the shared date-picker popover — reusing `SearchCombobox` directly would have closed the calendar on every combobox click.

**How to apply:** Inside any Popover/Dialog content, render dropdowns INLINE (absolutely-positioned div, no portal), replicating the SearchCombobox styling (`InlineSearchCombobox` in `smart-date-input.tsx` is the reference). Select rows with `onMouseDown` + `preventDefault` so the input blur doesn't race the click.
