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

## Client webview→host fetch needs BOTH CSP allowance AND server CORS
The client reaches the host with the **webview `fetch`** (`fetch("http://<ip>:<port>/lan/{ping,invoke,changes}", {headers:{"x-lan-token"}})`). On Windows the WebView2 origin is `http://tauri.localhost`, so a LAN `http://` target is cross-origin (NOT mixed-content). Two things must both be true or every LAN call silently fails with the generic "تعذّر الوصول":
1. `tauri.conf.json` `security.csp` `connect-src` must include `http://*:*` (LAN host IP+port). It originally only listed `'self'` + the cloud `https://*.zacoderp.com`, so the webview blocked all LAN fetches.
2. The tiny_http host (`lan.rs`) must answer the **CORS preflight** and send `Access-Control-Allow-*` on every response. `x-lan-token` is a non-safelisted header → the browser sends an `OPTIONS` preflight first; that branch must be handled BEFORE `token_matches` (preflight carries no token) and return 204 + CORS headers.
**Why:** the LAN feature was shipped using webview fetch but never tested cross-machine; CSP + missing CORS made test-connection always fail even with the host running.
**How to apply:** if you ever switch the transport to Rust-side reqwest (via a Tauri command), both of these become unnecessary — but as long as the bridge uses webview `fetch`, keep CSP `connect-src http://*:*` and the lan.rs CORS/OPTIONS handling in lockstep.

## Test-connection must be side-effect free
The wizard/settings "اختبار الاتصال" buttons use `pingHostAt(url, token)` (explicit args, no state writes), NOT `pingHost()` + persisting `net_role`/`lan_host_url`/`lan_token`.
**Why:** persisting before a test silently flips a saved single/host device into client mode just by testing. Role is only committed on explicit Save/Finish.

## Cloud sync is host-only
`pullAndPersist`/`syncPushNow` in `sync.ts` no-op when `isClient()` — the host owns the shared DB and is the single uploader; a client pulling would write into a SQLite it never reads.

## Boot
`initBridge()` runs at the top of `App.boot()` before any data-loading branch, so a client routes from the first load.

## Every bridged command needs a lan.rs dispatch arm
Any `*.ts` lib that calls a Rust command through `shouldUseBridge()`/`bridgeInvoke` (e.g. `customers.ts`) requires a matching `"cmd_name" =>` arm in the `dispatch_command` match in `src-tauri/src/lan.rs`, with args read via the `s_opt`/`f_opt`/`i_opt`/`b_opt`/`i_req` helpers in the SAME camelCase keys the TS side sends. Missing arm → client mode gets "unknown command"; arg-count drift vs the Rust fn signature → Rust compile break (caught only on a real Tauri build, never in Replit typecheck).
**Why:** adding credit args to `create_customer_local` and a new `update_customer_local` command silently left the LAN dispatch on the old 8-arg call / with no arm at all.
**How to apply:** whenever you change a bridged command's Rust signature or add a new bridged command, update its lan.rs arm in the same edit. NOTE: `accounting.ts` (sales/purchases/accounts/suppliers/cash_boxes/banks) uses direct `invoke` (NOT the bridge), so those are intentionally absent from lan.rs — do not "fix" that without a deliberate accounting→bridge migration.

## Host server is multi-threaded
`start_lan_server` wraps the tiny_http `Server` in `Arc` and spawns `LAN_WORKER_THREADS` (8) workers that each block on `server.recv()`; per-request logic lives in `handle_lan_request`. There is NO hardcoded cap on client devices — the worker count just bounds concurrency, not connections.
**Why:** the original single `incoming_requests()` loop served devices one-at-a-time, so simultaneous checkouts queued. SQLite is opened per-call in WAL mode, so reads run in parallel and writes serialise safely at the DB layer — the HTTP layer must not be the bottleneck.
**How to apply:** keep request handling stateless/per-call-connection; never introduce a shared mutable `Connection` across workers. `token`/`name`/`version` are shared read-only via `Arc`.

Rust cannot be compiled in Replit — verify via TS typecheck + architectural review only.
