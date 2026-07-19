---
name: JE gap-fill draft (استرجاع رقم قيد محذوف)
description: Re-creating a deleted journal-entry doc number as an empty draft; why and how the gap-fill path is constrained.
---

Rule: deleted JE doc numbers are restored via the gap-fill path in `POST /api/journal-entries` (`{gapFill:true, docNumber, entryDate}`), never by direct DB insert — prod DB is read-only to the agent.

**Why:** prod writes are impossible via executeSql; the sequence engine is authoritative on normal create (`fromSeq ?? client`), so a gap number can never be minted through the normal form.

**How to apply:** gap-fill bypasses `nextSequenceNumber` entirely (counter untouched). Contract is strict and server-enforced: docNumber required non-blank (400), lines must be empty (400), no settlement link (400), entryType pinned to "general", status always "draft". Uniqueness: friendly pre-check 409 + re-check INSIDE the insert tx under `pg_advisory_xact_lock(cid,1001)`. UI: toolbar button "استرجاع رقم محذوف" in JournalEntries list screen.

**SuperAdmin-only (user decision, governance model):** both gap-fill create AND the companion `GET /journal-entries/gap-scan?from&to` are 403 for anyone but `role==="superadmin"`, and the UI button is hidden for non-SA. Server guard is authoritative; UI gating is cosmetic.

**Gap-scan invariants:** groups doc numbers by trailing-digit prefix, lists missing ints between min..max per prefix, cap 500 + `truncated`, suggestedDate = nearest LOWER existing number's date. Numbers with >8 digits (timestamp suffixes like `TRF-1776880398900`) MUST be excluded or the scan floods with fake gaps. SA needs acting-company context: `journalEntriesApi.authHeaders` sends `x-acting-company-id` from localStorage (server honors it only for SA).
