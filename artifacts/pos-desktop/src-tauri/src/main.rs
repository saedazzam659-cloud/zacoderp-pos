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

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT_TOKEN).map_err(|e| e.to_string())
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
