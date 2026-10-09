---
name: Native navigation boundaries with Wouter
description: Preserve browser navigation when opening new tabs or crossing artifact routes.
---

Use a native `<a target="_blank" rel="noopener noreferrer">` when an affordance should open a route in a new tab. Build its href from `import.meta.env.BASE_URL` plus the internal route so artifact path-based routing is preserved.

Use a full document navigation (`window.location.assign` or `replace`) when redirecting from one artifact to another. A Wouter redirect only changes the client-side URL and leaves the current artifact bundle mounted, so the proxy cannot route the request to the destination artifact.

**Why:** Wouter's `Link` handles an unmodified left-click by preventing the browser default and calling SPA navigation; it does this even if `target="_blank"` is passed, so the click does not reliably open a new tab. Similarly, a Wouter redirect cannot switch the loaded JavaScript app when artifact services own different path prefixes.

**How to apply:** Keep the normal Wouter `Link` for same-artifact routes. Use a separate native anchor for new-tab controls, and use a full document navigation for cross-artifact redirects such as ERP login into POS. Preserve the artifact base path when building native links.