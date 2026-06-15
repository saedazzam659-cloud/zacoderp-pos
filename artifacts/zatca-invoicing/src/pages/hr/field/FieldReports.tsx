import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fieldApi } from "@/lib/fieldServiceApi";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { BarChart3, Clock, AlertTriangle, CheckCircle2, Star } from "lucide-react";
import { DateField } from "@/components/ui/date-field";

export default function FieldReports() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);

  const { data: summary } = useQuery({ queryKey: ["fsm-summary", from, to], queryFn: () => fieldApi.summary({ from, to }) });
  const { data: sla }     = useQuery({ queryKey: ["fsm-sla-rep", from, to], queryFn: () => fieldApi.sla({ from, to }) });

  return (
    <div className="p-6 space-y-4" dir="rtl" data-testid="page-field-reports">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><BarChart3 className="h-6 w-6" /> تقارير الخدمة الميدانية</h1>
          <p className="text-sm text-muted-foreground mt-1">مؤشرات أداء الزيارات وSLA لكل موظف</p>
        </div>
        <div className="flex gap-2 items-end">
          <div><Label className="text-xs">من</Label><DateField value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" /></div>
          <div><Label className="text-xs">إلى</Label><DateField value={to} onChange={(e) => setTo(e.target.value)} className="w-36" /></div>
        </div>
      </div>

      {/* SLA KPI */}
      {sla && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {[
            { i: BarChart3,      l: "إجمالي التذاكر", v: sla.summary.total, c: "text-blue-600" },
            { i: AlertTriangle,  l: "مفتوحة",         v: sla.summary.open,  c: "text-amber-600" },
            { i: CheckCircle2,   l: "محلولة",         v: sla.summary.resolved, c: "text-emerald-600" },
            { i: AlertTriangle,  l: "خرق استجابة",    v: sla.summary.respBreached, c: "text-rose-600" },
            { i: AlertTriangle,  l: "خرق حل",         v: sla.summary.resBreached,  c: "text-rose-600" },
            { i: Clock,          l: "متوسط استجابة (د)", v: sla.summary.avgResponseMin, c: "text-blue-600" },
            { i: Star,           l: "متوسط التقييم", v: sla.summary.avgRating?.toFixed(1) ?? "0", c: "text-amber-600" },
          ].map((s, idx) => {
            const Icon = s.i;
            return (
              <Card key={idx} className="p-3">
                <div className="flex items-start gap-2">
                  <Icon className={`h-4 w-4 ${s.c}`} />
                  <div>
                    <div className="text-xs text-muted-foreground">{s.l}</div>
                    <div className="text-lg font-bold">{String(s.v)}</div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* SLA by priority */}
      {sla && sla.byPriority.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold mb-2">SLA حسب الأولوية</h3>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-right p-2">الأولوية</th>
                <th className="text-right p-2">إجمالي</th>
                <th className="text-right p-2">خرق استجابة</th>
                <th className="text-right p-2">خرق حل</th>
              </tr>
            </thead>
            <tbody>
              {sla.byPriority.map((r) => (
                <tr key={r.priority} className="border-t">
                  <td className="p-2"><Badge variant="outline">{r.priority}</Badge></td>
                  <td className="p-2">{r.total}</td>
                  <td className="p-2">{r.respBreached}</td>
                  <td className="p-2">{r.resBreached}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Per-employee summary */}
      {summary && (
        <Card className="p-4">
          <h3 className="font-semibold mb-2">ملخص الزيارات لكل موظف</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-right p-2">الموظف</th>
                  <th className="text-right p-2">إجمالي زيارات</th>
                  <th className="text-right p-2">مكتملة</th>
                  <th className="text-right p-2">مفتوحة</th>
                  <th className="text-right p-2">إجمالي الدقائق</th>
                  <th className="text-right p-2">مواقع فريدة</th>
                  <th className="text-right p-2">زيارات بحالة شاذة</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((r) => (
                  <tr key={r.employeeId} className="border-t">
                    <td className="p-2 font-medium">{r.employeeName}</td>
                    <td className="p-2">{r.totalVisits}</td>
                    <td className="p-2">{r.completedVisits}</td>
                    <td className="p-2">{r.openVisits}</td>
                    <td className="p-2">{r.totalMinutes}</td>
                    <td className="p-2">{r.uniqueLocations}</td>
                    <td className="p-2">{r.flaggedVisits > 0 ? <Badge variant="destructive">{r.flaggedVisits}</Badge> : "0"}</td>
                  </tr>
                ))}
                {summary.rows.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">لا توجد بيانات في الفترة المحددة</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
