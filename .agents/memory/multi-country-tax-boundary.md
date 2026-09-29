---
name: Country tax integration boundary
description: Preserve Saudi ZATCA while adding isolated Egypt and Jordan tax integrations.
---
Egypt and Jordan tax providers are separate from the established Saudi ZATCA implementation. Do not edit Saudi ZATCA routes, signing, submission, invoice-post automation, or reuse its sender as a country adapter for the new integrations.

**Why:** The user explicitly stated that Saudi ZATCA is working and must not be touched while Egypt and Jordan are added.

**How to apply:** Route by the company's canonical country, keep credentials and provider payloads isolated, and use separately gated adapters. If a future requirement would modify a Saudi flow, explain the dependency and get explicit approval first.

JoFotara's documented invoice URL (`backend.jofotara.gov.jo/core/invoices/`) is a live submission endpoint, not a safe connection-test endpoint. Do not send test payloads there. Require ISTD-confirmed sandbox details before wiring Jordan network calls; until then, tests must use injected local transports and must block the known live host.

**Why:** The official user guide shows the production invoice POST route, while the candidate sandbox hostname found during research did not resolve. A mistaken probe could create a legal invoice.

**How to apply:** Keep Jordan connection and submission checks in the local-mock-only state until an official sandbox URL and credentials are available. Never treat a successful mock response as provider verification.