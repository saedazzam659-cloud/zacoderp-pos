---
name: POS Desktop cross-tab dataBus reactivity
description: How keep-alive tabs stay fresh via lib/dataBus channel bus, and the listener-channel-coverage gotcha.
---

# Cross-tab reactivity (lib/dataBus.ts)

`lib/dataBus.ts` is a channel-based in-process pub/sub: `emitData(...entities)` + `useDataRefresh(entities, fn)`, with `DataEntity` channels like "journal" / "invoices" / "vouchers" / "stock" / "items". Listeners fire **even while their tab is hidden** (PosShell keeps every open tab mounted with display:none), so by the time the user switches tabs the data is already fresh — there is NO need for an emit-on-tab-activate hook.

**Idiom:** LIB mutation functions emit, SCREENS only listen. `lib/accounting.ts` posting/journal mutations emit after the `invoke(...)` succeeds (JE create/update/post/unpost/delete → "journal"; sales/purchase post/unpost/update/delete + goods receipt/delivery + returns + converts → "invoices","journal","stock"; financialTx → "vouchers","journal"; postingCenter → "journal","invoices","vouchers","stock"). Do NOT also emit at the component call site — that double-fires.

**Why:** a single source of emit (the lib) guarantees every screen that performs a post/unpost (Posting Center, Journal Entries, the 9 doc admins) triggers all listeners regardless of call site.

**The gotcha (cost me a review round):** a screen's `useDataRefresh` channel list must cover EVERY entity its `refresh()` reads — not just the screen's "primary" doc type. `SalesInvoicesAdmin`/`PurchasesAdmin` `refresh()` also call `listFinancialTx` to compute paid/outstanding, so they must listen to `["invoices","vouchers"]`, not just `["invoices"]`, or a receipt/payment posted on another screen leaves their paid columns stale.

**How to apply:** when wiring a new screen onto the bus, list-channel = union of all entities its fetch touches. When adding a new posting/GL/stock mutation to a lib, add an `emitData(...)` after the successful invoke.

**Do NOT** reintroduce a parallel generic broadcast (a prior session added `emitDataChanged`/`useDataChanged` and even clobbered dataBus.ts — all reverted). One bus only.

Related FIX (same session): blank document-line VAT default is `getTaxRate()` (country-aware: SA=15, EG=14, AE=5…), but a picked item's own saved `vatRate` still wins (`it.vatRate ?? next.vatRate`). ItemsAdmin keeps pharmacy 14 via `isPharmacy ? 14 : getTaxRate()`.
