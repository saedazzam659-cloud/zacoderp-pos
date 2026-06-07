---
name: POS Desktop boot-hang white screen
description: Why the Tauri app can show a blank/white screen on startup and the required guard pattern.
---

# POS Desktop boot-hang white screen

The Tauri+React app's initial `BootState` is `{ phase: "checking" }`, rendered as a
loader ("جاري التحقق من الجهاز…"). `App.tsx` kicks off startup with
`useEffect(() => { void boot(); }, [])`. If `boot()` has NO `.catch` and any awaited
startup step **rejects** OR **hangs** (e.g. a native `invoke` that never resolves),
the state stays `"checking"` forever — which the field user perceives as a **blank
white screen**.

**Why the existing safety nets don't cover this:**
- The root `ErrorBoundary` only catches *render* errors, not unhandled async rejections.
- Per-step try/catch (e.g. `api.validate()` offline fallback) only covers the steps
  that were explicitly wrapped — one unwrapped await still strands the whole boot.

**Required guard pattern (do not regress):**
1. A thin `boot()` wrapper with `try/catch` around `bootInner()` → on error, transition
   to a dedicated visible `{ phase: "boot-error"; message }` instead of hanging.
2. A **watchdog** `useEffect` keyed on `state.phase`: if still `"checking"` after ~20s,
   flip to `boot-error`. This is the ONLY thing that catches a true *hang* (a never-
   resolving promise can't be caught by try/catch).
3. A recoverable `boot-error` render branch (retry + reload buttons, shows the real
   message). Retry re-enters `"checking"` and re-runs `boot()`.
4. A monotonic `bootRunId` ref: each `boot()` captures `++bootRunId.current`; terminal
   `setState`s check the id so a STALE attempt (after a retry/watchdog) can't clobber
   the newer one. The watchdog's functional `setState` already self-guards on
   `s.phase === "checking"`.

**How to apply:** any new awaited step added to `bootInner` / `bootCloud` /
`bootStandalone` is automatically covered by the wrapper+watchdog — but never add a
second top-level `void someAsync()` boot path without the same try/catch, or the
white-screen class of bug returns.
