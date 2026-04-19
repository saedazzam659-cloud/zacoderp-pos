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
