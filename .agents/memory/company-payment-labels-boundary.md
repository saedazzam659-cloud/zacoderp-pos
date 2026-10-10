---
name: Company payment labels
description: Company-specific payment defaults and display aliases must not alter accounting payment identifiers.
---

Payment defaults and display aliases are configured independently per company. A company may change the visible text for an existing payment method, such as showing “شبكة” for the existing bank method, without creating a new payment type or changing accounting behavior.

**Why:** This preserves established posting logic and lets companies use their preferred terminology without affecting other tenants.

**How to apply:** Keep the stored payment keys stable (`credit`, `cash`, `bank`); scope defaults and labels to the company and use them only for form defaults and display text.
