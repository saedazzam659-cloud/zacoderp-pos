import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { X, Loader2, Receipt, Banknote, CreditCard, Smartphone, Wallet, ChefHat, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  api,
  getPosSessionId,
  type ROrder, type ROrderItem,
  type CreateInvoiceLine, type CreateInvoiceBody,
} from "@/lib/api";

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
      const lines: CreateInvoiceLine[] = selected.items
        .filter(li => li.status !== "cancelled")
        .map(li => {
          const qty = Number(li.qty);
          const price = Number(li.price);
          const lineSub = qty * price;
          const lineVat = lineSub * 0.15;
          return {
            // Use 0 as itemId — server may accept null but type needs number;
            // server will store name only. If your sales schema requires
            // an itemId, link menuItem to an inventory item via posMenuItem.itemId.
            itemId: 0,
            itemName: li.nameSnapshot,
            qty,
            unitPrice: price,
            discount: 0,
            vatRate: 15,
            lineTotal: lineSub + lineVat,
            warehouseId: defaultWarehouseId ?? undefined,
          };
        });
      const subtotal = Number(selected.subtotal);
      const vatAmount = Number(selected.vatAmount);
      const totalAmount = Number(selected.total);

      const body: CreateInvoiceBody = {
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
        priceIncludesVat: false,
        notes: `طلب مطعم ${selected.orderNumber} — ${methodLabel(method)}`,
        lines,
        posSessionId: getPosSessionId(),
      };
      const inv = await api.createSalesInvoice(body);
      try { await api.postSalesInvoice(inv.id); } catch {}
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
            <div className="font-bold text-lg">طلبات الصالة المفتوحة</div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-2 min-h-0">
          {/* Left: list */}
          <div className="border-l border-border overflow-y-auto p-3 space-y-2">
            {ordersQ.isLoading ? (
              <Loader2 className="animate-spin mx-auto mt-8" />
            ) : (ordersQ.data ?? []).length === 0 ? (
              <div className="text-center text-muted-foreground py-12 text-sm">
                لا توجد طلبات مفتوحة من النادل حالياً
              </div>
            ) : ordersQ.data!.map(o => {
              const ago = Math.floor((Date.now() - new Date(o.openedAt).getTime()) / 60000);
              const active = selected?.id === o.id;
              return (
                <button
                  key={o.id}
                  onClick={() => loadFull.mutate(o.id)}
                  className={`w-full text-right p-3 rounded-xl border transition ${
                    active ? "border-amber-500 bg-amber-500/10" : "border-border bg-card hover-elevate"
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-bold">{o.orderNumber}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {channelLabel(o.channel)} • {statusLabel(o.status)}
                      </div>
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
                    {selected.items.length} صنف • {channelLabel(selected.channel)}
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
                      <div className="font-bold text-amber-600">{Number(li.total).toFixed(2)}</div>
                    </div>
                  ))}
                </div>
                <div className="p-3 border-t border-border space-y-1 text-sm">
                  <Row label="المجموع الفرعي" v={selected.subtotal} />
                  <Row label="ضريبة 15%" v={selected.vatAmount} />
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

function statusLabel(s: ROrder["status"]) {
  const m: Record<string, string> = {
    draft: "مسودة", sent: "أُرسل", preparing: "قيد التحضير", ready: "جاهز",
    served: "تم التقديم", billed: "مفوتر", cancelled: "ملغى",
  };
  return m[s] ?? s;
}
function channelLabel(c: ROrder["channel"]) {
  return c === "dine_in" ? "صالة" : c === "takeaway" ? "سفري" : "توصيل";
}
function methodLabel(m: string) {
  return m === "cash" ? "نقداً" : m === "card" ? "شبكة" : m === "apple" ? "Apple Pay" : "محفظة";
}
