---
name: Archive split panel + share links
description: Odoo-style attachment preview panel pattern and HMAC public share-link rules for document archives
---

## Split-screen attachment panel (web ERP)
- `JournalScanArchive` renders `ArchivePreviewPanel` (portal to body, fixed LEFT edge — form stays right in RTL). Every screen using the archive button gets the split view for free (incl. `InvoiceArchiveTab`).
- The "split" is real: while open, `document.body.style.paddingLeft = min(46vw,760px)` on md+ (matchMedia listener, cleanup restores ""). Fixed/portal elements (dialogs z-50) are unaffected; panel is z-40.
- Auto-opens ONCE per document key when archived files exist (`autoOpenedRef` reset + panel close on jeKey change). Local mode must load the localStorage index on MOUNT (not only on dialog open) or the panel has nothing to list.
- Local-file previews come from async `openArchivedFile` object URLs — revoke on change; `null` (saved via download fallback) → show a "open from your device" hint, never an empty iframe.

## Public share links (WhatsApp) for archived files
**Rule:** a PUBLIC unauthenticated download route keyed by a signed token must (1) use a secret with NO hardcoded fallback — fail CLOSED (mint → 503, verify → reject) when `SESSION_SECRET` is missing; (2) be mintable only through a fully ACL-checked authenticated endpoint; (3) re-check the tenant kill-switch (screen mode ≠ off) at download time so disabling the feature kills already-shared links.

**Why:** wa.me cannot attach files, so WhatsApp send = share a signed URL; a guessable fallback secret lets anyone forge `id.exp.hmac` tokens and enumerate every tenant's archived files.

**How to apply:** token = `${id}.${exp}.${base64url(HMAC-sha256(id.exp))}`, verify with `timingSafeEqual`, TTL ~7 days; register `/shared/:token` BEFORE `/:id/download`; frontend builds the absolute URL from `window.location.origin` (works on dev preview and prod domain). Email path is different: server attaches bytes directly (`POST /:id/email`), no link needed.
