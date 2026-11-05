import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { X, Loader2, Receipt, Banknote, CreditCard, Smartphone, Wallet, ChefHat, Clock, Truck, Utensils, Phone, RefreshCw, Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  api,
  getPosSessionId,
  type ROrder, type ROrderItem,
  type CreateInvoiceBody,
} from "@/lib/api";
import { buildRestaurantInvoicePricing } from "@/lib/restaurant-pricing";
import { tr, usePosLanguage } from "@/lib/posLanguage";

type Props = {
  open: boolean;
  onClose: () => void;
  branchId: number | null;
  cashCashBoxId: number | null;
  cardBankAccountId: number | null;
  defaultWarehouseId: number | null;
  onBilled?: (invoiceId: number) => void;
};

type FullOrder = ROrder & { items: ROrderItem[] };

export default function RestaurantOrdersDialog({
  open, onClose, branchId, cashCashBoxId, cardBankAccountId, defaultWarehouseId, onBilled,
}: Props) {
  const { language, setLanguage } = usePosLanguage();
  const text = (ar: string, en: string) => tr(language, ar, en);
  const [selected, setSelected] = useState<FullOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: number; method: string } | null>(null);
  const [channelFilter, setChannelFilter] = useState<"all" | "dine_in" | "delivery">("all");

  const ordersQ = useQuery({
    queryKey: ["r-cashier-orders"],
    queryFn: async () => {
      // Show ready/served orders + sent/preparing for situational awareness
      const all = await api.rOrders();
      return all.filter(o => ["sent", "preparing", "ready", "served"].includes(o.status));
    },
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });
  const tablesQ = useQuery({
    queryKey: ["r-tables"],
    queryFn: () => api.rTables(),
    enabled: open,
    refetchInterval: open ? 10000 : false,
  });
  const visibleOrders = useMemo(() => (ordersQ.data ?? []).filter(order =>
    channelFilter === "all" || order.channel === channelFilter), [ordersQ.data, channelFilter]);
  const tableName = (tableId?: number | null) => {
    const table = tablesQ.data?.find(entry => entry.id === tableId);
    return table ? `${table.nameAr} · ${table.code}` : tableId
      ? `${text("طاولة", "Table")} ${tableId}`
      : text("طاولة غير محددة", "Unassigned table");
  };

  useEffect(() => {
    if (!open) { setSelected(null); setError(null); setDone(null); }
  }, [open]);

  const loadFull = useMutation({
    mutationFn: (id: number) => api.rOrder(id),
    onSuccess: (full) => setSelected(full),
    onError: (e: any) => setError(e?.message ?? text("تعذر تحميل الطلب", "Could not load the order")),
  });

  async function bill(method: "cash" | "card" | "apple" | "wallet") {
    if (!selected) return;
    setSubmitting(true); setError(null);
    try {
      const activeItems = selected.items.filter(li => li.status !== "cancelled");
      if (activeItems.length === 0) throw new Error(text("لا توجد أصناف قابلة للفوترة في هذا الطلب", "This order has no billable items"));
      if (activeItems.some(li => !li.erpItemId || !["stock", "service"].includes(li.erpItemType ?? ""))) {
        throw new Error(text("اربط كل صنف مطعم بصنف مخزون أو خدمة من إعدادات المطعم قبل الفوترة", "Link each restaurant item to an inventory item or service in restaurant settings before billing"));
      }
      if (activeItems.some(li => li.erpItemType === "stock") && !defaultWarehouseId) {
        throw new Error(text("حدد مخزناً افتراضياً قبل فوترة أصناف مرتبطة بالمخزون", "Set a default warehouse before billing inventory-linked items"));
      }

      const { lines, subtotal, vatAmount, totalAmount } =
        buildRestaurantInvoicePricing(activeItems, defaultWarehouseId);

      const orderContext = selected.channel === "dine_in"
          ? `${text("الصالة", "Dine-in")} - ${tableName(selected.tableId)}`
        : selected.channel === "delivery"
          ? `${text("توصيل", "Delivery")} - ${selected.customerName || text("عميل", "Customer")}`
          : text("سفري", "Takeaway");
      const body: CreateInvoiceBody = {
        clientRequestId: `restaurant-order-${selected.id}`,
        invoiceDate: new Date().toISOString().slice(0, 10),
        branchId: branchId ?? null,
        paymentType: method === "cash" ? "cash" : "bank",
        cashBoxId: method === "cash" ? cashCashBoxId : null,
        bankAccountId: method !== "cash" ? cardBankAccountId : null,
        currencyCode: "SAR",
        subtotal,
        vatAmount,
        discountAmount: 0,
        totalAmount,
        priceIncludesVat: true,
        notes: `${text("طلب مطعم", "Restaurant order")} ${selected.orderNumber} — ${orderContext} — ${methodLabel(method, language)}`,
        lines,
        posSessionId: getPosSessionId(),
      };
      let inv = await api.createSalesInvoice(body);
      if (
        inv.status !== "posted" &&
        inv.subtotal != null &&
        inv.vatAmount != null &&
        (
          Math.abs(Number(inv.subtotal) - subtotal) > 0.01 ||
          Math.abs(Number(inv.vatAmount) - vatAmount) > 0.01 ||
          Math.abs(Number(inv.totalAmount) - totalAmount) > 0.01
        )
      ) {
        throw new Error(text("توجد مسودة قديمة للطلب بإجماليات ضريبية مختلفة. راجعها قبل المتابعة حتى لا تُرحّل مبالغ غير مطابقة.", "An older draft has different tax totals. Review it before continuing to avoid posting mismatched amounts."));
      }
      if (inv.status !== "posted" && inv.paymentType && inv.paymentType !== body.paymentType) {
        throw new Error(text("توجد مسودة فاتورة لهذا الطلب بطريقة دفع مختلفة؛ استخدم الطريقة نفسها أو راجع المسودة قبل المتابعة", "An invoice draft for this order uses a different payment method. Use the same method or review the draft."));
      }
      if (inv.status !== "posted") inv = await api.postSalesInvoice(inv.id);
      if (inv.status !== "posted") {
        throw new Error(text("لم يتم ترحيل الفاتورة؛ ظل الطلب مفتوحاً ويمكن إعادة المحاولة", "The invoice was not posted. The order remains open and can be retried."));
      }
      await api.rBillOrder(selected.id, { salesInvoiceId: inv.id });
      setDone({ id: inv.id, method: methodLabel(method, language) });
      onBilled?.(inv.id);
      ordersQ.refetch();
    } catch (e: any) {
      setError(e?.message ?? text("تعذر إصدار الفاتورة", "Could not issue the invoice"));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div dir={language === "ar" ? "rtl" : "ltr"} className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <ChefHat className="text-amber-500" />
            <div><div className="font-bold text-lg">{text("فواتير طلبات المطعم", "Restaurant order billing")}</div><div className="text-xs text-muted-foreground">{text("الصالة والتوصيل في مسارين واضحين", "Dine-in and delivery are shown separately")}</div></div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setLanguage(language === "ar" ? "en" : "ar")} aria-label={text("التبديل إلى الإنجليزية", "Switch to Arabic")} data-testid="button-restaurant-orders-language"><Languages className="h-4 w-4" />{language === "ar" ? "EN" : "AR"}</Button>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label={text("إغلاق", "Close")}><X className="h-4 w-4" /></Button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-2 min-h-0">
          {/* Left: list */}
          <div className="border-s border-border overflow-y-auto p-3">
            <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label={text("تصفية قناة الطلب", "Filter order channel")}>
              {([
                ["all", text("الكل", "All")],
                ["dine_in", text("الصالة", "Dine-in")],
                ["delivery", text("التوصيل", "Delivery")],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" role="tab" aria-selected={channelFilter === value}
                  onClick={() => setChannelFilter(value)} data-testid={`button-order-channel-${value}`}
                  className={`rounded-lg px-2 py-2 text-xs font-bold transition ${channelFilter === value ? (value === "delivery" ? "bg-orange-600 text-white shadow-sm" : value === "dine_in" ? "bg-primary text-primary-foreground shadow-sm" : "bg-card text-foreground shadow-sm") : "text-muted-foreground hover:text-foreground"}`}>
                  {label}
                </button>
              ))}
            </div>
            {ordersQ.isLoading ? (
              <div className="space-y-2" role="status" aria-label={text("تحميل الطلبات", "Loading orders")}>{[1, 2, 3].map(i => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)}</div>
            ) : ordersQ.isError ? (
              <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-center text-sm text-destructive" role="alert">
                {text("تعذّر تحميل الطلبات", "Could not load orders")} <Button size="sm" variant="outline" className="mt-3" onClick={() => ordersQ.refetch()}><RefreshCw className="ms-1 h-3.5 w-3.5" /> {text("إعادة المحاولة", "Try again")}</Button>
              </div>
            ) : visibleOrders.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
                {channelFilter === "all" ? text("لا توجد طلبات مطعم مفتوحة حالياً", "No open restaurant orders") : channelFilter === "delivery" ? text("لا توجد طلبات توصيل جاهزة للفوترة", "No delivery orders ready for billing") : text("لا توجد طلبات صالة جاهزة للفوترة", "No dine-in orders ready for billing")}
              </div>
            ) : visibleOrders.map(o => {
              const ago = Math.floor((Date.now() - new Date(o.openedAt).getTime()) / 60000);
              const active = selected?.id === o.id;
              const delivery = o.channel === "delivery";
              const dineIn = o.channel === "dine_in";
              return (
                <button
                  key={o.id}
                  onClick={() => loadFull.mutate(o.id)}
                  data-testid={`button-select-restaurant-order-${o.id}`}
                  className={`mb-2 w-full text-start p-3 rounded-xl border transition ${
                    active ? (delivery ? "border-orange-500 bg-orange-50" : "border-primary bg-primary/5") : delivery ? "border-orange-100 bg-orange-50/30 hover:border-orange-300" : "border-border bg-card hover-elevate"
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2 font-bold">{o.orderNumber}<span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold ${delivery ? "bg-orange-100 text-orange-800" : "bg-primary/10 text-primary"}`}>{delivery ? <Truck className="h-3 w-3" /> : <Utensils className="h-3 w-3" />}{channelLabel(o.channel, language)}</span></div>
                      <div className="mt-1 text-xs font-semibold text-foreground">{delivery ? (o.customerName || text("عميل بدون اسم", "Unnamed customer")) : dineIn ? tableName(o.tableId) : text("طلب سفري", "Takeaway order")}</div>
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">{delivery ? <><Phone className="h-3 w-3" />{o.customerPhone || text("لا يوجد رقم", "No phone")}</> : dineIn ? `${o.guestCount || 0} ${text("ضيوف", "guests")}` : text("استلام من المطعم", "Restaurant pickup")} · {statusLabel(o.status, language)}</div>
                    </div>
                    <div className="text-end">
                      <div className="text-amber-600 font-bold">{new Intl.NumberFormat(language === "ar" ? "ar-SA" : "en-US", { minimumFractionDigits: 2 }).format(Number(o.total))} {text("ر.س", "SAR")}</div>
                      <div className="text-[11px] text-muted-foreground flex items-center justify-end gap-1 mt-1">
                        <Clock className="h-3 w-3" /> {ago} {text("د", "min")}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right: detail + bill */}
          <div className="flex flex-col overflow-hidden">
            {!selected ? (
                <div className="flex-1 grid place-items-center text-muted-foreground text-sm p-6">
                {text("اختر طلباً من القائمة لمعاينة وإصدار الفاتورة", "Select an order to review and bill")}
              </div>
            ) : done ? (
              <div className="flex-1 grid place-items-center p-6">
                <div className="text-center">
                  <Receipt className="mx-auto h-12 w-12 text-emerald-500 mb-2" />
                  <div className="font-bold text-lg">{text("تم إصدار الفاتورة", "Invoice issued")} #{done.id}</div>
                  <div className="text-sm text-muted-foreground mt-1">{text("طريقة الدفع:", "Payment method:")} {done.method}</div>
                  <Button className="mt-4" onClick={() => { setSelected(null); setDone(null); }}>
                    {text("التالي", "Next")}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="p-3 border-b border-border">
                  <div className="font-bold">{selected.orderNumber}</div>
                  <div className="text-xs text-muted-foreground">
                    <span className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-1 font-bold ${selected.channel === "delivery" ? "bg-orange-100 text-orange-800" : "bg-primary/10 text-primary"}`}>
                      {selected.channel === "delivery" ? <Truck className="h-3 w-3" /> : <Utensils className="h-3 w-3" />}
                      {selected.channel === "delivery" ? text("طلب توصيل", "Delivery order") : selected.channel === "dine_in" ? `${text("طلب صالة", "Dine-in order")} · ${tableName(selected.tableId)}` : text("طلب سفري", "Takeaway order")}
                    </span>
                    {selected.channel === "delivery" && <div className="mt-1 text-xs text-muted-foreground">{selected.customerName || text("عميل", "Customer")} · {selected.customerPhone || text("لا يوجد رقم", "No phone")}</div>}
                    <div className="mt-1 text-xs text-muted-foreground">{selected.items.length} {text("صنف", "items")}</div>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                  {selected.items.map(li => (
                    <div key={li.id} className={`flex justify-between p-2 mb-1 rounded ${
                      li.status === "cancelled" ? "opacity-40 line-through" : "bg-muted/40"
                    }`}>
                      <div className="flex-1">
                        <div className="text-sm font-semibold">{li.nameSnapshot}</div>
                        <div className="text-xs text-muted-foreground">
                          {Number(li.qty).toFixed(0)} × {Number(li.price).toFixed(2)}
                        </div>
                      </div>
                  <div className="font-bold text-amber-600">{lineGross(li).toFixed(2)}</div>
                    </div>
                  ))}
                </div>
                <div className="p-3 border-t border-border space-y-1 text-sm">
              <Row label={text("المجموع الفرعي", "Subtotal")} v={selected.subtotal} language={language} />
              <Row label={text("ضريبة القيمة المضافة", "VAT")} v={selected.vatAmount} language={language} />
              <Row label={text("الإجمالي", "Total")} v={selected.total} language={language} bold />
                </div>
                {error && (
                  <div className="px-3 pb-2 text-xs text-rose-600">{error}</div>
                )}
                <div className="grid grid-cols-2 gap-2 p-3 border-t border-border bg-muted/30">
                  <Button disabled={submitting} onClick={() => bill("cash")} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                    <Banknote className="h-4 w-4 me-1" /> {text("نقداً", "Cash")}
                  </Button>
                  <Button disabled={submitting} onClick={() => bill("card")} className="bg-blue-600 hover:bg-blue-700 text-white">
                    <CreditCard className="h-4 w-4 me-1" /> {text("شبكة", "Card")}
                  </Button>
                  <Button disabled={submitting} onClick={() => bill("apple")} variant="outline">
                    <Smartphone className="h-4 w-4 me-1" /> Apple Pay
                  </Button>
                  <Button disabled={submitting} onClick={() => bill("wallet")} variant="outline">
                    <Wallet className="h-4 w-4 me-1" /> {text("محفظة", "Wallet")}
                  </Button>
                  {submitting && (
                    <div className="col-span-2 text-center text-xs text-muted-foreground">
                      <Loader2 className="inline h-3 w-3 animate-spin me-1" /> {text("جاري الإصدار...", "Issuing...")}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, v, bold, language }: { label: string; v: string; bold?: boolean; language: "ar" | "en" }) {
  const amount = new Intl.NumberFormat(language === "ar" ? "ar-SA" : "en-US", { minimumFractionDigits: 2 }).format(Number(v) || 0);
  return (
    <div className={`flex justify-between ${bold ? "font-bold text-base" : ""}`}>
      <span>{label}</span>
      <span>{amount} {language === "ar" ? "ر.س" : "SAR"}</span>
    </div>
  );
}

function lineGross(line: ROrderItem): number {
  const amount = Number(line.qty) * Number(line.price);
  const configuredRate = line.erpVatRate == null ? Number.NaN : Number(line.erpVatRate);
  const rate = Number.isFinite(configuredRate) && configuredRate >= 0 ? configuredRate : 15;
  return line.vatIncluded === false ? amount * (1 + rate / 100) : amount;
}

function statusLabel(s: ROrder["status"], language: "ar" | "en") {
  const m: Record<string, string> = language === "ar" ? {
    draft: "مسودة", sent: "أُرسل", preparing: "قيد التحضير", ready: "جاهز",
    served: "تم التقديم", billed: "مفوتر", cancelled: "ملغى",
  } : {
    draft: "Draft", sent: "Sent", preparing: "Preparing", ready: "Ready",
    served: "Served", billed: "Billed", cancelled: "Cancelled",
  };
  return m[s] ?? s;
}
function channelLabel(c: ROrder["channel"], language: "ar" | "en") {
  return c === "dine_in"
    ? tr(language, "الصالة", "Dine-in")
    : c === "takeaway"
      ? tr(language, "سفري", "Takeaway")
      : tr(language, "توصيل", "Delivery");
}
function methodLabel(m: string, language: "ar" | "en") {
  return m === "cash" ? tr(language, "نقداً", "Cash")
    : m === "card" ? tr(language, "شبكة", "Card")
      : m === "apple" ? "Apple Pay" : tr(language, "محفظة", "Wallet");
}
