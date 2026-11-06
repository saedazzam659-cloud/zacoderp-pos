import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight, ChevronLeft, Plus, Send, Trash2, Loader2, Users, Clock, X, RefreshCw, Settings,
  Search, Utensils, MapPin, ShoppingBag, AlertCircle, Truck, Phone, ClipboardList, Languages,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import VoiceSearchButton from "@/components/VoiceSearchButton";
import {
  api, getToken, getStoredUser,
  type RTable, type ROrder, type ROrderItem, type RMenuItem,
} from "@/lib/api";
import RestaurantModifierDialog, { type RestaurantModifierSelection } from "@/components/RestaurantModifierDialog";
import { tr, usePosLanguage } from "@/lib/posLanguage";

export default function WaiterApp() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const user = getStoredUser();
  const { language, setLanguage } = usePosLanguage();
  const dir = language === "ar" ? "rtl" : "ltr";
  const text = (ar: string, en: string) => tr(language, ar, en);
  const [view, setView] = useState<"tables" | "delivery" | "takeaway">(() =>
    new URLSearchParams(window.location.search).get("view") === "delivery" ? "delivery"
      : new URLSearchParams(window.location.search).get("view") === "takeaway" ? "takeaway" : "tables");
  const [openTableId, setOpenTableId] = useState<number | null>(null);
  const [activeOrder, setActiveOrder] = useState<(ROrder & { items: ROrderItem[] }) | null>(null);
  const [activeCat, setActiveCat] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [opening, setOpening] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryNotes, setDeliveryNotes] = useState("");
  const [creatingDelivery, setCreatingDelivery] = useState(false);
  const [deliveryError, setDeliveryError] = useState("");
  const [modifierTarget, setModifierTarget] = useState<{ item: RMenuItem; line?: ROrderItem } | null>(null);
  const [tableOperationOpen, setTableOperationOpen] = useState(false);
  const [tableOperationKind, setTableOperationKind] = useState<"move" | "merge" | "split">("move");
  const [tableOperationTarget, setTableOperationTarget] = useState("");
  const [splitItemIds, setSplitItemIds] = useState<number[]>([]);
  const [splitGuestCount, setSplitGuestCount] = useState(1);

  useEffect(() => { if (!getToken()) setLocation("/login"); }, [setLocation]);

  const tablesQ = useQuery({ queryKey: ["r-tables"], queryFn: () => api.rTables(), refetchInterval: 5000 });
  const catsQ = useQuery({ queryKey: ["r-cats"], queryFn: () => api.rCategories() });
  const itemsQ = useQuery({ queryKey: ["r-items"], queryFn: () => api.rMenuItems() });
  const serviceOrdersQ = useQuery({
    queryKey: ["r-service-orders"],
    queryFn: () => api.rOrders(),
    refetchInterval: 5000,
    select: orders => orders.filter(order =>
      ["delivery", "takeaway"].includes(order.channel) && !["billed", "cancelled"].includes(order.status)),
  });
  const draftTableOrdersQ = useQuery({
    queryKey: ["r-table-operation-orders", activeOrder?.id],
    queryFn: () => api.rOrders(),
    enabled: tableOperationOpen && tableOperationKind === "merge",
    select: orders => orders.filter(order =>
      order.id !== activeOrder?.id && order.channel === "dine_in" && order.status === "open" && !!order.tableId),
  });

  // Select a table and reuse its open order, otherwise create a draft.
  useEffect(() => {
    if (view !== "tables") { setOpening(false); return; }
    if (!openTableId) { setActiveOrder(null); setOpening(false); return; }
    const tbl = tablesQ.data?.find(t => t.id === openTableId);
    if (!tbl) return;
    let cancelled = false;
    setOpening(true);
    (async () => {
      if (tbl.currentOrderId) {
        try {
          const order = await api.rOrder(tbl.currentOrderId);
          if (!cancelled) setActiveOrder(order);
        } catch {
          // Preserve the existing order-fetch behavior; the waiter can close and retry.
        }
      }
      if (!tbl.currentOrderId) {
        try {
          const order = await api.rCreateOrder({
            branchId: tbl.branchId, tableId: tbl.id, channel: "dine_in", guestCount: 2,
          });
          await qc.invalidateQueries({ queryKey: ["r-tables"] });
          const full = await api.rOrder(order.id);
          if (!cancelled) setActiveOrder(full);
        } catch (e: any) {
          if (!cancelled) alert(e?.message ?? text("تعذّر إنشاء الطلب", "Could not create the order"));
        }
      }
      if (!cancelled) setOpening(false);
    })();
    return () => { cancelled = true; };
  }, [openTableId, tablesQ.data, qc, view, language]);

  const addItem = useMutation({
    mutationFn: ({ orderId, menuItemId, modifiers }: { orderId: number; menuItemId: number; modifiers: RestaurantModifierSelection }) =>
      api.rAddItem(orderId, { menuItemId, qty: 1, modifiers }),
    onSuccess: async () => {
      if (activeOrder) setActiveOrder(await api.rOrder(activeOrder.id));
      await qc.invalidateQueries({ queryKey: ["r-service-orders"] });
      setModifierTarget(null);
    },
  });
  const updateItemModifiers = useMutation({
    mutationFn: ({ orderId, itemId, modifiers }: { orderId: number; itemId: number; modifiers: RestaurantModifierSelection }) =>
      api.rUpdateItemModifiers(orderId, itemId, modifiers),
    onSuccess: async () => {
      if (activeOrder) setActiveOrder(await api.rOrder(activeOrder.id));
      await qc.invalidateQueries({ queryKey: ["r-service-orders"] });
      setModifierTarget(null);
    },
  });
  const removeItem = useMutation({
    mutationFn: ({ orderId, itemId }: { orderId: number; itemId: number }) => api.rRemoveItem(orderId, itemId),
    onSuccess: async () => {
      if (activeOrder) setActiveOrder(await api.rOrder(activeOrder.id));
      await qc.invalidateQueries({ queryKey: ["r-service-orders"] });
    },
  });
  const sendOrder = useMutation({
    mutationFn: (id: number) => api.rSendOrder(id),
    onSuccess: async () => {
      if (activeOrder) setActiveOrder(await api.rOrder(activeOrder.id));
      await qc.invalidateQueries({ queryKey: ["r-tables"] });
      await qc.invalidateQueries({ queryKey: ["r-service-orders"] });
    },
  });
  const cancelOrder = useMutation({
    mutationFn: (id: number) => api.rCancelOrder(id),
    onSuccess: async () => {
      setActiveOrder(null); setOpenTableId(null);
      await qc.invalidateQueries({ queryKey: ["r-tables"] });
      await qc.invalidateQueries({ queryKey: ["r-service-orders"] });
    },
  });
  const tableOperationMutation = useMutation({
    mutationFn: () => {
      if (!activeOrder) throw new Error("لا يوجد طلب مفتوح");
      return api.rTableOperation(activeOrder.id, tableOperationKind === "merge"
        ? { operation: "merge", targetOrderId: Number(tableOperationTarget) }
        : tableOperationKind === "split"
          ? { operation: "split", targetTableId: Number(tableOperationTarget), itemIds: splitItemIds, guestCount: splitGuestCount }
          : { operation: "move", targetTableId: Number(tableOperationTarget) });
    },
    onSuccess: async result => {
      const updatedOrder = await api.rOrder(result.activeOrderId);
      setActiveOrder(updatedOrder);
      setOpenTableId(updatedOrder.tableId ?? null);
      setTableOperationOpen(false);
      setSplitItemIds([]);
      setTableOperationTarget("");
      await qc.invalidateQueries({ queryKey: ["r-tables"] });
      await qc.invalidateQueries({ queryKey: ["r-service-orders"] });
    },
  });

  const filteredItems = useMemo(() => {
    let arr = itemsQ.data ?? [];
    arr = arr.filter(item => item.showInPos !== false);
    if (activeCat) arr = arr.filter(i => i.categoryId === activeCat);
    if (search.trim()) {
      const term = search.trim().toLowerCase();
      arr = arr.filter(i =>
        i.nameAr.toLowerCase().includes(term) ||
        (i.nameEn ?? "").toLowerCase().includes(term) ||
        (i.code ?? "").toLowerCase().includes(term));
    }
    return arr;
  }, [itemsQ.data, activeCat, search]);
  const tableAreas = useMemo(() => {
    const grouped = new Map<string, RTable[]>();
    for (const table of tablesQ.data ?? []) {
      const area = table.area?.trim() || text("الصالة", "Dining room");
      grouped.set(area, [...(grouped.get(area) ?? []), table]);
    }
    return [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b, language === "ar" ? "ar" : "en"))
      .map(([area, tables]) => ({ area, tables: tables.sort((a, b) => a.code.localeCompare(b.code, language === "ar" ? "ar" : "en")) }));
  }, [tablesQ.data, language]);
  const freeCount = (tablesQ.data ?? []).filter(table => table.status === "free").length;
  const visibleServiceOrders = (serviceOrdersQ.data ?? []).filter(order => order.channel === view);
  const unsentItemCount = activeOrder?.items.filter(item => !item.sentAt && item.status === "pending").length ?? 0;
  const sentItemCount = activeOrder?.items.filter(item => Boolean(item.sentAt)).length ?? 0;
  const hasUnservedKitchenItems = !!activeOrder?.items.some(item =>
    Boolean(item.sentAt) && !["served", "cancelled"].includes(item.status));
  const isDeliveryView = view === "delivery";
  const selectedTable = tablesQ.data?.find(table => table.id === openTableId);
  const chooseMenuItem = (item: RMenuItem) => {
    if (item.modifierGroups?.length) setModifierTarget({ item });
    else if (activeOrder) addItem.mutate({ orderId: activeOrder.id, menuItemId: item.id, modifiers: [] });
  };
  const confirmModifiers = (modifiers: RestaurantModifierSelection) => {
    if (!activeOrder || !modifierTarget) return;
    if (modifierTarget.line) {
      updateItemModifiers.mutate({ orderId: activeOrder.id, itemId: modifierTarget.line.id, modifiers });
    } else {
      addItem.mutate({ orderId: activeOrder.id, menuItemId: modifierTarget.item.id, modifiers });
    }
  };
  const modifierInitialSelection = useMemo(() => {
    const selections: RestaurantModifierSelection = [];
    for (const modifier of modifierTarget?.line?.modifiers ?? []) {
      if (!modifier.groupId || !modifier.optionId) continue;
      const group = selections.find(entry => entry.groupId === modifier.groupId);
      if (group) group.optionIds.push(modifier.optionId);
      else selections.push({ groupId: modifier.groupId, optionIds: [modifier.optionId] });
    }
    return selections;
  }, [modifierTarget?.line?.modifiers]);
  const deliveryBranchId =
    Number(localStorage.getItem("pos_branch_id") || 0) ||
    tablesQ.data?.[0]?.branchId ||
    null;

  async function createDelivery() {
    if (!customerName.trim() || !customerPhone.trim()) {
      setDeliveryError(text("أدخل اسم العميل ورقم التواصل لبدء طلب التوصيل.", "Enter the customer's name and phone number to start a delivery order."));
      return;
    }
    if (deliveryAddress.trim().length < 4) {
      setDeliveryError(text("أدخل عنوان توصيل واضحًا (4 أحرف على الأقل).", "Enter a delivery address (at least 4 characters)."));
      return;
    }
    if (!deliveryBranchId) {
      setDeliveryError(text("تعذّر تحديد الفرع. تحقق من إعدادات نقطة البيع.", "Could not identify the branch. Check the POS settings."));
      return;
    }
    setCreatingDelivery(true);
    setDeliveryError("");
    try {
      const order = await api.rCreateOrder({
        branchId: deliveryBranchId,
        channel: "delivery",
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        deliveryAddress: deliveryAddress.trim(),
        notes: deliveryNotes.trim() || undefined,
      });
      await qc.invalidateQueries({ queryKey: ["r-service-orders"] });
      setActiveOrder(await api.rOrder(order.id));
      setCustomerName("");
      setCustomerPhone("");
      setDeliveryAddress("");
      setDeliveryNotes("");
    } catch (error: any) {
      setDeliveryError(error?.message ?? text("تعذّر إنشاء طلب التوصيل.", "Could not create the delivery order."));
    } finally {
      setCreatingDelivery(false);
    }
  }

  async function createTakeaway() {
    if (!deliveryBranchId) {
      setDeliveryError(text("تعذّر تحديد الفرع. تحقق من إعدادات نقطة البيع.", "Could not identify the branch. Check the POS settings."));
      return;
    }
    setCreatingDelivery(true);
    setDeliveryError("");
    try {
      const order = await api.rCreateOrder({
        branchId: deliveryBranchId,
        channel: "takeaway",
        customerName: customerName.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
        notes: deliveryNotes.trim() || undefined,
      });
      await qc.invalidateQueries({ queryKey: ["r-service-orders"] });
      setActiveOrder(await api.rOrder(order.id));
      setCustomerName("");
      setCustomerPhone("");
      setDeliveryNotes("");
    } catch (error: any) {
      setDeliveryError(error?.message ?? text("تعذّر إنشاء طلب السفري.", "Could not create the takeaway order."));
    } finally {
      setCreatingDelivery(false);
    }
  }

  async function resumeServiceOrder(orderId: number, channel: "delivery" | "takeaway") {
    setView(channel);
    setOpening(true);
    try {
      setActiveOrder(await api.rOrder(orderId));
    } catch (error: any) {
      setDeliveryError(error?.message ?? text("تعذّر استعادة الطلب.", "Could not reopen the order."));
    } finally {
      setOpening(false);
    }
  }

  const tableStatus = (table: RTable) => {
    switch (table.status) {
      case "free": return { label: text("متاحة", "Available"), style: "border-primary/25 bg-primary/[0.06] text-primary", dot: "bg-primary" };
      case "occupied": return { label: text("مشغولة", "Occupied"), style: "border-destructive/25 bg-destructive/[0.06] text-destructive", dot: "bg-destructive" };
      case "reserved": return { label: text("محجوزة", "Reserved"), style: "border-amber-500/30 bg-amber-500/[0.08] text-amber-700", dot: "bg-amber-500" };
      case "cleaning": return { label: text("تنظيف", "Cleaning"), style: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground" };
    }
  };

  return (
    <div dir={dir} lang={language} className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-3 border-b border-border/80 bg-card px-3 py-2 shadow-sm sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/restaurant")} aria-label={text("العودة إلى المطعم", "Back to restaurant")} data-testid="button-waiter-back">
            {language === "ar" ? <ChevronRight className="ms-1 h-4 w-4" /> : <ChevronLeft className="ms-1 h-4 w-4" />} {text("رجوع", "Back")}
          </Button>
          <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <Utensils className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-black sm:text-base">{text("طلبات المطعم", "Restaurant orders")}</div>
            <div className="truncate text-xs text-muted-foreground">{user?.username ? `${text("النادل", "Waiter")} · ${user.username}` : text("الصالة والسفري والتوصيل", "Dine-in, takeaway, and delivery")}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setLanguage(language === "ar" ? "en" : "ar")} aria-label={text("التبديل إلى الإنجليزية", "Switch to Arabic")} data-testid="button-waiter-language">
            <Languages className="h-4 w-4" /> {language === "ar" ? "EN" : "AR"}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setLocation("/restaurant-settings?tab=tables&returnTo=waiter")} aria-label={text("إعدادات الطاولات", "Table settings")} data-testid="button-waiter-settings">
            <Settings className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => qc.invalidateQueries({ queryKey: ["r-tables"] })} aria-label={text("تحديث الطاولات", "Refresh tables")} data-testid="button-refresh-tables">
            <RefreshCw className={`h-4 w-4 ${tablesQ.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </header>

      {!activeOrder ? (
        <main className="mx-auto w-full max-w-[1500px] flex-1 p-4 sm:p-6">
          <div className="mb-6 grid w-full max-w-3xl grid-cols-3 rounded-2xl border border-border bg-card p-1.5 shadow-sm" role="tablist" aria-label={text("قناة الطلب", "Order channel")}>
            <button type="button" role="tab" aria-selected={view === "tables"} onClick={() => { setView("tables"); setDeliveryError(""); }}
              data-testid="button-view-dine-in" className={`flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-black transition ${view === "tables" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted"}`}>
              <Utensils className="h-4 w-4" /> {text("الصالة والطاولات", "Dine-in tables")}
            </button>
            <button type="button" role="tab" aria-selected={view === "takeaway"} onClick={() => { setView("takeaway"); setOpenTableId(null); setDeliveryError(""); }}
              data-testid="button-view-takeaway" className={`flex min-h-12 items-center justify-center gap-2 rounded-xl text-sm font-black transition ${view === "takeaway" ? "bg-amber-600 text-white shadow-sm" : "text-muted-foreground hover:bg-muted"}`}>
              <ShoppingBag className="h-4 w-4" /> {text("طلبات السفري", "Takeaway")}
            </button>
            <button type="button" role="tab" aria-selected={view === "delivery"} onClick={() => { setView("delivery"); setOpenTableId(null); setDeliveryError(""); }}
              data-testid="button-view-delivery" className={`flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-black transition ${view === "delivery" ? "bg-orange-600 text-white shadow-sm" : "text-muted-foreground hover:bg-muted"}`}>
              <Truck className="h-4 w-4" /> {text("طلبات التوصيل", "Delivery orders")}
            </button>
          </div>
          {view !== "tables" ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
              <section className={`overflow-hidden rounded-2xl border bg-card shadow-sm ${isDeliveryView ? "border-orange-200" : "border-amber-200"}`}>
                <div className={`flex items-center justify-between border-b px-5 py-4 ${isDeliveryView ? "border-orange-100 bg-orange-50/80" : "border-amber-100 bg-amber-50/80"}`}>
                  <div><p className={`text-xs font-bold ${isDeliveryView ? "text-orange-700" : "text-amber-700"}`}>{isDeliveryView ? text("قناة مستقلة · توصيل", "Separate channel · Delivery") : text("قناة مستقلة · استلام", "Separate channel · Pickup")}</p><h1 className="mt-1 text-xl font-black">{isDeliveryView ? text("طلبات التوصيل النشطة", "Active delivery orders") : text("طلبات السفري النشطة", "Active takeaway orders")}</h1></div>
                  <span className={`grid size-11 place-items-center rounded-xl ${isDeliveryView ? "bg-orange-100 text-orange-700" : "bg-amber-100 text-amber-700"}`}>{isDeliveryView ? <Truck className="h-5 w-5" /> : <ShoppingBag className="h-5 w-5" />}</span>
                </div>
                <div className="space-y-2 p-4">
                  {serviceOrdersQ.isLoading ? Array.from({ length: 3 }, (_, i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />) :
                    serviceOrdersQ.isError ? <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-5 text-sm text-destructive" role="alert">
                      {text("تعذّر تحميل الطلبات.", "Could not load orders.")} <Button variant="outline" size="sm" onClick={() => serviceOrdersQ.refetch()} className="ms-2">{text("إعادة المحاولة", "Try again")}</Button>
                    </div> : visibleServiceOrders.length === 0 ?
                      <div className="rounded-xl border border-dashed border-border px-5 py-10 text-center">
                        <ClipboardList className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
                        <p className="font-bold">{isDeliveryView ? text("لا توجد طلبات توصيل نشطة", "No active delivery orders") : text("لا توجد طلبات سفري نشطة", "No active takeaway orders")}</p><p className="mt-1 text-sm text-muted-foreground">{text("ستظهر الطلبات هنا لتتمكن من استكمالها.", "Orders will appear here so you can continue them.")}</p>
                      </div> :
                      visibleServiceOrders.map(order => (
                        <button key={order.id} type="button" onClick={() => resumeServiceOrder(order.id, isDeliveryView ? "delivery" : "takeaway")} data-testid={`button-resume-${order.channel}-${order.id}`}
                          className={`flex w-full items-center justify-between gap-3 rounded-xl border bg-background p-4 text-start transition focus-visible:outline-none focus-visible:ring-2 ${isDeliveryView ? "border-orange-100 hover:border-orange-300 hover:bg-orange-50/50 focus-visible:ring-orange-500" : "border-amber-100 hover:border-amber-300 hover:bg-amber-50/50 focus-visible:ring-amber-500"}`}>
                          <span className="min-w-0"><span className="flex items-center gap-2 font-black">{order.orderNumber}<span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${isDeliveryView ? "bg-orange-100 text-orange-800" : "bg-amber-100 text-amber-800"}`}>{isDeliveryView ? text("توصيل", "Delivery") : text("سفري", "Takeaway")}</span></span>
                            {(order.customerName || order.customerPhone) && <span className="mt-1 block truncate text-sm text-muted-foreground">{[order.customerName, order.customerPhone].filter(Boolean).join(" · ")}</span>}
                            {order.deliveryAddress && <span className="mt-1 block truncate text-xs text-orange-800">{order.deliveryAddress}</span>}
                          </span><span className="shrink-0 text-end"><span className="block font-black">{Number(order.total).toFixed(2)} {text("ر.س", "SAR")}</span><span className="mt-1 block text-xs text-muted-foreground">{statusLabel(order.status, language)}</span></span>
                        </button>
                      ))}
                </div>
              </section>
              <section className="h-fit rounded-2xl border border-border bg-card p-5 shadow-sm">
                <div className="mb-5 flex items-center gap-3"><span className={`grid size-10 place-items-center rounded-xl ${isDeliveryView ? "bg-orange-100 text-orange-700" : "bg-amber-100 text-amber-700"}`}><Plus className="h-5 w-5" /></span>
                  <div><p className={`text-xs font-bold ${isDeliveryView ? "text-orange-700" : "text-amber-700"}`}>{text("طلب جديد", "New order")}</p><h2 className="text-lg font-black">{isDeliveryView ? text("بيانات التوصيل", "Delivery details") : text("بيانات طلب السفري", "Takeaway details")}</h2></div></div>
                <div className="space-y-4">
                  <label className="block text-sm font-bold">{text("اسم العميل (اختياري)", "Customer name (optional)")}<Input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder={text("اسم المستلم", "Recipient name")} data-testid={`input-${view}-customer-name`} className="mt-1.5 h-11 rounded-xl" /></label>
                  <label className="block text-sm font-bold">{text("رقم التواصل", "Phone number")}<div className="relative mt-1.5"><Phone className={`absolute ${dir === "rtl" ? "right-3" : "left-3"} top-3.5 h-4 w-4 text-muted-foreground`} /><Input value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} placeholder="05xxxxxxxx" inputMode="tel" data-testid={`input-${view}-customer-phone`} className={`h-11 rounded-xl ${dir === "rtl" ? "pr-10" : "pl-10"}`} /></div></label>
                  {isDeliveryView && <label className="block text-sm font-bold">{text("عنوان التوصيل", "Delivery address")}<textarea required value={deliveryAddress} onChange={e => setDeliveryAddress(e.target.value)} placeholder={text("المدينة، الحي، الشارع، رقم المبنى أو علامة مميزة", "City, district, street, building number or landmark")} data-testid="input-delivery-address" className="mt-1.5 min-h-20 w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm font-normal outline-none transition focus-visible:ring-2 focus-visible:ring-ring" /></label>}
                  <label className="block text-sm font-bold">{text("ملاحظة للطلب", "Order note")}<textarea value={deliveryNotes} onChange={e => setDeliveryNotes(e.target.value)} placeholder={isDeliveryView ? text("الدور، الشقة، أو تعليمات الوصول", "Floor, apartment, or access instructions") : text("اسم صاحب الطلب أو ملاحظات التحضير", "Pickup name or preparation notes")} data-testid={`input-${view}-notes`} className="mt-1.5 min-h-20 w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm font-normal outline-none transition focus-visible:ring-2 focus-visible:ring-ring" /></label>
                  {deliveryError && <p className="text-sm text-destructive" role="alert">{deliveryError}</p>}
                  <Button type="button" disabled={creatingDelivery || !deliveryBranchId} onClick={isDeliveryView ? createDelivery : createTakeaway} data-testid={`button-create-${view}-order`} className={`h-12 w-full font-black text-white ${isDeliveryView ? "bg-orange-600 hover:bg-orange-700" : "bg-amber-600 hover:bg-amber-700"}`}>
                    {creatingDelivery ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Plus className="me-2 h-4 w-4" />} {isDeliveryView ? text("إنشاء طلب التوصيل واختيار الأصناف", "Create delivery order and choose items") : text("إنشاء طلب سفري واختيار الأصناف", "Create takeaway order and choose items")}
                  </Button>
                </div>
              </section>
            </div>
          ) : <>
          <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary"><MapPin className="h-3.5 w-3.5" /> {text("الصالة الآن", "Dining room")}</p>
              <h1 className="text-2xl font-black tracking-tight sm:text-3xl">{text("اختر طاولة", "Choose a table")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{text("افتح طاولة لبدء طلب أو متابعة الطلب المفتوح.", "Open a table to start or continue its order.")}</p>
            </div>
            {!tablesQ.isLoading && (tablesQ.data ?? []).length > 0 && (
              <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs font-bold shadow-sm" data-testid="status-table-summary">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-primary"><i className="size-1.5 rounded-full bg-primary" />{freeCount} {text("متاحة", "available")}</span>
                <span className="text-muted-foreground">{(tablesQ.data?.length ?? 0) - freeCount} {text("مستخدمة", "in use")}</span>
              </div>
            )}
          </div>

          {tablesQ.isLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6" role="status" aria-label={text("جارٍ تحميل الطاولات", "Loading tables")}>
              {Array.from({ length: 8 }, (_, i) => <div key={i} className="h-32 animate-pulse rounded-2xl border border-border bg-muted/70" />)}
            </div>
          ) : tablesQ.isError ? (
            <section className="mx-auto mt-12 max-w-lg rounded-2xl border border-destructive/20 bg-card p-8 text-center shadow-sm" role="alert">
              <AlertCircle className="mx-auto mb-3 h-8 w-8 text-destructive" />
              <h2 className="font-bold">{text("تعذّر تحميل الطاولات", "Could not load tables")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{text("تحقق من الاتصال ثم حاول التحديث.", "Check your connection, then try again.")}</p>
              <Button onClick={() => tablesQ.refetch()} className="mt-4" data-testid="button-retry-tables"><RefreshCw className="me-2 h-4 w-4" /> {text("إعادة المحاولة", "Try again")}</Button>
            </section>
          ) : (tablesQ.data ?? []).length === 0 ? (
            <section className="mx-auto mt-10 max-w-xl rounded-3xl border border-border bg-card px-6 py-12 text-center shadow-sm">
              <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-primary/10 text-primary"><Users className="h-7 w-7" /></div>
              <h2 className="text-lg font-black">{text("لا توجد طاولات معرّفة بعد", "No tables have been set up")}</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{text("أضف الطاولات من إعدادات المطعم لتبدأ استقبال الطلبات في الصالة.", "Add tables in restaurant settings to start taking dine-in orders.")}</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Button onClick={() => setLocation("/restaurant-settings?tab=tables&returnTo=waiter")} data-testid="btn-add-tables-cta"><Plus className="me-2 h-4 w-4" /> {text("إضافة طاولات", "Add tables")}</Button>
                <Button variant="outline" onClick={() => qc.invalidateQueries({ queryKey: ["r-tables"] })} data-testid="btn-refresh-tables"><RefreshCw className="me-2 h-4 w-4" /> {text("تحديث", "Refresh")}</Button>
              </div>
            </section>
          ) : (
            <div className="space-y-7">
              {tableAreas.map(({ area, tables }) => (
                <section key={area} aria-label={`${text("منطقة", "Area")} ${area}`} data-testid={`section-table-area-${area}`}>
                  <div className="mb-3 flex items-center justify-between border-b border-border pb-2">
                    <h2 className="font-black">{area}</h2><span className="text-xs text-muted-foreground">{tables.length} {text("طاولة", "tables")}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
                    {tables.map(table => {
                      const status = tableStatus(table);
                      return (
                        <button key={table.id} type="button" onClick={() => setOpenTableId(table.id)}
                          aria-label={`${text("فتح", "Open")} ${table.nameAr}, ${status.label}`}
                          data-testid={`button-table-${table.id}`}
                          className={`group min-h-32 rounded-2xl border bg-card p-3 text-start shadow-sm transition duration-150 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${status.style}`}>
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[11px] font-bold opacity-70">{table.code}</span>
                            <span className={`size-2 rounded-full ${status.dot}`} />
                          </div>
                          <div className="mt-3 truncate text-base font-black text-foreground">{table.nameAr}</div>
                          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" />{table.capacity} {text("مقاعد", "seats")}</div>
                          <div className="mt-3 border-t border-current/10 pt-2 text-xs font-bold">{status.label}</div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
          </>}
        </main>
      ) : (
        <main className="mx-auto grid min-h-0 w-full max-w-[1600px] flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
          <section className="flex min-h-[55dvh] flex-col border-b border-border md:min-h-0 md:border-b-0 md:border-l" aria-label={text("قائمة الطعام", "Menu")}>
            <div className="flex gap-2 border-b border-border bg-card p-3">
              <div className="relative min-w-0 flex-1">
                <Search className={`absolute ${dir === "rtl" ? "right-3" : "left-3"} top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground`} />
                <Input placeholder={text("ابحث في القائمة...", "Search menu...")} value={search} onChange={e => setSearch(e.target.value)}
                  aria-label={text("البحث في قائمة الطعام", "Search menu")} data-testid="input-menu-search"
                  className={`h-11 rounded-xl bg-background ${dir === "rtl" ? "pr-10" : "pl-10"}`} />
              </div>
              <div className="grid place-items-center rounded-xl border border-border bg-background px-1">
                <VoiceSearchButton onResult={text => {
                  setSearch(text);
                  const matches = (itemsQ.data ?? []).filter(i =>
                    i.nameAr.includes(text) || text.includes(i.nameAr) ||
                    Boolean(i.nameEn && (i.nameEn.includes(text) || text.includes(i.nameEn))));
                  if (matches.length === 1 && activeOrder) {
                    chooseMenuItem(matches[0]);
                    setSearch("");
                  }
                }} />
              </div>
            </div>
            <div className="flex gap-2 overflow-x-auto border-b border-border bg-muted/40 px-3 py-2" role="tablist" aria-label={text("فئات قائمة الطعام", "Menu categories")}>
              <button type="button" onClick={() => setActiveCat(null)} aria-pressed={activeCat == null} data-testid="button-menu-category-all"
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${activeCat == null ? "bg-primary text-primary-foreground shadow-sm" : "bg-card text-muted-foreground hover:text-foreground"}`}>{text("الكل", "All")}</button>
              {(catsQ.data ?? []).map(category => (
                <button key={category.id} type="button" onClick={() => setActiveCat(category.id)} aria-pressed={activeCat === category.id}
                  data-testid={`button-menu-category-${category.id}`}
                  className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${activeCat === category.id ? "bg-primary text-primary-foreground shadow-sm" : "bg-card text-muted-foreground hover:text-foreground"}`}>
                  {language === "en" ? (category.nameEn || category.nameAr) : category.nameAr}
                </button>
              ))}
            </div>
            <div className="grid flex-1 auto-rows-max grid-cols-2 content-start gap-3 overflow-y-auto bg-background p-3 sm:grid-cols-3 lg:grid-cols-4">
              {itemsQ.isLoading ? Array.from({ length: 8 }, (_, i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-muted" />) :
                itemsQ.isError ? <div className="col-span-full py-10 text-center text-sm text-destructive" role="alert">{text("تعذّر تحميل الأصناف.", "Could not load menu items.")}</div> :
                  filteredItems.length === 0 ? (
                    <div className="col-span-full py-12 text-center text-sm leading-6 text-muted-foreground" data-testid="empty-restaurant-menu">
                      {(itemsQ.data ?? []).length === 0
                         ? text("قائمة المطعم فارغة. أضف الأصناف من إعدادات المطعم، أو استورد أصناف المخزون واربطها بسجلاتها.", "The restaurant menu is empty. Add items in restaurant settings, or import and link inventory items.")
                         : text("لا توجد أصناف مطابقة. جرّب فئة أخرى أو امسح البحث.", "No matching items. Try another category or clear your search.")}
                    </div>
                  ) :
                    filteredItems.map(item => (
                      <button key={item.id} type="button" disabled={addItem.isPending}
                        onClick={() => chooseMenuItem(item)}
                        data-testid={`button-add-menu-item-${item.id}`} aria-label={`${text("إضافة", "Add")} ${item.nameEn && language === "en" ? item.nameEn : item.nameAr}`}
                        className="group min-h-28 rounded-2xl border border-border bg-card p-3 text-start shadow-sm transition hover:border-primary/40 hover:shadow-md disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        <span className="flex items-start justify-between gap-2">
                          <span className="text-sm font-bold leading-5">{language === "en" ? (item.nameEn || item.nameAr) : item.nameAr}</span>
                          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground"><Plus className="h-4 w-4" /></span>
                        </span>
                        <span className="mt-3 block text-base font-black text-primary">{new Intl.NumberFormat(language === "ar" ? "ar-SA" : "en-US", { minimumFractionDigits: 2 }).format(Number(item.price))} <span className="text-xs font-semibold">{text("ر.س", "SAR")}</span></span>
                        {item.prepTimeMinutes > 0 && <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground"><Clock className="h-3 w-3" />{item.prepTimeMinutes} {text("د", "min")}</span>}
                      </button>
                    ))}
            </div>
          </section>

          <aside className="flex min-h-[70dvh] flex-col bg-card md:sticky md:top-16 md:h-[calc(100dvh-4rem)] md:min-h-0" aria-label={text("تفاصيل الطلب", "Order details")}>
            <div className="border-b border-border p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                   <p className={`text-xs font-bold ${activeOrder.channel === "delivery" ? "text-orange-700" : activeOrder.channel === "takeaway" ? "text-amber-700" : "text-primary"}`}>{activeOrder.channel === "delivery" ? text("طلب توصيل", "Delivery order") : activeOrder.channel === "takeaway" ? text("طلب سفري", "Takeaway order") : text("طلب صالة · طاولة", "Dine-in · Table")}</p>
                  <h2 className="mt-1 text-lg font-black">{activeOrder.orderNumber}</h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">{activeOrder.channel !== "dine_in" ? [activeOrder.customerName, activeOrder.customerPhone].filter(Boolean).join(" · ") || text("طلب استلام", "Pickup order") : `${text("طاولة", "Table")} ${selectedTable?.nameAr ?? activeOrder.tableId}`}</p>
                    {activeOrder.channel === "delivery" && activeOrder.deliveryAddress && <p className="mt-1 max-w-sm text-xs leading-5 text-orange-800">{activeOrder.deliveryAddress}</p>}
                </div>
                  <div className="flex items-center gap-1">
                    {activeOrder.channel === "dine_in" && activeOrder.tableId && !["billed", "cancelled"].includes(activeOrder.status) &&
                      <Button variant="outline" size="sm" onClick={() => { tableOperationMutation.reset(); setTableOperationKind("move"); setTableOperationTarget(""); setSplitItemIds([]); setSplitGuestCount(1); setTableOperationOpen(true); }}
                        data-testid="button-table-order-operations">
                        <MapPin className="me-1 h-4 w-4" /> {text("إدارة الطاولة", "Table actions")}
                      </Button>}
                    <Button variant="ghost" size="icon" aria-label={text("إغلاق الطلب والعودة للطاولات", "Close order and return")} data-testid="button-close-order"
                      onClick={() => { setActiveOrder(null); setOpenTableId(null); }}><X className="h-4 w-4" /></Button>
                  </div>
              </div>
              <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs font-bold text-muted-foreground" data-testid="status-active-order">
                 <span className="size-1.5 rounded-full bg-primary" />{statusLabel(activeOrder.status, language)}
              </div>
            </div>
            <div className="min-h-28 flex-1 overflow-y-auto p-3">
              {opening ? (
                <div className="space-y-3" role="status" aria-label={text("جارٍ فتح الطلب", "Opening order")}>
                  <div className="h-16 animate-pulse rounded-xl bg-muted" /><div className="h-16 animate-pulse rounded-xl bg-muted" />
                </div>
              ) : activeOrder.items.length === 0 ? (
                <div className="flex h-full min-h-32 flex-col items-center justify-center text-center text-muted-foreground">
                  <ShoppingBag className="mb-2 h-7 w-7 opacity-50" /><p className="text-sm font-semibold">{text("ابدأ بإضافة أصناف للطلب", "Add items to this order")}</p>
                </div>
              ) : activeOrder.items.map(line => (
                <div key={line.id} className="mb-2 flex items-center gap-2 rounded-xl border border-border/80 bg-background p-3" data-testid={`row-order-item-${line.id}`}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold">{line.nameSnapshot}</div>
                    {line.modifiers?.length ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {line.modifiers.map(modifier => modifier.option).join("، ")}
                      </div>
                    ) : null}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{Number(line.qty).toFixed(0)} × {Number(line.price).toFixed(2)}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${line.status === "served" ? "bg-primary/10 text-primary" : line.status === "ready" ? "bg-amber-100 text-amber-800" : line.status === "preparing" ? "bg-sky-100 text-sky-800" : "bg-muted text-muted-foreground"}`}>{statusLabel(line.status, language)}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-sm font-black">{Number(line.total).toFixed(2)}</div>
                  {!line.sentAt && itemsQ.data?.find(item => item.id === line.menuItemId)?.modifierGroups?.length ? (
                    <Button variant="ghost" size="icon" aria-label={`${text("تعديل الإضافات", "Edit add-ons")} ${line.nameSnapshot}`}
                      data-testid={`button-edit-order-item-modifiers-${line.id}`}
                      onClick={() => {
                        const item = itemsQ.data?.find(entry => entry.id === line.menuItemId);
                        if (item) setModifierTarget({ item, line });
                      }}>
                      <Settings className="h-4 w-4" />
                    </Button>
                  ) : null}
                  {!line.sentAt && <Button variant="ghost" size="icon" aria-label={`${text("حذف", "Remove")} ${line.nameSnapshot}`} data-testid={`button-remove-order-item-${line.id}`}
                    disabled={removeItem.isPending} onClick={() => removeItem.mutate({ orderId: activeOrder.id, itemId: line.id })}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>}
                </div>
              ))}
            </div>
            <div className="space-y-2 border-t border-border px-4 py-3 text-sm">
              <Row label={text("المجموع الفرعي", "Subtotal")} v={activeOrder.subtotal} language={language} />
              <Row label={text("ضريبة 15%", "VAT 15%")} v={activeOrder.vatAmount} language={language} />
              <Row label={text("الإجمالي", "Total")} v={activeOrder.total} language={language} bold />
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-border p-3">
              <Button disabled={unsentItemCount === 0 || sendOrder.isPending || opening} onClick={() => sendOrder.mutate(activeOrder.id)}
                data-testid="button-send-to-kitchen" className="h-11 font-bold">
                {sendOrder.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Send className="me-2 h-4 w-4" />}
                {unsentItemCount === 0
                  ? sentItemCount > 0 ? text("تم إرسال الأصناف", "Items already sent") : text("لا توجد أصناف للإرسال", "No items to send")
                  : activeOrder.sentAt
                    ? text("إرسال الأصناف الجديدة", "Send new items")
                    : text("إرسال للمطبخ", "Send to kitchen")}
              </Button>
              <Button variant="destructive" disabled={cancelOrder.isPending || opening} data-testid="button-cancel-order"
                 onClick={() => {
                   const message = hasUnservedKitchenItems
                     ? text("سيُلغى الطلب وتذاكره غير المقدمة، وتُحرر الطاولة إذا كانت ما زالت مرتبطة به. هل تريد المتابعة؟", "This order and its unserved kitchen lines will be cancelled. Its table will be released only if it is still linked to this order. Continue?")
                     : text("إلغاء الطلب نهائياً؟", "Cancel this order permanently?");
                   if (confirm(message)) cancelOrder.mutate(activeOrder.id);
                 }}>
                {cancelOrder.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <X className="me-2 h-4 w-4" />} {text("إلغاء الطلب", "Cancel order")}
              </Button>
            </div>
            {(sendOrder.isError || addItem.isError || updateItemModifiers.isError || removeItem.isError || cancelOrder.isError) && (
              <p className="px-4 pb-3 text-xs text-destructive" role="alert">
                {cancelOrder.isError && cancelOrder.error instanceof Error
                  ? cancelOrder.error.message
                  : text("تعذّر تنفيذ الإجراء. حاول مرة أخرى.", "Could not complete the action. Try again.")}
              </p>
            )}
          </aside>
        </main>
      )}
      {modifierTarget && activeOrder && (
        <RestaurantModifierDialog
          open={Boolean(modifierTarget)}
          onOpenChange={open => { if (!open && !updateItemModifiers.isPending && !addItem.isPending) setModifierTarget(null); }}
          item={modifierTarget.item}
          groups={modifierTarget.item.modifierGroups ?? []}
          language={language}
          submitting={addItem.isPending || updateItemModifiers.isPending}
          initialSelection={modifierInitialSelection}
          confirmLabel={modifierTarget.line ? text("حفظ التعديلات", "Save changes") : undefined}
          onConfirm={confirmModifiers}
        />
      )}
      {tableOperationOpen && activeOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="table-operation-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="table-operation-title" className="text-lg font-black">{text("إدارة الطلب والطاولة", "Manage table order")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{activeOrder.orderNumber} · {text("الطاولة", "Table")} {activeOrder.tableId}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setTableOperationOpen(false)} aria-label={text("إغلاق", "Close")}><X className="h-4 w-4" /></Button>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {([
                ["move", text("نقل", "Move")],
                ["merge", text("دمج", "Merge")],
                ["split", text("تقسيم", "Split")],
              ] as const).map(([kind, label]) => {
                const draftOnly = kind !== "move";
                const draftReady = activeOrder.status === "open" && activeOrder.items.every(line => !line.sentAt && line.status === "pending");
                return <button key={kind} type="button" disabled={draftOnly && !draftReady}
                  aria-pressed={tableOperationKind === kind} onClick={() => { tableOperationMutation.reset(); setTableOperationKind(kind); setTableOperationTarget(""); setSplitItemIds([]); setSplitGuestCount(1); }}
                  className={`min-h-10 rounded-xl border px-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 ${tableOperationKind === kind ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}>
                  {label}
                </button>;
              })}
            </div>
            {tableOperationKind !== "merge" ? (
              <label className="mt-4 block text-sm font-bold">{text("الطاولة المتاحة", "Available table")}
                <select value={tableOperationTarget} onChange={e => setTableOperationTarget(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-input bg-background px-3">
                  <option value="">{text("اختر طاولة", "Choose a table")}</option>
                  {(tablesQ.data ?? []).filter(table => table.branchId === activeOrder.branchId && table.id !== activeOrder.tableId && table.status === "free" && table.isActive &&
                    table.capacity >= (tableOperationKind === "split" ? splitGuestCount : Number(activeOrder.guestCount))).map(table =>
                    <option key={table.id} value={table.id}>{table.nameAr} · {table.code} · {table.capacity}</option>)}
                </select>
              </label>
            ) : (
              <label className="mt-4 block text-sm font-bold">{text("الطلب المفتوح على الطاولة الأخرى", "Open order on the other table")}
                <select value={tableOperationTarget} onChange={e => setTableOperationTarget(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-input bg-background px-3">
                  <option value="">{text("اختر طلباً", "Choose an order")}</option>
                  {(draftTableOrdersQ.data ?? []).filter(order => order.branchId === activeOrder.branchId).map(order =>
                    <option key={order.id} value={order.id}>{order.orderNumber} · {text("طاولة", "Table")} {order.tableId}</option>)}
                </select>
              </label>
            )}
            {tableOperationKind === "split" && (
              <fieldset className="mt-4 space-y-2">
                <legend className="text-sm font-bold">{text("اختر الأصناف التي ستُنقل", "Choose items to move")}</legend>
                <label className="block text-sm font-bold">{text("عدد الضيوف على الطاولة الجديدة", "Guests at the new table")}
                  <Input type="number" min={1} max={Math.max(1, Number(activeOrder.guestCount) - 1)} value={splitGuestCount}
                    onChange={e => setSplitGuestCount(Number(e.target.value))} className="mt-1 h-10" />
                </label>
                {activeOrder.items.filter(line => !line.sentAt && line.status === "pending").map(line => (
                  <label key={line.id} className="flex items-center gap-2 rounded-lg border border-border p-2 text-sm">
                    <input type="checkbox" checked={splitItemIds.includes(line.id)}
                      onChange={e => setSplitItemIds(current => e.target.checked ? [...current, line.id] : current.filter(id => id !== line.id))} />
                    <span className="flex-1">{line.nameSnapshot} × {Number(line.qty).toFixed(0)}</span><span>{Number(line.total).toFixed(2)}</span>
                  </label>
                ))}
                <p className="text-xs text-muted-foreground">{text("التقسيم ينقل أصنافاً كاملة فقط، ويُبقي صنفاً واحداً على الأقل في الطلب الأصلي.", "Split moves whole lines only and keeps at least one line in the original order.")}</p>
              </fieldset>
            )}
            {tableOperationKind !== "move" && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">{text("الدمج والتقسيم متاحان قبل إرسال الأصناف للمطبخ فقط.", "Merge and split are available only before items are sent to the kitchen.")}</p>}
            {tableOperationMutation.isError && <p role="alert" className="mt-3 text-sm text-destructive">{(tableOperationMutation.error as Error).message || text("تعذّر تنفيذ العملية.", "Could not complete the operation.")}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setTableOperationOpen(false)}>{text("إلغاء", "Cancel")}</Button>
              <Button disabled={tableOperationMutation.isPending || !tableOperationTarget ||
                (tableOperationKind === "split" && (splitItemIds.length === 0 || splitItemIds.length >= activeOrder.items.length ||
                  splitGuestCount < 1 || splitGuestCount >= Number(activeOrder.guestCount)))}
                onClick={() => tableOperationMutation.mutate()}>
                {tableOperationMutation.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {text("تنفيذ", "Apply")}
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Row({ label, v, bold, language }: { label: string; v: string; bold?: boolean; language: "ar" | "en" }) {
  const amount = new Intl.NumberFormat(language === "ar" ? "ar-SA" : "en-US", { minimumFractionDigits: 2 }).format(Number(v) || 0);
  return <div className={`flex justify-between ${bold ? "border-t border-border pt-2 text-base font-black" : "text-muted-foreground"}`}><span>{label}</span><span className="text-foreground">{amount} {language === "ar" ? "ر.س" : "SAR"}</span></div>;
}
function statusLabel(s: ROrder["status"] | ROrderItem["status"], language: "ar" | "en") {
  const labels: Record<string, string> = language === "ar" ? {
    open: "مفتوح", sent: "أُرسل", preparing: "قيد التحضير", ready: "جاهز",
    served: "تم التقديم", billed: "مفوتر", cancelled: "ملغى", pending: "بانتظار",
  } : {
    open: "Open", sent: "Sent", preparing: "Preparing", ready: "Ready",
    served: "Served", billed: "Billed", cancelled: "Cancelled", pending: "Pending",
  };
  return labels[s] ?? s;
}
