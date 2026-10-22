---
name: Grid localization coverage
description: Project expectations for Arabic/English localization across system grids.
---

Every system grid's headings and surrounding UI controls should follow the selected Arabic or English language. Static Arabic JSX text is localized only when an exact translation exists, so audit the full set of grid headings and controls rather than assuming the shared plugin covers them automatically. Resolve ambiguous labels in their screen context, and preserve entered business data and record values.

**Why:** The user clarified that the `/sales/invoices` screen was already in English; mixed Arabic UI labels were a defect. Partial coverage must not be reported as system-wide completion.

**How to apply:** Before finishing localization work, scan all relevant grids for untranslated headings and controls, add contextual mappings where needed, and state any verification limits such as routes that require sign-in.
