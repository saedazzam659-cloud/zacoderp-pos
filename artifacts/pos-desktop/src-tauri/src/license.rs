// License activation & hardware fingerprinting.
// TODO Step 8: store device JWT in Windows Credential Manager via `keyring`.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sysinfo::System;

#[derive(Serialize, Deserialize)]
pub struct ActivationResponse {
    pub success: bool,
    pub device_token: Option<String>,
    pub error: Option<String>,
}

pub fn hardware_fingerprint() -> Result<String> {
    let sys = System::new_all();
    // Hash a stable composite: CPU brand + total RAM + machine id.
    let cpu = sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default();
    let ram = sys.total_memory();
    let machine_id = machine_uid::get().unwrap_or_default();
    let composite = format!("{cpu}|{ram}|{machine_id}");
    let mut h = Sha256::new();
    h.update(composite.as_bytes());
    Ok(hex::encode(h.finalize()))
}

pub async fn activate(license_key: &str, server_url: &str) -> Result<ActivationResponse> {
    let fp = hardware_fingerprint()?;
    let body = serde_json::json!({
        "licenseKey": license_key,
        "deviceName": hostname::get().ok().and_then(|h| h.into_string().ok()).unwrap_or_default(),
        "fingerprint": fp,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "osInfo": format!("Windows {}", System::os_version().unwrap_or_default()),
    });
    let url = format!("{server_url}/api/device-licenses/activate");
    let resp = reqwest::Client::new().post(&url).json(&body).send().await?;
    if resp.status().is_success() {
        let j: serde_json::Value = resp.json().await?;
        // TODO: store j["deviceToken"] in keyring
        Ok(ActivationResponse {
            success: true,
            device_token: j.get("deviceToken").and_then(|v| v.as_str()).map(String::from),
            error: None,
        })
    } else {
        let err: serde_json::Value = resp.json().await.unwrap_or_default();
        Ok(ActivationResponse {
            success: false,
            device_token: None,
            error: err.get("error").and_then(|v| v.as_str()).map(String::from),
        })
    }
}
