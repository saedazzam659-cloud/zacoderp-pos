// LAN shared-database mode (Task #207).
//
// One cashier device runs as the HOST: it owns the single `pos.db` SQLite
// file AND runs a tiny HTTP server (tiny_http) on the local network so the
// other cashier devices (CLIENTS) can route every shared-data read/write to
// it. Clients own NO data file — every catalog/customer/invoice/stock call
// is forwarded to the host's `/lan/invoke` endpoint and executed against the
// host's database. SINGLE (standalone) mode never touches any of this.
//
// Endpoints:
//   GET  /lan/ping     → liveness + host name/version (token-checked except
//                        ping stays lenient so the client can detect "wrong
//                        token" vs "host down").
//   POST /lan/invoke   → { cmd, args } dispatched to an allow-listed set of
//                        existing #[tauri::command] functions; returns
//                        { result } on success or { ok:false, error } on
//                        failure (matches `bridge.ts`).
//   GET  /lan/changes  → { version } — a monotically increasing counter
//                        bumped on every shared write so clients can poll and
//                        refetch catalog/stock near-realtime.
//
// Authentication is a shared branch token (`x-lan-token`) configured at
// pairing time. It is NOT a security boundary against a hostile LAN — it just
// prevents an accidental cross-branch mixup. The server binds 0.0.0.0 so any
// device on the branch Wi-Fi/switch can reach it.

use crate::db;
use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

static SERVER_STARTED: AtomicBool = AtomicBool::new(false);

pub const DEFAULT_LAN_PORT: u16 = 7711;

