---
name: Large registers must stay paged
description: Why high-volume server-paged grids must reject legacy show-all preferences at both UI and API boundaries.
---

High-volume registers must never turn a saved `pageSize = 0` or an “all” UI
choice into one response and one DOM render. Normalize unsupported saved values
to a safe page size before constructing the first query, remove “all” from that
screen’s picker, and cap the corresponding API page size independently.

**Why:** A company with only a few thousand enriched journal rows froze the
browser because a legacy shared-grid preference requested and rendered every
row. UI-only removal is insufficient because old localStorage values and direct
API requests can still trigger the same failure.

**How to apply:** Use bounded server pagination for large audit/accounting
registers. Full export may traverse all rows, but it must do so on demand in
bounded batches rather than reusing the interactive list’s first-paint query.