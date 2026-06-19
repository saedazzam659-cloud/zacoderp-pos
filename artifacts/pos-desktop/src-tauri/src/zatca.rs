// ZATCA TLV (Tag-Length-Value) QR code generator — Rust port.
//
// Mirrors `artifacts/api-server/src/lib/zatca-tlv.ts` byte-for-byte so an
// invoice signed locally on the desktop produces the SAME QR string the
// cloud would have produced for the same input. This is essential for
// offline-signed invoices to verify correctly against the ZATCA portal
// once uploaded.
//
// ZATCA Phase 1 QR (Annex B) tags:
//   1 - Seller Name              (UTF-8 string)
//   2 - VAT Registration Number  (15 digits)
//   3 - Invoice Timestamp        (ISO 8601 e.g. "2026-05-24T22:32:20Z")
//   4 - Invoice Total (with VAT) (decimal string e.g. "115.00")
//   5 - VAT Amount               (decimal string e.g. "15.00")
//
// Phase 2 adds tags 6-9 (invoice hash, signature, public key, sig timestamp)
// — those land with the XAdES signer port (separate file).
//
// Length byte uses the single-byte short form per ZATCA spec. Values >255
// bytes (only realistic for tag 1 with very long Arabic seller names) get
// truncated at the call site — we panic in debug, silently truncate in
// release, matching the TS behavior of relying on Node's Buffer overflow
// semantics (which also produce an invalid TLV beyond 255).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use crate::db;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Encodes a single (tag, value) pair as a TLV byte sequence.
fn encode_tlv(tag: u8, value: &str) -> Vec<u8> {
    let value_bytes = value.as_bytes();
    debug_assert!(
        value_bytes.len() <= u8::MAX as usize,
        "TLV value for tag {} exceeds 255 bytes ({}); ZATCA single-byte length is too small",
        tag,
        value_bytes.len()
    );
    let len = value_bytes.len().min(u8::MAX as usize) as u8;
    let mut out = Vec::with_capacity(2 + len as usize);
    out.push(tag);
    out.push(len);
    out.extend_from_slice(&value_bytes[..len as usize]);
    out
}

/// Parameters for [`generate_zatca_qr`]. Order matches the TS API.
#[derive(Debug, Clone)]
pub struct ZatcaQrInput<'a> {
    pub seller_name: &'a str,
    pub vat_number: &'a str,
    pub invoice_timestamp: &'a str,
    pub invoice_total: &'a str,
    pub vat_amount: &'a str,
}

/// Produces the base64-encoded TLV string that the device renders as a QR
/// on every invoice.
pub fn generate_zatca_qr(input: &ZatcaQrInput<'_>) -> String {
    let mut buf = Vec::with_capacity(256);
    buf.extend(encode_tlv(1, input.seller_name));
    buf.extend(encode_tlv(2, input.vat_number));
    buf.extend(encode_tlv(3, input.invoice_timestamp));
    buf.extend(encode_tlv(4, input.invoice_total));
    buf.extend(encode_tlv(5, input.vat_amount));
    base64::engine::general_purpose::STANDARD.encode(&buf)
}

/// Decodes a ZATCA TLV QR back into its 5 fields. Used by tests and by the
/// QR-verification path when the cashier re-scans a printed receipt.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ZatcaQrFields {
    pub seller_name: String,
    pub vat_number: String,
    pub invoice_timestamp: String,
    pub invoice_total: String,
    pub vat_amount: String,
}

pub fn decode_zatca_qr(b64: &str) -> Result<ZatcaQrFields, String> {
    let buf = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("invalid base64: {e}"))?;
    let mut fields = ZatcaQrFields::default();
    let mut i = 0usize;
    while i < buf.len() {
        if i + 2 > buf.len() {
            return Err(format!("truncated TLV header at offset {i}"));
        }
        let tag = buf[i];
        let len = buf[i + 1] as usize;
        i += 2;
        if i + len > buf.len() {
            return Err(format!("TLV value for tag {tag} exceeds buffer"));
        }
        let value = std::str::from_utf8(&buf[i..i + len])
            .map_err(|e| format!("tag {tag} not UTF-8: {e}"))?
            .to_string();
        match tag {
            1 => fields.seller_name = value,
            2 => fields.vat_number = value,
            3 => fields.invoice_timestamp = value,
            4 => fields.invoice_total = value,
            5 => fields.vat_amount = value,
            _ => { /* tags 6-9 (Phase 2) ignored here */ }
        }
        i += len;
    }
    Ok(fields)
}

