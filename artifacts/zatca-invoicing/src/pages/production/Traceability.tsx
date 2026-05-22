import { useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";

const API = import.meta.env.VITE_API_URL || "";
import { GitBranch, PackageSearch, AlertTriangle, Loader2 } from "lucide-react";

type OrderTrace = {
  order: any;
  fg: any[];
  raws: any[];
};

type BatchTrace = {
  batchNumber: string;
  itemId: number | null;
  consumedBy: any[];
  movements: any[];
};

export default function Traceability() {
  const { token } = useAuth();
  const [tab, setTab] = useState<"order" | "batch">("order");

  // Order downstream mode
  const [orderId, setOrderId] = useState("");
  const [orderLoading, setOrderLoading] = useState(false);
  const [orderErr, setOrderErr] = useState<string | null>(null);
  const [orderData, setOrderData] = useState<OrderTrace | null>(null);

  // Batch recall mode
  const [batchNumber, setBatchNumber] = useState("");
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const [batchData, setBatchData] = useState<BatchTrace | null>(null);

  async function loadOrder() {
    if (!orderId.trim()) return;
    setOrderLoading(true);
    setOrderErr(null);
    setOrderData(null);
    try {
      const r = await fetch(`${API}/api/production/orders/${encodeURIComponent(orderId.trim())}/traceability`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setOrderData(j);
    } catch (e: any) {
      setOrderErr(e?.message || "تعذّر التحميل");
    } finally {
      setOrderLoading(false);
    }
  }

  async function loadBatch() {
    if (!batchNumber.trim()) return;
    setBatchLoading(true);
    setBatchErr(null);
    setBatchData(null);
    try {
      const r = await fetch(
        `${API}/api/production/trace-by-batch?batchNumber=${encodeURIComponent(batchNumber.trim())}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setBatchData(j);
    } catch (e: any) {
      setBatchErr(e?.message || "تعذّر التحميل");
    } finally {
      setBatchLoading(false);
    }
  }

  return (
    <div className="p-4 space-y-4" dir="rtl">
      <div className="flex items-center gap-2">
        <GitBranch className="h-5 w-5 text-violet-600" />
        <h1 className="text-xl font-semibold">تتبّع التشغيلات (Genealogy / Recall)</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        ابحث عن أمر إنتاج لعرض كل التشغيلات المستهلَكة فيه (downstream)، أو ابحث برقم تشغيلة خام لمعرفة كل أوامر الإنتاج التي
        استهلكتها (recall / upstream).
      </p>

      <Tabs value={tab} onValueChange={(v: any) => setTab(v)} className="w-full">
        <TabsList>
          <TabsTrigger value="order" data-testid="tab-order">
            <PackageSearch className="h-4 w-4 me-1" /> بأمر الإنتاج
          </TabsTrigger>
          <TabsTrigger value="batch" data-testid="tab-batch">
            <AlertTriangle className="h-4 w-4 me-1" /> برقم التشغيلة (Recall)
          </TabsTrigger>
        </TabsList>

        {/* ─── ORDER MODE — downstream genealogy ─── */}
        <TabsContent value="order" className="space-y-4 mt-3">
          <Card className="p-4">
            <div className="grid md:grid-cols-[1fr_auto] gap-3 items-end">
              <div>
                <Label htmlFor="orderId">رقم أمر الإنتاج (الـ ID الرقمي)</Label>
                <Input
                  id="orderId"
                  data-testid="input-order-id"
                  value={orderId}
                  onChange={(e) => setOrderId(e.target.value)}
                  placeholder="مثلاً 1234"
                  onKeyDown={(e) => e.key === "Enter" && loadOrder()}
                />
              </div>
              <Button onClick={loadOrder} disabled={orderLoading || !orderId.trim()} data-testid="btn-load-order">
                {orderLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "بحث"}
              </Button>
            </div>
            {orderErr && <div className="text-sm text-red-600 mt-3">{orderErr}</div>}
          </Card>

          {orderData && (
            <>
              <Card className="p-4 bg-violet-50/40 dark:bg-violet-950/10 border-violet-200 dark:border-violet-900/50">
                <div className="flex flex-wrap gap-4 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">أمر</div>
                    <Link href={`/production/orders/${orderData.order.id}`}>
                      <a className="text-violet-600 hover:underline font-semibold" data-testid="link-order">
                        {orderData.order.orderNumber}
                      </a>
                    </Link>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">المنتج</div>
                    <div className="font-medium">{orderData.order.title}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">الحالة</div>
                    <div className="font-medium">{orderData.order.status}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">تشغيلة البضاعة التامة</div>
                    <div className="font-mono">{orderData.order.batchNumber ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">انتهاء البضاعة التامة</div>
                    <div>{orderData.order.fgExpiryDate ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">منتَج / هالك</div>
                    <div>
                      {Number(orderData.order.producedQty).toLocaleString()} / {Number(orderData.order.wasteQty).toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">تكلفة فعلية</div>
                    <div>{Number(orderData.order.actualCost).toLocaleString()}</div>
                  </div>
                </div>
              </Card>

              <Card className="p-4">
                <div className="text-sm font-semibold mb-3">سطور البضاعة التامة (FG Receipt)</div>
                {orderData.fg.length === 0 ? (
                  <div className="text-xs text-muted-foreground">لم يُرحَّل إذن إضافة بعد.</div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="text-start p-1">التاريخ</th>
                        <th className="text-start p-1">الصنف</th>
                        <th className="text-start p-1">التشغيلة</th>
                        <th className="text-start p-1">الانتهاء</th>
                        <th className="text-start p-1">المستودع</th>
                        <th className="text-end p-1">الكمية</th>
                        <th className="text-end p-1">سعر التكلفة</th>
                        <th className="text-end p-1">الإجمالي</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderData.fg.map((r) => (
                        <tr key={r.id} className="border-t" data-testid={`row-fg-${r.id}`}>
                          <td className="p-1">{r.txDate}</td>
                          <td className="p-1">
                            <div>{r.itemNameAr}</div>
                            <div className="font-mono text-muted-foreground">{r.itemCode}</div>
                          </td>
                          <td className="p-1 font-mono">{r.batchNumber ?? "—"}</td>
                          <td className="p-1">{r.expiryDate ?? "—"}</td>
                          <td className="p-1">{r.warehouseName ?? "—"}</td>
                          <td className="p-1 text-end">{Number(r.qty).toLocaleString()}</td>
                          <td className="p-1 text-end">{Number(r.costPrice).toFixed(4)}</td>
                          <td className="p-1 text-end">{Number(r.totalCost).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card className="p-4">
                <div className="text-sm font-semibold mb-3">
                  الخامات المستهلكة (Raw Genealogy — مجمَّعة حسب التشغيلة)
                </div>
                {orderData.raws.length === 0 ? (
                  <div className="text-xs text-muted-foreground">لم يُرحَّل إذن صرف بعد.</div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="text-start p-1">الصنف</th>
                        <th className="text-start p-1">التشغيلة</th>
                        <th className="text-start p-1">الانتهاء</th>
                        <th className="text-end p-1">الكمية المستهلكة</th>
                        <th className="text-end p-1">متوسط التكلفة</th>
                        <th className="text-end p-1">الإجمالي</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderData.raws.map((r, i) => (
                        <tr
                          key={`${r.itemId}-${r.batchNumber ?? ""}-${r.expiryDate ?? ""}-${i}`}
                          className="border-t"
                          data-testid={`row-raw-${i}`}
                        >
                          <td className="p-1">
                            <div>{r.itemNameAr}</div>
                            <div className="font-mono text-muted-foreground">{r.itemCode}</div>
                          </td>
                          <td className="p-1 font-mono">
                            {r.batchNumber ?? <span className="text-muted-foreground">— غير مرمَّز —</span>}
                          </td>
                          <td className="p-1">{r.expiryDate ?? "—"}</td>
                          <td className="p-1 text-end">{Number(r.qty).toLocaleString()}</td>
                          <td className="p-1 text-end">{Number(r.avgCost).toFixed(4)}</td>
                          <td className="p-1 text-end">{Number(r.totalCost).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </>
          )}
        </TabsContent>

        {/* ─── BATCH MODE — recall / upstream lookup ─── */}
        <TabsContent value="batch" className="space-y-4 mt-3">
          <Card className="p-4">
            <div className="grid md:grid-cols-[1fr_auto] gap-3 items-end">
              <div>
                <Label htmlFor="batchNumber">رقم التشغيلة (Batch No.)</Label>
                <Input
                  id="batchNumber"
                  data-testid="input-batch-number"
                  value={batchNumber}
                  onChange={(e) => setBatchNumber(e.target.value)}
                  placeholder="مثلاً B-2026-0042"
                  onKeyDown={(e) => e.key === "Enter" && loadBatch()}
                />
              </div>
              <Button onClick={loadBatch} disabled={batchLoading || !batchNumber.trim()} data-testid="btn-load-batch">
                {batchLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "تتبّع"}
              </Button>
            </div>
            {batchErr && <div className="text-sm text-red-600 mt-3">{batchErr}</div>}
          </Card>

          {batchData && (
            <>
              <Card className="p-4">
                <div className="text-sm font-semibold mb-3">
                  أوامر الإنتاج التي استهلكت التشغيلة{" "}
                  <span className="font-mono">{batchData.batchNumber}</span>
                </div>
                {batchData.consumedBy.length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    لم يتم صرف هذه التشغيلة على أي أمر إنتاج (قد تكون لا تزال في المستودع أو تم بيعها مباشرة — راجع جدول
                    «كل حركات التشغيلة»).
                  </div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="text-start p-1">أمر الإنتاج</th>
                        <th className="text-start p-1">المنتج النهائي</th>
                        <th className="text-start p-1">تشغيلة FG</th>
                        <th className="text-start p-1">انتهاء FG</th>
                        <th className="text-start p-1">الصنف الخام</th>
                        <th className="text-end p-1">الكمية المستهلكة</th>
                        <th className="text-end p-1">التكلفة</th>
                        <th className="text-start p-1">تاريخ الصرف</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchData.consumedBy.map((r, i) => (
                        <tr key={`${r.orderId}-${r.rawItemId}-${i}`} className="border-t" data-testid={`row-consumed-${i}`}>
                          <td className="p-1">
                            <Link href={`/production/orders/${r.orderId}`}>
                              <a className="text-violet-600 hover:underline">{r.orderNumber}</a>
                            </Link>
                          </td>
                          <td className="p-1">
                            <div>{r.fgItemNameAr ?? "—"}</div>
                            <div className="font-mono text-muted-foreground">{r.fgItemCode ?? ""}</div>
                          </td>
                          <td className="p-1 font-mono">{r.fgBatch ?? "—"}</td>
                          <td className="p-1">{r.fgExpiryDate ?? "—"}</td>
                          <td className="p-1">
                            <div>{r.rawItemNameAr}</div>
                            <div className="font-mono text-muted-foreground">{r.rawItemCode}</div>
                          </td>
                          <td className="p-1 text-end">{Number(r.consumedQty).toLocaleString()}</td>
                          <td className="p-1 text-end">{Number(r.consumedCost).toLocaleString()}</td>
                          <td className="p-1">{r.issuedOn}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card className="p-4">
                <div className="text-sm font-semibold mb-3">كل حركات التشغيلة على دفتر المخزون</div>
                {batchData.movements.length === 0 ? (
                  <div className="text-xs text-muted-foreground">لا توجد حركات لهذه التشغيلة.</div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="text-start p-1">التاريخ</th>
                        <th className="text-start p-1">النوع</th>
                        <th className="text-start p-1">الصنف</th>
                        <th className="text-start p-1">المستودع</th>
                        <th className="text-end p-1">الكمية</th>
                        <th className="text-end p-1">السعر</th>
                        <th className="text-end p-1">الإجمالي</th>
                        <th className="text-start p-1">المرجع</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchData.movements.map((r, i) => (
                        <tr key={i} className="border-t" data-testid={`row-move-${i}`}>
                          <td className="p-1">{r.txDate}</td>
                          <td className="p-1 font-mono">{r.txType}</td>
                          <td className="p-1">
                            <div>{r.itemNameAr}</div>
                            <div className="font-mono text-muted-foreground">{r.itemCode}</div>
                          </td>
                          <td className="p-1">{r.warehouseName ?? "—"}</td>
                          <td className={`p-1 text-end ${Number(r.qty) < 0 ? "text-red-600" : "text-emerald-700"}`}>
                            {Number(r.qty).toLocaleString()}
                          </td>
                          <td className="p-1 text-end">{Number(r.costPrice).toFixed(4)}</td>
                          <td className="p-1 text-end">{Number(r.totalCost).toLocaleString()}</td>
                          <td className="p-1 text-muted-foreground">
                            {r.refType ? `${r.refType}#${r.refId}` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
