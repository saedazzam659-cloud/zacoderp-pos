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
import { isZatcaCountry } from "../lib/zatcaBridge";
import { useTaxSettings, computeTotals } from "../lib/taxSettings";
import { useCurrencySymbol } from "../lib/currency";

const LS_PRINTER = "pos_desktop_peripherals_printer";

type Props = { companyName?: string; vatNumber?: string; cashierName?: string };

export default function ReturnsScreen({ companyName = "ZACOD POS", vatNumber = "300000000000003", cashierName }: Props) {
  const sym = useCurrencySymbol();
  const [invoices, setInvoices] = useState<PendingInvoice[]>([]);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<{ inv: PendingInvoice; payload: OfflineInvoicePayload } | null>(null);
  const [lines, setLines] = useState<Array<{ itemId: number; nameAr: string; unitPrice: number; vatRate: number; qty: number; refundQty: number }>>([]);
  const DEFAULT_RETURN_REASON = "إرجاع من العميل";
  const [reason, setReason] = useState(DEFAULT_RETURN_REASON);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastReturn, setLastReturn] = useState<string | null>(null);
  // Set of original-invoice numbers that already have at least one credit
  // note. Used to disable the إرجاع button and block double-returns.
  const [returnedInvoiceNos, setReturnedInvoiceNos] = useState<Set<string>>(new Set());

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const list = await listAllInvoices(100);
      setInvoices(list);
      setReturnedInvoiceNos(await computeReturnedSet(list));
    } catch { /* ignore */ }
  }

  // Build the "already returned" set by scanning EVERY invoice's payload and
  // matching on payload.kind === "return". We can't rely on the invoiceNo
  // prefix because the Rust-backed saver assigns "OFF-…" to all invoices
  // (returns included); only the browser fallback uses "RET-". Reading
  // payloads is O(N) over `listAllInvoices(100)`, which is fine — and we
  // pre-load the LS array once instead of re-parsing per row.
  async function computeReturnedSet(list: PendingInvoice[]): Promise<Set<string>> {
    const returned = new Set<string>();
    let lsCache: any[] | null = null;
    const lsGet = (id: number): string | undefined => {
      if (!lsCache) {
        try {
          const raw = localStorage.getItem("pos_desktop_invoices_v1");
          lsCache = raw ? JSON.parse(raw) : [];
        } catch { lsCache = []; }
      }
      return lsCache!.find((i) => i.id === id)?.payloadJson;
    };
    for (const inv of list) {
      try {
        const full = await getOfflineInvoice(inv.id);
        const payloadJson = full?.payloadJson ?? lsGet(inv.id);
        if (!payloadJson) continue;
        const p = JSON.parse(payloadJson) as any;
        if (p?.kind === "return" && typeof p.refOf === "string") {
          returned.add(p.refOf);
        }
      } catch { /* skip unreadable payloads */ }
    }
    return returned;
  }

  const filtered = useMemo(() => {
    if (!search) return invoices;
    return invoices.filter((i) =>
      i.invoiceNo.toLowerCase().includes(search.toLowerCase()),
    );
  }, [invoices, search]);

  async function pick(inv: PendingInvoice) {
    setToast(null);
    // Guard #1: never let a credit note get a credit note.
    if (inv.invoiceNo.startsWith("RET-")) {
      setToast({ kind: "err", text: "لا يمكن إرجاع فاتورة مرتجع" });
      return;
    }
    // Guard #2: one credit note per original invoice — re-check at click time
    // in case another tab/operation created one since the last refresh.
    if (returnedInvoiceNos.has(inv.invoiceNo)) {
      setToast({ kind: "err", text: `سبق إرجاع الفاتورة ${inv.invoiceNo} — غير مسموح بمرتجع آخر عليها` });
      return;
    }
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
        itemId: l.itemId, nameAr: l.nameAr, unitPrice: l.unitPrice, vatRate: l.vatRate,
        qty: l.qty, refundQty: l.qty,
      })));
    } catch (e: any) {
      setToast({ kind: "err", text: e?.message ?? "فشل تحميل الفاتورة" });
    }
  }

  const { rate: vatRatePct, mode: taxMode } = useTaxSettings();
  const totals = useMemo(() => {
    const raw = lines.reduce((s, l) => s + l.unitPrice * l.refundQty, 0);
    const t = computeTotals(raw, vatRatePct, taxMode);
    return { sub: t.subtotal, vat: t.vat, grand: t.grandTotal };
  }, [lines, vatRatePct, taxMode]);

  async function submitReturn() {
    if (!picked) return;
    const refundLines = lines.filter((l) => l.refundQty > 0);
    if (refundLines.length === 0) { setToast({ kind: "err", text: "حدد كمية على الأقل لإرجاعها" }); return; }
    // Reason defaults to DEFAULT_RETURN_REASON on mount; only block if user
    // explicitly cleared it.
    const finalReason = reason.trim() || DEFAULT_RETURN_REASON;
    // Printer is OPTIONAL — record the return either way. We try to print
    // only if a printer is configured; failure to print does not roll back
    // the saved return.
    const printer = localStorage.getItem(LS_PRINTER);

    setBusy(true); setToast(null);
    try {
      // Submit-side re-check: another return for this invoice may have been
      // created between pick() and submit (different tab, resumed session,
      // race). Re-scan ground truth before persisting to avoid double credit
      // notes. The button-disable in the list is UI-only and bypassable.
      const freshList = await listAllInvoices(100);
      const freshReturned = await computeReturnedSet(freshList);
      if (freshReturned.has(picked.inv.invoiceNo)) {
        setToast({ kind: "err", text: `سبق إرجاع الفاتورة ${picked.inv.invoiceNo} — لا يمكن إنشاء مرتجع آخر` });
        setReturnedInvoiceNos(freshReturned);
        setBusy(false);
        return;
      }
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
        reason: finalReason,
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
      const reasonKey = finalReason.slice(0, 32).replace(/\s+/g, "_");
      const key = `ret-${picked.inv.id}-${reasonKey}-${shape}`;
      const saved = await saveOfflineInvoice(payload, qr ?? undefined, undefined, key);

      // Restock local inventory for tracked items (no-op for untracked, and
      // for items whose original sale carried itemId=0 — older returns or
      // walk-in lines without a catalog match). Tied to the idempotency key
      // by being a one-shot after the invoice persists.
      try {
        const { adjustStockShared } = await import("../lib/stock");
        for (const l of refundLines) {
          if (l.itemId > 0) await adjustStockShared(l.itemId, l.refundQty);
        }
      } catch { /* non-fatal */ }

      const body: ReceiptLine[] = [];
      for (const l of refundLines) {
        body.push({ text: `${l.nameAr.padEnd(20, " ")} ×${l.refundQty}  ${(l.unitPrice * l.refundQty).toFixed(2)}` });
      }
      body.push({ text: "─".repeat(32) });
      body.push({ text: `إجمالي المرتجع قبل الضريبة:  ${totals.sub.toFixed(2)}` });
      body.push({ text: `الضريبة المسترجعة:           ${totals.vat.toFixed(2)}` });
      body.push({ text: `الإجمالي المسترجع:            ${totals.grand.toFixed(2)}`, bold: true });
      body.push({ text: `السبب: ${finalReason}` });
      body.push({ text: `فاتورة أصلية: ${picked.inv.invoiceNo}` });

      // Print only when a printer is configured. Any print error is logged
      // to the toast but does NOT undo the saved return.
      let printWarn: string | null = null;
      if (printer) {
        try {
          await printReceipt({
            printerName: printer,
            header: [
              { text: companyName, bold: true, center: true },
              { text: `الرقم الضريبي: ${vatNumber}`, center: true },
              { text: `*** إشعار دائن — مرتجع ***`, bold: true, center: true },
              { text: `رقم: ${saved.invoiceNo}`, center: true },
              { text: new Date(ts).toLocaleString("ar-SA"), center: true },
              ...(cashierName ? [{ text: `الكاشير: ${cashierName}`, center: true }] : []),
            ],
            body,
            footer: [{ text: "شكراً لزيارتكم", center: true }],
            qrData: isZatcaCountry() ? qr : undefined,
            cut: true,
            openDrawer: payload.paymentMethod === "cash",
          });
        } catch (pe: any) {
          printWarn = `(تعذرت الطباعة: ${pe?.message ?? pe})`;
        }
      } else {
        printWarn = "(لا توجد طابعة مهيأة — تم الحفظ بدون طباعة)";
      }

      setLastReturn(saved.invoiceNo);
      setPicked(null); setLines([]); setReason(DEFAULT_RETURN_REASON);
      setToast({ kind: "ok", text: `✅ تم تسجيل المرتجع — ${saved.invoiceNo}${printWarn ? " " + printWarn : ""}` });
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
                {filtered.map((inv) => {
                  const isReturn = inv.invoiceNo.startsWith("RET-");
                  const alreadyReturned = returnedInvoiceNos.has(inv.invoiceNo);
                  const blocked = isReturn || alreadyReturned;
                  return (
                    <tr key={inv.id} style={S.tr}>
                      <td style={S.tdMono}>{inv.invoiceNo}</td>
                      <td style={S.td}>{new Date(inv.createdAt).toLocaleString("ar-SA")}</td>
                      <td style={S.td}>
                        <span style={isReturn ? S.badgeRet : alreadyReturned ? S.badgeRet : S.badgeOk}>
                          {isReturn ? "مرتجع" : alreadyReturned ? "تم إرجاعها" : inv.syncStatus}
                        </span>
                      </td>
                      <td style={S.tdRight}>
                        <button
                          onClick={() => pick(inv)}
                          style={blocked ? { ...S.btnPrimary, opacity: 0.45, cursor: "not-allowed" } : S.btnPrimary}
                          disabled={blocked}
                          title={alreadyReturned ? "سبق إرجاع هذه الفاتورة — مرتجع واحد فقط مسموح" : isReturn ? "لا يمكن إرجاع فاتورة مرتجع" : "إرجاع"}
                        >
                          ↩️ إرجاع
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <div style={S.refundCard}>
          {/* Header — gradient + invoice chip */}
          <div style={S.refundHeader}>
            <div>
              <div style={S.refundEyebrow}>↩️ إرجاع للفاتورة</div>
              <div style={S.refundInvNo}>{picked.inv.invoiceNo}</div>
              <div style={S.refundMeta}>
                {lines.length} صنف · {lines.filter((l) => l.refundQty > 0).length} محدد للإرجاع
              </div>
            </div>
            <button onClick={() => setPicked(null)} style={S.btnGhost}>← اختر فاتورة أخرى</button>
          </div>

          {/* Scrollable lines area — internal scroll keeps totals + button always visible */}
          <div style={S.linesScroll}>
            <table style={S.tableLines}>
              <thead style={S.theadSticky}><tr>
                <th style={S.th}>الصنف</th>
                <th style={S.th}>السعر</th>
                <th style={S.th}>الكمية الأصلية</th>
                <th style={S.th}>كمية الإرجاع</th>
                <th style={S.thRight}>الإجمالي</th>
              </tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const isActive = l.refundQty > 0;
                  return (
                    <tr key={i} style={{ ...S.tr, background: isActive ? "#fff7ed" : (i % 2 ? "#fafafa" : "#fff") }}>
                      <td style={{ ...S.td, fontWeight: isActive ? 600 : 400 }}>{l.nameAr}</td>
                      <td style={S.tdMono}>{l.unitPrice.toFixed(2)}</td>
                      <td style={{ ...S.td, color: "#64748b" }}>×{l.qty}</td>
                      <td style={S.td}>
                        <div style={S.stepperWrap}>
                          <button
                            type="button"
                            onClick={() => {
                              const v = Math.max(0, l.refundQty - 1);
                              setLines((prev) => prev.map((p, j) => j === i ? { ...p, refundQty: v } : p));
                            }}
                            style={S.stepBtn}
                            disabled={l.refundQty <= 0}
                            title="إنقاص"
                          >−</button>
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
                          <button
                            type="button"
                            onClick={() => {
                              const v = Math.min(l.qty, l.refundQty + 1);
                              setLines((prev) => prev.map((p, j) => j === i ? { ...p, refundQty: v } : p));
                            }}
                            style={S.stepBtn}
                            disabled={l.refundQty >= l.qty}
                            title="زيادة"
                          >+</button>
                        </div>
                      </td>
                      <td style={{ ...S.tdRight, fontWeight: 700, color: isActive ? "#dc2626" : "#94a3b8", fontFamily: "ui-monospace, monospace" }}>
                        {(l.unitPrice * l.refundQty).toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pinned bottom: totals + reason + actions — never hidden by long lists */}
          <div style={S.pinnedFooter}>
            <div style={S.totals}>
              <Row k="إجمالي قبل الضريبة" v={totals.sub.toFixed(2)} />
              <Row k={`ضريبة ${vatRatePct}%${taxMode === "inclusive" ? " (شاملة)" : ""}`} v={totals.vat.toFixed(2)} />
              <Row k="إجمالي المرتجع" v={totals.grand.toFixed(2)} big />
            </div>

            <label style={{ display: "block", marginTop: 8 }}>
              <div style={{ fontSize: 13, color: "#475569", marginBottom: 4, fontWeight: 600 }}>
                سبب الإرجاع <span style={{ fontWeight: 400, color: "#94a3b8" }}>(يمكن تعديله)</span>
              </div>
              <input value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="مثلاً: عيب في المنتج، طلب العميل..." style={S.search} />
            </label>

            <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
              <button onClick={submitReturn} disabled={busy || totals.grand <= 0} style={{ ...S.btnDanger, opacity: (busy || totals.grand <= 0) ? 0.5 : 1, cursor: (busy || totals.grand <= 0) ? "not-allowed" : "pointer" }}>
                {busy ? "..." : `↩️ تأكيد المرتجع (${totals.grand.toFixed(2)} ${sym})`}
              </button>
              <button onClick={() => setPicked(null)} style={S.btnGhost}>إلغاء</button>
            </div>
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
  wrap: { maxWidth: 1100, margin: "0 auto", width: "100%", padding: "8px 4px 24px" } as const,
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 16 } as const,
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
  refundCard: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, boxShadow: "0 4px 20px rgba(15,23,42,0.06)", overflow: "hidden" } as const,
  refundHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: 20, gap: 16, background: "linear-gradient(135deg, #fef2f2 0%, #fff5f5 100%)", borderBottom: "1px solid #fee2e2" } as const,
  refundEyebrow: { fontSize: 12, color: "#dc2626", fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase" as const } as const,
  refundInvNo: { fontSize: 22, fontWeight: 800, fontFamily: "ui-monospace, monospace", color: "#0f172a", marginTop: 4, letterSpacing: 0.5 } as const,
  refundMeta: { fontSize: 12, color: "#64748b", marginTop: 6 } as const,
  linesScroll: { padding: "0 20px" } as const,
  tableLines: { width: "100%", borderCollapse: "collapse" as const } as const,
  theadSticky: { background: "#f8fafc", boxShadow: "0 1px 0 #e2e8f0" } as const,
  pinnedFooter: { padding: "12px 20px 16px", borderTop: "1px solid #e2e8f0", background: "#fff" } as const,
  totals: { padding: "4px 4px", marginTop: 0 } as const,
  qtyInput: { width: 56, padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, textAlign: "center" as const, fontWeight: 600, fontFamily: "ui-monospace, monospace" } as const,
  stepperWrap: { display: "inline-flex", alignItems: "center", gap: 4 } as const,
  stepBtn: { width: 28, height: 28, padding: 0, border: "1px solid #cbd5e1", background: "#f8fafc", color: "#0f172a", borderRadius: 6, cursor: "pointer", fontSize: 16, fontWeight: 700, lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center" } as const,
  ok: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
};
