---
name: Mobile error recovery
description: Preserve the active mobile route during error recovery and avoid hook-order crashes during async loading.
---

When a mobile screen render fails, **Try Again** should reset the React ErrorBoundary in place rather than restart the app. In this app, a full restart returns authenticated users to the invoice landing route instead of the screen that failed. Keep every React hook before loading/error early returns so async query transitions cannot change hook count.

**Why:** The requested cash-expense flow must retry on its current screen; loading-to-loaded hook-order changes caused the crash that exposed the recovery problem.

**How to apply:** Preserve this behavior when changing `ErrorFallback`, `ErrorBoundary`, or root navigation. When adding hooks to a screen with loading/error branches, declare them before every conditional return.
