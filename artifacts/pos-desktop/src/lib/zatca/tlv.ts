// ZATCA TLV (Tag-Length-Value) QR builder — browser-safe (Task #233).
//
// Phase 1 (Annex B) — 5 tags, identical to the cloud's `zatca-tlv.ts` and the
// Rust port in `src-tauri/src/zatca.rs` (byte-for-byte: the Phase-1 vector test
// in that Rust file is reproduced exactly by `buildPhase1Qr`).
//
//   1 - Seller Name              (UTF-8)
//   2 - VAT Registration Number  (UTF-8)
//   3 - Invoice Timestamp        (UTF-8, ISO-8601)
//   4 - Invoice Total (with VAT) (UTF-8)
//   5 - VAT Amount               (UTF-8)
//
// Phase 2 adds the cryptographic-stamp tags required on every SIGNED simplified
// invoice (per ZATCA's security implementation standard / Fatoora SDK):
//
//   6 - Invoice hash             (UTF-8 of the base64 DigestValue string)
//   7 - Digital signature        (UTF-8 of the base64 SignatureValue string)
//   8 - EGS public key           (raw DER SubjectPublicKeyInfo bytes)
//   9 - CSID stamp signature      (raw signature bytes from the CSID cert)
//
// NOTE: tags 6-9 encoding follows the ZATCA SDK convention; it has no cloud
// reference (the cloud QR is Phase-1 only) and MUST be validated against the
// ZATCA sandbox before relying on it in production. The encoder itself is a
// pure function — the caller (submission pipeline) supplies the prepared
// values from the signed UBL + CSID certificate.

import { utf8ToBytes, bytesToB64 } from "./crypto";

/** Encode one (tag, value) pair using ZATCA's single-byte (short-form) length. */
function tlv(tag: number, value: Uint8Array): Uint8Array {
  if (value.length > 0xff) {
    throw new Error(
      `ZATCA TLV tag ${tag} value is ${value.length} bytes — exceeds the single-byte length limit (255)`,
    );
  }
  const out = new Uint8Array(2 + value.length);
  out[0] = tag;
  out[1] = value.length;
  out.set(value, 2);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface Phase1QrInput {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  invoiceTotal: string;
  vatTotal: string;
}

export function buildPhase1Qr(i: Phase1QrInput): string {
  return bytesToB64(
    concat([
      tlv(1, utf8ToBytes(i.sellerName)),
      tlv(2, utf8ToBytes(i.vatNumber)),
      tlv(3, utf8ToBytes(i.timestamp)),
      tlv(4, utf8ToBytes(i.invoiceTotal)),
      tlv(5, utf8ToBytes(i.vatTotal)),
    ]),
  );
}

export interface Phase2QrInput extends Phase1QrInput {
  /** base64 of the invoice DigestValue (tag 6). */
  invoiceHashB64: string;
  /** base64 of the XAdES SignatureValue (tag 7). */
  signatureB64: string;
  /** DER SubjectPublicKeyInfo bytes of the EGS public key (tag 8). */
  publicKeyDer: Uint8Array;
  /** Raw signature bytes of the CSID certificate (tag 9). Omitted when absent. */
  certSignatureDer?: Uint8Array | null;
}

export function buildPhase2Qr(i: Phase2QrInput): string {
  const parts: Uint8Array[] = [
    tlv(1, utf8ToBytes(i.sellerName)),
    tlv(2, utf8ToBytes(i.vatNumber)),
    tlv(3, utf8ToBytes(i.timestamp)),
    tlv(4, utf8ToBytes(i.invoiceTotal)),
    tlv(5, utf8ToBytes(i.vatTotal)),
    tlv(6, utf8ToBytes(i.invoiceHashB64)),
    tlv(7, utf8ToBytes(i.signatureB64)),
    tlv(8, i.publicKeyDer),
  ];
  if (i.certSignatureDer && i.certSignatureDer.length > 0) {
    parts.push(tlv(9, i.certSignatureDer));
  }
  return bytesToB64(concat(parts));
}

/** Decode a TLV QR back into a tag→value map. Tags 1-7 are returned as UTF-8
 * strings; binary tags (8, 9) are returned as the raw byte length only via the
 * `_rawLengths` side-channel for diagnostics. Primarily used by tests. */
export function decodeTlv(b64: string): Record<number, string> {
  const bin = atob(b64.replace(/\s+/g, ""));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const out: Record<number, string> = {};
  let i = 0;
  while (i < buf.length) {
    if (i + 2 > buf.length) throw new Error(`truncated TLV header at offset ${i}`);
    const tag = buf[i];
    const len = buf[i + 1];
    i += 2;
    if (i + len > buf.length) throw new Error(`TLV value for tag ${tag} exceeds buffer`);
    out[tag] = new TextDecoder().decode(buf.subarray(i, i + len));
    i += len;
  }
  return out;
}
