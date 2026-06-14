---
name: POS Desktop license-expiry banner
description: Where the expiry banner renders and where its renewal text comes from.
---

# POS Desktop license-expiry banner

The license-expiry warning banner in `PosShell.tsx` MUST render on its own
full-width row directly below `<nav>` (same slot as `UpdateBanner`), NEVER
inside `S.topnavControls`.

**Why:** a wide pill placed in the topbar controls squeezed/wrapped the menu
bar ("هدم القوائم") and looked unprofessional to the vendor's customers.

**How to apply:** keep `ExpiryBanner` as a slim single-line row; if you add
more topbar status chips, do not put anything wide/variable-width into
`topnavControls`.

The banner's renewal/contact TEXT is SuperAdmin-editable and reuses the ONE
global `system_settings.subscription_contact_info` key (the same value shown to
web tenants at login). It flows to the device via `/api/sync/pull` →
`settings.renewalMessage`, cached in localStorage `pos_desktop_renewal_message`
(see `lib/expiryMessage.ts`), read each render in PosShell.

**Why:** single source of truth for the vendor's renewal message across web +
desktop — do NOT fork it into a separate desktop-only key.

**How to apply:** standalone mode never pulls, so the banner falls back to the
built-in default text; the LS key is `pos_desktop_*`-prefixed so the
mode-switch wipe clears it automatically. WhatsApp/phone quick-action buttons
stay hardcoded to the vendor numbers by design.
