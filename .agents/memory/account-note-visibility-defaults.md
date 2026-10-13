---
name: Account-note visibility defaults
description: Product-confirmed default visibility of customer and supplier credit/debit notes in the ZATCA web ERP.
---

**Rule:** Show customer credit notes in sales/customer areas and supplier debit notes in purchasing/supplier areas by default. Hide customer debit notes and supplier credit notes by default, with independent company-level settings to reveal them.

**Why:** The user explicitly confirmed this pairing and required the change to preserve note processing logic and existing note records.

**How to apply:** Keep these distinctions consistent across navigation, module hubs, invoice tabs, company settings, new-company setup, and customer/supplier statements. General-ledger statements should retain posted note entries and include operation/reference details without duplicating party-statement balances. Visibility changes must not remove or rewrite historical notes, change routes, or alter posting behavior.
