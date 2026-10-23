---
name: Company quantity precision
description: Visible manufacturing quantities should follow the active company's decimal precision.
---

In manufacturing UI, format displayed quantities with the company-configured precision, including order quantities, production/waste quantities, material quantities, and stock availability. Keep calculations, stored values, and fiscal payloads at their existing precision; editable input text must not be silently rounded on load.

**Why:** Users rely on the company decimal setting for readable and consistent quantities; fixed four- or six-decimal displays expose implementation precision rather than the configured business precision.

**How to apply:** Use the shared `useFmt().fmtQty` for display-only quantities in manufacturing screens. Keep money on monetary formatters and conversion factors on their own precision rules.
