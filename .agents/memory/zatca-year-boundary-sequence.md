---
name: ZATCA sequence continuity at fiscal-year rollover
description: Preserve regulatory invoice numbering and the ZATCA ICV/PIH chain across fiscal-year changes.
---

Fiscal-year close must never reset, rewind, or reformat a ZATCA e-invoice sequence. Keep ICV monotonic and PIH linked to the prior generated electronic invoice or note across year boundaries. The electronic invoice reference number must not be reused. Internal sequences default to a separate counter per fiscal year and transaction type, selected by the document date; include a fiscal-year marker so identifiers remain unique, and preserve prior counters/logs/documents. Do not implement annual restart by deleting old counter rows.

**Why:** ZATCA requires a tamper-resistant invoice counter that cannot be reset or reformatted and a linked electronic-invoice/note hash sequence. The user explicitly requires fiscal-year changes not to affect these values and requests annual numbering as the default for internal documents.

**How to apply:** Keep regulatory chain state scoped to its EGS identity and independent of fiscal periods. Treat annual close as a no-op for those counters. For internal series, derive the bucket from the fiscal year containing the document date, keep each transaction type independent, and preserve number uniqueness and audit history.
