---
name: Publish fails via Standby Build (infra, not code)
description: How to recognize and handle the "Standby Build → Waiting for deployment to be ready → failed, zero app logs" publish failure.
---

# Standby-Build publish failure signature

**Signature:** publish fails with UI message "built successfully but failed to start — runtime error", but the build log shows `Using Standby Build` and SKIPS install/build/image-push entirely, then hangs ~8 min at "Waiting for deployment to be ready". `fetchDeploymentLogs` returns NOTHING for the failed candidate VM (it only covers the active deployment). A healthy publish log instead shows the full pipeline: security scan → pnpm install → per-artifact builds → image layers → VM → ready in ~1 min.

**Rule:** when this signature appears, do NOT hunt for code bugs. Verify quickly (build prod-mode locally: `NODE_ENV=production pnpm --filter @workspace/api-server build` then run dist on a free port — boots in ~1.5s if healthy), then have the user **wait 15–20 minutes and re-publish** — the platform then takes the full-build path and succeeds (worked 2026-07-24 and again 2026-07-28). Third identical failure → Replit support with build IDs.

**Why:** the pre-provisioned standby image on Replit's side is broken/stale; nothing in the repo can fix it. The last successful deployment keeps serving during failed attempts, so prod is not down.

**How to apply:** first step on any publish failure = fetch the failed build's logs and check for `Using Standby Build` + missing build phase before auditing boot code, env, or DB.
