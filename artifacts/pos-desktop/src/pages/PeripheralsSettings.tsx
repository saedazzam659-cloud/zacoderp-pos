// Peripherals test + configuration panel.
//
// Lets the cashier:
//   - Pick a default printer from the Windows spooler list
//   - Pick a serial-COM fallback (if any)
//   - Print a test receipt (validates ESC/POS path end-to-end)
//   - Kick the cash drawer (validates ESC p 0 25 250 path)
//   - Verify the barcode-scanner keyboard-wedge listener is firing
//
// Config persists to localStorage so PosShell can read it back when actually
// finalising a sale. Keys are namespaced `pos_desktop_peripherals_*`.

import { useEffect, useState } from "react";
import {
  listPrinters, listSerialPorts,
  printReceipt, openCashDrawer,
  type PrinterInfo,
} from "../lib/peripherals";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { TAURI_MODE } from "../lib/tauri-shim";
import { SearchCombobox } from "./_adminUi";
import { uiText, useUiLanguage } from "../lib/appSettings";

const LS_PRINTER = "pos_desktop_peripherals_printer";
const LS_SERIAL = "pos_desktop_peripherals_serial_port";
const LS_BAUD = "pos_desktop_peripherals_serial_baud";

type Props = { onClose: () => void };

export default function PeripheralsSettings({ onClose }: Props) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [serialPorts, setSerialPorts] = useState<string[]>([]);
  const [printer, setPrinter] = useState<string>(() => localStorage.getItem(LS_PRINTER) ?? "");
  const [serial, setSerial] = useState<string>(() => localStorage.getItem(LS_SERIAL) ?? "");
  const [baud, setBaud] = useState<number>(() => Number(localStorage.getItem(LS_BAUD) ?? 9600));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastScan, setLastScan] = useState<string>("");
  const [scanCount, setScanCount] = useState(0);

  useBarcodeScanner({
    onScan: (code) => {
      setLastScan(code);
      setScanCount((n) => n + 1);
    },
  });

  useEffect(() => {
    if (TAURI_MODE !== "tauri") return;
    void (async () => {
      try {
        const [p, s] = await Promise.all([listPrinters(), listSerialPorts()]);
        setPrinters(p);
        setSerialPorts(s);
        // Auto-pick the system default if nothing saved yet
        if (!printer) {
          const def = p.find((x) => x.isDefault) ?? p[0];
          if (def) {
            setPrinter(def.name);
            localStorage.setItem(LS_PRINTER, def.name);
          }
        }
      } catch (e: any) {
        setMsg({ kind: "err", text: `${text("تعذّر قراءة الأجهزة:", "Could not read devices:")} ${e?.message ?? e}` });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function persistPrinter(v: string) { setPrinter(v); localStorage.setItem(LS_PRINTER, v); }
  function persistSerial(v: string) { setSerial(v); localStorage.setItem(LS_SERIAL, v); }
  function persistBaud(v: number) { setBaud(v); localStorage.setItem(LS_BAUD, String(v)); }

  async function doTestPrint() {
    if (!printer) { setMsg({ kind: "err", text: text("اختر طابعة أولاً", "Select a printer first.") }); return; }
    setBusy("print"); setMsg(null);
    try {
      await printReceipt({
        printerName: printer,
        header: [
          { text: "ZACOD POS", bold: true, center: true },
          { text: text("اختبار الطباعة", "Print test"), center: true },
        ],
        body: [
          { text: text("صنف تجريبي ×1     10.00", "Demo item ×1     10.00") },
          { text: text("ضريبة (15%)        1.50", "Tax (15%)        1.50") },
          { text: "─────────────────────" },
          { text: text("الإجمالي           11.50", "Total             11.50"), bold: true },
        ],
        footer: [
          { text: new Date().toLocaleString(language === "en" ? "en-GB" : "ar-SA"), center: true },
          { text: text("شكراً لزيارتكم", "Thank you for visiting"), center: true },
        ],
        qrData: "https://zacoderp.com",
        cut: true,
        openDrawer: false,
      });
      setMsg({ kind: "ok", text: `✅ ${text("تم إرسال إيصال اختبار للطابعة", "Test receipt sent to the printer.")}` });
    } catch (e: any) {
      setMsg({ kind: "err", text: `${text("فشل الطباعة:", "Print failed:")} ${e?.message ?? e}` });
    } finally { setBusy(null); }
  }

  async function doKickDrawer() {
    if (!printer) { setMsg({ kind: "err", text: text("اختر طابعة أولاً (الدرج يفتح عبرها)", "Select a printer first (the cash drawer opens through it).") }); return; }
    setBusy("drawer"); setMsg(null);
    try {
      await openCashDrawer(printer);
      setMsg({ kind: "ok", text: `✅ ${text("تم إرسال أمر فتح الدرج", "Cash drawer open command sent.")}` });
    } catch (e: any) {
      setMsg({ kind: "err", text: `${text("فشل فتح الدرج:", "Could not open cash drawer:")} ${e?.message ?? e}` });
    } finally { setBusy(null); }
  }

  return (
    <div dir={language === "en" ? "ltr" : "rtl"} style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <header style={S.header}>
          <h2 style={S.title}>{text("إعدادات الأجهزة الطرفية", "Peripheral settings")}</h2>
          <button style={S.close} onClick={onClose}>×</button>
        </header>

        {TAURI_MODE !== "tauri" && (
          <div style={S.warn}>
            🌐 {text("وضع المتصفح — تعداد الطابعات والمنافذ معطّل. سيعمل فعلياً داخل التطبيق على Windows فقط.", "Browser preview — printer and port discovery is disabled. It works inside the Windows app only.")}
          </div>
        )}

        <section style={S.section}>
          <label style={S.label}>{text("الطابعة (Windows spooler)", "Printer (Windows spooler)")}</label>
          <SearchCombobox
            value={printer}
            onChange={(v) => persistPrinter(String(v))}
            disabled={TAURI_MODE !== "tauri"}
            style={S.input}
            placeholder={text("— لم يتم الاختيار —", "— Not selected —")}
            options={[
              { value: "", label: text("— لم يتم الاختيار —", "— Not selected —") },
              ...printers.map((p) => ({
                value: p.name,
                label: `${p.name}${p.isDefault ? ` (${text("افتراضية", "default")})` : ""} — ${p.state}`,
              })),
            ]}
          />
        </section>

        <section style={S.section}>
          <label style={S.label}>{text("منفذ تسلسلي (COM) — اختياري للطابعات القديمة", "Serial port (COM) — optional for older printers")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <SearchCombobox
                value={serial}
                onChange={(v) => persistSerial(String(v))}
                disabled={TAURI_MODE !== "tauri"}
                style={S.input}
                placeholder={text("— بدون —", "— None —")}
                options={[
                  { value: "", label: text("— بدون —", "— None —") },
                  ...serialPorts.map((p) => ({ value: p, label: p })),
                ]}
              />
            </div>
            <input
              type="number"
              value={baud}
              onChange={(e) => persistBaud(Number(e.target.value))}
              style={{ ...S.input, width: 120 }}
              placeholder="Baud"
            />
          </div>
        </section>

        <section style={S.section}>
          <div style={S.btnRow}>
            <button onClick={doTestPrint} disabled={!!busy || TAURI_MODE !== "tauri"} style={S.btnPrimary}>
              {busy === "print" ? text("جارٍ الطباعة...", "Printing...") : `🖨️ ${text("طباعة إيصال اختبار", "Print test receipt")}`}
            </button>
            <button onClick={doKickDrawer} disabled={!!busy || TAURI_MODE !== "tauri"} style={S.btnSecondary}>
              {busy === "drawer" ? text("جارٍ الفتح...", "Opening...") : `💵 ${text("فتح درج النقود", "Open cash drawer")}`}
            </button>
          </div>
          {msg && (
            <div style={msg.kind === "ok" ? S.success : S.err}>{msg.text}</div>
          )}
        </section>

        <section style={S.section}>
          <label style={S.label}>{text("اختبار قارئ الباركود", "Barcode scanner test")}</label>
          <div style={S.scanBox}>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>
              {text("امسح أي باركود الآن — التركيز ليس مهماً (المستمع عام).", "Scan any barcode now. Focus does not matter; the listener is global.")}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span dir="ltr" style={{ fontFamily: "ui-monospace, monospace", fontSize: 18, color: "#0f172a" }}>
                {lastScan || "—"}
              </span>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>{text("عدد المسحات:", "Scans:")} {scanCount}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

const S = {
  overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 } as const,
  modal: { background: "#fff", borderRadius: 12, width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", padding: 24, fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 } as const,
  title: { margin: 0, fontSize: 20, color: "#0f172a" } as const,
  close: { background: "transparent", border: "none", fontSize: 28, cursor: "pointer", color: "#64748b", lineHeight: 1 } as const,
  section: { marginBottom: 18 } as const,
  label: { display: "block", fontSize: 13, color: "#475569", marginBottom: 6, fontWeight: 600 } as const,
  input: { width: "100%", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, fontFamily: "inherit" } as const,
  btnRow: { display: "flex", gap: 10, flexWrap: "wrap" } as const,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnSecondary: { padding: "10px 18px", background: "#fff", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  success: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, marginTop: 10, fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginTop: 10, fontSize: 13 } as const,
  warn: { background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", padding: 10, borderRadius: 6, marginBottom: 16, fontSize: 13 } as const,
  scanBox: { background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 6, padding: 12 } as const,
};
