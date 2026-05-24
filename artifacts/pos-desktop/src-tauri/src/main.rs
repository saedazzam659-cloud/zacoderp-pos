// ZACOD POS Desktop — Tauri entry point
// TODO (Task #174 Steps 6-12): wire up real DB, sync, license, ZATCA modules.
// This scaffold compiles and shows the React shell; offline logic stubbed.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod license;
mod sync;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
