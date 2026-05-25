// ZACOD POS Desktop — Tauri entry point
// TODO (Task #174 Steps 6-12): wire up real DB, sync, license, ZATCA modules.
// This scaffold compiles and shows the React shell; offline logic stubbed.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod customers;
mod db;
mod invoices;
mod items;
mod license;
mod peripherals;
mod sync;
mod zatca;

use serde::{Deserialize, Serialize};
use license::ActivationResponse;

#[derive(Serialize, Deserialize)]
struct ActivationRequest {
    license_key: String,
    server_url: String,
}

#[tauri::command]
async fn activate_device(req: ActivationRequest) -> Result<ActivationResponse, String> {
    license::activate(&req.license_key, &req.server_url)
        .await
        .map_err(|e| e.to_string())
}

// `sync::sync_push_now` is the real worker; this thin alias keeps the
// older JS callsite (`invoke('sync_now')`) working without a churn.
#[tauri::command]
async fn sync_now(server_url: String, device_token: String) -> Result<sync::PushSummary, String> {
    sync::push_pending_invoices(&server_url, &device_token)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_hardware_fingerprint() -> Result<String, String> {
    license::hardware_fingerprint().map_err(|e| e.to_string())
}

// ─── Commands consumed by src/lib/tauri-shim.ts ──────────────────────
// These align the Tauri ↔ React contract so the activation wizard's
// shim resolves to real native calls in the desktop build (instead of
// silently falling back to localStorage stubs).

#[tauri::command]
fn get_device_name() -> String {
    // COMPUTERNAME on Windows, fall back to "DESKTOP" if unset.
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "DESKTOP".into())
}

#[tauri::command]
fn get_os_info() -> String {
    format!(
        "{} {} ({})",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::consts::FAMILY
    )
}

// Secure device-token storage via OS keyring (Windows Credential
// Manager / macOS Keychain / Linux Secret Service). All three commands
// surface keyring errors as JS-side Err so the shim's localStorage
// fallback can engage in headless/CI environments.
const KEYRING_SERVICE: &str = "com.zacoderp.pos";
const KEYRING_ACCOUNT_TOKEN: &str = "device-token-v1";
// Cashier user token (Task #175) — separate keyring slot from the device
// token so logging out one cashier never wipes the device binding.
const KEYRING_ACCOUNT_USER_TOKEN: &str = "user-token-v1";

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT_TOKEN).map_err(|e| e.to_string())
}
fn user_token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT_USER_TOKEN).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_device_token(token: String) -> Result<(), String> {
    token_entry()?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_device_token() -> Result<Option<String>, String> {
    match token_entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn clear_device_token() -> Result<(), String> {
    match token_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ─── Cashier user token (Task #175) ──────────────────────────────────
#[tauri::command]
fn save_user_token(token: String) -> Result<(), String> {
    user_token_entry()?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_user_token() -> Result<Option<String>, String> {
    match user_token_entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn clear_user_token() -> Result<(), String> {
    match user_token_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ─── Parked carts (Task #175) ────────────────────────────────────────
// Scratchpad rows the cashier set aside mid-sale. Scoped to a pos_session_id
// so logging out / closing the shift purges that cashier's carts.

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedCart {
    pub id: String,
    pub pos_session_id: i64,
    pub label: String,
    pub customer_note: Option<String>,
    pub lines: serde_json::Value,
    pub grand_total: f64,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
fn parked_carts_list(pos_session_id: i64) -> Result<Vec<ParkedCart>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, pos_session_id, label, customer_note, cart_json, grand_total, created_at, updated_at
         FROM parked_carts WHERE pos_session_id = ?1 ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([pos_session_id], |r| {
        let lines_json: String = r.get(4)?;
        Ok(ParkedCart {
            id: r.get(0)?,
            pos_session_id: r.get(1)?,
            label: r.get(2)?,
            customer_note: r.get(3)?,
            lines: serde_json::from_str(&lines_json).unwrap_or(serde_json::json!([])),
            grand_total: r.get(5)?,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
        })
    }).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[derive(Deserialize)]
struct ParkedCartUpsert {
    cart: serde_json::Value,
}

#[tauri::command]
fn parked_carts_upsert(args: ParkedCartUpsert) -> Result<(), String> {
    let c = &args.cart;
    let id = c.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
    let sid = c.get("posSessionId").and_then(|v| v.as_i64()).ok_or("missing posSessionId")?;
    let label = c.get("label").and_then(|v| v.as_str()).unwrap_or("");
    let note  = c.get("customerNote").and_then(|v| v.as_str());
    let lines = c.get("lines").cloned().unwrap_or(serde_json::json!([]));
    let total = c.get("grandTotal").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let created_at = c.get("createdAt").and_then(|v| v.as_str()).unwrap_or("");
    let updated_at = c.get("updatedAt").and_then(|v| v.as_str()).unwrap_or("");

    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO parked_carts (id, pos_session_id, label, customer_note, cart_json, grand_total, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            label=excluded.label,
            customer_note=excluded.customer_note,
            cart_json=excluded.cart_json,
            grand_total=excluded.grand_total,
            updated_at=excluded.updated_at",
        rusqlite::params![
            id, sid, label, note,
            serde_json::to_string(&lines).unwrap_or_else(|_| "[]".into()),
            total, created_at, updated_at,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn parked_carts_delete(id: String) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM parked_carts WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn parked_carts_clear_session(pos_session_id: i64) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM parked_carts WHERE pos_session_id = ?1", [pos_session_id]).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    env_logger::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|_app| {
            db::initialize().expect("DB init failed");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            activate_device,
            sync_now,
            get_hardware_fingerprint,
            get_device_name,
            get_os_info,
            save_device_token,
            load_device_token,
            clear_device_token,
            save_user_token,
            load_user_token,
            clear_user_token,
            parked_carts_list,
            parked_carts_upsert,
            parked_carts_delete,
            parked_carts_clear_session,
            zatca::generate_qr,
            zatca::decode_qr,
            peripherals::list_printers,
            peripherals::list_serial_ports,
            peripherals::print_receipt,
            peripherals::print_raw_serial,
            peripherals::open_cash_drawer,
            peripherals::open_cash_drawer_serial,
            items::list_items,
            items::find_item_by_barcode,
            items::seed_demo_items,
            items::upsert_items_from_cloud,
            customers::list_customers,
            customers::upsert_customers_from_cloud,
            customers::create_customer_local,
            invoices::save_offline_invoice,
            invoices::list_pending_invoices,
            invoices::list_all_invoices,
            invoices::get_offline_invoice,
            invoices::count_pending_invoices,
            sync::sync_push_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
