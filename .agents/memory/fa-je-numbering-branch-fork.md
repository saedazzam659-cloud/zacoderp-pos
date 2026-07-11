---
name: Fixed-asset JE numbering branch fork
description: Why fa acquisition/depreciation/disposal JEs must resolve a numbering branch, not pass the asset's raw (often null) branch
---

Fixed-asset JEs (acquisition / depreciation / disposal, built in `fa-journals.ts`)
draw their human number from the company-wide `journal_entry` sequence. That
counter is keyed **per branch**. Passing `a.branchId ?? null` for a branchless
asset coalesces to the **branch-0** bucket and restarts at 1 (e.g. QYD-0001,
QYD/06/0006), diverging from the main JE series that manual/sales JEs consume on
the company's operating branch (e.g. QYD/06/1396).

**Rule:** resolve the numbering branch = asset branch, else the company's main
branch (`branches.is_main`) — via the shared `resolveNumberingBranch` helper —
and pass THAT to `nextSequenceNumber` / `resolveJeNumber`. Keep the JE's own
`branchId = a.branchId ?? null` (company-wide, visible from any branch) so
branch-scoped reports are unchanged; only the number stream is realigned.

**Why:** users perceive the branch-with-the-most-JEs stream as THE sequence; a
forked branch-0 series looks like duplicate low numbers in the JE list.

**How to apply:** any NEW asset-derived JE path in this file must go through
`resolveNumberingBranch`, not raw `a.branchId`. Safe because fa_* JEs carry no
ZATCA chain (no ICV/PIH). Fix is forward-only — pre-existing wrong-numbered
posted JEs need separate remediation (can't be renumbered via read-only prod SQL).
