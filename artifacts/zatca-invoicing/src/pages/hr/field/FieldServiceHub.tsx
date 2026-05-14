import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { fieldApi } from "@/lib/fieldServiceApi";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  MapPin, Smartphone, ClipboardList, Wrench, BarChart3, Activity, Building2,
  Clock, AlertTriangle, CheckCircle2, Users,
} from "lucide-react";

export default function FieldServiceHub() {
  const { data: sla } = useQuery({ queryKey: ["fsm-sla"], queryFn: () => fieldApi.sla({}) });
  const { data: live } = useQuery({ queryKey: ["fsm-live"], queryFn: () => fieldApi.liveTracking(), refetchInterval: 30_000 });
  const { data: summary } = useQuery({ queryKey: ["fsm-summary"], queryFn: () => fieldApi.summary({}) });

  const cards = [
    { href: "/hr/field/check-in",  icon: Smartphone,   title: "تسجيل زيارة من الجوال",  desc: "بدء/إنهاء زيارة للموقع مع GPS", color: "from-emerald-500 to-teal-600" },
    { href: "/hr/field/locations", icon: MapPin,       title: "سجل المواقع الميدانية",  desc: "مكاتب، عملاء، مشاريع، أصول", color: "from-blue-500 to-cyan-600" },
    { href: "/hr/field/plans",     icon: ClipboardList,title: "خطط الزيارات اليومية",   desc: "جدول الجولات للمندوبين والفنيين", color: "from-violet-500 to-purple-600" },
    { href: "/hr/field/tickets",   icon: Wrench,       title: "تذاكر الخدمة (FSM)",     desc: "أوامر صيانة مع SLA", color: "from-amber-500 to-orange-600" },
    { href: "/hr/field/tracking",  icon: Activity,     title: "التتبع المباشر",         desc: "آخر موقع لكل موظف ميداني", color: "from-rose-500 to-red-600" },
    { href: "/hr/field/reports",   icon: BarChart3,    title: "التقارير ومؤشرات الأداء", desc: "زيارات، أوقات، انحرافات SLA", color: "from-slate-500 to-slate-700" },
  ];

  const stats = [
    { icon: Wrench,         label: "تذاكر مفتوحة",     value: sla?.summary.open ?? "—",            color: "text-amber-600" },
    { icon: AlertTriangle,  label: "خرق SLA الاستجابة", value: sla?.summary.respBreached ?? 0,      color: "text-rose-600" },
    { icon: AlertTriangle,  label: "خرق SLA الحل",     value: sla?.summary.resBreached ?? 0,       color: "text-rose-600" },
    { icon: Clock,          label: "متوسط الاستجابة (د)", value: sla?.summary.avgResponseMin ?? 0, color: "text-blue-600" },
    { icon: CheckCircle2,   label: "متوسط الحل (د)",    value: sla?.summary.avgResolutionMin ?? 0, color: "text-emerald-600" },
    { icon: Users,          label: "موظفون نشطون اليوم", value: live?.length ?? 0,                  color: "text-violet-600" },
    { icon: Activity,       label: "زيارات (آخر ٧ أيام)", value: summary?.rows.reduce((s, r) => s + r.totalVisits, 0) ?? 0, color: "text-indigo-600" },
  ];

  return (
    <div className="p-6 space-y-6" dir="rtl" data-testid="page-field-hub">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5"><Building2 className="h-7 w-7 text-primary" /></div>
          إدارة الخدمة الميدانية (FSM)
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          نظام موحّد لمهندسي المشاريع، مندوبي المبيعات، وفنيي الصيانة — وفق المعايير الدولية
        </p>
      </div>

      {/* SLA + activity stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {stats.map((s, i) => {
          const Icon = s.icon;
          return (
            <Card key={i} className="p-4">
              <div className="flex items-start gap-2">
                <Icon className={`h-5 w-5 ${s.color}`} />
                <div className="flex-1">
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                  <div className="text-xl font-bold mt-0.5">{String(s.value)}</div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((c, i) => {
          const Icon = c.icon;
          return (
            <Link key={i} href={c.href}>
              <Card className={`p-5 cursor-pointer hover:shadow-lg transition-all bg-gradient-to-br ${c.color} text-white`}>
                <div className="flex items-start gap-3">
                  <Icon className="h-8 w-8 opacity-90" />
                  <div>
                    <h3 className="font-semibold text-lg">{c.title}</h3>
                    <p className="text-sm opacity-80 mt-1">{c.desc}</p>
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>

      {/* Active employees today */}
      {live && live.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold mb-3">الفريق الميداني اليوم</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {live.map((r) => (
              <div key={r.employee_id} className="flex items-center gap-3 p-2 rounded border">
                <div className="flex-1">
                  <div className="font-medium">{r.employee_name}</div>
                  <div className="text-xs text-muted-foreground">{r.location_name ?? "—"}</div>
                </div>
                <Badge variant={r.status === "open" ? "default" : "secondary"}>
                  {r.status === "open" ? "في الميدان" : "أنهى"}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
