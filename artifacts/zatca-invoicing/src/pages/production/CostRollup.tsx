import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  Calculator, Package, Wrench, Factory, AlertTriangle,
  DollarSign, Layers, Settings, Download, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { DateField } from "@/components/ui/date-field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { downloadBlob } from "@/lib/dataIoApi";

const API = import.meta.env.VITE_API_URL || "";

type Item = { id: number; nameAr?: string | null; nameEn?: string | null; sku?: string | null };
type CostRollup = {
  product: { id: number; nameAr: string; nameEn: string | null; sku: string | null };
  bom: { templateId: number; nameAr: string; outputQty: number } | null;
  routing: { routingId: number; nameAr: string } | null;
  materials: Array<{
    itemId: number | null; nameAr: string | null; sku: string | null;
    qty: number; unitCost: number; totalCost: number;
  }>;
  stages: Array<{
    stageId: number; sequence: number; nameAr: string;
    workCenterId: number | null; workCenterNameAr: string | null;
    durationMinutes: number | null;
    laborCost: number; overheadCost: number; stageCost: number;
    source: "expectedCost" | "rates" | "none";
  }>;
  totals: {
    materialsCost: number; laborCost: number; overheadCost: number;
    routingExplicitCost: number; operatingCost: number;
    totalCost: number; unitCost: number;
  };
};

