---
name: Agent login CAPTCHA host
description: Keep agent login branding, CAPTCHA issuance, and answer verification aligned on custom domains behind proxies.
---

Agent-hosted login branding may resolve the browser's public hostname explicitly because a reverse proxy can rewrite Host and forwarded-host headers. CAPTCHA issuance and login verification must resolve the same registered agent hostname; bind the signed challenge to that canonical host. Challenge issuance must read central agent settings, not the tenant database. When checking multiple trusted host hints, skip registered agents with CAPTCHA disabled instead of ending the search early.

**Why:** If branding sees CAPTCHA enabled but the challenge route has already switched to the tenant database, resolves only the proxy hostname, or stops at a different non-CAPTCHA server, the page shows the CAPTCHA field without an image and users cannot sign in.

**How to apply:** When changing agent login settings, keep public challenge creation on the central datasource and compare hostname resolution for branding, challenge creation, and login verification. Prefer verified proxy identity and page origin/referrer; accept a query host only when it matches the page origin/referrer, and verify the challenge against the same selected host.
