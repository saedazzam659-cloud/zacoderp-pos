---
name: Publish reverts — artifact vite.config requires PORT at build time
description: A multi-artifact publish that runs ~5min then reverts with NO build record is a LOCAL pre-promote artifact build failing; a vite.config that throws on missing PORT/BASE_PATH at config-load is the classic cause.
---

# Symptom
User clicks Republish, it runs ~5 minutes, then the button reverts to "Republish" — no upload, and **no new deployment build record** appears (listDeploymentBuilds shows nothing newer). The live site keeps serving the old version.

# Root cause
The publish flow builds **every** deployed artifact **locally first**, and only after they ALL succeed does it create the cloud build record + promote. If ONE artifact's build fails or hangs, publish aborts BEFORE any build record exists → silent revert. (A failure that reaches the cloud build phase, by contrast, DOES leave a `failed` record.)

The classic trigger: an artifact's `vite.config.ts` reads `process.env.PORT` / `BASE_PATH` at **config-load time** and `throw`s if missing. PORT/BASE_PATH are **runtime** service-env vars (set by the dev workflow + `[services.env]`), NOT present during the build step. So the config load throws and that artifact's `vite build` fails.

# How to reproduce / confirm
Run the publish-equivalent build with those vars unset:
`env -u PORT -u BASE_PATH pnpm -r --workspace-concurrency=1 --if-present run build`
The failing artifact is named in the `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` line. EXIT=0 ⇒ publish build phase is clean.

# Fix (mirror the working artifact's pattern)
Guard the requirement behind a build check so build never needs PORT:
```ts
const isBuild = process.argv.includes("build");
if (!process.env.PORT && !isBuild) throw new Error("PORT ... required");
const port = process.env.PORT ? Number(process.env.PORT) : 5173;
const basePath = process.env.BASE_PATH ?? (isBuild ? "/" : undefined);
if (!basePath) throw new Error("BASE_PATH ... required");
```
**Why:** dev still fails fast if PORT/BASE_PATH are missing, but `vite build` (publish) supplies safe defaults. `base` is overridden at serve time by the artifact's BASE_PATH anyway.
**How to apply:** when ANY new artifact's vite.config hard-requires an env var, verify it's guarded by `isBuild`, or the next publish silently reverts. zatca-invoicing already had the correct pattern; copy it.

# Related dev-env trap
While debugging, the `admin-reports-tests` workflow (a continuously-running `node --test` suite) can wedge: aborted test HTTP requests leave orphaned PG queries holding relation locks, which deadlock api-server's boot `ensureSchema` DDL (DIDNT_OPEN_A_PORT, log stuck at "ensureSchema: starting"). Fix: stop the test workflow, `pg_terminate_backend` the root blocker (find via `pg_blocking_pids`), restart api-server, then restore the test workflow (autoStart off so it can't re-wedge boot). See also api-server-ensureschema-lock-hang.md.