const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export default function CostRollup() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [productId, setProductId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<CostRollup | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState("");
  const [branches, setBranches] = useState<any[]>([]);
  const [aggregate, setAggregate] = useState<any>(null);
  const [profitability, setProfitability] = useState<any>(null);
  const [reportLoading, setReportLoading] = useState(false);

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }), [token]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      const r = await fetch(`${API}/api/inventory/items?includeHidden=1&limit=1000`, { headers });
      if (r.ok) {
        const d = await r.json();
        setItems(Array.isArray(d) ? d : d?.items ?? []);
      }
    })();
  }, [token, headers]);

  useEffect(() => {
    if (!token) return;
    void fetch(`${API}/api/branches`, { headers }).then(async (r) => {
      if (!r.ok) return [];
      const j=await r.json();
      return Array.isArray(j) ? j : (j.rows??j.data??[]);
    }).then(setBranches).catch(()=>setBranches([]));
  }, [token, headers]);

  const run = useCallback(async () => {
    if (!productId) return;
    setLoading(true);
    setData(null);
    try {
      const r = await fetch(
        `${API}/api/production/cost-rollup?productItemId=${productId}`,
        { headers },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || `HTTP ${r.status}`);
      }
      setData(await r.json());
    } catch (e: any) {
      toast({ title: "فشل الحساب", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [productId, headers, toast]);

  const reportQuery = useMemo(() => {
    const p=new URLSearchParams({ from, to });
    if(branchId) p.set("branchId",branchId);
    return p.toString();
  }, [from,to,branchId]);

  const loadReports = useCallback(async () => {
    setReportLoading(true);
    try {
      const [costs,sales]=await Promise.all([
        fetch(`${API}/api/production/reports/costs?${reportQuery}`,{headers}),
        fetch(`${API}/api/production/reports/realized-product-profitability?${reportQuery}`,{headers}),
      ]);
      const cj=await costs.json(); const sj=await sales.json();
      if(!costs.ok) throw new Error(cj.error||"تعذر تحميل تقرير التكلفة");
      if(!sales.ok) throw new Error(sj.error||"تعذر تحميل المبيعات المحققة");
      setAggregate(cj); setProfitability(sj);
    } catch(e:any) {
      toast({title:"تعذر تحميل تقارير التصنيع",description:e.message,variant:"destructive"});
    } finally { setReportLoading(false); }
  },[headers,reportQuery,toast]);

  useEffect(()=>{ if(token) void loadReports(); },[token,loadReports]);

  function exportCsv(kind:"costs"|"sales") {
    const quote=(v:unknown)=>`"${String(v??"").replaceAll('"','""')}"`;
    let rows: unknown[][];
    if(kind==="costs") {
      rows=[["Product ID","Product","Produced Qty","Standard Cost","Actual Cost","Variance","Actual Unit Cost"],
        ...(aggregate?.products??[]).map((x:any)=>[x.productItemId,x.productName,x.producedQty,x.standardCost,x.actualCost,x.variance,x.actualUnitCost])];
    } else {
      rows=[["Product ID","Product","Posted Sales Qty","Posted Return Qty","Net Sold Qty","Posted Sales Revenue","Posted Return Revenue","Realized Net Revenue","Gross Margin","Operating Cost","Financing Cost","Attribution"],
        ...(profitability?.products??[]).map((x:any)=>[x.itemId,x.productName,x.postedSalesQty,x.postedReturnQty,x.netSoldQty,x.postedSalesRevenue,x.postedReturnRevenue,x.realizedNetRevenue,"UNAVAILABLE","UNAVAILABLE","UNAVAILABLE",x.marginStatus])];
    }
    const csv="\uFEFF"+rows.map(r=>r.map(quote).join(",")).join("\r\n");
    downloadBlob(new Blob([csv],{type:"text/csv;charset=utf-8"}),
      `manufacturing-${kind}-${from}-${to}${branchId?`-branch-${branchId}`:""}.csv`);
  }

  const missingCost = data?.materials.some((m) => m.unitCost === 0);
  const missingDuration = data?.stages.some((s) => s.source === "none");

  return (
    <div className="container mx-auto p-4 space-y-4" dir="rtl">
      <div className="flex items-center gap-3">
        <DollarSign className="h-6 w-6 text-emerald-600" />
        <div>
          <h1 className="text-2xl font-bold">تكلفة المنتج المعيارية (Cost Rollup)</h1>
          <p className="text-sm text-slate-500">
            احسب تكلفة وحدة المنتج التام من قالب BOM وقالب المراحل (المواد + التشغيل).
          </p>
        </div>
      </div>

      <Tabs defaultValue="standard" className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="standard">التكلفة المعيارية</TabsTrigger>
          <TabsTrigger value="actual">التكلفة والانحراف والمصادر</TabsTrigger>
          <TabsTrigger value="sales">المبيعات المحققة والربحية</TabsTrigger>
        </TabsList>
        <TabsContent value="standard" className="space-y-4">
      <Card>
        <CardContent className="p-3">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-[300px]">
              <Label className="text-xs">المنتج التام</Label>
              <SearchCombobox
                value={productId}
                onValueChange={(v: string) => setProductId(v)}
                items={items.map((it) => ({
                  value: String(it.id),
                  label: it.nameAr || it.nameEn || it.sku || `#${it.id}`,
                }))}
                placeholder="ابحث عن منتج..."
              />
            </div>
            <Button onClick={run} disabled={!productId || loading}>
              <Calculator className="h-4 w-4 me-1" />
              {loading ? "جاري الحساب..." : "احسب التكلفة"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading && (
        <Card><CardContent className="p-4 space-y-2">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}
        </CardContent></Card>
      )}

      {data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-3 text-center">
                <div className="text-xs text-slate-500 flex items-center justify-center gap-1">
                  <Package className="h-3 w-3" />مواد
                </div>
                <div className="text-xl font-bold mt-1 font-mono">{fmtMoney(data.totals.materialsCost)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <div className="text-xs text-slate-500 flex items-center justify-center gap-1">
                  <Wrench className="h-3 w-3" />عمالة + مصاريف
                </div>
                <div className="text-xl font-bold mt-1 font-mono text-blue-700">
                  {fmtMoney(data.totals.operatingCost)}
                </div>
              </CardContent>
            </Card>
            <Card className="border-emerald-300">
              <CardContent className="p-3 text-center">
                <div className="text-xs text-emerald-700 flex items-center justify-center gap-1">
                  <DollarSign className="h-3 w-3" />تكلفة الوحدة
                </div>
                <div className="text-2xl font-bold mt-1 font-mono text-emerald-900">
                  {fmtMoney(data.totals.unitCost)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <div className="text-xs text-slate-500 flex items-center justify-center gap-1">
                  <Layers className="h-3 w-3" />المصادر
                </div>
                <div className="text-xs mt-2 flex flex-col items-center gap-0.5">
                  <Badge variant={data.bom ? "default" : "destructive"} className="text-[10px]">
                    BOM {data.bom ? "✓" : "مفقود"}
                  </Badge>
                  <Badge variant={data.routing ? "default" : "outline"} className="text-[10px]">
                    Routing {data.routing ? "✓" : "مفقود"}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          </div>

          {(missingCost || missingDuration || !data.bom) && (
            <Card className="border-amber-300 bg-amber-50">
              <CardContent className="p-3 text-sm text-amber-900 space-y-1">
                {!data.bom && (
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    لا يوجد قالب BOM نشط لهذا المنتج — تكلفة المواد = 0.
                  </div>
                )}
                {missingCost && (
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    بعض المواد لا يوجد لها متوسط تكلفة في المخزون.
                  </div>
                )}
                {missingDuration && (
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    بعض المراحل بدون مدة متوقعة أو مركز عمل بأسعار — لم تُحسب تكلفتها.
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Materials */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="h-4 w-4" />المواد (BOM)
                {data.bom && (
                  <span className="text-xs text-slate-500 font-normal">
                    {data.bom.nameAr} — مقاسة لكل وحدة منتج تام
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.materials.length === 0 ? (
                <div className="p-6 text-center text-slate-500 text-sm">لا توجد مواد</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-100/60 text-xs">
                    <tr>
                      <th className="p-2 text-start">المادة</th>
                      <th className="p-2 text-end">الكمية/وحدة</th>
                      <th className="p-2 text-end">سعر الوحدة</th>
                      <th className="p-2 text-end">التكلفة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.materials.map((m, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-2">
                          <div className="font-bold">{m.nameAr ?? `#${m.itemId}`}</div>
                          {m.sku && <div className="text-[10px] text-slate-500 font-mono">{m.sku}</div>}
                        </td>
                        <td className="p-2 text-end font-mono">{m.qty.toLocaleString("en-US")}</td>
                        <td className={`p-2 text-end font-mono ${m.unitCost === 0 ? "text-rose-600" : ""}`}>
                          {fmtMoney(m.unitCost)}
                        </td>
                        <td className="p-2 text-end font-mono font-bold">{fmtMoney(m.totalCost)}</td>
                      </tr>
                    ))}
                    <tr className="border-t bg-slate-100 font-bold">
                      <td className="p-2" colSpan={3}>إجمالي المواد</td>
                      <td className="p-2 text-end font-mono">{fmtMoney(data.totals.materialsCost)}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {/* Stages */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Factory className="h-4 w-4" />التشغيل (Routing)
                {data.routing && (
                  <span className="text-xs text-slate-500 font-normal">
                    {data.routing.nameAr}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.stages.length === 0 ? (
                <div className="p-6 text-center text-slate-500 text-sm">
                  {data.routing ? "لا توجد مراحل" : "لا يوجد قالب مراحل نشط لهذا المنتج"}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-100/60 text-xs">
                    <tr>
                      <th className="p-2 text-center w-8">#</th>
                      <th className="p-2 text-start">المرحلة</th>
                      <th className="p-2 text-start">مركز العمل</th>
                      <th className="p-2 text-end">المدة (د)</th>
                      <th className="p-2 text-end">عمالة</th>
                      <th className="p-2 text-end">مصاريف</th>
                      <th className="p-2 text-end">إجمالي المرحلة</th>
                      <th className="p-2 text-center">المصدر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stages.map((s) => (
                      <tr key={s.stageId} className="border-t">
                        <td className="p-2 text-center text-slate-500">{s.sequence}</td>
                        <td className="p-2 font-bold">{s.nameAr}</td>
                        <td className="p-2 text-xs">{s.workCenterNameAr ?? "—"}</td>
                        <td className="p-2 text-end font-mono">{s.durationMinutes ?? "—"}</td>
                        <td className="p-2 text-end font-mono">{fmtMoney(s.laborCost)}</td>
                        <td className="p-2 text-end font-mono">{fmtMoney(s.overheadCost)}</td>
                        <td className="p-2 text-end font-mono font-bold">{fmtMoney(s.stageCost)}</td>
                        <td className="p-2 text-center">
                          {s.source === "expectedCost" && (
                            <Badge variant="secondary" className="text-[10px] gap-1">
                              <Settings className="h-3 w-3" />يدوي
                            </Badge>
                          )}
                          {s.source === "rates" && (
                            <Badge className="text-[10px] bg-blue-100 text-blue-800 hover:bg-blue-100 gap-1">
                              <Wrench className="h-3 w-3" />أسعار م.ع
                            </Badge>
                          )}
                          {s.source === "none" && (
                            <Badge variant="destructive" className="text-[10px]">بدون</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t bg-slate-100 font-bold">
                      <td className="p-2" colSpan={4}>إجمالي التشغيل</td>
                      <td className="p-2 text-end font-mono">{fmtMoney(data.totals.laborCost)}</td>
                      <td className="p-2 text-end font-mono">{fmtMoney(data.totals.overheadCost)}</td>
                      <td className="p-2 text-end font-mono">{fmtMoney(data.totals.operatingCost)}</td>
                      <td className="p-2"></td>
                    </tr>
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {/* Grand total */}
          <Card className="border-emerald-400 bg-emerald-50">
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <DollarSign className="h-6 w-6 text-emerald-700" />
                  <div>
                    <div className="text-sm text-emerald-700">تكلفة وحدة المنتج التام</div>
                    <div className="text-xs text-emerald-600">{data.product.nameAr}</div>
                  </div>
                </div>
                <div className="text-3xl font-bold font-mono text-emerald-900">
                  {fmtMoney(data.totals.unitCost)}
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
        </TabsContent>
        <TabsContent value="actual" className="space-y-4">
          <ReportFilters from={from} to={to} branchId={branchId} branches={branches}
            onFrom={setFrom} onTo={setTo} onBranch={setBranchId}
            onRefresh={loadReports} loading={reportLoading} onExport={()=>exportCsv("costs")}/>
          <div className="grid md:grid-cols-3 gap-3">
            {(aggregate?.orders??[]).map((row:any)=><Card key={row.status}><CardContent className="p-3">
              <div className="text-xs text-slate-500">{row.status} — {row.orders} أمر</div>
              <div className="font-mono font-bold">{fmtMoney(Number(row.actual))}</div>
              <div className="text-xs">معياري {fmtMoney(Number(row.planned))} • انحراف {fmtMoney(Number(row.variance))}</div>
            </CardContent></Card>)}
          </div>
          <Card><CardHeader><CardTitle className="text-base">تكلفة المنتجات الفعلية والانحراف</CardTitle></CardHeader>
            <CardContent className="p-0"><ReportTable headers={["المنتج","الكمية المنتجة","المعياري","الفعلي","الانحراف","تكلفة الوحدة"]}
              rows={(aggregate?.products??[]).map((x:any)=>[x.productName??`#${x.productItemId}`,x.producedQty,x.standardCost,x.actualCost,x.variance,x.actualUnitCost])}/></CardContent></Card>
          <Card><CardHeader><CardTitle className="text-base">مصادر التكلفة وتوجيهها</CardTitle></CardHeader>
            <CardContent className="p-0"><ReportTable headers={["نوع المصدر","المعالجة","عدد اللقطات","المبلغ"]}
              rows={(aggregate?.sources??[]).map((x:any)=>[x.sourceType,x.treatment,x.allocations,x.amount])}/></CardContent></Card>
        </TabsContent>
        <TabsContent value="sales" className="space-y-4">
          <ReportFilters from={from} to={to} branchId={branchId} branches={branches}
            onFrom={setFrom} onTo={setTo} onBranch={setBranchId}
            onRefresh={loadReports} loading={reportLoading} onExport={()=>exportCsv("sales")}/>
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            الإيراد أدناه محقق من فواتير البيع والمرتجعات المُرحّلة فقط وعلى مستوى المنتج والفترة.
            هامش الربح وتكاليف التشغيل والتمويل غير متاحة بأمان لأن سطور البيع لا تحفظ رابط التشغيلة/أمر الإنتاج؛ لن ينسب النظام تكلفة مختلقة.
          </div>
          <Card><CardHeader><CardTitle className="text-base">المبيعات والمرتجعات المحققة</CardTitle></CardHeader>
            <CardContent className="p-0"><ReportTable headers={["المنتج","مباع","مرتجع","صافي الكمية","إيراد البيع","إيراد المرتجع","صافي الإيراد","الربحية"]}
              rows={(profitability?.products??[]).map((x:any)=>[x.productName??`#${x.itemId}`,x.postedSalesQty,x.postedReturnQty,x.netSoldQty,x.postedSalesRevenue,x.postedReturnRevenue,x.realizedNetRevenue,"غير متاحة — ينقص رابط تكلفة التشغيلة"])}/></CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ReportFilters(props:any) {
  return <Card><CardContent className="p-3 flex flex-wrap gap-3 items-end">
    <div><Label>من</Label><DateField value={props.from} onChange={(e)=>props.onFrom(e.target.value)}/></div>
    <div><Label>إلى</Label><DateField value={props.to} onChange={(e)=>props.onTo(e.target.value)}/></div>
    <div className="min-w-56"><Label>الفرع</Label><SearchCombobox value={props.branchId} onValueChange={props.onBranch}
      items={[{value:"",label:"كل الفروع المسموحة"},...props.branches.map((b:any)=>({value:String(b.id),label:b.nameAr||b.nameEn||`#${b.id}`}))]}/></div>
    <Button variant="outline" onClick={props.onRefresh} disabled={props.loading}><RefreshCw className={`h-4 w-4 me-1 ${props.loading?"animate-spin":""}`}/>تحديث</Button>
    <Button variant="outline" onClick={props.onExport}><Download className="h-4 w-4 me-1"/>CSV</Button>
  </CardContent></Card>;
}

function ReportTable({headers,rows}:{headers:string[];rows:unknown[][]}) {
  return <div className="overflow-x-auto"><table className="w-full text-sm">
    <thead className="bg-slate-100"><tr>{headers.map(h=><th key={h} className="p-2 text-start">{h}</th>)}</tr></thead>
    <tbody>{rows.length===0?<tr><td colSpan={headers.length} className="p-6 text-center text-slate-500">لا توجد بيانات ضمن النطاق.</td></tr>:
      rows.map((r,i)=><tr key={i} className="border-t">{r.map((v,j)=><td key={j} className="p-2">{v==null?"—":typeof v==="number"?v.toLocaleString("en-US",{maximumFractionDigits:2}):String(v)}</td>)}</tr>)}</tbody>
  </table></div>;
}
