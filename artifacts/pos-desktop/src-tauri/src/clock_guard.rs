// Clock-rollback guard — encrypted, machine-bound redundant time store.
//
// The actual monotonic-time logic (high-water-mark merge, backward-clock
// detection, Ed25519 unlock-code verification, online-unblock pickup) lives in
// TypeScript (`src/lib/clockGuard.ts`) so it can reuse the SAME @noble/ed25519
// verify path and pinned public key the offline-license loader already uses.
// Rust owns ONE thing the webview cannot: a tamper-resistant, machine-bound
// ENCRYPTED file that survives even if the SQLite `app_settings` row is wiped.
//
// The TS layer keeps the guard state (high-water-mark + lock flag + nonce) in
// THREE redundant stores — SQLite `app_settings`, this encrypted file, and
// (dev only) localStorage — and merges them by taking the MAX high-water-mark
// and OR-ing the lock flag, so an attacker has to defeat every copy at once.

use std::fs;
use std::path::PathBuf;

fn guard_file_path() -> PathBuf {
    // Same base dir as the SQLite DB (`db::db_path`), under a `guard/` subdir.
    let mut p = dirs::data_dir().expect("no data dir");
    p.push("com.zacoderp.pos");
    p.push("guard");
    std::fs::create_dir_all(&p).ok();
    p.push("clock_guard.bin");
    p
}

/// Returns the decrypted guard-state JSON blob, or `None` if no file exists yet.
/// Decryption is machine-bound (AES-256-GCM, key = SHA256 of the hardware
/// fingerprint), so a file copied from another machine fails closed (`Err`),
/// which the TS layer treats as "this store is unavailable" (the other stores
/// win the merge).
#[tauri::command]
pub fn clock_guard_file_read() -> Result<Option<String>, String> {
    let path = guard_file_path();
    if !path.exists() {
        return Ok(None);
    }
    let stored = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if stored.trim().is_empty() {
        return Ok(None);
    }
    let plain = crate::zatca::zatca_decrypt(stored.trim())?;
    Ok(Some(plain))
}

/// Encrypts and writes the guard-state JSON blob to the machine-bound file.
#[tauri::command]
pub fn clock_guard_file_write(blob: String) -> Result<(), String> {
    let path = guard_file_path();
    let enc = crate::zatca::zatca_encrypt(&blob)?;
    fs::write(&path, enc).map_err(|e| e.to_string())?;
    Ok(())
}
