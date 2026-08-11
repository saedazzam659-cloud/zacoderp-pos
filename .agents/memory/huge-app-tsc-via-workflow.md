---
name: Typecheck a large artifact via a temporary workflow
description: How to get a reliable full tsc pass when the app is too big for the bash/subagent time ceilings
---

A full `tsc -p tsconfig.json --noEmit` on a large artifact (e.g. zatca-invoicing,
~135+ page files) takes ~5–8 minutes — longer than the bash tool's 120s ceiling
AND longer than a delegation subagent's 300s budget. Detached/backgrounded
processes (`setsid`/`nohup`) get reaped between polling calls, so they never
finish.

**Reliable approach:** run the typecheck as a temporary *console workflow*.

1. `configureWorkflow({ name: "zatca-typecheck", command: "pnpm --filter @workspace/<slug> exec tsc -p tsconfig.json --noEmit", outputType: "console", autoStart: true })`
2. Wait (sleep in bash) for ~3–4 min.
3. `getWorkflowStatus({ name: "zatca-typecheck" })` — **state `finished` (not `failed`) + empty output = clean.** `tsc --noEmit` prints nothing on success, and error runs surface as non-empty output / `failed`.
4. `removeWorkflow` to clean up.

**Why:** workflows are managed long-running processes that survive across tool
calls, so they aren't reaped like detached shell jobs. A 0-byte/no-done file from
a bash-detached run means it was KILLED, not that it passed.

## Stale-log trap (caused a prod white-screen)
A `TSC_CLEAN` read after a short sleep may come from the PREVIOUS run's log file — a missing `useState` import passed "clean" this way and crashed prod after Publish. Before declaring clean: confirm the log file's mtime is AFTER the WorkflowsRestart, or wait until the workflow status is `finished` for THIS run. Never tell the user to Publish based on a log whose freshness wasn't verified.
