import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight, Plus, Send, Trash2, Loader2, Users, Clock, X, RefreshCw, Settings,
  Search, Utensils, MapPin, ShoppingBag, AlertCircle, Truck, Phone, ClipboardList,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import VoiceSearchButton from "@/components/VoiceSearchButton";
import {
  api, getToken, getStoredUser,
  type RTable, type ROrder, type ROrderItem,
} from "@/lib/api";

export default function WaiterApp() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const user = getStoredUser();
  const [view, setView] = useState<"tables" | "delivery">(() =>
    new URLSearchParams(window.location.search).get("view") === "delivery" ? "delivery" : "tables");
  const [openTableId, setOpenTableId] = useState<number | null>(null);
  const [activeOrder, setActiveOrder] = useState<(ROrder & { items: ROrderItem[] }) | null>(null);
  const [activeCat, setActiveCat] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [opening, setOpening] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [deliveryNotes, setDeliveryNotes] = useState("");
  const [creatingDelivery, setCreatingDelivery] = useState(false);
  const [deliveryError, setDeliveryError] = useState("");

  useEffect(() => { if (!getToken()) setLocation("/login"); }, [setLocation]);

  const tablesQ = useQuery({ queryKey: ["r-tables"], queryFn: () => api.rTables(), refetchInterval: 5000 });
  const catsQ = useQuery({ queryKey: ["r-cats"], queryFn: () => api.rCategories() });
  const itemsQ = useQuery({ queryKey: ["r-items"], queryFn: () => api.rMenuItems() });
  const deliveryOrdersQ = useQuery({
    queryKey: ["r-delivery-orders"],
    queryFn: () => api.rOrders(),
    refetchInterval: 5000,
    select: orders => orders.filter(order =>
      order.channel === "delivery" && !["billed", "cancelled"].includes(order.status)),
  });

  // Select a table and reuse its open order, otherwise create a draft.
  useEffect(() => {
    if (view === "delivery") { setOpening(false); return; }
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
          if (!cancelled) alert(e?.message ?? "تعذّر إنشاء الطلب");
        }
      }
      if (!cancelled) setOpening(false);
    })();
    return () => { cancelled = true; };
  }, [openTableId, tablesQ.data, qc, view]);

  const addItem = useMutation({
    mutationFn: ({ orderId, menuItemId }: { orderId: number; menuItemId: number }) =>
      api.rAddItem(orderId, { menuItemId, qty: 1 }),
    onSuccess: async () => {
      if (activeOrder) setActiveOrder(await api.rOrder(activeOrder.id));
      await qc.invalidateQueries({ queryKey: ["r-delivery-orders"] });
    },
  });
  const removeItem = useMutation({
    mutationFn: ({ orderId, itemId }: { orderId: number; itemId: number }) => api.rRemoveItem(orderId, itemId),
    onSuccess: async () => {
      if (activeOrder) setActiveOrder(await api.rOrder(activeOrder.id));
      await qc.invalidateQueries({ queryKey: ["r-delivery-orders"] });
    },
  });
  const sendOrder = useMutation({
    mutationFn: (id: number) => api.rSendOrder(id),
    onSuccess: async () => {
      if (activeOrder) setActiveOrder(await api.rOrder(activeOrder.id));
      await qc.invalidateQueries({ queryKey: ["r-tables"] });
      await qc.invalidateQueries({ queryKey: ["r-delivery-orders"] });
    },
  });
  const cancelOrder = useMutation({
    mutationFn: (id: number) => api.rCancelOrder(id),
    onSuccess: async () => {
      setActiveOrder(null); setOpenTableId(null);
      await qc.invalidateQueries({ queryKey: ["r-tables"] });
      await qc.invalidateQueries({ queryKey: ["r-delivery-orders"] });
    },
  });

  const filteredItems = useMemo(() => {
    let arr = itemsQ.data ?? [];
    if (activeCat) arr = arr.filter(i => i.categoryId === activeCat);
    if (search.trim()) {
      const term = search.trim().toLowerCase();
      arr = arr.filter(i => i.nameAr.toLowerCase().includes(term) || (i.code ?? "").toLowerCase().includes(term));
    }
    return arr;
  }, [itemsQ.data, activeCat, search]);
  const tableAreas = useMemo(() => {
    const grouped = new Map<string, RTable[]>();
    for (const table of tablesQ.data ?? []) {
      const area = table.area?.trim() || "الصالة";
      grouped.set(area, [...(grouped.get(area) ?? []), table]);
    }
    return [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "ar"))
      .map(([area, tables]) => ({ area, tables: tables.sort((a, b) => a.code.localeCompare(b.code, "ar")) }));
  }, [tablesQ.data]);
  const freeCount = (tablesQ.data ?? []).filter(table => table.status === "free").length;
  const selectedTable = tablesQ.data?.find(table => table.id === openTableId);
  const deliveryBranchId =
    Number(localStorage.getItem("pos_branch_id") || 0) ||
    tablesQ.data?.[0]?.branchId ||
    null;

  async function createDelivery() {
    if (!customerName.trim() || !customerPhone.trim()) {
      setDeliveryError("أدخل اسم العميل ورقم التواصل لبدء طلب التوصيل.");
      return;
    }
    if (!deliveryBranchId) {
      setDeliveryError("تعذّر تحديد الفرع. تحقق من إعدادات نقطة البيع.");
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
        notes: deliveryNotes.trim() || undefined,
      });
      await qc.invalidateQueries({ queryKey: ["r-delivery-orders"] });
      setActiveOrder(await api.rOrder(order.id));
      setCustomerName("");
      setCustomerPhone("");
      setDeliveryNotes("");
    } catch (error: any) {
      setDeliveryError(error?.message ?? "تعذّر إنشاء طلب التوصيل.");
    } finally {
      setCreatingDelivery(false);
    }
  }

  async function resumeDelivery(orderId: number) {
    setView("delivery");
    setOpening(true);
    try {
      setActiveOrder(await api.rOrder(orderId));
    } catch (error: any) {
      setDeliveryError(error?.message ?? "تعذّر استعادة الطلب.");
    } finally {
      setOpening(false);
    }
  }

  const tableStatus = (table: RTable) => {
    switch (table.status) {
      case "free": return { label: "متاحة", style: "border-primary/25 bg-primary/[0.06] text-primary", dot: "bg-primary" };
      case "occupied": return { label: "مشغولة", style: "border-destructive/25 bg-destructive/[0.06] text-destructive", dot: "bg-destructive" };
      case "reserved": return { label: "محجوزة", style: "border-amber-500/30 bg-amber-500/[0.08] text-amber-700", dot: "bg-amber-500" };
      case "cleaning": return { label: "تنظيف", style: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground" };
    }
  };

  return (
    <div dir="rtl" className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-3 border-b border-border/80 bg-card px-3 py-2 shadow-sm sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/restaurant")} aria-label="العودة إلى المطعم" data-testid="button-waiter-back">
            <ChevronRight className="ml-1 h-4 w-4" /> رجوع
          </Button>
          <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <Utensils className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-black sm:text-base">طلبات المطعم</div>
            <div className="truncate text-xs text-muted-foreground">{user?.username ? `النادل · ${user.username}` : "الصالة والتوصيل"}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/restaurant-settings?tab=tables&returnTo=waiter")} aria-label="إعدادات الطاولات" data-testid="button-waiter-settings">
            <Settings className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => qc.invalidateQueries({ queryKey: ["r-tables"] })} aria-label="تحديث الطاولات" data-testid="button-refresh-tables">
            <RefreshCw className={`h-4 w-4 ${tablesQ.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </header>

      {!activeOrder ? (
        <main className="mx-auto w-full max-w-[1500px] flex-1 p-4 sm:p-6">
          <div className="mb-6 flex w-full max-w-xl rounded-2xl border border-border bg-card p-1.5 shadow-sm" role="tablist" aria-label="قناة الطلب">
            <button type="button" role="tab" aria-selected={view === "tables"} onClick={() => { setView("tables"); setDeliveryError(""); }}
              data-testid="button-view-dine-in" className={`flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-black transition ${view === "tables" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted"}`}>
              <Utensils className="h-4 w-4" /> الصالة والطاولات
            </button>
            <button type="button" role="tab" aria-selected={view === "delivery"} onClick={() => { setView("delivery"); setOpenTableId(null); setDeliveryError(""); }}
              data-testid="button-view-delivery" className={`flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-black transition ${view === "delivery" ? "bg-orange-600 text-white shadow-sm" : "text-muted-foreground hover:bg-muted"}`}>
              <Truck className="h-4 w-4" /> طلبات التوصيل
            </button>
          </div>
          {view === "delivery" ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
              <section className="overflow-hidden rounded-2xl border border-orange-200 bg-card shadow-sm">
                <div className="flex items-center justify-between border-b border-orange-100 bg-orange-50/80 px-5 py-4">
                  <div><p className="text-xs font-bold text-orange-700">قناة مستقلة · توصيل</p><h1 className="mt-1 text-xl font-black">طلبات التوصيل النشطة</h1></div>
                  <span className="grid size-11 place-items-center rounded-xl bg-orange-100 text-orange-700"><Truck className="h-5 w-5" /></span>
                </div>
                <div className="space-y-2 p-4">
                  {deliveryOrdersQ.isLoading ? Array.from({ length: 3 }, (_, i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />) :
                    deliveryOrdersQ.isError ? <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-5 text-sm text-destructive" role="alert">
                      تعذّر تحميل الطلبات. <Button variant="outline" size="sm" onClick={() => deliveryOrdersQ.refetch()} className="mr-2">إعادة المحاولة</Button>
                    </div> : (deliveryOrdersQ.data ?? []).length === 0 ?
                      <div className="rounded-xl border border-dashed border-border px-5 py-10 text-center">
                        <ClipboardList className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
                        <p className="font-bold">لا توجد طلبات توصيل نشطة</p><p className="mt-1 text-sm text-muted-foreground">ستظهر الطلبات هنا لتتمكن من استكمالها.</p>
                      </div> :
                      deliveryOrdersQ.data!.map(order => (
                        <button key={order.id} type="button" onClick={() => resumeDelivery(order.id)} data-testid={`button-resume-delivery-${order.id}`}
                          className="flex w-full items-center justify-between gap-3 rounded-xl border border-orange-100 bg-background p-4 text-right transition hover:border-orange-300 hover:bg-orange-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                          <span className="min-w-0"><span className="flex items-center gap-2 font-black">{order.orderNumber}<span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-800">توصيل</span></span>
                            <span className="mt-1 block truncate text-sm text-muted-foreground">{order.customerName || "عميل بدون اسم"} · {order.customerPhone || "لا يوجد رقم"}</span>
                          </span><span className="shrink-0 text-left"><span className="block font-black">{Number(order.total).toFixed(2)} ر.س</span><span className="mt-1 block text-xs text-muted-foreground">{statusLabel(order.status)}</span></span>
                        </button>
                      ))}
                </div>
              </section>
              <section className="h-fit rounded-2xl border border-border bg-card p-5 shadow-sm">
                <div className="mb-5 flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-orange-100 text-orange-700"><Plus className="h-5 w-5" /></span>
                  <div><p className="text-xs font-bold text-orange-700">طلب جديد</p><h2 className="text-lg font-black">بيانات التوصيل</h2></div></div>
                <div className="space-y-4">
                  <label className="block text-sm font-bold">اسم العميل<Input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="اسم المستلم" data-testid="input-delivery-customer-name" className="mt-1.5 h-11 rounded-xl" /></label>
                  <label className="block text-sm font-bold">رقم التواصل<div className="relative mt-1.5"><Phone className="absolute right-3 top-3.5 h-4 w-4 text-muted-foreground" /><Input value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} placeholder="05xxxxxxxx" inputMode="tel" data-testid="input-delivery-customer-phone" className="h-11 rounded-xl pr-10" /></div></label>
                  <label className="block text-sm font-bold">ملاحظات التوصيل<textarea value={deliveryNotes} onChange={e => setDeliveryNotes(e.target.value)} placeholder="العنوان أو تعليمات إضافية" data-testid="input-delivery-notes" className="mt-1.5 min-h-24 w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm font-normal outline-none transition focus-visible:ring-2 focus-visible:ring-ring" /></label>
                  {deliveryError && <p className="text-sm text-destructive" role="alert">{deliveryError}</p>}
                  <Button type="button" disabled={creatingDelivery || !deliveryBranchId} onClick={createDelivery} data-testid="button-create-delivery-order" className="h-12 w-full bg-orange-600 font-black text-white hover:bg-orange-700">
                    {creatingDelivery ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Plus className="ml-2 h-4 w-4" />} إنشاء طلب التوصيل واختيار الأصناف
                  </Button>
                </div>
              </section>
            </div>
          ) : <>
          <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary"><MapPin className="h-3.5 w-3.5" /> الصالة الآن</p>
              <h1 className="text-2xl font-black tracking-tight sm:text-3xl">اختر طاولة</h1>
              <p className="mt-1 text-sm text-muted-foreground">افتح طاولة لبدء طلب أو متابعة الطلب المفتوح.</p>
            </div>
            {!tablesQ.isLoading && (tablesQ.data ?? []).length > 0 && (
              <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs font-bold shadow-sm" data-testid="status-table-summary">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-primary"><i className="size-1.5 rounded-full bg-primary" />{freeCount} متاحة</span>
                <span className="text-muted-foreground">{(tablesQ.data?.length ?? 0) - freeCount} مستخدمة</span>
              </div>
            )}
          </div>

          {tablesQ.isLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6" role="status" aria-label="جارٍ تحميل الطاولات">
              {Array.from({ length: 8 }, (_, i) => <div key={i} className="h-32 animate-pulse rounded-2xl border border-border bg-muted/70" />)}
            </div>
          ) : tablesQ.isError ? (
            <section className="mx-auto mt-12 max-w-lg rounded-2xl border border-destructive/20 bg-card p-8 text-center shadow-sm" role="alert">
              <AlertCircle className="mx-auto mb-3 h-8 w-8 text-destructive" />
              <h2 className="font-bold">تعذّر تحميل الطاولات</h2>
              <p className="mt-1 text-sm text-muted-foreground">تحقق من الاتصال ثم حاول التحديث.</p>
              <Button onClick={() => tablesQ.refetch()} className="mt-4" data-testid="button-retry-tables"><RefreshCw className="ml-2 h-4 w-4" /> إعادة المحاولة</Button>
            </section>
          ) : (tablesQ.data ?? []).length === 0 ? (
            <section className="mx-auto mt-10 max-w-xl rounded-3xl border border-border bg-card px-6 py-12 text-center shadow-sm">
              <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-primary/10 text-primary"><Users className="h-7 w-7" /></div>
              <h2 className="text-lg font-black">لا توجد طاولات معرّفة بعد</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">أضف الطاولات من إعدادات المطعم لتبدأ استقبال الطلبات في الصالة.</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Button onClick={() => setLocation("/restaurant-settings?tab=tables&returnTo=waiter")} data-testid="btn-add-tables-cta"><Plus className="ml-2 h-4 w-4" /> إضافة طاولات</Button>
                <Button variant="outline" onClick={() => qc.invalidateQueries({ queryKey: ["r-tables"] })} data-testid="btn-refresh-tables"><RefreshCw className="ml-2 h-4 w-4" /> تحديث</Button>
              </div>
            </section>
          ) : (
            <div className="space-y-7">
              {tableAreas.map(({ area, tables }) => (
                <section key={area} aria-label={`منطقة ${area}`} data-testid={`section-table-area-${area}`}>
                  <div className="mb-3 flex items-center justify-between border-b border-border pb-2">
                    <h2 className="font-black">{area}</h2><span className="text-xs text-muted-foreground">{tables.length} طاولة</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
                    {tables.map(table => {
                      const status = tableStatus(table);
                      return (
                        <button key={table.id} type="button" onClick={() => setOpenTableId(table.id)}
                          aria-label={`فتح ${table.nameAr}، ${status.label}`}
                          data-testid={`button-table-${table.id}`}
                          className={`group min-h-32 rounded-2xl border bg-card p-3 text-right shadow-sm transition duration-150 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${status.style}`}>
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[11px] font-bold opacity-70">{table.code}</span>
                            <span className={`size-2 rounded-full ${status.dot}`} />
                          </div>
                          <div className="mt-3 truncate text-base font-black text-foreground">{table.nameAr}</div>
                          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" />{table.capacity} مقاعد</div>
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
          <section className="flex min-h-[55dvh] flex-col border-b border-border md:min-h-0 md:border-b-0 md:border-l" aria-label="قائمة الطعام">
            <div className="flex gap-2 border-b border-border bg-card p-3">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input placeholder="ابحث في القائمة..." value={search} onChange={e => setSearch(e.target.value)}
                  aria-label="البحث في قائمة الطعام" data-testid="input-menu-search"
                  className="h-11 rounded-xl bg-background pr-10" />
              </div>
              <div className="grid place-items-center rounded-xl border border-border bg-background px-1">
                <VoiceSearchButton onResult={text => {
                  setSearch(text);
                  const matches = (itemsQ.data ?? []).filter(i => i.nameAr.includes(text) || text.includes(i.nameAr));
                  if (matches.length === 1 && activeOrder) {
                    addItem.mutate({ orderId: activeOrder.id, menuItemId: matches[0].id });
                    setSearch("");
                  }
                }} />
              </div>
            </div>
            <div className="flex gap-2 overflow-x-auto border-b border-border bg-muted/40 px-3 py-2" role="tablist" aria-label="فئات قائمة الطعام">
              <button type="button" onClick={() => setActiveCat(null)} aria-pressed={activeCat == null} data-testid="button-menu-category-all"
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${activeCat == null ? "bg-primary text-primary-foreground shadow-sm" : "bg-card text-muted-foreground hover:text-foreground"}`}>الكل</button>
              {(catsQ.data ?? []).map(category => (
                <button key={category.id} type="button" onClick={() => setActiveCat(category.id)} aria-pressed={activeCat === category.id}
                  data-testid={`button-menu-category-${category.id}`}
                  className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${activeCat === category.id ? "bg-primary text-primary-foreground shadow-sm" : "bg-card text-muted-foreground hover:text-foreground"}`}>
                  {category.nameAr}
                </button>
              ))}
            </div>
            <div className="grid flex-1 auto-rows-max grid-cols-2 content-start gap-3 overflow-y-auto bg-background p-3 sm:grid-cols-3 lg:grid-cols-4">
              {itemsQ.isLoading ? Array.from({ length: 8 }, (_, i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-muted" />) :
                itemsQ.isError ? <div className="col-span-full py-10 text-center text-sm text-destructive" role="alert">تعذّر تحميل الأصناف.</div> :
                  filteredItems.length === 0 ? (
                    <div className="col-span-full py-12 text-center text-sm leading-6 text-muted-foreground" data-testid="empty-restaurant-menu">
                      {(itemsQ.data ?? []).length === 0
                        ? "قائمة المطعم فارغة. أضف الأصناف من إعدادات المطعم، أو استورد أصناف المخزون واربطها بسجلاتها."
                        : "لا توجد أصناف مطابقة. جرّب فئة أخرى أو امسح البحث."}
                    </div>
                  ) :
                    filteredItems.map(item => (
                      <button key={item.id} type="button" disabled={addItem.isPending}
                        onClick={() => addItem.mutate({ orderId: activeOrder.id, menuItemId: item.id })}
                        data-testid={`button-add-menu-item-${item.id}`} aria-label={`إضافة ${item.nameAr}`}
                        className="group min-h-28 rounded-2xl border border-border bg-card p-3 text-right shadow-sm transition hover:border-primary/40 hover:shadow-md disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        <span className="flex items-start justify-between gap-2">
                          <span className="text-sm font-bold leading-5">{item.nameAr}</span>
                          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground"><Plus className="h-4 w-4" /></span>
                        </span>
                        <span className="mt-3 block text-base font-black text-primary">{Number(item.price).toFixed(2)} <span className="text-xs font-semibold">ر.س</span></span>
                        {item.prepTimeMinutes > 0 && <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground"><Clock className="h-3 w-3" />{item.prepTimeMinutes} د</span>}
                      </button>
                    ))}
            </div>
          </section>

          <aside className="flex min-h-[70dvh] flex-col bg-card md:sticky md:top-16 md:h-[calc(100dvh-4rem)] md:min-h-0" aria-label="تفاصيل الطلب">
            <div className="border-b border-border p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                   <p className={`text-xs font-bold ${activeOrder.channel === "delivery" ? "text-orange-700" : "text-primary"}`}>{activeOrder.channel === "delivery" ? "طلب توصيل" : "طلب صالة · طاولة"}</p>
                  <h2 className="mt-1 text-lg font-black">{activeOrder.orderNumber}</h2>
                   <p className="mt-0.5 text-sm text-muted-foreground">{activeOrder.channel === "delivery" ? `${activeOrder.customerName || "عميل"} · ${activeOrder.customerPhone || "لا يوجد رقم"}` : `طاولة ${selectedTable?.nameAr ?? activeOrder.tableId}`}</p>
                </div>
                <Button variant="ghost" size="icon" aria-label="إغلاق الطلب والعودة للطاولات" data-testid="button-close-order"
                   onClick={() => { setActiveOrder(null); setOpenTableId(null); }}><X className="h-4 w-4" /></Button>
              </div>
              <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs font-bold text-muted-foreground" data-testid="status-active-order">
                <span className="size-1.5 rounded-full bg-primary" />{statusLabel(activeOrder.status)}
              </div>
            </div>
            <div className="min-h-28 flex-1 overflow-y-auto p-3">
              {opening ? (
                <div className="space-y-3" role="status" aria-label="جارٍ فتح الطلب">
                  <div className="h-16 animate-pulse rounded-xl bg-muted" /><div className="h-16 animate-pulse rounded-xl bg-muted" />
                </div>
              ) : activeOrder.items.length === 0 ? (
                <div className="flex h-full min-h-32 flex-col items-center justify-center text-center text-muted-foreground">
                  <ShoppingBag className="mb-2 h-7 w-7 opacity-50" /><p className="text-sm font-semibold">ابدأ بإضافة أصناف للطلب</p>
                </div>
              ) : activeOrder.items.map(line => (
                <div key={line.id} className="mb-2 flex items-center gap-2 rounded-xl border border-border/80 bg-background p-3" data-testid={`row-order-item-${line.id}`}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold">{line.nameSnapshot}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{Number(line.qty).toFixed(0)} × {Number(line.price).toFixed(2)}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${line.status === "served" ? "bg-primary/10 text-primary" : line.status === "ready" ? "bg-amber-100 text-amber-800" : line.status === "preparing" ? "bg-sky-100 text-sky-800" : "bg-muted text-muted-foreground"}`}>{statusLabel(line.status as any)}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-sm font-black">{Number(line.total).toFixed(2)}</div>
                  {!line.sentAt && <Button variant="ghost" size="icon" aria-label={`حذف ${line.nameSnapshot}`} data-testid={`button-remove-order-item-${line.id}`}
                    disabled={removeItem.isPending} onClick={() => removeItem.mutate({ orderId: activeOrder.id, itemId: line.id })}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>}
                </div>
              ))}
            </div>
            <div className="space-y-2 border-t border-border px-4 py-3 text-sm">
              <Row label="المجموع الفرعي" v={activeOrder.subtotal} />
              <Row label="ضريبة 15%" v={activeOrder.vatAmount} />
              <Row label="الإجمالي" v={activeOrder.total} bold />
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-border p-3">
              <Button disabled={activeOrder.items.length === 0 || sendOrder.isPending || opening} onClick={() => sendOrder.mutate(activeOrder.id)}
                data-testid="button-send-to-kitchen" className="h-11 font-bold">
                {sendOrder.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4" />} إرسال للمطبخ
              </Button>
              <Button variant="destructive" disabled={cancelOrder.isPending || opening} data-testid="button-cancel-order"
                onClick={() => { if (confirm("إلغاء الطلب نهائياً؟")) cancelOrder.mutate(activeOrder.id); }}>
                {cancelOrder.isPending ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <X className="ml-2 h-4 w-4" />} إلغاء الطلب
              </Button>
            </div>
            {(sendOrder.isError || addItem.isError || removeItem.isError || cancelOrder.isError) && (
              <p className="px-4 pb-3 text-xs text-destructive" role="alert">تعذّر تنفيذ الإجراء. حاول مرة أخرى.</p>
            )}
          </aside>
        </main>
      )}
    </div>
  );
}

function Row({ label, v, bold }: { label: string; v: string; bold?: boolean }) {
  return <div className={`flex justify-between ${bold ? "border-t border-border pt-2 text-base font-black" : "text-muted-foreground"}`}><span>{label}</span><span className={bold ? "text-foreground" : "text-foreground"}>{Number(v).toFixed(2)} ر.س</span></div>;
}
function statusLabel(s: ROrder["status"] | ROrderItem["status"]) {
  const labels: Record<string, string> = {
    draft: "مسودة", sent: "أُرسل", preparing: "قيد التحضير", ready: "جاهز",
    served: "تم التقديم", billed: "مفوتر", cancelled: "ملغى", pending: "بانتظار",
  };
  return labels[s] ?? s;
}
