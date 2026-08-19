---
name: Strict demo browser binding
description: Authorization, reset, and preview-cookie rules for demo accounts locked to one browser.
---

An isolated demo account authorizes exactly one browser token held in an HttpOnly cookie. Pair codes, cloned companies, and shadow users are not part of this policy. Login enrollment/reset must serialize on the same per-source advisory lock, and session issuance must still require the exact link to be ready and unrevoked.

The bearer token is not sufficient for an isolated demo user. Every bearer resolution path—including ordinary middleware, `/auth/me`, SSE, and authenticated WebSockets—must also hash and validate the browser cookie against the active primary link. Administrative unlinking revokes the link and source session together; the first later login becomes the new browser.

**Why:** Login-only checking still lets a copied bearer run from another browser. Separately committing enrollment before session issuance can also strand the account on a server-minted token that never reached the browser.

**How to apply:** Route all user-token checks through the cookie-aware bearer resolver, passing the request cookie on HTTP/SSE/WS paths. Set the cookie immediately after guarded session issuance and release a newly minted binding if issuance fails. Never use IP as browser identity.

Replit Preview may rewrite response cookies to `Secure; SameSite=None` so the app works inside its cross-site iframe, even when the application emits `SameSite=Strict` and non-secure development cookies. Treat this as preview-proxy behavior; production application policy remains Strict.