import { useState, useMemo, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Plus,
  Minus,
  Trash2,
  Percent,
  CreditCard,
  Banknote,
  Smartphone,
  Wallet,
  User as UserIcon,
  Pause,
  Receipt,
  Wifi,
  WifiOff,
  Sparkles,
  ChevronLeft,
  Store,
  ScanBarcode,
  ShoppingBag,
  X,
  Check,
  LogOut,
  Loader2,
  ChefHat,
  CookingPot,
  Settings,
  Users,
  RotateCcw,
} from "lucide-react";
import RestaurantOrdersDialog from "@/components/RestaurantOrdersDialog";
import PosAiPanel from "@/components/PosAiPanel";
import ReturnsPage from "@/pages/Returns";
import { enqueueInvoice, syncNow, countQueued } from "@/lib/offlineQueue";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  api,
  getStoredUser,
  getToken,
  clearAuth,
  getPosSessionId,
  setPosSessionId,
  type Item,
  type PosItemGroup,
  type PosItemSubgroup,
  type CashBox,
  type Branch,
  type Warehouse,
  type AuthUser,
  type SalesInvoice,
  type CreateInvoiceLine,
} from "@/lib/api";

type CartLine = {
  item: Item;
  qty: number;
};

type ParkedCart = {
  id: string;
  createdAt: string;
  cart: CartLine[];
  discountPct: number;
};

const VAT_RATE = 15;
const SERVICE_ACCESS: Record<string, { feature: string; action: "view" | "edit" }> = {
  waiter: { feature: "pos_waiter", action: "view" },
  kitchen: { feature: "pos_kitchen", action: "view" },
  analytics: { feature: "pos_waiter", action: "view" },
  settings: { feature: "pos_waiter", action: "edit" },
  supermarket: { feature: "pos_cashier", action: "view" },
};

function hasPosFeatureAccess(
  user: AuthUser | null,
  feature: string,
  action: "view" | "create" | "edit" = "view",
) {
  if (!user) return false;
  if (user.role === "superadmin") return true;
  return user.companyMenuPermissions?.[feature] === true &&
    (user.role === "admin" || user.permissions?.[feature]?.[action] === true);
}

function isParkedCart(value: unknown): value is ParkedCart {
  if (!value || typeof value !== "object") return false;
  const cart = value as ParkedCart;
  return typeof cart.id === "string" &&
    Number.isFinite(Date.parse(cart.createdAt)) &&
    Number.isFinite(Number(cart.discountPct)) &&
    Array.isArray(cart.cart) &&
    cart.cart.length > 0 &&
    cart.cart.every((line) =>
      !!line?.item &&
      Number.isInteger(Number(line.item.id)) &&
      Number.isFinite(Number(line.qty)) &&
      Number(line.qty) > 0,
    );
}

function parkedCartTotal(cart: ParkedCart) {
  const discountPct = Math.max(0, Math.min(100, Number(cart.discountPct) || 0));
  const subtotal = cart.cart.reduce(
    (sum, line) => sum + Number(line.item.salePrice) * line.qty,
    0,
  );
  const discount = subtotal * discountPct / 100;
  const vat = cart.cart.reduce((sum, line) => {
    const gross = Number(line.item.salePrice) * line.qty;
    const net = gross - gross * discountPct / 100;
    return sum + net * (Number(line.item.vatRate) || VAT_RATE) / 100;
  }, 0);
  return subtotal - discount + vat;
}

