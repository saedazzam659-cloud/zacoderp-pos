// Standalone-mode local store (Task #199).
//
// Persists app mode + license file + local users + login session in the
// existing SQLite database (`pos.db` under `%APPDATA%`). bcrypt cost 12
// for password hashing. The whole module is offline-only — it makes no
// network calls and never reads anything cloud-related.

use crate::db;
use anyhow::Result;
use bcrypt::{hash, verify, DEFAULT_COST};
use rusqlite::params;
use serde::{Deserialize, Serialize};

const SESSION_KEY: &str = "standalone_session";
const MODE_KEY: &str = "app_mode";

// ── Generic app_settings get/set (Task #200) ─────────────────────────
// Used by both cloud and standalone modes to persist UI preferences like
// the selected vertical (grocery/pharmacy/general). Keys are prefixed
// "ui_" by callers so they cannot collide with internal mode/session keys.
#[tauri::command]
pub fn standalone_get_setting(key: String) -> Result<Option<String>, String> {
    if key == MODE_KEY || key == SESSION_KEY {
        return Err("reserved key".to_string());
    }
    settings_get(&key).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn standalone_set_setting(key: String, value: String) -> Result<(), String> {
    if key == MODE_KEY || key == SESSION_KEY {
        return Err("reserved key".to_string());
    }
    settings_set(&key, &value).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LocalUser {
    pub id: String,
    pub username: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub role: String, // "admin" | "cashier"
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastLoginAt")]
    pub last_login_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LocalSession {
    #[serde(rename = "userId")]
    pub user_id: String,
    pub username: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub role: String,
    #[serde(rename = "signedInAt")]
    pub signed_in_at: String,
}

fn now_iso() -> String { chrono::Utc::now().to_rfc3339() }

// ── app_settings helpers ─────────────────────────────────────────────
fn settings_get(key: &str) -> Result<Option<String>> {
    let conn = db::open()?;
    let v: Option<String> = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |r| r.get(0))
        .ok();
    Ok(v)
}
fn settings_set(key: &str, value: &str) -> Result<()> {
    let conn = db::open()?;
    conn.execute(
        "INSERT INTO app_settings(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}
fn settings_del(key: &str) -> Result<()> {
    let conn = db::open()?;
    conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
    Ok(())
}

// ── App mode ─────────────────────────────────────────────────────────
#[tauri::command]
pub fn standalone_get_mode() -> Result<Option<String>, String> {
    settings_get(MODE_KEY).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn standalone_set_mode(mode: String) -> Result<(), String> {
    if mode != "cloud" && mode != "standalone" {
        return Err(format!("invalid mode '{mode}'"));
    }
    // Mode is write-once. Switching modes requires standalone_wipe_all first
    // (which clears MODE_KEY along with everything else). Without this guard
    // a malicious caller could flip "cloud → standalone" mid-session and
    // hide cloud-mode data inside a standalone-looking shell.
    if let Some(existing) = settings_get(MODE_KEY).map_err(|e| e.to_string())? {
        if existing == mode { return Ok(()); }
        return Err(format!(
            "وضع التطبيق مثبّت مسبقاً على '{existing}'. للتبديل يجب تنفيذ مسح كامل من شاشة الإعدادات."
        ));
    }
    settings_set(MODE_KEY, &mode).map_err(|e| e.to_string())
}

// ── License ──────────────────────────────────────────────────────────
#[tauri::command]
pub fn standalone_load_license() -> Result<Option<String>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let v: Option<String> = conn
        .query_row("SELECT file_json FROM local_license WHERE id = 1", [], |r| r.get(0))
        .ok();
    Ok(v)
}
#[tauri::command]
pub fn standalone_save_license(file_json: String) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO local_license(id,file_json,installed_at) VALUES(1,?1,?2)
         ON CONFLICT(id) DO UPDATE SET file_json=excluded.file_json, installed_at=excluded.installed_at",
        params![file_json, now_iso()],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Users ────────────────────────────────────────────────────────────
fn row_to_user(r: &rusqlite::Row<'_>) -> rusqlite::Result<LocalUser> {
    Ok(LocalUser {
        id: r.get(0)?,
        username: r.get(1)?,
        display_name: r.get(2)?,
        role: r.get(3)?,
        created_at: r.get(4)?,
        last_login_at: r.get(5)?,
    })
}

#[tauri::command]
pub fn standalone_list_users() -> Result<Vec<LocalUser>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,username,display_name,role,created_at,last_login_at FROM local_users ORDER BY created_at ASC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_user).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows { out.push(r.map_err(|e| e.to_string())?); }
    Ok(out)
}

#[tauri::command]
pub fn standalone_create_user(
    id: String, username: String, display_name: String, password: String, role: String,
) -> Result<LocalUser, String> {
    if role != "admin" && role != "cashier" { return Err("invalid role".into()); }
    let hash = hash(&password, DEFAULT_COST).map_err(|e| e.to_string())?;
    let created_at = now_iso();
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO local_users(id,username,display_name,role,password_hash,created_at,last_login_at)
         VALUES(?1,?2,?3,?4,?5,?6,NULL)",
        params![id, username, display_name, role, hash, created_at],
    ).map_err(|e| {
        let s = e.to_string();
        if s.contains("UNIQUE") { "اسم المستخدم موجود مسبقاً".to_string() } else { s }
    })?;
    Ok(LocalUser {
        id, username, display_name, role,
        created_at, last_login_at: None,
    })
}

#[tauri::command]
pub fn standalone_auth_user(username: String, password: String) -> Result<LocalSession, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let row = conn.query_row(
        "SELECT id,username,display_name,role,password_hash FROM local_users WHERE username = ?1",
        params![username.trim().to_lowercase()],
        |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
            r.get::<_, String>(3)?, r.get::<_, String>(4)?,
        )),
    );
    let (id, uname, display, role, ph) = match row {
        Ok(t) => t,
        Err(_) => return Err("اسم مستخدم أو كلمة مرور غير صحيحة".to_string()),
    };
    let ok = verify(&password, &ph).map_err(|e| e.to_string())?;
    if !ok { return Err("اسم مستخدم أو كلمة مرور غير صحيحة".to_string()); }
    let now = now_iso();
    let _ = conn.execute("UPDATE local_users SET last_login_at = ?1 WHERE id = ?2", params![now, id]);
    let session = LocalSession {
        user_id: id, username: uname, display_name: display, role,
        signed_in_at: now,
    };
    let json = serde_json::to_string(&session).map_err(|e| e.to_string())?;
    settings_set(SESSION_KEY, &json).map_err(|e| e.to_string())?;
    Ok(session)
}

