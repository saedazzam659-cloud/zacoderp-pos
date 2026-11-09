---
name: Language-switch completeness
description: The product expectation for switching the ERP interface between Arabic and English.
---

Selecting English should leave navigation, labels, buttons, placeholders, tooltips, dialogs, and other interface controls in English across the relevant screens. Direction and alignment should follow the selected language.

POS Desktop keeps language selection available before entry and inside the signed-in shell; the saved choice follows the local installation across restarts.

Preserve user-entered business data in its original language. When a record has a localized English name, show it in English mode; do not translate or rewrite user data as part of a UI-language change.

Print and report exports follow the active interface language, including browser print, PDF, and Excel. English output uses translated template labels and available English master-data fields; unpaired user-entered values remain unchanged.

**Why:** Mixed-language screens have been observed after switching to English, including Arabic UI fallbacks and RTL-only containers. Users distinguish interface labels from the business records they enter.

**How to apply:** Keep the pre-entry selector and in-app switch connected to the same persisted locale setting. When auditing screens, print, or exports, check labels and direction and use English master-data fields only when they exist; never translate or alter stored values.

Shared localized-text helpers must guard missing or non-string values before trimming or translating them.

**Why:** Tenant-specific data can contain optional labels; an English-only transformation must not turn a blank display value into a screen crash.

**How to apply:** Make localization utilities safe at their boundary, and use UI-only placeholders where a missing business label needs explanation.
