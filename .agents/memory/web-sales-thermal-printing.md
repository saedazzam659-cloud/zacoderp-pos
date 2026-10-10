---
name: Web sales thermal printing
description: Default and activation rules for thermal printing in web sales invoices and returns.
---

Thermal templates for web sales invoices and returns must not become the default automatically. Keep A4 as the default unless a company explicitly selects a thermal template; automatic printing after save must remain opt-in.

**Why:** The owner wants thermal printing available without changing existing paper-size behavior or causing unexpected print dialogs.

**How to apply:** Reuse the existing thermal templates and company print preferences. Preserve the A4 default and only auto-print when the saved company preference is enabled.
