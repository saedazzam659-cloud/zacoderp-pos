---
name: POS Desktop /sync/pull must write to local store
description: Dashboard counters are not enough — sales screen reads its own catalog.
---

`POST /api/sync/pull` returns customers/items but the consumer in
`artifacts/pos-desktop` has two layers: the dashboard "Pull" button
shows the counts from the response, and the sales screen reads from
the local catalog (`items_local` in Tauri or `LS_KEYS.items` in browser).
The Pull action must therefore go through `lib/sync.ts → pullAndPersist`
which calls `upsertItemsFromCloud` / `upsertCustomersFromCloud` to
actually write rows. Bypassing them (e.g. calling `api.pull` directly
from the UI) prints success while the sales grid stays empty.

**Why:** Reported as a real bug ("تم السحب 184 صنف" but grid was empty).

**How to apply:** Any new Pull/sync entry point must go through
`pullAndPersist`. Never call `api.pull` directly from a component.
