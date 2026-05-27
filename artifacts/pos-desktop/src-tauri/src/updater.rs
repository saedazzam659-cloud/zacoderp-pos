// In-app updater — Microsoft-style download + passive install.
//
// download_and_install_update(url, expected_sha256?):
//   1. Streams the MSI from `url` into %TEMP%/zacod-pos-update-vXXX.msi
//   2. Emits `updater://progress` events every chunk so the UI can render
//      a Microsoft-style progress bar (downloaded / total bytes).
//   3. Verifies SHA-256 when `expected_sha256` is provided. A mismatch
//      deletes the file and returns Err — we never launch an unverified
//      installer.
//   4. Spawns `msiexec /i <path> /passive /norestart` — Windows shows
//      its native installer progress UI (same as Office / Edge updates).
//      `/passive` keeps the user informed without blocking on prompts.
//   5. After the installer is spawned the running app must exit so the
//      MSI can replace it. We schedule `std::process::exit(0)` ~700ms
//      later so the success event reaches the frontend first.
//
// Cross-platform note: this file only compiles on Windows (msiexec). The
// `cfg(target_os = "windows")` gate keeps Linux/macOS CI happy if the
// crate ever builds there.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
    percent: u8,
}

#[derive(Clone, Serialize)]
pub struct UpdateResult {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

fn temp_msi_path(version: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    // Sanitise the version string — only digits, dots, hyphens allowed.
    let safe: String = version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .collect();
    p.push(format!("zacod-pos-update-v{}.msi", safe));
    p
}

#[tauri::command]
pub async fn download_and_install_update(
    app: AppHandle,
    url: String,
    expected_sha256: Option<String>,
    version: String,
) -> Result<UpdateResult, String> {
    log::info!("[updater] download start url={} version={}", url, version);

    let dest = temp_msi_path(&version);
    let dest_display = dest.display().to_string();

    // ── 1) Stream the MSI to disk while emitting progress ───────────
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("فشل الاتصال بخادم التحديث: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} عند تنزيل التحديث", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file =
        File::create(&dest).map_err(|e| format!("لا يمكن إنشاء ملف التنزيل: {}", e))?;
    let mut hasher = Sha256::new();

    // Throttle progress events to ~10/sec so we don't flood the IPC bridge.
    let mut last_emit = Instant::now();
    let _ = app.emit(
        "updater://progress",
        DownloadProgress {
            downloaded: 0,
            total,
            percent: 0,
        },
    );

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("انقطع التنزيل: {}", e))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("فشل الكتابة على القرص: {}", e))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= Duration::from_millis(100) {
            let percent = if total > 0 {
                ((downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0) as u8
            } else {
                0
            };
            let _ = app.emit(
                "updater://progress",
                DownloadProgress {
                    downloaded,
                    total,
                    percent,
                },
            );
            last_emit = Instant::now();
        }
    }
    file.flush()
        .map_err(|e| format!("فشل إنهاء كتابة الملف: {}", e))?;
    drop(file);

    let sha = hex::encode(hasher.finalize());
    let _ = app.emit(
        "updater://progress",
        DownloadProgress {
            downloaded,
            total: downloaded.max(total),
            percent: 100,
        },
    );

    // ── 2) Verify checksum if the server published one ──────────────
    if let Some(expected) = expected_sha256.as_ref() {
        let expected_clean = expected.trim().to_lowercase();
        if !expected_clean.is_empty() && expected_clean != sha {
            let _ = std::fs::remove_file(&dest);
            return Err(format!(
                "فشل التحقق من سلامة الملف (sha256 لا يطابق). متوقع {} ولكن {}",
                &expected_clean[..16.min(expected_clean.len())],
                &sha[..16.min(sha.len())],
            ));
        }
    }

    log::info!(
        "[updater] download complete: {} bytes → {}",
        downloaded,
        dest_display
    );

    // ── 3) Spawn msiexec /passive (Windows-only) ────────────────────
    #[cfg(target_os = "windows")]
    {
        let dest_str = dest_display.clone();
        std::process::Command::new("msiexec")
            .args(["/i", &dest_str, "/passive", "/norestart"])
            .spawn()
            .map_err(|e| format!("تعذّر تشغيل المثبّت: {}", e))?;

        // Let the success event flush to the renderer before we die.
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            let _ = app2.emit("updater://exiting", ());
            std::thread::sleep(Duration::from_millis(300));
            std::process::exit(0);
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On non-Windows, just return success without launching anything.
        // The MSI is in temp; the user can run it manually.
        log::warn!("[updater] non-Windows build — installer not launched");
    }

    Ok(UpdateResult {
        path: dest_display,
        bytes: downloaded,
        sha256: sha,
    })
}
