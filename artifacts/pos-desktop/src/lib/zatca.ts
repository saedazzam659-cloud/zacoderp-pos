// ZATCA TLV QR shim — forwards to Rust commands in src-tauri/src/zatca.rs.
// In browser dev mode, builds a deterministic fake base64 so the UI still
// renders something during testing (clearly marked as DEV).

const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core");
    _invoke = mod.invoke;
  }
  return (await _invoke!(cmd, args)) as T;
}

export interface ZatcaQrInput {
  sellerName: string;
  vatNumber: string;
  timestamp: string;        // ISO-8601, e.g. "2026-05-24T10:30:00Z"
  invoiceTotal: string;     // includes VAT, e.g. "115.00"
  vatTotal: string;         // e.g. "15.00"
}

export async function generateZatcaQr(input: ZatcaQrInput): Promise<string> {
  if (IS_TAURI) {
    // Rust signature: generate_qr(seller_name, vat_number, invoice_timestamp,
    //                              invoice_total, vat_amount)
    // — keys MUST match exactly or Tauri rejects with "missing field" before
    //   the command body runs.
    return invoke<string>("generate_qr", {
      seller_name: input.sellerName,
      vat_number: input.vatNumber,
      invoice_timestamp: input.timestamp,
      invoice_total: input.invoiceTotal,
      vat_amount: input.vatTotal,
    });
  }
  // Browser dev fallback — NOT ZATCA-valid, just for UI smoke-testing.
  const raw = `DEV|${input.sellerName}|${input.vatNumber}|${input.timestamp}|${input.invoiceTotal}|${input.vatTotal}`;
  return btoa(unescape(encodeURIComponent(raw)));
}