// ─── Tauri commands ──────────────────────────────────────────────────
// Frontend can offline-generate a QR string without round-tripping to the
// cloud. The desktop POS calls `generate_qr` while preparing the printable
// receipt + the cached invoice row in SQLite.

#[tauri::command]
pub fn generate_qr(
    seller_name: String,
    vat_number: String,
    invoice_timestamp: String,
    invoice_total: String,
    vat_amount: String,
) -> String {
    generate_zatca_qr(&ZatcaQrInput {
        seller_name: &seller_name,
        vat_number: &vat_number,
        invoice_timestamp: &invoice_timestamp,
        invoice_total: &invoice_total,
        vat_amount: &vat_amount,
    })
}

#[tauri::command]
pub fn decode_qr(b64: String) -> Result<serde_json::Value, String> {
    let f = decode_zatca_qr(&b64)?;
    Ok(serde_json::json!({
        "sellerName": f.seller_name,
        "vatNumber": f.vat_number,
        "invoiceTimestamp": f.invoice_timestamp,
        "invoiceTotal": f.invoice_total,
        "vatAmount": f.vat_amount,
    }))
}

// ─── Tests ───────────────────────────────────────────────────────────
// Test vectors generated from the Node/TS reference implementation
// (artifacts/api-server/src/lib/zatca-tlv.ts) so any drift between the two
// fails immediately. See scripts in scripts/zatca-vectors.mjs.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_seller_matches_ts_reference() {
        // Vector A: pure ASCII (smoke test, easy to read)
        // TS: generateZatcaQr({sellerName:"Test Co", vatNumber:"300000000000003",
        //   invoiceTimestamp:"2026-05-24T12:00:00Z", invoiceTotal:"115.00", vatAmount:"15.00"})
        let qr = generate_zatca_qr(&ZatcaQrInput {
            seller_name: "Test Co",
            vat_number: "300000000000003",
            invoice_timestamp: "2026-05-24T12:00:00Z",
            invoice_total: "115.00",
            vat_amount: "15.00",
        });
        assert_eq!(
            qr,
            "AQdUZXN0IENvAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMDUtMjRUMTI6MDA6MDBaBAYxMTUuMDAFBTE1LjAw"
        );
    }

    #[test]
    fn arabic_seller_byte_count_uses_utf8_length() {
        // Vector B: Arabic seller — UTF-8 byte length matters, not char count.
        // "شركة" = 8 bytes (4 chars × 2 bytes each in UTF-8 Arabic block).
        let qr = generate_zatca_qr(&ZatcaQrInput {
            seller_name: "شركة",
            vat_number: "310000000000003",
            invoice_timestamp: "2026-05-24T12:00:00Z",
            invoice_total: "230.50",
            vat_amount: "30.07",
        });
        // Roundtrip decode and verify
        let decoded = decode_zatca_qr(&qr).expect("decode");
        assert_eq!(decoded.seller_name, "شركة");
        assert_eq!(decoded.vat_number, "310000000000003");
        assert_eq!(decoded.invoice_total, "230.50");
    }

    #[test]
    fn roundtrip_preserves_all_5_fields() {
        let input = ZatcaQrInput {
            seller_name: "متجر الإلكترونيات",
            vat_number: "300000000000003",
            invoice_timestamp: "2026-12-31T23:59:59Z",
            invoice_total: "9999.99",
            vat_amount: "1304.34",
        };
        let qr = generate_zatca_qr(&input);
        let back = decode_zatca_qr(&qr).expect("decode");
        assert_eq!(back.seller_name, input.seller_name);
        assert_eq!(back.vat_number, input.vat_number);
        assert_eq!(back.invoice_timestamp, input.invoice_timestamp);
        assert_eq!(back.invoice_total, input.invoice_total);
        assert_eq!(back.vat_amount, input.vat_amount);
    }

    #[test]
    fn empty_strings_produce_valid_tlv() {
        // Edge case: minimum-length tags (len=0). TS impl produces 10 bytes
        // (5 tags × 2-byte headers) → base64 = "AQACAAMABAAFAA==".
        let qr = generate_zatca_qr(&ZatcaQrInput {
            seller_name: "",
            vat_number: "",
            invoice_timestamp: "",
            invoice_total: "",
            vat_amount: "",
        });
        assert_eq!(qr, "AQACAAMABAAFAA==");
        let back = decode_zatca_qr(&qr).expect("decode");
        assert_eq!(back, ZatcaQrFields::default());
    }

    #[test]
    fn decode_rejects_truncated_input() {
        // Half a TLV header → must error, not panic.
        let r = decode_zatca_qr("AQ==");
        assert!(r.is_err(), "expected truncated error, got {:?}", r);
    }
}

