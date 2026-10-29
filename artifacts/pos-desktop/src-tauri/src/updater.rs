// In-app updater — Microsoft-style download + passive install.
//
// download_and_install_update(url, expected_sha256?):
//   1. Streams the MSI from `url` into %TEMP%/zacod-pos-update-vXXX.msi
//   2. Emits `updater://progress` events every chunk so the UI can render
//      a Microsoft-style progress bar (downloaded / total bytes).
//   3. Verifies SHA-256 when `expected_sha256` is provided. A mismatch
//      deletes the file and returns Err — we never launch an unverified
//      installer.
//   4. Starts a detached copy of this executable as a small update helper.
//      The helper waits for the app to exit, runs msiexec, and waits for the
//      actual installer result before restarting the app.
//   5. The app exits so Windows Installer can replace its files. The helper
//      relaunches it only after a successful install; failures show a native
//      error dialog and relaunch the existing installation.
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

const UPDATE_HELPER_ARG: &str = "--apply-pos-update";

/// Runs the detached installer helper when this executable was started with
/// the private update argument. Returns true when the normal Tauri app should
/// not be started.
pub fn run_update_helper() -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut args = std::env::args_os().skip(1);
        if args.next().as_deref() != Some(std::ffi::OsStr::new(UPDATE_HELPER_ARG)) {
            return false;
        }

        let Some(parent_pid) = args
            .next()
            .and_then(|value| value.to_string_lossy().parse::<u32>().ok())
        else {
            return true;
        };
        let Some(msi_path) = args.next().map(PathBuf::from) else {
            return true;
        };
        let Some(app_path) = args.next().map(PathBuf::from) else {
            return true;
        };

        run_update_helper_windows(parent_pid, msi_path, app_path);
        true
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Remove helper executable copies left in the temp directory by earlier
/// updates. The delay lets the detached helper finish spawning this app.
pub fn cleanup_stale_helpers() {
    #[cfg(target_os = "windows")]
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(15));
        let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name
                .to_string_lossy()
                .starts_with("zacod-pos-update-helper-")
            {
                if let Err(error) = std::fs::remove_file(entry.path()) {
                    log::debug!("[updater] deferred helper cleanup: {}", error);
                }
            }
        }
    });
}

#[cfg(target_os = "windows")]
fn installer_log_is_maintenance_mode(log_path: &std::path::Path) -> bool {
    let Ok(bytes) = std::fs::read(log_path) else {
        return false;
    };
    let words = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    String::from_utf16_lossy(&words).contains("Product registered: entering maintenance mode")
}

#[cfg(target_os = "windows")]
fn run_update_helper_windows(parent_pid: u32, msi_path: PathBuf, app_path: PathBuf) {
    // SYNCHRONIZE is sufficient to wait for the parent process to terminate.
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const INFINITE: u32 = 0xFFFF_FFFF;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> *mut std::ffi::c_void;
        fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }

    let parent = unsafe { OpenProcess(SYNCHRONIZE, 0, parent_pid) };
    if !parent.is_null() {
        unsafe {
            WaitForSingleObject(parent, INFINITE);
            CloseHandle(parent);
        }
    }

    let log_path = std::env::temp_dir().join("zacod-pos-update-install.log");
    let mut result = std::process::Command::new("msiexec")
        .arg("/i")
        .arg(&msi_path)
        .args(["/passive", "/norestart", "/l*v"])
        .arg(&log_path)
        .status();

    // 0 = success; 3010 = success, reboot required.
    let mut success = matches!(
        result.as_ref().map(std::process::ExitStatus::code),
        Ok(Some(0 | 3010))
    );
    let mut result_log_path = log_path.clone();

    // A same-ProductCode MSI can enter maintenance mode instead of upgrading.
    // With passive UI, Windows Installer may then return success without
    // selecting any features (the old app files remain in place). Retry that
    // specific case as an explicit repair of every already-installed feature.
    if success && installer_log_is_maintenance_mode(&log_path) {
        let repair_log_path = std::env::temp_dir().join("zacod-pos-update-repair.log");
        log::warn!(
            "[updater] MSI entered maintenance mode; retrying with REINSTALL=ALL"
        );
        result = std::process::Command::new("msiexec")
            .arg("/i")
            .arg(&msi_path)
            .args(["REINSTALL=ALL", "REINSTALLMODE=amus"])
            .args(["/passive", "/norestart", "/l*v"])
            .arg(&repair_log_path)
            .status();
        success = matches!(
            result.as_ref().map(std::process::ExitStatus::code),
            Ok(Some(0 | 3010))
        );
        result_log_path = repair_log_path;
    }

    if !success {
        let code = result
            .ok()
            .and_then(|status| status.code())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "تعذّر تشغيل Windows Installer".to_string());
        show_update_error(&code, &result_log_path);
    }

    // Relaunch the app after msiexec releases the files. On failure this
    // deliberately returns the user to the existing installation.
    if app_path.exists() {
        if let Err(error) = std::process::Command::new(&app_path).spawn() {
            show_update_error(&format!("تعذّر فتح البرنامج: {error}"), &log_path);
        }
    }
}

#[cfg(target_os = "windows")]
fn show_update_error(error: &str, log_path: &std::path::Path) {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(
            window: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            kind: u32,
        ) -> i32;
    }

    let message = format!(
        "لم يكتمل تثبيت التحديث (رمز الخطأ: {error}).\nسيتم فتح النسخة الحالية. أرسل ملف السجل إلى الدعم:\n{}",
        log_path.display()
    );
    let to_wide = |value: &str| {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let message = to_wide(&message);
    let caption = to_wide("تحديث ZACOD POS");
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            caption.as_ptr(),
            0x0000_0010, // MB_ICONERROR
        );
    }
}

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
    let mut file = File::create(&dest).map_err(|e| format!("لا يمكن إنشاء ملف التنزيل: {}", e))?;
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

    // ── 3) Launch the MSI installer directly (Windows-only) ────────
    #[cfg(target_os = "windows")]
    {
        // Safety net: snapshot the local database into <data_root>/backups
        // BEFORE the installer replaces the app. That folder lives in %APPDATA%
        // which the MSI upgrade/uninstall never touches, so an update can never
        // lose data. Best-effort — a backup failure must NOT block the update.
        match crate::backup::pre_update_backup() {
            Ok(p) => log::info!("[updater] pre-update backup saved → {}", p),
            Err(e) => log::warn!("[updater] pre-update backup failed (continuing): {}", e),
        }

        // Spawn this same signed executable in helper mode. Unlike a short
        // fixed sleep, the helper waits for this process to exit, then waits
        // for Windows Installer's final exit code before restarting the app.
        let executable =
            std::env::current_exe().map_err(|e| format!("تعذّر تحديد ملف البرنامج: {}", e))?;
        let helper_path = std::env::temp_dir().join(format!(
            "zacod-pos-update-helper-{}.exe",
            std::process::id()
        ));
        std::fs::copy(&executable, &helper_path)
            .map_err(|e| format!("تعذّر تجهيز مساعد التحديث: {}", e))?;
        std::process::Command::new(&helper_path)
            .arg(UPDATE_HELPER_ARG)
            .arg(std::process::id().to_string())
            .arg(&dest)
            .arg(&executable)
            .spawn()
            .map_err(|e| {
                let _ = std::fs::remove_file(&helper_path);
                format!("تعذّر بدء مساعد التحديث: {}", e)
            })?;

        log::info!("[updater] update helper started; exiting app so MSI can replace files");

        // Let the UI receive the transition, then release the executable.
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            let _ = app2.emit("updater://exiting", ());
            std::thread::sleep(Duration::from_millis(200));
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
