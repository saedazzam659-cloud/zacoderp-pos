import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Factory, Plus, RefreshCw, ChevronLeft, Save, Play, Pause,
  RotateCcw, Settings2, FileText, Boxes, GitBranch,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Catalog = {
  items: Array<{ id: number; code: string; nameAr: string; itemNature?: string }>;
  warehouses: Array<{ id: number; code: string; nameAr: string; branchId?: number | null; isDefault?: boolean }>;
  templates: Array<{ id: number; name: string; configuration: Record<string, any> }>;
  routings: Array<{ id: number; productItemId: number | null; nameAr: string }>;
};
type Order = {
  id: number; orderNumber: string; title: string; status: string;
  plannedQty: string | number; producedQty: string | number;
  estimatedCost: string | number; actualCost: string | number;
  productItemId: number | null; plannedStartDate?: string | null;
};

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

export default function SimpleManufacturing() {
  const { token } = useAuth();
  const { toast } = useToast();
  const [catalog, setCatalog] = useState<Catalog>({ items: [], warehouses: [], templates: [], routings: [] });
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [sourceCosts, setSourceCosts] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("orders");
  const [form, setForm] = useState({
    title: "", productItemId: "", plannedQty: "1", rawWarehouseId: "", finishedWarehouseId: "",
    plannedStartDate: new Date().toISOString().slice(0, 10), templateId: "",
  });
  const [bom, setBom] = useState({ productItemId: "", nameAr: "", itemId: "", quantity: "1" });
  const [material, setMaterial] = useState({ code: "", nameAr: "", itemNature: "raw" });
  const [warehouse, setWarehouse] = useState({ code: "", nameAr: "", isDefault: false });
  const [routing, setRouting] = useState({ productItemId: "", nameAr: "", stage: "" });
  const [template, setTemplate] = useState({ name: "", productItemId: "", plannedQty: "1" });

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
  }), [token]);

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "تعذر إتمام العملية");
    return body;
  }, [headers]);

  const load = useCallback(async () => {
    const [nextCatalog, nextOrders] = await Promise.all([
      request("/api/simple-manufacturing/catalog"),
      request("/api/simple-manufacturing/orders"),
    ]);
    setCatalog(nextCatalog);
    setOrders(Array.isArray(nextOrders) ? nextOrders : []);
    setForm(current => ({
      ...current,
      rawWarehouseId: current.rawWarehouseId || String(nextCatalog.warehouses[0]?.id ?? ""),
      finishedWarehouseId: current.finishedWarehouseId || String(nextCatalog.warehouses[0]?.id ?? ""),
      productItemId: current.productItemId || String(nextCatalog.items[0]?.id ?? ""),
    }));
  }, [request]);

  useEffect(() => { void load().catch(e => toast({ title: e.message, variant: "destructive" })); }, [load, toast]);

  const mutate = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      toast({ title: success });
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const openOrder = async (order: Order) => {
    try {
      const [detail, costs] = await Promise.all([
        request(`/api/simple-manufacturing/orders/${order.id}`),
        request(`/api/simple-manufacturing/orders/${order.id}/source-costs`),
      ]);
      setSelected({ ...detail.order, detail });
      setSourceCosts(Array.isArray(costs) ? costs : []);
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
    }
  };

  const createOrder = () => mutate(async () => {
    const productItemId = Number(form.productItemId);
    const title = form.title.trim() || `تشغيل ${catalog.items.find(i => i.id === productItemId)?.nameAr || ""}`.trim();
    const row = await request("/api/simple-manufacturing/orders", {
      method: "POST",
      body: JSON.stringify({
        ...form, title, productItemId, plannedQty: Number(form.plannedQty),
        rawWarehouseId: Number(form.rawWarehouseId), finishedWarehouseId: Number(form.finishedWarehouseId),
        templateId: form.templateId || undefined,
        wizardRequestId: `simple-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
    });
    setSelected(row);
    setTab("orders");
  }, "تم إنشاء أمر التصنيع");

  const changeStatus = (order: Order, target: string) => mutate(async () => {
    const row = await request(`/api/simple-manufacturing/orders/${order.id}/status`, {
      method: "POST", body: JSON.stringify({ status: target }),
    });
    setSelected(row);
  }, `تم تحديث الحالة إلى ${statusLabel(target)}`);

  const deleteOrder = (order: Order) => mutate(async () => {
    await request(`/api/simple-manufacturing/orders/${order.id}`, { method: "DELETE" });
    setSelected(null);
    setSourceCosts([]);
  }, "تم حذف المسودة");

  const saveBom = () => mutate(async () => {
    await request("/api/simple-manufacturing/setup/bom", {
      method: "POST",
      body: JSON.stringify({
        productItemId: Number(bom.productItemId), nameAr: bom.nameAr || "قائمة مواد مبسطة",
        lines: [{ itemId: Number(bom.itemId), quantity: Number(bom.quantity), description: "مادة خام" }],
      }),
    });
  }, "تم حفظ قائمة المواد");

  const saveMaterial = () => mutate(async () => {
    const row = await request("/api/simple-manufacturing/setup/products", {
      method: "POST", body: JSON.stringify(material),
    });
    setMaterial({ code: "", nameAr: "", itemNature: "raw" });
    setBom(current => ({ ...current, itemId: String(row.id) }));
  }, "تمت إضافة المادة");

  const saveWarehouse = () => mutate(async () => {
    await request("/api/simple-manufacturing/setup/warehouses", {
      method: "POST", body: JSON.stringify(warehouse),
    });
    setWarehouse({ code: "", nameAr: "", isDefault: false });
  }, "تمت إضافة المخزن");

  const saveRouting = () => mutate(async () => {
    await request("/api/simple-manufacturing/setup/routing", {
      method: "POST",
      body: JSON.stringify({
        productItemId: Number(routing.productItemId), nameAr: routing.nameAr || "مسار مبسط",
        stages: [{ nameAr: routing.stage || "مرحلة الإنتاج", code: "S1" }],
      }),
    });
  }, "تم حفظ مسار الإنتاج");

  const saveTemplate = () => mutate(async () => {
    await request("/api/simple-manufacturing/templates", {
      method: "POST",
      body: JSON.stringify({
        name: template.name || "قالب تصنيع مبسط",
        configuration: {
          productItemId: Number(template.productItemId),
          plannedQty: Number(template.plannedQty),
          rawWarehouseId: Number(form.rawWarehouseId),
          finishedWarehouseId: Number(form.finishedWarehouseId),
        },
      }),
    });
  }, "تم حفظ القالب");

  const productName = (id: number | null) => catalog.items.find(i => i.id === id)?.nameAr || "—";
  const selectedOrder = selected ? (orders.find(o => o.id === selected.id) ?? selected) : null;

  return (
    <div dir="rtl" className="space-y-5 pb-10">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600 p-3 text-white shadow-lg">
            <Factory className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">التصنيع المبسط</h1>
            <p className="text-sm text-muted-foreground">قائمة الأوامر، الإنشاء، التفاصيل والإعداد داخل شاشة واحدة</p>
          </div>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={busy}><RefreshCw className="ml-2 h-4 w-4" />تحديث</Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="orders"><Boxes className="ml-2 h-4 w-4" />الأوامر</TabsTrigger>
          <TabsTrigger value="new"><Plus className="ml-2 h-4 w-4" />أمر جديد</TabsTrigger>
          <TabsTrigger value="setup"><Settings2 className="ml-2 h-4 w-4" />الإعداد</TabsTrigger>
          <TabsTrigger value="reports"><FileText className="ml-2 h-4 w-4" />التقارير</TabsTrigger>
        </TabsList>

        <TabsContent value="orders" className="space-y-4">
          {selectedOrder && (
            <Card className="border-violet-200 shadow-sm">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>تفاصيل {selectedOrder.orderNumber}</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setSelected(null)}><ChevronLeft className="ml-1 h-4 w-4" />إخفاء</Button>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-4 text-sm">
                <div><span className="text-muted-foreground">المنتج</span><div className="font-semibold">{productName(selectedOrder.productItemId)}</div></div>
                <div><span className="text-muted-foreground">الكمية</span><div className="font-semibold">{selectedOrder.plannedQty}</div></div>
                <div><span className="text-muted-foreground">التكلفة التقديرية</span><div className="font-semibold">{selectedOrder.estimatedCost ?? 0}</div></div>
                <div><span className="text-muted-foreground">الحالة</span><div><Badge>{statusLabel(selectedOrder.status)}</Badge></div></div>
                <div className="md:col-span-4 flex gap-2 flex-wrap pt-2">
                  {nextStatus(selectedOrder.status) && <Button disabled={busy} onClick={() => changeStatus(selectedOrder, nextStatus(selectedOrder.status)!)}>
                    <Play className="ml-2 h-4 w-4" />{statusLabel(nextStatus(selectedOrder.status)!)}
                  </Button>}
                  {selectedOrder.status === "in_production" && <Button variant="outline" disabled={busy} onClick={() => changeStatus(selectedOrder, "paused")}><Pause className="ml-2 h-4 w-4" />إيقاف مؤقت</Button>}
                  {selectedOrder.status === "completed" && <Button variant="destructive" disabled={busy} onClick={() => changeStatus(selectedOrder, "reversed")}><RotateCcw className="ml-2 h-4 w-4" />عكس</Button>}
                  {selectedOrder.status === "draft" && <Button variant="destructive" disabled={busy} onClick={() => deleteOrder(selectedOrder)}>حذف المسودة</Button>}
                </div>
                <div className="md:col-span-4 rounded-lg border p-3">
                  <div className="mb-2 font-medium">روابط مصادر التكلفة</div>
                  {sourceCosts.length ? sourceCosts.map(source => (
                    <div key={source.id} className="flex justify-between border-b py-1 last:border-0">
                      <span>{source.sourceType} #{source.sourceRecordId}</span><b>{source.allocatedAmount}</b>
                    </div>
                  )) : <span className="text-muted-foreground">لا توجد توزيعات مصادر تكلفة لهذا الأمر</span>}
                </div>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle>أوامر التصنيع</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-right"><th className="p-2">الرقم</th><th className="p-2">المنتج</th><th className="p-2">الكمية</th><th className="p-2">الحالة</th><th className="p-2" /></tr></thead>
                  <tbody>{orders.map(order => <tr key={order.id} className="border-b hover:bg-muted/40">
                    <td className="p-2 font-medium">{order.orderNumber}</td><td className="p-2">{productName(order.productItemId)}</td>
                    <td className="p-2">{order.plannedQty}</td><td className="p-2"><Badge variant="outline">{statusLabel(order.status)}</Badge></td>
                     <td className="p-2 text-left flex gap-1 justify-end">
                       <Button size="sm" variant="ghost" onClick={() => void openOrder(order)}>التفاصيل</Button>
                       <Link href={`/simple-manufacturing/orders/${order.id}`}><Button size="sm" variant="outline">دورة الحياة</Button></Link>
                     </td>
                  </tr>)}</tbody>
                </table>
                {!orders.length && <div className="py-12 text-center text-muted-foreground">لا توجد أوامر بعد</div>}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="new">
          <Card><CardHeader><CardTitle>إنشاء أمر تصنيع مبسط</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
            <label>العنوان<Input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="تشغيل إنتاج جديد" /></label>
            <label>قالب جاهز<select className="mt-1 w-full rounded-md border bg-background p-2" value={form.templateId} onChange={e => {
              const value = e.target.value;
              const chosen = catalog.templates.find(t => String(t.id) === value);
              const configuration = chosen?.configuration || {};
              setForm({
                ...form, templateId: value,
                productItemId: configuration.productItemId ? String(configuration.productItemId) : form.productItemId,
                plannedQty: configuration.plannedQty ? String(configuration.plannedQty) : form.plannedQty,
                rawWarehouseId: configuration.rawWarehouseId ? String(configuration.rawWarehouseId) : form.rawWarehouseId,
                finishedWarehouseId: configuration.finishedWarehouseId ? String(configuration.finishedWarehouseId) : form.finishedWarehouseId,
              });
            }}><option value="">بدون قالب</option>{catalog.templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <label>المنتج النهائي<select className="mt-1 w-full rounded-md border bg-background p-2" value={form.productItemId} onChange={e => setForm({ ...form, productItemId: e.target.value })}>{catalog.items.map(i => <option key={i.id} value={i.id}>{i.nameAr} — {i.code}</option>)}</select></label>
            <label>الكمية<Input inputMode="decimal" value={form.plannedQty} onChange={e => setForm({ ...form, plannedQty: e.target.value })} /></label>
            <label>تاريخ البدء<Input type="date" value={form.plannedStartDate} onChange={e => setForm({ ...form, plannedStartDate: e.target.value })} /></label>
            <label>مخزن الخامات<select className="mt-1 w-full rounded-md border bg-background p-2" value={form.rawWarehouseId} onChange={e => setForm({ ...form, rawWarehouseId: e.target.value })}>{catalog.warehouses.map(w => <option key={w.id} value={w.id}>{w.nameAr} — {w.code}</option>)}</select></label>
            <label>مخزن الإنتاج التام<select className="mt-1 w-full rounded-md border bg-background p-2" value={form.finishedWarehouseId} onChange={e => setForm({ ...form, finishedWarehouseId: e.target.value })}>{catalog.warehouses.map(w => <option key={w.id} value={w.id}>{w.nameAr} — {w.code}</option>)}</select></label>
            <div className="md:col-span-2 flex justify-end"><Button disabled={busy || !form.productItemId} onClick={createOrder}><Plus className="ml-2 h-4 w-4" />إنشاء الأمر</Button></div>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="setup" className="grid gap-4 lg:grid-cols-4">
          <Card><CardHeader><CardTitle><Boxes className="ml-2 inline h-4 w-4" />المواد وقائمة المكونات</CardTitle></CardHeader><CardContent className="space-y-3">
            <div className="rounded-lg border border-dashed p-3">
              <div className="mb-2 text-sm font-medium">إضافة مادة خام</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input value={material.code} onChange={e => setMaterial({ ...material, code: e.target.value })} placeholder="رمز المادة" />
                <Input value={material.nameAr} onChange={e => setMaterial({ ...material, nameAr: e.target.value })} placeholder="اسم المادة" />
                <select className="rounded-md border bg-background p-2" value={material.itemNature} onChange={e => setMaterial({ ...material, itemNature: e.target.value })}>
                  <option value="raw">مادة خام</option><option value="semi">نصف مصنعة</option>
                  <option value="finished">منتج نهائي</option><option value="consumable">مستهلك</option>
                </select>
              </div>
              <Button variant="outline" size="sm" className="mt-2 w-full" disabled={busy || !material.code || !material.nameAr} onClick={saveMaterial}><Plus className="ml-2 h-4 w-4" />إضافة الصنف</Button>
            </div>
            <select className="w-full rounded-md border bg-background p-2" value={bom.productItemId} onChange={e => setBom({ ...bom, productItemId: e.target.value })}><option value="">المنتج النهائي</option>{catalog.items.map(i => <option key={i.id} value={i.id}>{i.nameAr}</option>)}</select>
            <Input value={bom.nameAr} onChange={e => setBom({ ...bom, nameAr: e.target.value })} placeholder="اسم القائمة" />
            <select className="w-full rounded-md border bg-background p-2" value={bom.itemId} onChange={e => setBom({ ...bom, itemId: e.target.value })}><option value="">المادة الخام</option>{catalog.items.map(i => <option key={i.id} value={i.id}>{i.nameAr}</option>)}</select>
            <Input value={bom.quantity} onChange={e => setBom({ ...bom, quantity: e.target.value })} placeholder="الكمية" />
            <Button className="w-full" disabled={busy || !bom.productItemId || !bom.itemId} onClick={saveBom}><Save className="ml-2 h-4 w-4" />حفظ قائمة المواد</Button>
          </CardContent></Card>
          <Card><CardHeader><CardTitle><GitBranch className="ml-2 inline h-4 w-4" />المسار والمراحل</CardTitle></CardHeader><CardContent className="space-y-3">
            <select className="w-full rounded-md border bg-background p-2" value={routing.productItemId} onChange={e => setRouting({ ...routing, productItemId: e.target.value })}><option value="">المنتج</option>{catalog.items.map(i => <option key={i.id} value={i.id}>{i.nameAr}</option>)}</select>
            <Input value={routing.nameAr} onChange={e => setRouting({ ...routing, nameAr: e.target.value })} placeholder="اسم المسار" />
            <Input value={routing.stage} onChange={e => setRouting({ ...routing, stage: e.target.value })} placeholder="المرحلة الأولى" />
            <Button className="w-full" disabled={busy || !routing.productItemId} onClick={saveRouting}><Save className="ml-2 h-4 w-4" />حفظ المسار</Button>
          </CardContent></Card>
          <Card><CardHeader><CardTitle><FileText className="ml-2 inline h-4 w-4" />قوالب التصنيع</CardTitle></CardHeader><CardContent className="space-y-3">
            <Input value={template.name} onChange={e => setTemplate({ ...template, name: e.target.value })} placeholder="اسم القالب" />
            <select className="w-full rounded-md border bg-background p-2" value={template.productItemId} onChange={e => setTemplate({ ...template, productItemId: e.target.value })}><option value="">المنتج</option>{catalog.items.map(i => <option key={i.id} value={i.id}>{i.nameAr}</option>)}</select>
            <Input value={template.plannedQty} onChange={e => setTemplate({ ...template, plannedQty: e.target.value })} placeholder="الكمية الافتراضية" />
            <Button className="w-full" disabled={busy || !template.productItemId} onClick={saveTemplate}><Save className="ml-2 h-4 w-4" />حفظ القالب</Button>
            <div className="space-y-1 text-xs text-muted-foreground">{catalog.templates.map(t => <div key={t.id} className="rounded bg-muted p-2">{t.name}</div>)}</div>
          </CardContent></Card>
           <Card><CardHeader><CardTitle><Boxes className="ml-2 inline h-4 w-4" />المخازن</CardTitle></CardHeader><CardContent className="space-y-3">
             <Input value={warehouse.code} onChange={e => setWarehouse({ ...warehouse, code: e.target.value })} placeholder="رمز المخزن" />
             <Input value={warehouse.nameAr} onChange={e => setWarehouse({ ...warehouse, nameAr: e.target.value })} placeholder="اسم المخزن" />
             <label className="flex items-center gap-2 text-sm">
               <input type="checkbox" checked={warehouse.isDefault} onChange={e => setWarehouse({ ...warehouse, isDefault: e.target.checked })} />
               مخزن افتراضي
             </label>
             <Button className="w-full" disabled={busy || !warehouse.code || !warehouse.nameAr} onClick={saveWarehouse}><Save className="ml-2 h-4 w-4" />حفظ المخزن</Button>
           </CardContent></Card>
        </TabsContent>

        <TabsContent value="reports">
          <SimpleManufacturingReport request={request} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SimpleManufacturingReport({ request }: { request: (path: string, init?: RequestInit) => Promise<any> }) {
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void request("/api/simple-manufacturing/reports").then(setReport).catch((e: any) => setError(e.message));
  }, [request]);
  if (error) return <Card><CardContent className="p-6 text-destructive">{error}</CardContent></Card>;
  if (!report) return <Card><CardContent className="p-6 text-muted-foreground">جاري تحميل التقرير…</CardContent></Card>;
  return <Card><CardHeader><CardTitle>تقرير تكلفة التصنيع</CardTitle></CardHeader><CardContent>
    <div className="mb-4 grid gap-3 md:grid-cols-2"><div className="rounded-lg bg-muted p-3">التكلفة المعيارية: <b>{Number(report.totals.standardCost || 0).toFixed(2)}</b></div><div className="rounded-lg bg-muted p-3">التكلفة الفعلية: <b>{Number(report.totals.actualCost || 0).toFixed(2)}</b></div></div>
    <div className="space-y-2">{(report.rows || []).map((row: any) => <div key={row.id} className="flex items-center justify-between rounded border p-2 text-sm"><span>{row.orderNumber} — {row.productName || row.title}</span><span>{statusLabel(row.status)} · {row.actualCost || 0}</span></div>)}</div>
  </CardContent></Card>;
}