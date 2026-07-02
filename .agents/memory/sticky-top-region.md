---
name: Sticky top region (header + nav)
description: How to keep the ERP top chrome (banner + header + horizontal menu) pinned without overlap or z-index regressions.
---

# Sticky top region in Layout.tsx (zatca-invoicing)

Making the horizontal top-nav menu stay visible on scroll must NOT hard-code a
per-child sticky offset. The header (`TopBar`) is variable-height (search/actions
row + a breadcrumb row that can wrap), so a `sticky top-14` (56px) on the menu
overlaps the header's second row.

**Rule:** wrap the acting-company banner + `TopBar` + `TopNavBar` in ONE
`sticky top-0` container and make the children static (remove their individual
`sticky` classes). The whole block pins together, so the menu always sits directly
under the header regardless of header height, in both topnav and sidebar layouts.
Put the amber banner at the TOP of the wrapper.

**Why:** hard-coded offsets drift when the header grows; one sticky wrapper is
height-agnostic.

**Z-index constraint (regression trap):** the mobile chrome layers are
desktop sidebar `z-20`, mobile backdrop `z-30`, mobile drawer `z-40`. The sticky
top wrapper must be `z-20` — NOT `z-30`. At `z-30` it ties the mobile backdrop and
(being a later DOM sibling) paints ABOVE the dim backdrop when the drawer is open,
causing overlap/click-through. `z-20` keeps it above page content, below the
backdrop, and it never overlaps the side-positioned desktop sidebar (content sits
in a `md:mr-64`/`md:ml-64` column beside it).
