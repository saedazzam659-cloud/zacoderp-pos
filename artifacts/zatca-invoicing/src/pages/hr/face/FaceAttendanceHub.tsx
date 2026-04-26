import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { faceApi, type FaceAnalytics } from "@/lib/faceAttendanceApi";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ScanFace, Camera, Settings2, ScrollText, Tv, Sparkles,
  Users, UserCheck, Clock, AlertTriangle, TrendingUp,
} from "lucide-react";

function computeInsight(a: FaceAnalytics | undefined): string {
  if (!a) return "";
  const parts: string[] = [];
  const enrollPct = (a.enrollmentRate * 100).toFixed(0);
  const presPct = (a.presenceRate * 100).toFixed(0);
  if (a.totalEmployees === 0) {
    return "لا يوجد موظفون نشطون بعد. ابدأ بإضافة الموظفين ثم سجّل بصمات وجوههم لتفعيل الحضور الذكي.";
  }
  if (a.enrolledEmployees === 0) {
    parts.push(`لديك ${a.totalEmployees} موظف نشط، لكن لم يتم تسجيل أي بصمة وجه بعد.`);
    parts.push("ابدأ بشاشة «تسجيل بصمات الوجوه» لتمكين النظام الذكي من العمل.");
    return parts.join(" ");
  }
  parts.push(`تم تسجيل بصمات وجوه ${a.enrolledEmployees} من أصل ${a.totalEmployees} موظف (${enrollPct}%).`);
  if (a.todayPresent > 0) {
    parts.push(`اليوم: ${a.todayPresent} حاضر${a.todayLate > 0 ? ` و${a.todayLate} متأخر` : ""} — معدل حضور ${presPct}%.`);
  }
  parts.push(`خلال الأسبوع الماضي: ${a.weekRecognitions} عملية تعرف ناجحة${a.weekSpoofs > 0 ? `، و${a.weekSpoofs} محاولة تزوير محظورة` : ""}.`);
  // recommendations
  if (a.enrollmentRate < 0.8) parts.push(`💡 توصية: ${a.totalEmployees - a.enrolledEmployees} موظف بحاجة لتسجيل بصمة الوجه — رفع نسبة التغطية يحسّن دقة النظام.`);
  if (a.todayLate > a.totalEmployees * 0.2) parts.push("💡 ملاحظة: نسبة التأخير اليوم مرتفعة — راجع جدول الدوام أو سياسة سماحية التأخير.");
  if (a.weekSpoofs > 0) parts.push("⚠️ تنبيه: تم رصد محاولات تزوير — تأكد من تفعيل الكشف الحي في الإعدادات.");
  return parts.join(" ");
}