// ════════════════════════════════════════════════════════════════════
// Standalone ZATCA: secret storage + onboarding state + per-invoice chain
// + direct-to-gateway HTTPS proxy. (Task #233)
//
// The webview ports the heavy crypto (keygen / CSR / UBL / XAdES / QR) in
// src/lib/zatca/*. Rust owns only what the webview cannot safely do:
//   1. Persist the EGS private key + CSID material in the OS keyring.
//   2. Persist non-secret onboarding lifecycle state + the PIH/ICV chain
//      in the local SQLite DB.
//   3. Make the actual HTTPS calls to the ZATCA gateway (CORS + client TLS
//      make this impossible from the webview).
// ════════════════════════════════════════════════════════════════════

const ZATCA_KEYRING_SERVICE: &str = "com.zacoderp.pos";

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Maps a short, frontend-facing slot alias to its keyring account name.
/// Only these three slots are addressable — a compromised webview can NOT
/// reach the device / cashier auth tokens (different slots in main.rs), so
/// clearing a ZATCA enrolment never disturbs the device binding.
fn zatca_slot_account(slot: &str) -> Result<&'static str, String> {
    match slot {
        // EGS private key — hex-encoded secp256k1 scalar.
        "privkey" => Ok("zatca-privkey-v1"),
        // Compliance CSID bundle (binarySecurityToken + secret + requestID), JSON.
        "compliance" => Ok("zatca-compliance-csid-v1"),
        // Production CSID bundle (binarySecurityToken + secret + requestID), JSON.
        "production" => Ok("zatca-production-csid-v1"),
        _ => Err(format!("unknown ZATCA secret slot '{slot}'")),
    }
}

/// ACL-restricted file fallback for the keyring (same rationale as the
/// device token in main.rs — Windows Credential Manager can silently fail
/// on unsigned MSI installs / locked-down group policy).
fn zatca_secret_file(account: &str) -> Result<std::path::PathBuf, String> {
    let mut p = dirs::data_dir().ok_or_else(|| "no data dir available".to_string())?;
    p.push("ZACOD-POS");
    p.push("zatca");
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    p.push(account);
    Ok(p)
}

/// Version marker prefixing an encrypted on-disk secret. Files without it are
/// treated as legacy plaintext (transparent migration on the next save).
const ZATCA_ENC_PREFIX: &str = "zenc1:";

/// Derives the 32-byte AES key for the file fallback from this machine's
/// hardware fingerprint. No key is ever persisted — the encrypted file is
/// therefore bound to THIS machine: copying %APPDATA% to another box yields
/// an undecryptable blob. Domain-separated from any other fingerprint use.
fn zatca_file_key() -> Result<[u8; 32], String> {
    let fp = crate::license::hardware_fingerprint().map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    h.update(b"zatca-secret-file-v1|");
    h.update(fp.as_bytes());
    let digest = h.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    Ok(key)
}

/// AES-256-GCM encrypt → "zenc1:" + base64(nonce[12] || ciphertext+tag).
pub(crate) fn zatca_encrypt(plain: &str) -> Result<String, String> {
    let key = zatca_file_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|e| format!("zatca secret encrypt failed: {e}"))?;
    let mut blob = Vec::with_capacity(nonce_bytes.len() + ct.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ct);
    Ok(format!(
        "{ZATCA_ENC_PREFIX}{}",
        base64::engine::general_purpose::STANDARD.encode(&blob)
    ))
}

