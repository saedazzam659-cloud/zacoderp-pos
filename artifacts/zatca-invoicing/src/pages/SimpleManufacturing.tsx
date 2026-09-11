import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { usePermission } from "@/hooks/usePermission";
import { Factory, RefreshCw, Boxes, Plus, Settings2, FileText } from "lucide-react";
import type { Catalog, Order } from "./simple-manufacturing/types";
import { SimpleOrderList } from "./simple-manufacturing/SimpleList";
import { SimpleWizard } from "./simple-manufacturing/SimpleWizard";
import { SimpleSetup } from "./simple-manufacturing/SimpleSetup";
import { SimpleReports } from "./simple-manufacturing/SimpleReports";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SimpleManufacturing() {
  const { token, user, actingCompanyId } = useAuth();
  const { toast } = useToast();

  const emptyCatalog = (): Catalog => ({ items: [], warehouses: [], templates: [], routings: [] });
  const [catalog, setCatalog] = useState<Catalog>(() => emptyCatalog());
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [sourceCosts, setSourceCosts] = useState<any[]>([]);
  const [costDrilldown, setCostDrilldown] = useState<any>(null);

  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("orders");
  const loadRequestRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const orderRequestRef = useRef(0);
  const orderAbortRef = useRef<AbortController | null>(null);

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
    ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
  }), [token, actingCompanyId]);

  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(response.ok ? "استجابة غير صالحة من الخادم" : `HTTP ${response.status}`);
      }
    }
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    return body;
  }, [headers]);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setBusy(true);
    try {
      const [nextCatalog, nextOrders] = await Promise.all([
        request("/api/simple-manufacturing/catalog", { signal: controller.signal }),
        request("/api/simple-manufacturing/orders", { signal: controller.signal }),
      ]);
      if (requestId !== loadRequestRef.current || controller.signal.aborted) return;
      if (!nextCatalog || typeof nextCatalog !== "object" ||
          !Array.isArray(nextCatalog.items) ||
          !Array.isArray(nextCatalog.warehouses) ||
          !Array.isArray(nextCatalog.templates) ||
          !Array.isArray(nextCatalog.routings)) {
        throw new Error("استجابة كتالوج التصنيع غير صالحة");
      }
      setCatalog(nextCatalog);
      if (!Array.isArray(nextOrders)) throw new Error("استجابة أوامر التصنيع غير صالحة");
      setOrders(nextOrders);
    } catch (e: any) {
      if (e?.name !== "AbortError" && requestId === loadRequestRef.current) {
        toast({ title: e.message, variant: "destructive" });
      }
    } finally {
      if (requestId === loadRequestRef.current) setBusy(false);
    }
  }, [request, toast]);

  // The same page can stay mounted while a SuperAdmin changes the acting
  // tenant. Clear all local screen state before loading the new tenant so a
  // late response can never leak the previous company's catalog/order data.
  const tenantScope = `${user?.id ?? "anonymous"}:${user?.companyId ?? ""}:${actingCompanyId ?? ""}`;
  const tenantScopeRef = useRef(tenantScope);
  tenantScopeRef.current = tenantScope;
  useEffect(() => {
    loadRequestRef.current += 1;
    loadAbortRef.current?.abort();
    orderRequestRef.current += 1;
    orderAbortRef.current?.abort();
    setCatalog(emptyCatalog());
    setOrders([]);
    setSelectedOrder(null);
    setSourceCosts([]);
    setCostDrilldown(null);
    void load();
    return () => {
      loadRequestRef.current += 1;
      loadAbortRef.current?.abort();
      orderRequestRef.current += 1;
      orderAbortRef.current?.abort();
    };
  }, [load, tenantScope]);

  const mutate = async (fn: () => Promise<unknown>, success: string) => {
    const mutationScope = tenantScopeRef.current;
    setBusy(true);
    try {
      const result = await fn();
      if (mutationScope !== tenantScopeRef.current) return;
      await load();
      if (mutationScope !== tenantScopeRef.current) return;
      toast({ title: success });
      return result;
    } catch (e: any) {
      toast({ title: e.message, variant: "destructive" });
      throw e;
    } finally {
      if (mutationScope === tenantScopeRef.current) setBusy(false);
    }
  };

  const openOrder = async (order: Order) => {
    const requestId = ++orderRequestRef.current;
    orderAbortRef.current?.abort();
    const controller = new AbortController();
    orderAbortRef.current = controller;
    try {
      const [detail, costs, drilldown] = await Promise.all([
        request(`/api/simple-manufacturing/orders/${order.id}`, { signal: controller.signal }),
        request(`/api/simple-manufacturing/orders/${order.id}/source-costs`, { signal: controller.signal }),
        request(`/api/simple-manufacturing/orders/${order.id}/cost-drilldown`, { signal: controller.signal }),
      ]);
      if (requestId !== orderRequestRef.current || controller.signal.aborted) return;
      if (!detail?.order) throw new Error("استجابة تفاصيل أمر التصنيع غير صالحة");
      if (!Array.isArray(costs)) throw new Error("استجابة مصادر تكلفة الأمر غير صالحة");
      setSelectedOrder({ ...detail.order, detail });
      setSourceCosts(costs);
      setCostDrilldown(drilldown);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e: any) {
      if (e?.name !== "AbortError" && requestId === orderRequestRef.current) {
        toast({ title: e.message, variant: "destructive" });
      }
    }
  };

  const closeOrder = () => {
    orderRequestRef.current += 1;
    orderAbortRef.current?.abort();
    setSelectedOrder(null);
    setSourceCosts([]);
    setCostDrilldown(null);
  };

  const changeStatus = (order: Order, target: string) => mutate(async () => {
    const row = await request(`/api/simple-manufacturing/orders/${order.id}/status`, {
      method: "POST", body: JSON.stringify({ status: target }),
    });
    setSelectedOrder(row);
  }, `تم تحديث الحالة`);

  const deleteDraft = (order: Order) => mutate(async () => {
    await request(`/api/simple-manufacturing/orders/${order.id}`, { method: "DELETE" });
    setSelectedOrder(null);
    setSourceCosts([]);
  }, "تم حذف المسودة");

  // Wizard Submit
  const handleWizardSubmit = async (mode: "draft" | "execute", payload: any) => {
    const submissionScope = tenantScopeRef.current;
    setBusy(true);
    try {
      const j = await request("/api/simple-manufacturing/orders/wizard", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      let finalOrder = j;

      if (mode === "execute") {
        let status = j.status;
        if (status === "draft") {
          const approve = await request(`/api/simple-manufacturing/orders/${j.id}/status`, {
            method: "POST", body: JSON.stringify({ status: "approved" })
          });
          status = approve.status;
        }
        if (status === "approved") {
          finalOrder = await request(`/api/simple-manufacturing/orders/${j.id}/status`, {
            method: "POST", body: JSON.stringify({ status: "in_production" })
          });
        }
      }

      if (submissionScope !== tenantScopeRef.current) return;
      await load();
      if (submissionScope !== tenantScopeRef.current) return;
      toast({ title: mode === "execute" ? "تم إنشاء الأمر وبدء الإنتاج" : "تم حفظ المسودة بنجاح" });
      setTab("orders");
      await openOrder(finalOrder);
    } catch (e: any) {
      toast({ title: e?.message || "حدث خطأ أثناء الحفظ", variant: "destructive" });
    } finally {
      if (submissionScope === tenantScopeRef.current) setBusy(false);
    }
  };

  // Setup Mutations
  const handleSaveMaterial = async (data: any) => {
    // Raw/consumable stock is created through the materials endpoint; only
    // finished/semi/merchandise items use the product alias.
    const setupPath = ["finished", "semi", "merchandise"].includes(data.itemNature)
      ? "/api/simple-manufacturing/setup/products"
      : "/api/simple-manufacturing/setup/materials";
    return mutate(() => request(setupPath, {
      method: "POST", body: JSON.stringify(data),
    }), "تمت إضافة الصنف بنجاح");
  };

  const handleSaveBom = async (data: any) => {
    const lines = Array.isArray(data.lines) ? data.lines : [{
      itemId: data.itemId,
      quantity: data.quantity,
      unitCode: data.unitCode,
    }];
    return mutate(() => request("/api/simple-manufacturing/setup/bom", {
      method: "POST",
      body: JSON.stringify({
        productItemId: Number(data.productItemId), nameAr: data.nameAr || "قائمة مكونات",
        outputQty: Number(data.outputQty) > 0 ? Number(data.outputQty) : 1,
        ...(data.outputUnitCode ? { outputUnitCode: data.outputUnitCode } : {}),
        lines: lines.map((line: any) => ({
          itemId: Number(line.itemId),
          quantity: Number(line.quantity),
          description: line.description || "مادة خام",
          ...(line.unitCode ? { unitCode: line.unitCode } : {}),
        })),
      }),
    }), "تم حفظ الوصفة");
  };

  const handleSaveRouting = async (data: any) => {
    const stages = (data.stages || []).map((s: any, idx: number) => ({
      nameAr: s.nameAr || "مرحلة",
      code: `S${idx + 1}`,
      expectedCost: 0,
      expectedWasteRatio: 0,
      expectedDurationMinutes: s.expectedDurationMinutes ? Number(s.expectedDurationMinutes) : undefined
    }));
    return mutate(() => request("/api/simple-manufacturing/setup/routing", {
      method: "POST",
      body: JSON.stringify({
        productItemId: Number(data.productItemId), nameAr: data.nameAr || "مسار مبسط",
        stages: stages.length ? stages : [{ nameAr: "مرحلة الإنتاج", code: "S1", expectedCost: 0, expectedWasteRatio: 0 }],
      }),
    }), "تم حفظ مسار الإنتاج");
  };

  const handleSaveTemplate = async (data: any) => {
    return mutate(() => request("/api/simple-manufacturing/templates", {
      method: "POST",
      body: JSON.stringify({
        name: data.name || "قالب تصنيع",
        configuration: {
          productItemId: Number(data.productItemId),
          plannedQty: Number(data.plannedQty),
          ...(data.unitCode ? { unitCode: data.unitCode } : {}),
        },
      }),
    }), "تم حفظ القالب");
  };

  const canCreate = usePermission("simple_manufacturing", "create");
  const canEdit = usePermission("simple_manufacturing", "edit");
  const canDelete = usePermission("simple_manufacturing", "delete");
  const canPost = usePermission("simple_manufacturing", "post");
  const canUnpost = usePermission("simple_manufacturing", "unpost");

  const handleSaveWarehouse = async (data: any) => {
    return mutate(() => request("/api/simple-manufacturing/setup/warehouses", {
      method: "POST", body: JSON.stringify(data),
    }), "تمت إضافة المخزن");
  };

  return (
    <div dir="rtl" className="space-y-6 pb-12 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap bg-white p-6 rounded-2xl border shadow-sm">
        <div className="flex items-center gap-4">
          <div className="rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 p-3.5 text-white shadow-lg shadow-violet-200">
            <Factory className="h-7 w-7" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">التصنيع المبسط</h1>
            <p className="text-sm text-slate-500 mt-1">إدارة أوامر التشغيل، التكاليف، وإعدادات الورشة من شاشة واحدة.</p>
          </div>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={busy} className="bg-slate-50">
          <RefreshCw className={`ml-2 h-4 w-4 ${busy ? "animate-spin" : ""}`} />
          تحديث البيانات
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList className="flex w-full overflow-x-auto no-scrollbar bg-white border p-1 h-14 rounded-xl shadow-sm">
          <TabsTrigger value="orders" className="flex-1 rounded-lg text-base h-11 data-[state=active]:bg-violet-50 data-[state=active]:text-violet-700 data-[state=active]:shadow-sm">
            <Boxes className="ml-2 h-4 w-4" />
            سجل الأوامر
          </TabsTrigger>
          <TabsTrigger value="new" className="flex-1 rounded-lg text-base h-11 data-[state=active]:bg-violet-600 data-[state=active]:text-white data-[state=active]:shadow-sm">
            <Plus className="ml-2 h-4 w-4" />
            أمر تصنيع جديد
          </TabsTrigger>
          <TabsTrigger value="setup" className="flex-1 rounded-lg text-base h-11 data-[state=active]:bg-violet-50 data-[state=active]:text-violet-700 data-[state=active]:shadow-sm">
            <Settings2 className="ml-2 h-4 w-4" />
            الإعدادات
          </TabsTrigger>
          <TabsTrigger value="reports" className="flex-1 rounded-lg text-base h-11 data-[state=active]:bg-violet-50 data-[state=active]:text-violet-700 data-[state=active]:shadow-sm">
            <FileText className="ml-2 h-4 w-4" />
            التقارير المجمعة
          </TabsTrigger>
        </TabsList>

        <TabsContent value="orders" className="mt-0">
          <SimpleOrderList
            orders={orders}
            catalog={catalog}
            busy={busy}
            selectedOrder={selectedOrder}
            sourceCosts={sourceCosts}
             costDrilldown={costDrilldown}
             canPost={canPost}
             canUnpost={canUnpost}
             canDelete={canDelete}
            onOpenOrder={openOrder}
             onCloseOrder={closeOrder}
            onChangeStatus={changeStatus}
            onDeleteDraft={deleteDraft}
          />
        </TabsContent>

        <TabsContent value="new" className="mt-0">
          <SimpleWizard
             key={tenantScope}
            token={token || ""}
            catalog={catalog}
            busy={busy}
            onSubmit={handleWizardSubmit}
            onCancel={() => setTab("orders")}
          />
        </TabsContent>

        <TabsContent value="setup" className="mt-0">
          <SimpleSetup
            catalog={catalog}
            busy={busy}
             canCreate={canCreate}
             canEdit={canEdit}
            onSaveMaterial={handleSaveMaterial}
            onSaveBom={handleSaveBom}
            onSaveRouting={handleSaveRouting}
            onSaveTemplate={handleSaveTemplate}
            onSaveWarehouse={handleSaveWarehouse}
          />
        </TabsContent>

        <TabsContent value="reports" className="mt-0">
          <SimpleReports request={request} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
