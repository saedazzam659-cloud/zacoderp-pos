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
gate every mutation to `source='self_register'`.** Revalidate of an admin (or unknown)
license returns `404/not_found` BEFORE any fingerprint binding or row update — an admin
license must be indistinguishable from an unknown key so the endpoint can never mutate
or leak admin-license state. Forgetting this gate silently drags file-licenses into the
cloud-controlled/lockable path and breaks the offline guarantee.
**Why:** unauthenticated endpoint; the only trust anchor is the Ed25519 signature, so
the source gate is the only thing protecting admin licenses from remote tampering.

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
