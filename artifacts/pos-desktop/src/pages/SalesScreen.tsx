// Sales screen — fully redesigned for Windows desktop usage.
//
// Layout invariant (architect-flagged): payment buttons MUST stay fixed at
// the bottom of the cart pane and never scroll with the items list. The
// cartPane is a flex column with `lines` as the only scrolling region;
// `totals` + `payRow` are pinned at the bottom (flex-shrink:0).

import { useEffect, useMemo, useState } from "react";
import { printReceipt, openCashDrawer, type ReceiptLine } from "../lib/peripherals";
import { generateZatcaQr } from "../lib/zatca";
import { listItems, findItemUnitByBarcode, seedDemoItems, daysUntilExpiry, findItemByPlu, type LocalItem, type ItemUnit } from "../lib/items";
import { parseEmbeddedWeightBarcode, readWeightOnce, getScaleConfig } from "../lib/scale";
import { getVertical, verifyAdminCredentials, type Vertical } from "../lib/standalone";
import { isClient, getChangeVersion } from "../lib/bridge";

const LS_OVERRIDE_LOG = "pos_desktop_pharmacy_overrides_v1";
type OverrideLog = { ts: string; itemId: number; itemName: string; expiryDate: string | null; daysPastExpiry: number; supervisor: string; cashier: string | null };
function appendOverrideLog(entry: OverrideLog) {
  try {
    const raw = localStorage.getItem(LS_OVERRIDE_LOG);
    const arr: OverrideLog[] = raw ? JSON.parse(raw) : [];
    arr.push(entry);
    // Keep last 500 to avoid unbounded growth.
    localStorage.setItem(LS_OVERRIDE_LOG, JSON.stringify(arr.slice(-500)));
  } catch { /* non-fatal */ }
}
import { listCustomers, createCustomer, type LocalCustomer } from "../lib/customers";
import { saveOfflineInvoice, type OfflineInvoicePayload } from "../lib/invoices";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { useCurrencySymbol, currencySymbol } from "../lib/currency";
import {
  saveParkedCart, listParkedCarts, deleteParkedCart, takeResumeCartId,
  type ParkedCart,
} from "../lib/parkedCarts";
import { useTaxSettings, computeTotals } from "../lib/taxSettings";
const LS_PRINTER = "pos_desktop_peripherals_printer";

interface CartLine {
  /** Stable per-line id so weighed items added multiple times for the same
   * catalog row stay independently editable/removable. Round-3 review fix:
   * keying by `item.id` collapsed duplicate-barcode weighings into one
   * React node and made +/-/× mutate every matching line at once. */
  lineId: string;
  item: LocalItem;
  qty: number;
  /** Task #201: when true, qty is in kilograms and the line was priced per-kg. */
  weighed?: boolean;
  /** Multi-unit sale: present when the line was added as a non-base unit
   * (e.g. كرتونة). `item.salePrice` already holds the per-unit price and `qty`
   * counts these units; `factor` = base units (pieces) per one of this unit and
   * is used to deduct stock in the base unit. */
  unit?: { id: string; name: string; factor: number };
}

