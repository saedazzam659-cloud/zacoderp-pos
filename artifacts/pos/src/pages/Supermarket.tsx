import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import {
  Search, Plus, Minus, Trash2, CreditCard, Banknote, Smartphone, Wallet,
  Pause, RotateCcw, Sparkles, LogOut, Loader2, ShoppingCart, Languages,
  Receipt, X, Check, FileText, Store,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  api, getStoredUser, getToken, clearAuth, getPosSessionId, setPosSessionId,
  type Item, type Branch, type Warehouse, type AuthUser, type SalesInvoice,
  type CreateInvoiceLine,
} from "@/lib/api";

type CartLine = {
  item: Item;
  qty: number;
  // When present (return mode loaded from a source invoice), these override
  // the current catalog pricing so we preserve the original invoice-line values.
  overrideUnitPrice?: number;
  overrideVatRate?: number;
  overrideDiscount?: number;
  overrideWarehouseId?: number | null;
};
type HeldTicket = {
  id: string;
  note: string;
  savedAt: number;
  lines: CartLine[];
  mode: "sale" | "return";
  sourceInvoiceId?: number | null;
  sourceDocNumber?: string | null;
};
type Lang = "ar" | "en";

const VAT_RATE = 15;
const HELD_KEY  = "super_pos_held";
const HIST_KEY  = "super_pos_history";
const LANG_KEY  = "super_pos_lang";
const MAX_HIST  = 30;

function fmt(n: number, lang: Lang) {
  return new Intl.NumberFormat(lang === "ar" ? "ar-SA" : "en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n);
}

function loadHeld(): HeldTicket[] {
  try { return JSON.parse(localStorage.getItem(HELD_KEY) || "[]"); } catch { return []; }
}
function saveHeld(list: HeldTicket[]) {
  try { localStorage.setItem(HELD_KEY, JSON.stringify(list)); } catch {}
}
function loadHistory(): number[][] {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); } catch { return []; }
}
function pushHistory(itemIds: number[]) {
  try {
    const h = loadHistory();
    h.unshift(itemIds);
    localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, MAX_HIST)));
  } catch {}
}

