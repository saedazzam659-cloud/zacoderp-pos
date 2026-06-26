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

**Empty-state guard trap:** for an ON-DEMAND report (data only after the user clicks عرض/تشغيل) guard the refresh callback so it re-runs only when a result already exists — but guard on a stable "has been run" signal, NEVER on `rows.length`/`raw.length`: a report whose last run returned ZERO rows would then never refresh again. For screens that AUTO-load on mount (`useEffect(() => void refresh(), [])`), use NO guard at all — just `() => { void refresh(); }`. Mis-guarding StockValuation/WarehouseStock on `rows.length` silently froze them on empty stock.

**Draft-create mutations must emit too:** the objective is "every action (create/edit/delete/post/unpost) propagates". A draft-create that writes no JE/stock still changes a LIST (e.g. `createStocktake`) — emit its nearest channel (`"stock"`) so open admin lists refresh cross-tab, even though only posting touches GL.

**Do NOT** reintroduce a parallel generic broadcast (a prior session added `emitDataChanged`/`useDataChanged` and even clobbered dataBus.ts — all reverted). One bus only.

**VAT source rule (the 9 doc forms):** a document line's VAT comes ONLY from the picked item — never the country default. A blank line (no item) is `vatRate:0`; on item-select it is `it.vatRate ?? 0` on every form (sales AND purchase/goods). A selected HEADER tax (`selectedRate`) still overrides all line rates AFTER, so one tax can blanket the whole invoice. **Why:** items carry their own correct rate (e.g. zero-rated/exempt goods); seeding from `getTaxRate()` silently taxed exempt lines at the country rate. `getTaxRate()`/`ItemsAdmin` (item-master default, pharmacy 14) are a SEPARATE concern and keep using country-aware defaults.
