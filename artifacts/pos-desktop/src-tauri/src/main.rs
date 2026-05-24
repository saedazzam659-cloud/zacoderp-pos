// ZACOD POS Desktop — Tauri entry point
// TODO (Task #174 Steps 6-12): wire up real DB, sync, license, ZATCA modules.
// This scaffold compiles and shows the React shell; offline logic stubbed.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod license;
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

#[tauri::command]
async fn sync_now() -> Result<String, String> {
    sync::run_full_cycle().await.map_err(|e| e.to_string())
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

// Secure device-token storage. Real impl in Step 8 uses the `keyring` crate
// (Windows Credential Manager). For the scaffold, these are explicit stubs
// that always Err so the shim's fallback path is used and the dev knows
// secure storage is not yet wired.
#[tauri::command]
fn save_device_token(_token: String) -> Result<(), String> {
    Err("save_device_token: not implemented yet (Task #174 Step 8)".into())
}

#[tauri::command]
fn load_device_token() -> Result<Option<String>, String> {
    Err("load_device_token: not implemented yet (Task #174 Step 8)".into())
}

#[tauri::command]
fn clear_device_token() -> Result<(), String> {
    Err("clear_device_token: not implemented yet (Task #174 Step 8)".into())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
