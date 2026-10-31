---
name: Contabo hosted runtime
description: Deployment and verification boundary for the production ERP instance.
---

The user's production ERP is hosted on a Contabo Linux VPS behind Nginx and HTTPS, not on Replit. The Replit workspace is a development/source environment; a code change is not live until it is deployed through the user's VPS release path. The documented PM2 configuration uses two cluster workers, so pre-authentication one-time state must be shared across workers.

**Why:** The user explicitly requires CAPTCHA acceptance, refresh, wrong-answer rejection, and expiry to be tested against the actual Contabo site; Replit preview alone is not completion.

**How to apply:** Verify the live domain after the VPS release and database migration. Never report production success before those checks, and ask for the established deployment path if it is not available.
