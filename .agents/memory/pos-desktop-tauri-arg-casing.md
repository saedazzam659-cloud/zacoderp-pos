---
name: POS Desktop Tauri invoke arg casing
description: Why pos-desktop Tauri command args must be camelCase on BOTH the JS invoke and the lan.rs bridge handler, in lockstep.
---

# POS Desktop — Tauri v2 invoke arg casing

**Rule:** Every `tauriInvoke(cmd, args)` call must use **camelCase** top-level
arg keys (e.g. `nameAr`, `salePrice`, `withinDays`), even though the Rust
`#[tauri::command]` params are snake_case (`name_ar`, `sale_price`). Tauri v2's
runtime converts JS-camelCase → Rust-snake_case automatically. Sending
snake_case keys from JS fails with `command <x> missing required key nameAr`
(it literally looks for the camelCase key).

**Why:** A standalone (direct-Tauri) "add item" failed with that exact error.
The items SQLite commands (`insert_local_item`, `update_local_item`,
`update_local_item_extended`/`_weighed`, `list_expiring_items`) were the only
ones written with snake_case invoke args; every other working command
(`create_customer_local`, etc.) used camelCase.

**The LAN twist:** the snake-case item calls still *worked over LAN* because the
LAN bridge host (`src-tauri/src/lan.rs`) reads the **raw HTTP JSON keys** via
`s_req("name_ar")` / `i_req("within_days")` — so client-snake matched host-snake.
That masked the bug until someone ran standalone (direct Tauri). Therefore the
two transports must stay in lockstep:
- **JS invoke** (camelCase) → Tauri converts → Rust snake params. ✓
- **LAN bridge** `lan.rs` `s_req("…")` literals must match the **camelCase** key
  the JS sends, because lan.rs reads the JSON verbatim (no Tauri conversion).

**How to apply:** When adding/editing a pos-desktop Tauri command, send camelCase
from JS AND make the matching `lan.rs` `s_req/s_opt/i_req/...` string literals
camelCase too. EXCEPTION: nested structs passed as a single arg (e.g.
`upsert_items_from_cloud({ rows: [...] })`) are deserialized by serde on the Rust
struct — those nested fields follow the struct's serde rename (snake_case by
default, e.g. `CloudItem`), NOT the Tauri arg converter. Likewise the `RustItem`/
`RustCustomer` TS interfaces describe Rust-RETURNED JSON (snake_case) and are not
invoke args. Rust changes here compile only in CI (no local cargo).
