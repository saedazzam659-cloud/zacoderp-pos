---
name: JE gap-fill draft (استرجاع رقم قيد محذوف)
description: Re-creating a deleted journal-entry doc number as an empty draft; why and how the gap-fill path is constrained.
---

Rule: deleted JE doc numbers are restored via the gap-fill path in `POST /api/journal-entries` (`{gapFill:true, docNumber, entryDate}`), never by direct DB insert — prod DB is read-only to the agent.

**Why:** prod writes are impossible via executeSql; the sequence engine is authoritative on normal create (`fromSeq ?? client`), so a gap number can never be minted through the normal form.

**How to apply:** gap-fill bypasses `nextSequenceNumber` entirely (counter untouched). Contract is strict and server-enforced: docNumber required non-blank (400), lines must be empty (400), no settlement link (400), entryType pinned to "general", status always "draft". Uniqueness: friendly pre-check 409 + re-check INSIDE the insert tx under `pg_advisory_xact_lock(cid,1001)`. UI: toolbar button "استرجاع رقم محذوف" in JournalEntries list screen.
