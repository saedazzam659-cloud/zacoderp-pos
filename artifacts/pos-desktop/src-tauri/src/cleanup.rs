// Old-version cleanup — removes leftover side-by-side ZACOD POS installs.
//
// WHY: Windows Installer only auto-replaces a prior install when the new MSI
// carries the SAME UpgradeCode. Builds produced before the UpgradeCode was
// pinned (≤ 0.8.19) used Tauri's auto-derived code, so a freshly pinned 0.8.20
// MSI installs ALONGSIDE them instead of upgrading — two "ZACOD POS" entries
// in Programs & Features, the classic install conflict the user hit.
//
// This module enumerates the Windows uninstall registry, finds every installed
// "ZACOD POS" whose version differs from the one CURRENTLY RUNNING, and
// silently uninstalls it via `msiexec /x {ProductCode} /quiet /norestart`.
//
// It runs at STARTUP, which is the safe moment: the live process is the new
// version, so we only ever remove the *obsolete* side-by-side copies (never
// ourselves), and there are no locked-file races because the old binaries are
// not running. Uninstalls run sequentially and we WAIT on each one — the
// Windows Installer service is a single global mutex, so spawning several at
// once would just collide with error 1618. Anything we miss (e.g. installer
// busy right after the upgrade) is retried the next launch, so it converges.

#[derive(Clone, serde::Serialize)]
pub struct RemovedVersion {
    pub name: String,
    pub version: String,
    pub product_code: String,
    pub uninstalled: bool,
}

#[cfg(target_os = "windows")]
pub fn find_and_remove_old_versions(current_version: &str) -> Result<Vec<RemovedVersion>, String> {
    use winreg::enums::*;
    use winreg::RegKey;

    // True only when `installed` is a STRICTLY older numeric version than
    // `current` ("0.8.19" < "0.8.20"). Removing only older builds means a
    // newer/equal coexisting install can never be uninstalled by mistake.
    fn is_older(installed: &str, current: &str) -> bool {
        fn parts(v: &str) -> Vec<u64> {
            v.split(|c: char| !c.is_ascii_digit())
                .filter(|s| !s.is_empty())
                .filter_map(|s| s.parse::<u64>().ok())
                .collect()
        }
        let a = parts(installed);
        let b = parts(current);
        for i in 0..a.len().max(b.len()) {
            let x = a.get(i).copied().unwrap_or(0);
            let y = b.get(i).copied().unwrap_or(0);
            if x != y {
                return x < y;
            }
        }
        false
    }

    // Both registry views (64-bit + WOW6432Node) plus per-user installs.
    let roots = [
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            HKEY_CURRENT_USER,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
    ];

    let mut targets: Vec<RemovedVersion> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (root, path) in roots.iter() {
        let hk = RegKey::predef(*root);
        let uninstall = match hk.open_subkey_with_flags(*path, KEY_READ) {
            Ok(k) => k,
            Err(_) => continue,
        };
        for sub_name in uninstall.enum_keys().filter_map(|r| r.ok()) {
            let entry = match uninstall.open_subkey_with_flags(&sub_name, KEY_READ) {
                Ok(k) => k,
                Err(_) => continue,
            };
            let display_name: String = entry.get_value("DisplayName").unwrap_or_default();
            let publisher: String = entry.get_value("Publisher").unwrap_or_default();
            let dn_lower = display_name.to_lowercase();
            // Identify our product: by name, or ZACOD publisher + a POS name.
            let is_ours = dn_lower.contains("zacod pos")
                || (publisher.trim().eq_ignore_ascii_case("zacod") && dn_lower.contains("pos"));
            if !is_ours {
                continue;
            }
            let version: String = entry.get_value("DisplayVersion").unwrap_or_default();
            // Only remove STRICTLY older installs — never the live/equal version
            // and never a newer coexisting build.
            if !is_older(version.trim(), current_version.trim()) {
                continue;
            }
            // Prefer an explicit ProductCode; for an MSI the subkey name IS the
            // product GUID, so fall back to that.
            let product_code = entry
                .get_value::<String, _>("ProductCode")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| sub_name.clone());
            let pc = product_code.trim().to_string();
            // Only act on MSI GUID product codes ({...}); skip EXE/other entries
            // we don't know how to silently uninstall safely.
            if !(pc.starts_with('{') && pc.ends_with('}')) {
                continue;
            }
            if seen.insert(pc.to_uppercase()) {
                targets.push(RemovedVersion {
                    name: if display_name.is_empty() {
                        "ZACOD POS".to_string()
                    } else {
                        display_name
                    },
                    version: version.trim().to_string(),
                    product_code: pc,
                    uninstalled: false,
                });
            }
        }
    }

    let mut results: Vec<RemovedVersion> = Vec::new();
    for mut t in targets {
        log::info!(
            "[cleanup] removing old install {} v{} ({})",
            t.name,
            t.version,
            t.product_code
        );
        // Sequential + wait: Windows Installer is a global mutex.
        match std::process::Command::new("msiexec")
            .args(["/x", &t.product_code, "/quiet", "/norestart"])
            .status()
        {
            Ok(s) if s.success() => {
                t.uninstalled = true;
            }
            Ok(s) => {
                // 1618 = another install in progress; will retry next launch.
                log::warn!(
                    "[cleanup] uninstall {} exited with {:?} (will retry next launch)",
                    t.product_code,
                    s.code()
                );
            }
            Err(e) => {
                log::warn!("[cleanup] failed to launch uninstall for {}: {}", t.product_code, e);
            }
        }
        results.push(t);
    }
    Ok(results)
}

#[cfg(not(target_os = "windows"))]
pub fn find_and_remove_old_versions(_current_version: &str) -> Result<Vec<RemovedVersion>, String> {
    // No-op off Windows so the crate still type-checks on Linux/macOS CI.
    Ok(Vec::new())
}

/// Tauri command — lets the UI trigger a manual cleanup and report what was
/// removed. Compares against the running build's compile-time version.
#[tauri::command]
pub fn cleanup_old_versions() -> Result<Vec<RemovedVersion>, String> {
    find_and_remove_old_versions(env!("CARGO_PKG_VERSION"))
}
