---
name: Language-switch completeness
description: The product expectation for switching the ERP interface between Arabic and English.
---

Selecting English should leave navigation, labels, buttons, placeholders, tooltips, dialogs, and other interface controls in English across the relevant screens. Direction and alignment should follow the selected language.

Preserve user-entered business data in its original language. When a record has a localized English name, show it in English mode; do not translate or rewrite user data as part of a UI-language change.

Print and report exports follow the active interface language, including browser print, PDF, and Excel. English output uses translated template labels and available English master-data fields; unpaired user-entered values remain unchanged.

**Why:** Mixed-language screens have been observed after switching to English, including Arabic UI fallbacks and RTL-only containers. Users distinguish interface labels from the business records they enter.

**How to apply:** When auditing a screen, printer, or export renderer, check labels and direction as well as locale coverage. Select English values only from corresponding English fields; do not translate or alter stored values.
