import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { BarChart3, Package, Wrench, ArrowRightLeft, Trash2, AlertTriangle, Users, Search, Printer } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { fmt2 } from "@/lib/format";
import { employeesApi } from "@/lib/employeesApi";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Summary = {
  totalAssets: number; totalPurchase: number; totalBookValue: number;
  totalAccumulatedDepreciation: number; totalMaintenanceCost: number;
  maintenanceCount: number; transfersCount: number; disposalsCount: number;
  depreciationRuns: number; expiringInsurance: number;
  byStatus: Record<string, number>;
};

const STATUS_LABELS: Record<string,string> = {
  active:"نشط", in_maintenance:"تحت الصيانة", transferred:"منقول",
  sold:"مباع", scrapped:"مخرّد", fully_depreciated:"مهلك بالكامل",
};

export default function FaReports() {
  const { user, token } = useAuth() as any;
  const cid = user?.companyId;
  const headers = { Authorization: `Bearer ${token}` };

  const { data: s, isLoading } = useQuery<Summary>({
    queryKey:["fa/summary", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/summary?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });

  // ── الأصول المرتبطة بالموظفين — client-side join of the assets list
  //    (custodianEmployeeId) against the HR employees list.
  const { data: assets = [] } = useQuery<any[]>({
    queryKey:["fa/assets", cid],
    queryFn: async () => { const j = await (await fetch(`${API}/api/fixed-assets/assets?companyId=${cid}`, { headers })).json(); return Array.isArray(j) ? j : []; },
    enabled: !!cid,
  });
  const { data: employees = [] } = useQuery<any[]>({
    queryKey:["employees"],
    queryFn: () => employeesApi.list(),
    enabled: !!cid,
  });
  const [empSearch, setEmpSearch] = useState("");

  const byEmployee = useMemo(() => {
    const empById = new Map<number, any>(employees.map((e: any) => [Number(e.id), e]));
    const groups = new Map<number, { emp: any | null; assets: any[] }>();
    let unassigned = 0;
    for (const a of assets) {
      const eid = a.custodianEmployeeId ? Number(a.custodianEmployeeId) : null;
      if (!eid) { unassigned++; continue; }
      if (!groups.has(eid)) groups.set(eid, { emp: empById.get(eid) ?? null, assets: [] });
      groups.get(eid)!.assets.push(a);
    }
    const q = empSearch.trim().toLowerCase();
    let list = Array.from(groups.entries()).map(([eid, g]) => ({ eid, ...g }));
    if (q) {
      list = list.filter(({ emp, assets: as_ }) =>
        (emp?.nameAr ?? "").toLowerCase().includes(q) ||
        (emp?.nameEn ?? "").toLowerCase().includes(q) ||
        (emp?.code ?? "").toLowerCase().includes(q) ||
        as_.some((a) => (a.nameAr ?? "").toLowerCase().includes(q) || (a.code ?? "").toLowerCase().includes(q)));
    }
    list.sort((x, y) => (x.emp?.code ?? "").localeCompare(y.emp?.code ?? ""));
    return { list, unassigned };
  }, [assets, employees, empSearch]);

  // Escape every DB-sourced string before it enters the print HTML — asset and
  // employee names are user input and would otherwise be an XSS sink.
  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

  const printByEmployee = () => {
    const w = window.open("", "_blank");
    if (!w) return;
    const rows = byEmployee.list.map(({ emp, eid, assets: as_ }) => {
      const title = emp ? `${esc(emp.code)} — ${esc(emp.nameAr ?? emp.nameEn)}` : `موظف #${esc(eid)} (محذوف)`;
      const lines = as_.map((a) =>
        `<tr><td>${esc(a.code)}</td><td>${esc(a.nameAr)}</td><td>${esc(STATUS_LABELS[a.status] ?? a.status)}</td><td class="num">${fmt2(Number(a.bookValue ?? a.purchaseCost ?? 0))}</td></tr>`).join("");
      return `<h3>${title} <small>(${as_.length})</small></h3>
        <table><thead><tr><th>الكود</th><th>اسم الأصل</th><th>الحالة</th><th>القيمة الدفترية</th></tr></thead><tbody>${lines}</tbody></table>`;
    }).join("");
    w.document.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>الأصول المرتبطة بالموظفين</title>
      <style>body{font-family:Tahoma,Arial,sans-serif;padding:20px}h2{margin:0 0 4px}h3{margin:18px 0 6px;font-size:14px}
      table{width:100%;border-collapse:collapse;font-size:12px}table th,table td{border:1px solid #cbd5e1;padding:4px 8px;text-align:right}
      table th{background:#f1f5f9}td.num{text-align:left;font-family:monospace}small{color:#64748b}</style></head>
      <body><h2>تقرير الأصول المرتبطة بالموظفين</h2><small>${new Date().toLocaleDateString("en-GB")}</small>${rows || "<p>لا توجد أصول مرتبطة بموظفين</p>"}
      <script>window.onload=function(){window.print()}</script></body></html>`);
    w.document.close();
  };

  const card = (label:string, value:string|number, icon:any, color:string) => {
    const Icon = icon;
    return (
      <div className={`border rounded-lg p-4 bg-${color}-50 border-${color}-200`}>
        <div className="flex items-center justify-between">
          <div>
            <div className={`text-xs text-${color}-700`}>{label}</div>
            <div className={`text-xl font-bold mt-1 text-${color}-800 font-mono`}>{value}</div>
          </div>
          <Icon className={`h-8 w-8 text-${color}-400`} />
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-emerald-600" />
          تقارير الأصول الثابتة
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          ملخص شامل: الأصول، الإهلاك، الصيانة، النقل، التخلص، وتنبيهات التأمين
        </p>
      </div>

      {isLoading && <div className="text-center py-8 text-muted-foreground">جاري التحميل…</div>}

      {s && <>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {card("إجمالي الأصول", s.totalAssets, Package, "emerald")}
          {card("قيمة الشراء", `${fmt2(s.totalPurchase)} ر.س`, Package, "blue")}
          {card("القيمة الدفترية", `${fmt2(s.totalBookValue)} ر.س`, Package, "violet")}
          {card("الإهلاك المتراكم", `${fmt2(s.totalAccumulatedDepreciation)} ر.س`, Package, "amber")}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {card("سجلات الصيانة", s.maintenanceCount, Wrench, "orange")}
          {card("تكلفة الصيانة", `${fmt2(s.totalMaintenanceCost)} ر.س`, Wrench, "orange")}
          {card("عمليات النقل", s.transfersCount, ArrowRightLeft, "indigo")}
          {card("عمليات التخلص", s.disposalsCount, Trash2, "rose")}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {card("ترحيلات الإهلاك", s.depreciationRuns, BarChart3, "violet")}
          {card("تأمين قارب على الانتهاء (30 يوم)", s.expiringInsurance, AlertTriangle, "rose")}
        </div>

        {/* ── الأصول المرتبطة بالموظفين ─────────────────────────── */}
        <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
          <div className="px-4 py-2 border-b bg-slate-50 flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
              <Users className="h-4 w-4 text-teal-600" /> الأصول المرتبطة بالموظفين
              <span className="text-xs font-normal text-muted-foreground">({byEmployee.list.length} موظف)</span>
            </div>
            <div className="ms-auto flex items-center gap-2">
              <div className="relative">
                <Search className="h-3.5 w-3.5 absolute start-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input value={empSearch} onChange={(e)=>setEmpSearch(e.target.value)}
                  placeholder="بحث بالموظف أو الأصل…" className="h-8 ps-7 w-52 text-xs" />
              </div>
              <Button size="sm" variant="outline" className="h-8 gap-1" onClick={printByEmployee}>
                <Printer className="h-3.5 w-3.5" /> طباعة
              </Button>
            </div>
          </div>
          <div className="p-4 space-y-4">
            {byEmployee.list.length === 0 && (
              <div className="text-center text-muted-foreground py-4 text-sm">
                لا توجد أصول مرتبطة بموظفين — اربط الموظف من نموذج الأصل (تبويب إضافي / ملاحظات)
              </div>
            )}
            {byEmployee.list.map(({ eid, emp, assets: as_ }) => (
              <div key={eid} className="border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-teal-50/60 border-b flex items-center justify-between">
                  <div className="text-sm font-semibold text-teal-900">
                    {emp ? <>{emp.nameAr || emp.nameEn} <span className="font-mono text-xs text-muted-foreground">({emp.code})</span></> : `موظف #${eid} (محذوف)`}
                    {emp?.jobTitle && <span className="text-xs font-normal text-muted-foreground ms-2">{emp.jobTitle}</span>}
                  </div>
                  <span className="text-xs font-mono bg-white border rounded-full px-2 py-0.5">{as_.length} أصل</span>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 text-slate-600">
                      <th className="text-start px-3 py-1.5">الكود</th>
                      <th className="text-start px-3 py-1.5">اسم الأصل</th>
                      <th className="text-start px-3 py-1.5">الحالة</th>
                      <th className="text-end px-3 py-1.5">القيمة الدفترية</th>
                    </tr>
                  </thead>
                  <tbody>
                    {as_.map((a) => (
                      <tr key={a.id} className="border-t">
                        <td className="px-3 py-1.5 font-mono">{a.code}</td>
                        <td className="px-3 py-1.5">{a.nameAr}</td>
                        <td className="px-3 py-1.5">{STATUS_LABELS[a.status] ?? a.status}</td>
                        <td className="px-3 py-1.5 text-end font-mono">{fmt2(Number(a.bookValue ?? a.purchaseCost ?? 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {byEmployee.unassigned > 0 && (
              <div className="text-[11px] text-muted-foreground">
                {byEmployee.unassigned} أصل غير مرتبط بأي موظف
              </div>
            )}
          </div>
        </div>

        <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
          <div className="px-4 py-2 border-b bg-slate-50 text-sm font-semibold text-slate-800">
            توزيع الأصول حسب الحالة
          </div>
          <div className="p-4">
            {Object.keys(s.byStatus).length === 0 && <div className="text-center text-muted-foreground py-4">لا توجد بيانات</div>}
            {Object.entries(s.byStatus).map(([k,v]) => {
              const pct = s.totalAssets > 0 ? (v / s.totalAssets) * 100 : 0;
              return (
                <div key={k} className="mb-3">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-semibold">{STATUS_LABELS[k] || k}</span>
                    <span className="font-mono text-muted-foreground">{v} ({pct.toFixed(1)}%)</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </>}
    </div>
  );
}
