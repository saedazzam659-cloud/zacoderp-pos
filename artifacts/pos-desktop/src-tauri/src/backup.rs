// Local database backup / restore + scheduled auto-backup.
//
// The offline POS database is a single SQLite file (see db::db_path). Because
// every Rust command opens its OWN short-lived connection (db::open) there is
// no long-held writer to coordinate with — a backup just needs to flush the
// WAL into the main file (a TRUNCATE checkpoint) and copy the file.
//
// Restore copies a chosen .db OVER the live file and deletes any stale -wal /
// -shm sidecars; the user is told to restart so the React layer reloads from
// the new contents.
//
// Auto-backup runs from a background thread started in main.rs::setup. It is a
// best-effort "once per day, after the scheduled time, while the app is open"
// policy — it CANNOT run while the app is closed (documented for the user).

use crate::db;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupSettings {
    pub auto_enabled: bool,
    pub auto_time: String,      // "HH:MM" 24h local time
    pub backup_dir: String,     // folder for auto backups ("" = not chosen yet)
    pub last_backup_at: String, // ISO-8601 ("" = never)
    pub data_dir: String,       // current EFFECTIVE data root (display only)
    pub default_data_dir: String,
    pub is_custom_data_dir: bool,
}

// Flush the WAL into the main db file so a plain copy is a complete snapshot.
fn checkpoint() -> Result<()> {
    let conn = db::open()?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

fn remove_sidecars(db_file: &std::path::Path) {
    let base = db_file.display().to_string();
    let _ = std::fs::remove_file(format!("{base}-wal"));
    let _ = std::fs::remove_file(format!("{base}-shm"));
}

fn settings() -> Result<BackupSettings> {
    let conn = db::open()?;
    let effective = db::data_root();
    let default = db::default_data_root();
    Ok(BackupSettings {
        auto_enabled: db::get_config(&conn, "backup_auto_enabled")?.as_deref() == Some("1"),
        auto_time: db::get_config(&conn, "backup_auto_time")?.unwrap_or_else(|| "23:00".to_string()),
        backup_dir: db::get_config(&conn, "backup_dir")?.unwrap_or_default(),
        last_backup_at: db::get_config(&conn, "backup_last_at")?.unwrap_or_default(),
        is_custom_data_dir: effective != default,
        data_dir: effective.to_string_lossy().to_string(),
        default_data_dir: default.to_string_lossy().to_string(),
    })
}

// Copy the live db into `dir` with a timestamped name; records last_backup_at.
pub fn backup_to_dir(dir: &str) -> Result<String> {
    checkpoint()?;
    std::fs::create_dir_all(dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut dest = PathBuf::from(dir);
    dest.push(format!("pos-backup-{stamp}.db"));
    std::fs::copy(db::db_path(), &dest)?;
    let conn = db::open()?;
    db::set_config(&conn, "backup_last_at", &chrono::Local::now().to_rfc3339())?;
    Ok(dest.to_string_lossy().to_string())
}

// Safety snapshot taken automatically right before an in-app update installs.
// It lands in a FIXED folder INSIDE the data root (`<data_root>/backups`), which
// the MSI uninstall/upgrade never touches, so the user can always recover their
// data after an update — even if something goes wrong with the installer.
// Keeps only the most recent PRE_UPDATE_KEEP snapshots. Callers treat the Err as
// non-fatal: a backup failure must NEVER block the update.
pub fn pre_update_backup() -> Result<String> {
    checkpoint()?;
    let mut dir = db::data_root();
    dir.push("backups");
    std::fs::create_dir_all(&dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut dest = dir.clone();
    dest.push(format!("pre-update-{stamp}.db"));
    std::fs::copy(db::db_path(), &dest)?;
    prune_pre_update_backups(&dir);
    Ok(dest.to_string_lossy().to_string())
}

// Keep the newest PRE_UPDATE_KEEP `pre-update-*.db` snapshots; delete the rest.
// Names are zero-padded `YYYYMMDD-HHMMSS`, so a lexical sort is chronological.
fn prune_pre_update_backups(dir: &std::path::Path) {
    const PRE_UPDATE_KEEP: usize = 10;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("pre-update-") && n.ends_with(".db"))
                .unwrap_or(false)
        })
        .collect();
    if files.len() <= PRE_UPDATE_KEEP {
        return;
    }
    files.sort();
    let remove = files.len() - PRE_UPDATE_KEEP;
    for p in files.into_iter().take(remove) {
        let _ = std::fs::remove_file(p);
    }
}

fn restore_from(src: &str) -> Result<()> {
    let dest = db::db_path();
    // Drop sidecars FIRST so a stale WAL can't re-overlay the old data after copy.
    remove_sidecars(&dest);
    std::fs::copy(src, &dest)?;
    remove_sidecars(&dest);
    Ok(())
}