/// Inverse of `zatca_encrypt`. A value lacking the version prefix is returned
/// verbatim (legacy plaintext) so already-onboarded devices keep working.
pub(crate) fn zatca_decrypt(stored: &str) -> Result<String, String> {
    let Some(b64) = stored.strip_prefix(ZATCA_ENC_PREFIX) else {
        return Ok(stored.to_string());
    };
    let blob = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("invalid zatca secret blob: {e}"))?;
    if blob.len() < 12 + 16 {
        return Err("zatca secret blob too short".to_string());
    }
    let (nonce_bytes, ct) = blob.split_at(12);
    let key = zatca_file_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Nonce::from_slice(nonce_bytes);
    let pt = cipher
        .decrypt(nonce, ct)
        .map_err(|_| "zatca secret decrypt failed (wrong machine or corrupted file)".to_string())?;
    String::from_utf8(pt).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn zatca_save_secret(slot: String, value: String) -> Result<(), String> {
    let account = zatca_slot_account(&slot)?;
    // Best-effort keyring write (OS-encrypted primary store).
    if let Ok(entry) = keyring::Entry::new(ZATCA_KEYRING_SERVICE, account) {
        let _ = entry.set_password(&value);
    }
    // File fallback IS the source of truth — must succeed. Encrypted at rest
    // with a machine-bound key so a copied file is useless off this machine.
    let p = zatca_secret_file(account)?;
    let enc = zatca_encrypt(&value)?;
    std::fs::write(&p, enc).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn zatca_load_secret(slot: String) -> Result<Option<String>, String> {
    let account = zatca_slot_account(&slot)?;
    if let Ok(entry) = keyring::Entry::new(ZATCA_KEYRING_SERVICE, account) {
        if let Ok(v) = entry.get_password() {
            return Ok(Some(v));
        }
    }
    let p = zatca_secret_file(account)?;
    if !p.exists() {
        return Ok(None);
    }
    match std::fs::read_to_string(&p) {
        Ok(v) => {
            let v = v.trim();
            if v.is_empty() { Ok(None) } else { Ok(Some(zatca_decrypt(v)?)) }
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn zatca_clear_secret(slot: String) -> Result<(), String> {
    let account = zatca_slot_account(&slot)?;
    if let Ok(entry) = keyring::Entry::new(ZATCA_KEYRING_SERVICE, account) {
        let _ = entry.delete_credential();
    }
    let p = zatca_secret_file(account)?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Onboarding lifecycle state (singleton row id=1) ──────────────────

#[tauri::command]
pub fn zatca_get_onboarding() -> Result<serde_json::Value, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT environment, status, csr_pem, org_json, compliance_request_id,
                    production_request_id, last_error, updated_at
             FROM zatca_onboarding WHERE id = 1",
            [],
            |r| {
                Ok(serde_json::json!({
                    "environment": r.get::<_, String>(0)?,
                    "status": r.get::<_, String>(1)?,
                    "csrPem": r.get::<_, Option<String>>(2)?,
                    "orgJson": r.get::<_, Option<String>>(3)?,
                    "complianceRequestId": r.get::<_, Option<String>>(4)?,
                    "productionRequestId": r.get::<_, Option<String>>(5)?,
                    "lastError": r.get::<_, Option<String>>(6)?,
                    "updatedAt": r.get::<_, Option<String>>(7)?,
                }))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.unwrap_or_else(|| {
        serde_json::json!({
            "environment": "sandbox",
            "status": "none",
            "csrPem": serde_json::Value::Null,
            "orgJson": serde_json::Value::Null,
            "complianceRequestId": serde_json::Value::Null,
            "productionRequestId": serde_json::Value::Null,
            "lastError": serde_json::Value::Null,
            "updatedAt": serde_json::Value::Null,
        })
    }))
}

/// Upsert the singleton onboarding row. A `None` field PRESERVES the stored
/// value (COALESCE) — mirroring the web "b.X !== undefined" guard — EXCEPT
/// `last_error`, which is always written verbatim so a successful step can
/// clear a previous error by passing null.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn zatca_save_onboarding(
    environment: Option<String>,
    status: Option<String>,
    csr_pem: Option<String>,
    org_json: Option<String>,
    compliance_request_id: Option<String>,
    production_request_id: Option<String>,
    last_error: Option<String>,
) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO zatca_onboarding(id) VALUES(1) ON CONFLICT(id) DO NOTHING",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE zatca_onboarding SET
            environment = COALESCE(?1, environment),
            status = COALESCE(?2, status),
            csr_pem = COALESCE(?3, csr_pem),
            org_json = COALESCE(?4, org_json),
            compliance_request_id = COALESCE(?5, compliance_request_id),
            production_request_id = COALESCE(?6, production_request_id),
            last_error = ?7,
            updated_at = ?8
         WHERE id = 1",
        params![
            environment,
            status,
            csr_pem,
            org_json,
            compliance_request_id,
            production_request_id,
            last_error,
            now_iso(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Per-invoice PIH/ICV chain + submission status ────────────────────

/// Returns `{ icv, invoiceHash }` of the latest invoice in the chain, or
/// `null` if no invoice has been signed yet (caller seeds the genesis PIH).
#[tauri::command]
pub fn zatca_chain_head() -> Result<serde_json::Value, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT icv, invoice_hash FROM zatca_invoices ORDER BY icv DESC LIMIT 1",
            [],
            |r| {
                Ok(serde_json::json!({
                    "icv": r.get::<_, i64>(0)?,
                    "invoiceHash": r.get::<_, String>(1)?,
                }))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.unwrap_or(serde_json::Value::Null))
}

/// Insert (or idempotently re-record on retry) a signed invoice into the
/// chain. A duplicate `icv` for a DIFFERENT uuid is rejected (the UNIQUE
/// index protects the chain ordering); re-recording the SAME uuid updates
/// in place.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn zatca_record_invoice(
    local_uuid: String,
    icv: i64,
    pih: String,
    invoice_hash: String,
    invoice_no: Option<String>,
    invoice_type: Option<String>,
    signed_xml: Option<String>,
    qr_base64: Option<String>,
    status: Option<String>,
) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO zatca_invoices
            (local_uuid, icv, pih, invoice_hash, invoice_no, invoice_type,
             signed_xml, qr_base64, status)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8, COALESCE(?9,'pending'))
         ON CONFLICT(local_uuid) DO UPDATE SET
            icv = excluded.icv,
            pih = excluded.pih,
            invoice_hash = excluded.invoice_hash,
            invoice_no = excluded.invoice_no,
            invoice_type = excluded.invoice_type,
            signed_xml = excluded.signed_xml,
            qr_base64 = excluded.qr_base64,
            status = excluded.status",
        params![
            local_uuid,
            icv,
            pih,
            invoice_hash,
            invoice_no,
            invoice_type,
            signed_xml,
            qr_base64,
            status
        ],
    )
    .map_err(|e| {
        let s = e.to_string();
        if s.contains("idx_zatca_inv_icv") || s.contains("UNIQUE") {
            "تعارض في تسلسل الفاتورة (ICV مكرر)".to_string()
        } else {
            s
        }
    })?;
    Ok(())
}

