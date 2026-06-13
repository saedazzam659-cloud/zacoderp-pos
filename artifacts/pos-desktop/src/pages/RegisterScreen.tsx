// RegisterScreen — new point-of-sale register for the "trade" verticals
// (plumbing / paints / auto_parts / auto_workshop / mobiles).
//
// This screen is a SIBLING of SalesScreen.tsx — it intentionally does NOT
// import or modify it. It replicates the same real offline-POS pipeline
// (catalog load, cart, multi-unit pricing, customer attach, parked carts,
// barcode scanning, tax totals, ZATCA QR + offline-invoice persistence,
// LAN client stock handling, thermal receipt) but presents it with a
// document-style invoice table (5 columns) and two switchable themes:
//   • Aurora (default) — light teal "glassmorphism"
//   • Onyx              — dark with orange accent
//
// Theme choice persists per-device in localStorage.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { printReceipt, openCashDrawer, type ReceiptLine } from "../lib/peripherals";
import { generateZatcaQr } from "../lib/zatca";
import { isZatcaCountry } from "../lib/zatcaBridge";
import { listItems, findItemUnitByBarcode, seedDemoItems, type LocalItem, type ItemUnit } from "../lib/items";
import { isClient, getChangeVersion } from "../lib/bridge";
import { listCustomers, createCustomer, type LocalCustomer } from "../lib/customers";
import { saveOfflineInvoice, type OfflineInvoicePayload } from "../lib/invoices";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { useCurrencySymbol, currencySymbol } from "../lib/currency";
import {
  saveParkedCart, listParkedCarts, deleteParkedCart, takeResumeCartId,
} from "../lib/parkedCarts";
import { useTaxSettings, computeTotals } from "../lib/taxSettings";

const LS_PRINTER = "pos_desktop_peripherals_printer";
const LS_THEME = "pos_desktop_register_theme";

type ThemeName = "aurora" | "onyx";

function getStoredTheme(): ThemeName {
  try { return localStorage.getItem(LS_THEME) === "onyx" ? "onyx" : "aurora"; }
  catch { return "aurora"; }
}

interface CartLine {
  lineId: string;
  item: LocalItem;
  qty: number;
  /** Multi-unit sale: present when added as a non-base unit (e.g. كرتونة).
   * `item.salePrice` holds the per-unit price; `factor` = base units per one
   * of this unit and is used to deduct stock in the base unit at checkout. */
  unit?: { id: string; name: string; factor: number };
}

