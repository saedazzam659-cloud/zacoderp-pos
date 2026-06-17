---
name: POS Desktop online self-register + remote license control
description: Standalone devices can register online and be remotely renewed/revoked; the gate that keeps admin file-licenses pure-offline and the grace-lock rules.
---

Standalone POS-Desktop now has TWO license sources, and they must never cross:

- **`source='admin'` (file licenses)** — the original hand-dropped `.zacolic.json`.
  100% offline: NEVER phones home, never locks. This is a hard product invariant.
- **`source='self_register'`** — device registered its company profile online, the
  cloud signed an Ed25519 license, and the SuperAdmin controls expiry/renew/revoke
  centrally from the existing `/admin/offline-licenses` screen.

**The public endpoints (`/api/public/offline/register` + `/revalidate`, NO auth) MUST
gate every MUTATION to `source='self_register'`.** Only self_register may bind a
fingerprint, re-sign, or touch `last_seen_at`/`updated_at`. Forgetting this gate silently
drags file-licenses into the cloud-controlled/lockable path and breaks the offline guarantee.
**Why:** unauthenticated endpoint; the only trust anchor is the Ed25519 signature, so
the source gate is the only thing protecting admin licenses from remote tampering.

**Admin licenses now answer `/revalidate` READ-ONLY (changed — was `404/not_found`).** An
admin (`source!=='self_register'`) revalidate returns the current `effectiveStatus` plus the
stored `signedFileJson` WITHOUT any DB write (no bind, no re-sign, no last-seen). This lets a
SuperAdmin's remote expiry edit / revoke take effect WHEN THE DEVICE IS ONLINE — the PATCH on
`/admin/offline-licenses` already re-signs the stored file with the new expiry, so revalidate
just hands back that authoritative file. The fingerprint-mismatch guard (`lic.fingerprintHash
&& !== fpHash → 409`) runs BEFORE the source branch. This path can only ever TIGHTEN (surface
an expired/revoked status), never grant or extend offline trust.
**Why:** admin file-licenses must stay 100% offline-capable (run forever with no internet),
but the product now also wants central revoke/expiry to land when the box happens to be online.
**How to apply:** the desktop side makes this safe — `revalidateStandalone` marks admin
licenses `offlineTolerant` so unreachable/not_found/fingerprint_mismatch do NOT lock (only an
explicit `revoked`/`expired` from the server locks); self_register keeps strict grace-lock.
Unknown key still returns `404/not_found` for everyone (the lookup precedes the source branch).
**Accepted tradeoff:** the admin branch DOES disclose status + the signed file to any caller
that knows the `licenseKey` (previously admin keys were indistinguishable from unknown via
404). This is intentional and required — remote *renew* means the device must pull the
re-signed file with the new expiry, and the `licenseKey` is the bearer capability (same model
as self_register, which also returns its signed file to key-holders). The signed file is
already in the customer's possession (the `.zacolic.json` the admin gave them), it is
Ed25519-signed (tamper-evident), and admin rows carry NO fingerprint binding by design, so we
cannot gate on fingerprint. Do NOT "fix" this by hiding status/file — that breaks the feature.

**Offline grace-lock must fail closed.** `isGraceExpired(lastCheck, graceDays, fallbackTs)`
locks a self_register device that hasn't reached the cloud within its window (default 7d).
`lastCheck` is epoch-ms of the last SUCCESSFUL revalidation. When it is null (imported
self-register file, storage reset), anchor to the signed `issuedAt` (`fallbackTs`); if
there is no baseline at all, return expired. Returning `false` for null `lastCheck` would
let a self_register device run forever offline — that was a real bug. Admin licenses never
call this (gated out by source first).
**How to apply:** any new boot/periodic revalidation path must pass `issuedTs` from the
verified payload and route fresh register/import through full `boot()` (verify + revalidate)
before sign-in, not straight to the signed-in state.

**Register dedup is enforced by a PARTIAL unique index, not app logic.**
`offline_licenses_self_register_fp_uq` on `(fingerprint_hash) WHERE source='self_register'
AND fingerprint_hash IS NOT NULL` (admin rows can share a NULL fp, so it must be partial).
The register insert uses `onConflictDoNothing({ target: fingerprintHash, where: <SAME
predicate> })` — the `where` predicate MUST match the partial-index predicate or Postgres
rejects the ON CONFLICT. On an empty `returning()` (lost the race) re-select the
self_register row and return its stored signed file.
**Why:** select-then-insert alone races two concurrent registers into duplicate licenses
for one machine.

Note: this drizzle version names the conflict predicate option `where`, not `targetWhere`.

**Self-register is APPROVAL-GATED — register creates `status='pending'` with NO signed
file.** A device cannot run until a SuperAdmin approves it with a trial term (default 7d,
editable) or a permanent toggle, which signs the file and flips `pending→active`. The
device sits in a polling "awaiting approval" phase and resumes that wait across restarts
via a persisted pending-license-key (settings `pending_license_key` / LS
`pos_desktop_pending_license_key`, `""`→null). `/revalidate` returns `pending` (no file)
BEFORE bind-on-first-use while pending.
**Why:** the original flow handed out an active signed file instantly, so anyone could
self-provision a working license with zero oversight.
**How to apply:**
- Approve MUST be atomic: `UPDATE ... WHERE id=? AND status='pending'` (compare-and-set)
  and 409 on 0 rows — a plain read-check then unconditional update lets two concurrent
  approvals both win and double-assign the trial term.
- The device MUST clear the persisted pending key on every TERMINAL deny outcome
  (`revoked`/`not_found`/`fingerprint_mismatch`) and drop back to the form. Otherwise the
  boot branch that prioritises the pending key re-enters an indefinite poll forever.
- This is a HARD version cutoff: do NOT add a server compat path returning a signed file
  to old (≤0.8.20) clients — that would bypass the approval gate entirely. Old clients
  must update; their pending row self-heals once the new app retries after approval.