/// Update the submission status of a recorded invoice. `zatca_status`,
/// `warnings_json`, `response_json` preserve-on-None; `status` + a fresh
/// `submitted_at` are always written.
#[tauri::command]
pub fn zatca_update_invoice_status(
    local_uuid: String,
    status: String,
    zatca_status: Option<String>,
    warnings_json: Option<String>,
    response_json: Option<String>,
) -> Result<(), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE zatca_invoices SET
                status = ?2,
                zatca_status = COALESCE(?3, zatca_status),
                warnings_json = COALESCE(?4, warnings_json),
                response_json = COALESCE(?5, response_json),
                submitted_at = ?6
             WHERE local_uuid = ?1",
            params![local_uuid, status, zatca_status, warnings_json, response_json, now_iso()],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("الفاتورة غير موجودة في سجل زاتكا".into());
    }
    Ok(())
}

fn row_to_zatca_invoice(r: &rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "localUuid": r.get::<_, String>(0)?,
        "icv": r.get::<_, i64>(1)?,
        "pih": r.get::<_, String>(2)?,
        "invoiceHash": r.get::<_, String>(3)?,
        "invoiceNo": r.get::<_, Option<String>>(4)?,
        "invoiceType": r.get::<_, Option<String>>(5)?,
        "qrBase64": r.get::<_, Option<String>>(6)?,
        "status": r.get::<_, String>(7)?,
        "zatcaStatus": r.get::<_, Option<String>>(8)?,
        "warningsJson": r.get::<_, Option<String>>(9)?,
        "responseJson": r.get::<_, Option<String>>(10)?,
        "submittedAt": r.get::<_, Option<String>>(11)?,
        "createdAt": r.get::<_, String>(12)?,
    }))
}