function newLineId(): string {
  return (crypto as any).randomUUID?.() ?? `ln_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

type Props = { companyName?: string; vatNumber?: string; posSessionId?: number; cashierName?: string };

export default function SalesScreen({ companyName = "ZACOD POS", vatNumber = "300000000000003", posSessionId = 0, cashierName }: Props) {
  const sym = useCurrencySymbol();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [checkoutKey, setCheckoutKey] = useState<string | null>(null);
  // When non-null, the current cart in state was resumed from this parked
  // cart id. Saving (park again) overwrites the same row; completing the
  // checkout deletes it.
  const [activeParkedId, setActiveParkedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [lanTick, setLanTick] = useState(0); // bumped by client LAN polling to refetch items/stock
  // Task #208 — live host-connection status for LAN client devices.
  // null = not yet checked, true = host reachable, false = host unreachable.
  const [hostOnline, setHostOnline] = useState<boolean | null>(null);
  const [items, setItems] = useState<LocalItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [paying, setPaying] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastInvoice, setLastInvoice] = useState<string | null>(null);
  const [customer, setCustomer] = useState<LocalCustomer | null>(null);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [paidStr, setPaidStr] = useState("");
  // Task #201 — weight-capture modal state. Holds the item awaiting a weight.
  const [weighItem, setWeighItem] = useState<LocalItem | null>(null);
  // Multi-unit picker modal state. Holds the item whose sale-unit (base /
  // carton / half-carton) the cashier is choosing on a manual tap.
  const [unitPickItem, setUnitPickItem] = useState<LocalItem | null>(null);
  const [vertical, setVertical] = useState<Vertical>("general");
  useEffect(() => { void getVertical().then((v) => v && setVertical(v)); }, []);
  const isPharmacy = vertical === "pharmacy";

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
          lineId: newLineId(),
          item: {
            id: l.itemId, nameAr: l.nameAr, salePrice: l.salePrice,
            vatRate: l.vatRate, barcode: l.barcode ?? null,
            code: "", nameEn: null, updatedAt: null,
          } as unknown as LocalItem,
          qty: l.qty,
          // Restore the sale-unit so stock still deducts in base units and the
          // line keeps showing "كرتونة" etc. after a resume.
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

  // ── Task #207 — client realtime refresh ────────────────────────────
  // On a `client` device the catalog + stock live on the host. Poll the
  // host's change-version (~3s); when it advances (another till sold, an
  // admin edited an item/price, stock changed) bump `lanTick` to re-run the
  // item-load effect above so this screen never shows stale prices/stock.
  useEffect(() => {
    if (!isClient()) return; // only a client reads from the host; single/host read locally
    let stopped = false;
    let lastVersion = -1;
    const tick = async () => {
      if (stopped) return;
      try {
        const v = await getChangeVersion();
        // getChangeVersion returns null on any reachability failure, so it
        // doubles as the connection probe for the status badge (Task #208) —
        // no extra round-trip needed.
        if (!stopped) setHostOnline(v !== null);
        if (v !== null && v !== lastVersion) {
          if (lastVersion !== -1) setLanTick((n) => n + 1);
          lastVersion = v;
        }
      } catch {
        // host briefly unreachable — keep trying
        if (!stopped) setHostOnline(false);
      }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, 3000);
    return () => { stopped = true; window.clearInterval(id); };
  }, []);

  useBarcodeScanner({
    onScan: async (code) => {
      // Ignore scans while a blocking modal owns the screen — otherwise the
      // cashier's pending weight entry / customer pick would silently lose
      // focus or get overwritten by an unrelated background cart mutation.
      if (weighItem || unitPickItem || showCustomerPicker || paying) return;
      try {
        // Task #201: a barcode-printing scale prints EAN-13 stickers that
        // encode prefix + PLU + weight. Try that first; if it matches AND
        // we can resolve the PLU to a catalog row, push the line with
        // qty=weight_kg and unitPrice=pricePerKg — no modal needed.
        const wb = parseEmbeddedWeightBarcode(code);
        if (wb) {
          const found = await findItemByPlu(wb.plu);
          if (found) {
            pushWeighedLine(found, wb.weightKg);
            return;
          }
          // PLU unknown → fall through to the regular barcode lookup
          // (some POSes also ship plain-EAN catalogs that happen to match
          // the weight-prefix range).
        }
        // Unit-aware lookup: a scanned code may belong to a specific sale-unit
        // (e.g. the carton barcode) — that wins over the base barcode. `unit`
        // is null when the base barcode matched, so we add the base unit.
        const match = await findItemUnitByBarcode(code);
        if (match) {
          if (match.unit) await addUnitToCart(match.item, match.unit);
          else await addToCart(match.item);
        } else setMsg({ kind: "err", text: `لم يُعثر على باركود: ${code}` });
      } catch (e: any) {
        setMsg({ kind: "err", text: `خطأ في البحث: ${e?.message ?? e}` });
      }
    },
  });

  /**
   * Push a weighed line directly (qty = kg, unitPrice = pricePerKg) with
   * no modal — used by the embedded-weight barcode path. We synthesize a
   * LocalItem whose `salePrice = pricePerKg` so the totals math stays the
   * same (line subtotal = salePrice × qty).
   */
  function pushWeighedLine(item: LocalItem, weightKg: number) {
    if (!item.pricePerKg || item.pricePerKg <= 0) {
      setMsg({ kind: "err", text: `الصنف "${item.nameAr}" لا يحتوي على سعر للكيلو` });
      return;
    }
    if (weightKg <= 0) return;
    const synth: LocalItem = { ...item, salePrice: item.pricePerKg };
    setCart((prev) => [...prev, { lineId: newLineId(), item: synth, qty: weightKg, weighed: true }]);
    setMsg({ kind: "ok", text: `⚖️ ${item.nameAr} — ${weightKg.toFixed(3)} كجم` });
  }

  // Tax settings: rate (percent) + mode (inclusive vs exclusive) are
  // configurable per device from the Control Panel. The label below the
  // cart shows the live rate, and `computeTotals` switches the math:
  //   inclusive → salePrice is gross (subtotal = gross / (1+r))
  //   exclusive → salePrice is net   (grandTotal = net * (1+r))
  const { rate: vatRatePct, mode: taxMode } = useTaxSettings();
  const totals = useMemo(() => {
    const raw = cart.reduce((sum, l) => sum + l.item.salePrice * l.qty, 0);
    return computeTotals(raw, vatRatePct, taxMode);
  }, [cart, vatRatePct, taxMode]);

  /**
   * Pharmacy-only safety net: refuse to sell expired medicines. Override
   * requires real admin credentials (verifyAdminCredentials → bcrypt in
   * standalone, PBKDF2 in browser preview) and is audit-logged to
   * `pos_desktop_pharmacy_overrides_v1` in localStorage. The cashier's
   * session is NOT touched by the supervisor auth.
   *
   * Cloud-mode caveat: there is no local admin user store when running
   * against the cloud (no local_users table populated), so verification
   * will always fail and expired items become unsellable on cloud devices.
   * Cloud-mode supervisor override is tracked as a follow-up.
   */
  /**
   * Pharmacy-only expiry gate, shared by base and unit add paths so neither can
   * bypass the supervisor-override safety net. Returns true when the item may be
   * sold (not pharmacy, not expired, or override approved), false when blocked
   * (and sets the error message). On a successful override it logs + shows the
   * approval notice.
   */
  async function ensureExpiryAllowed(item: LocalItem): Promise<boolean> {
    if (!isPharmacy) return true;
    const d = daysUntilExpiry(item);
    if (d === null || d >= 0) return true;
    const username = window.prompt(`❌ ${item.nameAr} منتهي الصلاحية بتاريخ ${item.expiryDate} (مر عليه ${Math.abs(d)} يوم).\n\nلتجاوز الحظر يجب أن يعتمد المشرف عملية البيع.\nاسم مستخدم المشرف:`);
    if (!username || !username.trim()) {
      setMsg({ kind: "err", text: `❌ ${item.nameAr} — منتهي الصلاحية، لا يمكن بيعه` });
      return false;
    }
    const password = window.prompt(`كلمة مرور المشرف ${username}:`);
    if (!password) {
      setMsg({ kind: "err", text: `❌ تم إلغاء التجاوز — ${item.nameAr} لن يُباع` });
      return false;
    }
    const ok = await verifyAdminCredentials(username, password);
    if (!ok) {
      setMsg({ kind: "err", text: `❌ اعتماد المشرف فشل — ${item.nameAr} منتهي الصلاحية ولا يمكن بيعه` });
      return false;
    }
    appendOverrideLog({
      ts: new Date().toISOString(), itemId: item.id, itemName: item.nameAr,
      expiryDate: item.expiryDate ?? null, daysPastExpiry: Math.abs(d),
      supervisor: username.trim(), cashier: cashierName ?? null,
    });
    setMsg({ kind: "ok", text: `⚠️ تم اعتماد التجاوز من المشرف ${username} — ${item.nameAr}` });
    return true;
  }

  async function addToCart(item: LocalItem) {
    setMsg(null);
    // Task #201: weighed items go through the WeightCaptureModal instead
    // of being pushed at qty=1.
    if (item.isWeighed) {
      if (!item.pricePerKg || item.pricePerKg <= 0) {
        setMsg({ kind: "err", text: `الصنف "${item.nameAr}" مفعّل كموزون لكن لا يحتوي على سعر للكيلو` });
        return;
      }
      setWeighItem(item);
      return;
    }
    if (!(await ensureExpiryAllowed(item))) return;
    setCart((prev) => {
      // Non-weighed lines still collapse to a single line per catalog row —
      // tapping the same product twice should bump qty, not spawn duplicates.
      // Weighed lines bypass this branch entirely (see pushWeighedLine).
      // `!l.unit` keeps base-unit lines separate from carton/half-carton lines
      // of the same product (those are added by addUnitToCart).
      const existing = prev.find((l) => l.item.id === item.id && !l.weighed && !l.unit);
      if (existing) return prev.map((l) => l.lineId === existing.lineId ? { ...l, qty: l.qty + 1 } : l);
      return [...prev, { lineId: newLineId(), item, qty: 1 }];
    });
  }

  /**
   * Add an item as a specific NON-BASE sale unit (e.g. كرتونة). We synthesize a
   * LocalItem whose `salePrice = unit.price` so all the existing totals math
   * (subtotal = salePrice × qty) keeps working unchanged. The `unit.factor` is
   * carried on the cart line and applied at checkout to deduct stock in base
   * units. Lines collapse per (item.id + unit.id) so tapping the same unit twice
   * bumps qty rather than spawning duplicates.
   */
  async function addUnitToCart(item: LocalItem, unit: ItemUnit) {
    setMsg(null);
    // Same pharmacy expiry gate as base adds — a carton of expired medicine is
    // still expired medicine.
    if (!(await ensureExpiryAllowed(item))) return;
    const synth: LocalItem = { ...item, salePrice: unit.price };
    setCart((prev) => {
      const existing = prev.find((l) => l.item.id === item.id && l.unit?.id === unit.id && !l.weighed);
      if (existing) return prev.map((l) => l.lineId === existing.lineId ? { ...l, qty: l.qty + 1 } : l);
      return [...prev, { lineId: newLineId(), item: synth, qty: 1, unit: { id: unit.id, name: unit.name, factor: unit.factor } }];
    });
    setMsg({ kind: "ok", text: `➕ ${item.nameAr} — ${unit.name}` });
  }

  /**
   * Manual tap on an item card. If the item has additional sale units (and is
   * not weighed), open the unit picker so the cashier chooses قطعة / كرتونة /
   * etc.; otherwise add the base unit directly.
   */
  function onItemTap(item: LocalItem) {
    if (!item.isWeighed && item.units && item.units.length > 0) {
      setUnitPickItem(item);
      return;
    }
    void addToCart(item);
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

  async function checkout(paymentMethod: "cash" | "card") {
    if (cart.length === 0) return;
    // Printer is OPTIONAL — if not configured, the sale is still recorded
    // (and a non-blocking warning is shown so the cashier can set it up later
    // from "لوحة التحكم → الأجهزة الطرفية"). This unblocks day-1 usage on
    // machines that haven't paired a thermal printer yet.
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
          nameAr: l.weighed
            ? `${l.item.nameAr} (${l.qty.toFixed(3)} كجم)`
            : l.unit ? `${l.item.nameAr} (${l.unit.name})` : l.item.nameAr,
          qty: l.qty, unitPrice: l.item.salePrice, vatRate: l.item.vatRate,
        })),
      };
      // Task #209 — on a CLIENT, decrement stock on the HOST *before* the
      // invoice is persisted. The old flow saved the invoice first and only
      // then asked the host to decrement; if the host rejected an oversell the
      // sale was already on the books with no compensating record, leaving the
      // host's stock/books out of sync. Now an oversell aborts the sale with
      // NO invoice committed, and any lines already decremented this checkout
      // are rolled back so the host stays consistent. Single/host mode is
      // unchanged — it decrements locally AFTER the invoice persists below.
      const client = isClient();
      const applied: Array<{ itemId: number; qty: number }> = [];
      if (client) {
        const { adjustStockShared } = await import("../lib/stock");
        try {
          for (const l of cart) {
            // Stock is kept in the BASE unit (pieces) — selling a carton
            // deducts factor× pieces. weighed/base lines have factor undefined → ×1.
            const baseQty = l.qty * (l.unit?.factor ?? 1);
            await adjustStockShared(l.item.id, -baseQty);
            applied.push({ itemId: l.item.id, qty: baseQty });
          }
        } catch (e: any) {
          // Roll back every decrement already applied in this checkout, then
          // abort BEFORE committing the invoice — no silent partial-stock sale.
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
        // The invoice failed to persist after we already decremented host
        // stock — restore it so the host books match reality, then rethrow
        // to the outer handler (which shows the failure message).
        if (client) {
          const { adjustStockShared } = await import("../lib/stock");
          for (const a of applied) {
            try { await adjustStockShared(a.itemId, a.qty); } catch { /* best effort */ }
          }
        }
        throw e;
      }
      const invNum = saved.invoiceNo;

      // Single/host mode: decrement local stock IMMEDIATELY after the invoice
      // persists, BEFORE printing/drawer/parked cleanup. A printer fault must
      // NOT prevent the stock movement the customer has already walked away
      // with. No-op for untracked items; local adjust never throws.
      if (!client) {
        const { adjustStockShared } = await import("../lib/stock");
        for (const l of cart) {
          try {
            // Deduct in base units: carton line → factor× pieces.
            await adjustStockShared(l.item.id, -(l.qty * (l.unit?.factor ?? 1)));
          } catch { /* single/host — non-fatal, ignore as before. */ }
        }
      }

      const body: ReceiptLine[] = [];
      for (const l of cart) {
        if (l.weighed) {
          // Task #201 receipt format for weighed lines: name on one line,
          // weight × price = total on the next (matches market practice).
          body.push({ text: l.item.nameAr });
          body.push({ text: `  ${l.qty.toFixed(3)} كجم × ${l.item.salePrice.toFixed(2)} = ${(l.item.salePrice * l.qty).toFixed(2)}` });
        } else {
          const label = l.unit ? `${l.item.nameAr} (${l.unit.name})` : l.item.nameAr;
          body.push({ text: `${label.padEnd(20, " ")} ×${l.qty}  ${(l.item.salePrice * l.qty).toFixed(2)}` });
        }
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
        if (change >= 0) {
          body.push({ text: `الباقي للعميل:        ${change.toFixed(2)}`, bold: true });
        }
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
          qrData: qr, cut: true,
          openDrawer: paymentMethod === "cash",
        });
        if (paymentMethod === "cash") {
          try { await openCashDrawer(printer); } catch { /* ignore */ }
        }
      }
      // If this cart was resumed from a parked one, remove the parked row
      // now that it has become a finalized sale.
      if (activeParkedId) {
        try { await deleteParkedCart(activeParkedId); } catch { /* non-fatal */ }
      }
      setLastInvoice(invNum);
      setCart([]); setCheckoutKey(null); setActiveParkedId(null);
      setCustomer(null); setPaidStr("");
      // By the time we reach here the host stock was already decremented
      // (client) or will be (single/host), and the invoice persisted — so the
      // sale is always fully consistent. Oversells aborted earlier with no
      // invoice committed.
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
          {isClient() && (
            <div
              style={
                hostOnline === false ? S.connBadgeOff
                  : hostOnline === true ? S.connBadgeOn
                  : S.connBadgeUnknown
              }
              title={
                hostOnline === false
                  ? "تعذّر الوصول إلى الجهاز الرئيسي — تحقق من شبكة Wi-Fi وأن الجهاز الرئيسي يعمل"
                  : hostOnline === true
                  ? "الاتصال بالجهاز الرئيسي سليم"
                  : "جارٍ التحقق من الاتصال بالجهاز الرئيسي..."
              }
            >
              <span style={{ fontSize: 9 }}>{hostOnline === false ? "🔴" : hostOnline === true ? "🟢" : "⚪"}</span>
              <span>
                {hostOnline === false
                  ? "غير متصل بالجهاز الرئيسي"
                  : hostOnline === true
                  ? "متصل بالجهاز الرئيسي"
                  : "جارٍ التحقق..."}
              </span>
            </div>
          )}
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
              items.map((item) => {
                const d = isPharmacy ? daysUntilExpiry(item) : null;
                // Per spec: < 30 days = RED, 30..< 90 days = YELLOW. Expired
                // items fall into the < 30 bucket (red) and are additionally
                // blocked in addToCart with supervisor-override gate.
                const sev: "red" | "yellow" | null =
                  d === null ? null : d < 30 ? "red" : d < 90 ? "yellow" : null;
                return (
                  <button key={item.id} onClick={() => { onItemTap(item); }} style={S.itemCard}>
                    {sev && (
                      <div style={{
                        position: "absolute" as const, top: 4, insetInlineStart: 4,
                        padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                        background: sev === "red" ? "#fef2f2" : "#fefce8",
                        color: sev === "red" ? "#dc2626" : "#ca8a04",
                        border: `1px solid ${sev === "red" ? "#fecaca" : "#fef08a"}`,
                      }}>
                        {(d as number) < 0 ? "❌ منتهي" : `${sev === "red" ? "⚠️" : "🕒"} ${d}ي`}
                      </div>
                    )}
                    <div style={S.itemName}>{item.nameAr}</div>
                    <div style={S.itemPrice}>{item.salePrice.toFixed(2)} <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 400 }}>{sym}</span></div>
                    {item.barcode && <div style={S.itemBarcode}>{item.barcode}</div>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ─── Cart pane — fixed-width column with sticky bottom ─── */}
      <aside style={S.cartPane}>
        {/* Customer chip — moved ABOVE cart header per UX request. */}
        <div style={S.customerBar}>
          {customer ? (
            <div style={S.customerChip}>
              <span style={{ fontSize: 18 }}>👤</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={S.customerName}>{customer.nameAr}</div>
                {(customer.phone || customer.vatNumber) && (
                  <div style={S.customerMeta}>
                    {customer.phone || ""}{customer.phone && customer.vatNumber ? " · " : ""}{customer.vatNumber || ""}
                  </div>
                )}
              </div>
              <button onClick={() => setShowCustomerPicker(true)} style={S.customerEditBtn} title="تغيير العميل">✏️</button>
              <button onClick={() => setCustomer(null)} style={S.customerRemoveBtn} title="إزالة العميل">×</button>
            </div>
          ) : (
            <button onClick={() => setShowCustomerPicker(true)} style={S.customerAddBtn}>
              <span style={{ fontSize: 18 }}>👤</span>
              <span>إضافة عميل للفاتورة</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 18, color: "#3b82f6" }}>+</span>
            </button>
          )}
        </div>

        <div style={S.cartHeader}>
          <h2 style={S.cartTitle}>
            🛒 السلة
            {cart.length > 0 && (
              <span style={S.cartCountBadge}>
                {cart.length} {cart.length === 1 ? "صنف" : "أصناف"} · {cart.reduce((s, l) => s + l.qty, 0)} قطعة
              </span>
            )}
            {activeParkedId && <span style={S.resumedBadge}>مستأنفة</span>}
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
                <div key={l.lineId} style={S.line}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: "#0f172a", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.item.nameAr}</div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                      {l.unit && <span style={{ color: "#7c3aed", fontWeight: 700 }}>{l.unit.name} · </span>}
                      {l.item.salePrice.toFixed(2)} × {l.qty} = <strong style={{ color: "#0f172a" }}>{(l.item.salePrice * l.qty).toFixed(2)}</strong>
                    </div>
                  </div>
                  <div style={S.qtyControls}>
                    {l.weighed ? (
                      // Task #201 round-3 fix: weighed lines are immutable
                      // after capture — qty *is* the measured weight in kg,
                      // so ±1 would corrupt it. Show the kg readout (locked)
                      // and only allow remove. To re-weigh, delete and add
                      // the item again.
                      <span style={{ minWidth: 80, textAlign: "center", fontWeight: 600, color: "#1d4ed8" }}>
                        ⚖️ {l.qty.toFixed(3)} كجم
                      </span>
                    ) : (
                      <>
                        <button onClick={() => changeQty(l.lineId, -1)} style={S.qtyBtn}>−</button>
                        <span style={{ minWidth: 28, textAlign: "center", fontWeight: 600 }}>{l.qty}</span>
                        <button onClick={() => changeQty(l.lineId, +1)} style={S.qtyBtn}>+</button>
                      </>
                    )}
                    <button onClick={() => removeLine(l.lineId)} style={{ ...S.qtyBtn, color: "#dc2626", borderColor: "#fecaca", marginInlineStart: 6 }}>×</button>
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
            <Row k={`ضريبة ${vatRatePct}%${taxMode === "inclusive" ? " (شاملة)" : ""}`} v={totals.vat.toFixed(2)} />
            <Row k="الإجمالي" v={totals.grandTotal.toFixed(2)} big />
          </div>

          {/* Paid amount + change calculator */}
          {cart.length > 0 && (() => {
            const paidNum = parseFloat(paidStr) || 0;
            const change = paidNum - totals.grandTotal;
            const hasPaid = paidStr.trim() !== "" && paidNum > 0;
            const enough = paidNum >= totals.grandTotal;
            return (
              <div style={S.paidBox}>
                <div style={S.paidRow}>
                  <label style={S.paidLabel}>💵 المبلغ المدفوع</label>
                  <input
                    type="number" inputMode="decimal" step="0.01" min="0"
                    placeholder="0.00"
                    value={paidStr}
                    onChange={(e) => setPaidStr(e.target.value)}
                    style={S.paidInput}
                  />
                </div>
                {hasPaid && (
                  <div style={enough ? S.changeRowOk : S.changeRowShort}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {enough ? "💰 الباقي للعميل" : "⚠️ المتبقي على العميل"}
                    </span>
                    <span style={S.changeAmount}>
                      {Math.abs(change).toFixed(2)} <span style={{ fontSize: 11, fontWeight: 400 }}>{sym}</span>
                    </span>
                  </div>
                )}
                {hasPaid && (
                  <div style={S.paidQuick}>
                    {[totals.grandTotal, 50, 100, 200, 500].filter((v, i, a) => a.indexOf(v) === i).map((v) => (
                      <button key={v} onClick={() => setPaidStr(v.toFixed(2))} style={S.quickBtn}>
                        {v.toFixed(0)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

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

      {showCustomerPicker && (
        <CustomerPicker
          onSelect={(c) => { setCustomer(c); setShowCustomerPicker(false); }}
          onClose={() => setShowCustomerPicker(false)}
        />
      )}

      {weighItem && (
        <WeightCaptureModal
          item={weighItem}
          onCancel={() => setWeighItem(null)}
          onConfirm={(kg) => {
            pushWeighedLine(weighItem, kg);
            setWeighItem(null);
          }}
        />
      )}

      {unitPickItem && (
        <UnitPickerModal
          item={unitPickItem}
          onCancel={() => setUnitPickItem(null)}
          onPick={(unit) => {
            if (unit) void addUnitToCart(unitPickItem, unit);
            else void addToCart(unitPickItem);
            setUnitPickItem(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Unit picker modal (multi-unit pricing) ─────────────────────────
// Opens on a manual tap of an item that has additional sale units. Lets
// the cashier choose the base unit (قطعة) or any defined unit (نص كرتونة
// / كرتونة …). `onPick(null)` = base unit; `onPick(unit)` = that unit.
function UnitPickerModal({
  item, onPick, onCancel,
}: {
  item: LocalItem;
  onPick: (unit: ItemUnit | null) => void;
  onCancel: () => void;
}) {
  const units = item.units ?? [];
  return (
    <div style={S.modalOverlay} onClick={onCancel}>
      <div dir="rtl" style={{ ...S.modalCard, maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>
          {item.nameAr}
        </div>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
          اختر وحدة البيع
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Base unit */}
          <button onClick={() => onPick(null)} style={S.unitPickRow}>
            <span style={{ fontWeight: 700, color: "#0f172a" }}>قطعة</span>
            <span style={{ color: "#166534", fontWeight: 700 }}>{item.salePrice.toFixed(2)} {currencySymbol()}</span>
          </button>
          {units.map((u) => (
            <button key={u.id} onClick={() => onPick(u)} style={S.unitPickRow}>
              <span style={{ fontWeight: 700, color: "#0f172a" }}>
                {u.name}
                <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 400, marginInlineStart: 6 }}>
                  ({u.factor} قطعة)
                </span>
              </span>
              <span style={{ color: "#166534", fontWeight: 700 }}>{u.price.toFixed(2)} {currencySymbol()}</span>
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button onClick={onCancel} style={S.modalBackBtn}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

// ─── Weight capture modal (Task #201) ───────────────────────────────
// Opens whenever a cashier picks a weighed item by tap/click. Polls
// the live scale every 700 ms via lib/scale.ts; the cashier can also
// type the weight by hand for the (common) case where the scale is
// disconnected or the operator weighed the item on a back-room scale.
function WeightCaptureModal({
  item, onConfirm, onCancel,
}: {
  item: LocalItem;
  onConfirm: (kg: number) => void;
  onCancel: () => void;
}) {
  const [reading, setReading] = useState<number | null>(null);
  const [manual, setManual] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasPort = !!getScaleConfig().port;

  async function poll() {
    setBusy(true); setErr(null);
    try {
      const kg = await readWeightOnce();
      setReading(kg);
    } catch (e: any) {
      setErr(e?.message ?? "فشل قراءة الميزان");
    } finally { setBusy(false); }
  }

  // Live polling: re-read every 800 ms while the modal is open. We
  // guard against overlapping reads with a `busy` ref so a slow scale
  // doesn't queue up multiple port-open attempts. The interval is
  // cleared on unmount, on manual entry (typing overrides the live
  // reading anyway), and when no port is configured.
  useEffect(() => {
    if (!hasPort) return;
    let cancelled = false;
    let inflight = false;
    const tick = async () => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        const kg = await readWeightOnce();
        if (!cancelled) { setReading(kg); setErr(null); }
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? "فشل قراءة الميزان");
      } finally { inflight = false; }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, 800);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [hasPort]);

  const live = reading;
  const typed = parseFloat(manual);
  const kg = Number.isFinite(typed) && typed > 0 ? typed : (live ?? 0);
  const subtotal = kg * (item.pricePerKg ?? 0);

  function confirm() {
    if (kg <= 0) { setErr("الوزن يجب أن يكون أكبر من صفر"); return; }
    onConfirm(kg);
  }

  return (
    <div style={S.modalOverlay} onClick={onCancel}>
      <div dir="rtl" style={{ ...S.modalCard, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>
          ⚖️ {item.nameAr}
        </div>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
          السعر: {(item.pricePerKg ?? 0).toFixed(2)} {currencySymbol()} / كجم
        </div>

        {hasPort ? (
          <div style={{ background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 10, padding: 16, textAlign: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#64748b" }}>القراءة من الميزان</div>
            <div style={{ fontSize: 36, fontWeight: 700, color: live !== null ? "#166534" : "#94a3b8" }}>
              {live !== null ? live.toFixed(3) : "—"} <span style={{ fontSize: 18 }}>كجم</span>
            </div>
            <button onClick={() => void poll()} disabled={busy} style={{ ...S.modalSaveBtn, marginTop: 8, background: "#475569" }}>
              {busy ? "..." : "🔄 إعادة القراءة"}
            </button>
          </div>
        ) : (
          <div style={{ ...S.msgErr, marginBottom: 12 }}>
            لم يتم تكوين منفذ الميزان. أدخل الوزن يدوياً، أو افتح ‹الميزان› من لوحة التحكم لتفعيل القراءة الحيّة.
          </div>
        )}

        <label style={{ display: "block", marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: "#475569", marginBottom: 4 }}>وزن يدوي (كجم) — يُلغي قراءة الميزان</div>
          <input type="number" step="0.001" min="0" value={manual}
                 onChange={(e) => setManual(e.target.value)} autoFocus
                 placeholder={live !== null ? live.toFixed(3) : "0.000"}
                 style={{ width: "100%", padding: "12px 14px", fontSize: 18, border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit", textAlign: "center", boxSizing: "border-box" }} />
        </label>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 12px", background: "#fefce8", border: "1px solid #fde047", borderRadius: 8, marginBottom: 12 }}>
          <span style={{ color: "#854d0e" }}>المجموع</span>
          <strong style={{ color: "#854d0e", fontSize: 18 }}>{subtotal.toFixed(2)} {currencySymbol()}</strong>
        </div>

        {err && <div style={S.msgErr}>{err}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={confirm} disabled={kg <= 0} style={{ ...S.modalSaveBtn, opacity: kg <= 0 ? 0.5 : 1 }}>
            ✅ إضافة للسلة
          </button>
          <button onClick={onCancel} style={S.modalBackBtn}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

// ─── Customer picker modal ─────────────────────────────────────────
function CustomerPicker({ onSelect, onClose }: { onSelect: (c: LocalCustomer) => void; onClose: () => void }) {
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
    <div style={S.modalOverlay} onClick={onClose}>
      <div dir="rtl" style={S.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h3 style={{ margin: 0, fontSize: 18, color: "#0f172a" }}>
            {showNew ? "👤 عميل جديد" : "👥 اختر العميل"}
          </h3>
          <button onClick={onClose} style={S.modalCloseBtn}>×</button>
        </div>

        {!showNew ? (
          <>
            <input
              autoFocus placeholder="🔍 بحث بالاسم، الجوال، أو الرقم الضريبي..."
              value={q} onChange={(e) => setQ(e.target.value)}
              style={S.modalSearch}
            />
            <div style={S.modalList}>
              {loading ? (
                <div style={S.modalEmpty}>... جاري التحميل</div>
              ) : rows.length === 0 ? (
                <div style={S.modalEmpty}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🤷‍♂️</div>
                  <div>لا يوجد عميل مطابق</div>
                </div>
              ) : (
                rows.map((c) => (
                  <button key={c.id} onClick={() => onSelect(c)} style={S.customerRow}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={S.customerRowName}>{c.nameAr}</div>
                      {(c.phone || c.vatNumber) && (
                        <div style={S.customerRowMeta}>
                          {c.phone ? `📱 ${c.phone}` : ""}{c.phone && c.vatNumber ? "  ·  " : ""}{c.vatNumber ? `🧾 ${c.vatNumber}` : ""}
                        </div>
                      )}
                    </div>
                    <span style={{ color: "#3b82f6", fontSize: 14, fontWeight: 600 }}>اختيار ←</span>
                  </button>
                ))
              )}
            </div>
            <button onClick={() => setShowNew(true)} style={S.modalNewBtn}>
              <span style={{ fontSize: 18 }}>＋</span> إضافة عميل جديد
            </button>
          </>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={S.modalFieldLabel}>اسم العميل *</label>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} style={S.modalField} />
            </div>
            <div>
              <label style={S.modalFieldLabel}>رقم الجوال</label>
              <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} style={S.modalField} placeholder="05XXXXXXXX" />
            </div>
            <div>
              <label style={S.modalFieldLabel}>الرقم الضريبي (اختياري)</label>
              <input value={newVat} onChange={(e) => setNewVat(e.target.value)} style={S.modalField} placeholder="3xxxxxxxxxxxxx3" />
            </div>
            {err && <div style={S.msgErr}>{err}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button onClick={handleCreate} disabled={saving} style={{ ...S.modalSaveBtn, opacity: saving ? 0.6 : 1 }}>
                {saving ? "..." : "💾 حفظ واختيار"}
              </button>
              <button onClick={() => setShowNew(false)} style={S.modalBackBtn}>← رجوع</button>
            </div>
          </div>
        )}
      </div>
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
  // Task #208 — LAN host-connection status badge (client devices only).
  connBadgeOn: { display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 999, fontSize: 13, color: "#166534", fontWeight: 700, whiteSpace: "nowrap" as const } as const,
  connBadgeOff: { display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 999, fontSize: 13, color: "#b91c1c", fontWeight: 700, whiteSpace: "nowrap" as const } as const,
  connBadgeUnknown: { display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 999, fontSize: 13, color: "#64748b", fontWeight: 600, whiteSpace: "nowrap" as const } as const,
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
    width: 440, background: "#fff", border: "1px solid #e2e8f0",
    borderRadius: 12, display: "flex", flexDirection: "column" as const,
    minHeight: 0,
    boxShadow: "0 4px 16px rgba(0,0,0,.06)",
    overflow: "hidden",
  } as const,
  cartHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 16px", borderBottom: "1px solid #f1f5f9", flexShrink: 0 } as const,
  cartTitle: { margin: 0, fontSize: 18, color: "#0f172a" } as const,
  clearBtn: { padding: "4px 10px", background: "#fff", color: "#64748b", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit" } as const,
  parkBtn: { padding: "4px 10px", background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 } as const,
  resumedBadge: { fontSize: 10, padding: "2px 8px", background: "#dbeafe", color: "#1e40af", borderRadius: 999, marginInlineStart: 8, fontWeight: 700, verticalAlign: "middle" } as const,
  cartCountBadge: { fontSize: 11, padding: "2px 8px", background: "#f1f5f9", color: "#475569", borderRadius: 999, marginInlineStart: 8, fontWeight: 600, verticalAlign: "middle" } as const,

  // THIS is the ONLY scrolling region in the cart — items list.
  // MUST stay minHeight:0 so the sticky footer (payment buttons) is never pushed off-screen.
  linesScroll: { flex: 1, overflowY: "auto" as const, overflowX: "hidden" as const, minHeight: 0, maxHeight: "100%", padding: "12px 16px" } as const,
  cartEmpty: { padding: 40, color: "#94a3b8", fontSize: 14, textAlign: "center" as const } as const,
  lines: { display: "flex", flexDirection: "column" as const, gap: 8 } as const,
  line: { display: "flex", gap: 8, padding: 10, background: "#f8fafc", borderRadius: 8, alignItems: "center" } as const,
  qtyControls: { display: "flex", alignItems: "center", gap: 4, flexShrink: 0 } as const,
  qtyBtn: { width: 28, height: 28, border: "1px solid #cbd5e1", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 16, lineHeight: 1, fontFamily: "inherit" } as const,

  // STICKY FOOTER — flex-shrink:0 keeps it pinned, never scrolls.
  // Compacted (v0.7.6): smaller padding here + on totals + on pay buttons
  // gives ~50px back to the items list so 6+ rows fit on a 720p display.
  footer: { padding: "10px 12px", borderTop: "1px solid #f1f5f9", background: "#fff", flexShrink: 0 } as const,
  totals: { padding: "0 4px 8px" } as const,
  payRow: { display: "flex", gap: 8 } as const,
  payCash: { flex: 1, padding: "12px 10px", background: "linear-gradient(180deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 700, fontFamily: "inherit", boxShadow: "0 2px 6px rgba(22,163,74,.3)" } as const,
  payCard: { flex: 1, padding: "12px 10px", background: "linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%)", color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 700, fontFamily: "inherit", boxShadow: "0 2px 6px rgba(37,99,235,.3)" } as const,
  msgOk: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, fontSize: 12, marginTop: 10 } as const,
  msgErr: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, fontSize: 12, marginTop: 10 } as const,
  lastInv: { fontSize: 11, color: "#94a3b8", textAlign: "center" as const, marginTop: 10 } as const,

  // Customer bar (above cartHeader). Compacted (v0.7.6) — was eating ~70px.
  customerBar: { padding: "6px 12px 0", flexShrink: 0 } as const,
  customerAddBtn: {
    display: "flex", alignItems: "center", gap: 8, width: "100%",
    padding: "6px 12px", background: "linear-gradient(180deg, #eff6ff 0%, #dbeafe 100%)",
    border: "1px dashed #93c5fd", borderRadius: 8, color: "#1e40af",
    cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
  } as const,
  customerChip: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "10px 12px", background: "linear-gradient(180deg, #f0fdf4 0%, #dcfce7 100%)",
    border: "1px solid #86efac", borderRadius: 10,
  } as const,
  customerName: { fontSize: 14, fontWeight: 700, color: "#14532d", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const } as const,
  customerMeta: { fontSize: 11, color: "#166534", marginTop: 2, fontFamily: "ui-monospace, monospace" } as const,
  customerEditBtn: { background: "transparent", border: "none", cursor: "pointer", fontSize: 14, padding: 4 } as const,
  customerRemoveBtn: { background: "#fff", border: "1px solid #fecaca", color: "#dc2626", width: 24, height: 24, borderRadius: "50%", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0, fontWeight: 700 } as const,

  // Paid amount + change box
  paidBox: {
    background: "linear-gradient(180deg, #fefce8 0%, #fef9c3 100%)",
    border: "1px solid #fde047", borderRadius: 10,
    padding: 10, marginBottom: 10,
  } as const,
  paidRow: { display: "flex", alignItems: "center", gap: 8 } as const,
  paidLabel: { fontSize: 13, fontWeight: 700, color: "#854d0e", whiteSpace: "nowrap" as const } as const,
  paidInput: {
    flex: 1, padding: "10px 12px", fontSize: 16, fontWeight: 700,
    border: "1px solid #fde047", borderRadius: 8, fontFamily: "ui-monospace, monospace",
    textAlign: "left" as const, background: "#fff", color: "#0f172a", boxSizing: "border-box" as const,
    minWidth: 0,
  } as const,
  changeRowOk: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    marginTop: 8, padding: "8px 12px",
    background: "#dcfce7", border: "1px solid #86efac", borderRadius: 8, color: "#14532d",
  } as const,
  changeRowShort: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    marginTop: 8, padding: "8px 12px",
    background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, color: "#991b1b",
  } as const,
  changeAmount: { fontSize: 20, fontWeight: 800, fontFamily: "ui-monospace, monospace" } as const,
  paidQuick: { display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" as const } as const,
  quickBtn: {
    flex: 1, minWidth: 50, padding: "6px 8px", background: "#fff",
    border: "1px solid #fde047", borderRadius: 6, cursor: "pointer",
    fontSize: 12, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#854d0e",
  } as const,

  // Customer picker modal
  modalOverlay: {
    position: "fixed" as const, inset: 0, background: "rgba(15,23,42,.55)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 1000, padding: 16, backdropFilter: "blur(2px)",
  } as const,
  modalCard: {
    background: "#fff", borderRadius: 14, width: "100%", maxWidth: 480,
    maxHeight: "85vh", display: "flex", flexDirection: "column" as const,
    boxShadow: "0 20px 60px rgba(0,0,0,.3)", overflow: "hidden",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  } as const,
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #f1f5f9" } as const,
  modalCloseBtn: { background: "transparent", border: "none", fontSize: 24, color: "#64748b", cursor: "pointer", padding: 4, lineHeight: 1 } as const,
  modalSearch: { margin: 16, padding: "10px 14px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit" } as const,
  modalList: { flex: 1, overflowY: "auto" as const, padding: "0 16px", display: "flex", flexDirection: "column" as const, gap: 6 } as const,
  modalEmpty: { padding: 32, textAlign: "center" as const, color: "#94a3b8", fontSize: 13 } as const,
  customerRow: {
    display: "flex", alignItems: "center", gap: 8, padding: "12px 14px",
    background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10,
    cursor: "pointer", textAlign: "right" as const, fontFamily: "inherit", width: "100%",
  } as const,
  customerRowName: { fontSize: 14, fontWeight: 700, color: "#0f172a" } as const,
  customerRowMeta: { fontSize: 11, color: "#64748b", marginTop: 2, fontFamily: "ui-monospace, monospace" } as const,
  modalNewBtn: {
    margin: 16, padding: "12px 16px", background: "linear-gradient(180deg, #3b82f6 0%, #2563eb 100%)",
    color: "#fff", border: "none", borderRadius: 10, cursor: "pointer",
    fontSize: 14, fontWeight: 700, fontFamily: "inherit", display: "flex",
    alignItems: "center", justifyContent: "center", gap: 6,
  } as const,
  modalFieldLabel: { display: "block", fontSize: 12, color: "#475569", marginBottom: 4, fontWeight: 600 } as const,
  modalField: { width: "100%", padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
  modalSaveBtn: { flex: 1, padding: "12px 16px", background: "linear-gradient(180deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 700, fontFamily: "inherit" } as const,
  modalBackBtn: { padding: "12px 16px", background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "inherit" } as const,
  unitPickRow: { display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "14px 16px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, cursor: "pointer", fontSize: 15, fontFamily: "inherit" } as const,
};

// Wrapper around the modal body to fix padding when in "new customer" mode
const _modalNewWrap = { padding: 16 };
void _modalNewWrap;
