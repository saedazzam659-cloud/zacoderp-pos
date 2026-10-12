---
name: Web sales thermal printing
description: Default and activation rules for thermal printing in web sales invoices and returns.
---

Keep A4 as the default for web sales invoices and returns. A company can save thermal mode per template; enabling it changes that same design to 80 mm portrait output instead of substituting a separate design. Automatic printing after save remains opt-in.

**Why:** The owner wants thermal printing available without changing existing paper-size behavior, and wants a saved per-template choice that works consistently across users.

**How to apply:** Keep the built-in thermal designs available, but let A4 designs opt into 80 mm output through a company-level template setting. Preserve A4 defaults and only auto-print when the saved company preference is enabled.

After-save print preview is a separate company preference for sales invoices and returns. It opens the template chooser without launching the browser print dialog; when both preview and auto-print are enabled, preview takes precedence. Put the configured default template first, then the remaining enabled templates.

**Why:** The owner wants to inspect the saved invoice and choose whether to print, while keeping the older direct auto-print behavior available as a separate setting.

**How to apply:** Preserve the two preferences independently, use the existing sales print modal for the after-save handoff, and keep the explicit Print button as the only print action in preview mode.

Thermal print width calibration is separate from the company's template choice: default to 100%, let the user reduce the printed content and type together, and save the adjustment per company/template in that browser so different printer stations do not overwrite one another. A4 output is unaffected.

**Why:** The owner wants to tune the actual thermal printer's usable width without repeatedly editing templates or wasting paper; the roll is reported as 80 mm, but each device/driver can expose a different printable area.

**How to apply:** Keep calibration available only when the selected template is thermal, retain 100% as the reset/default, and do not claim physical output is verified until a printed sample is checked.
