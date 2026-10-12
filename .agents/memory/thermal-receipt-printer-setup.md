---
name: Thermal receipt printer setup
description: Reported roll width for the current thermal receipt printer and limits of verification.
---

The user reports that the thermal receipt roll is 80 mm wide. The exact printer model and its driver-reported printable head width are not yet known.

**Why:** The reported width was given while diagnosing a thermal sales invoice that prints correctly from another application; it is useful setup context but does not prove the web print output is fixed.

**How to apply:** Keep thermal receipt output separate from A4. For printer-specific layout decisions, treat 80 mm as the roll width, not necessarily the printable head width, and do not claim a fix is confirmed until a physical sample from the target printer is checked.
