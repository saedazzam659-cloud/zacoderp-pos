---
name: Annual sequence reset policy
description: Default behavior and safe transition when a company disables fiscal-year numbering resets.
---

Fiscal-year sequence reset is opt-in and stays disabled by default for fresh sequences, new companies, and template-based setup. Preserve saved choices on existing companies; never switch all tenants or counters without explicit approval. When an administrator disables an annual reset on a used sequence, continue from the highest saved fiscal-year counter or logged suffix plus one, while retaining historical counters.

**Why:** The user reported that annual reset being enabled by default made operating companies restart at 1 and disrupt existing numbering. Their stated preference is continuous numbering unless the company explicitly chooses fiscal-year resets.

**How to apply:** Default the UI, API, schema, and company-creation paths to annual reset off. Keep explicit annual choices intact. On annual-to-continuous changes, carry forward the maximum existing next-counter/log suffix before issuing another number. Treat any bulk change to already-saved company settings as a separate action requiring confirmation.
