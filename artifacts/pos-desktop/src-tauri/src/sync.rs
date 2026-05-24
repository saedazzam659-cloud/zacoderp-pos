// Sync engine.
//
// Push side (Step 11 — landed):
//   - Reads every offline_invoices row with sync_status='pending'.
//   - Posts them in a single batched call to POST /api/sync/push as
//     `{ items: [{ clientId: local_uuid, entityType:"invoice",
//        operation:"create", payload:{...}, occurredAt }]}`.
//   - For each per-item ack with status in {"queued","ok","accepted",
//     "duplicate"}, marks the row as synced + records cloud_id if the
//     server returned one.
//   - Items the server rejected (e.g., schema error) stay 'pending' so
//     the next cycle retries; we also surface their count in the
//     summary so the UI can flag them.
//
// Pull/heartbeat are intentionally NOT wired here yet — the UI doesn't
// drive them today, and adding them without product requirements would
// be premature. They land alongside the catalog-refresh button in a
// later slice.

use crate::{db, invoices};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PushSummary {
    pub attempted: usize,
    pub synced: usize,
    pub failed: usize,
    pub server_time: Option<String>,
}

#[derive(Deserialize, Debug)]
struct PushAck {
    #[serde(rename = "clientId")]
    client_id: String,
    status: String,
    #[serde(rename = "cloudId")]
    cloud_id: Option<i64>,
}

#[derive(Deserialize, Debug)]
struct PushResponse {
    #[serde(default)]
    acks: Vec<PushAck>,
    #[serde(rename = "serverTime", default)]
    server_time: Option<String>,
}

pub async fn push_pending_invoices(server_url: &str, device_token: &str) -> Result<PushSummary> {
    let pending = invoices::list_pending_full().context("read pending invoices")?;
    if pending.is_empty() {
        return Ok(PushSummary { attempted: 0, synced: 0, failed: 0, server_time: None });
    }

    let items: Vec<_> = pending
        .iter()
        .map(|p| {
            // payload_json is opaque text we stored at checkout time. We
            // wrap it as a parsed object if possible so the server gets a
            // real JSON shape (the server uses `z.record` so a stringified
            // payload would fail validation).
            let payload_obj: serde_json::Value = serde_json::from_str(&p.payload_json)
                .unwrap_or_else(|_| json!({ "raw": &p.payload_json }));
            // `occurredAt` is server-validated as z.string().datetime()
            // (RFC3339). Our SQLite `created_at` default is the SQLite
            // CURRENT_TIMESTAMP format ("YYYY-MM-DD HH:MM:SS") which is
            // NOT RFC3339, so try to parse + reformat; fall back to
            // omitting the field on failure (it's optional server-side).
            let occurred_at_rfc3339: Option<String> = chrono::NaiveDateTime::parse_from_str(
                &p.created_at, "%Y-%m-%d %H:%M:%S",
            )
            .ok()
            .map(|ndt| ndt.and_utc().to_rfc3339())
            .or_else(|| {
                // Already-RFC3339 strings (newer rows we write ourselves later)
                // round-trip through DateTime parse just to validate shape.
                chrono::DateTime::parse_from_rfc3339(&p.created_at)
                    .ok()
                    .map(|dt| dt.to_rfc3339())
            });
            let mut item = json!({
                "clientId": &p.local_uuid,
                "entityType": "invoice",
                "operation": "create",
                "payload": {
                    "invoiceNo": &p.invoice_no,
                    "qrBase64": &p.qr_base64,
                    "signedXml": &p.signed_xml,
                    "data": payload_obj,
                },
            });
            if let Some(ts) = occurred_at_rfc3339 {
                item["occurredAt"] = json!(ts);
            }
            item
        })
        .collect();

    let url = format!("{}/api/sync/push", server_url.trim_end_matches('/'));
    // Server `deviceAuth` reads from `X-Device-Token` header, NOT
    // `Authorization: Bearer`. Using bearer_auth here would silently
    // 401 with a valid token.
    let resp = reqwest::Client::new()
        .post(&url)
        .header("X-Device-Token", device_token)
        .json(&json!({ "items": items }))
        .send()
        .await
        .context("POST /api/sync/push")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("sync push failed: HTTP {status} — {body}");
    }
    let parsed: PushResponse = resp.json().await.context("decode push response")?;

    // Mark per-ack success inside a single transaction so a crash
    // mid-loop doesn't leave half the batch in an inconsistent state.
    let mut conn = db::open()?;
    let tx = conn.transaction()?;
    let mut synced = 0usize;
    let mut explicit_failed = 0usize;
    let mut acked_ids = std::collections::HashSet::new();
    for ack in &parsed.acks {
        acked_ids.insert(ack.client_id.clone());
        let ok = matches!(ack.status.as_str(), "queued" | "ok" | "accepted" | "duplicate");
        if !ok {
            explicit_failed += 1;
            log::warn!("sync push ack rejected: {} → {}", ack.client_id, ack.status);
            continue;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let updated = tx.execute(
            "UPDATE offline_invoices
             SET sync_status = 'synced',
                 synced_at   = ?2,
                 cloud_id    = COALESCE(?3, cloud_id)
             WHERE local_uuid = ?1 AND sync_status = 'pending'",
            rusqlite::params![ack.client_id, now, ack.cloud_id],
        )?;
        if updated > 0 {
            synced += 1;
        }
    }
    tx.commit()?;

    // "failed" = explicit negative acks + any items we sent that the
    // server didn't ack at all (silent drop). Both stay 'pending' and
    // will be retried on the next push.
    let unacked = pending.iter().filter(|p| !acked_ids.contains(&p.local_uuid)).count();
    let failed = explicit_failed + unacked;
    if unacked > 0 {
        log::warn!("sync push: {unacked} item(s) sent but not acked — staying pending for retry");
    }

    Ok(PushSummary {
        attempted: pending.len(),
        synced,
        failed,
        server_time: parsed.server_time,
    })
}

// ─── Tauri commands ──────────────────────────────────────────────────
#[tauri::command]
pub async fn sync_push_now(server_url: String, device_token: String) -> Result<PushSummary, String> {
    push_pending_invoices(&server_url, &device_token)
        .await
        .map_err(|e| e.to_string())
}
