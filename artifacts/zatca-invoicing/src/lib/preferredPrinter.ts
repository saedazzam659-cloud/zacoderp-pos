// Per-device "preferred printer name" hint.
//
// Browsers cannot programmatically enumerate the printers connected
// to the user's computer (security restriction); the system print
// dialog opened by `window.print()` is the only place where the user
// can pick a physical printer. So this helper stores nothing more
// than a HUMAN-READABLE NAME the user has typed in — a reminder that
// surfaces in the Print Settings tab and as a hint in the
// pre-print toast. The value is per-device (localStorage), not
// per-user, because a single user account is often used from
// multiple machines, each connected to a different printer.

const KEY = "preferredPrinterName";

export function getPreferredPrinter(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setPreferredPrinter(name: string): void {
  try {
    const trimmed = (name ?? "").trim();
    if (trimmed) localStorage.setItem(KEY, trimmed);
    else localStorage.removeItem(KEY);
  } catch {
    /* localStorage may be unavailable (private mode, etc.) — ignore */
  }
}

// ── Auto-detect via WebUSB ────────────────────────────────────────
// Browsers can't enumerate every installed printer for privacy, but
// they DO let the user grant access to a single USB device through
// `navigator.usb.requestDevice`. We filter on USB class 7 (Printer
// class) so the chooser only shows printer-like devices. After the
// user picks one we read the product/manufacturer strings the
// printer reports over USB and use them as the suggested name.
//
// Caveats (surfaced to the caller via the result type):
//   - Chrome/Edge/Opera only. Firefox & Safari don't ship WebUSB.
//   - Only USB-connected printers — network/Wi-Fi printers won't
//     show up in the chooser.
//   - The user must accept the browser's USB-permission dialog.

export type DetectPrinterResult =
  | { ok: true; name: string; manufacturer?: string; product?: string }
  | { ok: false; reason: "unsupported" | "cancelled" | "no-name" | "error"; message?: string };

export async function detectUsbPrinter(): Promise<DetectPrinterResult> {
  const nav = navigator as any;
  if (!nav?.usb?.requestDevice) {
    return { ok: false, reason: "unsupported" };
  }
  try {
    // USB printer class code = 7 (per usb.org device-class assignments).
    const device = await nav.usb.requestDevice({ filters: [{ classCode: 7 }] });
    const product = (device?.productName ?? "").trim();
    const manufacturer = (device?.manufacturerName ?? "").trim();
    if (!product && !manufacturer) {
      return { ok: false, reason: "no-name" };
    }
    // Prefer a combined "Manufacturer Product" label when both are
    // distinct, e.g. "EPSON TM-T20" or "HP LaserJet M1136".
    const name =
      product && manufacturer && !product.toLowerCase().includes(manufacturer.toLowerCase())
        ? `${manufacturer} ${product}`
        : product || manufacturer;
    return { ok: true, name, manufacturer, product };
  } catch (err: any) {
    // The API throws a NotFoundError when the user cancels the
    // chooser without picking a device. Treat that as a benign
    // "cancelled" so the UI can stay quiet.
    const msg = String(err?.message ?? err ?? "");
    if (err?.name === "NotFoundError" || /no device selected/i.test(msg)) {
      return { ok: false, reason: "cancelled" };
    }
    return { ok: false, reason: "error", message: msg };
  }
}

export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as any).usb?.requestDevice;
}

// Open a tiny test sheet that calls window.print() so the user can
// confirm the system print dialog is wired to their preferred printer.
// Returns the opened window (or null when the popup was blocked).
export function openPrinterTestSheet(printerName?: string): Window | null {
  const w = window.open("", "_blank", "width=520,height=420");
  if (!w) return null;
  const safe = (printerName ?? "")
    .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  const html = `<!doctype html><html dir="rtl"><head><meta charset="utf-8"/>
<title>اختبار الطباعة</title>
<style>
  body { font-family: "Segoe UI", "Tahoma", "Arial", system-ui, sans-serif; margin:24px; color:#0f172a; }
  h1 { font-size:18px; margin:0 0 12px; color:#0e7c8a; }
  .card { border:1px solid #cbd5e1; border-radius:8px; padding:14px; background:#f8fafc; font-size:13px; line-height:1.7; }
  .btn { margin-top:14px; padding:8px 14px; background:#0e7c8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:13px; }
  @media print { .btn { display:none; } }
</style></head><body>
<h1>اختبار الطباعة</h1>
<div class="card">
  <div>هذه صفحة اختبار للتأكد من توصيل الطابعة بشكل صحيح.</div>
  ${safe ? `<div style="margin-top:6px;">الطابعة المفضلة على هذا الجهاز: <b>${safe}</b></div>` : ""}
  <div style="margin-top:6px;">عند ظهور نافذة الطباعة، تأكد من اختيار الطابعة المتصلة بالجهاز ثم اضغط "طباعة".</div>
</div>
<button class="btn" onclick="window.print()">طباعة</button>
<script>setTimeout(function(){ window.print(); }, 350);</script>
</body></html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
  return w;
}
