// Minimal sales screen (Step 10 of Task #174 — first slice).
//
// Goals:
//   - Functional end-to-end: pick item → add to cart → checkout → print receipt + open drawer
//   - Wires together: peripherals module (print), zatca module (TLV QR), barcode scanner hook
//   - Uses hardcoded sample items until SQLite layer is connected (later in Step 10)
//
// Notes:
//   - VAT = 15% standard, applied to displayed prices as INCLUSIVE (typical Saudi retail)
//   - Receipt mirrors the ZATCA Phase-1 simplified invoice fields
//   - "Cash" payment opens the drawer; "Card" does not

import { useEffect, useMemo, useState } from "react";
import { printReceipt, openCashDrawer, type ReceiptLine } from "../lib/peripherals";
import { generateZatcaQr } from "../lib/zatca";
import { listItems, findItemByBarcode, seedDemoItems, type LocalItem } from "../lib/items";
import { saveOfflineInvoice, type OfflineInvoicePayload } from "../lib/invoices";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";

const VAT_RATE = 0.15;
const LS_PRINTER = "pos_desktop_peripherals_printer";

interface CartLine { item: LocalItem; qty: number; }

type Props = { companyName?: string; vatNumber?: string };

export default function SalesScreen({ companyName = "ZACOD POS", vatNumber = "300000000000003" }: Props) {
  const [cart, setCart] = useState<CartLine[]>([]);
  // Idempotency key for the current cart. Generated lazily on first checkout
  // attempt; cleared when the cart is cleared (after a successful sale or
  // explicit reset). A retried checkout for the same cart reuses the same key
  // so save_offline_invoice returns the existing row instead of duplicating.
  const [checkoutKey, setCheckoutKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<LocalItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [paying, setPaying] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastInvoice, setLastInvoice] = useState<string | null>(null);

  // ─── Catalog loading ─────────────────────────────────────────────────
  // Seed on mount once (fire-and-forget); the search effect below is the
  // SINGLE source of truth for what's in `items` — that prevents a slow mount
  // fetch from overwriting the result of a fast user search (architect-flagged
  // race condition). A monotonically-increasing request id guards against
  // out-of-order responses when two search edits land back-to-back.
  useEffect(() => { void seedDemoItems().catch(() => {}); }, []);

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const rows = await listItems(search || undefined);
        if (!cancelled) setItems(rows);
      } catch (e: any) {
        if (!cancelled && loadingItems) {
          setMsg({ kind: "err", text: `تعذّر تحميل الأصناف: ${e?.message ?? e}` });
        }
        // keep previous list on transient failure mid-session
      } finally {
        if (!cancelled) setLoadingItems(false);
      }
    }, search ? 150 : 0); // initial empty-search load fires immediately
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  useBarcodeScanner({
    onScan: async (code) => {
      try {
        const found = await findItemByBarcode(code);
        if (found) addToCart(found);
        else setMsg({ kind: "err", text: `لم يُعثر على باركود: ${code}` });
      } catch (e: any) {
        setMsg({ kind: "err", text: `خطأ في البحث: ${e?.message ?? e}` });
      }
    },
  });

  const totals = useMemo(() => {
    const grandTotal = cart.reduce((sum, l) => sum + l.item.salePrice * l.qty, 0);
    const subtotal = grandTotal / (1 + VAT_RATE);
    const vat = grandTotal - subtotal;
    return { subtotal, vat, grandTotal };
  }, [cart]);

  function addToCart(item: LocalItem) {
    setMsg(null);
    setCart((prev) => {
      const existing = prev.find((l) => l.item.id === item.id);
      if (existing) return prev.map((l) => l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l);
      return [...prev, { item, qty: 1 }];
    });
  }

  function changeQty(itemId: number, delta: number) {
    setCart((prev) => prev
      .map((l) => l.item.id === itemId ? { ...l, qty: l.qty + delta } : l)
      .filter((l) => l.qty > 0));
  }

  function removeLine(itemId: number) {
    setCart((prev) => {
      const next = prev.filter((l) => l.item.id !== itemId);
      if (next.length === 0) setCheckoutKey(null);
      return next;
    });
  }

  async function checkout(paymentMethod: "cash" | "card") {
    if (cart.length === 0) return;
    const printer = localStorage.getItem(LS_PRINTER);
    if (!printer) {
      setMsg({ kind: "err", text: "لم يتم تكوين طابعة. افتح ‹الأجهزة الطرفية› أولاً." });
      return;
    }

    setPaying(true); setMsg(null);
    try {
      const ts = new Date().toISOString();

      // 1) ZATCA QR first — cheapest step, no side effects.
      const qr = await generateZatcaQr({
        sellerName: companyName,
        vatNumber,
        timestamp: ts,
        invoiceTotal: totals.grandTotal.toFixed(2),
        vatTotal: totals.vat.toFixed(2),
      });

      // 2) Persist BEFORE printing. If save fails we abort the whole flow —
      //    we must never print a receipt the system can't track (would be
      //    invisible to the cloud push and break audit). If print later
      //    fails, the row is still safely in `offline_invoices` and can be
      //    reprinted from the pending queue (TODO: reprint UI).
      const payload: OfflineInvoicePayload = {
        vatNumber,
        paymentMethod,
        timestamp: ts,
        subtotal: Number(totals.subtotal.toFixed(2)),
        vat: Number(totals.vat.toFixed(2)),
        grandTotal: Number(totals.grandTotal.toFixed(2)),
        lines: cart.map((l) => ({
          itemId: l.item.id,
          nameAr: l.item.nameAr,
          qty: l.qty,
          unitPrice: l.item.salePrice,
          vatRate: l.item.vatRate,
        })),
      };
      // Reuse the cart's idempotency key across retries; generate once.
      let key = checkoutKey;
      if (!key) {
        key = (crypto as any).randomUUID?.() ??
          `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        setCheckoutKey(key);
      }
      const saved = await saveOfflineInvoice(payload, qr ?? undefined, undefined, key!);
      const invNum = saved.invoiceNo;

      const body: ReceiptLine[] = [];
      for (const l of cart) {
        const lineTotal = (l.item.salePrice * l.qty).toFixed(2);
        body.push({ text: `${l.item.nameAr.padEnd(20, " ")} ×${l.qty}  ${lineTotal}` });
      }
      body.push({ text: "─".repeat(32) });
      body.push({ text: `المجموع قبل الضريبة:  ${totals.subtotal.toFixed(2)}` });
      body.push({ text: `ضريبة القيمة المضافة: ${totals.vat.toFixed(2)}` });
      body.push({ text: `الإجمالي:             ${totals.grandTotal.toFixed(2)}`, bold: true });
      body.push({ text: `طريقة الدفع: ${paymentMethod === "cash" ? "نقداً" : "بطاقة"}` });

      await printReceipt({
        printerName: printer,
        header: [
          { text: companyName, bold: true, center: true },
          { text: `الرقم الضريبي: ${vatNumber}`, center: true },
          { text: `فاتورة #${invNum}`, center: true },
          { text: new Date(ts).toLocaleString("ar-SA"), center: true },
        ],
        body,
        footer: [
          { text: "شكراً لزيارتكم", center: true },
        ],
        qrData: qr,
        cut: true,
        openDrawer: paymentMethod === "cash",
      });

      // Belt-and-braces: even if openDrawer flag failed silently, kick again
      // for cash so the cashier never gets stuck. No-op for card.
      if (paymentMethod === "cash") {
        try { await openCashDrawer(printer); } catch { /* ignore */ }
      }

      setLastInvoice(invNum);
      setCart([]);
      setCheckoutKey(null); // fresh key for the next cart
      setMsg({ kind: "ok", text: `✅ تم إنهاء البيع — فاتورة ${invNum}` });
    } catch (e: any) {
      setMsg({ kind: "err", text: `فشل إنهاء البيع: ${e?.message ?? e}` });
    } finally {
      setPaying(false);
    }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      {/* ─── Items grid ────────────────────────────────────────── */}
      <div style={S.itemsPane}>
        <input
          placeholder="بحث بالاسم أو الباركود... (أو امسح باركود)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={S.search}
          data-allow-scan="true"
        />
        <div style={S.grid}>
          {loadingItems && items.length === 0 ? (
            <div style={S.empty}>... جاري تحميل الأصناف</div>
          ) : items.length === 0 ? (
            <div style={S.empty}>لا توجد أصناف مطابقة</div>
          ) : (
            items.map((item) => (
              <button key={item.id} onClick={() => addToCart(item)} style={S.itemCard}>
                <div style={S.itemName}>{item.nameAr}</div>
                <div style={S.itemPrice}>{item.salePrice.toFixed(2)} ر.س</div>
                <div style={S.itemBarcode}>{item.barcode ?? ""}</div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ─── Cart sidebar ──────────────────────────────────────── */}
      <aside style={S.cartPane}>
        <h2 style={S.cartTitle}>السلة</h2>
        {cart.length === 0 ? (
          <div style={S.empty}>السلة فارغة — اضغط على صنف أو امسح باركود</div>
        ) : (
          <div style={S.lines}>
            {cart.map((l) => (
              <div key={l.item.id} style={S.line}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, color: "#0f172a" }}>{l.item.nameAr}</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    {l.item.salePrice.toFixed(2)} × {l.qty} = {(l.item.salePrice * l.qty).toFixed(2)}
                  </div>
                </div>
                <div style={S.qtyControls}>
                  <button onClick={() => changeQty(l.item.id, -1)} style={S.qtyBtn}>−</button>
                  <span style={{ minWidth: 24, textAlign: "center" }}>{l.qty}</span>
                  <button onClick={() => changeQty(l.item.id, +1)} style={S.qtyBtn}>+</button>
                  <button onClick={() => removeLine(l.item.id)} style={{ ...S.qtyBtn, color: "#dc2626", marginInlineStart: 6 }}>×</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={S.totals}>
          <Row k="قبل الضريبة" v={totals.subtotal.toFixed(2)} />
          <Row k="ضريبة 15%" v={totals.vat.toFixed(2)} />
          <Row k="الإجمالي" v={totals.grandTotal.toFixed(2)} big />
        </div>

        <div style={S.payRow}>
          <button onClick={() => checkout("cash")} disabled={paying || cart.length === 0} style={S.payCash}>
            {paying ? "..." : "💵 نقداً"}
          </button>
          <button onClick={() => checkout("card")} disabled={paying || cart.length === 0} style={S.payCard}>
            {paying ? "..." : "💳 بطاقة"}
          </button>
        </div>

        {msg && (
          <div style={msg.kind === "ok" ? S.msgOk : S.msgErr}>{msg.text}</div>
        )}
        {lastInvoice && !msg && (
          <div style={S.lastInv}>آخر فاتورة: {lastInvoice}</div>
        )}
      </aside>
    </div>
  );
}

function Row({ k, v, big }: { k: string; v: string; big?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: big ? 18 : 14, fontWeight: big ? 700 : 400, color: big ? "#0f172a" : "#475569", borderTop: big ? "1px solid #e2e8f0" : undefined, marginTop: big ? 8 : 0, paddingTop: big ? 12 : 6 }}>
      <span>{k}</span><span>{v}</span>
    </div>
  );
}

const S = {
  wrap: { display: "flex", gap: 16, height: "calc(100vh - 32px)", padding: 16, fontFamily: "'Segoe UI', system-ui, sans-serif", background: "#f1f5f9" } as const,
  itemsPane: { flex: 1, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 } as const,
  search: { padding: "12px 16px", fontSize: 15, border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit" } as const,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, overflowY: "auto", padding: 4 } as const,
  itemCard: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, cursor: "pointer", textAlign: "right" as const, fontFamily: "inherit", display: "flex", flexDirection: "column" as const, gap: 6, transition: "transform .08s", minHeight: 90 } as const,
  itemName: { fontSize: 14, fontWeight: 600, color: "#0f172a" } as const,
  itemPrice: { fontSize: 16, color: "#2563eb", fontWeight: 700 } as const,
  itemBarcode: { fontSize: 10, color: "#94a3b8", fontFamily: "ui-monospace, monospace" } as const,
  cartPane: { width: 360, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 } as const,
  cartTitle: { margin: 0, fontSize: 18, color: "#0f172a" } as const,
  empty: { padding: 24, color: "#94a3b8", fontSize: 13, textAlign: "center" as const, border: "1px dashed #cbd5e1", borderRadius: 8 } as const,
  lines: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" as const, gap: 8 } as const,
  line: { display: "flex", gap: 8, padding: 10, background: "#f8fafc", borderRadius: 8, alignItems: "center" } as const,
  qtyControls: { display: "flex", alignItems: "center", gap: 4 } as const,
  qtyBtn: { width: 28, height: 28, border: "1px solid #cbd5e1", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 16, lineHeight: 1 } as const,
  totals: { padding: "8px 4px" } as const,
  payRow: { display: "flex", gap: 8 } as const,
  payCash: { flex: 1, padding: "14px 16px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 16, fontWeight: 700 } as const,
  payCard: { flex: 1, padding: "14px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 16, fontWeight: 700 } as const,
  msgOk: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, fontSize: 13 } as const,
  msgErr: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, fontSize: 13 } as const,
  lastInv: { fontSize: 12, color: "#94a3b8", textAlign: "center" as const } as const,
};
