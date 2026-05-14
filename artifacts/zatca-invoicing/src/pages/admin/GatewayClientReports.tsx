/**
 * Phase 2 — Gateway client reports dashboard.
 * Standalone page (separate from the GatewayClients modal so SuperAdmins
 * can drill into one client's data without losing the dialog state).
 *
 * Backend: /api/admin/gateway-clients/:id/reports/summary
 *          /api/admin/gateway-clients/:id/reports/export.csv
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Download, ArrowRight, TrendingUp, FileSpreadsheet, AlertTriangle, ShieldCheck } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Row = { bucket: string; count: number; total: number; vat: number; cleared: number; rejected: number; warned: number };
type StatusRow = { status: string; count: number; total: number };
type CustomerRow = { buyer: string; count: number; total: number };
type Summary = {
  rangeMonths: number; since: string;
  monthly: Row[]; byStatus: StatusRow[]; topCustomers: CustomerRow[];
  overall: { count: number; total: number; vat: number; cleared: number; rejected: number } | null;
};

const STATUS_CLR: Record<string, string> = {
  received: "#0ea5e9", queued_for_zatca: "#f59e0b",
  cleared: "#10b981", sandbox_cleared: "#8b5cf6",
  manual_ack: "#f59e0b", warning: "#f97316", sandbox_warning: "#fbbf24",
  rejected: "#e11d48", failed: "#e11d48", submission_failed: "#dc2626",
};
const STATUS_AR: Record<string, string> = {
  received: "مستلمة", queued_for_zatca: "بالانتظار",
  cleared: "مقبولة", sandbox_cleared: "نجاح (تجربة)",
  manual_ack: "إقرار يدوي", warning: "تحذير", sandbox_warning: "تحذير (تجربة)",
  rejected: "مرفوضة", failed: "فشل", submission_failed: "فشل الإرسال",
};

async function api<T>(path: string): Promise<T> {
  const token = localStorage.getItem("zatca_token");
  const acting = localStorage.getItem("zatca_acting_company_id");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (acting) headers["x-acting-company-id"] = acting;
  const r = await fetch(API + path, { headers });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}

export default function GatewayClientReports() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [months, setMonths] = useState(12);
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const { data, isLoading, error } = useQuery<Summary>({
    queryKey: ["gateway-client-reports", id, months],
    queryFn: () => api(`/api/admin/gateway-clients/${id}/reports/summary?months=${months}`),
    enabled: Number.isFinite(id),
  });
  const { data: clientResp } = useQuery<{ client: { nameAr: string; vatNumber: string; zatcaEnv: string } }>({
    queryKey: ["gateway-client-min", id],
    queryFn: () => api(`/api/admin/gateway-clients/${id}`),
    enabled: Number.isFinite(id),
  });
  const client = clientResp?.client;

  const downloadCsv = () => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from); if (to) qs.set("to", to); if (statusFilter) qs.set("status", statusFilter);
    const url = `${API}/api/admin/gateway-clients/${id}/reports/export.csv${qs.toString() ? `?${qs}` : ""}`;
    // Auth header required — use blob fetch + save
    const token = localStorage.getItem("zatca_token");
    const acting = localStorage.getItem("zatca_acting_company_id");
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (acting) headers["x-acting-company-id"] = acting;
    fetch(url, { headers }).then(r => r.blob()).then(blob => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `gateway-${id}-${new Date().toISOString().slice(0,10)}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
    });
  };

  const monthlyChart = useMemo(() => (data?.monthly ?? []).map(r => ({
    bucket: r.bucket,
    "إجمالي": Math.round(r.total),
    "ضريبة": Math.round(r.vat),
    "ناجحة": r.cleared,
    "مرفوضة": r.rejected,
  })), [data]);

  if (isLoading) return <div className="flex justify-center items-center min-h-[60vh]"><Loader2 className="h-10 w-10 animate-spin text-indigo-600" /></div>;
  if (error) return <div className="p-8 text-center text-rose-600">خطأ: {(error as Error).message}</div>;
  if (!data) return null;

  const overall = data.overall ?? { count: 0, total: 0, vat: 0, cleared: 0, rejected: 0 };
  const successRate = overall.count ? Math.round((overall.cleared / overall.count) * 100) : 0;

  return (
    <div className="container mx-auto p-6 space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <Link href="/admin/gateway-clients" className="text-sm text-indigo-600 hover:underline flex items-center gap-1 mb-1">
            <ArrowRight className="h-4 w-4 rtl:rotate-180" />
            رجوع لعملاء البوابة
          </Link>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-indigo-600" />
            تقارير {client?.nameAr ?? `العميل #${id}`}
          </h1>
          {client && (
            <div className="text-xs text-slate-500 font-mono mt-1">
              VAT: {client.vatNumber}
              <Badge variant="outline" className="mr-2">{client.zatcaEnv === "production" ? "إنتاج" : "تجريبي"}</Badge>
            </div>
          )}
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label className="text-[11px] text-slate-500 block">آخر</label>
            <select value={months} onChange={e => setMonths(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
              <option value={3}>3 أشهر</option>
              <option value={6}>6 أشهر</option>
              <option value={12}>سنة</option>
              <option value={24}>سنتين</option>
              <option value={36}>3 سنوات</option>
            </select>
          </div>
          <Button onClick={downloadCsv} className="bg-emerald-600 hover:bg-emerald-700">
            <FileSpreadsheet className="h-4 w-4 ml-1" />
            تصدير CSV
          </Button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KPI label="عدد الفواتير" value={overall.count.toLocaleString("ar-EG")} cls="bg-sky-50 text-sky-800 border-sky-200" />
        <KPI label="إجمالي المبالغ (ر.س)" value={overall.total.toLocaleString("ar-EG", { maximumFractionDigits: 0 })} cls="bg-indigo-50 text-indigo-800 border-indigo-200" />
        <KPI label="إجمالي الضريبة (ر.س)" value={overall.vat.toLocaleString("ar-EG", { maximumFractionDigits: 0 })} cls="bg-amber-50 text-amber-800 border-amber-200" />
        <KPI label="ناجحة" value={overall.cleared.toLocaleString("ar-EG")} icon={<ShieldCheck className="h-4 w-4" />} cls="bg-emerald-50 text-emerald-800 border-emerald-200" />
        <KPI label={`نسبة النجاح ${successRate}%`} value={`${successRate}%`} icon={<AlertTriangle className="h-4 w-4" />} cls={successRate >= 90 ? "bg-emerald-50 text-emerald-800 border-emerald-200" : successRate >= 70 ? "bg-amber-50 text-amber-800 border-amber-200" : "bg-rose-50 text-rose-800 border-rose-200"} />
      </div>

      {/* Monthly bar chart */}
      <Card>
        <CardHeader><CardTitle className="text-base">الإجمالي الشهري</CardTitle></CardHeader>
        <CardContent>
          {monthlyChart.length === 0 ? (
            <div className="py-12 text-center text-slate-400 text-sm">لا توجد بيانات في الفترة المختارة</div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={monthlyChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="إجمالي" fill="#6366f1" />
                <Bar dataKey="ضريبة" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Status pie */}
        <Card>
          <CardHeader><CardTitle className="text-base">توزيع الحالات</CardTitle></CardHeader>
          <CardContent>
            {data.byStatus.length === 0 ? (
              <div className="py-12 text-center text-slate-400 text-sm">لا توجد بيانات</div>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie data={data.byStatus.map(s => ({ name: STATUS_AR[s.status] ?? s.status, value: s.count, status: s.status }))}
                       dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={(e) => `${e.name}: ${e.value}`}>
                    {data.byStatus.map((s, i) => <Cell key={i} fill={STATUS_CLR[s.status] ?? "#94a3b8"} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Top customers */}
        <Card>
          <CardHeader><CardTitle className="text-base">أعلى 10 عملاء (حسب المبلغ)</CardTitle></CardHeader>
          <CardContent>
            {data.topCustomers.length === 0 ? (
              <div className="py-12 text-center text-slate-400 text-sm">لا توجد بيانات</div>
            ) : (
              <div className="space-y-1.5 max-h-[260px] overflow-y-auto">
                {data.topCustomers.map((c, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 text-sm border-b py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-xs text-slate-400 w-5">{i + 1}</span>
                      <span className="truncate font-medium">{c.buyer}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-slate-500">{c.count} فاتورة</span>
                      <span className="font-mono text-emerald-700 font-semibold">{c.total.toLocaleString("ar-EG", { maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Custom CSV export filter */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Download className="h-4 w-4" /> تصدير مفصّل</CardTitle></CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-slate-500 block mb-1">من تاريخ</label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">إلى تاريخ</label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">الحالات (مفصولة بفاصلة)</label>
              <Input value={statusFilter} onChange={e => setStatusFilter(e.target.value)} placeholder="cleared,sandbox_cleared" dir="ltr" />
            </div>
            <div className="flex items-end">
              <Button onClick={downloadCsv} className="bg-emerald-600 hover:bg-emerald-700 w-full">
                <FileSpreadsheet className="h-4 w-4 ml-1" /> تصدير CSV
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">CSV يُصدَّر بترميز UTF-8 مع BOM ليُعرض النص العربي بشكل صحيح في Excel.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function KPI({ label, value, cls, icon }: { label: string; value: string | number; cls: string; icon?: React.ReactNode }) {
  return (
    <div className={`rounded-xl border p-4 ${cls}`}>
      <div className="text-[11px] opacity-80 flex items-center gap-1">{icon}{label}</div>
      <div className="text-2xl font-bold font-mono mt-1 leading-none">{value}</div>
    </div>
  );
}
