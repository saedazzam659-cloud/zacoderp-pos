---
name: Agent login CAPTCHA host
description: Keep agent login branding, CAPTCHA issuance, and answer verification aligned on custom domains behind proxies.
---

Agent-hosted login branding may resolve the browser's public hostname explicitly because a reverse proxy can rewrite Host and forwarded-host headers. CAPTCHA issuance and login verification must resolve the same registered agent hostname; bind the signed challenge to that canonical host.

**Why:** If branding sees CAPTCHA enabled but the image endpoint resolves only the proxy hostname, the page shows the CAPTCHA field without an image and users cannot sign in.

**How to apply:** When changing agent login settings, compare hostname resolution for branding, challenge creation, and login verification. Accept a supplied host only when it matches the page origin or referrer, and verify the challenge against that same host.
