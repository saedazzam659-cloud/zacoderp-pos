import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Calculator, CheckCircle2, RotateCcw, Unlock, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { usePermission } from "@/hooks/usePermission";

export function MonthlyOverheadClosures({ request }: { request: (path: string, init?: RequestInit) => Promise<any> }) {
  const [closures, setClosures] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<{value: string, label: string}[]>([]);
  const [pendingUtilityOrders, setPendingUtilityOrders] = useState<any[]>([]);
  const [utilitySources, setUtilitySources] = useState<any[]>([]);
  const [pendingOrderIds, setPendingOrderIds] = useState<string[]>([]);
  const [utilitySourceKey, setUtilitySourceKey] = useState("");
  const [utilityBranchScope, setUtilityBranchScope] = useState("");
  const [utilityBranches, setUtilityBranches] = useState<Array<{ value: string; label: string }>>([]);
  const [utilityFactoryId, setUtilityFactoryId] = useState("");
  const [utilityCostCenter, setUtilityCostCenter] = useState("");
  const [utilityLoadError, setUtilityLoadError] = useState<string | null>(null);
  const [varianceAccountId, setVarianceAccountId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7)); // YYYY-MM
  const { toast } = useToast();
  
  const canCreate = usePermission("simple_manufacturing", "create");
  const canPost = usePermission("simple_manufacturing", "post");
  const canUnpost = usePermission("simple_manufacturing", "unpost");

  useEffect(() => {
    // Fetch compact catalog merged accounts
    request("/api/simple-manufacturing/catalog")
      .then(data => {
        if (data && data.accounting) {
          const list = data.accounting.accounts || [];
          setAccounts(list.map((a: any) => ({ value: String(a.id), label: `${a.code} - ${a.nameAr}` })));
          if (data.accounting.settings?.defaultVarianceAccountId) {
            setVarianceAccountId(String(data.accounting.settings.defaultVarianceAccountId));
          }
        }
      })
      .catch(console.error);
  }, [request]);

  const load = async () => {
    setLoading(true);
    try {
      const [data, pending, sources] = await Promise.all([
        request(`/api/simple-manufacturing/overhead-closures?period=${encodeURIComponent(period)}`),
        request(`/api/simple-manufacturing/pending-utility-orders?period=${encodeURIComponent(period)}${utilityBranchScope ? `&branchId=${encodeURIComponent(utilityBranchScope)}` : ""}`),
        request(`/api/simple-manufacturing/cost-sources?period=${encodeURIComponent(period)}`),
      ]);
      setClosures(Array.isArray(data) ? data : data.rows || []);
      const pendingRows = Array.isArray(pending) ? pending : pending?.rows || pending?.orders || [];
      const discoveredBranches = pendingRows.map((row: any) => row.branchId)
        .filter((branchId: unknown) => branchId != null)
        .map((branchId: unknown) => String(branchId));
      setUtilityBranches(current => {
        const values = new Set([...current.map(item => item.value), ...discoveredBranches]);
        return [...values].sort((a, b) => Number(a) - Number(b))
          .map(value => ({ value, label: `فرع #${value}` }));
      });
      // The endpoint returns one immutable evidence row per stage, while the
      // close contract claims complete orders. Group only the displayed rows;
      // the submitted IDs remain the server-issued order IDs.
      const groupedPending = new Map<string, any>();
      pendingRows.forEach((row: any) => {
        const orderId = String(row.orderId ?? row.id);
        const current = groupedPending.get(orderId);
        groupedPending.set(orderId, {
          ...row,
          id: orderId,
          kwh: Number(current?.kwh ?? 0) + Number(row.kwh ?? 0),
          estimatedAmount: Number(current?.estimatedAmount ?? 0) + Number(row.estimate ?? row.estimatedAmount ?? 0),
          stageCount: Number(current?.stageCount ?? 0) + 1,
        });
      });
      setPendingUtilityOrders([...groupedPending.values()]);
      setUtilitySources((Array.isArray(sources) ? sources : []).filter((source: any) =>
        source.sourceType === "purchase_invoice" &&
        source.meta?.costType === "electricity" &&
        (source.meta?.industrialDriver ?? source.meta?.allocationMethod) === "machine_hours",
      ));
      setUtilityLoadError(null);
    } catch (e: any) {
      // Keep the established closure list usable if the new utility endpoint
      // rejects this period. The server's exact error is shown beside the
      // pending-settlement controls rather than being silently treated as no
      // pending usage.
      setUtilityLoadError(e.message || "تعذر تحميل تسويات الكهرباء المعلقة");
      try {
        const data = await request(`/api/simple-manufacturing/overhead-closures?period=${encodeURIComponent(period)}`);
        setClosures(Array.isArray(data) ? data : data.rows || []);
      } catch (closureError: any) {
        toast({ title: "خطأ", description: closureError.message, variant: "destructive" });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPendingOrderIds([]);
    setUtilitySourceKey("");
    setUtilityBranchScope("");
    setUtilityFactoryId("");
    setUtilityCostCenter("");
    load();
  }, [period]);

  useEffect(() => {
    if (!utilityBranchScope) return;
    setPendingOrderIds([]);
    setUtilitySourceKey("");
    setUtilityFactoryId("");
    setUtilityCostCenter("");
    void load();
  }, [utilityBranchScope]);

  const handleCreate = async () => {
    if (!varianceAccountId) {
      toast({ title: "الرجاء اختيار حساب الفروقات (Variance Account)", variant: "destructive" });
      return;
    }
    const source = scopedUtilitySources.find(row =>
      `${row.sourceType}:${row.sourceRecordId}` === utilitySourceKey,
    );
    const hasPendingSelection = pendingOrderIds.length > 0;
    if (hasPendingSelection && (!source || !utilityBranchScope || !utilityFactoryId || !utilityCostCenter)) {
      toast({
        title: "اختيار تسوية الكهرباء غير مكتمل",
        description: "اختر الفرع وفاتورة الكهرباء الصناعية والمصنع ومركز التكلفة صراحةً. لا يطابق النظام هذه الحقول تلقائياً.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      await request("/api/simple-manufacturing/overhead-closures", {
        method: "POST",
        body: JSON.stringify(hasPendingSelection ? {
          period,
          varianceAccountId: Number(varianceAccountId),
          branchId: Number(utilityBranchScope),
          pendingOrderIds: pendingOrderIds.map(Number),
          utilitySource: {
            sourceType: "purchase_invoice",
            sourceRecordId: Number(source.sourceRecordId),
            factoryId: Number(utilityFactoryId),
            costCenter: utilityCostCenter,
          },
        } : { period, varianceAccountId: Number(varianceAccountId) })
      });
      toast({ title: hasPendingSelection ? "تم إنشاء مسودة تسوية الكهرباء المعلقة" : "تم إنشاء مسودة إقفال المصادر بنجاح" });
      load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  // The settlement service requires the explicit close branch and factory to
  // match. Keep candidates within the branch the operator selected, then
  // expose only the tags belonging to the selected posted source.
  const scopedUtilitySources = utilityBranchScope
    ? utilitySources.filter(source => String(source.meta?.factoryId) === utilityBranchScope)
    : [];
  const selectedUtilitySource = scopedUtilitySources.find(source =>
    `${source.sourceType}:${source.sourceRecordId}` === utilitySourceKey,
  );
  const factoryOptions = selectedUtilitySource
    ? [String(selectedUtilitySource.meta?.factoryId)]
    : [];
  const costCenterOptions = selectedUtilitySource
    ? [selectedUtilitySource.meta?.costCenter]
    .filter((value: unknown) => value != null && value !== "")
    .map((value: unknown) => String(value))
    : [];

  const handleAction = async (id: string, action: "post" | "reverse" | "reopen") => {
    setBusy(true);
    try {
      await request(`/api/simple-manufacturing/overhead-closures/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify({})
      });
      const title = action === "post" ? "تم ترحيل إقفال المصادر بنجاح" 
                  : action === "reverse" ? "تم عكس الإقفال بنجاح" 
                  : "تم إعادة فتح مسودة الإقفال بنجاح";
      toast({ title });
      load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-violet-100 shadow-sm mt-6">
      <CardHeader className="bg-violet-50/50 pb-4">
        <CardTitle className="text-lg flex items-center gap-2">
          <Calculator className="h-5 w-5 text-violet-600" />
          إقفال المصادر الشهري (Overhead Closures)
        </CardTitle>
        <CardDescription>
          مقارنة التكاليف غير المباشرة (الرواتب، الإهلاك، المصاريف) الموزعة على أوامر الإنتاج بالاستحقاقات الفعلية وإثبات الفروقات.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <div className="grid md:grid-cols-3 gap-4 items-end bg-slate-50 p-4 rounded-xl border border-slate-100">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">الشهر (YYYY-MM)</label>
            <Input type="month" value={period} onChange={e => setPeriod(e.target.value)} className="bg-white" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">حساب الفروقات (Variance)</label>
            <SearchCombobox
              value={varianceAccountId}
              onValueChange={setVarianceAccountId}
              items={accounts}
              placeholder="اختر الحساب..."
            />
                  </div>
          {canCreate && (
            <Button onClick={handleCreate} disabled={busy || loading || !varianceAccountId || (pendingOrderIds.length > 0 && (!utilitySourceKey || !utilityBranchScope || !utilityFactoryId || !utilityCostCenter))} className="bg-violet-600 hover:bg-violet-700 w-full">
              <Plus className="h-4 w-4 me-2" /> إنشاء مسودة للشهر المحدد
            </Button>
          )}
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-amber-950">تسوية كهرباء آلات معلّقة ضمن الإقفال الحالي</h4>
            <p className="mt-1 text-xs leading-5 text-amber-900">تظهر هنا لقطات kWh المجمدة التي اكتملت دون فاتورة كهرباء. اختر الأمر/الأوامر وفاتورة صناعية مرحّلة والمصنع ومركز التكلفة صراحةً؛ لا يوجد ربط تلقائي ولا تُعامل قيمة التعريفة التقديرية كمصروف فعلي.</p>
          </div>
          {utilityLoadError ? (
            <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-800">{utilityLoadError}</div>
          ) : pendingUtilityOrders.length === 0 ? (
            <p className="rounded-md border border-dashed border-amber-200 bg-white/70 p-3 text-xs text-slate-600">لا توجد استخدامات كهرباء آلة مجمّدة معلّقة ومؤهلة لهذه الفترة، أو لم يثبت الخادم أن تكلفة الإنتاج التام لا تزال بالكامل في المخزون.</p>
          ) : (
            <>
              <div className="space-y-2">
                {pendingUtilityOrders.map(order => {
                  const id = String(order.orderId ?? order.id);
                  const checked = pendingOrderIds.includes(id);
                  return <label key={id} className="flex cursor-pointer items-start gap-2 rounded-md border border-amber-100 bg-white p-3 text-xs">
                    <input type="checkbox" className="mt-0.5 rounded text-violet-600" checked={checked} disabled={!canCreate || busy}
                      onChange={event => setPendingOrderIds(current => event.target.checked ? [...current, id] : current.filter(value => value !== id))} />
                    <span><b>{order.orderNumber ?? `أمر #${id}`}</b> — kWh مجمّدة: {Number(order.kwh ?? order.totalKwh ?? 0).toLocaleString()} — تقدير التعريفة: {Number(order.estimatedAmount ?? order.tariffEstimate ?? 0).toLocaleString()}</span>
                  </label>;
                })}
              </div>
              <div className="grid gap-3 md:grid-cols-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">نطاق الفرع</label>
                  <SearchCombobox value={utilityBranchScope} onValueChange={setUtilityBranchScope} disabled={!canCreate || busy}
                    placeholder="اختر الفرع…" items={[
                      { value: "", label: "اختر الفرع…" },
                      ...utilityBranches,
                    ]} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">فاتورة كهرباء صناعية مرحّلة</label>
                  <SearchCombobox value={utilitySourceKey} onValueChange={value => {
                    setUtilitySourceKey(value);
                    setUtilityFactoryId("");
                    setUtilityCostCenter("");
                  }} disabled={!canCreate || busy || !utilityBranchScope}
                    placeholder="اختر المصدر…" items={[
                      { value: "", label: "اختر فاتورة الكهرباء…" },
                      ...scopedUtilitySources.map(source => ({ value: `${source.sourceType}:${source.sourceRecordId}`, label: `${source.label} (#${source.sourceRecordId})` })),
                    ]} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">المصنع</label>
                  <SearchCombobox value={utilityFactoryId} onValueChange={setUtilityFactoryId} disabled={!canCreate || busy || !selectedUtilitySource}
                    placeholder="اختر المصنع…" items={[{ value: "", label: "اختر المصنع…" }, ...factoryOptions.map(value => ({ value, label: `#${value}` }))]} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">مركز التكلفة</label>
                  <SearchCombobox value={utilityCostCenter} onValueChange={setUtilityCostCenter} disabled={!canCreate || busy || !selectedUtilitySource}
                    placeholder="اختر مركز التكلفة…" items={[{ value: "", label: "اختر مركز التكلفة…" }, ...costCenterOptions.map(value => ({ value, label: value }))]} />
                </div>
              </div>
              {!utilitySources.length && <p className="text-xs leading-5 text-amber-900">لا توجد فاتورة شراء صناعية مرحّلة موسومة «كهرباء» بمحرك «ساعات الآلة» لهذه الفترة. أضف المصدر المرحّل أولاً، ثم حدده هنا للتسوية المتأخرة.</p>}
            </>
          )}
        </div>

        {loading ? (
          <div className="py-8 text-center text-slate-500 flex flex-col items-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-violet-500" />
            <span>جاري التحميل...</span>
          </div>
        ) : closures.length === 0 ? (
          <div className="text-center p-8 border-2 border-dashed rounded-lg text-slate-500 text-sm">
            لا توجد سجلات إقفال لشهر {period}.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm text-right">
              <thead>
                <tr className="bg-slate-50 border-b">
                  <th className="p-3 font-semibold">رقم الإقفال</th>
                  <th className="p-3 font-semibold">الشهر</th>
                  <th className="p-3 font-semibold">الحالة</th>
                  <th className="p-3 font-semibold">قيمة الفروقات</th>
                  <th className="p-3 font-semibold">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {closures.map(c => (
                  <tr key={c.id} className="hover:bg-slate-50/50">
                    <td className="p-3 font-medium">#{c.id}</td>
                    <td className="p-3">{c.period}</td>
                    <td className="p-3">
                      <Badge variant="outline" className={c.status === "posted" ? "bg-emerald-50 text-emerald-700" : c.status === "reversed" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700"}>
                        {c.status === "posted" ? "مرحّل" : c.status === "reversed" ? "معكوس" : "مسودة"}
                      </Badge>
                    </td>
                    <td className="p-3 font-mono">{Number(c.varianceAmount || 0).toLocaleString()}</td>
                    <td className="p-3">
  <div className="flex gap-2 justify-end">
    {c.status === "draft" && canPost && (
      <Button size="sm" variant="outline" className="text-emerald-700 hover:text-emerald-800" disabled={busy} onClick={() => handleAction(c.id, "post")}>
        <CheckCircle2 className="h-4 w-4 me-1" /> ترحيل
      </Button>
    )}
    {c.status === "posted" && canUnpost && (
      <Button size="sm" variant="outline" className="text-rose-700 hover:text-rose-800" disabled={busy} onClick={() => handleAction(c.id, "reverse")}>
        <RotateCcw className="h-4 w-4 me-1" /> عكس
      </Button>
    )}
    {c.status === "reversed" && canUnpost && (
      <Button size="sm" variant="outline" className="text-blue-700 hover:text-blue-800" disabled={busy} onClick={() => handleAction(c.id, "reopen")}>
        <Unlock className="h-4 w-4 me-1" /> إعادة فتح
      </Button>
    )}
  </div>
</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}