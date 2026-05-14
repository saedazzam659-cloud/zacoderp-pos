import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Activity, AlertTriangle, CheckCircle2, Globe2, TrendingUp, ArrowLeft } from "lucide-react";
import { useLocation } from "wouter";

const API = ((import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "").replace(/\/$/, "");

function api<T>(path: string): Promise<T> {
  const token = localStorage.getItem("zatca_token");
  const acting = localStorage.getItem("zatca_acting_company_id");
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (acting) headers["x-acting-company-id"] = acting;
  return fetch(`${API}${path}`, { headers, credentials: "include" })
    .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json() as Promise<T>; });
}

interface ClientRow {
  id: number; nameAr: string; nameEn: string | null;
  env: "sandbox" | "production"; status: string;
  monthlyQuota: number; invoicesThisMonth: number;
  lastInvoiceAt: string | null;
  last30: number; cleared30: number; rejected30: number; totalSar30: string;
}

export default function GatewayOverview() {
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery<{ clients: ClientRow[] }>({
    queryKey: ["gateway-overview"],
    queryFn: () => api<{ clients: ClientRow[] }>("/api/admin/gateway-clients/overview/clients-summary"),
    refetchInterval: 30_000,
  });

  const clients = data?.clients ?? [];
  const totals = clients.reduce((acc, c) => ({
    invoices: acc.invoices + c.last30,
    cleared:  acc.cleared  + c.cleared30,
    rejected: acc.rejected + c.rejected30,
    sar:      acc.sar      + Number(c.totalSar30 || 0),
    atRisk:   acc.atRisk   + (c.invoicesThisMonth / Math.max(1, c.monthlyQuota) >= 0.8 ? 1 : 0),
  }), { invoices: 0, cleared: 0, rejected: 0, sar: 0, atRisk: 0 });

  const successRate = totals.invoices > 0 ? (totals.cleared / totals.invoices) * 100 : 0;

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6" dir="rtl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/admin/gateway-clients")}>
          <ArrowLeft className="h-4 w-4 ml-1" />
          عودة لقائمة العملاء
        </Button>
        <h1 className="text-2xl font-bold">نظرة عامة على بوابة زاتكا — آخر 30 يوم</h1>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi icon={Globe2} label="عدد العملاء" value={clients.length.toLocaleString("ar-EG")} accent="bg-indigo-50 text-indigo-700" />
        <Kpi icon={Activity} label="فواتير 30 يوم" value={totals.invoices.toLocaleString("ar-EG")} accent="bg-blue-50 text-blue-700" />
        <Kpi icon={CheckCircle2} label="نجاح الإرسال" value={`${successRate.toFixed(1)}%`} accent="bg-emerald-50 text-emerald-700" />
        <Kpi icon={TrendingUp} label="إجمالي SAR" value={totals.sar.toLocaleString("ar-EG", { maximumFractionDigits: 0 })} accent="bg-amber-50 text-amber-700" mono />
        <Kpi icon={AlertTriangle} label="عملاء قارَبوا الحصة" value={totals.atRisk.toLocaleString("ar-EG")} accent="bg-rose-50 text-rose-700" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>تفاصيل لكل عميل</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground">جاري التحميل…</div>
          ) : clients.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">لا يوجد عملاء بعد.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-right">
                    <th className="p-3">العميل</th>
                    <th className="p-3">البيئة</th>
                    <th className="p-3">الحالة</th>
                    <th className="p-3">حصة الشهر</th>
                    <th className="p-3">فواتير 30 يوم</th>
                    <th className="p-3">معدل النجاح</th>
                    <th className="p-3">إجمالي SAR (30 يوم)</th>
                    <th className="p-3">آخر إرسال</th>
                    <th className="p-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map(c => {
                    const rate = c.last30 > 0 ? (c.cleared30 / c.last30) * 100 : 0;
                    const quotaPct = (c.invoicesThisMonth / Math.max(1, c.monthlyQuota)) * 100;
                    return (
                      <tr key={c.id} className="border-t hover:bg-muted/20">
                        <td className="p-3 font-medium">{c.nameAr}{c.nameEn ? <div className="text-xs text-muted-foreground">{c.nameEn}</div> : null}</td>
                        <td className="p-3">
                          <Badge variant="outline" className={c.env === "production" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-sky-50 text-sky-700 border-sky-200"}>
                            {c.env === "production" ? "إنتاج" : "تجربة"}
                          </Badge>
                        </td>
                        <td className="p-3">
                          <Badge variant="outline" className={c.status === "active" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : c.status === "suspended" ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-amber-50 text-amber-700 border-amber-200"}>
                            {c.status === "active" ? "مفعّل" : c.status === "suspended" ? "موقوف" : "بانتظار"}
                          </Badge>
                        </td>
                        <td className="p-3 min-w-[180px]">
                          <div className="flex items-center gap-2">
                            <Progress value={Math.min(100, quotaPct)} className="h-2 flex-1" />
                            <span className="text-xs whitespace-nowrap font-mono">{c.invoicesThisMonth.toLocaleString("ar-EG")} / {c.monthlyQuota.toLocaleString("ar-EG")}</span>
                          </div>
                        </td>
                        <td className="p-3 font-mono">{c.last30.toLocaleString("ar-EG")}</td>
                        <td className="p-3">
                          <span className={rate >= 90 ? "text-emerald-700 font-semibold" : rate >= 60 ? "text-amber-700" : c.last30 > 0 ? "text-rose-700 font-semibold" : "text-muted-foreground"}>
                            {c.last30 > 0 ? `${rate.toFixed(1)}%` : "—"}
                          </span>
                          {c.rejected30 > 0 && <div className="text-xs text-rose-600">{c.rejected30} مرفوضة</div>}
                        </td>
                        <td className="p-3 font-mono">{Number(c.totalSar30 || 0).toLocaleString("ar-EG", { maximumFractionDigits: 2 })}</td>
                        <td className="p-3 text-xs text-muted-foreground">{c.lastInvoiceAt ? new Date(c.lastInvoiceAt).toLocaleString("ar-EG") : "—"}</td>
                        <td className="p-3">
                          <Button variant="ghost" size="sm" onClick={() => window.open(`/admin/gateway-clients/${c.id}/reports`, "_blank")}>
                            تقارير
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, accent, mono }: { icon: typeof Activity; label: string; value: string; accent: string; mono?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${accent}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className={`text-lg font-bold truncate ${mono ? "font-mono" : ""}`}>{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
