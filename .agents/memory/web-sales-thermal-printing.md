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

Thermal print width calibration belongs inside each thermal template card in General Settings (not only in the print chooser): default to 100%, let the user reduce the printed content and type together, and save the adjustment per company/template in that browser so different printer stations do not overwrite one another. A4 output is unaffected.

**Why:** The owner wants to tune the actual thermal printer's usable width without repeatedly editing templates or wasting paper; the roll is reported as 80 mm, but each device/driver can expose a different printable area.

**How to apply:** Show the control in each enabled thermal template card and in the print chooser for that selected thermal template; both surfaces must read/write the same setting. Retain 100% as reset/default, and do not claim physical output is verified until a printed sample is checked.

Thermal font boldness uses a separate per-company/template browser setting from 0 (unchanged) to 10, shared by General Settings and the print chooser; apply it only to thermal print output.

**Why:** The user needs darker thermal receipts while keeping font sizing/layout and A4 documents independently controlled.

**How to apply:** Keep the 0–10 control in the same two surfaces as width calibration, persist both with the same company/template scope, and verify the maximum setting on a physical printer before claiming the ink density is ideal.