/// List invoices (newest ICV first), optionally filtered by status. Omits
/// the (potentially large) signed XML — use `zatca_get_invoice` for that.
#[tauri::command]
pub fn zatca_list_invoices(status: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let cols = "local_uuid, icv, pih, invoice_hash, invoice_no, invoice_type,
                qr_base64, status, zatca_status, warnings_json, response_json,
                submitted_at, created_at";
    let mut out = Vec::new();
    match status {
        Some(s) => {
            let sql = format!(
                "SELECT {cols} FROM zatca_invoices WHERE status = ?1 ORDER BY icv DESC"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![s], row_to_zatca_invoice)
                .map_err(|e| e.to_string())?;
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
        }
        None => {
            let sql = format!("SELECT {cols} FROM zatca_invoices ORDER BY icv DESC");
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], row_to_zatca_invoice)
                .map_err(|e| e.to_string())?;
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn zatca_get_invoice(local_uuid: String) -> Result<Option<serde_json::Value>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT local_uuid, icv, pih, invoice_hash, invoice_no, invoice_type,
                    signed_xml, qr_base64, status, zatca_status, warnings_json,
                    response_json, submitted_at, created_at
             FROM zatca_invoices WHERE local_uuid = ?1",
            params![local_uuid],
            |r| {
                Ok(serde_json::json!({
                    "localUuid": r.get::<_, String>(0)?,
                    "icv": r.get::<_, i64>(1)?,
                    "pih": r.get::<_, String>(2)?,
                    "invoiceHash": r.get::<_, String>(3)?,
                    "invoiceNo": r.get::<_, Option<String>>(4)?,
                    "invoiceType": r.get::<_, Option<String>>(5)?,
                    "signedXml": r.get::<_, Option<String>>(6)?,
                    "qrBase64": r.get::<_, Option<String>>(7)?,
                    "status": r.get::<_, String>(8)?,
                    "zatcaStatus": r.get::<_, Option<String>>(9)?,
                    "warningsJson": r.get::<_, Option<String>>(10)?,
                    "responseJson": r.get::<_, Option<String>>(11)?,
                    "submittedAt": r.get::<_, Option<String>>(12)?,
                    "createdAt": r.get::<_, String>(13)?,
                }))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

// ── Direct HTTPS proxy to the ZATCA gateway ──────────────────────────

/// POST to the ZATCA gateway on behalf of the webview (which can't make the
/// call itself: CORS + mutual TLS). Locked to *.zatca.gov.sa so a
/// compromised webview can't repurpose this as a generic SSRF primitive.
/// All ZATCA-required headers (Authorization, Accept-Version, Content-Type,
/// OTP, …) are supplied by the caller. Returns `{ status, body }` — the
/// caller parses the JSON body.
#[tauri::command]
pub async fn zatca_https_post(
    url: String,
    headers: HashMap<String, String>,
    body: String,
) -> Result<serde_json::Value, String> {
    let host = url
        .strip_prefix("https://")
        .ok_or_else(|| "ZATCA URL must use https".to_string())?
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    if !(host == "zatca.gov.sa" || host.ends_with(".zatca.gov.sa")) {
        return Err(format!("host '{host}' is not a ZATCA gateway"));
    }
    let client = reqwest::Client::new();
    let mut req = client.post(&url).body(body);
    for (k, v) in headers.iter() {
        req = req.header(k.as_str(), v.as_str());
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": text }))
}