// Best-effort daily auto-backup. Returns the written path when it actually ran.
pub fn maybe_auto_backup() -> Result<Option<String>> {
    let conn = db::open()?;
    if db::get_config(&conn, "backup_auto_enabled")?.as_deref() != Some("1") {
        return Ok(None);
    }
    let dir = db::get_config(&conn, "backup_dir")?.unwrap_or_default();
    if dir.trim().is_empty() {
        return Ok(None);
    }
    let time = db::get_config(&conn, "backup_auto_time")?.unwrap_or_else(|| "23:00".to_string());
    let last = db::get_config(&conn, "backup_last_at")?.unwrap_or_default();
    let now = chrono::Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    // Already backed up today → done.
    if last.starts_with(&today) {
        return Ok(None);
    }
    // Not yet past the scheduled HH:MM (lexical compare is valid for zero-padded 24h).
    if now.format("%H:%M").to_string().as_str() < time.as_str() {
        return Ok(None);
    }
    drop(conn);
    let path = backup_to_dir(dir.trim())?;
    Ok(Some(path))
}

// ── Tauri commands ───────────────────────────────────────────────────────

#[tauri::command]
pub fn backup_get_settings() -> Result<BackupSettings, String> {
    settings().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn backup_set_settings(
    auto_enabled: bool,
    auto_time: String,
    backup_dir: String,
) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    db::set_config(&conn, "backup_auto_enabled", if auto_enabled { "1" } else { "0" })
        .map_err(|e| e.to_string())?;
    db::set_config(&conn, "backup_auto_time", auto_time.trim())
        .map_err(|e| e.to_string())?;
    db::set_config(&conn, "backup_dir", backup_dir.trim())
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Run a backup immediately into the configured auto-backup folder.
#[tauri::command]
pub fn backup_run_now() -> Result<String, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let dir = db::get_config(&conn, "backup_dir")
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if dir.trim().is_empty() {
        return Err("لم يتم اختيار مجلد النسخ الاحتياطي بعد".to_string());
    }
    drop(conn);
    backup_to_dir(dir.trim()).map_err(|e| e.to_string())
}

// "Save As" export: native dialog → copy db to the chosen path. None = cancelled.
#[tauri::command]
pub async fn backup_export(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("نسخة احتياطية", &["db"])
        .set_file_name(&format!("pos-backup-{stamp}.db"))
        .save_file(move |fp| {
            let _ = tx.send(fp);
        });
    let chosen = rx.await.map_err(|e| e.to_string())?;
    let Some(fp) = chosen else { return Ok(None); };
    let path: PathBuf = fp.into_path().map_err(|e| e.to_string())?;
    checkpoint().map_err(|e| e.to_string())?;
    std::fs::copy(db::db_path(), &path).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// Import/restore: native open dialog → copy chosen file OVER the live db.
#[tauri::command]
pub async fn backup_import(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("قاعدة بيانات", &["db"])
        .pick_file(move |fp| {
            let _ = tx.send(fp);
        });
    let chosen = rx.await.map_err(|e| e.to_string())?;
    let Some(fp) = chosen else { return Ok(None); };
    let path: PathBuf = fp.into_path().map_err(|e| e.to_string())?;
    restore_from(&path.to_string_lossy()).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// Native folder picker (used for both the auto-backup folder and the data dir).
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |fp| {
        let _ = tx.send(fp);
    });
    let chosen = rx.await.map_err(|e| e.to_string())?;
    match chosen {
        Some(fp) => Ok(Some(
            fp.into_path()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string(),
        )),
        None => Ok(None),
    }
}

// Relocate the data folder. ORDER IS CRITICAL: the pointer is committed LAST,
// only after the db file has been safely copied to the destination. If anything
// fails mid-way we leave the pointer untouched so the app keeps opening the
// ORIGINAL database (never strands the user on an empty/new db). Pass an empty
// string to revert to the default location. Returns the new db path.
#[tauri::command]
pub fn data_dir_set(dir: Option<String>) -> Result<String, String> {
    // Flush into the CURRENT (old) db FIRST, while the pointer still resolves
    // to the existing location, so the snapshot we copy is complete.
    checkpoint().map_err(|e| e.to_string())?;
    let old = db::db_path();

    // Resolve the destination WITHOUT touching the pointer yet.
    let normalized = dir.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let new_root: PathBuf = match normalized {
        Some(d) => PathBuf::from(d),
        None => db::default_data_root(),
    };
    let new = new_root.join("pos.db");

    // No-op when the location is unchanged: just (re)write the pointer to match.
    if old == new {
        db::set_data_dir_override(normalized).map_err(|e| e.to_string())?;
        return Ok(new.to_string_lossy().to_string());
    }

    std::fs::create_dir_all(&new_root).map_err(|e| e.to_string())?;

    // Copy the db into place BEFORE committing the pointer. Only copy when the
    // source exists and we won't clobber a db already at the destination (e.g.
    // the user pointed at a folder that already holds a database). If the copy
    // fails the pointer is still untouched, so the app stays on the old db.
    let copied = old.exists() && !new.exists();
    if copied {
        std::fs::copy(&old, &new).map_err(|e| e.to_string())?;
    }

    // Commit the pointer LAST — this is the only irreversible step, and by now
    // the destination is guaranteed to hold a usable database.
    db::set_data_dir_override(normalized).map_err(|e| {
        // Pointer write failed after a successful copy: roll the copy back so we
        // don't leave an orphaned half-migrated file at the destination.
        if copied {
            let _ = std::fs::remove_file(&new);
        }
        e.to_string()
    })?;

    // Pointer is committed and the new db is in place — safe to remove the old
    // file now (best-effort; a leftover old file is harmless).
    if copied {
        let _ = std::fs::remove_file(&old);
        remove_sidecars(&old);
    }
    Ok(new.to_string_lossy().to_string())
}
