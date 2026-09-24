---
name: Party classification boundaries
description: User-approved ordinary defaults, picker-only scope, and historical relationship preservation.
---

An absent/null classification means ordinary customer or ordinary supplier, NOT eligibility for every module. This applies to legacy records too, without a bulk backfill.

**Why:** The user explicitly clarified that not choosing a classification must behave as customer/supplier only, overriding an earlier proposed legacy-unrestricted default.

**How to apply:** New contracting choices require project-owner/subcontractor or combined classification; sales/purchase choices admit ordinary or combined classification. Retain currently selected historical party references regardless of current classification.

Classification is for choice-list filtering only, not a new ledger identity, authorization rule, or posting restriction.

**Why:** The approved design preserves existing functions and avoids duplicate party screens/records.

**How to apply:** Leave vouchers, statements, master lists, balances and existing postings unfiltered. Do not create contractor or party records as a side effect of changing classification. Existing contractor identifiers must not be replaced with supplier identifiers.