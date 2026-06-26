---
name: DevStudio proposal review/approval gate
description: How a submitted developer code proposal is reviewed + accepted; what "published" actually means.
---

# DevStudio proposal review/approval gate (Phase 2)

A developer-submitted proposal (a unified DIFF) does NOT auto-apply. The flow is a
MANUAL SuperAdmin approval gate backed by an ADVISORY automated review.

- The review engine inspects the diff **TEXT ONLY** — it never applies, clones, or
  executes code. Gates: scope (every touched file + targetPath must be inside the
  developer's visibility allow-list via `isPathVisible`, else `fail`), stats (size),
  danger_scan (risky patterns in ADDED lines only → `warn`, advisory not blocking),
  ai_review (shared `aiClient` with a deterministic rule-based fallback). Aggregate
  verdict (fail>warn>pass) + an `sha256(diff)` hash.
- The decision endpoint only accepts a proposal whose `status === "submitted"`
  (else 409); reject requires a reason (≥3 chars, else 400). On decision it persists
  a tamper-evident record: reviewReport/reviewVerdict/diffHash/reviewedBy/reviewedAt/
  decisionReason, and auto-runs the review if the SA skipped the explicit /review step.

**Why:** the platform's core safety promise is "no untrusted code executes on our
infra." So even Phase 2 cannot auto-apply a developer's code. `published` is a
GOVERNANCE status (SA-accepted into the merge queue) — the actual code application
to production remains a human/main-agent step. The automated gates are decision
SUPPORT only; the human SA always makes the final call (user-chosen Option 1).

**How to apply:** if asked to "auto-deploy" or "auto-merge" approved proposals,
push back — that breaks the no-code-execution invariant. Any new proposal status
mutation must keep the submitted-only state guard and the diff-hash acceptance
record, and must not run/apply the diff.
