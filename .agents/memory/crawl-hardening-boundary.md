---
name: Conservative crawler hardening boundary
description: Preserve ERP behavior when reducing indexing and AI collection; distinguish advisory controls from access control.
---

Use conservative indexing and build-artifact exposure controls without changing login, normal-user behavior, module permissions, or mobile/POS/agent access.

**Why:** The approved scope is reduced AI collection with no changes to existing workflows, not a session-architecture migration. An AI-generated ERP specification from a URL alone does not establish private-screen or tenant-data exposure. Robots directives cannot prevent authorized copying or clients that ignore them.

**How to apply:** Keep marketing search discoverability separate from private-page indexing. Do not add broad user-agent bans, CAPTCHAs, or generic API rate limits under this scope. Evaluate the actual HTML/static serving layer, not just API middleware; separately hosted agents need their gateway configuration updated before claiming equivalent coverage. Never describe generated installation configuration as already applied to running agents.

Behavioral monitoring must remain observation-only unless a later request explicitly authorizes enforcement after compatibility/performance assessment.

**Why:** The user prioritized unchanged ERP speed and uninterrupted agents, mobile, and Windows clients over aggressive anti-scraping measures, and delegated omission of risky measures.

**How to apply:** Do not turn risk scores into automatic blocking, logout, throttling, or CAPTCHA. Avoid per-request database work, bound memory/background work, and distinguish a local counter microbenchmark from end-to-end or production performance evidence. A persisted web channel is not proof of a physical browser; monitor coverage must never be described as exhaustive.