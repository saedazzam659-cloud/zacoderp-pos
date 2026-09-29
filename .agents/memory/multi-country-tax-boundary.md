---
name: Country tax integration boundary
description: Preserve Saudi ZATCA while adding isolated Egypt and Jordan tax integrations.
---
Egypt and Jordan tax providers are separate from the established Saudi ZATCA implementation. Do not edit Saudi ZATCA routes, signing, submission, invoice-post automation, or reuse its sender as a country adapter for the new integrations.

**Why:** The user explicitly stated that Saudi ZATCA is working and must not be touched while Egypt and Jordan are added.

**How to apply:** Route by the company's canonical country, keep credentials and provider payloads isolated, and use separately gated adapters. If a future requirement would modify a Saudi flow, explain the dependency and get explicit approval first.