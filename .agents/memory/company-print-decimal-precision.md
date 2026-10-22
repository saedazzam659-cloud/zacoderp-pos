---
name: Company print decimal precision
description: Company-configured monetary precision must remain consistent in visible document printouts.
---

Visible monetary values in document print templates must use the owning company's configured decimal precision, matching the web form. This includes sales and purchase templates, account notes, cash and settlement vouchers, and generic batch-print layouts. Keep quantities on their own precision rules and preserve fixed precision required by fiscal QR serialization.

**Why:** A quotation showed three decimals in the editor but rounded to two on paper, creating a mismatch between the entered amount and the document customers received.

**How to apply:** Pass the relevant company precision into each print renderer and change display formatting only. Do not change stored values, calculations, posting behavior, or required fiscal payload formatting as part of a print-only correction.
