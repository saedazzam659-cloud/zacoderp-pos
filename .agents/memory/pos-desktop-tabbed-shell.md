---
name: POS Desktop tabbed shell gating
description: Access-control rule when PosShell keeps multiple screens open as tabs
---

PosShell runs a keep-alive tabbed workspace: `openTabs: View[]` + `activeTab`; every open tab stays mounted (`display:contents` active / `none` inactive) so each screen preserves its own state. `setView` is a back-compat shim that opens+activates a tab.

**Rule:** when a module/screen becomes gated mid-session (profile change, SuperAdmin disables a module, permission change), you MUST prune `openTabs` — not just redirect the active `view`. A previously-opened tab chip keeps a now-forbidden screen reachable otherwise.

**Why:** the original mid-session guard only did `if (!moduleVisible(view)) setView("sales")`, which fixes the active view but leaves disabled modules reachable via their still-open tab chips (broken access control).

**How to apply:** in the `moduleVisible` effect, `setOpenTabs(prev => prev.filter(t => t === "sales" || moduleVisible(t)))` (fall back to `["sales"]` if empty), then the active-view fallback. "sales" is always allowed.

**Tradeoff:** keep-alive means hidden tabs keep running effects/pollers in the background. Accepted for state preservation; gate expensive effects by visibility if a heavy screen is added.
