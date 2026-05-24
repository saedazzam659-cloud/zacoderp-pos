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

use base64::Engine;

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
