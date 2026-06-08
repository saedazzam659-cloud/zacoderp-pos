/**
 * ZATCA TLV (Tag-Length-Value) QR Code Generator
 * As per ZATCA e-invoicing requirements (Annex B)
 *
 * Tags:
 *   1 - Seller Name
 *   2 - VAT Registration Number
 *   3 - Invoice Timestamp (ISO 8601)
 *   4 - Invoice Total (with VAT)
 *   5 - VAT Amount
 */

function encodeTLV(tag: number, value: string): Buffer {
  const valueBytes = Buffer.from(value, "utf8");
  const tagBuf = Buffer.from([tag]);
  const lenBuf = Buffer.from([valueBytes.length]);
  return Buffer.concat([tagBuf, lenBuf, valueBytes]);
}

export function generateZatcaQr(params: {
  sellerName: string;
  vatNumber: string;
  invoiceTimestamp: string;
  invoiceTotal: string;
  vatAmount: string;
}): string {
  const tlv = Buffer.concat([
    encodeTLV(1, params.sellerName),
    encodeTLV(2, params.vatNumber),
    encodeTLV(3, params.invoiceTimestamp),
    encodeTLV(4, params.invoiceTotal),
    encodeTLV(5, params.vatAmount),
  ]);
  return tlv.toString("base64");
}

/**
 * Phase-2 (cryptographic-stamp) QR — tags 1-9, required on SIGNED simplified
 * invoices and used for ZATCA compliance-check submissions.
 *
 *   1-5 — same as Phase-1 (seller, VAT, timestamp, total, VAT amount)
 *   6   — invoice hash (base64 DigestValue string)
 *   7   — XAdES SignatureValue (base64 string)
 *   8   — EGS public key as DER SubjectPublicKeyInfo (raw bytes)
 *   9   — CSID certificate signature (raw bytes) — omitted when absent
 *
 * Binary tags (8, 9) carry raw bytes, so this uses a Buffer-capable encoder
 * rather than the UTF-8 `encodeTLV` above. Single-byte length (values < 256B).
 */
function encodeTLVBinary(tag: number, value: Buffer): Buffer {
  if (value.length > 0xff) {
    throw new Error(`ZATCA TLV tag ${tag} value is ${value.length} bytes — exceeds the single-byte length limit (255)`);
  }
  return Buffer.concat([Buffer.from([tag]), Buffer.from([value.length]), value]);
}

export function buildPhase2Qr(params: {
  sellerName: string;
  vatNumber: string;
  invoiceTimestamp: string;
  invoiceTotal: string;
  vatAmount: string;
  invoiceHashB64: string;
  signatureB64: string;
  publicKeyDer: Buffer;
  certSignatureDer?: Buffer | null;
}): string {
  const parts: Buffer[] = [
    encodeTLVBinary(1, Buffer.from(params.sellerName, "utf8")),
    encodeTLVBinary(2, Buffer.from(params.vatNumber, "utf8")),
    encodeTLVBinary(3, Buffer.from(params.invoiceTimestamp, "utf8")),
    encodeTLVBinary(4, Buffer.from(params.invoiceTotal, "utf8")),
    encodeTLVBinary(5, Buffer.from(params.vatAmount, "utf8")),
    encodeTLVBinary(6, Buffer.from(params.invoiceHashB64, "utf8")),
    encodeTLVBinary(7, Buffer.from(params.signatureB64, "utf8")),
    encodeTLVBinary(8, params.publicKeyDer),
  ];
  if (params.certSignatureDer && params.certSignatureDer.length > 0) {
    parts.push(encodeTLVBinary(9, params.certSignatureDer));
  }
  return Buffer.concat(parts).toString("base64");
}

export function decodeZatcaQr(base64: string): Record<string, string> {
  const buf = Buffer.from(base64, "base64");
  const tags: Record<number, string> = {};
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i++]!;
    const len = buf[i++]!;
    const value = buf.subarray(i, i + len).toString("utf8");
    tags[tag] = value;
    i += len;
  }
  return {
    sellerName: tags[1] ?? "",
    vatNumber: tags[2] ?? "",
    invoiceTimestamp: tags[3] ?? "",
    invoiceTotal: tags[4] ?? "",
    vatAmount: tags[5] ?? "",
  };
}
