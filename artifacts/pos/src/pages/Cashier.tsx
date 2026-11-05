import { useState, useMemo, useEffect, useCallback, useRef } from "react";
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
  Package2,
  AlertCircle,
  Clock3,
  Truck,
  Utensils,
} from "lucide-react";
import RestaurantOrdersDialog from "@/components/RestaurantOrdersDialog";
import CashMovementDialog from "@/components/CashMovementDialog";
import CashBoxesDialog from "@/components/CashBoxesDialog";
import EmployeeMealsDialog from "@/components/EmployeeMealsDialog";
import PosAiPanel from "@/components/PosAiPanel";
import ReturnsPage from "@/pages/Returns";
import { enqueueInvoice, syncNow, countQueued } from "@/lib/offlineQueue";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  api,
  getStoredUser,
  getToken,
  getPosDeviceId,
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
  type PosSession,
  getItemSalePrice,
  getSalePriceOptions,
  getSalePriceOptionName,
} from "@/lib/api";
import { printPosThermalReceipt } from "@/lib/posThermalReceipt";
import {
  openPosShiftPrintWindow,
  printPosShiftReport,
  type PosShiftCashReport,
  type PosShiftDetail,
} from "@/lib/posShiftPrint";

type CartLine = {
  item: Item;
  qty: number;
  selectedSaleOptionId?: string;
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
    (sum, line) => sum + getItemSalePrice(line.item, line.selectedSaleOptionId) * line.qty,
    0,
  );
  const discount = subtotal * discountPct / 100;
  const vat = cart.cart.reduce((sum, line) => {
    const gross = getItemSalePrice(line.item, line.selectedSaleOptionId) * line.qty;
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

export default function CashierPage() {
  const [, navigate] = useLocation();
  const searchInputRef = useRef<HTMLInputElement>(null);
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
  const [queuedInvoices, setQueuedInvoices] = useState(0);
  const [time, setTime] = useState(new Date());
  const [posSession, setPosSession] = useState<PosSession | null>(null);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [restaurantOpen, setRestaurantOpen] = useState(false);
  const [heldCarts, setHeldCarts] = useState<ParkedCart[]>([]);
  const [heldCartsOpen, setHeldCartsOpen] = useState(false);
  const [returnsOpen, setReturnsOpen] = useState(false);
  const [cashMovementOpen, setCashMovementOpen] = useState(false);
  const [cashBoxesOpen, setCashBoxesOpen] = useState(false);
  const [employeeMealsOpen, setEmployeeMealsOpen] = useState(false);
  const canManageCashExpenses = user?.mobilePermissions?.cash_expenses_create === true &&
    user?.mobilePermissions?.cash_expenses_post === true;
  const canManageOtherCashMovements = hasPosFeatureAccess(user, "pos_cashier", "edit");
  // Hide services until the selected station's configuration has loaded.
  // This never replaces company-module or signed-in-user permission checks.
  const [enabledServices, setEnabledServices] = useState<string[]>([]);
  const canShowService = useCallback((key: string) => {
    const access = SERVICE_ACCESS[key];
    return !!access &&
      hasPosFeatureAccess(user, access.feature, access.action) &&
      enabledServices.includes(key);
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
    const refreshCurrentSession = () => {
      if (!getToken()) return;
      void api.getCurrentPosSession().then((session) => {
        setPosSession(session);
        setPosSessionId(session?.id ?? null);
      }).catch(() => {});
    };
    refreshCurrentSession();
    const refreshSessionTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshCurrentSession();
    }, 15_000);
    window.addEventListener("focus", refreshCurrentSession);
    const onO = () => {
      setOnline(true);
      // Auto-sync any queued offline invoices.
      void syncNow(getToken()).then(() => countQueued()).then(setQueuedInvoices).catch(() => {});
    };
    const onF = () => setOnline(false);
    // On mount, attempt sync if any queued ops exist.
    void countQueued().then((n) => {
      setQueuedInvoices(n);
      if (n > 0 && navigator.onLine) {
        void syncNow(getToken()).then(() => countQueued()).then(setQueuedInvoices).catch(() => {});
      }
    });
    window.addEventListener("online", onO);
    window.addEventListener("offline", onF);
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => {
      window.clearInterval(refreshSessionTimer);
      window.removeEventListener("focus", refreshCurrentSession);
      window.removeEventListener("online", onO);
      window.removeEventListener("offline", onF);
      clearInterval(t);
    };
  }, []);

  // Load reference + catalog data
  useEffect(() => {
    let alive = true;
    const refreshServiceAvailability = () => {
      const selectedTerminalId = Number(localStorage.getItem("pos_terminal_id") || 0) || null;
      api.getEffectiveServices(selectedTerminalId)
        .then((r) => {
          if (alive) setEnabledServices(Array.isArray(r?.services) ? r.services : []);
        })
        .catch(() => {
          if (alive) setEnabledServices([]);
        });
    };
    refreshServiceAvailability();
    const serviceRefreshTimer = window.setInterval(refreshServiceAvailability, 15_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshServiceAvailability();
    };
    window.addEventListener("focus", refreshServiceAvailability);
    document.addEventListener("visibilitychange", refreshWhenVisible);
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
      } catch (err: any) {
        if (alive) setLoadError(err?.message || "تعذّر تحميل البيانات");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      window.clearInterval(serviceRefreshTimer);
      window.removeEventListener("focus", refreshServiceAvailability);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
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
      mixed:  (posSettings?.posCashCashBoxId ?? defaultCashBoxId) != null &&
        !!(posSettings?.posCardBankAccountId || posSettings?.posAppleBankAccountId || posSettings?.posWalletBankAccountId),
    }),
    [posSettings, defaultCashBoxId],
  );

  const branchName = useMemo(() => {
    return branches.find((b) => b.id === branchId)?.nameAr || "—";
  }, [branches, branchId]);

  const openShift = async (openingCash: number) => {
    const terminalId = Number(localStorage.getItem("pos_terminal_id") || 0) || null;
    const session = await api.openPosSession({
      branchId,
      cashBoxId: defaultCashBoxId,
      openingCash,
      device: navigator.userAgent.slice(0, 120),
      posTerminalId: terminalId,
      machineCode: terminalId ? getPosDeviceId() : null,
    });
    setPosSession(session);
    setPosSessionId(session.id);
  };

  const ensureShiftWorkComplete = async (): Promise<boolean> => {
    const blockers: string[] = [];

    if (cart.length > 0 && !paid) {
      blockers.push(`السلة الحالية تحتوي على ${itemCount} صنف؛ أكمل البيع أو أفرغ السلة.`);
    }
    if (heldCarts.length > 0) {
      blockers.push(`${heldCarts.length} فاتورة معلّقة على هذا الجهاز؛ استعدها أو احذفها يدويًا.`);
    }

    let queuedCount = await countQueued();
    let syncError = "";
    if (queuedCount > 0 && navigator.onLine) {
      try {
        await syncNow(getToken());
      } catch (error: any) {
        syncError = error?.message || "";
      }
      queuedCount = await countQueued();
      setQueuedInvoices(queuedCount);
    }
    if (queuedCount > 0) {
      blockers.push(
        `${queuedCount} فاتورة غير متزامنة؛ اتصل بالإنترنت وأكمل المزامنة${syncError ? ` (${syncError})` : ""}.`,
      );
    }

    if (canShowService("waiter")) {
      try {
        const { count } = await api.rActiveOrderCount(posSession?.branchId ?? branchId);
        if (count > 0) {
          blockers.push(`${count} طلب مطعم مفتوح؛ فوّتره أو ألغِه من طلبات الصالة أو تطبيق النادل.`);
        }
      } catch {
        blockers.push("تعذّر التحقق من طلبات المطعم؛ أُوقف الإجراء حتى لا تُترك طلبات دون معالجة.");
      }
    }

    if (blockers.length > 0) {
      window.alert(`لا يمكن إغلاق الوردية أو فتح وردية جديدة قبل معالجة التالي:\n\n• ${blockers.join("\n• ")}`);
      return false;
    }
    return true;
  };

  const closeAndPrintShift = async (sessionId: number, printWindow: Window) => {
    try {
      const [detail, cashReport] = await Promise.all([
        api.request<PosShiftDetail>("GET", `/api/pos-sessions/${sessionId}`),
        api.request<PosShiftCashReport>("GET", `/api/pos-sessions/${sessionId}/cash-movements`),
      ]);
      const closedSession = await api.closePosSession(sessionId, {});
      printPosShiftReport(printWindow, {
        ...detail,
        closedAt: closedSession.closedAt,
      }, cashReport);
    } catch (error) {
      printWindow.close();
      throw error;
    }
  };

  const handleShiftAction = async () => {
    try {
      if (!posSession) {
        if (!(await ensureShiftWorkComplete())) return;
        const rawOpening = window.prompt("أدخل مبلغ النقد الافتتاحي في الدرج", "0");
        if (rawOpening === null) return;
        const opening = Number(rawOpening);
        if (!Number.isFinite(opening) || opening < 0) {
          window.alert("أدخل مبلغاً صحيحاً لا يقل عن صفر.");
          return;
        }
        await openShift(opening);
        return;
      }

      const printWindow = openPosShiftPrintWindow();
      if (!printWindow) {
        window.alert("اسمح بفتح النوافذ المنبثقة لإغلاق الوردية وطباعة تقرير حركتها.");
        return;
      }
      if (!(await ensureShiftWorkComplete())) {
        printWindow.close();
        return;
      }
      await closeAndPrintShift(posSession.id, printWindow);
      setPosSession(null);
      setPosSessionId(null);
      if (window.confirm("تم إغلاق الوردية. هل تريد فتح وردية جديدة الآن؟")) {
        const rawOpening = window.prompt("أدخل مبلغ النقد الافتتاحي للوردية الجديدة", "0");
        if (rawOpening === null) return;
        const opening = Number(rawOpening);
        if (!Number.isFinite(opening) || opening < 0) {
          window.alert("أدخل مبلغاً صحيحاً لا يقل عن صفر.");
          return;
        }
        if (!(await ensureShiftWorkComplete())) return;
        await openShift(opening);
      }
    } catch (error: any) {
      window.alert(error?.message || "تعذّر تنفيذ إجراء الوردية.");
    }
  };

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

  const selectSalePriceOption = (itemId: number, optionId: string) => {
    setCart((c) => c.map((line) =>
      line.item.id === itemId
        ? { ...line, selectedSaleOptionId: optionId || undefined }
        : line,
    ));
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
    (s, l) => s + getItemSalePrice(l.item, l.selectedSaleOptionId) * l.qty,
    0,
  );
  const discountAmount = (subtotal * discountPct) / 100;
  const afterDiscount = subtotal - discountAmount;
  const vatAmount = cart.reduce((s, l) => {
    const lineGross = getItemSalePrice(l.item, l.selectedSaleOptionId) * l.qty;
    const lineDisc = (lineGross * discountPct) / 100;
    const rate = Number(l.item.vatRate) || VAT_RATE;
    return s + ((lineGross - lineDisc) * rate) / 100;
  }, 0);
  const grandTotal = afterDiscount + vatAmount;
  const itemCount = cart.reduce((n, l) => n + l.qty, 0);

  const handleLogout = async () => {
    const sessionId = getPosSessionId();
    if (sessionId) {
      const printWindow = openPosShiftPrintWindow();
      if (!printWindow) {
        window.alert("اسمح بفتح النوافذ المنبثقة لإغلاق الوردية وطباعة تقرير حركتها.");
        return;
      }
      if (!(await ensureShiftWorkComplete())) {
        printWindow.close();
        return;
      }
      try {
        await closeAndPrintShift(sessionId, printWindow);
      } catch (error: any) {
        window.alert(error?.message || "تعذّر إغلاق الوردية؛ لم يتم تسجيل الخروج.");
        return;
      }
      setPosSession(null);
      setPosSessionId(null);
    }
    api.logout().catch(() => {});
    clearAuth();
    navigate("/login");
  };

  const pay = useCallback(
    async (method: "cash" | "card" | "apple" | "wallet" | "mixed") => {
      if (cart.length === 0 || submitting) return;
      setSubmitError(null);
      setSubmitting(true);

      const today = new Date().toISOString().slice(0, 10);
      const lines: CreateInvoiceLine[] = cart.map((l) => {
        const unitPrice = getItemSalePrice(l.item, l.selectedSaleOptionId);
        const lineGross = unitPrice * l.qty;
        const lineDisc = (lineGross * discountPct) / 100;
        const option = getSalePriceOptions(l.item).find((candidate) => candidate.id === l.selectedSaleOptionId);
        const optionName = getSalePriceOptionName(option);
        return {
          itemId: l.item.id,
          itemName: optionName ? `${l.item.nameAr} — ${optionName}` : l.item.nameAr,
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
      let paymentType: "cash" | "bank" | "mixed" = "cash";
      let cashBoxIdForPayment: number | null = null;
      let bankAccountIdForPayment: number | null = null;
      let cashAmountForPayment: number | null = null;
      let bankAmountForPayment: number | null = null;
      if (method === "mixed") {
        cashBoxIdForPayment = posSettings?.posCashCashBoxId ?? defaultCashBoxId;
        const bankMethod = posSettings?.posCardBankAccountId ? "card"
          : posSettings?.posAppleBankAccountId ? "apple"
          : posSettings?.posWalletBankAccountId ? "wallet" : null;
        bankAccountIdForPayment = bankMethod === "card" ? posSettings?.posCardBankAccountId ?? null
          : bankMethod === "apple" ? posSettings?.posAppleBankAccountId ?? null
          : bankMethod === "wallet" ? posSettings?.posWalletBankAccountId ?? null : null;
        if (!cashBoxIdForPayment || !bankAccountIdForPayment) {
          setSubmitError("اربط صندوق النقد وحساباً بنكياً واحداً على الأقل من إعدادات نقاط البيع.");
          setSubmitting(false);
          return;
        }
        const rawCashAmount = window.prompt(`أدخل المبلغ النقدي من إجمالي ${formatSAR(grandTotal)} ر.س. سيُحصّل الباقي عبر ${methodArabic(bankMethod || "card")}.`, (grandTotal / 2).toFixed(2));
        if (rawCashAmount === null) {
          setSubmitting(false);
          return;
        }
        cashAmountForPayment = Math.round(Number(rawCashAmount) * 100) / 100;
        bankAmountForPayment = Math.round((grandTotal - cashAmountForPayment) * 100) / 100;
        if (!Number.isFinite(cashAmountForPayment) || cashAmountForPayment <= 0 || bankAmountForPayment <= 0) {
          setSubmitError("يجب أن يكون مبلغ النقد ومبلغ البنك أكبر من صفر.");
          setSubmitting(false);
          return;
        }
        paymentType = "mixed";
      } else if (method === "cash") {
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
        // Sales require an explicitly opened shift so the cashier's opening
        // cash is captured before the first transaction.
        let posSessionId = getPosSessionId();
        if (!posSessionId) {
          const existing = await api.getCurrentPosSession().catch(() => null);
          if (!existing) {
            setSubmitError("افتح وردية البيع أولاً قبل إتمام الفاتورة.");
            return;
          }
          posSessionId = existing.id;
          setPosSession(existing);
          setPosSessionId(posSessionId);
        }
        const invoiceBody = {
          invoiceDate: today,
          branchId,
          paymentType,
          cashBoxId: cashBoxIdForPayment,
          bankAccountId: bankAccountIdForPayment,
          cashAmount: cashAmountForPayment,
          bankAmount: bankAmountForPayment,
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
            if (posted.status === "posted") {
              setPosSession((current) => current
                ? { ...current, invoiceCount: (current.invoiceCount ?? 0) + 1 }
                : current);
            }
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
            void countQueued().then(setQueuedInvoices).catch(() => {});
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
      posSettings,
    ],
  );

  const timeStr = new Intl.DateTimeFormat("ar-SA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(time);
  const openedAtMs = posSession ? Date.parse(posSession.openedAt) : NaN;
  const elapsedShiftSeconds = Number.isFinite(openedAtMs)
    ? Math.max(0, Math.floor((time.getTime() - openedAtMs) / 1000))
    : 0;
  const elapsedShiftHours = Math.floor(elapsedShiftSeconds / 3600);
  const elapsedShiftMinutes = Math.floor((elapsedShiftSeconds % 3600) / 60);
  const elapsedShiftRemainder = elapsedShiftSeconds % 60;
  const shiftDuration = posSession
    ? `${String(elapsedShiftHours).padStart(2, "0")}:${String(elapsedShiftMinutes).padStart(2, "0")}:${String(elapsedShiftRemainder).padStart(2, "0")}`
    : "--:--:--";

  return (
    <div
      dir="rtl"
      className="h-[100dvh] w-full bg-background text-foreground flex flex-col overflow-hidden"
    >
      {/* TOP BAR */}
      <header className="relative z-30 flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card px-3 py-2 shadow-[0_4px_18px_-16px_hsl(var(--foreground)/.4)] sm:px-5 lg:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-md shadow-primary/20 ring-1 ring-primary/15">
            <Store className="w-5 h-5" strokeWidth={2.4} />
          </div>
          <div className="hidden min-w-0 sm:block">
            <p className="truncate text-sm font-black leading-tight tracking-tight">
              زاكود <span className="text-primary">نقاط البيع</span>
            </p>
            <p className="mt-0.5 max-w-48 truncate text-[10px] leading-tight text-muted-foreground">
              {branchName} <span aria-hidden="true">·</span> {user?.company?.nameAr || ""}
            </p>
          </div>
        </div>

        <div className="min-w-0 flex-1 sm:max-w-md lg:max-w-lg">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث باسم المنتج أو الباركود..."
              aria-label="البحث عن منتج بالاسم أو الرمز أو الباركود"
              data-testid="input-pos-product-search"
              className="h-11 rounded-xl border-border/80 bg-background pr-10 pl-12 text-sm font-medium shadow-inner shadow-foreground/[0.02] focus-visible:ring-primary/25"
            />
            <button
              type="button"
              title="مسح الباركود"
              aria-label="تفعيل حقل البحث لمسح الباركود"
              data-testid="button-focus-barcode-search"
              onClick={() => {
                searchInputRef.current?.focus();
                searchInputRef.current?.select();
              }}
              className="absolute left-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <ScanBarcode className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            role="status"
            data-testid="status-pos-connection"
            title={online ? "نقطة البيع متصلة بالإنترنت" : "نقطة البيع تعمل دون اتصال"}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1.5 text-[10px] font-bold sm:px-2.5 sm:text-[11px] ${
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
            <span className="hidden sm:inline">{online ? "متصل" : "دون اتصال"}</span>
            {queuedInvoices > 0 && (
              <span className="inline-flex items-center gap-1 border-r border-current/20 pr-1.5 sm:pr-2" data-testid="status-pos-queued-invoices">
                <Receipt className="size-3" />
                {queuedInvoices}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleShiftAction()}
            aria-label={posSession ? "إغلاق الوردية الحالية" : "فتح وردية جديدة"}
            data-testid="button-pos-shift"
            className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-bold transition-colors hover-elevate ${
              posSession
                ? "border-primary/20 bg-primary/5 text-primary"
                : "border-amber-300 bg-amber-50 text-amber-800"
            }`}
          >
            <Clock3 className="size-4" />
            <span className="hidden sm:inline">{posSession ? "إغلاق الوردية" : "فتح وردية"}</span>
          </button>
          {hasPosFeatureAccess(user, "pos_cashier", "view") && (
            <button
              type="button"
              onClick={() => setCashBoxesOpen(true)}
              aria-label="عرض الخزائن المتاحة"
              data-testid="button-pos-cash-boxes"
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-primary/20 bg-primary/5 px-2.5 text-xs font-bold text-primary transition-colors hover-elevate"
            >
              <Wallet className="size-4" />
              <span className="hidden sm:inline">الخزائن</span>
            </button>
          )}
          {hasPosFeatureAccess(user, "pos_cashier", "view") && (
            <button
              type="button"
              onClick={() => setCashMovementOpen(true)}
              aria-label="فتح المصروفات والحركات النقدية"
              data-testid="button-pos-cash-movements"
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-card px-2.5 text-xs font-bold text-foreground transition-colors hover-elevate"
            >
              <Banknote className="size-4" />
              <span className="hidden sm:inline">المصروفات والحركات</span>
            </button>
          )}
          {hasPosFeatureAccess(user, "pos_cashier", "view") && (
            <button
              type="button"
              onClick={() => setEmployeeMealsOpen(true)}
              aria-label="فتح وجبات الموظفين"
              data-testid="button-pos-employee-meals"
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-card px-2.5 text-xs font-bold text-foreground transition-colors hover-elevate"
            >
              <ChefHat className="size-4" />
              <span className="hidden sm:inline">وجبات الموظفين</span>
            </button>
          )}
          <div
            role="group"
            aria-label={posSession ? `مدة الوردية ${shiftDuration}، ${posSession.invoiceCount ?? 0} فاتورة` : `الوقت الحالي ${timeStr}، لا توجد وردية مفتوحة`}
            data-testid="pos-shift-summary"
            className="hidden md:flex shrink-0 items-center gap-2 rounded-xl border border-primary/20 bg-gradient-to-l from-primary/10 via-white to-white px-2.5 py-1.5 shadow-sm"
          >
            <div className="min-w-[94px] text-center leading-none">
              <span className="mb-1 block text-[9px] font-bold text-muted-foreground">
                {posSession ? "مدة الوردية" : "لا توجد وردية"}
              </span>
              <span
                dir="ltr"
                role="timer"
                aria-label={posSession ? `مدة الوردية ${shiftDuration}` : `الوقت الحالي ${timeStr}`}
                data-testid="pos-shift-elapsed"
                className="font-mono text-[15px] font-black tracking-[0.08em] text-black tabular-nums"
              >
                {posSession ? shiftDuration : timeStr}
              </span>
            </div>
            <span aria-hidden="true" className="h-8 w-px bg-primary/20" />
            <div className="flex min-w-[52px] items-center justify-center gap-1 text-primary">
              <Receipt className="size-4" />
              <span className="font-mono text-lg font-black leading-none text-black tabular-nums" data-testid="pos-shift-invoice-count">
                {posSession?.invoiceCount ?? 0}
              </span>
              <span className="text-[9px] font-bold text-muted-foreground">فاتورة</span>
            </div>
          </div>
          <button
            title={user?.username || "حساب"}
            aria-label={`حساب المستخدم ${user?.username || ""}`}
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
                onClick={() => navigate("/waiter?view=tables")}
                title="فتح طلبات الصالة والطاولات"
                className="h-10 px-3 rounded-xl border border-primary/25 bg-primary/[0.07] text-primary text-xs font-semibold grid place-items-center gap-1 hover-elevate active-elevate-2 hidden xl:flex"
                data-testid="svc-waiter-tables"
              >
                <Utensils className="w-4 h-4" /> طاولات المطعم
              </button>
              <button
                onClick={() => navigate("/waiter?view=delivery")}
                title="فتح طلبات التوصيل"
                className="h-10 px-3 rounded-xl border border-orange-300 bg-orange-50 text-orange-800 text-xs font-semibold grid place-items-center gap-1 hover-elevate active-elevate-2 hidden xl:flex"
                data-testid="svc-waiter-delivery"
              >
                <Truck className="w-4 h-4" /> طلب توصيل
              </button>
              <button
                onClick={() => setRestaurantOpen(true)}
                title="طلبات الصالة (المطعم)"
                className="h-10 px-3 rounded-xl border border-amber-300 bg-amber-50 text-amber-800 text-xs font-semibold grid place-items-center gap-1 hover-elevate active-elevate-2 hidden xl:flex"
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
              className="h-10 px-3 rounded-xl border border-rose-300 bg-rose-50 text-rose-800 text-xs font-semibold grid place-items-center gap-1 hover-elevate active-elevate-2 hidden xl:flex"
              data-testid="svc-kitchen"
            >
              <CookingPot className="w-4 h-4" /> المطبخ
            </button>
          )}
          {canShowService("analytics") && (
            <button
              onClick={() => navigate("/restaurant-ai")}
              title="تحليلات الذكاء الاصطناعي"
              className="h-10 px-3 rounded-xl border border-violet-300 bg-violet-50 text-violet-800 text-xs font-semibold grid place-items-center gap-1 hover-elevate active-elevate-2 hidden xl:flex"
              data-testid="svc-analytics"
            >
              <Sparkles className="w-4 h-4" /> الذكاء
            </button>
          )}
          {canShowService("settings") && (
            <button
              onClick={() => navigate("/restaurant-settings?returnTo=cashier")}
              title="إعدادات المطعم"
              className="w-10 h-10 rounded-xl border border-border bg-card grid place-items-center hover-elevate active-elevate-2 hidden xl:flex"
              data-testid="svc-settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          {canShowService("supermarket") && (
            <button
              onClick={() => navigate("/super")}
              title="نمط سوبر ماركت"
              className="h-10 px-3 rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs font-semibold grid place-items-center hover-elevate active-elevate-2 hidden xl:flex"
              data-testid="svc-supermarket"
            >
              سوبر ماركت
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
            type="button"
            onClick={() => setMobileCartOpen(true)}
            aria-label={`فتح السلة، ${itemCount} صنف`}
            data-testid="button-open-mobile-cart"
            className="lg:hidden relative grid size-10 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/5 text-primary hover:bg-primary/10"
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

      {(canShowService("waiter") || canShowService("kitchen") || canShowService("supermarket")) && (
        <nav aria-label="اختصارات التشغيل" className="flex shrink-0 gap-2 overflow-x-auto border-b border-border/70 bg-card/70 px-3 py-2 xl:hidden">
          {canShowService("waiter") && (
            <>
              <button type="button" onClick={() => navigate("/waiter?view=tables")} title="فتح الصالة والطاولات" data-testid="svc-waiter-tables-mobile"
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-primary/15 bg-primary/[0.06] px-3 text-xs font-bold text-primary">
                <Utensils className="size-4" /> طاولات المطعم
              </button>
              <button type="button" onClick={() => navigate("/waiter?view=delivery")} title="فتح طلبات التوصيل" data-testid="svc-waiter-delivery-mobile"
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-orange-200 bg-orange-50 px-3 text-xs font-bold text-orange-800">
                <Truck className="size-4" /> طلب توصيل
              </button>
              <button type="button" onClick={() => setRestaurantOpen(true)} title="طلبات الصالة" data-testid="svc-waiter-orders-mobile"
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-border bg-background px-3 text-xs font-bold">
                <ChefHat className="size-4" /> طلبات الصالة
              </button>
            </>
          )}
          {canShowService("kitchen") && (
            <button type="button" onClick={() => navigate("/kitchen")} title="شاشة المطبخ" data-testid="svc-kitchen-mobile"
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 text-xs font-bold text-rose-800">
              <CookingPot className="size-4" /> المطبخ
            </button>
          )}
          {canShowService("supermarket") && (
            <button type="button" onClick={() => navigate("/super")} title="نمط سوبر ماركت" data-testid="svc-supermarket-mobile"
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-xs font-bold text-emerald-800">
              <ShoppingBag className="size-4" /> سوبر ماركت
            </button>
          )}
        </nav>
      )}

      <div className="flex-1 grid lg:grid-cols-[minmax(0,1fr)_26rem] xl:grid-cols-[minmax(0,1fr)_30rem] 2xl:grid-cols-[minmax(0,1fr)_32rem] min-h-0">
        {/* LEFT — products */}
        <section className="flex flex-col min-h-0 min-w-0">
          {/* Categories */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-background/80 px-4 py-3 lg:px-6">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">نقطة البيع</p>
              <h1 className="mt-0.5 truncate text-base font-black tracking-tight sm:text-lg">الأصناف</h1>
            </div>
            <div className="hidden shrink-0 items-center gap-2 text-xs text-muted-foreground sm:flex">
              <span className="rounded-full border border-border bg-card px-3 py-1.5 font-semibold">{filtered.length} منتج</span>
              <span className="text-border">|</span>
              <span className="font-semibold">{branchName}</span>
            </div>
          </div>

          {categories.length > 1 && (
            <div className="shrink-0 overflow-x-auto border-b border-border/70 bg-card/60 px-4 py-3 lg:px-6">
              <div className="flex items-center gap-2 min-w-max">
                {categories.map((c) => {
                  const active = activeCat === c.id;
                  return (
                    <button
                      key={String(c.id)}
                      onClick={() => { setActiveCat(c.id as any); setActiveSubgroup("all"); }}
                      aria-pressed={active}
                      data-testid={`button-pos-display-group-${String(c.id)}`}
                      className={`flex items-center gap-2 rounded-xl border font-bold whitespace-nowrap transition-all ${
                        active
                          ? "h-14 border-primary bg-primary px-5 text-base text-primary-foreground shadow-md ring-2 ring-primary/15"
                          : "h-10 border-border/80 bg-background px-4 text-sm text-foreground hover:border-primary/30 hover:bg-primary/[0.04]"
                      }`}
                    >
                      {c.id !== "all" && (imageSrcFromUrl(c.imageUrl) ? (
                        <img
                          src={imageSrcFromUrl(c.imageUrl) ?? undefined}
                          alt=""
                          className={`${active ? "h-9 w-9 rounded-lg" : "h-6 w-6 rounded-md"} object-cover`}
                          loading="lazy"
                        />
                      ) : (
                        <span className={`grid place-items-center text-[10px] font-black ${
                          active ? "h-9 w-9 rounded-lg" : "h-6 w-6 rounded-md"
                        } ${
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
            <div className="shrink-0 border-b border-border/70 bg-background px-4 py-2 lg:px-6">
              <div className="flex items-center gap-2 overflow-x-auto">
                <span className="shrink-0 text-xs font-bold text-muted-foreground">المجموعات الفرعية</span>
                <button type="button" data-testid="button-pos-subgroup-all" aria-pressed={activeSubgroup === "all"}
                  onClick={() => setActiveSubgroup("all")}
                  className={`flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors ${activeSubgroup === "all" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:border-primary/30"}`}>
                  الكل
                </button>
                {availableSubgroups.map((group) => <button type="button" key={group.id} data-testid={`button-pos-subgroup-${group.id}`}
                  aria-pressed={activeSubgroup === group.id} onClick={() => setActiveSubgroup(group.id)}
                  className={`flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors ${activeSubgroup === group.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:border-primary/30"}`}>
                  {group.imageUrl && <img src={imageSrcFromUrl(group.imageUrl) ?? undefined} alt="" className="h-6 w-6 rounded object-cover" loading="lazy" />}
                  <span>{group.nameAr}</span>
                </button>)}
              </div>
            </div>
          )}

          {/* Products grid */}
          <div className="flex-1 overflow-y-auto p-3 sm:p-4 lg:p-6">
            {loading ? (
              <div role="status" aria-label="جاري تحميل المنتجات" className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {Array.from({ length: 10 }, (_, index) => (
                  <div key={index} className="animate-pulse rounded-2xl border border-border/70 bg-card p-3">
                    <div className="aspect-square rounded-xl bg-muted" />
                    <div className="mt-3 h-4 w-3/4 rounded bg-muted" />
                    <div className="mt-2 h-3 w-1/3 rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : loadError ? (
              <div className="h-full grid place-items-center text-center py-20">
                <div className="max-w-md">
                  <AlertCircle className="mx-auto mb-3 size-10 text-destructive" />
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
                  <Search className="mx-auto mb-3 size-9 text-primary/60" />
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
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {filtered.map((p) => {
                  const inCart = cart.find((l) => l.item.id === p.id);
                  return (
                    <motion.button
                      key={p.id}
                      layout
                      whileTap={{ scale: 0.97 }}
                      onClick={() => addToCart(p)}
                      aria-label={`إضافة ${p.nameAr} إلى السلة، ${formatSAR(Number(p.salePrice))} ريال`}
                      data-testid={`button-add-product-${p.id}`}
                      className={`group relative min-w-0 rounded-2xl border bg-card p-1.5 text-right shadow-[0_5px_18px_-16px_hsl(var(--foreground)/.35)] transition-all sm:p-2 ${
                        inCart
                          ? "border-primary ring-2 ring-primary/15"
                          : "border-card-border hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
                      }`}
                    >
                      {inCart && (
                        <div className="absolute left-2 top-2 z-10 grid h-7 min-w-7 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-black text-primary-foreground shadow-md ring-2 ring-card">
                          {inCart.qty}
                        </div>
                      )}
                      <div className="relative mb-1.5 aspect-[1.7/1] overflow-hidden rounded-lg bg-gradient-to-br from-primary/[0.09] via-muted to-chart-2/[0.08]">
                        {imageSrc(p) ? (
                          <img src={imageSrc(p)!} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-primary/65">
                            <Package2 className="size-7 stroke-[1.5]" aria-hidden="true" />
                          </div>
                        )}
                      </div>
                      <div className="flex min-h-8 items-center justify-between gap-1 border-t border-border/60 pt-1">
                        <span className="min-w-0 flex-1 line-clamp-1 text-xs font-extrabold leading-tight sm:text-sm">
                          {p.nameAr}
                        </span>
                        <span className="shrink-0 whitespace-nowrap text-xs font-black tabular-nums text-primary sm:text-sm">
                          {formatSAR(Number(p.salePrice))}
                          <span className="mr-0.5 text-[9px] font-bold text-muted-foreground">
                            ر.س
                          </span>
                        </span>
                      </div>
                      <span className="mt-0.5 block truncate text-[9px] font-mono leading-none text-muted-foreground">
                        {p.code}
                      </span>
                    </motion.button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* RIGHT — cart panel (desktop) */}
        <aside className="hidden min-h-0 min-w-0 flex-col border-r border-border/80 bg-card lg:flex">
          <CartPanel
            cart={cart}
            updateQty={updateQty}
            removeLine={removeLine}
            selectSalePriceOption={selectSalePriceOption}
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
            openRestaurantTables={() => navigate("/waiter?view=tables")}
            openRestaurantDelivery={() => navigate("/waiter?view=delivery")}
            canShowRestaurantServices={canShowService("waiter")}
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
              <div className="h-14 shrink-0 border-b border-border px-4 flex items-center justify-between">
                <p className="font-extrabold">السلة</p>
                <button
                  type="button"
                  onClick={() => setMobileCartOpen(false)}
                  aria-label="إغلاق السلة"
                  data-testid="button-close-mobile-cart"
                  className="w-9 h-9 rounded-lg grid place-items-center hover-elevate active-elevate-2"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <CartPanel
                cart={cart}
                updateQty={updateQty}
                removeLine={removeLine}
                selectSalePriceOption={selectSalePriceOption}
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
                openRestaurantTables={() => navigate("/waiter?view=tables")}
                openRestaurantDelivery={() => navigate("/waiter?view=delivery")}
                canShowRestaurantServices={canShowService("waiter")}
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
            companyNameEn={(user?.company?.nameEn ?? "") as string}
            companyVatNumber={(user?.company?.vatNumber ?? "") as string}
            companyCrNumber={(user?.company?.crNumber ?? "") as string}
            companyCity={(user?.company?.city ?? "") as string}
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
          onBilled={() => {
            setPosSession((current) => current
              ? { ...current, invoiceCount: (current.invoiceCount ?? 0) + 1 }
              : current);
          }}
        />
      )}

      <CashMovementDialog
        open={cashMovementOpen}
        onClose={() => setCashMovementOpen(false)}
        companyId={Number(user?.companyId ?? 0)}
        session={posSession}
        cashBoxes={cashBoxes}
        branchId={branchId}
        canManageExpenses={canManageCashExpenses}
        canManageOtherMovements={canManageOtherCashMovements}
      />
      <CashBoxesDialog
        open={cashBoxesOpen}
        onClose={() => setCashBoxesOpen(false)}
        companyId={Number(user?.companyId ?? 0)}
        cashBoxes={cashBoxes}
        currentCashBoxId={posSession?.cashBoxId ?? null}
      />
      <EmployeeMealsDialog
        open={employeeMealsOpen}
        onClose={() => setEmployeeMealsOpen(false)}
        companyId={Number(user?.companyId ?? 0)}
        user={user}
      />

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

function methodArabic(method: string) {
  return (
    {
      cash: "نقداً",
      card: "شبكة",
      apple: "Apple Pay",
      wallet: "محفظة",
      mixed: "نقد + بنك",
    } as Record<string, string>
  )[method] || method;
}

/* ---------- Cart Panel ---------- */

function CartPanel(props: {
  cart: CartLine[];
  updateQty: (id: number, delta: number) => void;
  removeLine: (id: number) => void;
  selectSalePriceOption: (itemId: number, optionId: string) => void;
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
  openRestaurantTables: () => void;
  openRestaurantDelivery: () => void;
  canShowRestaurantServices: boolean;
  paid: boolean;
  pay: (method: "cash" | "card" | "apple" | "wallet" | "mixed") => void | Promise<void>;
  methods: { cash: boolean; card: boolean; apple: boolean; wallet: boolean; mixed: boolean };
  submitting: boolean;
  submitError: string | null;
}) {
  const {
    cart,
    updateQty,
    removeLine,
    selectSalePriceOption,
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
    openRestaurantTables,
    openRestaurantDelivery,
    canShowRestaurantServices,
    paid,
    pay,
    methods,
    submitting,
    submitError,
  } = props;

  return (
    <>
      {/* Header */}
      <div className="shrink-0 border-b border-border/80 bg-card px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-black">السلة الحالية</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {itemCount} صنف في الفاتورة
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {canShowRestaurantServices && (
            <>
              <button
                type="button"
                onClick={openRestaurantTables}
                title="إضافة أصناف لطاولات المطعم"
                aria-label="فتح طاولات المطعم"
                data-testid="cart-open-restaurant-tables"
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-primary/25 bg-primary/[0.06] px-2 text-[10px] font-extrabold text-primary hover:bg-primary/10"
              >
                <Utensils className="size-3.5" /> الطاولات
              </button>
              <button
                type="button"
                onClick={openRestaurantDelivery}
                title="إنشاء طلب توصيل"
                aria-label="فتح طلبات التوصيل"
                data-testid="cart-open-restaurant-delivery"
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-orange-300 bg-orange-50 px-2 text-[10px] font-extrabold text-orange-800 hover:bg-orange-100"
              >
                <Truck className="size-3.5" /> توصيل
              </button>
            </>
          )}
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
          <span className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted/70 px-2.5 text-[10px] font-bold text-muted-foreground">
            <Receipt className="size-3.5" /> بيع مباشر
          </span>
        </div>
      </div>

      {/* Lines */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        {cart.length === 0 ? (
          <div className="h-full grid place-items-center text-center text-muted-foreground p-6">
            <div>
              <div className="mb-3 grid size-16 place-items-center rounded-2xl border border-primary/10 bg-primary/[0.06] text-primary">
                <ShoppingBag className="size-7" strokeWidth={1.7} />
              </div>
              <p className="text-sm font-extrabold text-foreground">ابدأ الفاتورة بإضافة صنف</p>
              <p className="mt-1 text-xs">اختر من القائمة أو امسح الباركود</p>
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
                  className="flex items-center gap-2 rounded-xl border border-border/80 bg-card p-2 shadow-[0_3px_12px_-12px_hsl(var(--foreground)/.5)]"
                >
                  <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-primary/[0.06] text-primary">
                    {imageSrc(l.item) ? (
                      <img src={imageSrc(l.item)!} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <Package2 className="size-5" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold leading-tight line-clamp-1">
                      {l.item.nameAr}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {formatSAR(getItemSalePrice(l.item, l.selectedSaleOptionId))} ر.س /{" "}
                      {l.item.unit?.nameAr || "وحدة"}
                    </p>
                    {getSalePriceOptions(l.item).length > 0 && (
                      <select
                        value={l.selectedSaleOptionId ?? ""}
                        onChange={(event) => selectSalePriceOption(l.item.id, event.target.value)}
                        aria-label={`اختيار سعر ${l.item.nameAr}`}
                        data-testid={`select-price-option-${l.item.id}`}
                        className="mt-1 h-8 w-full rounded-md border border-primary/20 bg-background px-2 text-xs"
                      >
                        <option value="">السعر الأساسي · {formatSAR(Number(l.item.salePrice))} ر.س</option>
                        {getSalePriceOptions(l.item).map((option) => (
                          <option key={option.id} value={option.id}>
                            {getSalePriceOptionName(option)} · {formatSAR(Number(option.salePrice))} ر.س
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
                        <button
                          onClick={() => updateQty(l.item.id, -1)}
                          type="button"
                          className="grid size-8 place-items-center rounded-lg hover:bg-card hover:text-primary"
                          aria-label="إنقاص"
                          data-testid={`button-decrease-quantity-${l.item.id}`}
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="min-w-7 text-center font-black text-sm">
                          {l.qty}
                        </span>
                        <button
                          onClick={() => updateQty(l.item.id, 1)}
                          type="button"
                          className="grid size-8 place-items-center rounded-lg hover:bg-card hover:text-primary"
                          aria-label="زيادة"
                          data-testid={`button-increase-quantity-${l.item.id}`}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <p className="text-sm font-black text-primary">
                        {formatSAR(getItemSalePrice(l.item, l.selectedSaleOptionId) * l.qty)}
                        <span className="text-[10px] text-muted-foreground font-bold mr-0.5">
                          ر.س
                        </span>
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => removeLine(l.item.id)}
                    type="button"
                    className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label="حذف"
                    data-testid={`button-remove-cart-line-${l.item.id}`}
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
      <div className="shrink-0 space-y-2.5 border-t border-border/80 bg-background p-3 sm:p-4">
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
              aria-label="نسبة الخصم"
              data-testid="input-pos-discount"
              className="flex-1 bg-transparent text-end text-sm font-bold outline-none"
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
          <div className="my-2 h-px bg-border" />
          <div className="flex items-center justify-between rounded-xl bg-primary/[0.055] px-3 py-2">
            <span className="font-extrabold">الإجمالي</span>
            <span className="text-xl font-black tabular-nums text-primary">
              {formatSAR(grandTotal)}
              <span className="text-sm text-muted-foreground font-bold mr-1">ر.س</span>
            </span>
          </div>
        </div>

        {/* All payment methods stay visible; only configured methods are actionable. */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 pt-0.5">
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
          <PayButton
            testId="button-pay-mixed"
            disabled={cart.length === 0 || submitting || !methods.mixed}
            disabledReason={!methods.mixed ? "اربط صندوقاً نقدياً وحساباً بنكياً من إعدادات نقاط البيع." : undefined}
            onClick={() => pay("mixed")}
            icon={<Banknote className="w-4 h-4" />}
            label="نقد + بنك"
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
          className="w-full h-12 rounded-xl bg-primary text-sm font-extrabold text-primary-foreground shadow-md shadow-primary/15 hover:bg-primary/95 disabled:opacity-50"
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
      className="h-11 min-w-0 rounded-xl border border-border bg-card px-1 text-xs font-bold transition-colors hover:border-primary/30 hover:bg-primary/[0.04] disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-card"
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
  companyNameEn: string;
  companyVatNumber: string;
  companyCrNumber: string;
  companyCity: string;
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
    companyNameEn,
    companyVatNumber,
    companyCrNumber,
    companyCity,
    cashierName,
  } = props;
  const printReceipt = (widthMm: 58 | 80) => {
    const opened = printPosThermalReceipt({
      invoice, cart, subtotal, discountAmount, vatAmount, grandTotal, method,
      companyName: companyNameAr, companyNameEn, companyVatNumber, companyCrNumber, companyCity,
      companyLogo, cashierName, widthMm,
    });
    if (!opened) window.alert("اسمح بفتح النوافذ المنبثقة لطباعة الإيصال.");
  };

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
              <span className="inline-flex items-start gap-1.5"><AlertCircle className="mt-0.5 size-3.5 shrink-0" />{warning}</span>
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

          <div className="grid grid-cols-2 gap-2 pt-2 print:hidden">
            <button
              onClick={onClose}
              className="h-11 rounded-xl border border-border bg-card font-bold text-xs hover-elevate active-elevate-2"
            >
              فاتورة جديدة
            </button>
            <button
              onClick={() => printReceipt(80)}
              className="h-11 rounded-xl bg-primary text-primary-foreground font-bold text-xs inline-flex items-center justify-center gap-1 hover-elevate active-elevate-2"
              title="طباعة بالنموذج الحراري الكلاسيكي رقم 6"
            >
              <Receipt className="w-4 h-4" />
              حراري كلاسيكي 80
            </button>
          </div>
          <div className="text-[10px] text-muted-foreground text-center print:hidden">
            <button
              onClick={() => printReceipt(58)}
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