/// Verify an admin's credentials WITHOUT touching the active session — used
/// by the pharmacy-vertical expired-medicine sale override flow so the
/// cashier remains signed in after the supervisor authorizes the bypass.
/// Returns Ok(true) only when the row exists, password matches, and role
/// is "admin". Any other case returns Ok(false) with a generic error so we
/// don't leak username existence.
#[tauri::command]
pub fn standalone_verify_admin(username: String, password: String) -> Result<bool, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let row = conn.query_row(
        "SELECT role, password_hash FROM local_users WHERE username = ?1",
        params![username.trim().to_lowercase()],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    );
    let (role, ph) = match row { Ok(t) => t, Err(_) => return Ok(false) };
    if role != "admin" { return Ok(false); }
    Ok(verify(&password, &ph).unwrap_or(false))
}

#[tauri::command]
pub fn standalone_load_session() -> Result<Option<LocalSession>, String> {
    let raw = settings_get(SESSION_KEY).map_err(|e| e.to_string())?;
    let Some(raw) = raw else { return Ok(None); };
    let sess: LocalSession = match serde_json::from_str(&raw) {
        Ok(s) => s, Err(_) => { let _ = settings_del(SESSION_KEY); return Ok(None); }
    };
    // Re-validate against users table (blocks stale session for a deleted user)
    let conn = db::open().map_err(|e| e.to_string())?;
    let exists: Option<(String, String)> = conn.query_row(
        "SELECT username, role FROM local_users WHERE id = ?1",
        params![sess.user_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    ).ok();
    match exists {
        Some((u, r)) if u == sess.username && r == sess.role => Ok(Some(sess)),
        _ => { let _ = settings_del(SESSION_KEY); Ok(None) }
    }
}
#[tauri::command]
pub fn standalone_clear_session() -> Result<(), String> {
    settings_del(SESSION_KEY).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn standalone_delete_user(id: String) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM local_users WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn standalone_change_password(id: String, new_password: String) -> Result<(), String> {
    if new_password.len() < 4 { return Err("كلمة المرور قصيرة جداً".into()); }
    let hash = hash(&new_password, DEFAULT_COST).map_err(|e| e.to_string())?;
    let conn = db::open().map_err(|e| e.to_string())?;
    let n = conn.execute(
        "UPDATE local_users SET password_hash = ?1 WHERE id = ?2",
        params![hash, id],
    ).map_err(|e| e.to_string())?;
    if n == 0 { return Err("المستخدم غير موجود".into()); }
    Ok(())
}

/// Drop every standalone row + the entire SQLite database file is left
/// intact, but the three standalone tables are emptied. We also wipe the
/// catalog/offline tables so a "switch back to cloud" doesn't leak prior
/// data into the new tree.
#[tauri::command]
pub fn standalone_wipe_all() -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        DELETE FROM local_users;
        DELETE FROM local_license;
        DELETE FROM app_settings;
        DELETE FROM parked_carts;
        DELETE FROM offline_invoices;
        DELETE FROM customers_local;
        DELETE FROM items_local;
        "#,
    ).map_err(|e| e.to_string())?;
    Ok(())
}