export default function SupermarketPage() {
  const [, navigate] = useLocation();
  const [user, setUser] = useState<AuthUser | null>(getStoredUser());
  const [lang, setLang] = useState<Lang>(
    (localStorage.getItem(LANG_KEY) as Lang) || "ar",
  );
  const dir = lang === "ar" ? "rtl" : "ltr";
  const tr = (ar: string, en: string) => (lang === "ar" ? ar : en);

  // Data
  const [items, setItems]         = useState<Item[]>([]);
  const [branches, setBranches]   = useState<Branch[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [cashBoxes, setCashBoxes] = useState<Array<{ id: number; nameAr: string }>>([]);
  const [posSettings, setPosSettings] = useState<{
    posCashCashBoxId: number | null;
    posCardBankAccountId: number | null;
    posAppleBankAccountId: number | null;
    posWalletBankAccountId: number | null;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading]     = useState(true);

  // Cart + modes
  const [cart, setCart]         = useState<CartLine[]>([]);
  const [search, setSearch]     = useState("");
  const [mode, setMode]         = useState<"sale" | "return">("sale");
  const [sourceInvoice, setSourceInvoice] = useState<SalesInvoice | null>(null);
  const [submitting, setSubmitting]       = useState(false);
  const [toast, setToast]                 = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [held, setHeld]                   = useState<HeldTicket[]>(() => loadHeld());
  const [showHold, setShowHold]           = useState(false);
  const [holdNote, setHoldNote]           = useState("");
  const [showReturn, setShowReturn]       = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Auth gate
  useEffect(() => { if (!getToken()) navigate("/login"); }, [navigate]);

  // Lang persistence
  useEffect(() => { localStorage.setItem(LANG_KEY, lang); document.documentElement.dir = dir; }, [lang, dir]);

  // Load data
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!user) { const me = await api.me(); if (!alive) return; setUser(me); }
        const cid = (user?.companyId ?? getStoredUser()?.companyId) as number | null | undefined;
        if (!cid) { setLoadError(tr("لا توجد شركة مرتبطة بحسابك.", "No company linked to your account.")); setLoading(false); return; }
        const [its, whs, brs, cbs, settings] = await Promise.all([
          api.getItems(cid),
          api.getWarehouses(cid).catch(() => []),
          api.getBranches(cid).catch(() => []),
          api.getCashBoxes(cid).catch(() => []),
          api.getPosSettings(cid).catch(() => null),
        ]);
        if (!alive) return;
        setItems(its); setWarehouses(whs); setBranches(brs); setCashBoxes(cbs); setPosSettings(settings);
      } catch (err: any) {
        if (alive) setLoadError(err?.message || tr("تعذّر تحميل البيانات", "Failed to load data"));
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const branchId = useMemo<number | null>(() => {
    const s = Number(localStorage.getItem("pos_branch_id") || "0");
    if (s && branches.some((b) => b.id === s)) return s;
    return branches[0]?.id ?? null;
  }, [branches]);
  const defaultWarehouseId = useMemo<number | null>(() => warehouses[0]?.id ?? null, [warehouses]);
  const defaultCashBoxId   = useMemo<number | null>(() => cashBoxes[0]?.id ?? null, [cashBoxes]);

  // Search suggestions (top 8)
  const suggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [] as Item[];
    const list = items.filter((p) =>
      p.nameAr.toLowerCase().includes(q) ||
      (p.nameEn || "").toLowerCase().includes(q) ||
      p.code.toLowerCase().includes(q) ||
      (p.barcode || "").toLowerCase().includes(q),
    ).slice(0, 8);
    return list;
  }, [items, search]);

  // Smart suggestions: items frequently bought together with current cart
  const smartSuggestions = useMemo(() => {
    if (cart.length === 0) return [] as Item[];
    const cartIds = new Set(cart.map((c) => c.item.id));
    const history = loadHistory();
    const score = new Map<number, number>();
    for (const basket of history) {
      if (!basket.some((id) => cartIds.has(id))) continue;
      for (const id of basket) {
        if (cartIds.has(id)) continue;
        score.set(id, (score.get(id) || 0) + 1);
      }
    }
    const sorted = Array.from(score.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return sorted.map(([id]) => items.find((i) => i.id === id)).filter(Boolean) as Item[];
  }, [cart, items]);

  const addItem = (p: Item, qty = 1) => {
    setCart((c) => {
      const ex = c.find((l) => l.item.id === p.id);
      if (ex) return c.map((l) => l.item.id === p.id ? { ...l, qty: l.qty + qty } : l);
      return [...c, { item: p, qty }];
    });
    setSearch("");
    searchRef.current?.focus();
  };
  const setQty = (id: number, qty: number) =>
    setCart((c) => c.map((l) => l.item.id === id ? { ...l, qty: Math.max(0, qty) } : l).filter((l) => l.qty > 0));
  const removeLine = (id: number) => setCart((c) => c.filter((l) => l.item.id !== id));
  const clearAll = () => { setCart([]); setMode("sale"); setSourceInvoice(null); };

  /**
   * Parse a scale-printed weight barcode (EAN-13 starting with "2").
   * Common Saudi/EU format:
   *   prefix(1) "2" + itemCode(6) + weight-grams(5) + checkDigit(1) = 13 digits
   * Returns { itemCode, weightKg } or null.
   */
  const parseWeightBarcode = (raw: string): { itemCode: string; weightKg: number } | null => {
    const s = raw.trim();
    if (!/^2\d{12}$/.test(s)) return null;
    const itemCode = s.slice(1, 7);          // 6-digit PLU
    const grams = parseInt(s.slice(7, 12), 10); // 5-digit weight (grams)
    if (!Number.isFinite(grams) || grams <= 0) return null;
    return { itemCode, weightKg: grams / 1000 };
  };

  // Barcode + scale + quantity-multiplier handler.
  // Supports:
  //   • Plain Enter — add first match (qty = 1)
  //   • "5*<scan>" — multiply qty by 5
  //   • EAN-13 starting with "2" — parse weight, add by kg
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const raw = search.trim();
    if (!raw) return;

    // Quantity-multiplier prefix: "5*apple" or "5*1234567890123"
    let qtyMultiplier = 1;
    let payload = raw;
    const mult = raw.match(/^(\d+(?:\.\d+)?)\s*[\*xX]\s*(.+)$/);
    if (mult) {
      qtyMultiplier = parseFloat(mult[1]) || 1;
      payload = mult[2].trim();
    }

    // Weight barcode: lookup by 6-digit PLU, qty = weightKg
    const wb = parseWeightBarcode(payload);
    if (wb) {
      const match = items.find(
        (p) => p.code === wb.itemCode || p.barcode === wb.itemCode || p.barcode === payload
      );
      if (match) {
        addItem(match, +(wb.weightKg * qtyMultiplier).toFixed(3));
        return;
      }
    }

    // Otherwise: pick first suggestion match for the payload
    const q = payload.toLowerCase();
    const list = items.filter((p) =>
      p.nameAr.toLowerCase().includes(q) ||
      (p.nameEn || "").toLowerCase().includes(q) ||
      p.code.toLowerCase().includes(q) ||
      (p.barcode || "").toLowerCase().includes(q),
    );
    if (list.length > 0) addItem(list[0], qtyMultiplier);
  };

  const subtotal       = cart.reduce((s, l) => s + Number(l.item.salePrice) * l.qty, 0);
  const vatAmount      = cart.reduce((s, l) => {
    const rate = Number(l.item.vatRate) || VAT_RATE;
    return s + (Number(l.item.salePrice) * l.qty * rate) / 100;
  }, 0);
  const grandTotal     = subtotal + vatAmount;
  const itemCount      = cart.reduce((n, l) => n + l.qty, 0);

  // Hold / recall / delete
  const holdCurrent = () => {
    if (cart.length === 0) { setToast({ kind: "err", msg: tr("السلة فارغة", "Cart is empty") }); return; }
    const t: HeldTicket = {
      id: String(Date.now()), note: holdNote.trim(), savedAt: Date.now(),
      lines: cart, mode, sourceInvoiceId: sourceInvoice?.id ?? null,
      sourceDocNumber: sourceInvoice?.docNumber ?? null,
    };
    const next = [t, ...held].slice(0, 20);
    setHeld(next); saveHeld(next);
    setShowHold(false); setHoldNote(""); clearAll();
    setToast({ kind: "ok", msg: tr("تم حفظ الفاتورة مؤقتاً", "Ticket held") });
  };
  const recall = (t: HeldTicket) => {
    setCart(t.lines); setMode(t.mode);
    if (t.sourceInvoiceId) setSourceInvoice({ id: t.sourceInvoiceId, docNumber: t.sourceDocNumber ?? null, invoiceDate: "", totalAmount: "0", status: "posted" });
    const next = held.filter((h) => h.id !== t.id);
    setHeld(next); saveHeld(next);
  };
  const removeHeld = (id: string) => {
    const next = held.filter((h) => h.id !== id);
    setHeld(next); saveHeld(next);
  };

  const handleLogout = async () => {
    const sid = getPosSessionId();
    if (sid) { try { await api.closePosSession(sid, {}); } catch {} setPosSessionId(null); }
    api.logout().catch(() => {});
    clearAuth(); navigate("/login");
  };

  const methodLabel = (m: "cash" | "card" | "apple" | "wallet") =>
    m === "cash" ? tr("نقدي", "Cash") : m === "card" ? tr("بطاقة", "Card") : m === "apple" ? tr("Apple Pay", "Apple Pay") : tr("محفظة", "Wallet");

  // Pay / submit
  const pay = useCallback(async (method: "cash" | "card" | "apple" | "wallet") => {
    if (cart.length === 0 || submitting) return;
    setSubmitting(true); setToast(null);

    const today = new Date().toISOString().slice(0, 10);

    let paymentType: "cash" | "bank" = "cash";
    let cashBoxIdForPayment: number | null = null;
    let bankAccountIdForPayment: number | null = null;
    if (method === "cash") {
      paymentType = "cash";
      cashBoxIdForPayment = posSettings?.posCashCashBoxId ?? defaultCashBoxId;
    } else {
      const bankId = method === "card"  ? posSettings?.posCardBankAccountId
                   : method === "apple" ? posSettings?.posAppleBankAccountId
                   :                      posSettings?.posWalletBankAccountId;
      if (!bankId) {
        setToast({ kind: "err", msg: tr(`طريقة "${methodLabel(method)}" غير مربوطة بحساب بنكي`, `"${methodLabel(method)}" not linked to a bank account`) });
        setSubmitting(false); return;
      }
      paymentType = "bank"; bankAccountIdForPayment = bankId;
    }
    if (paymentType === "cash" && !cashBoxIdForPayment) {
      setToast({ kind: "err", msg: tr("لم يتم ربط صندوق نقدي", "No cash box configured") });
      setSubmitting(false); return;
    }

    try {
      if (mode === "sale") {
        // Ensure open session
        let sessId = getPosSessionId();
        if (!sessId) {
          try {
            const existing = await api.getCurrentPosSession();
            if (existing) sessId = existing.id;
            else {
              const opened = await api.openPosSession({
                branchId, cashBoxId: defaultCashBoxId, openingCash: 0,
                device: navigator.userAgent.slice(0, 120),
              });
              sessId = opened.id;
            }
            setPosSessionId(sessId);
          } catch {}
        }
        const lines: CreateInvoiceLine[] = cart.map((l) => {
          const unitPrice = Number(l.item.salePrice);
          const lineGross = unitPrice * l.qty;
          return {
            itemId: l.item.id, itemName: l.item.nameAr, itemCode: l.item.code,
            unit: l.item.unit?.nameAr || null, unitId: l.item.unitId ?? null,
            warehouseId: l.item.itemType === "stock" ? defaultWarehouseId : null,
            qty: l.qty, unitPrice, discount: 0,
            vatRate: Number(l.item.vatRate) || VAT_RATE, lineTotal: lineGross,
          };
        });
        const inv = await api.createSalesInvoice({
          invoiceDate: today, branchId, paymentType,
          cashBoxId: cashBoxIdForPayment, bankAccountId: bankAccountIdForPayment,
          subtotal, vatAmount, discountAmount: 0, totalAmount: grandTotal,
          priceIncludesVat: false,
          notes: `SUPER POS — ${methodLabel(method)}`, lines, posSessionId: sessId,
        });
        let posted = false;
        let postErr = "";
        try { await api.postSalesInvoice(inv.id); posted = true; }
        catch (e: any) { postErr = e?.message || ""; }
        pushHistory(cart.map((l) => l.item.id));
        if (posted) {
          setToast({ kind: "ok", msg: tr(`تمت الفاتورة ${inv.docNumber ?? ""}`, `Invoice ${inv.docNumber ?? ""} posted`) });
        } else {
          setToast({ kind: "err", msg: tr(`حُفظت كمسودة ${inv.docNumber ?? ""} لكن تعذّر الترحيل: ${postErr}`, `Saved as draft ${inv.docNumber ?? ""} but posting failed: ${postErr}`) });
        }
      } else {
        // Return — preserve original invoice-line pricing via cart overrides.
        const retLines = cart.map((l) => {
          const unitPrice = l.overrideUnitPrice ?? Number(l.item.salePrice);
          const vatRate   = l.overrideVatRate   ?? (Number(l.item.vatRate) || VAT_RATE);
          const discount  = l.overrideDiscount  ?? 0;
          const lineGross = unitPrice * l.qty;
          return {
            itemId: l.item.id > 0 ? l.item.id : null,
            itemName: l.item.nameAr, itemCode: l.item.code,
            unit: l.item.unit?.nameAr || null, unitId: l.item.unitId ?? null,
            warehouseId: l.item.itemType === "stock"
              ? (l.overrideWarehouseId ?? defaultWarehouseId)
              : null,
            qty: l.qty, unitPrice, discount,
            vatRate, lineTotal: lineGross - discount,
          };
        });
        const retSubtotal = retLines.reduce((s, ln) => s + ln.lineTotal, 0);
        const retVat      = retLines.reduce((s, ln) => s + (ln.lineTotal * ln.vatRate) / 100, 0);
        const retTotal    = retSubtotal + retVat;
        const ret = await api.createSalesReturn({
          returnDate: today, branchId, paymentType,
          cashBoxId: cashBoxIdForPayment, bankAccountId: bankAccountIdForPayment,
          // POS returns inherit the customer from the source invoice so the
          // server's required-customer guard on /sales-returns is satisfied.
          // Walk-in invoices (posSessionId path) have customerId=null on the
          // source — server fall-back will then derive from invoiceId.
          customerId: sourceInvoice?.customerId ?? null,
          invoiceId: sourceInvoice?.id ?? null,
          totalAmount: retTotal, vatAmount: retVat, discountAmount: 0,
          priceIncludesVat: false,
          notes: `SUPER POS RETURN — ${methodLabel(method)}${sourceInvoice ? ` (inv#${sourceInvoice.docNumber ?? sourceInvoice.id})` : ""}`,
          lines: retLines,
        });
        let postedR = false;
        let postErrR = "";
        try { await api.postSalesReturn(ret.id); postedR = true; }
        catch (e: any) { postErrR = e?.message || ""; }
        if (postedR) {
          setToast({ kind: "ok", msg: tr(`تم ترحيل المرتجع ${ret.docNumber ?? ""}`, `Return ${ret.docNumber ?? ""} posted`) });
        } else {
          setToast({ kind: "err", msg: tr(`حُفظ المرتجع كمسودة ${ret.docNumber ?? ""} لكن تعذّر الترحيل: ${postErrR}`, `Return saved as draft ${ret.docNumber ?? ""} but posting failed: ${postErrR}`) });
        }
      }
      clearAll();
    } catch (err: any) {
      setToast({ kind: "err", msg: err?.message || tr("تعذّر الإتمام", "Operation failed") });
    } finally { setSubmitting(false); }
  }, [cart, submitting, mode, sourceInvoice, posSettings, defaultCashBoxId, defaultWarehouseId, branchId, subtotal, vatAmount, grandTotal, lang]);

  if (loading) {
    return <div dir={dir} className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="h-10 w-10 animate-spin text-emerald-600" /></div>;
  }
  if (loadError) {
    const noCompany = user?.role === "superadmin" || !user?.companyId;
    return (
      <div dir={dir} className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="bg-white rounded-xl p-6 max-w-md shadow border text-center space-y-3">
          <div className="text-5xl">⚠️</div>
          <p className="text-red-600 font-semibold">{loadError}</p>
          {noCompany && (
            <p className="text-sm text-slate-600">
              {tr(
                `الحساب الحالي (${user?.username || "—"}) للإدارة العامة وليس مرتبطاً بشركة. نقطة البيع متاحة لحسابات الكاشير فقط.`,
                `The current account (${user?.username || "—"}) is an administrator account not linked to any company. POS is only available for cashier accounts.`,
              )}
            </p>
          )}
          <div className="flex items-center justify-center gap-2 pt-2">
            <Button variant="outline" onClick={() => window.location.reload()}>{tr("إعادة المحاولة", "Retry")}</Button>
            <Button onClick={handleLogout} className="gap-1">
              <LogOut className="h-4 w-4" />
              {tr("تسجيل الخروج", "Logout")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div dir={dir} className={`min-h-screen bg-slate-50 text-slate-900 ${lang === "ar" ? "font-[Cairo,Tajawal,system-ui]" : "font-sans"}`}>
      {/* Top bar */}
      <header className="h-14 bg-gradient-to-l from-emerald-700 via-emerald-600 to-teal-600 text-white px-4 flex items-center gap-3 shadow">
        <div className="flex items-center gap-2 font-bold">
          <Store className="h-5 w-5" />
          {tr("سوبر ماركت — نقطة بيع", "Supermarket POS")}
        </div>
        <div className="text-xs opacity-80 truncate flex-1">
          {user?.company?.nameAr || user?.username} · {branches.find((b) => b.id === branchId)?.nameAr || "—"}
        </div>
        <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 gap-1" onClick={() => setLang(lang === "ar" ? "en" : "ar")}>
          <Languages className="h-4 w-4" /> {lang === "ar" ? "EN" : "AR"}
        </Button>
        <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 gap-1" onClick={() => navigate("/pos")}>
          <Receipt className="h-4 w-4" /> {tr("نمط كلاسيكي", "Classic mode")}
        </Button>
        <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 gap-1" onClick={handleLogout}>
          <LogOut className="h-4 w-4" /> {tr("خروج", "Logout")}
        </Button>
      </header>

      {/* Held tickets bar */}
      {held.length > 0 && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center gap-2 overflow-x-auto">
          <span className="text-xs text-amber-700 font-semibold shrink-0">{tr("فواتير محفوظة:", "Held tickets:")}</span>
          {held.map((t) => (
            <div key={t.id} className="flex items-center gap-1 bg-white border border-amber-300 rounded-full px-2 py-1 text-xs shrink-0 hover:shadow cursor-pointer group" onClick={() => recall(t)}>
              <Pause className="h-3 w-3 text-amber-600" />
              <span className="font-medium">{t.lines.length} {tr("صنف", "items")}</span>
              {t.note && <span className="text-slate-500 max-w-[140px] truncate">— {t.note}</span>}
              {t.mode === "return" && <span className="text-red-600 font-semibold">↩</span>}
              <button onClick={(e) => { e.stopPropagation(); removeHeld(t.id); }} className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-700 ml-1"><X className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
      )}

      {/* Main layout: AR → cart on right, payment on left via RTL + grid */}
      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-0 h-[calc(100vh-56px-(held.length>0?36:0))]" style={{ height: `calc(100vh - 56px${held.length > 0 ? " - 40px" : ""})` }}>
        {/* CART SIDE */}
        <section className="flex flex-col min-h-0 border-slate-200 border-s">
          {/* Search */}
          <div className="p-3 border-b bg-white">
            <div className="relative">
              <Search className={`absolute top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 ${dir === "rtl" ? "right-3" : "left-3"}`} />
              <Input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={tr("ابحث / امسح الباركود / 5*كود لكمية × 5", "Search / scan barcode / 5*code for qty × 5")}
                className={`${dir === "rtl" ? "pr-10" : "pl-10"} h-11 text-base`}
                autoFocus
              />
              {suggestions.length > 0 && (
                <div className="absolute top-full inset-x-0 mt-1 bg-white rounded-lg border shadow-lg z-20 max-h-80 overflow-y-auto">
                  {suggestions.map((p) => (
                    <button key={p.id} onClick={() => addItem(p)} className="w-full flex items-center justify-between px-3 py-2 hover:bg-emerald-50 border-b last:border-b-0 text-sm">
                      <span className="font-medium truncate">{lang === "ar" ? p.nameAr : (p.nameEn || p.nameAr)}</span>
                      <span className="text-xs text-slate-500 font-mono">{p.code} · {fmt(Number(p.salePrice), lang)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Mode + return source banner */}
            {mode === "return" && (
              <div className="mt-2 flex items-center gap-2 text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <RotateCcw className="h-4 w-4 text-red-600" />
                <span className="text-red-700 font-semibold">{tr("وضع مرتجع المبيعات", "Sales Return mode")}</span>
                {sourceInvoice && <span className="text-slate-600 ms-auto">{tr("فاتورة:", "Invoice:")} <strong>{sourceInvoice.docNumber ?? sourceInvoice.id}</strong></span>}
                <button className="text-red-600 hover:underline ms-2" onClick={() => { clearAll(); }}>{tr("خروج", "Exit")}</button>
              </div>
            )}
          </div>

          {/* Cart lines */}
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-3">
                <ShoppingCart className="h-14 w-14" />
                <p>{tr("ابدأ بإضافة الأصناف من شريط البحث", "Start by adding items from the search bar")}</p>
              </div>
            ) : cart.map((l) => {
              const unitPrice = Number(l.item.salePrice);
              const lineTotal = unitPrice * l.qty;
              const name = lang === "ar" ? l.item.nameAr : (l.item.nameEn || l.item.nameAr);
              return (
                <div key={l.item.id} className="bg-white border border-slate-200 rounded-lg px-3 py-2.5 flex items-center gap-3 hover:border-emerald-300 hover:shadow-sm">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">{name}</div>
                    <div className="text-[11px] text-slate-500 font-mono">{l.item.code} · {fmt(unitPrice, lang)} {tr("ر.س", "SAR")}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button type="button" size="icon" variant="outline" className="h-8 w-8" onClick={() => setQty(l.item.id, l.qty - 1)}><Minus className="h-3 w-3" /></Button>
                    <Input
                      value={l.qty}
                      onChange={(e) => setQty(l.item.id, Number(e.target.value) || 0)}
                      className="h-8 w-14 text-center font-mono text-sm"
                    />
                    <Button type="button" size="icon" variant="outline" className="h-8 w-8" onClick={() => setQty(l.item.id, l.qty + 1)}><Plus className="h-3 w-3" /></Button>
                  </div>
                  <div className="w-28 text-end font-mono font-bold text-emerald-700">{fmt(lineTotal, lang)}</div>
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-red-500 hover:bg-red-50" onClick={() => removeLine(l.item.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              );
            })}

            {/* Smart AI suggestions */}
            {smartSuggestions.length > 0 && (
              <div className="mt-4 pt-3 border-t border-dashed">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-purple-700 mb-2">
                  <Sparkles className="h-3.5 w-3.5" />
                  {tr("اقتراحات ذكية (تُشترى عادةً مع هذه الأصناف)", "Smart suggestions (often bought together)")}
                </div>
                <div className="flex flex-wrap gap-2">
                  {smartSuggestions.map((p) => (
                    <button key={p.id} onClick={() => addItem(p)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-purple-50 border border-purple-200 text-purple-800 hover:bg-purple-100">
                      <Plus className="h-3 w-3" />
                      {lang === "ar" ? p.nameAr : (p.nameEn || p.nameAr)}
                      <span className="text-purple-500 font-mono">{fmt(Number(p.salePrice), lang)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer toolbar */}
          <div className="bg-white border-t p-2 flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setShowHold(true)} disabled={cart.length === 0} className="gap-1">
              <Pause className="h-3.5 w-3.5" /> {tr("حفظ مؤقت", "Hold")}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setShowReturn(true)} className="gap-1 border-red-200 text-red-700 hover:bg-red-50">
              <RotateCcw className="h-3.5 w-3.5" /> {tr("مرتجع", "Return")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={clearAll} disabled={cart.length === 0} className="gap-1 text-slate-600">
              <Trash2 className="h-3.5 w-3.5" /> {tr("إفراغ", "Clear")}
            </Button>
            <div className="ms-auto text-xs text-slate-500">{itemCount} {tr("قطعة", "pcs")}</div>
          </div>
        </section>

        {/* PAYMENT SIDE (visually left in AR, right in EN via RTL grid) */}
        <aside className="bg-white border-slate-200 border-e flex flex-col min-h-0">
          <div className={`p-5 ${mode === "return" ? "bg-gradient-to-b from-red-600 to-red-700" : "bg-gradient-to-b from-emerald-600 to-emerald-700"} text-white`}>
            <div className="text-xs opacity-90">{mode === "return" ? tr("إجمالي المرتجع", "Return total") : tr("الإجمالي", "Total")}</div>
            <div className="text-4xl font-bold tracking-tight font-mono mt-1">{fmt(grandTotal, lang)}</div>
            <div className="text-xs opacity-80 mt-1">{tr("ر.س", "SAR")}</div>
            <div className="flex gap-4 mt-3 text-xs opacity-90">
              <span>{tr("صافي:", "Net:")} <strong className="font-mono">{fmt(subtotal, lang)}</strong></span>
              <span>{tr("ض.ق.م:", "VAT:")} <strong className="font-mono">{fmt(vatAmount, lang)}</strong></span>
            </div>
          </div>

          <div className="p-4 space-y-2 flex-1">
            <div className="text-xs font-semibold text-slate-500 mb-1">{tr("طرق الدفع", "Payment methods")}</div>
            <div className="grid grid-cols-2 gap-2">
              <PaymentButton onClick={() => pay("cash")} disabled={submitting || cart.length === 0}
                icon={<Banknote className="h-5 w-5" />} label={tr("نقدي", "Cash")} color="emerald" />
              <PaymentButton onClick={() => pay("card")} disabled={submitting || cart.length === 0}
                icon={<CreditCard className="h-5 w-5" />} label={tr("بطاقة", "Card")} color="blue" />
              <PaymentButton onClick={() => pay("apple")} disabled={submitting || cart.length === 0}
                icon={<Smartphone className="h-5 w-5" />} label="Apple Pay" color="slate" />
              <PaymentButton onClick={() => pay("wallet")} disabled={submitting || cart.length === 0}
                icon={<Wallet className="h-5 w-5" />} label={tr("محفظة", "Wallet")} color="purple" />
            </div>
            {submitting && (
              <div className="flex items-center justify-center gap-2 text-sm text-emerald-700 mt-3">
                <Loader2 className="h-4 w-4 animate-spin" /> {tr("جاري الإتمام…", "Finalizing…")}
              </div>
            )}
          </div>

          {toast && (
            <div className={`m-3 rounded-lg px-3 py-2 text-xs flex items-start gap-2 ${toast.kind === "ok" ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-red-50 text-red-800 border border-red-200"}`}>
              {toast.kind === "ok" ? <Check className="h-4 w-4 mt-0.5 shrink-0" /> : <X className="h-4 w-4 mt-0.5 shrink-0" />}
              <span className="flex-1">{toast.msg}</span>
              <button onClick={() => setToast(null)}><X className="h-3 w-3" /></button>
            </div>
          )}
        </aside>
      </div>

      {/* Hold dialog */}
      {showHold && (
        <Modal onClose={() => setShowHold(false)} title={tr("حفظ الفاتورة مؤقتاً", "Hold ticket")} dir={dir}>
          <p className="text-sm text-slate-600">{tr("يمكنك إضافة ملاحظة لتسهيل التمييز (مثل اسم العميل).", "Add a note to easily identify this ticket (e.g. customer name).")}</p>
          <Input autoFocus value={holdNote} onChange={(e) => setHoldNote(e.target.value)} placeholder={tr("ملاحظة (اختياري)", "Note (optional)")} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setShowHold(false)}>{tr("إلغاء", "Cancel")}</Button>
            <Button onClick={holdCurrent} className="bg-amber-600 hover:bg-amber-700"><Pause className="h-4 w-4 me-1" />{tr("حفظ", "Hold")}</Button>
          </div>
        </Modal>
      )}

      {/* Return dialog */}
      {showReturn && user?.companyId && (
        <ReturnDialog
          companyId={user.companyId}
          onClose={() => setShowReturn(false)}
          onLoad={(inv) => {
            const lines: CartLine[] = (inv.lines || []).map((ln) => {
              const existing = items.find((i) => i.id === (ln.itemId ?? -1));
              const synth: Item = existing || {
                id: ln.itemId ?? -Math.random(),
                code: ln.itemCode || "",
                nameAr: ln.itemName,
                nameEn: null, barcode: null, groupId: null, unitId: ln.unitId ?? null,
                itemType: "stock",
                salePrice: ln.unitPrice, costPrice: "0",
                vatRate: ln.vatRate, imageUrl: null,
                unit: ln.unit ? { id: 0, nameAr: ln.unit } : null, group: null,
              } as Item;
              return {
                item: synth,
                qty: Number(ln.qty) || 1,
                // Lock original invoice line values so prices/VAT/warehouse
                // survive catalog changes and match the source invoice.
                overrideUnitPrice: Number(ln.unitPrice) || 0,
                overrideVatRate:   Number(ln.vatRate)   || 0,
                overrideDiscount:  Number(ln.discount)  || 0,
                overrideWarehouseId: ln.warehouseId ?? null,
              };
            });
            setCart(lines); setMode("return"); setSourceInvoice(inv); setShowReturn(false);
          }}
          dir={dir}
          tr={tr}
          lang={lang}
        />
      )}
    </div>
  );
}

function PaymentButton({ onClick, disabled, icon, label, color }:
  { onClick: () => void; disabled: boolean; icon: React.ReactNode; label: string; color: "emerald" | "blue" | "slate" | "purple" }) {
  const colorMap: Record<string, string> = {
    emerald: "from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 shadow-emerald-200",
    blue:    "from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 shadow-blue-200",
    slate:   "from-slate-700 to-slate-800 hover:from-slate-800 hover:to-slate-900 shadow-slate-300",
    purple:  "from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 shadow-purple-200",
  };
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      className={`h-20 rounded-xl bg-gradient-to-b ${colorMap[color]} text-white font-semibold shadow-md disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none flex flex-col items-center justify-center gap-1 transition-all active:scale-95`}
    >
      {icon}
      <span className="text-sm">{label}</span>
    </button>
  );
}

function Modal({ children, onClose, title, dir }:
  { children: React.ReactNode; onClose: () => void; title: string; dir: string }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div dir={dir} className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-lg">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ReturnDialog({ companyId, onClose, onLoad, dir, tr, lang }:
  { companyId: number; onClose: () => void; onLoad: (inv: SalesInvoice) => void; dir: string; tr: (a: string, e: string) => string; lang: Lang }) {
  const [query, setQuery]     = useState("");
  const [list, setList]       = useState<SalesInvoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);
  const [err, setErr]         = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      setLoading(true); setErr(null);
      try {
        const rows = await api.listSalesInvoices(companyId, query.trim() || undefined);
        if (alive) setList(rows.slice(0, 50));
      } catch (e: any) { if (alive) setErr(e?.message || ""); }
      finally { if (alive) setLoading(false); }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [query, companyId]);

  const open = async (inv: SalesInvoice) => {
    setOpening(inv.id); setErr(null);
    try {
      const full = await api.getSalesInvoice(inv.id);
      onLoad(full);
    } catch (e: any) { setErr(e?.message || tr("تعذّر تحميل الفاتورة", "Failed to load invoice")); }
    finally { setOpening(null); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div dir={dir} className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 space-y-3 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-lg flex items-center gap-2"><RotateCcw className="h-5 w-5 text-red-600" />{tr("مرتجع مبيعات", "Sales Return")}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        <Input
          autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={tr("ابحث برقم الفاتورة أو اسم العميل…", "Search by invoice number or customer…")}
          className="h-10"
        />
        {err && <div className="text-xs text-red-600">{err}</div>}
        <div className="flex-1 overflow-y-auto border rounded-lg divide-y">
          {loading && <div className="p-6 text-center text-slate-400"><Loader2 className="h-5 w-5 animate-spin inline" /></div>}
          {!loading && list.length === 0 && (
            <div className="p-6 text-center text-slate-400 text-sm">
              <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
              {tr("لا توجد نتائج", "No invoices found")}
            </div>
          )}
          {!loading && list.map((inv) => (
            <button key={inv.id} onClick={() => open(inv)}
              disabled={opening === inv.id}
              className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 text-start disabled:opacity-50">
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{inv.docNumber || `#${inv.id}`}{inv.customerName ? ` · ${inv.customerName}` : ""}</div>
                <div className="text-xs text-slate-500">{inv.invoiceDate} · {inv.status}</div>
              </div>
              <div className="font-mono font-bold text-emerald-700">{new Intl.NumberFormat(lang === "ar" ? "ar-SA" : "en-US", { minimumFractionDigits: 2 }).format(Number(inv.totalAmount))}</div>
              {opening === inv.id && <Loader2 className="h-4 w-4 animate-spin" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
