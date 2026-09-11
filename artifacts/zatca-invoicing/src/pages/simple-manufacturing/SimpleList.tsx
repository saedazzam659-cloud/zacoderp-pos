import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronLeft, Play, Pause, RotateCcw, Boxes } from "lucide-react";
import { Link } from "wouter";
import type { Order, Catalog } from "./types";

function statusLabel(status: string) {
  return ({
    draft: "مسودة", approved: "معتمد", in_production: "قيد الإنتاج",
    paused: "متوقف مؤقتاً", quality_check: "فحص الجودة", completed: "مكتمل",
    cancelled: "ملغى", reversed: "معكوس",
  } as Record<string, string>)[status] ?? status;
}

function nextStatus(status: string): string | null {
  return ({
    draft: "approved", approved: "in_production", in_production: "completed",
    paused: "in_production", quality_check: "completed",
  } as Record<string, string>)[status] ?? null;
}

function formatMoney(value: unknown) {
  if (value == null) return "—";
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString() : "—";
}

export function SimpleOrderList({
  orders,
  catalog,
  busy,
  selectedOrder,
  sourceCosts,
  costDrilldown,
  canPost,
  canUnpost,
  canDelete,
  onOpenOrder,
  onCloseOrder,
  onChangeStatus,
  onDeleteDraft
}: {
  orders: Order[];
  catalog: Catalog;
  busy: boolean;
  selectedOrder: (Order & { detail?: any }) | null;
  sourceCosts: any[];
  costDrilldown: any;
  canPost: boolean;
  canUnpost: boolean;
  canDelete: boolean;
  onOpenOrder: (order: Order) => void;
  onCloseOrder: () => void;
  onChangeStatus: (order: Order, status: string) => void;
  onDeleteDraft: (order: Order) => void;
}) {
  const productName = (id: number | null) => catalog.items.find(i => i.id === id)?.nameAr || "—";
  const actualPosted = selectedOrder
    ? ["in_production", "paused", "quality_check", "completed", "reversed"].includes(selectedOrder.status) &&
      (selectedOrder.issueJournalEntryId != null || selectedOrder.receiptJournalEntryId != null)
    : false;

  return (
    <div className="space-y-4">
      {selectedOrder && (
        <Card className="border-violet-200 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 end-0 w-24 h-24 bg-gradient-to-br from-violet-500/10 to-transparent rounded-bl-full pointer-events-none" />
          <CardHeader className="flex-row items-center justify-between pb-2 border-b">
            <CardTitle className="text-xl">تفاصيل {selectedOrder.orderNumber}</CardTitle>
            <Button variant="ghost" size="sm" onClick={onCloseOrder} className="h-8">
              <ChevronLeft className="ml-1 h-4 w-4" />
              إغلاق التفاصيل
            </Button>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid gap-4 md:grid-cols-4 text-sm mb-6">
              <div className="space-y-1">
                <span className="text-muted-foreground text-xs uppercase">المنتج</span>
                <div className="font-semibold text-base">{productName(selectedOrder.productItemId)}</div>
              </div>
              <div className="space-y-1">
                <span className="text-muted-foreground text-xs uppercase">الكمية المخططة</span>
                <div className="font-semibold text-base">{selectedOrder.plannedQty}</div>
              </div>
              <div className="space-y-1">
                <span className="text-muted-foreground text-xs uppercase">التكلفة التقديرية</span>
                <div className="font-semibold text-base">{formatMoney(selectedOrder.estimatedCost)}</div>
              </div>
              <div className="space-y-1">
                <span className="text-muted-foreground text-xs uppercase">الحالة</span>
                <div><Badge className="text-sm px-2 py-0.5">{statusLabel(selectedOrder.status)}</Badge></div>
              </div>
            </div>

            <div className="flex gap-2 flex-wrap mb-6">
              {nextStatus(selectedOrder.status) && (
                <Button disabled={busy || !canPost} onClick={() => onChangeStatus(selectedOrder, nextStatus(selectedOrder.status)!)} className="bg-violet-600 hover:bg-violet-700">
                  <Play className="ml-2 h-4 w-4" />
                  {statusLabel(nextStatus(selectedOrder.status)!)}
                </Button>
              )}
              {selectedOrder.status === "in_production" && (
                <Button variant="outline" disabled={busy || !canPost} onClick={() => onChangeStatus(selectedOrder, "paused")}>
                  <Pause className="ml-2 h-4 w-4" />إيقاف مؤقت
                </Button>
              )}
              {selectedOrder.status === "completed" && (
                <Button variant="destructive" disabled={busy || !canUnpost} onClick={() => onChangeStatus(selectedOrder, "reversed")}>
                  <RotateCcw className="ml-2 h-4 w-4" />عكس وإلغاء الإنتاج
                </Button>
              )}
              {selectedOrder.status === "draft" && (
                <Button variant="destructive" disabled={busy || !canDelete} onClick={() => onDeleteDraft(selectedOrder)}>
                  حذف المسودة
                </Button>
              )}
            </div>

            {!canPost && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                لا تملك صلاحية الترحيل في التصنيع المبسط؛ أزرار تغيير الحالة معروضة لكنها غير مفعلة.
              </div>
            )}
            <div className="rounded-xl border bg-slate-50/50 p-4">
              <div className="mb-3 font-semibold text-slate-800 flex items-center gap-2">
                <div className="w-1.5 h-4 bg-violet-500 rounded-full" />
                تحليل مصادر التكلفة المحملة
              </div>
              {sourceCosts.length > 0 ? (
                <div className="space-y-2">
                  {sourceCosts.map(source => (
                    <div key={source.id} className="flex justify-between items-center bg-white border p-2 rounded-lg text-sm shadow-sm">
                      <span className="font-medium text-slate-700">{source.sourceType} #{source.sourceRecordId}</span>
                      <Badge variant="outline" className="font-bold bg-violet-50 text-violet-700 border-violet-200">
                        {Number(source.allocatedAmount).toLocaleString()}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-slate-500 text-sm border-2 border-dashed rounded-lg bg-white">
                  لا توجد توزيعات مصادر تكلفة مرفقة مع هذا الأمر
                </div>
              )}
              {selectedOrder.detail?.manualCosts?.length > 0 && (
                <div className="mt-3 space-y-2">
                  <div className="text-xs font-semibold text-amber-700">تكاليف يدوية فعلية</div>
                  {selectedOrder.detail.manualCosts.map((cost: any) => (
                    <div key={cost.category} className="flex justify-between items-center bg-amber-50 border border-amber-100 p-2 rounded-lg text-sm">
                      <span>{cost.description || cost.category} <span className="text-xs text-slate-500">• حساب #{cost.counterpartAccountId}</span></span>
                      <Badge variant="outline" className="font-bold text-amber-700">{formatMoney(cost.amount)}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-4 rounded-xl border bg-white p-4">
              <div className="mb-3 font-semibold text-slate-800 flex items-center gap-2">
                <div className="w-1.5 h-4 bg-emerald-500 rounded-full" />
                أثر المواد وتكلفة التصنيع
              </div>
              {selectedOrder.detail?.items?.length ? (
                <div className="divide-y rounded-lg border">
                  {selectedOrder.detail.items.map((item: any) => (
                    <div key={item.id} className="p-3 flex flex-wrap justify-between gap-2 text-sm">
                      <span className="font-medium text-slate-700">{item.description || `صنف #${item.itemId}`}</span>
                      <span className="text-slate-600">
                        {Number(item.quantity || 0).toLocaleString()} {item.unitCode || ""}
                        {item.totalCost != null && ` • ${Number(item.totalCost).toLocaleString()}`}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-slate-500">لا توجد حركات مواد محفوظة لهذا الأمر.</div>
              )}
               <div className="mt-3 grid gap-2 sm:grid-cols-3 text-sm border-t pt-3">
                 <div><span className="text-slate-500 block">إجمالي المواد</span><b>{formatMoney(
                   selectedOrder.detail?.items?.length &&
                   selectedOrder.detail.items.every((item: any) => item.totalCost != null)
                     ? selectedOrder.detail.items.reduce((sum: number, item: any) => sum + Number(item.totalCost), 0)
                     : null,
                 )}</b></div>
                 <div><span className="text-slate-500 block">توزيع التصنيع</span><b>{formatMoney(
                   sourceCosts.length
                     ? sourceCosts.reduce((sum: number, source: any) => sum + Number(source.allocatedAmount), 0)
                     : null,
                 )}</b></div>
                 <div><span className="text-slate-500 block">إجمالي الأمر الفعلي</span><b>{actualPosted ? formatMoney(selectedOrder.actualCost) : "لم يُرحّل بعد"}</b></div>
              </div>
            </div>
            {actualPosted && costDrilldown?.totals && costDrilldown.totals.actual != null && (
              <div className="mt-4 rounded-xl border bg-white p-4">
                <div className="mb-3 font-semibold text-slate-800">ملخص إجمالي تكلفة الأمر</div>
                <div className="grid gap-2 sm:grid-cols-5 text-sm">
                  {(() => {
                    const materials = Array.isArray(costDrilldown.trace?.materials) ? costDrilldown.trace.materials : [];
                    const materialTotal = materials.length > 0 &&
                      materials.every((line: any) => line?.amount != null && Number.isFinite(Number(line.amount)))
                      ? materials.reduce((sum: number, line: any) => sum + Number(line.amount), 0)
                      : null;
                    const manufacturingTotal = materialTotal == null ? null
                      : Math.max(0, Number(costDrilldown.totals.actual) - materialTotal);
                    return (
                      <>
                        <div><span className="text-slate-500 block">المواد</span><b>{formatMoney(materialTotal)}</b></div>
                        <div><span className="text-slate-500 block">توزيع التصنيع</span><b>{formatMoney(manufacturingTotal)}</b></div>
                      </>
                    );
                  })()}
                  <div><span className="text-slate-500 block">تكلفة الوحدة</span><b>{formatMoney(costDrilldown.totals.unitCost)}</b></div>
                      <div><span className="text-slate-500 block">الإضافي الفعلي</span><b>{formatMoney(costDrilldown.totals.additionalActual)}</b></div>
                      <div><span className="text-slate-500 block">الإضافي / وحدة</span><b>{formatMoney(costDrilldown.totals.additionalUnitCost)}</b></div>
                  <div><span className="text-slate-500 block">الانحراف</span><b>{formatMoney(costDrilldown.totals.variance)}</b></div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="border-b bg-slate-50/50 pb-4">
          <CardTitle className="text-lg flex items-center gap-2">
            <Boxes className="h-5 w-5 text-violet-600" />
            سجل أوامر التصنيع
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-slate-50 text-slate-500 text-right">
                  <th className="px-4 py-3 font-medium">رقم الأمر</th>
                  <th className="px-4 py-3 font-medium">المنتج</th>
                  <th className="px-4 py-3 font-medium">الكمية</th>
                  <th className="px-4 py-3 font-medium">الحالة</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {orders.map(order => (
                  <tr key={order.id} className="border-b hover:bg-slate-50/80 transition-colors">
                    <td className="px-4 py-3 font-semibold text-violet-700">{order.orderNumber}</td>
                    <td className="px-4 py-3 font-medium">{productName(order.productItemId)}</td>
                    <td className="px-4 py-3">{order.plannedQty}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="bg-white">{statusLabel(order.status)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-left flex gap-2 justify-end">
                      <Button size="sm" variant="outline" onClick={() => onOpenOrder(order)} className="bg-white">
                        التفاصيل
                      </Button>
                      <Link href={`/simple-manufacturing/orders/${order.id}`}>
                        <Button size="sm" variant="secondary" className="bg-slate-100 hover:bg-slate-200">
                          دورة الحياة
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!orders.length && (
              <div className="py-16 text-center">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 mb-3 text-slate-400">
                  <Boxes className="h-6 w-6" />
                </div>
                <h3 className="text-sm font-medium text-slate-900 mb-1">لا توجد أوامر بعد</h3>
                <p className="text-sm text-slate-500">قم بإنشاء أمر تصنيع جديد للبدء.</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
