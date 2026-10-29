---
name: POS Desktop full-width UI
description: User-directed width and table styling for POS Desktop back-office screens.
---

For POS Desktop back-office screens, use the available window width instead of narrow centered page caps. Keep document forms outlined with subtle neutral borders rather than prominent thick blue frames. Prefer compact, legible spreadsheet-like tables with clear headers and row separators.

**Why:** The user requested that all POS Desktop screens use the available width, with clearer Excel-like data tables and less prominent form framing.

**How to apply:** Keep this as a presentation rule for back-office screens. Preserve existing business logic, natural document-page scrolling, and the register's sticky payment controls.

For invoice item tabs, follow the web invoice's compact, full-width grid and horizontal totals summary. Keep selected-item counts accurate, and adapt the grid to the Windows window width rather than forcing a wide table and a narrow vertical totals card.

**Why:** The Windows sales-invoice tab's oversized table and vertical totals panel were specifically rejected in favor of the web invoice's item-tab presentation.

**How to apply:** Change only the presentation unless the user asks for workflow changes; preserve pricing, discounts, taxes, validation, and natural page scrolling.

Keep the essential item, unit, quantity, free quantity, price, discount, tax, and line-total fields visible. Put less-used line notes and conditional brand selection in expandable row details; automatically open details for existing notes or saved brands.

**Why:** A dense invoice grid is easier to scan when secondary fields are available without occupying a permanent column, while existing data remains visible and editable.

**How to apply:** Maintain the current line data and calculations. Expand details when selecting an item that requires a brand, and preserve disclosure state correctly when a row is removed.