function newLineId(): string {
  return (crypto as any).randomUUID?.() ?? `ln_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

type Props = { companyName?: string; vatNumber?: string; posSessionId?: number; cashierName?: string };

export default function RegisterScreen({ companyName = "ZACOD POS", vatNumber = "300000000000003", posSessionId = 0, cashierName }: Props) {
  const sym = useCurrencySymbol();
  const [theme, setTheme] = useState<ThemeName>(getStoredTheme);
  const T = theme === "onyx" ? ONYX : AURORA;
  const S = useMemo(() => makeStyles(T), [T]);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [checkoutKey, setCheckoutKey] = useState<string | null>(null);
  const [activeParkedId, setActiveParkedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [lanTick, setLanTick] = useState(0);
  const [hostOnline, setHostOnline] = useState<boolean | null>(null);
  const [items, setItems] = useState<LocalItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [paying, setPaying] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastInvoice, setLastInvoice] = useState<string | null>(null);
  const [customer, setCustomer] = useState<LocalCustomer | null>(null);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [unitPickItem, setUnitPickItem] = useState<LocalItem | null>(null);
  const [paidStr, setPaidStr] = useState("");
  const [payMethod, setPayMethod] = useState<"cash" | "card">("cash");
  const [now, setNow] = useState(new Date());
  // Fast-entry row
  const [fastCode, setFastCode] = useState("");
  const [fastQty, setFastQty] = useState("1");

  function toggleTheme() {
    setTheme((p) => {
      const next: ThemeName = p === "onyx" ? "aurora" : "onyx";
      try { localStorage.setItem(LS_THEME, next); } catch { /* non-fatal */ }
      return next;
    });
  }

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => { void seedDemoItems().catch(() => {}); }, []);

  // Resume handoff from ParkedCarts page.
  useEffect(() => {
    const id = takeResumeCartId();
    if (!id || !posSessionId) return;
    (async () => {
      try {
        const all = await listParkedCarts(posSessionId);
        const c = all.find(x => x.id === id);
        if (!c) { setMsg({ kind: "err", text: "تعذّر استئناف السلة (غير موجودة)" }); return; }
        const lines: CartLine[] = c.lines.map(l => ({
          lineId: newLineId(),
          item: {
            id: l.itemId, nameAr: l.nameAr, salePrice: l.salePrice,
            vatRate: l.vatRate, barcode: l.barcode ?? null,
            code: "", nameEn: null, updatedAt: null,
          } as unknown as LocalItem,
          qty: l.qty,
          ...(l.unitId != null && l.unitName != null && l.unitFactor != null
            ? { unit: { id: l.unitId, name: l.unitName, factor: l.unitFactor } }
            : {}),
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
          unitId: l.unit?.id ?? null, unitName: l.unit?.name ?? null,
          unitFactor: l.unit?.factor ?? null,
        })),
      });
      setCart([]); setCheckoutKey(null); setActiveParkedId(null);
      setMsg({ kind: "ok", text: `📌 تم تعليق "${saved.label}" — افتحها من شاشة "المعلّقة"` });
    } catch (e: any) {
      setMsg({ kind: "err", text: `فشل تعليق السلة: ${e?.message ?? e}` });
    }
  }

  // Catalog load (debounced by search).
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
  }, [search, lanTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Client realtime refresh (LAN) — poll host change-version + connection probe.
  useEffect(() => {
    if (!isClient()) return;
    let stopped = false;
    let lastVersion = -1;
    const tick = async () => {
      if (stopped) return;
      try {
        const v = await getChangeVersion();
        if (!stopped) setHostOnline(v !== null);
        if (v !== null && v !== lastVersion) {
          if (lastVersion !== -1) setLanTick((n) => n + 1);
          lastVersion = v;
        }
      } catch {
        if (!stopped) setHostOnline(false);
      }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, 3000);
    return () => { stopped = true; window.clearInterval(id); };
  }, []);

  useBarcodeScanner({
    onScan: async (code) => {
      if (unitPickItem || showCustomerPicker || paying) return;
      try {
        const match = await findItemUnitByBarcode(code);
        if (match) {
          if (match.unit) addUnitToCart(match.item, match.unit);
          else addToCart(match.item);
        } else setMsg({ kind: "err", text: `لم يُعثر على باركود: ${code}` });
      } catch (e: any) {
        setMsg({ kind: "err", text: `خطأ في البحث: ${e?.message ?? e}` });
      }
    },
  });

  const { rate: vatRatePct, mode: taxMode } = useTaxSettings();
  const totals = useMemo(() => {
    const raw = cart.reduce((sum, l) => sum + l.item.salePrice * l.qty, 0);
    return computeTotals(raw, vatRatePct, taxMode);
  }, [cart, vatRatePct, taxMode]);

  function addToCart(item: LocalItem, qty = 1) {
    setMsg(null);
    setCart((prev) => {
      const existing = prev.find((l) => l.item.id === item.id && !l.unit);
      if (existing) return prev.map((l) => l.lineId === existing.lineId ? { ...l, qty: l.qty + qty } : l);
      return [...prev, { lineId: newLineId(), item, qty }];
    });
  }

  function addUnitToCart(item: LocalItem, unit: ItemUnit, qty = 1) {
    setMsg(null);
    const synth: LocalItem = { ...item, salePrice: unit.price };
    setCart((prev) => {
      const existing = prev.find((l) => l.item.id === item.id && l.unit?.id === unit.id);
      if (existing) return prev.map((l) => l.lineId === existing.lineId ? { ...l, qty: l.qty + qty } : l);
      return [...prev, { lineId: newLineId(), item: synth, qty, unit: { id: unit.id, name: unit.name, factor: unit.factor } }];
    });
    setMsg({ kind: "ok", text: `➕ ${item.nameAr} — ${unit.name}` });
  }

  function onItemTap(item: LocalItem) {
    if (item.units && item.units.length > 0) { setUnitPickItem(item); return; }
    addToCart(item);
  }

  async function addByFastCode() {
    const code = fastCode.trim();
    if (!code) return;
    const qty = Math.max(1, parseInt(fastQty, 10) || 1);
    try {
      const match = await findItemUnitByBarcode(code);
      if (match) {
        if (match.unit) addUnitToCart(match.item, match.unit, qty);
        else addToCart(match.item, qty);
        setFastCode(""); setFastQty("1");
        return;
      }
      // No barcode hit → treat as a name filter so the cashier can tap the card.
      setSearch(code);
      setMsg({ kind: "err", text: `لا يوجد باركود مطابق — تم البحث بالاسم "${code}"` });
    } catch (e: any) {
      setMsg({ kind: "err", text: `خطأ في البحث: ${e?.message ?? e}` });
    }
  }

  function changeQty(lineId: string, delta: number) {
    setCart((prev) => prev
      .map((l) => l.lineId === lineId ? { ...l, qty: l.qty + delta } : l)
      .filter((l) => l.qty > 0));
  }
  function removeLine(lineId: string) {
    setCart((prev) => {
      const next = prev.filter((l) => l.lineId !== lineId);
      if (next.length === 0) setCheckoutKey(null);
      return next;
    });
  }
  function clearCart() {
    setCart([]); setCheckoutKey(null); setActiveParkedId(null); setCustomer(null); setPaidStr("");
  }

  async function checkout(paymentMethod: "cash" | "card") {
    if (cart.length === 0) return;
    const printer = localStorage.getItem(LS_PRINTER);
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
        customerName: customer?.nameAr,
        subtotal: Number(totals.subtotal.toFixed(2)),
        vat: Number(totals.vat.toFixed(2)),
        grandTotal: Number(totals.grandTotal.toFixed(2)),
        lines: cart.map((l) => ({
          itemId: l.item.id,
          nameAr: l.unit ? `${l.item.nameAr} (${l.unit.name})` : l.item.nameAr,
          qty: l.qty, unitPrice: l.item.salePrice, vatRate: l.item.vatRate,
        })),
      };
      // On a CLIENT, decrement host stock BEFORE persisting the invoice; roll
      // back every applied decrement and abort with NO invoice on oversell.
      const client = isClient();
      const applied: Array<{ itemId: number; qty: number }> = [];
      if (client) {
        const { adjustStockShared } = await import("../lib/stock");
        try {
          for (const l of cart) {
            const baseQty = l.qty * (l.unit?.factor ?? 1);
            await adjustStockShared(l.item.id, -baseQty);
            applied.push({ itemId: l.item.id, qty: baseQty });
          }
        } catch (e: any) {
          for (const a of applied) {
            try { await adjustStockShared(a.itemId, a.qty); } catch { /* best effort */ }
          }
          setMsg({ kind: "err", text: `❌ تعذّر إتمام البيع — المخزون غير كافٍ على الجهاز الرئيسي:\n${e?.message ?? e}\nلم يتم حفظ الفاتورة.` });
          return;
        }
      }

      let key = checkoutKey;
      if (!key) {
        key = (crypto as any).randomUUID?.() ??
          `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        setCheckoutKey(key);
      }
      let saved;
      try {
        saved = await saveOfflineInvoice(payload, qr ?? undefined, undefined, key!);
      } catch (e) {
        if (client) {
          const { adjustStockShared } = await import("../lib/stock");
          for (const a of applied) {
            try { await adjustStockShared(a.itemId, a.qty); } catch { /* best effort */ }
          }
        }
        throw e;
      }
      const invNum = saved.invoiceNo;

      // Single/host mode: decrement local stock immediately after persist.
      if (!client) {
        const { adjustStockShared } = await import("../lib/stock");
        for (const l of cart) {
          try { await adjustStockShared(l.item.id, -(l.qty * (l.unit?.factor ?? 1))); }
          catch { /* single/host — non-fatal */ }
        }
      }

      const body: ReceiptLine[] = [];
      for (const l of cart) {
        const label = l.unit ? `${l.item.nameAr} (${l.unit.name})` : l.item.nameAr;
        body.push({ text: `${label.padEnd(20, " ")} ×${l.qty}  ${(l.item.salePrice * l.qty).toFixed(2)}` });
      }
      body.push({ text: "─".repeat(32) });
      body.push({ text: `المجموع قبل الضريبة:  ${totals.subtotal.toFixed(2)}` });
      body.push({ text: `ضريبة القيمة المضافة: ${totals.vat.toFixed(2)}` });
      body.push({ text: `الإجمالي:             ${totals.grandTotal.toFixed(2)}`, bold: true });
      body.push({ text: `طريقة الدفع: ${paymentMethod === "cash" ? "نقداً" : "بطاقة"}` });
      const paidNum = parseFloat(paidStr) || 0;
      if (paymentMethod === "cash" && paidNum > 0) {
        body.push({ text: `المبلغ المدفوع:       ${paidNum.toFixed(2)}` });
        const change = paidNum - totals.grandTotal;
        if (change >= 0) body.push({ text: `الباقي للعميل:        ${change.toFixed(2)}`, bold: true });
      }
      if (customer) {
        body.push({ text: "─".repeat(32) });
        body.push({ text: `العميل: ${customer.nameAr}` });
        if (customer.phone) body.push({ text: `الجوال: ${customer.phone}` });
        if (customer.vatNumber) body.push({ text: `الرقم الضريبي: ${customer.vatNumber}` });
      }

      if (printer) {
        await printReceipt({
          printerName: printer,
          header: [
            { text: companyName, bold: true, center: true },
            { text: `الرقم الضريبي: ${vatNumber}`, center: true },
            { text: `فاتورة #${invNum}`, center: true },
            { text: new Date(ts).toLocaleString("ar-SA"), center: true },
            ...(cashierName ? [{ text: `الكاشير: ${cashierName}`, center: true }] : []),
          ],
          body,
          footer: [{ text: "شكراً لزيارتكم", center: true }],
          qrData: isZatcaCountry() ? qr : undefined, cut: true,
          openDrawer: paymentMethod === "cash",
        });
        if (paymentMethod === "cash") {
          try { await openCashDrawer(printer); } catch { /* ignore */ }
        }
      }
      if (activeParkedId) {
        try { await deleteParkedCart(activeParkedId); } catch { /* non-fatal */ }
      }
      setLastInvoice(invNum);
      setCart([]); setCheckoutKey(null); setActiveParkedId(null);
      setCustomer(null); setPaidStr("");
      setMsg({ kind: "ok", text: `✅ تم إنهاء البيع — فاتورة ${invNum}` });
    } catch (e: any) {
      setMsg({ kind: "err", text: `فشل إنهاء البيع: ${e?.message ?? e}` });
    } finally { setPaying(false); }
  }

  const paidNum = parseFloat(paidStr) || 0;
  const change = paidNum - totals.grandTotal;
  const hasPaid = paidStr.trim() !== "" && paidNum > 0;
  const enough = paidNum >= totals.grandTotal;
  const totalQty = cart.reduce((s, l) => s + l.qty, 0);

  return (
    <div dir="rtl" style={S.wrap}>
      <style>{scrollbarCss(T)}</style>

      {/* ─── Top header bar ─────────────────────────────────────── */}
      <header style={S.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <div style={S.brandIcon}>🛒</div>
            <div style={{ minWidth: 0 }}>
              <div style={S.brandName}>{companyName}</div>
              <div style={S.brandSub}>محطة بيع #01</div>
            </div>
          </div>
          <div style={S.headerDivider} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={S.headerLabel}>👤 الكاشير</span>
            <span style={S.headerValue}>{cashierName || "—"}</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {isClient() && (
            <div style={hostOnline === false ? S.connOff : hostOnline === true ? S.connOn : S.connUnknown}>
              {hostOnline === false ? "🔴 غير متصل" : hostOnline === true ? "🟢 متصل" : "⚪ تحقق..."}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <span style={S.clockTime}>{now.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span style={S.headerLabel}>{now.toLocaleDateString("ar-SA")}</span>
          </div>
          {customer ? (
            <button onClick={() => setShowCustomerPicker(true)} style={S.customerBtnActive} title="تغيير العميل">
              👤 {customer.nameAr}
            </button>
          ) : (
            <button onClick={() => setShowCustomerPicker(true)} style={S.customerBtn}>
              ＋ عميل نقدي
            </button>
          )}
          <button onClick={toggleTheme} style={S.themeBtn} title="تبديل المظهر (أورورا / أونيكس)">
            {theme === "onyx" ? "🌙 أونيكس" : "☀️ أورورا"}
          </button>
        </div>
      </header>

      {/* ─── Main layout ────────────────────────────────────────── */}
      <main style={S.main}>
        {/* LEFT — products */}
        <section style={S.productsPane}>
          <div style={S.searchRow}>
            <input
              placeholder="🔍 بحث في المنتجات بالاسم أو الباركود..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={S.search}
              data-allow-scan="true"
            />
            <div style={S.countChip}>{items.length} صنف</div>
          </div>

          <div className="reg-scroll" style={S.gridScroll}>
            <div style={S.grid}>
              {loadingItems && items.length === 0 ? (
                <div style={S.empty}>... جاري تحميل الأصناف</div>
              ) : items.length === 0 ? (
                <div style={S.empty}>
                  <div style={{ fontSize: 16, marginBottom: 6 }}>لا توجد أصناف</div>
                  <div style={{ fontSize: 13 }}>اسحب من السحابة (لوحة التحكم → Pull) أو أضف صنف من شاشة "أصناف"</div>
                </div>
              ) : (
                items.map((item) => (
                  <button key={item.id} onClick={() => onItemTap(item)} style={S.itemCard}>
                    <div style={S.itemThumb}>📦</div>
                    <div style={S.itemName}>{item.nameAr}</div>
                    <div style={S.itemFoot}>
                      <span style={S.itemPrice}>{item.salePrice.toFixed(2)} <span style={S.itemPriceCur}>{sym}</span></span>
                      {item.barcode && <span style={S.itemBarcode}>{item.barcode}</span>}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </section>

        {/* RIGHT — invoice document */}
        <section style={S.invoicePane}>
          <div style={S.invoiceHeader}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 800 }}>الفاتورة الحالية</div>
              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                {activeParkedId ? "سلة مستأنفة" : "فاتورة جديدة"}
                {lastInvoice ? ` · آخر: ${lastInvoice}` : ""}
              </div>
            </div>
            <div style={S.invoiceHeaderBadge}>{cart.length} صنف · {totalQty} قطعة</div>
          </div>

          {/* Fast-entry row */}
          <div style={S.fastRow}>
            <input
              placeholder="باركود أو اسم الصنف"
              value={fastCode}
              onChange={(e) => setFastCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void addByFastCode(); }}
              style={S.fastInput}
              data-allow-scan="true"
            />
            <input
              type="number" min="1" value={fastQty}
              onChange={(e) => setFastQty(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void addByFastCode(); }}
              style={S.fastQty}
            />
            <button onClick={() => void addByFastCode()} style={S.fastAddBtn}>إضافة</button>
          </div>

          {/* Table header — 5 columns (T3) */}
          <div style={S.tableHead}>
            <div style={S.colName}>الصنف</div>
            <div style={S.colQty}>الكمية</div>
            <div style={S.colUnit}>الوحدة</div>
            <div style={S.colPrice}>السعر</div>
            <div style={S.colTotal}>الإجمالي</div>
            <div style={S.colDel} />
          </div>

          {/* Table body */}
          <div className="reg-scroll" style={S.tableBody}>
            {cart.length === 0 ? (
              <div style={S.cartEmpty}>
                <div style={{ fontSize: 44, marginBottom: 8 }}>🧾</div>
                <div>لا توجد أصناف في الفاتورة</div>
                <div style={{ fontSize: 12, marginTop: 6, opacity: 0.7 }}>اضغط على صنف أو امسح باركود</div>
              </div>
            ) : (
              cart.map((l, idx) => (
                <div key={l.lineId} style={{ ...S.row, ...(idx % 2 ? S.rowAlt : null) }}>
                  <div style={S.colName}>
                    <div style={S.rowName}>{l.item.nameAr}</div>
                  </div>
                  <div style={S.colQty}>
                    <div style={S.qtyBox}>
                      <button onClick={() => changeQty(l.lineId, -1)} style={S.qtyBtn}>−</button>
                      <span style={S.qtyNum}>{l.qty}</span>
                      <button onClick={() => changeQty(l.lineId, +1)} style={S.qtyBtn}>+</button>
                    </div>
                  </div>
                  <div style={{ ...S.colUnit, ...S.cellMuted }}>{l.unit?.name ?? "قطعة"}</div>
                  <div style={{ ...S.colPrice, ...S.cellMuted }}>{l.item.salePrice.toFixed(2)}</div>
                  <div style={{ ...S.colTotal, ...S.cellTotal }}>{(l.item.salePrice * l.qty).toFixed(2)}</div>
                  <div style={S.colDel}>
                    <button onClick={() => removeLine(l.lineId)} style={S.delBtn} title="حذف">×</button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Totals + payment */}
          <div style={S.footer}>
            <div style={S.totalsBox}>
              <Row S={S} k="قبل الضريبة" v={`${totals.subtotal.toFixed(2)} ${sym}`} />
              <Row S={S} k={`ضريبة ${vatRatePct}%${taxMode === "inclusive" ? " (شاملة)" : ""}`} v={`${totals.vat.toFixed(2)} ${sym}`} />
              <Row S={S} k="الإجمالي النهائي" v={`${totals.grandTotal.toFixed(2)} ${sym}`} big />
            </div>

            {cart.length > 0 && (
              <div style={S.paidBox}>
                <div style={S.paidRow}>
                  <label style={S.paidLabel}>💵 المدفوع</label>
                  <input
                    type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00"
                    value={paidStr} onChange={(e) => setPaidStr(e.target.value)} style={S.paidInput}
                  />
                </div>
                {hasPaid && (
                  <div style={enough ? S.changeOk : S.changeShort}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{enough ? "💰 الباقي للعميل" : "⚠️ المتبقي على العميل"}</span>
                    <span style={S.changeAmount}>{Math.abs(change).toFixed(2)} {sym}</span>
                  </div>
                )}
                {hasPaid && (
                  <div style={S.paidQuick}>
                    {[totals.grandTotal, 50, 100, 200, 500].filter((v, i, a) => a.indexOf(v) === i).map((v) => (
                      <button key={v} onClick={() => setPaidStr(v.toFixed(2))} style={S.quickBtn}>{v.toFixed(0)}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Payment method selector */}
            <div style={S.payMethods}>
              <button onClick={() => setPayMethod("cash")} style={payMethod === "cash" ? S.payMethodActive : S.payMethod}>💵 نقدي</button>
              <button onClick={() => setPayMethod("card")} style={payMethod === "card" ? S.payMethodActive : S.payMethod}>💳 شبكة</button>
            </div>

            {/* Action bar */}
            <div style={S.actionRow}>
              <button onClick={clearCart} disabled={cart.length === 0} style={S.secondaryBtn}>🧾 جديدة</button>
              <button onClick={parkCart} disabled={cart.length === 0} style={S.secondaryBtn}>📌 تعليق</button>
              <button onClick={() => checkout(payMethod)} disabled={paying || cart.length === 0} style={S.saveBtn}>
                {paying ? "..." : "💾 حفظ وطباعة"}
              </button>
            </div>

            {msg && <div style={msg.kind === "ok" ? S.msgOk : S.msgErr}>{msg.text}</div>}
          </div>
        </section>
      </main>

      {showCustomerPicker && (
        <CustomerPicker
          T={T}
          onSelect={(c) => { setCustomer(c); setShowCustomerPicker(false); }}
          onClose={() => setShowCustomerPicker(false)}
        />
      )}

      {unitPickItem && (
        <UnitPickerModal
          T={T}
          item={unitPickItem}
          onCancel={() => setUnitPickItem(null)}
          onPick={(unit) => {
            if (unit) addUnitToCart(unitPickItem, unit);
            else addToCart(unitPickItem);
            setUnitPickItem(null);
          }}
        />
      )}
    </div>
  );
}

function Row({ S, k, v, big }: { S: Styles; k: string; v: string; big?: boolean }) {
  return (
    <div style={big ? S.totalsRowBig : S.totalsRow}>
      <span>{k}</span><span>{v}</span>
    </div>
  );
}

// ─── Unit picker modal (multi-unit pricing) ─────────────────────────
function UnitPickerModal({
  T, item, onPick, onCancel,
}: {
  T: Tokens;
  item: LocalItem;
  onPick: (unit: ItemUnit | null) => void;
  onCancel: () => void;
}) {
  const M = makeModalStyles(T);
  const units = item.units ?? [];
  return (
    <div style={M.overlay} onClick={onCancel}>
      <div dir="rtl" style={{ ...M.card, maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div style={M.title}>{item.nameAr}</div>
        <div style={M.subtitle}>اختر وحدة البيع</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button onClick={() => onPick(null)} style={M.unitRow}>
            <span style={{ fontWeight: 700, color: T.text }}>قطعة</span>
            <span style={{ color: T.accent, fontWeight: 700 }}>{item.salePrice.toFixed(2)} {currencySymbol()}</span>
          </button>
          {units.map((u) => (
            <button key={u.id} onClick={() => onPick(u)} style={M.unitRow}>
              <span style={{ fontWeight: 700, color: T.text }}>
                {u.name}
                <span style={{ fontSize: 12, color: T.subtext, fontWeight: 400, marginInlineStart: 6 }}>({u.factor} قطعة)</span>
              </span>
              <span style={{ color: T.accent, fontWeight: 700 }}>{u.price.toFixed(2)} {currencySymbol()}</span>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button onClick={onCancel} style={M.backBtn}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

// ─── Customer picker modal ─────────────────────────────────────────
function CustomerPicker({ T, onSelect, onClose }: { T: Tokens; onSelect: (c: LocalCustomer) => void; onClose: () => void }) {
  const M = makeModalStyles(T);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<LocalCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newVat, setNewVat] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const r = await listCustomers(q || undefined);
        if (!cancelled) setRows(r);
      } catch { /* ignore */ } finally { if (!cancelled) setLoading(false); }
    }, q ? 150 : 0);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [q]);

  async function handleCreate() {
    if (!newName.trim()) { setErr("اسم العميل مطلوب"); return; }
    setSaving(true); setErr(null);
    try {
      const c = await createCustomer({
        nameAr: newName.trim(),
        phone: newPhone.trim() || null,
        vatNumber: newVat.trim() || null,
      });
      onSelect(c);
    } catch (e: any) {
      setErr(`تعذّر الإنشاء: ${e?.message ?? e}`);
    } finally { setSaving(false); }
  }

  return (
    <div style={M.overlay} onClick={onClose}>
      <div dir="rtl" style={M.card} onClick={(e) => e.stopPropagation()}>
        <div style={M.header}>
          <h3 style={{ margin: 0, fontSize: 18, color: T.text }}>{showNew ? "👤 عميل جديد" : "👥 اختر العميل"}</h3>
          <button onClick={onClose} style={M.closeBtn}>×</button>
        </div>

        {!showNew ? (
          <>
            <input autoFocus placeholder="🔍 بحث بالاسم، الجوال، أو الرقم الضريبي..."
              value={q} onChange={(e) => setQ(e.target.value)} style={M.search} />
            <div style={M.list}>
              {loading ? (
                <div style={M.listEmpty}>... جاري التحميل</div>
              ) : rows.length === 0 ? (
                <div style={M.listEmpty}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🤷‍♂️</div>
                  <div>لا يوجد عميل مطابق</div>
                </div>
              ) : (
                rows.map((c) => (
                  <button key={c.id} onClick={() => onSelect(c)} style={M.row}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={M.rowName}>{c.nameAr}</div>
                      {(c.phone || c.vatNumber) && (
                        <div style={M.rowMeta}>
                          {c.phone ? `📱 ${c.phone}` : ""}{c.phone && c.vatNumber ? "  ·  " : ""}{c.vatNumber ? `🧾 ${c.vatNumber}` : ""}
                        </div>
                      )}
                    </div>
                    <span style={{ color: T.accent, fontSize: 14, fontWeight: 600 }}>اختيار ←</span>
                  </button>
                ))
              )}
            </div>
            <button onClick={() => setShowNew(true)} style={M.newBtn}>＋ إضافة عميل جديد</button>
          </>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
            <div>
              <label style={M.fieldLabel}>اسم العميل *</label>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} style={M.field} />
            </div>
            <div>
              <label style={M.fieldLabel}>رقم الجوال</label>
              <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} style={M.field} placeholder="05XXXXXXXX" />
            </div>
            <div>
              <label style={M.fieldLabel}>الرقم الضريبي (اختياري)</label>
              <input value={newVat} onChange={(e) => setNewVat(e.target.value)} style={M.field} placeholder="3xxxxxxxxxxxxx3" />
            </div>
            {err && <div style={M.err}>{err}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button onClick={handleCreate} disabled={saving} style={{ ...M.saveBtn, opacity: saving ? 0.6 : 1 }}>
                {saving ? "..." : "💾 حفظ واختيار"}
              </button>
              <button onClick={() => setShowNew(false)} style={M.backBtn}>← رجوع</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Theme tokens
// ════════════════════════════════════════════════════════════════════
type Tokens = {
  name: ThemeName;
  appBg: string;
  text: string;
  subtext: string;
  headerBg: string;
  border: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  panelBg: string;
  cardBg: string;
  cardBorder: string;
  invoiceBg: string;
  invoiceHeaderBg: string;
  invoiceHeaderText: string;
  tableHeadBg: string;
  rowAltBg: string;
  inputBg: string;
  inputBorder: string;
  totalsBg: string;
  scrollThumb: string;
  scrollTrack: string;
};

const AURORA: Tokens = {
  name: "aurora",
  appBg: "linear-gradient(135deg, #f0fdfa 0%, #e0f2fe 100%)",
  text: "#0f172a",
  subtext: "#64748b",
  headerBg: "rgba(255,255,255,0.85)",
  border: "#e2e8f0",
  accent: "#0d9488",
  accentText: "#ffffff",
  accentSoft: "#f0fdfa",
  panelBg: "rgba(255,255,255,0.5)",
  cardBg: "#ffffff",
  cardBorder: "#e2e8f0",
  invoiceBg: "#ffffff",
  invoiceHeaderBg: "#1e293b",
  invoiceHeaderText: "#ffffff",
  tableHeadBg: "#f1f5f9",
  rowAltBg: "#f8fafc",
  inputBg: "#ffffff",
  inputBorder: "#cbd5e1",
  totalsBg: "#f8fafc",
  scrollThumb: "#cbd5e1",
  scrollTrack: "transparent",
};

const ONYX: Tokens = {
  name: "onyx",
  appBg: "#0a0a0a",
  text: "#e2e8f0",
  subtext: "#94a3b8",
  headerBg: "#111111",
  border: "#27272a",
  accent: "#f97316",
  accentText: "#ffffff",
  accentSoft: "rgba(249,115,22,0.12)",
  panelBg: "#0a0a0a",
  cardBg: "#151515",
  cardBorder: "#27272a",
  invoiceBg: "#111111",
  invoiceHeaderBg: "#151515",
  invoiceHeaderText: "#ffffff",
  tableHeadBg: "#0d0d0d",
  rowAltBg: "#161616",
  inputBg: "#0a0a0a",
  inputBorder: "#3f3f46",
  totalsBg: "#151515",
  scrollThumb: "#333333",
  scrollTrack: "#111111",
};

function scrollbarCss(T: Tokens): string {
  return `
    .reg-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
    .reg-scroll::-webkit-scrollbar-track { background: ${T.scrollTrack}; border-radius: 6px; }
    .reg-scroll::-webkit-scrollbar-thumb { background: ${T.scrollThumb}; border-radius: 6px; }
    .reg-scroll { scrollbar-width: thin; scrollbar-color: ${T.scrollThumb} ${T.scrollTrack}; }
  `;
}

type Styles = Record<string, CSSProperties>;

function makeStyles(T: Tokens): Styles {
  const FONT = "'Segoe UI', system-ui, sans-serif";
  return {
    wrap: {
      display: "flex", flexDirection: "column", height: "100%", maxHeight: "100%",
      minHeight: 0, background: T.appBg, color: T.text, fontFamily: FONT, overflow: "hidden",
      boxSizing: "border-box",
    },

    // Header
    header: {
      flexShrink: 0, height: 64, display: "flex", alignItems: "center",
      justifyContent: "space-between", padding: "0 20px", background: T.headerBg,
      borderBottom: `1px solid ${T.border}`, backdropFilter: "blur(12px)",
    },
    brandIcon: {
      width: 40, height: 40, borderRadius: 12, background: T.accent, color: T.accentText,
      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0,
    },
    brandName: { fontSize: 16, fontWeight: 800, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 },
    brandSub: { fontSize: 11, color: T.subtext, marginTop: 2 },
    headerDivider: { width: 1, height: 32, background: T.border },
    headerLabel: { fontSize: 11, color: T.subtext },
    headerValue: { fontSize: 14, fontWeight: 700 },
    clockTime: { fontSize: 14, fontWeight: 800, fontFamily: "ui-monospace, monospace", letterSpacing: 1 },
    customerBtn: {
      display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 999,
      background: T.cardBg, border: `1px solid ${T.border}`, color: T.text, cursor: "pointer",
      fontSize: 13, fontWeight: 600, fontFamily: FONT,
    },
    customerBtnActive: {
      display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 999,
      background: T.accentSoft, border: `1px solid ${T.accent}`, color: T.accent, cursor: "pointer",
      fontSize: 13, fontWeight: 700, fontFamily: FONT, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    },
    themeBtn: {
      padding: "8px 12px", borderRadius: 10, background: T.cardBg, border: `1px solid ${T.border}`,
      color: T.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: FONT,
    },
    connOn: { padding: "6px 12px", borderRadius: 999, background: T.accentSoft, color: T.accent, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" },
    connOff: { padding: "6px 12px", borderRadius: 999, background: "#fef2f2", color: "#b91c1c", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" },
    connUnknown: { padding: "6px 12px", borderRadius: 999, background: T.cardBg, color: T.subtext, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", border: `1px solid ${T.border}` },

    // Main
    main: { flex: 1, display: "flex", gap: 16, padding: 16, overflow: "hidden", minHeight: 0 },

    // Products pane
    productsPane: {
      flex: 1, display: "flex", flexDirection: "column", gap: 12, minWidth: 0, minHeight: 0,
      background: T.panelBg, border: `1px solid ${T.border}`, borderRadius: 18, padding: 14,
    },
    searchRow: { display: "flex", gap: 10, alignItems: "center", flexShrink: 0 },
    search: { flex: 1, padding: "11px 14px", fontSize: 14, border: `1px solid ${T.inputBorder}`, borderRadius: 12, fontFamily: FONT, background: T.inputBg, color: T.text },
    countChip: { padding: "8px 14px", background: T.cardBg, border: `1px solid ${T.border}`, borderRadius: 999, fontSize: 13, color: T.subtext, fontWeight: 600, whiteSpace: "nowrap" },
    gridScroll: { flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0 },
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12, padding: 2, alignContent: "start" },
    empty: { gridColumn: "1 / -1", padding: 40, color: T.subtext, fontSize: 14, textAlign: "center", border: `1px dashed ${T.border}`, borderRadius: 12, background: T.cardBg },
    itemCard: {
      background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderRadius: 14, padding: 12,
      cursor: "pointer", textAlign: "right", fontFamily: FONT, display: "flex", flexDirection: "column",
      gap: 8, color: T.text, minHeight: 120,
    },
    itemThumb: {
      width: "100%", aspectRatio: "1.6", background: T.accentSoft, borderRadius: 10,
      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26,
    },
    itemName: { fontSize: 13, fontWeight: 700, lineHeight: 1.35, color: T.text },
    itemFoot: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto", gap: 6 },
    itemPrice: { fontSize: 15, color: T.accent, fontWeight: 800, whiteSpace: "nowrap" },
    itemPriceCur: { fontSize: 10, opacity: 0.7, fontWeight: 400 },
    itemBarcode: { fontSize: 9, color: T.subtext, fontFamily: "ui-monospace, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },

    // Invoice pane
    invoicePane: {
      width: 480, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0,
      background: T.invoiceBg, border: `1px solid ${T.border}`, borderRadius: 18, overflow: "hidden",
      boxShadow: T.name === "aurora" ? "0 8px 28px rgba(15,23,42,.10)" : "0 8px 28px rgba(0,0,0,.5)",
    },
    invoiceHeader: {
      flexShrink: 0, padding: "14px 16px", background: T.invoiceHeaderBg, color: T.invoiceHeaderText,
      display: "flex", alignItems: "center", justifyContent: "space-between",
    },
    invoiceHeaderBadge: { fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: "rgba(255,255,255,0.15)", whiteSpace: "nowrap" },

    fastRow: { flexShrink: 0, display: "flex", gap: 8, padding: 10, borderBottom: `1px solid ${T.border}`, background: T.totalsBg },
    fastInput: { flex: 1, padding: "10px 12px", fontSize: 14, border: `1px solid ${T.inputBorder}`, borderRadius: 10, fontFamily: FONT, background: T.inputBg, color: T.text, minWidth: 0 },
    fastQty: { width: 56, padding: "10px 6px", fontSize: 14, textAlign: "center", fontWeight: 700, border: `1px solid ${T.inputBorder}`, borderRadius: 10, fontFamily: FONT, background: T.inputBg, color: T.text },
    fastAddBtn: { padding: "10px 16px", background: T.accent, color: T.accentText, border: "none", borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 700, fontFamily: FONT, whiteSpace: "nowrap" },

    // Table — 5 columns
    tableHead: {
      flexShrink: 0, display: "flex", alignItems: "center", padding: "8px 14px",
      background: T.tableHeadBg, borderBottom: `1px solid ${T.border}`, fontSize: 12, fontWeight: 700, color: T.subtext,
    },
    colName: { flex: 3, minWidth: 0 },
    colQty: { width: 92, display: "flex", justifyContent: "center", flexShrink: 0 },
    colUnit: { width: 56, textAlign: "center", flexShrink: 0 },
    colPrice: { width: 64, textAlign: "center", flexShrink: 0 },
    colTotal: { width: 80, textAlign: "left", flexShrink: 0 },
    colDel: { width: 32, display: "flex", justifyContent: "flex-end", flexShrink: 0 },

    tableBody: { flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0 },
    cartEmpty: { padding: "48px 20px", textAlign: "center", color: T.subtext, fontSize: 14 },
    row: { display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: `1px solid ${T.border}`, background: T.invoiceBg },
    rowAlt: { background: T.rowAltBg },
    rowName: { fontSize: 13, fontWeight: 700, color: T.text, lineHeight: 1.3 },
    cellMuted: { fontSize: 13, fontWeight: 600, color: T.subtext },
    cellTotal: { fontSize: 13, fontWeight: 800, color: T.accent },
    qtyBox: { display: "flex", alignItems: "center", gap: 2, background: T.tableHeadBg, border: `1px solid ${T.border}`, borderRadius: 8, padding: 2 },
    qtyBtn: { width: 22, height: 22, border: "none", background: "transparent", color: T.text, borderRadius: 6, cursor: "pointer", fontSize: 15, lineHeight: 1, fontFamily: FONT },
    qtyNum: { minWidth: 22, textAlign: "center", fontWeight: 800, fontSize: 13, color: T.accent },
    delBtn: { width: 26, height: 26, border: "none", background: "transparent", color: T.subtext, borderRadius: 8, cursor: "pointer", fontSize: 18, lineHeight: 1, fontFamily: FONT },

    // Footer
    footer: { flexShrink: 0, padding: 14, borderTop: `1px solid ${T.border}`, background: T.totalsBg },
    totalsBox: { marginBottom: 10 },
    totalsRow: { display: "flex", justifyContent: "space-between", fontSize: 13, color: T.subtext, padding: "3px 0" },
    totalsRowBig: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 20, fontWeight: 800, color: T.text, paddingTop: 8, marginTop: 6, borderTop: `1px dashed ${T.border}` },

    paidBox: { background: T.cardBg, border: `1px solid ${T.border}`, borderRadius: 12, padding: 10, marginBottom: 10 },
    paidRow: { display: "flex", alignItems: "center", gap: 8 },
    paidLabel: { fontSize: 13, fontWeight: 700, color: T.text, whiteSpace: "nowrap" },
    paidInput: { flex: 1, padding: "9px 12px", fontSize: 16, fontWeight: 700, border: `1px solid ${T.inputBorder}`, borderRadius: 8, fontFamily: "ui-monospace, monospace", textAlign: "left", background: T.inputBg, color: T.text, minWidth: 0, boxSizing: "border-box" },
    changeOk: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, padding: "8px 12px", background: T.accentSoft, border: `1px solid ${T.accent}`, borderRadius: 8, color: T.accent },
    changeShort: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, padding: "8px 12px", background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, color: "#991b1b" },
    changeAmount: { fontSize: 18, fontWeight: 800, fontFamily: "ui-monospace, monospace" },
    paidQuick: { display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" },
    quickBtn: { flex: 1, minWidth: 50, padding: "6px 8px", background: T.inputBg, border: `1px solid ${T.inputBorder}`, borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: T.text },

    payMethods: { display: "flex", gap: 8, marginBottom: 10 },
    payMethod: { flex: 1, padding: "11px 8px", background: T.cardBg, border: `1px solid ${T.border}`, borderRadius: 12, color: T.text, cursor: "pointer", fontSize: 14, fontWeight: 700, fontFamily: FONT },
    payMethodActive: { flex: 1, padding: "11px 8px", background: T.accentSoft, border: `1px solid ${T.accent}`, borderRadius: 12, color: T.accent, cursor: "pointer", fontSize: 14, fontWeight: 800, fontFamily: FONT, boxShadow: `0 0 0 1px ${T.accent} inset` },

    actionRow: { display: "flex", gap: 8 },
    secondaryBtn: { flex: 1, padding: "12px 8px", background: T.cardBg, border: `1px solid ${T.border}`, borderRadius: 12, color: T.text, cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: FONT },
    saveBtn: { flex: 1.8, padding: "12px 8px", background: T.accent, color: T.accentText, border: "none", borderRadius: 12, cursor: "pointer", fontSize: 15, fontWeight: 800, fontFamily: FONT, boxShadow: `0 4px 14px ${T.name === "aurora" ? "rgba(13,148,136,.3)" : "rgba(249,115,22,.3)"}` },

    msgOk: { background: T.accentSoft, border: `1px solid ${T.accent}`, color: T.accent, padding: 10, borderRadius: 8, fontSize: 12, marginTop: 10, whiteSpace: "pre-line" },
    msgErr: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 8, fontSize: 12, marginTop: 10, whiteSpace: "pre-line" },
  };
}

// Modals use a neutral light card on both themes for contrast/legibility,
// but accent + text colors follow the active theme tokens.
function makeModalStyles(T: Tokens): Styles {
  const FONT = "'Segoe UI', system-ui, sans-serif";
  const card = T.name === "onyx" ? "#1a1a1a" : "#ffffff";
  const fieldBg = T.name === "onyx" ? "#0f0f0f" : "#f8fafc";
  const border = T.border;
  return {
    overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16, backdropFilter: "blur(2px)" },
    card: { background: card, borderRadius: 14, width: "100%", maxWidth: 480, maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,.4)", overflow: "hidden", fontFamily: FONT, border: `1px solid ${border}` },
    title: { fontSize: 18, fontWeight: 800, color: T.text, marginBottom: 4, padding: "16px 16px 0" },
    subtitle: { fontSize: 13, color: T.subtext, marginBottom: 12, padding: "0 16px" },
    header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: `1px solid ${border}` },
    closeBtn: { background: "transparent", border: "none", fontSize: 24, color: T.subtext, cursor: "pointer", padding: 4, lineHeight: 1 },
    search: { margin: 16, padding: "10px 14px", fontSize: 14, border: `1px solid ${T.inputBorder}`, borderRadius: 8, fontFamily: FONT, background: fieldBg, color: T.text },
    list: { flex: 1, overflowY: "auto", padding: "0 16px", display: "flex", flexDirection: "column", gap: 6 },
    listEmpty: { padding: 32, textAlign: "center", color: T.subtext, fontSize: 13 },
    row: { display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", background: fieldBg, border: `1px solid ${border}`, borderRadius: 10, cursor: "pointer", textAlign: "right", fontFamily: FONT, width: "100%" },
    rowName: { fontSize: 14, fontWeight: 700, color: T.text },
    rowMeta: { fontSize: 11, color: T.subtext, marginTop: 2, fontFamily: "ui-monospace, monospace" },
    newBtn: { margin: 16, padding: "12px 16px", background: T.accent, color: T.accentText, border: "none", borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 700, fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 },
    fieldLabel: { display: "block", fontSize: 12, color: T.subtext, marginBottom: 4, fontWeight: 600 },
    field: { width: "100%", padding: "10px 12px", fontSize: 14, border: `1px solid ${T.inputBorder}`, borderRadius: 8, fontFamily: FONT, boxSizing: "border-box", background: fieldBg, color: T.text },
    saveBtn: { flex: 1, padding: "12px 16px", background: T.accent, color: T.accentText, border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700, fontFamily: FONT },
    backBtn: { padding: "12px 16px", background: card, color: T.text, border: `1px solid ${T.inputBorder}`, borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: FONT },
    unitRow: { display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "14px 16px", background: fieldBg, border: `1px solid ${border}`, borderRadius: 10, cursor: "pointer", fontSize: 15, fontFamily: FONT },
    err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, fontSize: 12 },
  };
}
