---
name: Mobile server session boundary
description: Domain changes require a fresh server-bound session without losing queued financial operations.
---

Treat selecting another mobile server as a new authentication realm, even when company codes and usernames happen to match.

**Why:** The native settings previously changed the destination while retaining the old session and in-memory user. Public checks confirmed agent domains already answered branding correctly; a working domain registry is not proof that switching an authenticated mobile client is safe.

**How to apply:** Preserve the central and branded build defaults, require explicit login to the chosen server, reject stale asynchronous auth results, and never forward the previous server's bearer. Legacy unbound tokens may be retained only on the original central domain, not on an arbitrary branded build default.

Pending or failed offline financial operations block server/account changes and intentional logout until reviewed or synchronized.

**Why:** Silently clearing an outbox to fix authentication can destroy financial work. Replaying it under a different company's account is worse.

**How to apply:** Preserve queued data, keep ownership checks, and make server settings reachable while logged out so a bad domain can be corrected without an authenticated session.