export default function FaceAttendanceHub() {
  const { data: a } = useQuery<FaceAnalytics>({ queryKey: ["face-analytics"], queryFn: () => faceApi.analytics(), refetchInterval: 30_000 });
  const insight = computeInsight(a);

  const cards = [
    { href: "/hr/face/kiosk",       icon: Tv,         title: "شاشة الحضور المباشرة",   desc: "كاميرا مباشرة + تعرف وتسجيل تلقائي",     color: "from-emerald-500 to-teal-600" },
    { href: "/hr/face/enrollment",  icon: ScanFace,   title: "تسجيل بصمات الوجوه",     desc: "سجل وجوه الموظفين مع كشف حي",            color: "from-sky-500 to-indigo-600" },
    { href: "/hr/face/cameras",     icon: Camera,     title: "الكاميرات وأجهزة DVR",   desc: "إدارة كاميرات الفروع",                    color: "from-violet-500 to-purple-600" },
    { href: "/hr/face/logs",        icon: ScrollText, title: "سجل التعرف",             desc: "تدقيق كامل لكل عمليات التعرف",            color: "from-amber-500 to-orange-600" },
    { href: "/hr/face/settings",    icon: Settings2,  title: "الإعدادات",              desc: "حساسية، سياسات، حد التطابق",              color: "from-slate-500 to-slate-700" },
  ];

  const stats = [
    { icon: Users, label: "إجمالي الموظفين", value: a?.totalEmployees ?? "—", color: "text-blue-600" },
    { icon: UserCheck, label: "موظفون مسجَّل وجههم", value: `${a?.enrolledEmployees ?? 0} (${((a?.enrollmentRate ?? 0) * 100).toFixed(0)}%)`, color: "text-emerald-600" },
    { icon: Camera, label: "كاميرات نشطة", value: a?.camerasCount ?? 0, color: "text-violet-600" },
    { icon: TrendingUp, label: "تعرفات هذا الأسبوع", value: a?.weekRecognitions ?? 0, color: "text-indigo-600" },
    { icon: UserCheck, label: "حاضرون اليوم", value: a?.todayPresent ?? 0, color: "text-emerald-600" },
    { icon: Clock, label: "متأخرون اليوم", value: a?.todayLate ?? 0, color: "text-amber-600" },
    { icon: AlertTriangle, label: "محاولات تزوير", value: a?.weekSpoofs ?? 0, color: "text-rose-600" },
  ];

  return (
    <div className="p-6 space-y-6" data-testid="page-face-hub">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5"><ScanFace className="h-7 w-7 text-primary" /></div>
          الحضور بالذكاء الاصطناعي
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          نظام حضور وانصراف ذكي بالتعرف على الوجه — متعدد الفروع والكاميرات، مع كشف حي وحماية من التزوير
        </p>
      </div>

      {/* AI insight */}
      <Card className="p-5 bg-gradient-to-br from-primary/5 via-primary/3 to-transparent border-primary/20">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-primary/10"><Sparkles className="h-5 w-5 text-primary" /></div>
          <div className="flex-1">
            <h3 className="font-semibold mb-1">ملخص ذكي للأسبوع</h3>
            {insight ? (
              <p className="text-sm leading-relaxed text-foreground/80">{insight}</p>
            ) : (
              <p className="text-sm text-muted-foreground">سيظهر التحليل الذكي هنا بمجرد توفر بيانات كافية.</p>
            )}
          </div>
        </div>
      </Card>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {stats.map((s, i) => {
          const Icon = s.icon;
          return (
            <Card key={i} className="p-4">
              <div className="flex items-start gap-2">
                <Icon className={`h-5 w-5 ${s.color}`} />
                <div className="flex-1">
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                  <div className="text-xl font-bold mt-0.5">{s.value}</div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Action cards */}
      <div>
        <h2 className="font-semibold mb-3">الإجراءات</h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map((c) => {
            const Icon = c.icon;
            return (
              <Link key={c.href} href={c.href}>
                <Card className="p-5 hover:shadow-lg transition-all cursor-pointer h-full" data-testid={`card-${c.href.split("/").pop()}`}>
                  <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${c.color} flex items-center justify-center mb-3`}>
                    <Icon className="h-6 w-6 text-white" />
                  </div>
                  <h3 className="font-semibold mb-1">{c.title}</h3>
                  <p className="text-sm text-muted-foreground">{c.desc}</p>
                </Card>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Top late employees + heatmap */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <h3 className="font-semibold mb-3 flex items-center gap-2"><Clock className="h-4 w-4 text-amber-600" /> أعلى الموظفين تأخراً (هذا الأسبوع)</h3>
          {!a?.topLate?.length ? (
            <p className="text-sm text-muted-foreground text-center py-6">لا توجد تأخيرات مسجلة 🎉</p>
          ) : (
            <div className="space-y-2">
              {a.topLate.map((t) => (
                <div key={t.employeeId} className="flex items-center justify-between p-2 rounded border">
                  <div>
                    <div className="font-medium text-sm">{t.employeeName ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{t.employeeCode}</div>
                  </div>
                  <div className="text-right">
                    <Badge variant="secondary">{t.lateDays} يوم</Badge>
                    <div className="text-xs text-muted-foreground mt-0.5">{t.totalLateMin} دقيقة</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <h3 className="font-semibold mb-3 flex items-center gap-2"><TrendingUp className="h-4 w-4 text-indigo-600" /> أوقات ذروة التعرف (آخر 7 أيام)</h3>
          {!a?.heatmap?.length ? (
            <p className="text-sm text-muted-foreground text-center py-6">لا توجد بيانات بعد</p>
          ) : (
            <HeatmapStrip heatmap={a.heatmap} />
          )}
        </Card>
      </div>
    </div>
  );
}

function HeatmapStrip({ heatmap }: { heatmap: Array<{ hour: number; cnt: number }> }) {
  const map = new Map(heatmap.map((h) => [h.hour, h.cnt]));
  const max = Math.max(1, ...heatmap.map((h) => h.cnt));
  return (
    <div className="grid grid-cols-12 gap-1 text-center">
      {Array.from({ length: 24 }).map((_, h) => {
        const cnt = map.get(h) ?? 0;
        const intensity = cnt / max;
        return (
          <div key={h} className="space-y-1">
            <div
              className="h-12 rounded"
              style={{ background: `rgba(99, 102, 241, ${0.1 + intensity * 0.85})` }}
              title={`${h}:00 — ${cnt} تعرف`}
            />
            <div className="text-[10px] text-muted-foreground">{h}</div>
          </div>
        );
      })}
    </div>
  );
}
