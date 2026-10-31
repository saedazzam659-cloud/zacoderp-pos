---
name: Replit control plane and Contabo agents
description: Release and verification boundary for customer agent installations.
---

The central app is published from Replit. The user then prepares a release in the Agent Servers screen and runs the installation update on the target Contabo Linux VPS behind Nginx and HTTPS. Replit publishing alone does not update the VPS. The documented PM2 configuration uses two cluster workers, so pre-authentication one-time state must be shared across workers.

**Why:** The user explicitly requires CAPTCHA acceptance, refresh, wrong-answer rejection, and expiry to be tested against the actual agent domain; Replit preview or central publish alone is not completion.

**How to apply:** After publishing on Replit, generate the Agent Servers release and update the specific Contabo installation. Verify the live agent domain only after that completes; never report production success beforehand.