function formatSAR(n: number) {
  return new Intl.NumberFormat("ar-SA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function imageSrcFromUrl(u?: string | null): string | null {
  if (!u) return null;
  if (!u.startsWith("/objects/")) return u;
  // <img src="..."> can't send Authorization headers, so pass the bearer
  // token via ?token=… (the storage route promotes it to Authorization).
  const tok = getToken();
  return `/api/storage${u}${tok ? `?token=${encodeURIComponent(tok)}` : ""}`;
}
function imageSrc(item: Item): string | null {
  return imageSrcFromUrl(item.imageUrl);
}

function emojiFor(item: Item): string {
  const name = (item.nameAr || "").toLowerCase();
  if (/قهوة|coffee/.test(name)) return "☕";
  if (/شاي|tea/.test(name)) return "🍵";
  if (/خبز|عيش|bread/.test(name)) return "🥖";
  if (/تمر|date/.test(name)) return "🌴";
  if (/حليب|milk/.test(name)) return "🥛";
  if (/ماء|water/.test(name)) return "💧";
  if (/عصير|juice/.test(name)) return "🧃";
  if (/أرز|rice/.test(name)) return "🍚";
  if (/دجاج|chicken/.test(name)) return "🍗";
  if (/لحم|meat/.test(name)) return "🥩";
  if (/برج|burger/.test(name)) return "🍔";
  if (/ساندو/.test(name)) return "🥪";
  if (/شوكو|chocolate/.test(name)) return "🍫";
  if (/كيك|cake/.test(name)) return "🍰";
  if (/فاكهة|fruit/.test(name)) return "🍎";
  if (/خضار/.test(name)) return "🥦";
  if (/ملابس|قميص/.test(name)) return "👕";
  if (/جوال|هاتف/.test(name)) return "📱";
  return "📦";
}

export default function CashierPage() {
  const [, navigate] = useLocation();
  const [user, setUser] = useState<AuthUser | null>(getStoredUser());
  const [items, setItems] = useState<Item[]>([]);
  const [groups, setGroups] = useState<PosItemGroup[]>([]);
  const [subgroups, setSubgroups] = useState<PosItemSubgroup[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [cashBoxes, setCashBoxes] = useState<CashBox[]>([]);
  const [posSettings, setPosSettings] = useState<{
    posCashCashBoxId:       number | null;
    posCardBankAccountId:   number | null;
    posAppleBankAccountId:  number | null;
    posWalletBankAccountId: number | null;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [activeCat, setActiveCat] = useState<number | "all">("all");
  const [activeSubgroup, setActiveSubgroup] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discountPct, setDiscountPct] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [paid, setPaid] = useState(false);
  const [paidMethod, setPaidMethod] = useState<string | null>(null);
  const [lastInvoice, setLastInvoice] = useState<SalesInvoice | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [time, setTime] = useState(new Date());
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [restaurantOpen, setRestaurantOpen] = useState(false);
  const [heldCarts, setHeldCarts] = useState<ParkedCart[]>([]);
  const [heldCartsOpen, setHeldCartsOpen] = useState(false);
  const [returnsOpen, setReturnsOpen] = useState(false);
  // The terminal setting can further hide services, but it never replaces the
  // company-module and signed-in-user permission checks.
  const [enabledServices, setEnabledServices] = useState<string[] | null>(null);
  const canShowService = useCallback((key: string) => {
    const access = SERVICE_ACCESS[key];
    return !!access &&
      hasPosFeatureAccess(user, access.feature, access.action) &&
      (enabledServices === null || enabledServices.includes(key));
  }, [enabledServices, user]);
  const canCreatePosReturn =
    hasPosFeatureAccess(user, "pos_returns", "view") &&
    hasPosFeatureAccess(user, "pos_returns", "create");

  // Auth gate
  useEffect(() => {
    if (!getToken()) {
      navigate("/login");
    }
  }, [navigate]);

  // Online + clock
  useEffect(() => {
    const onO = () => {
      setOnline(true);
      // Auto-sync any queued offline invoices.
      void syncNow(getToken()).catch(() => {});
    };
    const onF = () => setOnline(false);
    // On mount, attempt sync if any queued ops exist.
    void countQueued().then((n) => { if (n > 0 && navigator.onLine) void syncNow(getToken()).catch(() => {}); });
    window.addEventListener("online", onO);
    window.addEventListener("offline", onF);
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => {
      window.removeEventListener("online", onO);
      window.removeEventListener("offline", onF);
      clearInterval(t);
    };
  }, []);

  // Load reference + catalog data
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!user) {
          const me = await api.me();
          if (!alive) return;
          setUser(me);
        }
        const cid = (user?.companyId ?? getStoredUser()?.companyId) as
          | number
          | null
          | undefined;
        if (!cid) {
          setLoadError("لا توجد شركة مرتبطة بحسابك. تواصل مع المدير.");
          setLoading(false);
          return;
        }
        const [its, grs, sgs, whs, brs, cbs, settings] = await Promise.all([
          api.getItems(cid),
          api.getPosItemGroups(cid).catch(() => []),
          api.getPosItemSubgroups(cid).catch(() => []),
          api.getWarehouses(cid).catch(() => []),
          api.getBranches(cid).catch(() => []),
          api.getCashBoxes(cid).catch(() => []),
          api.getPosSettings(cid).catch(() => null),
        ]);
        if (!alive) return;
        setItems(its);
        setGroups(grs);
        setSubgroups(sgs);
        setWarehouses(whs);
        setBranches(brs);
        setCashBoxes(cbs);
        setPosSettings(settings);
        // Resolve terminal-specific service availability. User grants and
        // company module access are checked separately before showing controls.
        api.getEffectiveServices()
          .then((r) => { if (alive) setEnabledServices(r?.services ?? null); })
          .catch(() => {});
      } catch (err: any) {
        if (alive) setLoadError(err?.message || "تعذّر تحميل البيانات");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const branchId = useMemo<number | null>(() => {
    const stored = Number(localStorage.getItem("pos_branch_id") || "0");
    if (stored && branches.some((b) => b.id === stored)) return stored;
    return branches[0]?.id ?? null;
  }, [branches]);

  const parkedCartsStorageKey = useMemo(() => {
    if (!user?.companyId || !user.id) return null;
    let terminalId = "default";
    try {
      terminalId = localStorage.getItem("pos_terminal_id") || "default";
    } catch {
      // The branch and cashier still scope parked carts if terminal storage is unavailable.
    }
    return `zacode_pos_parked_carts_v1:${user.companyId}:${user.id}:branch-${branchId ?? "default"}:terminal-${terminalId}`;
  }, [branchId, user?.companyId, user?.id]);

  useEffect(() => {
    if (!parkedCartsStorageKey) {
      setHeldCarts([]);
      return;
    }
    try {
      const parsed = JSON.parse(localStorage.getItem(parkedCartsStorageKey) || "[]");
      setHeldCarts(Array.isArray(parsed) ? parsed.filter(isParkedCart) : []);
    } catch {
      setHeldCarts([]);
    }
  }, [parkedCartsStorageKey]);

  const defaultWarehouseId = useMemo<number | null>(
    () => warehouses[0]?.id ?? null,
    [warehouses],
  );
  const defaultCashBoxId = useMemo<number | null>(
    () => cashBoxes[0]?.id ?? null,
    [cashBoxes],
  );

  // A payment method is only offered when its destination account is
  // configured: cash needs a cash box (POS-specific or the branch default),
  // card/apple/wallet each need their own bank account in POS settings.
  const availableMethods = useMemo(
    () => ({
      cash:   (posSettings?.posCashCashBoxId ?? defaultCashBoxId) != null,
      card:   posSettings?.posCardBankAccountId != null,
      apple:  posSettings?.posAppleBankAccountId != null,
      wallet: posSettings?.posWalletBankAccountId != null,
    }),
    [posSettings, defaultCashBoxId],
  );

  const branchName = useMemo(() => {
    return branches.find((b) => b.id === branchId)?.nameAr || "—";
  }, [branches, branchId]);

  // Display tabs are driven by the separate POS group assignment, not the
  // accounting item category (groupId).
  const categories = useMemo(() => {
    const usedIds = new Set(
      items
        .map((item) => item.posGroupId)
        .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id)),
    );
    const list = groups.filter((g) => usedIds.has(g.id));
    return [{ id: "all" as const, nameAr: "الكل", imageUrl: null }, ...list];
  }, [items, groups]);

  const availableSubgroups = useMemo(() => {
    if (activeCat === "all") return [];
    const used = new Set(items.filter((item) => item.posGroupId === activeCat)
      .map((item) => item.posSubgroupId).filter((id): id is number => Number.isSafeInteger(id)));
    return subgroups.filter((group) => group.isActive && group.parentPosGroupId === activeCat && used.has(group.id));
  }, [items, subgroups, activeCat]);

  const filtered = useMemo(() => {
    let list = items;
    if (activeCat !== "all") list = list.filter((p) => p.posGroupId === activeCat);
    if (activeSubgroup !== "all") list = list.filter((p) => p.posSubgroupId === activeSubgroup);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (p) =>
          p.nameAr.toLowerCase().includes(q) ||
          p.code.toLowerCase().includes(q) ||
          (p.barcode || "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [items, activeCat, activeSubgroup, search]);

  const addToCart = (p: Item) => {
    setCart((c) => {
      const existing = c.find((l) => l.item.id === p.id);
      if (existing) {
        return c.map((l) =>
          l.item.id === p.id ? { ...l, qty: l.qty + 1 } : l,
        );
      }
      return [...c, { item: p, qty: 1 }];
    });
  };

  const updateQty = (id: number, delta: number) => {
    setCart((c) =>
      c
        .map((l) =>
          l.item.id === id ? { ...l, qty: Math.max(0, l.qty + delta) } : l,
        )
        .filter((l) => l.qty > 0),
    );
  };

  const removeLine = (id: number) => {
    setCart((c) => c.filter((l) => l.item.id !== id));
  };

  const clearCart = () => {
    setCart([]);
    setDiscountPct(0);
    setPaid(false);
    setPaidMethod(null);
    setLastInvoice(null);
    setSubmitError(null);
  };

  const persistParkedCarts = (next: ParkedCart[]) => {
    if (!parkedCartsStorageKey) return false;
    try {
      localStorage.setItem(parkedCartsStorageKey, JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  };

  const parkCurrentCart = () => {
    if (cart.length === 0 || submitting || paid) return;
    const parked: ParkedCart = {
      id: globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
      cart: cart.map((line) => ({ ...line, item: { ...line.item } })),
      discountPct,
    };
    const next = [parked, ...heldCarts];
    if (!persistParkedCarts(next)) {
      setSubmitError("تعذّر حفظ الفاتورة المعلّقة على هذا الجهاز. لم يتم إفراغ السلة.");
      return;
    }
    setHeldCarts(next);
    clearCart();
  };

  const resumeParkedCart = (id: string) => {
    const parked = heldCarts.find((entry) => entry.id === id);
    if (!parked || submitting || paid) return;

    const remaining = heldCarts.filter((entry) => entry.id !== id);
    const next = cart.length > 0
      ? [{
          id: globalThis.crypto?.randomUUID?.() ??
            `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
          createdAt: new Date().toISOString(),
          cart: cart.map((line) => ({ ...line, item: { ...line.item } })),
          discountPct,
        }, ...remaining]
      : remaining;
    if (!persistParkedCarts(next)) {
      window.alert("تعذّر حفظ السلة الحالية قبل استعادة الفاتورة. لم يتغير محتوى السلة.");
      return;
    }

    setHeldCarts(next);
    setCart(parked.cart);
    setDiscountPct(Math.max(0, Math.min(100, Number(parked.discountPct) || 0)));
    setPaid(false);
    setPaidMethod(null);
    setLastInvoice(null);
    setSubmitError(null);
    setHeldCartsOpen(false);
  };

  const deleteParkedCart = (id: string) => {
    if (!window.confirm("هل تريد حذف هذه الفاتورة المعلّقة؟")) return;
    const next = heldCarts.filter((entry) => entry.id !== id);
    if (!persistParkedCarts(next)) {
      window.alert("تعذّر تحديث قائمة الفواتير المعلّقة على هذا الجهاز.");
      return;
    }
    setHeldCarts(next);
  };

  const subtotal = cart.reduce(
    (s, l) => s + Number(l.item.salePrice) * l.qty,
    0,
  );
  const discountAmount = (subtotal * discountPct) / 100;
  const afterDiscount = subtotal - discountAmount;
  const vatAmount = cart.reduce((s, l) => {
    const lineGross = Number(l.item.salePrice) * l.qty;
    const lineDisc = (lineGross * discountPct) / 100;
    const rate = Number(l.item.vatRate) || VAT_RATE;
    return s + ((lineGross - lineDisc) * rate) / 100;
  }, 0);
  const grandTotal = afterDiscount + vatAmount;
  const itemCount = cart.reduce((n, l) => n + l.qty, 0);

  const handleLogout = async () => {
    const sessionId = getPosSessionId();
    if (sessionId) {
      try { await api.closePosSession(sessionId, {}); } catch {}
      setPosSessionId(null);
    }
    api.logout().catch(() => {});
    clearAuth();
    navigate("/login");
  };

  const pay = useCallback(
    async (method: "cash" | "card" | "apple" | "wallet") => {
      if (cart.length === 0 || submitting) return;
      setSubmitError(null);
      setSubmitting(true);

      const today = new Date().toISOString().slice(0, 10);
      const lines: CreateInvoiceLine[] = cart.map((l) => {
        const unitPrice = Number(l.item.salePrice);
        const lineGross = unitPrice * l.qty;
        const lineDisc = (lineGross * discountPct) / 100;
        return {
          itemId: l.item.id,
          itemName: l.item.nameAr,
          itemCode: l.item.code,
          unit: l.item.unit?.nameAr || null,
          unitId: l.item.unitId ?? null,
          warehouseId:
            l.item.itemType === "stock" ? defaultWarehouseId : null,
          qty: l.qty,
          unitPrice,
          discount: lineDisc,
          vatRate: Number(l.item.vatRate) || VAT_RATE,
          lineTotal: lineGross - lineDisc,
        };
      });

      // Route the payment based on company POS settings (admin maps each
      // method to a cashbox or bank account in /pos-settings on the ERP).
      let paymentType: "cash" | "bank" = "cash";
      let cashBoxIdForPayment: number | null = null;
      let bankAccountIdForPayment: number | null = null;
      if (method === "cash") {
        paymentType = "cash";
        cashBoxIdForPayment = posSettings?.posCashCashBoxId ?? defaultCashBoxId;
      } else {
        const bankId = method === "card"   ? posSettings?.posCardBankAccountId
                     : method === "apple"  ? posSettings?.posAppleBankAccountId
                     : method === "wallet" ? posSettings?.posWalletBankAccountId
                     : null;
        if (!bankId) {
          setSubmitError(
            `طريقة الدفع "${methodArabic(method)}" غير مربوطة بحساب بنكي. يرجى الذهاب إلى ERP → إعدادات نقاط البيع وربطها أولاً.`,
          );
          setSubmitting(false);
          return;
        }
        paymentType = "bank";
        bankAccountIdForPayment = bankId;
      }
      if (paymentType === "cash" && !cashBoxIdForPayment) {
        setSubmitError(
          "لم يتم تحديد صندوق نقدي للدفع النقدي. يرجى ربطه من إعدادات نقاط البيع في ERP.",
        );
        setSubmitting(false);
        return;
      }

      try {
        // Ensure we have an open POS session; reopen if missing.
        let posSessionId = getPosSessionId();
        if (!posSessionId) {
          try {
            const existing = await api.getCurrentPosSession();
            if (existing) {
              posSessionId = existing.id;
            } else {
              const opened = await api.openPosSession({
                branchId,
                cashBoxId: defaultCashBoxId,
                openingCash: 0,
                device: navigator.userAgent.slice(0, 120),
              });
              posSessionId = opened.id;
            }
            setPosSessionId(posSessionId);
          } catch {
            // ignore — invoice will be created without session linkage.
          }
        }
        const invoiceBody = {
          invoiceDate: today,
          branchId,
          paymentType,
          cashBoxId: cashBoxIdForPayment,
          bankAccountId: bankAccountIdForPayment,
          subtotal,
          vatAmount,
          discountAmount,
          totalAmount: grandTotal,
          priceIncludesVat: false,
          notes: `POS — ${methodArabic(method)}`,
          lines,
          posSessionId,
        };
        try {
          const inv = await api.createSalesInvoice(invoiceBody);
          // Try to post (creates journal entry + decrements stock).
          try {
            const posted = await api.postSalesInvoice(inv.id);
            setLastInvoice(posted);
          } catch (postErr: any) {
            setLastInvoice(inv);
            setSubmitError(
              "تم حفظ الفاتورة كمسودة، لكن تعذّر ترحيلها: " + (postErr?.message || ""),
            );
          }
        } catch (netErr: any) {
          // Offline fallback: queue locally and show a soft receipt.
          if (!navigator.onLine || /Failed to fetch|NetworkError|الاتصال/.test(netErr?.message || "")) {
            const op = await enqueueInvoice(invoiceBody as any);
            setLastInvoice({
              id: 0, docNumber: `OFFLINE-${op.clientId.slice(0, 8)}`,
              invoiceDate: today, totalAmount: String(grandTotal), status: "queued_offline",
            } as any);
            setSubmitError("تم حفظ الفاتورة محلياً (وضع عدم الاتصال) — ستتم المزامنة تلقائياً عند عودة الإنترنت.");
          } else {
            throw netErr;
          }
        }
        setPaidMethod(method);
        setPaid(true);
      } catch (err: any) {
        setSubmitError(err?.message || "تعذّر إنشاء الفاتورة");
      } finally {
        setSubmitting(false);
      }
    },
    [
      cart,
      submitting,
      discountPct,
      defaultWarehouseId,
      defaultCashBoxId,
      branchId,
      subtotal,
      vatAmount,
      discountAmount,
      grandTotal,
    ],
  );

  const timeStr = new Intl.DateTimeFormat("ar-SA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(time);

  return (
    <div
      dir="rtl"
      className="h-screen w-full bg-background text-foreground flex flex-col overflow-hidden"
    >
      {/* TOP BAR */}
      <header className="h-16 border-b border-border bg-card/80 backdrop-blur-xl px-4 lg:px-6 flex items-center justify-between gap-4 sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-chart-2 grid place-items-center shadow-lg shadow-primary/30">
            <Store className="w-5 h-5 text-primary-foreground" strokeWidth={2.4} />
          </div>
          <div className="hidden sm:block">
            <p className="text-sm font-extrabold leading-tight">
              زاكود <span className="text-primary">POS</span>
            </p>
            <p className="text-[10px] text-muted-foreground leading-tight">
              {branchName} • {user?.company?.nameAr || ""}
            </p>
          </div>
        </div>

        <div className="flex-1 max-w-xs">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث باسم المنتج أو الباركود..."
              className="h-10 pr-10 pl-12 text-sm font-medium rounded-xl"
            />
            <button
              type="button"
              title="مسح الباركود"
              className="absolute left-1.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg bg-muted text-foreground grid place-items-center hover-elevate active-elevate-2"
            >
              <ScanBarcode className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className={`hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-bold border ${
              online
                ? "bg-primary/10 text-primary border-primary/20"
                : "bg-destructive/10 text-destructive border-destructive/20"
            }`}
          >
            {online ? (
              <Wifi className="w-3 h-3" />
            ) : (
              <WifiOff className="w-3 h-3" />
            )}
            {online ? "متصل" : "دون اتصال"}
          </div>
          <div className="hidden lg:flex items-center gap-2 text-xs font-semibold text-muted-foreground font-mono px-2.5 py-1.5 rounded-full bg-muted">
            {timeStr}
          </div>
          <button
            title={user?.username || "حساب"}
            className="w-10 h-10 rounded-xl border border-border bg-card grid place-items-center hover-elevate active-elevate-2"
          >
            <UserIcon className="w-4 h-4" />
          </button>
          {heldCarts.length > 0 && (
            <button
              type="button"
              onClick={() => setHeldCartsOpen(true)}
              title={`الفواتير المعلّقة (${heldCarts.length})`}
              aria-label={`عرض الفواتير المعلّقة، ${heldCarts.length}`}
              className="relative w-10 h-10 rounded-xl border border-amber-300 bg-amber-50 text-amber-800 grid place-items-center hover-elevate active-elevate-2"
              data-testid="button-open-parked-carts"
            >
              <Pause className="w-4 h-4" />
              <span className="absolute -top-1 -left-1 min-w-5 h-5 px-1 rounded-full bg-amber-600 text-white text-[10px] font-black grid place-items-center">
                {heldCarts.length}
              </span>
            </button>
          )}
          {canShowService("waiter") && (
            <>
              <button
                onClick={() => navigate("/waiter")}
                title="تطبيق النادل (الطاولات)"
                className="h-10 px-3 rounded-xl border border-amber-300 bg-amber-50 text-amber-800 text-xs font-semibold grid place-items-center gap-1 hover-elevate active-elevate-2 hidden md:flex"
                data-testid="svc-waiter"
              >
                <Users className="w-4 h-4" /> النادل
              </button>
              <button
                onClick={() => setRestaurantOpen(true)}
                title="طلبات الصالة (المطعم)"
                className="h-10 px-3 rounded-xl border border-amber-300 bg-amber-50 text-amber-800 text-xs font-semibold grid place-items-center gap-1 hover-elevate active-elevate-2 hidden md:flex"
                data-testid="svc-waiter-orders"
              >
                <ChefHat className="w-4 h-4" /> طلبات الصالة
              </button>
            </>
          )}
          {canShowService("kitchen") && (
            <button
              onClick={() => navigate("/kitchen")}
              title="شاشة المطبخ"
              className="h-10 px-3 rounded-xl border border-rose-300 bg-rose-50 text-rose-800 text-xs font-semibold grid place-items-center gap-1 hover-elevate active-elevate-2 hidden md:flex"
              data-testid="svc-kitchen"
            >
              <CookingPot className="w-4 h-4" /> المطبخ
            </button>
          )}
          {canShowService("analytics") && (
            <button
              onClick={() => navigate("/restaurant-ai")}
              title="تحليلات الذكاء الاصطناعي"
              className="h-10 px-3 rounded-xl border border-violet-300 bg-violet-50 text-violet-800 text-xs font-semibold grid place-items-center gap-1 hover-elevate active-elevate-2 hidden md:flex"
              data-testid="svc-analytics"
            >
              <Sparkles className="w-4 h-4" /> الذكاء
            </button>
          )}
          {canShowService("settings") && (
            <button
              onClick={() => navigate("/restaurant-settings")}
              title="إعدادات المطعم"
              className="w-10 h-10 rounded-xl border border-border bg-card grid place-items-center hover-elevate active-elevate-2 hidden md:flex"
              data-testid="svc-settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          {canShowService("supermarket") && (
            <button
              onClick={() => navigate("/super")}
              title="نمط سوبر ماركت"
              className="h-10 px-3 rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs font-semibold grid place-items-center hover-elevate active-elevate-2 hidden md:flex"
              data-testid="svc-supermarket"
            >
              🛒 سوبر ماركت
            </button>
          )}
          <button
            onClick={handleLogout}
            title="تسجيل الخروج"
            className="w-10 h-10 rounded-xl border border-border bg-card grid place-items-center hover-elevate active-elevate-2"
          >
            <LogOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => setMobileCartOpen(true)}
            className="lg:hidden relative w-10 h-10 rounded-xl border border-border bg-card grid place-items-center hover-elevate active-elevate-2"
          >
            <ShoppingBag className="w-4 h-4" />
            {itemCount > 0 && (
              <span className="absolute -top-1 -left-1 min-w-5 h-5 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-black grid place-items-center">
                {itemCount}
              </span>
            )}
          </button>
        </div>
      </header>

      <div className="flex-1 grid lg:grid-cols-[minmax(0,1fr)_26rem] xl:grid-cols-[minmax(0,1fr)_30rem] 2xl:grid-cols-[minmax(0,1fr)_32rem] min-h-0">
        {/* LEFT — products */}
        <section className="flex flex-col min-h-0 min-w-0">
          {/* Categories */}
          {categories.length > 1 && (
            <div className="px-4 lg:px-6 py-3 border-b border-border overflow-x-auto">
              <div className="flex items-center gap-2 min-w-max">
                {categories.map((c) => {
                  const active = activeCat === c.id;
                  return (
                    <button
                      key={String(c.id)}
                      onClick={() => { setActiveCat(c.id as any); setActiveSubgroup("all"); }}
                      aria-pressed={active}
                      data-testid={`button-pos-display-group-${String(c.id)}`}
                      className={`flex items-center gap-2 px-4 h-11 rounded-xl border font-bold text-sm whitespace-nowrap transition-all hover-elevate active-elevate-2 ${
                        active
                          ? "bg-primary text-primary-foreground border-primary shadow-md shadow-primary/25"
                          : "bg-card border-border text-foreground"
                      }`}
                    >
                      {c.id !== "all" && (imageSrcFromUrl(c.imageUrl) ? (
                        <img
                          src={imageSrcFromUrl(c.imageUrl) ?? undefined}
                          alt=""
                          className="h-6 w-6 rounded-md object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <span className={`grid h-6 w-6 place-items-center rounded-md text-[10px] font-black ${
                          active ? "bg-primary-foreground/15 text-primary-foreground" : "bg-primary/10 text-primary"
                        }`} aria-hidden="true">
                          {c.nameAr.slice(0, 1)}
                        </span>
                      ))}
                      <span>{c.nameAr}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {availableSubgroups.length > 0 && (
            <div className="border-b border-border px-4 py-2 lg:px-6">
              <div className="flex items-center gap-2 overflow-x-auto">
                <span className="shrink-0 text-xs font-bold text-muted-foreground">المجموعات الفرعية</span>
                <button type="button" data-testid="button-pos-subgroup-all" aria-pressed={activeSubgroup === "all"}
                  onClick={() => setActiveSubgroup("all")}
                  className={`flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${activeSubgroup === "all" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"}`}>
                  الكل
                </button>
                {availableSubgroups.map((group) => <button type="button" key={group.id} data-testid={`button-pos-subgroup-${group.id}`}
                  aria-pressed={activeSubgroup === group.id} onClick={() => setActiveSubgroup(group.id)}
                  className={`flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${activeSubgroup === group.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"}`}>
                  {group.imageUrl && <img src={imageSrcFromUrl(group.imageUrl) ?? undefined} alt="" className="h-6 w-6 rounded object-cover" loading="lazy" />}
                  <span>{group.nameAr}</span>
                </button>)}
              </div>
            </div>
          )}

          {/* Products grid */}
          <div className="flex-1 overflow-y-auto p-4 lg:p-6">
            {loading ? (
              <div className="h-full grid place-items-center text-muted-foreground py-20">
                <div className="text-center">
                  <Loader2 className="w-8 h-8 mx-auto animate-spin text-primary mb-2" />
                  <p className="font-bold">جاري تحميل المنتجات...</p>
                </div>
              </div>
            ) : loadError ? (
              <div className="h-full grid place-items-center text-center py-20">
                <div className="max-w-md">
                  <div className="text-5xl mb-3">⚠️</div>
                  <p className="font-bold text-destructive">{loadError}</p>
                  {(user?.role === "superadmin" || !user?.companyId) && (
                    <p className="text-sm text-muted-foreground mt-3">
                      الحساب الحالي <strong>({user?.username || "—"})</strong> للإدارة العامة وليس مرتبطاً بشركة.
                      نقطة البيع متاحة لحسابات الكاشير فقط.
                      <br />
                      سجّل خروج ثم ادخل بحساب كاشير مرتبط بشركة.
                    </p>
                  )}
                  <div className="flex items-center justify-center gap-2 mt-4">
                    <Button
                      onClick={() => window.location.reload()}
                      variant="outline"
                    >
                      إعادة المحاولة
                    </Button>
                    <Button
                      onClick={handleLogout}
                      variant="default"
                      className="gap-1"
                    >
                      <LogOut className="w-4 h-4" />
                      تسجيل الخروج
                    </Button>
                  </div>
                </div>
              </div>
            ) : filtered.length === 0 ? (
              <div className="h-full grid place-items-center text-center text-muted-foreground py-20">
                <div>
                  <div className="text-5xl mb-3">🔍</div>
                  <p className="font-bold">
                    {items.length === 0
                      ? "لا توجد أصناف معرّفة بعد"
                      : "لا توجد منتجات مطابقة"}
                  </p>
                  <p className="text-xs mt-1">
                    {items.length === 0
                      ? "أضف أصنافًا من نظام إدارة المخزون"
                      : "جرّب كلمة بحث أخرى أو فئة مختلفة"}
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                {filtered.map((p) => {
                  const inCart = cart.find((l) => l.item.id === p.id);
                  return (
                    <motion.button
                      key={p.id}
                      layout
                      whileTap={{ scale: 0.97 }}
                      onClick={() => addToCart(p)}
                      className={`relative text-right rounded-2xl border bg-card p-3 hover-elevate active-elevate-2 transition-all ${
                        inCart
                          ? "border-primary ring-2 ring-primary/20"
                          : "border-card-border"
                      }`}
                    >
                      {inCart && (
                        <div className="absolute top-2 left-2 min-w-6 h-6 px-1.5 rounded-full bg-primary text-primary-foreground text-[11px] font-black grid place-items-center shadow">
                          {inCart.qty}
                        </div>
                      )}
                      <div className="aspect-square rounded-xl bg-gradient-to-br from-muted to-muted/30 grid place-items-center text-5xl mb-2 overflow-hidden">
                        {imageSrc(p) ? (
                          <img src={imageSrc(p)!} alt="" className="w-full h-full object-cover" />
                        ) : (
                          emojiFor(p)
                        )}
                      </div>
                      <p className="font-bold text-sm leading-snug line-clamp-2 min-h-[2.5rem]">
                        {p.nameAr}
                      </p>
                      <div className="mt-2 flex items-baseline justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {p.code}
                        </span>
                        <span className="text-base font-black text-primary">
                          {formatSAR(Number(p.salePrice))}
                          <span className="text-[10px] text-muted-foreground font-bold mr-0.5">
                            ر.س
                          </span>
                        </span>
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* RIGHT — cart panel (desktop) */}
        <aside className="hidden lg:flex min-h-0 min-w-0 flex-col border-r border-border bg-card/60 backdrop-blur-xl">
          <CartPanel
            cart={cart}
            updateQty={updateQty}
            removeLine={removeLine}
            canCreatePosReturn={canCreatePosReturn}
            openReturns={() => setReturnsOpen(true)}
            subtotal={subtotal}
            discountPct={discountPct}
            setDiscountPct={setDiscountPct}
            discountAmount={discountAmount}
            vatAmount={vatAmount}
            grandTotal={grandTotal}
            itemCount={itemCount}
            parkCurrentCart={parkCurrentCart}
            paid={paid}
            pay={pay}
            methods={availableMethods}
            submitting={submitting}
            submitError={submitError}
          />
        </aside>
      </div>

      {/* Mobile cart sheet */}
      <AnimatePresence>
        {mobileCartOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileCartOpen(false)}
              className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 250 }}
              className="fixed inset-y-0 right-0 w-full max-w-md min-h-0 bg-card z-50 flex flex-col lg:hidden"
            >
              <div className="h-14 px-4 border-b border-border flex items-center justify-between">
                <p className="font-extrabold">السلة</p>
                <button
                  onClick={() => setMobileCartOpen(false)}
                  className="w-9 h-9 rounded-lg grid place-items-center hover-elevate active-elevate-2"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <CartPanel
                cart={cart}
                updateQty={updateQty}
                removeLine={removeLine}
                canCreatePosReturn={canCreatePosReturn}
                openReturns={() => setReturnsOpen(true)}
                subtotal={subtotal}
                discountPct={discountPct}
                setDiscountPct={setDiscountPct}
                discountAmount={discountAmount}
                vatAmount={vatAmount}
                grandTotal={grandTotal}
                itemCount={itemCount}
                parkCurrentCart={parkCurrentCart}
                paid={paid}
                pay={async (m) => {
                  await pay(m);
                  setMobileCartOpen(false);
                }}
                methods={availableMethods}
                submitting={submitting}
                submitError={submitError}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {heldCartsOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] grid place-items-center bg-black/55 p-3 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setHeldCartsOpen(false);
          }}
        >
          <motion.section
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="parked-carts-title"
            className="w-full max-w-2xl overflow-hidden rounded-3xl border border-border bg-card text-foreground shadow-2xl"
            data-testid="dialog-parked-carts"
          >
            <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-5 py-4">
              <div>
                <h2 id="parked-carts-title" className="text-lg font-black">الفواتير المعلّقة</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  محفوظة على هذا الجهاز، ويمكنك استعادتها أو متابعة أكثر من فاتورة.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHeldCartsOpen(false)}
                aria-label="إغلاق قائمة الفواتير المعلّقة"
                className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card hover-elevate"
              >
                <X className="size-4" />
              </button>
            </header>
            {cart.length > 0 && !paid && (
              <p className="border-b border-border bg-primary/5 px-5 py-2.5 text-xs font-semibold text-primary">
                عند استعادة فاتورة، ستُحفظ السلة الحالية تلقائياً ضمن القائمة.
              </p>
            )}
            <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4 sm:p-5">
              {heldCarts.map((parked, index) => (
                <article
                  key={parked.id}
                  className="rounded-2xl border border-border bg-background p-4"
                  data-testid={`parked-cart-${parked.id}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-extrabold">فاتورة معلّقة {heldCarts.length - index}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {new Intl.DateTimeFormat("ar-SA", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(parked.createdAt))}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-black text-primary">
                      {formatSAR(parkedCartTotal(parked))} ر.س
                    </p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {parked.cart.slice(0, 4).map((line) => (
                      <span
                        key={`${parked.id}-${line.item.id}`}
                        className="rounded-lg bg-muted px-2.5 py-1 text-[11px] font-semibold"
                      >
                        {line.item.nameAr} × {line.qty}
                      </span>
                    ))}
                    {parked.cart.length > 4 && (
                      <span className="rounded-lg bg-muted px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
                        +{parked.cart.length - 4} أصناف
                      </span>
                    )}
                  </div>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={() => resumeParkedCart(parked.id)}
                      disabled={submitting || paid}
                      className="h-10 flex-1 rounded-xl bg-primary px-4 text-sm font-extrabold text-primary-foreground hover-elevate disabled:opacity-50"
                      data-testid={`button-resume-parked-${parked.id}`}
                    >
                      استعادة الفاتورة
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteParkedCart(parked.id)}
                      disabled={submitting || paid}
                      className="grid size-10 place-items-center rounded-xl border border-border text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      title="حذف الفاتورة المعلّقة"
                      aria-label="حذف الفاتورة المعلّقة"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </motion.section>
        </motion.div>
      )}

      {returnsOpen && canCreatePosReturn && (
        <ReturnsPage embedded onClose={() => setReturnsOpen(false)} />
      )}

      {/* Receipt modal */}
      <AnimatePresence>
        {paid && (
          <ReceiptModal
            method={paidMethod || ""}
            invoice={lastInvoice}
            cart={cart}
            subtotal={subtotal}
            discountAmount={discountAmount}
            vatAmount={vatAmount}
            grandTotal={grandTotal}
            warning={submitError}
            onClose={clearCart}
            companyLogo={((user?.company as any)?.logo ?? null) as string | null}
            companyNameAr={(user?.company?.nameAr ?? "") as string}
            cashierName={(user?.nameAr || user?.username || "") as string}
          />
        )}
      </AnimatePresence>

      {canShowService("waiter") && (
        <RestaurantOrdersDialog
          open={restaurantOpen}
          onClose={() => setRestaurantOpen(false)}
          branchId={branchId}
          cashCashBoxId={posSettings?.posCashCashBoxId ?? defaultCashBoxId ?? null}
          cardBankAccountId={posSettings?.posCardBankAccountId ?? null}
          defaultWarehouseId={defaultWarehouseId ?? null}
        />
      )}

      {canShowService("analytics") && (
        <PosAiPanel
          cart={cart}
          totalAmount={grandTotal}
          discountPct={discountPct}
          paymentType="cash"
          allItems={items}
          onAddItem={(it) => setCart((c) => {
            const ex = c.find((l) => l.item.id === it.id);
            return ex ? c.map((l) => l.item.id === it.id ? { ...l, qty: l.qty + 1 } : l) : [...c, { item: it, qty: 1 }];
          })}
          onApplyDiscount={(pct) => setDiscountPct(pct)}
        />
      )}
    </div>
  );
}

// ─── Thermal receipt printing ────────────────────────────────────────────────
// Injects a transient @page + visibility stylesheet so a single window.print()
// call sends ONLY the receipt content to a thermal roll printer (typically
// 80mm for restaurants / supermarkets, 58mm for compact handhelds). The
// stylesheet is removed right after the print dialog closes so the next
// browser print (e.g. plain "طباعة") still uses the user's default A4 setup.
function printThermal(widthMm: 58 | 80 = 80) {
  const css = `
    @page { size: ${widthMm}mm auto; margin: 2mm; }
    @media print {
      html, body { background: #fff !important; }
      body * { visibility: hidden !important; }
      [data-thermal-root], [data-thermal-root] * { visibility: visible !important; }
      [data-thermal-root] {
        position: absolute !important;
        inset: 0 !important;
        width: ${widthMm}mm !important;
        max-width: ${widthMm}mm !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        background: #fff !important;
        color: #000 !important;
        font-size: 11px !important;
        line-height: 1.35 !important;
      }
      /* Compress padding inside the receipt so it fits the narrow roll. */
      [data-thermal-root] .p-6 { padding: 6px !important; }
      [data-thermal-root] .py-2 { padding-top: 4px !important; padding-bottom: 4px !important; }
      [data-thermal-root] .pt-2 { padding-top: 4px !important; }
      [data-thermal-root] .pt-3 { padding-top: 6px !important; }
      [data-thermal-root] .pb-2 { padding-bottom: 4px !important; }
      /* Drop the gradient header background — thermal printers can't render
         colour, and the dark fill wastes ink-ribbon-equivalent paper darkness. */
      [data-thermal-root] .bg-gradient-to-br,
      [data-thermal-root] .bg-gradient-to-tr { background: #fff !important; color: #000 !important; }
      [data-thermal-root] .text-primary,
      [data-thermal-root] .text-primary-foreground { color: #000 !important; }
      [data-thermal-root] .text-muted-foreground { color: #333 !important; }
      [data-thermal-root] .ring-4, [data-thermal-root] .border-4 { box-shadow: none !important; }
      [data-thermal-root] .rounded-3xl,
      [data-thermal-root] .rounded-2xl,
      [data-thermal-root] .rounded-xl { border-radius: 0 !important; }
    }
  `;
  const tag = document.createElement("style");
  tag.setAttribute("data-thermal-print", "1");
  tag.textContent = css;
  document.head.appendChild(tag);

  const cleanup = () => {
    tag.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // Safety net: also remove after a delay in case `afterprint` doesn't
  // fire on some browsers (older Safari).
  setTimeout(cleanup, 4000);

  window.print();
}

function methodArabic(method: string) {
  return (
    {
      cash: "نقداً",
      card: "شبكة",
      apple: "Apple Pay",
      wallet: "محفظة",
    } as Record<string, string>
  )[method] || method;
}

/* ---------- Cart Panel ---------- */

function CartPanel(props: {
  cart: CartLine[];
  updateQty: (id: number, delta: number) => void;
  removeLine: (id: number) => void;
  canCreatePosReturn: boolean;
  openReturns: () => void;
  subtotal: number;
  discountPct: number;
  setDiscountPct: (n: number) => void;
  discountAmount: number;
  vatAmount: number;
  grandTotal: number;
  itemCount: number;
  parkCurrentCart: () => void;
  paid: boolean;
  pay: (method: "cash" | "card" | "apple" | "wallet") => void | Promise<void>;
  methods: { cash: boolean; card: boolean; apple: boolean; wallet: boolean };
  submitting: boolean;
  submitError: string | null;
}) {
  const {
    cart,
    updateQty,
    removeLine,
    canCreatePosReturn,
    openReturns,
    subtotal,
    discountPct,
    setDiscountPct,
    discountAmount,
    vatAmount,
    grandTotal,
    itemCount,
    parkCurrentCart,
    paid,
    pay,
    methods,
    submitting,
    submitError,
  } = props;

  return (
    <>
      {/* Header */}
      <div className="shrink-0 px-3 py-2 border-b border-border flex items-center justify-between">
        <div>
          <p className="text-sm font-extrabold">فاتورة جديدة</p>
          <p className="text-[11px] text-muted-foreground">
            {itemCount} صنف
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {canCreatePosReturn && (
            <button
              type="button"
              onClick={openReturns}
              className="px-2.5 h-8 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs font-bold inline-flex items-center gap-1 hover-elevate active-elevate-2"
              title="إنشاء مرتجع من فاتورة نقاط البيع"
              data-testid="button-open-pos-return"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              مرتجع
            </button>
          )}
          <button className="px-2.5 h-8 rounded-lg border border-border bg-card text-xs font-bold inline-flex items-center gap-1 hover-elevate active-elevate-2">
            <UserIcon className="w-3 h-3" />
            عميل
          </button>
        </div>
      </div>

      {/* Lines */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        {cart.length === 0 ? (
          <div className="h-full grid place-items-center text-center text-muted-foreground p-6">
            <div>
              <div className="w-16 h-16 mx-auto rounded-2xl bg-muted grid place-items-center text-3xl mb-3">
                🛒
              </div>
              <p className="font-bold text-sm">السلة فارغة</p>
              <p className="text-xs mt-1">اضغط على المنتج لإضافته</p>
            </div>
          </div>
        ) : (
          <ul className="space-y-1.5">
            <AnimatePresence initial={false}>
              {cart.map((l) => (
                <motion.li
                  key={l.item.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 30 }}
                  className="rounded-xl bg-card border border-border p-2 flex items-center gap-2"
                >
                  <div className="w-9 h-9 rounded-lg bg-muted grid place-items-center text-lg shrink-0">
                    {emojiFor(l.item)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold leading-tight line-clamp-1">
                      {l.item.nameAr}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {formatSAR(Number(l.item.salePrice))} ر.س /{" "}
                      {l.item.unit?.nameAr || "وحدة"}
                    </p>
                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
                        <button
                          onClick={() => updateQty(l.item.id, -1)}
                          className="w-7 h-7 rounded-md grid place-items-center hover-elevate active-elevate-2"
                          aria-label="إنقاص"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="min-w-7 text-center font-black text-sm">
                          {l.qty}
                        </span>
                        <button
                          onClick={() => updateQty(l.item.id, 1)}
                          className="w-7 h-7 rounded-md grid place-items-center hover-elevate active-elevate-2"
                          aria-label="زيادة"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <p className="text-sm font-black text-primary">
                        {formatSAR(Number(l.item.salePrice) * l.qty)}
                        <span className="text-[10px] text-muted-foreground font-bold mr-0.5">
                          ر.س
                        </span>
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => removeLine(l.item.id)}
                    className="w-7 h-7 rounded-md grid place-items-center text-muted-foreground hover:text-destructive hover-elevate active-elevate-2"
                    aria-label="حذف"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>

      {/* Totals + Pay */}
      <div className="shrink-0 border-t border-border bg-gradient-to-b from-card to-muted/30 p-3 space-y-2">
        {submitError && (
          <div className="max-h-12 overflow-y-auto text-xs font-semibold text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2">
            {submitError}
          </div>
        )}

        {/* Discount */}
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-1 bg-card border border-border rounded-xl px-2.5 py-1.5">
            <Percent className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground">خصم</span>
            <input
              type="number"
              min={0}
              max={100}
              value={discountPct || ""}
              onChange={(e) =>
                setDiscountPct(Math.max(0, Math.min(100, +e.target.value || 0)))
              }
              placeholder="0"
              className="flex-1 bg-transparent outline-none text-sm font-bold text-end"
            />
            <span className="text-xs text-muted-foreground">%</span>
          </div>
          <button
            onClick={parkCurrentCart}
            disabled={cart.length === 0 || submitting || paid}
            className="px-3 h-9 rounded-xl border border-amber-300 bg-amber-50 text-amber-800 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-40 hover-elevate active-elevate-2"
            title="حفظ الفاتورة مؤقتاً واستكمالها لاحقاً"
            data-testid="button-park-cart"
          >
            <Pause className="w-3.5 h-3.5" />
            تعليق
          </button>
        </div>

        {/* Totals */}
        <div className="space-y-1 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">المجموع الفرعي</span>
            <span className="font-bold">{formatSAR(subtotal)} ر.س</span>
          </div>
          {discountPct > 0 && (
            <div className="flex items-center justify-between text-destructive">
              <span>الخصم ({discountPct}%)</span>
              <span className="font-bold">- {formatSAR(discountAmount)} ر.س</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">ضريبة القيمة المضافة 15%</span>
            <span className="font-bold">{formatSAR(vatAmount)} ر.س</span>
          </div>
          <div className="h-px bg-border my-2" />
          <div className="flex items-center justify-between">
            <span className="font-extrabold">الإجمالي</span>
            <span className="text-xl font-black text-primary tabular-nums">
              {formatSAR(grandTotal)}
              <span className="text-sm text-muted-foreground font-bold mr-1">ر.س</span>
            </span>
          </div>
        </div>

        {/* All payment methods stay visible; only configured methods are actionable. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-0.5">
          <PayButton
            testId="button-pay-cash"
            disabled={cart.length === 0 || submitting || !methods.cash}
            disabledReason={!methods.cash ? "اربط صندوقاً نقدياً من إعدادات نقاط البيع." : undefined}
            onClick={() => pay("cash")}
            icon={<Banknote className="w-4 h-4" />}
            label="نقداً"
          />
          <PayButton
            testId="button-pay-card"
            disabled={cart.length === 0 || submitting || !methods.card}
            disabledReason={!methods.card ? "اربط حساب الشبكة من إعدادات نقاط البيع." : undefined}
            onClick={() => pay("card")}
            icon={<CreditCard className="w-4 h-4" />}
            label="شبكة"
          />
          <PayButton
            testId="button-pay-apple"
            disabled={cart.length === 0 || submitting || !methods.apple}
            disabledReason={!methods.apple ? "اربط حساب Apple Pay من إعدادات نقاط البيع." : undefined}
            onClick={() => pay("apple")}
            icon={<Smartphone className="w-4 h-4" />}
            label="Apple Pay"
          />
          <PayButton
            testId="button-pay-wallet"
            disabled={cart.length === 0 || submitting || !methods.wallet}
            disabledReason={!methods.wallet ? "اربط حساب المحفظة من إعدادات نقاط البيع." : undefined}
            onClick={() => pay("wallet")}
            icon={<Wallet className="w-4 h-4" />}
            label="محفظة"
          />
        </div>
        {Object.values(methods).some((configured) => !configured) && (
          <p className="text-[10px] leading-tight text-muted-foreground text-center">
            الوسائل المعطلة تحتاج ربط حسابها من إعدادات نقاط البيع.
          </p>
        )}

        <Button
          disabled={cart.length === 0 || submitting || !methods.cash}
          onClick={() => pay("cash")}
          data-testid="button-complete-cash"
          title={!methods.cash ? "اربط صندوقاً نقدياً من إعدادات نقاط البيع." : undefined}
          className="w-full h-11 py-2 text-sm font-extrabold rounded-xl bg-gradient-to-l from-primary via-primary to-chart-2 text-primary-foreground pos-glow disabled:opacity-50 disabled:pos-glow-none"
        >
          <span className="inline-flex items-center gap-2">
            {submitting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                جاري حفظ الفاتورة...
              </>
            ) : (
              <>
                <Receipt className="w-5 h-5" />
                إتمام الدفع نقداً
                <ChevronLeft className="w-4 h-4" />
              </>
            )}
          </span>
        </Button>
      </div>
    </>
  );
}

function PayButton({
  icon,
  label,
  onClick,
  disabled,
  disabledReason,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      aria-label={disabledReason ? `${label}، ${disabledReason}` : label}
      title={disabledReason || (disabled ? "أضف صنفاً إلى السلة لتفعيل الدفع." : undefined)}
      className="h-10 min-w-0 rounded-xl border border-border bg-card px-1 font-bold text-xs inline-flex items-center justify-center gap-1 disabled:opacity-40 hover-elevate active-elevate-2"
    >
      <span className="flex flex-col items-center leading-none">
        <span className="inline-flex items-center gap-1">
          {icon}
          {label}
        </span>
        {disabledReason && (
          <span className="pt-0.5 text-[9px] font-semibold opacity-80">غير مهيأ</span>
        )}
      </span>
    </button>
  );
}

/* ---------- Receipt Modal ---------- */

function ReceiptModal(props: {
  method: string;
  invoice: SalesInvoice | null;
  cart: CartLine[];
  subtotal: number;
  discountAmount: number;
  vatAmount: number;
  grandTotal: number;
  warning: string | null;
  onClose: () => void;
  // The configured company logo (base64 data URL) and Arabic name —
  // forwarded from the parent so we can render a print-only header at
  // the top of the receipt with the brand mark.  Both fall back to
  // empty when the company has no logo / name configured.
  companyLogo: string | null;
  companyNameAr: string;
  // The cashier who issued the sale. Shown on the printed slip; Arabic name
  // preferred (this screen is Arabic-only), falling back to the username.
  cashierName: string;
}) {
  const {
    method,
    invoice,
    cart,
    subtotal,
    discountAmount,
    vatAmount,
    grandTotal,
    warning,
    onClose,
    companyLogo,
    companyNameAr,
    cashierName,
  } = props;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm grid place-items-center p-4"
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ type: "spring", damping: 22, stiffness: 250 }}
        className="bg-card rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden border border-card-border"
        // `data-thermal-root` is targeted by the thermal-print stylesheet
        // (injected on demand) so only the receipt content reaches the
        // 80mm/58mm thermal printer — everything else on the page is hidden.
        data-thermal-root
      >
        {/*
          Print-only company header — hidden on screen (the modal already
          shows a colourful confirmation banner) but appended to the
          printed receipt so the cashier slip carries the configured
          brand mark and shop name.  Falls back gracefully when neither
          a logo nor an Arabic name is configured.
        */}
        {(companyLogo || companyNameAr) && (
          <div className="hidden print:block text-center pt-3 pb-2 border-b">
            {companyLogo && (
              <img
                src={companyLogo}
                alt=""
                className="mx-auto"
                style={{ maxHeight: 50, maxWidth: 150, objectFit: "contain" }}
              />
            )}
            {companyNameAr && (
              <div className="text-sm font-bold mt-1">{companyNameAr}</div>
            )}
          </div>
        )}
        <div className="bg-gradient-to-br from-primary to-chart-2 text-primary-foreground p-6 text-center relative overflow-hidden">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.15, type: "spring", damping: 15 }}
            className="w-16 h-16 mx-auto rounded-full bg-white/20 grid place-items-center mb-3 ring-4 ring-white/20"
          >
            <Check className="w-9 h-9" strokeWidth={3} />
          </motion.div>
          <p className="text-lg font-extrabold">تم الدفع بنجاح</p>
          <p className="text-sm opacity-90 mt-0.5">{methodArabic(method)}</p>
          <Sparkles className="absolute top-4 right-4 w-5 h-5 opacity-40" />
          <Sparkles className="absolute bottom-4 left-4 w-4 h-4 opacity-30" />
        </div>

        <div className="p-6 space-y-3">
          {warning && (
            <div className="text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 dark:text-amber-200 dark:bg-amber-900/30 dark:border-amber-800/50">
              ⚠ {warning}
            </div>
          )}
          <div className="text-center">
            <p className="text-3xl font-black text-primary">
              {formatSAR(grandTotal)}
              <span className="text-base text-muted-foreground font-bold mr-1">ر.س</span>
            </p>
            <p className="text-[11px] text-muted-foreground mt-1 font-mono">
              فاتورة #{invoice?.docNumber || invoice?.id || "—"}
            </p>
            {cashierName && (
              <p className="text-[11px] text-muted-foreground mt-0.5">
                الكاشير: <span className="font-bold">{cashierName}</span>
              </p>
            )}
          </div>

          <div className="bg-muted/40 rounded-xl p-3 space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">عدد الأصناف</span>
              <span className="font-bold">
                {cart.reduce((n, l) => n + l.qty, 0)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">قبل الضريبة</span>
              <span className="font-bold">
                {formatSAR(subtotal - discountAmount)} ر.س
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">ض.ق.م 15%</span>
              <span className="font-bold">{formatSAR(vatAmount)} ر.س</span>
            </div>
          </div>

          {/* QR placeholder */}
          <div className="grid place-items-center py-2">
            <div className="w-32 h-32 bg-white border-4 border-foreground/10 rounded-xl grid place-items-center p-2">
              <div
                className="w-full h-full"
                style={{
                  backgroundImage:
                    "linear-gradient(45deg, #000 25%, transparent 25%), linear-gradient(-45deg, #000 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #000 75%), linear-gradient(-45deg, transparent 75%, #000 75%)",
                  backgroundSize: "8px 8px",
                  backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0px",
                }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground mt-2 font-mono">
              QR متوافق مع زاتكا
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-2 print:hidden">
            <button
              onClick={onClose}
              className="h-11 rounded-xl border border-border bg-card font-bold text-xs hover-elevate active-elevate-2"
            >
              فاتورة جديدة
            </button>
            <button
              onClick={() => window.print()}
              className="h-11 rounded-xl bg-primary text-primary-foreground font-bold text-xs inline-flex items-center justify-center gap-1 hover-elevate active-elevate-2"
              title="طباعة A4 على الطابعة الافتراضية"
            >
              <Receipt className="w-4 h-4" />
              طباعة
            </button>
            <button
              onClick={() => printThermal(80)}
              className="h-11 rounded-xl bg-emerald-600 text-white font-bold text-xs inline-flex items-center justify-center gap-1 hover-elevate active-elevate-2"
              title="طباعة على طابعة الإيصالات الحرارية 80مم (سوبر ماركت / مطاعم)"
              data-testid="btn-thermal-print"
            >
              <Receipt className="w-4 h-4" />
              حرارية 80
            </button>
          </div>
          <div className="text-[10px] text-muted-foreground text-center print:hidden">
            <button
              onClick={() => printThermal(58)}
              className="underline hover:text-foreground"
              data-testid="btn-thermal-print-58"
            >
              طباعة بطول 58مم بدلاً من 80مم
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
