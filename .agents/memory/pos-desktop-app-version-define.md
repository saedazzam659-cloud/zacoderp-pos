---
name: POS Desktop APP_VERSION must come from __APP_VERSION__
description: Never hardcode the app version string in POS Desktop frontend — use the build-time define.
---

The Vite `define` in `artifacts/pos-desktop/vite.config.ts` injects
`__APP_VERSION__` from `package.json` at build time. Any frontend code that
needs the running version (the in-app updater, the activation debug badge,
the topbar brand tag) MUST read `__APP_VERSION__`. The TS ambient is in
`src/vite-env.d.ts`.

**Why:** Hardcoded literals go stale on every release. We shipped 4+
versions where `updates.ts` + `UpdatesScreen.tsx` still said `"0.3.3"`,
so the "update available" banner fired even on the latest build and the
cashier kept seeing a fake update prompt.

**How to apply:**
- Anywhere you need the version, write `__APP_VERSION__` (no quotes).
- Bump the version in 4 spots in lockstep: `package.json`,
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the brand tag
  `v0.X.Y — ` in `PosShell.tsx` (the only frontend place that prints
  the version as a literal for visual styling rather than as code).
- Never re-introduce a `const APP_VERSION = "..."` in TS files.
