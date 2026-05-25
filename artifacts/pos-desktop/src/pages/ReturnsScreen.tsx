// Returns (مرتجع) screen.
//
// Two flows:
//   1) Reference an existing offline invoice and refund all/part of its lines
//   2) Manual return: type lines directly (for receipts the cashier doesn't have)
//
// A return is just an offline_invoices row with negative amounts and a
// `kind: "return"` flag in the payload. The same push pipeline ships it
// to the cloud. The receipt is printed as a clearly-marked credit note.

import { useEffect, useMemo, useState } from "react";
import { listAllInvoices, getOfflineInvoice, saveOfflineInvoice, type PendingInvoice, type OfflineInvoicePayload } from "../lib/invoices";
import { printReceipt, type ReceiptLine } from "../lib/peripherals";
import { generateZatcaQr } from "../lib/zatca";

const VAT_RATE = 0.15;
const LS_PRINTER = "pos_desktop_peripherals_printer";

type Props = { companyName?: string; vatNumber?: string };

export default function ReturnsScreen({ companyName = "ZACOD POS", vatNumber = "300000000000003" }: Props) {
  const [invoices, setInvoices] = useState<PendingInvoice[]>([]);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<{ inv: PendingInvoice; payload: OfflineInvoicePayload } | null>(null);
  const [lines, setLines] = useState<Array<{ nameAr: string; unitPrice: number; vatRate: number; qty: number; refundQty: number }>>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastReturn, setLastReturn] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try { setInvoices(await listAllInvoices(100)); }
    catch { /* ignore */ }
  }

  const filtered = useMemo(() => {
    if (!search) return invoices;
    return invoices.filter((i) =>
      i.invoiceNo.toLowerCase().includes(search.toLowerCase()),
    );
  }, [invoices, search]);

  async function pick(inv: PendingInvoice) {
    setToast(null);
    try {
      const full = await getOfflineInvoice(inv.id);
      // In browser-fallback there's no getOfflineInvoice — pull payload from localStorage
      let payloadJson = full?.payloadJson;
      if (!payloadJson) {
        try {
          const raw = localStorage.getItem("pos_desktop_invoices_v1");
          const arr: any[] = raw ? JSON.parse(raw) : [];
          payloadJson = arr.find((i) => i.id === inv.id)?.payloadJson;
        } catch { /* ignore */ }
      }
      if (!payloadJson) throw new Error("لم يُعثر على بيانات الفاتورة");
      const payload = JSON.parse(payloadJson) as OfflineInvoicePayload;
      if ((payload as any).kind === "return") {
        throw new Error("لا يمكن إرجاع فاتورة مرتجع");
      }
      setPicked({ inv, payload });
      setLines(payload.lines.map((l) => ({
        nameAr: l.nameAr, unitPrice: l.unitPrice, vatRate: l.vatRate,
        qty: l.qty, refundQty: l.qty,
      })));
    } catch (e: any) {
      setToast({ kind: "err", text: e?.message ?? "فشل تحميل الفاتورة" });
    }
  }

  const totals = useMemo(() => {
    const grand = lines.reduce((s, l) => s + l.unitPrice * l.refundQty, 0);
    const sub = grand / (1 + VAT_RATE);
    return { sub, vat: grand - sub, grand };
  }, [lines]);

  async function submitReturn() {
    if (!picked) return;
    const refundLines = lines.filter((l) => l.refundQty > 0);
    if (refundLines.length === 0) { setToast({ kind: "err", text: "حدد كمية على الأقل لإرجاعها" }); return; }
    if (!reason.trim()) { setToast({ kind: "err", text: "سبب الإرجاع مطلوب" }); return; }
    const printer = localStorage.getItem(LS_PRINTER);
    if (!printer) { setToast({ kind: "err", text: "لم يتم تكوين طابعة" }); return; }

    setBusy(true); setToast(null);
    try {
      const ts = new Date().toISOString();
      const qr = await generateZatcaQr({
        sellerName: companyName,
        vatNumber,
        timestamp: ts,
        invoiceTotal: (-totals.grand).toFixed(2),
        vatTotal: (-totals.vat).toFixed(2),
      });
      const payload: OfflineInvoicePayload & { kind: "return"; refOf: string; reason: string } = {
        kind: "return",
        refOf: picked.inv.invoiceNo,
        reason,
        paymentMethod: picked.payload.paymentMethod,
        timestamp: ts,
        subtotal: -Number(totals.sub.toFixed(2)),
        vat: -Number(totals.vat.toFixed(2)),
        grandTotal: -Number(totals.grand.toFixed(2)),
        lines: refundLines.map((l) => ({
          itemId: 0, nameAr: l.nameAr,
          qty: -l.refundQty, unitPrice: l.unitPrice, vatRate: l.vatRate,
        })),
      };
      // Stable idempotency key: same original-invoice id + same refund-qty
      // shape → same key. Double-clicks within the same modal cannot create
      // two separate credit notes. Architect-flagged: previously used
      // Date.now() which let rapid double-clicks slip through.
      const shape = refundLines
        .map((l) => `${l.nameAr.replace(/[|:]/g, "_")}:${l.refundQty}@${l.unitPrice}`)
        .sort()
        .join("|");
      const reasonKey = reason.trim().slice(0, 32).replace(/\s+/g, "_");
      const key = `ret-${picked.inv.id}-${reasonKey}-${shape}`;
      const saved = await saveOfflineInvoice(payload, qr ?? undefined, undefined, key);

      const body: ReceiptLine[] = [];
      for (const l of refundLines) {
        body.push({ text: `${l.nameAr.padEnd(20, " ")} ×${l.refundQty}  ${(l.unitPrice * l.refundQty).toFixed(2)}` });
      }
      body.push({ text: "─".repeat(32) });
      body.push({ text: `إجمالي المرتجع قبل الضريبة:  ${totals.sub.toFixed(2)}` });
      body.push({ text: `الضريبة المسترجعة:           ${totals.vat.toFixed(2)}` });
      body.push({ text: `الإجمالي المسترجع:            ${totals.grand.toFixed(2)}`, bold: true });
      body.push({ text: `السبب: ${reason}` });
      body.push({ text: `فاتورة أصلية: ${picked.inv.invoiceNo}` });

      await printReceipt({
        printerName: printer,
        header: [
          { text: companyName, bold: true, center: true },
          { text: `الرقم الضريبي: ${vatNumber}`, center: true },
          { text: `*** إشعار دائن — مرتجع ***`, bold: true, center: true },
          { text: `رقم: ${saved.invoiceNo}`, center: true },
          { text: new Date(ts).toLocaleString("ar-SA"), center: true },
        ],
        body,
        footer: [{ text: "شكراً لزيارتكم", center: true }],
        qrData: qr,
        cut: true,
        openDrawer: payload.paymentMethod === "cash",
      });

      setLastReturn(saved.invoiceNo);
      setPicked(null); setLines([]); setReason("");
      setToast({ kind: "ok", text: `✅ تم تسجيل المرتجع — ${saved.invoiceNo}` });
      await refresh();
    } catch (e: any) {
      setToast({ kind: "err", text: `فشل المرتجع: ${e?.message ?? e}` });
    } finally { setBusy(false); }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.headerRow}>
        <div>
          <h2 style={S.h2}>مرتجع المبيعات</h2>
          <div style={S.sub}>اختر فاتورة سابقة لإرجاع جزء أو كل أصنافها</div>
        </div>
        {lastReturn && (
          <div style={S.lastChip}>آخر مرتجع: {lastReturn}</div>
        )}
      </div>

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      {!picked ? (
        <>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث برقم الفاتورة..."
            style={S.search}
          />
          {filtered.length === 0 ? (
            <div style={S.empty}>لا توجد فواتير سابقة لإرجاعها</div>
          ) : (
            <table style={S.table}>
              <thead><tr>
                <th style={S.th}>رقم الفاتورة</th>
                <th style={S.th}>التاريخ</th>
                <th style={S.th}>الحالة</th>
                <th style={S.thRight}>إجراء</th>
              </tr></thead>
              <tbody>
                {filtered.map((inv) => (
                  <tr key={inv.id} style={S.tr}>
                    <td style={S.tdMono}>{inv.invoiceNo}</td>
                    <td style={S.td}>{new Date(inv.createdAt).toLocaleString("ar-SA")}</td>
                    <td style={S.td}>
                      <span style={inv.invoiceNo.startsWith("RET-") ? S.badgeRet : S.badgeOk}>
                        {inv.invoiceNo.startsWith("RET-") ? "مرتجع" : inv.syncStatus}
                      </span>
                    </td>
                    <td style={S.tdRight}>
                      <button onClick={() => pick(inv)} style={S.btnPrimary}
                        disabled={inv.invoiceNo.startsWith("RET-")}>
                        ↩️ إرجاع
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <div style={S.refundCard}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 13, color: "#64748b" }}>إرجاع للفاتورة</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>{picked.inv.invoiceNo}</div>
            </div>
            <button onClick={() => setPicked(null)} style={S.btnGhost}>← اختر فاتورة أخرى</button>
          </div>

          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>الصنف</th>
              <th style={S.th}>السعر</th>
              <th style={S.th}>الكمية الأصلية</th>
              <th style={S.th}>كمية الإرجاع</th>
              <th style={S.thRight}>الإجمالي</th>
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} style={S.tr}>
                  <td style={S.td}>{l.nameAr}</td>
                  <td style={S.tdMono}>{l.unitPrice.toFixed(2)}</td>
                  <td style={S.td}>×{l.qty}</td>
                  <td style={S.td}>
                    <input
                      type="number"
                      min="0" max={l.qty} step="1"
                      value={l.refundQty}
                      onChange={(e) => {
                        const v = Math.max(0, Math.min(l.qty, Number(e.target.value)));
                        setLines((prev) => prev.map((p, j) => j === i ? { ...p, refundQty: v } : p));
                      }}
                      style={S.qtyInput}
                    />
                  </td>
                  <td style={{ ...S.tdRight, fontWeight: 600 }}>
                    {(l.unitPrice * l.refundQty).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={S.totals}>
            <Row k="إجمالي قبل الضريبة" v={totals.sub.toFixed(2)} />
            <Row k="ضريبة 15%" v={totals.vat.toFixed(2)} />
            <Row k="إجمالي المرتجع" v={totals.grand.toFixed(2)} big />
          </div>

          <label style={{ display: "block", marginTop: 16 }}>
            <div style={{ fontSize: 13, color: "#475569", marginBottom: 4 }}>سبب الإرجاع *</div>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="مثلاً: عيب في المنتج، طلب العميل..." style={S.search} />
          </label>

          <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
            <button onClick={submitReturn} disabled={busy} style={S.btnDanger}>
              {busy ? "..." : `↩️ تأكيد المرتجع (${totals.grand.toFixed(2)} ر.س)`}
            </button>
            <button onClick={() => setPicked(null)} style={S.btnGhost}>إلغاء</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v, big }: { k: string; v: string; big?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", fontSize: big ? 18 : 14, fontWeight: big ? 700 : 400, color: big ? "#dc2626" : "#475569", borderTop: big ? "1px solid #e2e8f0" : undefined, marginTop: big ? 8 : 0, paddingTop: big ? 12 : 8 }}>
      <span>{k}</span><span>{v}</span>
    </div>
  );
}

const S = {
  wrap: { maxWidth: 1100, margin: "0 auto", width: "100%" } as const,
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 } as const,
  h2: { margin: 0, fontSize: 22, color: "#0f172a" } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  lastChip: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "6px 12px", borderRadius: 999, fontSize: 12, fontFamily: "ui-monospace, monospace" } as const,
  search: { width: "100%", padding: "10px 14px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 8, marginBottom: 16, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
  empty: { padding: 40, textAlign: "center" as const, color: "#94a3b8", background: "#fff", border: "1px dashed #e2e8f0", borderRadius: 8 } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" } as const,
  th: { textAlign: "right" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  thRight: { textAlign: "left" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  tr: { borderBottom: "1px solid #f1f5f9" } as const,
  td: { padding: "12px 14px", fontSize: 14, color: "#0f172a" } as const,
  tdMono: { padding: "12px 14px", fontSize: 13, color: "#0f172a", fontFamily: "ui-monospace, monospace" } as const,
  tdRight: { padding: "12px 14px", textAlign: "left" as const, fontSize: 14, color: "#0f172a" } as const,
  badgeOk: { display: "inline-block", padding: "2px 8px", background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", borderRadius: 999, fontSize: 12 } as const,
  badgeRet: { display: "inline-block", padding: "2px 8px", background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 999, fontSize: 12 } as const,
  btnPrimary: { padding: "8px 14px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 } as const,
  btnDanger: { padding: "12px 20px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 15, fontWeight: 700 } as const,
  btnGhost: { padding: "8px 14px", background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontSize: 13 } as const,
  refundCard: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 20 } as const,
  totals: { padding: "8px 4px", marginTop: 16 } as const,
  qtyInput: { width: 80, padding: "6px 10px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14 } as const,
  ok: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
};