// ── Shared-stock schema + change-version ─────────────────────────────
// `lan_stock` is the host-authoritative quantity table. In single mode the
// app keeps using localStorage for stock (unchanged); only host/client use
// this table. `reorder_point` mirrors the LS "tracked + low-stock" model:
// a row exists ⇒ the item is stock-tracked.
fn ensure_schema(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS lan_stock (
            item_id       INTEGER PRIMARY KEY,
            qty           REAL NOT NULL DEFAULT 0,
            reorder_point REAL NOT NULL DEFAULT 0,
            updated_at    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lan_change_version (
            id      INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO lan_change_version(id, version) VALUES (1, 0);
        "#,
    )?;
    Ok(())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn round3(n: f64) -> f64 {
    (n * 1000.0).round() / 1000.0
}

fn bump_version(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute(
        "UPDATE lan_change_version SET version = version + 1 WHERE id = 1",
        [],
    )?;
    Ok(())
}

#[derive(Serialize)]
pub struct StockRow {
    #[serde(rename = "itemId")]
    pub item_id: i64,
    pub qty: f64,
    #[serde(rename = "reorderPoint")]
    pub reorder_point: f64,
    // TS `fromRustStock` reads `updatedAt` — keep this field + the camelCase
    // rename in lockstep with `RustStockRow` in `src/lib/stock.ts`.
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

// ── Stock commands (host-side; clients reach these over /lan/invoke) ──
#[tauri::command]
pub fn lan_stock_get_all() -> Result<Vec<StockRow>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT item_id, qty, reorder_point, updated_at FROM lan_stock")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(StockRow {
                item_id: r.get(0)?,
                qty: r.get(1)?,
                reorder_point: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn lan_stock_set(
    item_id: i64,
    qty: f64,
    reorder_point: Option<f64>,
) -> Result<f64, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    let q = round3(qty.max(0.0));
    // Preserve an existing reorder point when the caller omits it.
    let rp = match reorder_point {
        Some(v) => v.max(0.0),
        None => conn
            .query_row(
                "SELECT reorder_point FROM lan_stock WHERE item_id = ?1",
                params![item_id],
                |r| r.get::<_, f64>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0.0),
    };
    conn.execute(
        "INSERT INTO lan_stock(item_id, qty, reorder_point, updated_at)
         VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(item_id) DO UPDATE SET
           qty = excluded.qty,
           reorder_point = excluded.reorder_point,
           updated_at = excluded.updated_at",
        params![item_id, q, rp, now_iso()],
    )
    .map_err(|e| e.to_string())?;
    bump_version(&conn).map_err(|e| e.to_string())?;
    Ok(q)
}

#[tauri::command]
pub fn lan_stock_set_reorder(item_id: i64, reorder_point: f64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    let rp = reorder_point.max(0.0);
    conn.execute(
        "INSERT INTO lan_stock(item_id, qty, reorder_point, updated_at)
         VALUES(?1, 0, ?2, ?3)
         ON CONFLICT(item_id) DO UPDATE SET
           reorder_point = excluded.reorder_point,
           updated_at = excluded.updated_at",
        params![item_id, rp, now_iso()],
    )
    .map_err(|e| e.to_string())?;
    bump_version(&conn).map_err(|e| e.to_string())?;
    Ok(())
}

/// Atomically add `delta` to a tracked item's quantity. Returns the new
/// quantity, or `None` when the item is NOT tracked (no row) so the caller
/// treats it as unlimited — matching the LS `adjustStock` semantics. A
/// negative delta that would drive a tracked item below zero is REJECTED
/// (Arabic error) so two near-simultaneous sales on different devices can't
/// oversell the shared stock.
#[tauri::command]
pub fn lan_stock_adjust(item_id: i64, delta: f64) -> Result<Option<f64>, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let prev: Option<f64> = tx
        .query_row(
            "SELECT qty FROM lan_stock WHERE item_id = ?1",
            params![item_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let result = match prev {
        None => None, // untracked → unlimited
        Some(q) => {
            let next = q + delta;
            if next < -0.0001 {
                return Err("الكمية غير كافية في المخزون".to_string());
            }
            let next = round3(next.max(0.0));
            tx.execute(
                "UPDATE lan_stock SET qty = ?1, updated_at = ?2 WHERE item_id = ?3",
                params![next, now_iso(), item_id],
            )
            .map_err(|e| e.to_string())?;
            Some(next)
        }
    };
    if result.is_some() {
        bump_version(&tx).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[derive(serde::Deserialize)]
pub struct BulkStockRow {
    #[serde(rename = "itemId")]
    pub item_id: i64,
    pub qty: f64,
    #[serde(rename = "reorderPoint")]
    pub reorder_point: Option<f64>,
}

#[tauri::command]
pub fn lan_stock_bulk_set(rows: Vec<BulkStockRow>) -> Result<u64, String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut n: u64 = 0;
    let now = now_iso();
    for row in &rows {
        let q = round3(row.qty.max(0.0));
        let rp = row.reorder_point.map(|v| v.max(0.0));
        match rp {
            Some(rp) => {
                tx.execute(
                    "INSERT INTO lan_stock(item_id, qty, reorder_point, updated_at)
                     VALUES(?1, ?2, ?3, ?4)
                     ON CONFLICT(item_id) DO UPDATE SET
                       qty = excluded.qty,
                       reorder_point = excluded.reorder_point,
                       updated_at = excluded.updated_at",
                    params![row.item_id, q, rp, now],
                )
                .map_err(|e| e.to_string())?;
            }
            None => {
                tx.execute(
                    "INSERT INTO lan_stock(item_id, qty, reorder_point, updated_at)
                     VALUES(?1, ?2, 0, ?3)
                     ON CONFLICT(item_id) DO UPDATE SET
                       qty = excluded.qty,
                       updated_at = excluded.updated_at",
                    params![row.item_id, q, now],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        n += 1;
    }
    bump_version(&tx).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

#[tauri::command]
pub fn lan_stock_clear() -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM lan_stock", [])
        .map_err(|e| e.to_string())?;
    bump_version(&conn).map_err(|e| e.to_string())?;
    Ok(())
}

fn setting_get(key: &str) -> Option<String> {
    let conn = db::open().ok()?;
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Read the persisted net role + LAN config and, when this device is a HOST,
/// start the LAN HTTP server. Called once from `setup()`. No-ops for single /
/// client roles (a client never binds a server). Missing token ⇒ skip with a
/// warning (the host UI forces a token at pairing time).
pub fn maybe_start_host_server(name: String, version: String) {
    let role = setting_get("net_role").unwrap_or_else(|| "single".to_string());
    if role != "host" {
        return;
    }
    let token = match setting_get("lan_token") {
        Some(t) if !t.is_empty() => t,
        _ => {
            log::warn!("net_role=host but no lan_token set; LAN server not started");
            return;
        }
    };
    let port = setting_get("lan_port")
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_LAN_PORT);
    start_lan_server(port, token, name, version);
}

pub fn get_change_version() -> Result<i64> {
    let conn = db::open()?;
    ensure_schema(&conn)?;
    let v: i64 = conn.query_row(
        "SELECT version FROM lan_change_version WHERE id = 1",
        [],
        |r| r.get(0),
    )?;
    Ok(v)
}

// ── Local IP (for the host UI to show the pairing address) ───────────
#[tauri::command]
pub fn lan_local_ip() -> Result<Option<String>, String> {
    match local_ip_address::local_ip() {
        Ok(ip) => Ok(Some(ip.to_string())),
        Err(_) => Ok(None),
    }
}

// ── Dispatch: cmd name → existing command function ───────────────────
// ONLY shared-data commands are reachable over the LAN. Device-local
// commands (peripherals, scale, keyring, license, parked carts, session,
// settings) are deliberately absent — a client must never drive the host's
// hardware or auth state. Cloud-pull commands ARE included so a host-side
// admin action initiated from a client (rare) still works; cloud PUSH stays
// host-only and is gated in the TS layer.
fn dispatch(cmd: &str, args: &Value) -> Result<Value, String> {
    let s_opt = |k: &str| -> Option<String> {
        args.get(k).and_then(|v| v.as_str()).map(|s| s.to_string())
    };
    let s_req = |k: &str| -> Result<String, String> {
        s_opt(k).ok_or_else(|| format!("missing field '{k}'"))
    };
    let f_req = |k: &str| -> Result<f64, String> {
        args.get(k)
            .and_then(|v| v.as_f64())
            .ok_or_else(|| format!("missing field '{k}'"))
    };
    let f_opt = |k: &str| -> Option<f64> { args.get(k).and_then(|v| v.as_f64()) };
    let i_req = |k: &str| -> Result<i64, String> {
        args.get(k)
            .and_then(|v| v.as_i64())
            .ok_or_else(|| format!("missing field '{k}'"))
    };
    let i_opt = |k: &str| -> Option<i64> { args.get(k).and_then(|v| v.as_i64()) };
    let b_opt = |k: &str| -> Option<bool> { args.get(k).and_then(|v| v.as_bool()) };

    match cmd {
        // ── Items ──
        "list_items" => crate::items::list_items(s_opt("search"))
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "find_item_by_barcode" => crate::items::find_item_by_barcode(s_req("barcode")?)
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "find_item_by_plu" => crate::items::find_item_by_plu(s_req("plu")?)
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "list_expiring_items" => {
            crate::items::list_expiring_items(i_req("within_days")?)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "seed_demo_items" => crate::items::seed_demo_items()
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "upsert_items_from_cloud" => {
            let rows = serde_json::from_value(args.get("rows").cloned().unwrap_or(json!([])))
                .map_err(|e| e.to_string())?;
            crate::items::upsert_items_from_cloud(rows)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "insert_local_item" => crate::items::insert_local_item(
            s_opt("code"),
            s_req("name_ar")?,
            s_opt("name_en"),
            s_opt("barcode"),
            f_req("sale_price")?,
            f_req("vat_rate")?,
            s_opt("active_ingredient"),
            s_opt("dosage_form"),
            s_opt("strength"),
            s_opt("manufacturer"),
            b_opt("requires_prescription"),
            b_opt("controlled"),
            s_opt("expiry_date"),
            s_opt("batch_no"),
            b_opt("is_weighed"),
            f_opt("price_per_kg"),
            s_opt("plu"),
        )
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "update_local_item_extended" => crate::items::update_local_item_extended(
            i_req("id")?,
            s_opt("active_ingredient"),
            s_opt("dosage_form"),
            s_opt("strength"),
            s_opt("manufacturer"),
            b_opt("requires_prescription"),
            b_opt("controlled"),
            s_opt("expiry_date"),
            s_opt("batch_no"),
        )
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "update_local_item_weighed" => crate::items::update_local_item_weighed(
            i_req("id")?,
            b_opt("is_weighed"),
            f_opt("price_per_kg"),
            s_opt("plu"),
        )
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),

        // ── Customers ──
        "list_customers" => crate::customers::list_customers(s_opt("search"))
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "upsert_customers_from_cloud" => {
            let rows = serde_json::from_value(args.get("rows").cloned().unwrap_or(json!([])))
                .map_err(|e| e.to_string())?;
            crate::customers::upsert_customers_from_cloud(rows)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "create_customer_local" => crate::customers::create_customer_local(
            s_req("nameAr")?,
            s_opt("nameEn"),
            s_opt("phone"),
            s_opt("vatNumber"),
            s_opt("currencyCode"),
            f_opt("openingBalance"),
            s_opt("openingNature"),
            s_opt("openingDate"),
            f_opt("creditLimit"),
            b_opt("enforceCreditLimit"),
            i_opt("paymentTermsDays"),
            args.get("profile").and_then(|v| serde_json::from_value(v.clone()).ok()),
        )
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "update_customer_local" => crate::customers::update_customer_local(
            i_req("id")?,
            s_opt("nameAr"),
            s_opt("nameEn"),
            s_opt("phone"),
            s_opt("vatNumber"),
            s_opt("currencyCode"),
            f_opt("creditLimit"),
            b_opt("enforceCreditLimit"),
            i_opt("paymentTermsDays"),
            args.get("profile").and_then(|v| serde_json::from_value(v.clone()).ok()),
        )
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),

        // ── Invoices ──
        "save_offline_invoice" => crate::invoices::save_offline_invoice(
            s_req("payloadJson")?,
            s_opt("qrBase64"),
            s_opt("signedXml"),
            s_opt("idempotencyKey"),
        )
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "get_offline_invoice" => crate::invoices::get_offline_invoice(i_req("id")?)
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "list_pending_invoices" => crate::invoices::list_pending_invoices()
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "count_pending_invoices" => crate::invoices::count_pending_invoices()
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "list_all_invoices" => crate::invoices::list_all_invoices(i_opt("limit"))
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "daily_report_invoices" => {
            crate::invoices::daily_report_invoices(s_req("startUtc")?, s_req("endUtc")?)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }

        // ── Shared stock ──
        "lan_stock_get_all" => lan_stock_get_all()
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "lan_stock_set" => {
            lan_stock_set(i_req("itemId")?, f_req("qty")?, f_opt("reorderPoint"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "lan_stock_set_reorder" => {
            lan_stock_set_reorder(i_req("itemId")?, f_req("reorderPoint")?)
                .map(|_| Value::Null)
        }
        "lan_stock_adjust" => lan_stock_adjust(i_req("itemId")?, f_req("delta")?)
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "lan_stock_bulk_set" => {
            let rows = serde_json::from_value(args.get("rows").cloned().unwrap_or(json!([])))
                .map_err(|e| e.to_string())?;
            lan_stock_bulk_set(rows)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "lan_stock_clear" => lan_stock_clear().map(|_| Value::Null),

        _ => Err(format!("أمر غير مسموح به عبر الشبكة: '{cmd}'")),
    }
}

// ── HTTP server ──────────────────────────────────────────────────────
// CORS headers attached to EVERY response. The client devices run inside a
// Tauri WebView2 webview whose origin is `http://tauri.localhost`; a fetch to
// `http://<host-ip>:<port>/lan/*` is cross-origin, so without these headers the
// browser blocks the response (and the preflight) and the client UI shows the
// generic "تعذّر الوصول" error even though the host is perfectly reachable.
// `x-lan-token` is a non-safelisted header, so it forces a CORS preflight that
// is answered in `handle_lan_request`.
fn cors_headers() -> Vec<tiny_http::Header> {
    [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "x-lan-token, content-type"),
        ("Access-Control-Max-Age", "86400"),
    ]
    .iter()
    .filter_map(|(k, v)| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).ok())
    .collect()
}

fn respond_json(req: tiny_http::Request, status: u16, body: &Value) {
    let data = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    let mut response = tiny_http::Response::from_string(data).with_status_code(status);
    if let Ok(ct) = tiny_http::Header::from_bytes(
        &b"Content-Type"[..],
        &b"application/json; charset=utf-8"[..],
    ) {
        response.add_header(ct);
    }
    for h in cors_headers() {
        response.add_header(h);
    }
    let _ = req.respond(response);
}

fn token_matches(req: &tiny_http::Request, token: &str) -> bool {
    req.headers().iter().any(|h| {
        h.field.as_str().as_str().eq_ignore_ascii_case("x-lan-token")
            && h.value.as_str() == token
    })
}

/// Number of worker threads that pull from the shared tiny_http accept queue.
/// SQLite is opened per-call (WAL mode), so reads run truly in parallel and
/// writes serialise at the DB layer — letting several cashier devices check
/// out at the same time without queueing behind one another at the HTTP layer.
const LAN_WORKER_THREADS: usize = 8;

/// Handle a single inbound LAN request. Runs on a worker thread; `token`,
/// `name`, `version` are shared read-only across all workers.
fn handle_lan_request(mut req: tiny_http::Request, token: &str, name: &str, version: &str) {
    let url = req.url().to_string();
    let method = req.method().clone();

    // CORS preflight — the webview sends an OPTIONS request before the real
    // GET/POST because `x-lan-token` is a custom header. Answer it with the
    // CORS headers and an empty 204 so the actual request is allowed through.
    if method == tiny_http::Method::Options {
        let mut response = tiny_http::Response::empty(204);
        for h in cors_headers() {
            response.add_header(h);
        }
        let _ = req.respond(response);
        return;
    }

    // /lan/ping — token-checked but distinguishes wrong-token (403)
    // from reachable, so the client status UI can show a precise msg.
    if url.starts_with("/lan/ping") {
        if !token_matches(&req, token) {
            respond_json(req, 403, &json!({ "error": "unauthorized" }));
        } else {
            respond_json(
                req,
                200,
                &json!({ "ok": true, "role": "host", "name": name, "version": version }),
            );
        }
        return;
    }

    if !token_matches(&req, token) {
        respond_json(req, 401, &json!({ "error": "unauthorized" }));
        return;
    }

    if url.starts_with("/lan/changes") {
        let v = get_change_version().unwrap_or(0);
        respond_json(req, 200, &json!({ "version": v }));
        return;
    }

    if url.starts_with("/lan/invoke") && method == tiny_http::Method::Post {
        let mut body = String::new();
        if req.as_reader().read_to_string(&mut body).is_err() {
            respond_json(req, 200, &json!({ "ok": false, "error": "تعذّر قراءة الطلب" }));
            return;
        }
        let parsed: Result<Value, _> = serde_json::from_str(&body);
        let payload = match parsed {
            Ok(v) => v,
            Err(_) => {
                respond_json(
                    req,
                    200,
                    &json!({ "ok": false, "error": "طلب غير صالح (JSON)" }),
                );
                return;
            }
        };
        let cmd = payload
            .get("cmd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let default_args = json!({});
        let cmd_args = payload.get("args").unwrap_or(&default_args);
        match dispatch(&cmd, cmd_args) {
            Ok(data) => respond_json(req, 200, &json!({ "result": data })),
            Err(e) => respond_json(req, 200, &json!({ "ok": false, "error": e })),
        }
        return;
    }

    respond_json(req, 404, &json!({ "error": "not found" }));
}

/// Start the host HTTP server. Idempotent — a second call (e.g. after a
/// settings refresh) is a no-op so we never bind twice. `name`/`version`
/// are echoed back on /lan/ping for the client UI.
///
/// The server is shared (via `Arc`) across `LAN_WORKER_THREADS` worker
/// threads that each block on `server.recv()`. tiny_http hands each incoming
/// connection to whichever worker is free, so multiple devices are served
/// concurrently instead of one-at-a-time.
pub fn start_lan_server(port: u16, token: String, name: String, version: String) {
    if SERVER_STARTED.swap(true, Ordering::SeqCst) {
        log::warn!("LAN server already started; ignoring duplicate start");
        return;
    }
    std::thread::spawn(move || {
        let addr = format!("0.0.0.0:{port}");
        let server = match tiny_http::Server::http(&addr) {
            Ok(s) => std::sync::Arc::new(s),
            Err(e) => {
                log::error!("LAN host server failed to bind {addr}: {e}");
                SERVER_STARTED.store(false, Ordering::SeqCst);
                return;
            }
        };
        log::info!(
            "LAN host server listening on {addr} ({LAN_WORKER_THREADS} workers)"
        );

        let shared = std::sync::Arc::new((token, name, version));
        let mut workers = Vec::with_capacity(LAN_WORKER_THREADS);
        for worker_id in 0..LAN_WORKER_THREADS {
            let server = std::sync::Arc::clone(&server);
            let shared = std::sync::Arc::clone(&shared);
            workers.push(std::thread::spawn(move || loop {
                match server.recv() {
                    Ok(req) => {
                        let (ref token, ref name, ref version) = *shared;
                        handle_lan_request(req, token, name, version);
                    }
                    Err(e) => {
                        log::warn!("LAN worker {worker_id} recv error: {e}");
                        break;
                    }
                }
            }));
        }
        // Block until every worker exits (only on unrecoverable recv errors).
        for w in workers {
            let _ = w.join();
        }
        log::warn!("LAN host server loop exited");
        SERVER_STARTED.store(false, Ordering::SeqCst);
    });
}
