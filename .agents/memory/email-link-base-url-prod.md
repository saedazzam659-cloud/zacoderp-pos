---
name: Emailed link base URL in production
description: Security/digest emails must never link to the dev workspace domain in production
---

Any server-side builder of ABSOLUTE links for emails (superadmin device-approval, recovery, maintenance digest) must resolve the base URL as: `PUBLIC_BASE_URL` → in production the deployed `REPLIT_DOMAINS` (custom domain like zacoderp.com preferred over `*.replit.app`) → dev `REPLIT_DEV_DOMAIN` only outside production.

**Why:** `REPLIT_DEV_DOMAIN` can be set even in the deployed environment; preferring it sent device-approval emails to the sleeping dev workspace ("Run this app" page), so the approval never registered and the superadmin login sat on "pending" forever.

**How to apply:** when adding a new emailed deep-link, reuse `publicBaseUrlFromReq` (superAdminAuth.ts) or replicate its prod-first ordering; never reach for `REPLIT_DEV_DOMAIN` first. Approval links are 15-min TTL — after fixing a link bug the user must trigger a fresh request.
