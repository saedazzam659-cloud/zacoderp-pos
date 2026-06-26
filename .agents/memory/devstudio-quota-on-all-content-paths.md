---
name: DevStudio quota/audit on every content-exposing path
description: Read/write quota + audit gates must cover ALL paths that expose or persist code, not just the obvious read/create endpoint.
---

# Quota + audit must gate every content path, not just the direct one

DevStudio enforces per-developer read-line and write-line quotas + an audit trail
to protect the IP of the version-pinned snapshot. The trap: enforcing the gate
ONLY on the obvious endpoint leaves sibling paths that expose/persist the same
content wide open.

**Rule:**
- ANY path that returns file CONTENT to a developer is a metered READ — meter it
  exactly like the direct file-read endpoint (count lines, enforce read quota →
  429, increment usage, write a `read_file` audit row). Feeding files to the AI
  propose endpoint counts; it is not "free" just because the response is a diff.
- ANY path that PERSISTS a diff (create AND update) is a metered WRITE. On update,
  re-meter by the DELTA vs the row's previously-counted `writeLines` (not the raw
  new count) or you double-charge; adjust `writeLinesUsed` by the delta with
  `GREATEST(0, …)`. Otherwise a developer stages a tiny draft within quota then
  balloons the diff on update to bypass the write quota.

**Why:** an earlier review caught both bypasses — `/ai/propose` read files with no
quota/audit, and proposal-update replaced the diff with no re-metering. The gate
on the primary endpoint gave a false sense of safety.

**How to apply:** when adding any new DevStudio (or similar metered-access)
endpoint, ask "does this expose or persist scoped content?" If yes, wire the same
quota-check + usage-increment + audit triple before responding.

**Also:** the AI orchestrator has a deterministic rule-based fallback
(`ruleBasedProposal`) used both when AI is unavailable AND when the provider call
fails — it returns `ok:true, provider:"rule-based"` with a safe TODO-comment
unified diff and never executes/invents code. Don't regress this to an error path.
