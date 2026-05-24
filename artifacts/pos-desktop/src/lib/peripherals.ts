// Peripherals shim: thermal printer + cash drawer.
// In Tauri → forwards to Rust commands in src-tauri/src/peripherals.rs.
// In browser → throws (peripherals require the desktop runtime).

const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("peripherals require the desktop runtime (Tauri)");
  if (!_invoke) {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core");
    _invoke = mod.invoke;
  }
  return (await _invoke!(cmd, args)) as T;
}

export interface ReceiptLine {
  text: string;
  bold?: boolean;
  center?: boolean;
}

export interface ReceiptJob {
  printerName: string;
  header: ReceiptLine[];
  body: ReceiptLine[];
  footer: ReceiptLine[];
  qrData?: string | null;
  openDrawer?: boolean;
  cut?: boolean;
}

export interface PrinterInfo {
  name: string;
  systemName: string;
  isDefault: boolean;
  state: string;
}

export function listPrinters(): Promise<PrinterInfo[]> {
  return invoke<PrinterInfo[]>("list_printers");
}

export function listSerialPorts(): Promise<string[]> {
  return invoke<string[]>("list_serial_ports");
}

export function printReceipt(job: ReceiptJob): Promise<void> {
  // Rust side expects snake_case fields (serde default)
  const payload = {
    printer_name: job.printerName,
    header: job.header,
    body: job.body,
    footer: job.footer,
    qr_data: job.qrData ?? null,
    open_drawer: job.openDrawer ?? false,
    cut: job.cut ?? true,
  };
  return invoke<void>("print_receipt", { job: payload });
}

export function printRawSerial(port: string, baud: number, bytes: number[]): Promise<void> {
  return invoke<void>("print_raw_serial", { port, baud, bytes });
}

export function openCashDrawer(printerName: string): Promise<void> {
  // Send snake_case explicitly so we don't depend on Tauri's implicit
  // camelCase→snake_case argument renaming (architect-flagged regression risk).
  return invoke<void>("open_cash_drawer", { printer_name: printerName });
}

export function openCashDrawerSerial(port: string, baud: number): Promise<void> {
  return invoke<void>("open_cash_drawer_serial", { port, baud });
}
