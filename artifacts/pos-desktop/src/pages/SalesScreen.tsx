// Sales screen — fully redesigned for Windows desktop usage.
//
// Layout invariant (architect-flagged): payment buttons MUST stay fixed at
// the bottom of the cart pane and never scroll with the items list. The
// cartPane is a flex column with `lines` as the only scrolling region;
// `totals` + `payRow` are pinned at the bottom (flex-shrink:0).

import { useEffect, useMemo, useState } from "react";
import { printReceipt, openCashDrawer, type ReceiptLine } from "../lib/peripherals";
import { generateZatcaQr } from "../lib/zatca";
import { listItems, findItemByBarcode, seedDemoItems, type LocalItem } from "../lib/items";
import { saveOfflineInvoice, type OfflineInvoicePayload } from "../lib/invoices";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import {
  saveParkedCart, listParkedCarts, deleteParkedCart, takeResumeCartId,
  type ParkedCart,
} from "../lib/parkedCarts";

const VAT_RATE = 0.15;
const LS_PRINTER = "pos_desktop_peripherals_printer";

interface CartLine { item: LocalItem; qty: number; }

type Props = { companyName?: string; vatNumber?: string; posSessionId?: number };

export default function SalesScreen({ companyName = "ZACOD POS", vatNumber = "300000000000003", posSessionId = 0 }: Props) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [checkoutKey, setCheckoutKey] = useState<string | null>(null);
  // When non-null, the current cart in state was resumed from this parked
  // cart id. Saving (park again) overwrites the same row; completing the
  // checkout deletes it.
  const [activeParkedId, setActiveParkedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<LocalItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [paying, setPaying] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastInvoice, setLastInvoice] = useState<string | null>(null);

  useEffect(() => { void seedDemoItems().catch(() => {}); }, []);

  // ─── Resume handoff from ParkedCarts page ─────────────────────────
  // ParkedCarts writes the id into sessionStorage and switches view;
  // we read+consume it on mount and hydrate the cart state.
  useEffect(() => {
    const id = takeResumeCartId();
    if (!id || !posSessionId) return;
    (async () => {
      try {
        const all = await listParkedCarts(posSessionId);
        const c = all.find(x => x.id === id);
        if (!c) { setMsg({ kind: "err", text: "تعذّر استئناف السلة (غير موجودة)" }); return; }
        // Hydrate cart from parked lines. We synthesize a LocalItem for each
        // line — only the fields the UI/checkout pipeline reads (id, nameAr,
        // salePrice, vatRate, barcode) are needed downstream.
        const lines: CartLine[] = c.lines.map(l => ({
          item: {
            id: l.itemId, nameAr: l.nameAr, salePrice: l.salePrice,
            vatRate: l.vatRate, barcode: l.barcode ?? null,
            code: "", nameEn: null, updatedAt: null,
          } as unknown as LocalItem,
          qty: l.qty,
        }));
        setCart(lines);
        setActiveParkedId(c.id);
        setMsg({ kind: "ok", text: `✅ تم استئناف "${c.label}"` });
      } catch (e: any) {
        setMsg({ kind: "err", text: `تعذّر الاستئناف: ${e?.message ?? e}` });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posSessionId]);

  async function parkCart() {
    if (cart.length === 0) return;
    if (!posSessionId) {
      setMsg({ kind: "err", text: "تعليق السلة يتطلب وردية مفتوحة. سجّل دخول من شاشة الكاشير أولاً." });
      return;
    }
    const defaultLabel = activeParkedId
      ? undefined
      : `سلة ${new Date().toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}`;
    const label = prompt("اسم السلة (اختياري):", defaultLabel ?? "") ?? defaultLabel;
    try {
      const saved = await saveParkedCart({
        id: activeParkedId ?? undefined,
        posSessionId,
        label: label || undefined,
        lines: cart.map(l => ({
          itemId: l.item.id, nameAr: l.item.nameAr,
          salePrice: l.item.salePrice, vatRate: l.item.vatRate,
          barcode: l.item.barcode ?? null, qty: l.qty,
        })),
      });
      setCart([]); setCheckoutKey(null); setActiveParkedId(null);
      setMsg({ kind: "ok", text: `📌 تم تعليق "${saved.label}" — افتحها من شاشة "المعلّقة"` });
    } catch (e: any) {
      setMsg({ kind: "err", text: `فشل تعليق السلة: ${e?.message ?? e}` });
    }
  }

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
      } finally {
        if (!cancelled) setLoadingItems(false);
      }
    }, search ? 150 : 0);
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
    return { subtotal, vat: grandTotal - subtotal, grandTotal };
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
      setMsg({ kind: "err", text: "لم يتم تكوين طابعة. افتح ‹الأجهزة الطرفية› من لوحة التحكم أولاً." });
      return;
    }
    setPaying(true); setMsg(null);
    try {
      const ts = new Date().toISOString();
      const qr = await generateZatcaQr({
        sellerName: companyName, vatNumber, timestamp: ts,
        invoiceTotal: totals.grandTotal.toFixed(2),
        vatTotal: totals.vat.toFixed(2),
      });
      const payload: OfflineInvoicePayload = {
        vatNumber, paymentMethod, timestamp: ts,
        subtotal: Number(totals.subtotal.toFixed(2)),
        vat: Number(totals.vat.toFixed(2)),
        grandTotal: Number(totals.grandTotal.toFixed(2)),
        lines: cart.map((l) => ({
          itemId: l.item.id, nameAr: l.item.nameAr,
          qty: l.qty, unitPrice: l.item.salePrice, vatRate: l.item.vatRate,
        })),
      };
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
        body.push({ text: `${l.item.nameAr.padEnd(20, " ")} ×${l.qty}  ${(l.item.salePrice * l.qty).toFixed(2)}` });
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
        footer: [{ text: "شكراً لزيارتكم", center: true }],
        qrData: qr, cut: true,
        openDrawer: paymentMethod === "cash",
      });
      if (paymentMethod === "cash") {
        try { await openCashDrawer(printer); } catch { /* ignore */ }
      }
      // If this cart was resumed from a parked one, remove the parked row
      // now that it has become a finalized sale.
      if (activeParkedId) {
        try { await deleteParkedCart(activeParkedId); } catch { /* non-fatal */ }
      }
      setLastInvoice(invNum);
      setCart([]); setCheckoutKey(null); setActiveParkedId(null);
      setMsg({ kind: "ok", text: `✅ تم إنهاء البيع — فاتورة ${invNum}` });
    } catch (e: any) {
      setMsg({ kind: "err", text: `فشل إنهاء البيع: ${e?.message ?? e}` });
    } finally { setPaying(false); }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <style>{`
        .cart-scroll::-webkit-scrollbar { width: 10px; }
        .cart-scroll::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 8px; margin: 4px; }
        .cart-scroll::-webkit-scrollbar-thumb { background: linear-gradient(180deg,#3b82f6,#2563eb); border-radius: 8px; border: 2px solid #f1f5f9; }
        .cart-scroll::-webkit-scrollbar-thumb:hover { background: linear-gradient(180deg,#2563eb,#1d4ed8); }
        .cart-scroll { scrollbar-width: thin; scrollbar-color: #2563eb #f1f5f9; }
        .grid-scroll::-webkit-scrollbar { width: 10px; }
        .grid-scroll::-webkit-scrollbar-track { background: transparent; }
        .grid-scroll::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 8px; }
        .grid-scroll::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
      `}</style>
      {/* ─── Items grid (left wide pane) ────────────────────────── */}
      <div style={S.itemsPane}>
        <div style={S.searchRow}>
          <input
            placeholder="🔍 بحث بالاسم أو الباركود... (أو امسح باركود)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={S.search}
            data-allow-scan="true"
          />
          <div style={S.countChip}>{items.length} صنف</div>
        </div>

        {/* The ONLY scroll region in the items pane */}
        <div className="grid-scroll" style={S.gridScroll}>
          <div style={S.grid}>
            {loadingItems && items.length === 0 ? (
              <div style={S.empty}>... جاري تحميل الأصناف</div>
            ) : items.length === 0 ? (
              <div style={S.empty}>
                <div style={{ fontSize: 16, marginBottom: 6 }}>لا توجد أصناف</div>
                <div style={{ fontSize: 13 }}>اسحب من السحابة (لوحة التحكم → Pull) أو أضف صنف يدوياً من شاشة "أصناف"</div>
              </div>
            ) : (
              items.map((item) => (
                <button key={item.id} onClick={() => addToCart(item)} style={S.itemCard}>
                  <div style={S.itemName}>{item.nameAr}</div>
                  <div style={S.itemPrice}>{item.salePrice.toFixed(2)} <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 400 }}>ر.س</span></div>
                  {item.barcode && <div style={S.itemBarcode}>{item.barcode}</div>}
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ─── Cart pane — fixed-width column with sticky bottom ─── */}
      <aside style={S.cartPane}>
        <div style={S.cartHeader}>
          <h2 style={S.cartTitle}>
            🛒 السلة{activeParkedId && <span style={S.resumedBadge}>مستأنفة</span>}
          </h2>
          {cart.length > 0 && (
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={parkCart} style={S.parkBtn} title="تعليق السلة وحفظها للعودة لاحقاً">
                📌 تعليق
              </button>
              <button onClick={() => { setCart([]); setCheckoutKey(null); setActiveParkedId(null); }} style={S.clearBtn}>
                مسح
              </button>
            </div>
          )}
        </div>

        {/* Scrolling lines region — flex:1 takes all remaining vertical space */}
        <div className="cart-scroll" style={S.linesScroll}>
          {cart.length === 0 ? (
            <div style={S.cartEmpty}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>🛍️</div>
              <div>السلة فارغة</div>
              <div style={{ fontSize: 12, marginTop: 6, color: "#94a3b8" }}>اضغط على صنف أو امسح باركود</div>
            </div>
          ) : (
            <div style={S.lines}>
              {cart.map((l) => (
                <div key={l.item.id} style={S.line}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: "#0f172a", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.item.nameAr}</div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                      {l.item.salePrice.toFixed(2)} × {l.qty} = <strong style={{ color: "#0f172a" }}>{(l.item.salePrice * l.qty).toFixed(2)}</strong>
                    </div>
                  </div>
                  <div style={S.qtyControls}>
                    <button onClick={() => changeQty(l.item.id, -1)} style={S.qtyBtn}>−</button>
                    <span style={{ minWidth: 28, textAlign: "center", fontWeight: 600 }}>{l.qty}</span>
                    <button onClick={() => changeQty(l.item.id, +1)} style={S.qtyBtn}>+</button>
                    <button onClick={() => removeLine(l.item.id)} style={{ ...S.qtyBtn, color: "#dc2626", borderColor: "#fecaca", marginInlineStart: 6 }}>×</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ─── STICKY FOOTER ─ totals + payment buttons ─── */}
        <div style={S.footer}>
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
        </div>
      </aside>
    </div>
  );
}

function Row({ k, v, big }: { k: string; v: string; big?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between",
      padding: big ? "10px 0 0" : "4px 0",
      fontSize: big ? 20 : 13,
      fontWeight: big ? 700 : 400,
      color: big ? "#0f172a" : "#64748b",
      borderTop: big ? "1px solid #e2e8f0" : undefined,
      marginTop: big ? 6 : 0,
    }}>
      <span>{k}</span><span>{v}</span>
    </div>
  );
}

