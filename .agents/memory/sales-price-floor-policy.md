---
name: Sales price floor policy
description: Company opt-in for the minimum manual sales price on web invoice lines.
---

Manual sales pricing remains open by default for every company, including existing companies. When a company enables the floor, a manually entered invoice-line price cannot be below the active catalog price; a lower configured alternative is allowed only after the user selects it. Approved offers remain valid, and opening an existing invoice must not silently reprice its saved lines.

**Why:** The user wants existing companies to keep their current open-price workflow unless they deliberately enable the control, while preventing accidental manual underpricing where the company opts in.

**How to apply:** Keep schema and company-creation defaults false. Gate the web invoice check on the company setting, and update the line's floor when the user selects an item, unit, brand price, or configured sales-price option.
