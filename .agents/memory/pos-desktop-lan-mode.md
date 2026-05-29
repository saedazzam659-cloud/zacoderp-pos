---
name: POS Desktop LAN shared-DB mode
description: net_role host/client/single architecture, bridge routing, and the camelCase stock contract that must stay in lockstep.
---

# POS Desktop LAN shared-database mode

Three `net_role` values (stored alongside `app_mode`): `single` (default standalone, must stay 100% behavior-preserving), `host` (sells + holds shared SQLite + runs a tiny_http LAN server), `client` (sells but routes all shared reads/writes to the host over LAN).

## Bridge routing
- `bridgeInvoke(cmd,args)` central transport: `client` → `POST {hostUrl}/lan/invoke` with `x-lan-token`; `host`/`single` (Tauri) → local invoke; browser preview → throws so the LS fallback runs.
- **`shouldUseBridge()` is NOT the client check.** It returns `isClient() || IS_TAURI`, true for host/single too. Use **`isClient()`** for anything that must only happen on a client (realtime polling, surfacing host oversell rejections). Using `shouldUseBridge()` causes host/single to poll the host needlessly.

## Stock contract (lockstep)
Rust `StockRow` in `src-tauri/src/lan.rs` serializes **camelCase** via `#[serde(rename)]`: `itemId`, `qty`, `reorderPoint`, `updatedAt`. The TS `RustStockRow` + `fromRustStock` in `src/lib/stock.ts` MUST read those exact camelCase keys.
**Why:** they were silently mismatched once (Rust camelCase + no `updated_at` vs TS snake_case + `updated_at`), which breaks `getAllStockShared()` mapping in LAN mode without any type error (it's a runtime JSON shape).
**How to apply:** any change to either struct must change the other in the same edit; the `lan_stock_get_all` SELECT must include every column the struct deserializes.

## Test-connection must be side-effect free
The wizard/settings "اختبار الاتصال" buttons use `pingHostAt(url, token)` (explicit args, no state writes), NOT `pingHost()` + persisting `net_role`/`lan_host_url`/`lan_token`.
**Why:** persisting before a test silently flips a saved single/host device into client mode just by testing. Role is only committed on explicit Save/Finish.

## Cloud sync is host-only
`pullAndPersist`/`syncPushNow` in `sync.ts` no-op when `isClient()` — the host owns the shared DB and is the single uploader; a client pulling would write into a SQLite it never reads.

## Boot
`initBridge()` runs at the top of `App.boot()` before any data-loading branch, so a client routes from the first load.

## Host server is multi-threaded
`start_lan_server` wraps the tiny_http `Server` in `Arc` and spawns `LAN_WORKER_THREADS` (8) workers that each block on `server.recv()`; per-request logic lives in `handle_lan_request`. There is NO hardcoded cap on client devices — the worker count just bounds concurrency, not connections.
**Why:** the original single `incoming_requests()` loop served devices one-at-a-time, so simultaneous checkouts queued. SQLite is opened per-call in WAL mode, so reads run in parallel and writes serialise safely at the DB layer — the HTTP layer must not be the bottleneck.
**How to apply:** keep request handling stateless/per-call-connection; never introduce a shared mutable `Connection` across workers. `token`/`name`/`version` are shared read-only via `Arc`.

Rust cannot be compiled in Replit — verify via TS typecheck + architectural review only.
