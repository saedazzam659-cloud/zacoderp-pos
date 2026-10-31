---
name: Agent login CAPTCHA host
description: Keep agent login branding, CAPTCHA issuance, and answer verification aligned on custom domains behind proxies.
---

Agent-hosted login branding may resolve the browser's public hostname explicitly because a reverse proxy can rewrite Host and forwarded-host headers. CAPTCHA challenge issuance should use the same public host lookup as branding rather than a separate auth-route resolution path; seeing CAPTCHA enabled in branding while challenge creation returns disabled is a host-resolution mismatch, not an image-rendering failure. Login verification must resolve the same registered agent hostname used to sign the challenge; bind the signed challenge to that canonical host. Challenge issuance must read central agent settings, not the tenant database. When checking multiple trusted host hints, skip registered agents with CAPTCHA disabled instead of ending the search early.

**Why:** A live custom-domain login showed CAPTCHA enabled in branding while challenge creation returned `enabled:false`; the UI was functioning, but the separate challenge lookup disagreed about the registered agent host. If branding and challenge issuance use different lookups, proxy routing or tenant datasource selection can hide an enabled setting and block sign-in.

**How to apply:** When changing agent login settings, keep challenge issuance on the central datasource and reuse branding's canonical registered-host lookup. Compare host resolution for challenge creation and login verification; bind and verify the challenge against the same selected host, preferring the page origin for same-origin login requests and validating other host hints.
