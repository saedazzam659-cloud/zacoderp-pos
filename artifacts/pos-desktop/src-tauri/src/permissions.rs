// Per-user screen permissions (Task #207).
// A row in user_permissions_local explicitly enables or disables a screen
// for one user. Absence means fall back to role defaults (computed in TS).

use crate::db;
use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserPermission {
    pub user_id: String,
    pub screen_key: String,
    pub can_view: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOverride {
    pub screen_key: String,
    pub can_view: bool,
}

#[tauri::command]
pub fn permissions_list_for_user(user_id: String) -> Result<Vec<UserPermission>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT user_id,screen_key,can_view FROM user_permissions_local WHERE user_id=?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([user_id], |r| {
            Ok(UserPermission {
                user_id: r.get(0)?,
                screen_key: r.get(1)?,
                can_view: r.get::<_, i64>(2)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn permissions_set(user_id: String, screen_key: String, can_view: bool) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO user_permissions_local(user_id,screen_key,can_view) VALUES(?1,?2,?3)
         ON CONFLICT(user_id,screen_key) DO UPDATE SET can_view=excluded.can_view",
        params![user_id, screen_key, if can_view { 1 } else { 0 }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn permissions_clear(user_id: String, screen_key: String) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM user_permissions_local WHERE user_id=?1 AND screen_key=?2",
        params![user_id, screen_key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn permissions_clear_all(user_id: String) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM user_permissions_local WHERE user_id=?1",
        params![user_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn permissions_replace_for_user(
    user_id: String,
    screen_keys: Vec<String>,
    overrides: Vec<PermissionOverride>,
) -> Result<(), String> {
    let mut conn = db::open().map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    // Replace only keys known to this UI. Older/future permission keys for
    // this user are left untouched so updating this app cannot erase them.
    for screen_key in &screen_keys {
        tx.execute(
            "DELETE FROM user_permissions_local WHERE user_id=?1 AND screen_key=?2",
            params![&user_id, screen_key],
        )
        .map_err(|e| e.to_string())?;
    }
    for permission in overrides {
        if !screen_keys.iter().any(|key| key == &permission.screen_key) {
            continue;
        }
        tx.execute(
            "INSERT INTO user_permissions_local(user_id,screen_key,can_view) VALUES(?1,?2,?3)
             ON CONFLICT(user_id,screen_key) DO UPDATE SET can_view=excluded.can_view",
            params![
                &user_id,
                &permission.screen_key,
                if permission.can_view { 1 } else { 0 }
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
