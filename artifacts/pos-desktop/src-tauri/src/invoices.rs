// Persist offline-completed invoices in the `offline_invoices` table so they
// survive crashes/reboots and can be pushed to the cloud later by sync.rs.
//
// One write path:
//   save_offline_invoice(payload, qr_base64?, signed_xml?) → returns
//   { local_uuid, invoice_no } so the UI can render the receipt header.
//
// Two read paths for diagnostics + future sync push:
//   list_pending_invoices()  — sync_status = 'pending'
//   count_pending_invoices() — single int for status badge
//
// invoice_no scheme (offline phase): "OFF-<yymmdd>-<6-char-uuid-suffix>"
// — guaranteed unique per device, sortable, and obviously distinct from
// cloud-issued numbers. When the cloud push lands (Step 11) the server
// replaces it with the canonical range-assigned number and updates cloud_id.

use crate::db;
use anyhow::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SavedInvoice {
    pub local_uuid: String,
    pub invoice_no: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PendingInvoice {
    pub id: i64,
    pub local_uuid: String,
    pub invoice_no: String,
    pub qr_base64: Option<String>,
    pub created_at: String,
    pub sync_status: String,
    // "sale" | "return", parsed from the payload's `kind`. Both sales and
    // returns share the "OFF-" invoice_no prefix on a device, so the listing
    // UI can no longer classify them by prefix — this carries the truth.
    // None for the badge-poll path (list_pending) which doesn't load payloads.
    #[serde(default)]
    pub doc_type: Option<String>,
}

pub fn save(
    payload_json: &str,
    qr_base64: Option<&str>,
    signed_xml: Option<&str>,
    idempotency_key: Option<&str>,
) -> Result<SavedInvoice> {
    let conn = db::open()?;

    // Lazily add the UNIQUE constraints + idempotency column. db.rs is shared
    // scaffolding we don't modify; CREATE …  IF NOT EXISTS is a no-op on
    // subsequent runs so this is safe and idempotent itself.
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS uniq_offline_inv_no
            ON offline_invoices(invoice_no);
         CREATE UNIQUE INDEX IF NOT EXISTS uniq_offline_inv_idem
            ON offline_invoices(local_uuid);"
    )?;

    // ─── Idempotency: if the caller passes a key and we already have a row
    // for it, return that row instead of inserting a duplicate. This makes
    // checkout retries (e.g., print failed → user clicks again) safe.
    // We piggy-back on `local_uuid` (already UNIQUE in the schema) by using
    // the idempotency key as the row's local_uuid when provided.
    if let Some(key) = idempotency_key {
        let existing: Option<(String, String)> = conn.query_row(
            "SELECT local_uuid, invoice_no FROM offline_invoices WHERE local_uuid = ?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).ok();
        if let Some((u, n)) = existing {
            return Ok(SavedInvoice { local_uuid: u, invoice_no: n });
        }
    }

    let local_uuid = idempotency_key.map(String::from)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    // ─── invoice_no uniqueness: 10-hex-char suffix (40 bits) backed by
    // UNIQUE INDEX above, with a small retry loop on the off-chance of
    // collision. Birthday-bound across a single device is well past any
    // realistic daily volume; the index + retry are belt-and-braces.
    let date_part = Utc::now().format("%y%m%d").to_string();
    let mut last_err: Option<rusqlite::Error> = None;
    let mut saved: Option<(String, i64)> = None;
    for _ in 0..5 {
        let fresh = Uuid::new_v4().to_string().replace('-', "");
        let suffix: String = fresh.chars().take(10).collect::<String>().to_uppercase();
        let invoice_no = format!("OFF-{}-{}", date_part, suffix);
        match conn.execute(
            "INSERT INTO offline_invoices
               (local_uuid, invoice_no, payload_json, signed_xml, qr_base64, sync_status)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending')",
            rusqlite::params![local_uuid, invoice_no, payload_json, signed_xml, qr_base64],
        ) {
            Ok(_) => { saved = Some((invoice_no, conn.last_insert_rowid())); break; }
            Err(e) => {
                // Retry only on a constraint violation on invoice_no. Any
                // other error (incl. local_uuid clash when idempotency key
                // was NOT provided) is fatal.
                let is_unique = matches!(
                    e.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::ConstraintViolation)
                );
                if !is_unique { return Err(e.into()); }
                last_err = Some(e);
                continue;
            }
        }
    }
    let (invoice_no, invoice_id) = saved.ok_or_else(|| anyhow::anyhow!(
        "could not allocate unique invoice_no after 5 retries: {:?}", last_err
    ))?;

    // Release the SQLite write handle BEFORE the accounting pass — the JE opens
    // its own transaction and SQLite is single-writer, so an overlapping handle
    // would deadlock.
    drop(conn);

    // Device-local journal entry for this register sale/return. NON-FATAL by
    // design: the invoice is already durable, and a misconfigured chart of
    // accounts must never block a cashier. Cloud mode re-derives its OWN GL
    // entry from the synced invoice (sync push ships only offline_invoices,
    // never local JEs), so the device + cloud ledgers each count the sale once.
    if let Err(e) = crate::accounting::post_pos_invoice_je(payload_json, invoice_id, &invoice_no) {
        log::warn!("[pos-je] local JE skipped for {invoice_no}: {e}");
    }

    Ok(SavedInvoice { local_uuid, invoice_no })
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PendingInvoiceFull {
    pub id: i64,
    pub local_uuid: String,
    pub invoice_no: String,
    pub payload_json: String,
    pub qr_base64: Option<String>,
    pub signed_xml: Option<String>,
    pub created_at: String,
}

/// Read every pending row with the FULL payload so the sync engine can
/// ship it to the cloud. Split from `list_pending` (UI listing) to
/// avoid loading multi-KB payloads into the badge poll.
pub fn list_pending_full() -> Result<Vec<PendingInvoiceFull>> {
    let conn = db::open()?;
    let mut stmt = conn.prepare(
        "SELECT id, local_uuid, invoice_no, payload_json, qr_base64, signed_xml, created_at
         FROM offline_invoices
         WHERE sync_status = 'pending'
         ORDER BY id ASC
         LIMIT 500",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PendingInvoiceFull {
            id: r.get(0)?,
            local_uuid: r.get(1)?,
            invoice_no: r.get(2)?,
            payload_json: r.get(3)?,
            qr_base64: r.get(4)?,
            signed_xml: r.get(5)?,
            created_at: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn list_pending() -> Result<Vec<PendingInvoice>> {
    let conn = db::open()?;
    let mut stmt = conn.prepare(
        "SELECT id, local_uuid, invoice_no, qr_base64, created_at, sync_status
         FROM offline_invoices
         WHERE sync_status = 'pending'
         ORDER BY id DESC
         LIMIT 200",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PendingInvoice {
            id: r.get(0)?,
            local_uuid: r.get(1)?,
            invoice_no: r.get(2)?,
            qr_base64: r.get(3)?,
            created_at: r.get(4)?,
            sync_status: r.get(5)?,
            doc_type: None,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FullInvoice {
    pub id: i64,
    pub local_uuid: String,
    pub invoice_no: String,
    pub payload_json: String,
    pub qr_base64: Option<String>,
    pub signed_xml: Option<String>,
    pub created_at: String,
    pub sync_status: String,
}

pub fn get(id: i64) -> Result<Option<FullInvoice>> {
    let conn = db::open()?;
    let mut stmt = conn.prepare(
        "SELECT id, local_uuid, invoice_no, payload_json, qr_base64, signed_xml, created_at, sync_status
         FROM offline_invoices WHERE id = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query_map([id], |r| {
        Ok(FullInvoice {
            id: r.get(0)?,
            local_uuid: r.get(1)?,
            invoice_no: r.get(2)?,
            payload_json: r.get(3)?,
            qr_base64: r.get(4)?,
            signed_xml: r.get(5)?,
            created_at: r.get(6)?,
            sync_status: r.get(7)?,
        })
    })?;
    if let Some(r) = rows.next() { Ok(Some(r?)) } else { Ok(None) }
}

// Full history (pending + synced + returns). Used by the Returns screen
// to pick an original sale to refund against. Capped at `limit` rows so
// long-running devices don't pay a 10k-row deserialization cost.
pub fn list_all(limit: i64) -> Result<Vec<PendingInvoice>> {
    let conn = db::open()?;
    let mut stmt = conn.prepare(
        "SELECT id, local_uuid, invoice_no, qr_base64, created_at, sync_status, payload_json
         FROM offline_invoices
         ORDER BY id DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        // Classify sale vs return from the payload's `kind` (returns carry
        // `kind:"return"`). Default to "sale" when the payload is missing the
        // flag or fails to parse — the overwhelming majority are sales.
        let payload: String = r.get(6)?;
        let doc_type = serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|v| v.get("kind").and_then(|k| k.as_str()).map(|s| s.to_string()))
            .map(|k| if k == "return" { "return".to_string() } else { "sale".to_string() })
            .or_else(|| Some("sale".to_string()));
        Ok(PendingInvoice {
            id: r.get(0)?,
            local_uuid: r.get(1)?,
            invoice_no: r.get(2)?,
            qr_base64: r.get(3)?,
            created_at: r.get(4)?,
            sync_status: r.get(5)?,
            doc_type,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn count_pending() -> Result<i64> {
    let conn = db::open()?;
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM offline_invoices WHERE sync_status = 'pending'",
        [], |r| r.get(0),
    )?;
    Ok(n)
}

// Permanently delete a saved offline invoice (local row only). The POS invoice
// may already be ZATCA-signed/submitted; removing the local record does NOT
// un-submit it from ZATCA — it only clears the device-side history entry. The
// frontend confirms with the cashier before calling this.
pub fn delete_offline(id: i64) -> Result<()> {
    let conn = db::open()?;
    conn.execute("DELETE FROM offline_invoices WHERE id = ?1", [id])?;
    Ok(())
}

// ─── Tauri commands ──────────────────────────────────────────────────
#[tauri::command]
pub fn save_offline_invoice(
    payload_json: String,
    qr_base64: Option<String>,
    signed_xml: Option<String>,
    idempotency_key: Option<String>,
) -> Result<SavedInvoice, String> {
    save(
        &payload_json,
        qr_base64.as_deref(),
        signed_xml.as_deref(),
        idempotency_key.as_deref(),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_pending_invoices() -> Result<Vec<PendingInvoice>, String> {
    list_pending().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_offline_invoice(id: i64) -> Result<Option<FullInvoice>, String> {
    get(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn count_pending_invoices() -> Result<i64, String> {
    count_pending().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_offline_invoice(id: i64) -> Result<(), String> {
    delete_offline(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_all_invoices(limit: Option<i64>) -> Result<Vec<PendingInvoice>, String> {
    list_all(limit.unwrap_or(100)).map_err(|e| e.to_string())
}

// ─── Daily Z-Report support ──────────────────────────────────────────
// Returns full rows (incl. payload_json) for a calendar day, so the
// frontend can aggregate sales + returns + payment-mix + top items
// without paying a round-trip per invoice. Day boundary is taken from
// the `created_at` timestamp (UTC text as stored by SQLite — the UI
// displays in local time, but offline shifts rarely cross the UTC
// midnight in practice; if needed later we can switch to a session-id
// scope which is more semantically correct for a Z-report).

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DailyInvoiceRow {
    pub id: i64,
    pub local_uuid: String,
    pub invoice_no: String,
    pub payload_json: String,
    pub sync_status: String,
    pub created_at: String,
}

pub fn list_for_range(start_utc: &str, end_utc: &str) -> Result<Vec<DailyInvoiceRow>> {
    let conn = db::open()?;
    let mut stmt = conn.prepare(
        "SELECT id, local_uuid, invoice_no, payload_json, sync_status, created_at
         FROM offline_invoices
         WHERE created_at >= ?1 AND created_at < ?2
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([start_utc, end_utc], |r| Ok(DailyInvoiceRow {
        id: r.get(0)?,
        local_uuid: r.get(1)?,
        invoice_no: r.get(2)?,
        payload_json: r.get(3)?,
        sync_status: r.get(4)?,
        created_at: r.get(5)?,
    }))?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

// Frontend passes UTC ISO timestamps derived from the user's local-day
// boundaries, so an evening shift in UTC+3 doesn't bleed into the next
// UTC calendar day. SQLite text comparison works lexicographically on
// ISO-8601 strings, which is order-preserving when both endpoints share
// the same format ("YYYY-MM-DD HH:MM:SS" as written by CURRENT_TIMESTAMP).
#[tauri::command]
pub fn daily_report_invoices(start_utc: String, end_utc: String) -> Result<Vec<DailyInvoiceRow>, String> {
    list_for_range(&start_utc, &end_utc).map_err(|e| e.to_string())
}
