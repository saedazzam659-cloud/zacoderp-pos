---
name: api-server does not pass strict tsc
description: Why `tsc --noEmit` on the api-server package reports many errors that are NOT yours, and how to verify your change cleanly.
---

The `@workspace/api-server` package does NOT pass `tsc -p tsconfig.json --noEmit`
cleanly — it carries 100+ pre-existing type errors (drizzle overload mismatches,
`Record<string,unknown>` constraint failures, `string | string[]` query-param
errors across admin.ts, inventory.ts, zatca.ts, sessions.ts, etc.). It runs in
dev/prod via `tsx`, which does no type-checking, so this debt never blocks boot.

**How to verify YOUR change** instead of drowning in pre-existing noise:
- Run the typecheck, capture to a file, then `grep -E "<your-file>\.ts" <log>` —
  if your file is absent from the error list, your change added no type errors.
  Also compare total `grep -c "error TS"` against the known baseline.

**Why:** a prior task mis-concluded "api-server typecheck is clean" from a
0-byte log. That was a FALSE NEGATIVE — the detached `tsc` had been killed by the
bash-tool timeout before writing anything, leaving an empty log that looks clean.
An empty log means "didn't finish", NOT "no errors".

**How to apply:** run typechecks to a file under the workspace (not /tmp, which
gets cleaned) and `wait` on the PID inline, or poll for a completion sentinel
(e.g. append `EXIT=$?` to the log). Never treat an empty/missing log as success.
The frontend artifact (`@workspace/zatca-invoicing`) DOES pass cleanly (exit 0),
so frontend typecheck exit code is trustworthy.
