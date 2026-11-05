import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { X, Loader2, Receipt, Banknote, CreditCard, Smartphone, Wallet, ChefHat, Clock, Truck, Utensils, Phone, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  api,
  getPosSessionId,
  type ROrder, type ROrderItem,
  type CreateInvoiceBody,
} from "@/lib/api";
import { buildRestaurantInvoicePricing } from "@/lib/restaurant-pricing";

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
    return table ? `${table.nameAr} · ${table.code}` : tableId ? `طاولة ${tableId}` : "طاولة غير محددة";
  };

  useEffect(() => {
    if (!open) { setSelected(null); setError(null); setDone(null); }
  }, [open]);

  const loadFull = useMutation({
    mutationFn: (id: number) => api.rOrder(id),
    onSuccess: (full) => setSelected(full),
    onError: (e: any) => setError(e?.message ?? "تعذر تحميل الطلب"),
  });

  async function bill(method: "cash" | "card" | "apple" | "wallet") {
    if (!selected) return;
    setSubmitting(true); setError(null);
    try {
      const activeItems = selected.items.filter(li => li.status !== "cancelled");
      if (activeItems.length === 0) throw new Error("لا توجد أصناف قابلة للفوترة في هذا الطلب");
      if (activeItems.some(li => !li.erpItemId || !["stock", "service"].includes(li.erpItemType ?? ""))) {
        throw new Error("اربط كل صنف مطعم بصنف مخزون أو خدمة من إعدادات المطعم قبل الفوترة");
      }
      if (activeItems.some(li => li.erpItemType === "stock") && !defaultWarehouseId) {
        throw new Error("حدد مخزناً افتراضياً قبل فوترة أصناف مرتبطة بالمخزون");
      }

      const { lines, subtotal, vatAmount, totalAmount } =
        buildRestaurantInvoicePricing(activeItems, defaultWarehouseId);

      const orderContext = selected.channel === "dine_in"
        ? `الصالة - ${tableName(selected.tableId)}`
        : selected.channel === "delivery"
          ? `توصيل - ${selected.customerName || "عميل"}`
          : "سفري";
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
        notes: `طلب مطعم ${selected.orderNumber} — ${orderContext} — ${methodLabel(method)}`,
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
        throw new Error("توجد مسودة قديمة للطلب بإجماليات ضريبية مختلفة. راجعها قبل المتابعة حتى لا تُرحّل مبالغ غير مطابقة.");
      }
      if (inv.status !== "posted" && inv.paymentType && inv.paymentType !== body.paymentType) {
        throw new Error("توجد مسودة فاتورة لهذا الطلب بطريقة دفع مختلفة؛ استخدم الطريقة نفسها أو راجع المسودة قبل المتابعة");
      }
      if (inv.status !== "posted") inv = await api.postSalesInvoice(inv.id);
      if (inv.status !== "posted") {
        throw new Error("لم يتم ترحيل الفاتورة؛ ظل الطلب مفتوحاً ويمكن إعادة المحاولة");
      }
      await api.rBillOrder(selected.id, { salesInvoiceId: inv.id });
      setDone({ id: inv.id, method: methodLabel(method) });
      onBilled?.(inv.id);
      ordersQ.refetch();
    } catch (e: any) {
      setError(e?.message ?? "تعذر إصدار الفاتورة");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div dir="rtl" className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <ChefHat className="text-amber-500" />
            <div><div className="font-bold text-lg">فواتير طلبات المطعم</div><div className="text-xs text-muted-foreground">الصالة والتوصيل في مسارين واضحين</div></div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-2 min-h-0">
          {/* Left: list */}
          <div className="border-l border-border overflow-y-auto p-3">
            <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label="تصفية قناة الطلب">
              {([
                ["all", "الكل"],
                ["dine_in", "الصالة"],
                ["delivery", "التوصيل"],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" role="tab" aria-selected={channelFilter === value}
                  onClick={() => setChannelFilter(value)} data-testid={`button-order-channel-${value}`}
                  className={`rounded-lg px-2 py-2 text-xs font-bold transition ${channelFilter === value ? (value === "delivery" ? "bg-orange-600 text-white shadow-sm" : value === "dine_in" ? "bg-primary text-primary-foreground shadow-sm" : "bg-card text-foreground shadow-sm") : "text-muted-foreground hover:text-foreground"}`}>
                  {label}
                </button>
              ))}
            </div>
            {ordersQ.isLoading ? (
              <div className="space-y-2" role="status" aria-label="تحميل الطلبات">{[1, 2, 3].map(i => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)}</div>
            ) : ordersQ.isError ? (
              <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-center text-sm text-destructive" role="alert">
                تعذّر تحميل الطلبات <Button size="sm" variant="outline" className="mt-3" onClick={() => ordersQ.refetch()}><RefreshCw className="ml-1 h-3.5 w-3.5" /> إعادة المحاولة</Button>
              </div>
            ) : visibleOrders.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
                {channelFilter === "all" ? "لا توجد طلبات مطعم مفتوحة حالياً" : channelFilter === "delivery" ? "لا توجد طلبات توصيل جاهزة للفوترة" : "لا توجد طلبات صالة جاهزة للفوترة"}
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
                  className={`mb-2 w-full text-right p-3 rounded-xl border transition ${
                    active ? (delivery ? "border-orange-500 bg-orange-50" : "border-primary bg-primary/5") : delivery ? "border-orange-100 bg-orange-50/30 hover:border-orange-300" : "border-border bg-card hover-elevate"
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2 font-bold">{o.orderNumber}<span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold ${delivery ? "bg-orange-100 text-orange-800" : "bg-primary/10 text-primary"}`}>{delivery ? <Truck className="h-3 w-3" /> : <Utensils className="h-3 w-3" />}{channelLabel(o.channel)}</span></div>
                      <div className="mt-1 text-xs font-semibold text-foreground">{delivery ? (o.customerName || "عميل بدون اسم") : dineIn ? tableName(o.tableId) : "طلب سفري"}</div>
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">{delivery ? <><Phone className="h-3 w-3" />{o.customerPhone || "لا يوجد رقم"}</> : dineIn ? `${o.guestCount || 0} ضيوف` : "استلام من المطعم"} · {statusLabel(o.status)}</div>
                    </div>
                    <div className="text-left">
                      <div className="text-amber-600 font-bold">{Number(o.total).toFixed(2)}</div>
                      <div className="text-[11px] text-muted-foreground flex items-center justify-end gap-1 mt-1">
                        <Clock className="h-3 w-3" /> {ago} د
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
                اختر طلباً من القائمة لمعاينة وإصدار الفاتورة
              </div>
            ) : done ? (
              <div className="flex-1 grid place-items-center p-6">
                <div className="text-center">
                  <Receipt className="mx-auto h-12 w-12 text-emerald-500 mb-2" />
                  <div className="font-bold text-lg">تم إصدار الفاتورة #{done.id}</div>
                  <div className="text-sm text-muted-foreground mt-1">طريقة الدفع: {done.method}</div>
                  <Button className="mt-4" onClick={() => { setSelected(null); setDone(null); }}>
                    التالي
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
                      {selected.channel === "delivery" ? "طلب توصيل" : selected.channel === "dine_in" ? `طلب صالة · ${tableName(selected.tableId)}` : "طلب سفري"}
                    </span>
                    {selected.channel === "delivery" && <div className="mt-1 text-xs text-muted-foreground">{selected.customerName || "عميل"} · {selected.customerPhone || "لا يوجد رقم"}</div>}
                    <div className="mt-1 text-xs text-muted-foreground">{selected.items.length} صنف</div>
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
                  <Row label="المجموع الفرعي" v={selected.subtotal} />
                  <Row label="ضريبة القيمة المضافة" v={selected.vatAmount} />
                  <Row label="الإجمالي" v={selected.total} bold />
                </div>
                {error && (
                  <div className="px-3 pb-2 text-xs text-rose-600">{error}</div>
                )}
                <div className="grid grid-cols-2 gap-2 p-3 border-t border-border bg-muted/30">
                  <Button disabled={submitting} onClick={() => bill("cash")} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                    <Banknote className="h-4 w-4 ml-1" /> نقداً
                  </Button>
                  <Button disabled={submitting} onClick={() => bill("card")} className="bg-blue-600 hover:bg-blue-700 text-white">
                    <CreditCard className="h-4 w-4 ml-1" /> شبكة
                  </Button>
                  <Button disabled={submitting} onClick={() => bill("apple")} variant="outline">
                    <Smartphone className="h-4 w-4 ml-1" /> Apple Pay
                  </Button>
                  <Button disabled={submitting} onClick={() => bill("wallet")} variant="outline">
                    <Wallet className="h-4 w-4 ml-1" /> محفظة
                  </Button>
                  {submitting && (
                    <div className="col-span-2 text-center text-xs text-muted-foreground">
                      <Loader2 className="inline h-3 w-3 animate-spin ml-1" /> جاري الإصدار...
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

function Row({ label, v, bold }: { label: string; v: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-bold text-base" : ""}`}>
      <span>{label}</span>
      <span>{Number(v).toFixed(2)} ر.س</span>
    </div>
  );
}

function lineGross(line: ROrderItem): number {
  const amount = Number(line.qty) * Number(line.price);
  const configuredRate = line.erpVatRate == null ? Number.NaN : Number(line.erpVatRate);
  const rate = Number.isFinite(configuredRate) && configuredRate >= 0 ? configuredRate : 15;
  return line.vatIncluded === false ? amount * (1 + rate / 100) : amount;
}

function statusLabel(s: ROrder["status"]) {
  const m: Record<string, string> = {
    draft: "مسودة", sent: "أُرسل", preparing: "قيد التحضير", ready: "جاهز",
    served: "تم التقديم", billed: "مفوتر", cancelled: "ملغى",
  };
  return m[s] ?? s;
}
function channelLabel(c: ROrder["channel"]) {
  return c === "dine_in" ? "الصالة" : c === "takeaway" ? "سفري" : "توصيل";
}
function methodLabel(m: string) {
  return m === "cash" ? "نقداً" : m === "card" ? "شبكة" : m === "apple" ? "Apple Pay" : "محفظة";
}