const S = {
  // CRITICAL: full viewport row, NO vertical scroll on the outer container —
  // the only scrolling regions are `gridScroll` (items grid) and `linesScroll`
  // (cart lines). The cart's footer is pinned via flex layout.
  wrap: {
    display: "flex", gap: 16,
    height: "100%", maxHeight: "100%", minHeight: 0,
    padding: 16, background: "#f1f5f9",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    overflow: "hidden",
    boxSizing: "border-box" as const,
  } as const,

  // Items pane: column with search row on top + scrolling grid below
  itemsPane: { flex: 1, display: "flex", flexDirection: "column" as const, gap: 12, minWidth: 0, minHeight: 0 } as const,
  searchRow: { display: "flex", gap: 12, alignItems: "center", flexShrink: 0 } as const,
  search: { flex: 1, padding: "12px 16px", fontSize: 15, border: "1px solid #cbd5e1", borderRadius: 10, fontFamily: "inherit", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.04)" } as const,
  countChip: { padding: "8px 14px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 999, fontSize: 13, color: "#475569", fontWeight: 600, whiteSpace: "nowrap" as const } as const,
  gridScroll: { flex: 1, overflowY: "auto" as const, overflowX: "hidden" as const, minHeight: 0, maxHeight: "100%" } as const,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))", gap: 12, padding: 4 } as const,
  empty: { gridColumn: "1 / -1", padding: 40, color: "#94a3b8", fontSize: 14, textAlign: "center" as const, border: "1px dashed #cbd5e1", borderRadius: 10, background: "#fff" } as const,
  itemCard: {
    background: "linear-gradient(180deg, #fff 0%, #f8fafc 100%)",
    border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, cursor: "pointer",
    textAlign: "right" as const, fontFamily: "inherit",
    display: "flex", flexDirection: "column" as const, gap: 6,
    transition: "all .12s",
    boxShadow: "0 1px 2px rgba(0,0,0,.04)",
    minHeight: 92,
  } as const,
  itemName: { fontSize: 14, fontWeight: 600, color: "#0f172a", lineHeight: 1.4 } as const,
  itemPrice: { fontSize: 18, color: "#2563eb", fontWeight: 700, marginTop: "auto" } as const,
  itemBarcode: { fontSize: 10, color: "#94a3b8", fontFamily: "ui-monospace, monospace" } as const,

  // Cart pane: fixed width column, content scrolls in middle, footer pinned bottom
  cartPane: {
    width: 380, background: "#fff", border: "1px solid #e2e8f0",
    borderRadius: 12, display: "flex", flexDirection: "column" as const,
    minHeight: 0,
    boxShadow: "0 4px 16px rgba(0,0,0,.06)",
    overflow: "hidden",
  } as const,
  cartHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #f1f5f9", flexShrink: 0 } as const,
  cartTitle: { margin: 0, fontSize: 18, color: "#0f172a" } as const,
  clearBtn: { padding: "4px 10px", background: "#fff", color: "#64748b", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit" } as const,
  parkBtn: { padding: "4px 10px", background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 } as const,
  resumedBadge: { fontSize: 10, padding: "2px 8px", background: "#dbeafe", color: "#1e40af", borderRadius: 999, marginInlineStart: 8, fontWeight: 700, verticalAlign: "middle" } as const,

  // THIS is the ONLY scrolling region in the cart — items list
  linesScroll: { flex: 1, overflowY: "auto" as const, overflowX: "hidden" as const, minHeight: 0, maxHeight: "100%", padding: "12px 16px" } as const,
  cartEmpty: { padding: 40, color: "#94a3b8", fontSize: 14, textAlign: "center" as const } as const,
  lines: { display: "flex", flexDirection: "column" as const, gap: 8 } as const,
  line: { display: "flex", gap: 8, padding: 10, background: "#f8fafc", borderRadius: 8, alignItems: "center" } as const,
  qtyControls: { display: "flex", alignItems: "center", gap: 4, flexShrink: 0 } as const,
  qtyBtn: { width: 28, height: 28, border: "1px solid #cbd5e1", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 16, lineHeight: 1, fontFamily: "inherit" } as const,

  // STICKY FOOTER — flex-shrink:0 keeps it pinned, never scrolls
  footer: { padding: 16, borderTop: "1px solid #f1f5f9", background: "#fff", flexShrink: 0 } as const,
  totals: { padding: "0 4px 12px" } as const,
  payRow: { display: "flex", gap: 8 } as const,
  payCash: { flex: 1, padding: "16px 12px", background: "linear-gradient(180deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontSize: 16, fontWeight: 700, fontFamily: "inherit", boxShadow: "0 2px 6px rgba(22,163,74,.3)" } as const,
  payCard: { flex: 1, padding: "16px 12px", background: "linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%)", color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontSize: 16, fontWeight: 700, fontFamily: "inherit", boxShadow: "0 2px 6px rgba(37,99,235,.3)" } as const,
  msgOk: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, fontSize: 12, marginTop: 10 } as const,
  msgErr: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, fontSize: 12, marginTop: 10 } as const,
  lastInv: { fontSize: 11, color: "#94a3b8", textAlign: "center" as const, marginTop: 10 } as const,
};
