// ZACOD POS Desktop — Tauri entry point
// TODO (Task #174 Steps 6-12): wire up real DB, sync, license, ZATCA modules.
// This scaffold compiles and shows the React shell; offline logic stubbed.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounting;
mod customers;
mod db;
mod inventory;
mod invoices;
mod items;
mod lan;
mod license;
mod peripherals;
mod permissions;
mod scale;
mod standalone;
mod sync;
mod updater;
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

// Native "Save As" dialog + write text to chosen path.
// Returns the chosen path on success, or None if the user cancelled.
// Used by the stock-import screen (and any future export) so the cashier
// gets a real Windows save dialog instead of a silent browser download
// that WebView2 often drops.
#[tauri::command]
async fn save_text_file(
    app: tauri::AppHandle,
    content: String,
    suggested_name: String,
    filter_name: String,
    filter_ext: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(&filter_name, &[filter_ext.as_str()])
        .set_file_name(&suggested_name)
        .save_file(move |fp| {
            let _ = tx.send(fp);
        });
    let chosen = rx.await.map_err(|e| e.to_string())?;
    let Some(fp) = chosen else { return Ok(None); };
    let path: std::path::PathBuf = fp.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
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

// ─── File-based fallback storage (Task #185) ─────────────────────────
// On Windows the OS keyring (Credential Manager) can silently fail for
// unsigned MSI installs or certain group-policy lockdowns. When that
// happens `load_device_token` would return None on every launch and the
// app would re-prompt for activation forever. Dual-write the token to a
// file under %APPDATA%/ZACOD-POS/tokens/<slot> so it survives even when
// the keyring layer is unavailable. The directory is ACL-restricted to
// the current user by default (Windows %APPDATA% inherits user-only ACL).
fn token_file_path(slot: &str) -> Result<std::path::PathBuf, String> {
    let mut p = dirs::data_dir().ok_or_else(|| "no data dir available".to_string())?;
    p.push("ZACOD-POS");
    p.push("tokens");
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    p.push(slot);
    Ok(p)
}

fn save_token_file(slot: &str, token: &str) -> Result<(), String> {
    let p = token_file_path(slot)?;
    std::fs::write(&p, token).map_err(|e| e.to_string())
}

fn load_token_file(slot: &str) -> Result<Option<String>, String> {
    let p = token_file_path(slot)?;
    if !p.exists() { return Ok(None); }
    match std::fs::read_to_string(&p) {
        Ok(t) => {
            let t = t.trim().to_string();
            if t.is_empty() { Ok(None) } else { Ok(Some(t)) }
        }
        Err(e) => Err(e.to_string()),
    }
}

fn clear_token_file(slot: &str) -> Result<(), String> {
    let p = token_file_path(slot)?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn save_device_token(token: String) -> Result<(), String> {
    // Best-effort keyring write — never fail the whole call on keyring errors.
    if let Ok(entry) = token_entry() {
        let _ = entry.set_password(&token);
    }
    // File write IS the source of truth — must succeed.
    save_token_file(KEYRING_ACCOUNT_TOKEN, &token)
}

#[tauri::command]
fn load_device_token() -> Result<Option<String>, String> {
    // Try keyring first (faster + more secure on healthy installs), then
    // fall back to the file. Returning None only when BOTH miss.
    if let Ok(entry) = token_entry() {
        if let Ok(t) = entry.get_password() {
            return Ok(Some(t));
        }
        // Any other keyring error (locked, NoEntry, OS error) → file fallback.
    }
    load_token_file(KEYRING_ACCOUNT_TOKEN)
}

#[tauri::command]
fn clear_device_token() -> Result<(), String> {
    if let Ok(entry) = token_entry() {
        let _ = entry.delete_credential();
    }
    clear_token_file(KEYRING_ACCOUNT_TOKEN)
}

// ─── Cashier user token (Task #175 + file fallback Task #185) ───────
#[tauri::command]
fn save_user_token(token: String) -> Result<(), String> {
    if let Ok(entry) = user_token_entry() {
        let _ = entry.set_password(&token);
    }
    save_token_file(KEYRING_ACCOUNT_USER_TOKEN, &token)
}

#[tauri::command]
fn load_user_token() -> Result<Option<String>, String> {
    if let Ok(entry) = user_token_entry() {
        if let Ok(t) = entry.get_password() {
            return Ok(Some(t));
        }
    }
    load_token_file(KEYRING_ACCOUNT_USER_TOKEN)
}

#[tauri::command]
fn clear_user_token() -> Result<(), String> {
    if let Ok(entry) = user_token_entry() {
        let _ = entry.delete_credential();
    }
    clear_token_file(KEYRING_ACCOUNT_USER_TOKEN)
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
            // Task #207: if this device is configured as the LAN host, start
            // its shared-database HTTP server now. No-op for single/client.
            lan::maybe_start_host_server(
                get_device_name(),
                env!("CARGO_PKG_VERSION").to_string(),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            activate_device,
            sync_now,
            save_text_file,
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
            items::list_expiring_items,
            items::insert_local_item,
            items::update_local_item_extended,
            items::update_local_item_weighed,
            items::find_item_by_plu,
            scale::list_scale_ports,
            scale::read_weight_once,
            customers::list_customers,
            customers::upsert_customers_from_cloud,
            customers::create_customer_local,
            customers::update_customer_local,
            invoices::save_offline_invoice,
            invoices::list_pending_invoices,
            invoices::list_all_invoices,
            invoices::daily_report_invoices,
            invoices::get_offline_invoice,
            invoices::count_pending_invoices,
            sync::sync_push_now,
            standalone::standalone_get_mode,
            standalone::standalone_set_mode,
            standalone::standalone_load_license,
            standalone::standalone_save_license,
            standalone::standalone_list_users,
            standalone::standalone_create_user,
            standalone::standalone_auth_user,
            standalone::standalone_verify_admin,
            standalone::standalone_load_session,
            standalone::standalone_clear_session,
            standalone::standalone_delete_user,
            standalone::standalone_change_password,
            standalone::standalone_wipe_all,
            standalone::standalone_get_setting,
            standalone::standalone_set_setting,
            updater::download_and_install_update,
            // Accounting & operations (Task #207).
            accounting::accounts_list,
            accounting::accounts_create,
            accounting::accounts_update,
            accounting::accounts_delete,
            accounting::suppliers_list,
            accounting::suppliers_create,
            accounting::suppliers_update,
            accounting::suppliers_delete,
            accounting::cash_boxes_list,
            accounting::cash_boxes_create,
            accounting::cash_boxes_update,
            accounting::cash_boxes_delete,
            accounting::banks_list,
            accounting::banks_create,
            accounting::banks_update,
            accounting::banks_delete,
            accounting::purchases_list,
            accounting::purchase_get,
            accounting::purchase_create,
            accounting::purchase_returns_list,
            accounting::purchase_return_get,
            accounting::purchase_return_create,
            accounting::sales_invoices_list,
            accounting::sales_invoice_get,
            accounting::sales_invoice_create,
            accounting::sales_returns_list,
            accounting::sales_return_get,
            accounting::sales_return_create,
            accounting::financial_tx_list,
            accounting::financial_tx_create,
            accounting::journal_entries_list,
            accounting::journal_entry_get,
            accounting::journal_entry_create,
            accounting::number_series_list,
            accounting::number_series_update,
            permissions::permissions_list_for_user,
            permissions::permissions_set,
            permissions::permissions_clear,
            permissions::permissions_clear_all,
            // Inventory & warehouses (Task #208).
            inventory::warehouses_list,
            inventory::warehouses_create,
            inventory::warehouses_update,
            inventory::warehouses_delete,
            inventory::stock_on_hand_list,
            inventory::stock_movements_list,
            inventory::stock_adjustments_list,
            inventory::stock_adjustment_create,
            inventory::stock_transfers_list,
            inventory::stock_transfer_create,
            inventory::stocktakes_list,
            inventory::stocktake_create,
            inventory::stocktake_post,
            // Multi-currency (Task #209).
            accounting::currencies_list,
            accounting::currency_create,
            accounting::currency_update,
            accounting::currency_delete,
            accounting::currency_rates_list,
            accounting::currency_rate_upsert,
            accounting::currency_rate_delete,
            accounting::treasury_transfers_list,
            accounting::treasury_transfer_create,
            // LAN shared database (Task #207).
            lan::lan_stock_get_all,
            lan::lan_stock_set,
            lan::lan_stock_set_reorder,
            lan::lan_stock_adjust,
            lan::lan_stock_bulk_set,
            lan::lan_stock_clear,
            lan::lan_local_ip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
