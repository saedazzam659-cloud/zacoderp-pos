import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { userTrackingApi, type AttendanceData } from "@/lib/userTrackingApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { CalendarCheck, CalendarX, Clock, AlertTriangle, Download, Users, Activity } from "lucide-react";

function fmtMin(min: number): string {
  if (!min || min <= 0) return "—";
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return `${m}د`;
  return `${h}س ${m}د`;
}
function fmtTime(s: string | null): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" }); }
  catch { return "—"; }
}
function fmtDay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const day = d.toLocaleDateString("ar-SA", { day: "2-digit", month: "2-digit" });
  const weekday = ["أحد", "اثن", "ثلا", "أرب", "خمي", "جمع", "سبت"][d.getDay()];
  return `${day}\n${weekday}`;
}
function isFriday(iso: string): boolean {
  return new Date(iso + "T00:00:00").getDay() === 5;
}

export default function UserAttendanceReport() {
  const { user } = useAuth();
  const cid = user?.companyId ?? undefined;

  // Default range: current month-to-date.
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayStr);
  const [userId, setUserId] = useState<number | undefined>(undefined);
  const [includeWeekends, setIncludeWeekends] = useState(false);
  const [viewMode, setViewMode] = useState<"matrix" | "summary">("matrix");

  const q = useQuery({
    queryKey: ["user-attendance", cid, from, to, userId, includeWeekends],
    queryFn: () => userTrackingApi.attendance({ companyId: cid, from, to, userId, includeWeekends }),
    enabled: !!cid,
  });

  const data: AttendanceData | undefined = q.data;
  const totalHours = useMemo(() => data ? (data.overall.totalMinutes / 60).toFixed(1) : "0", [data]);
  const attendanceRate = useMemo(() => {
    if (!data || data.overall.totalUserDays === 0) return 0;
    return Math.round((data.overall.presentUserDays / data.overall.totalUserDays) * 100);
  }, [data]);

  const exportCsv = () => {
    if (!data) return;
    const rows: string[][] = [];
    rows.push(["المستخدم", "اليوم", "الحالة", "أول دخول", "آخر خروج", "الإجمالي (دقيقة)", "عدد الجلسات", "تنبيه"]);
    for (const u of data.users) {
      for (const d of u.days) {
        rows.push([
          u.userName,
          d.day,
          d.status === "absent" ? "غائب" : d.status === "active" ? "نشط" : "حاضر",
          d.firstIn ? new Date(d.firstIn).toLocaleString("ar-SA") : "—",
          d.lastOut ? new Date(d.lastOut).toLocaleString("ar-SA") : (d.status === "active" ? "ما زال نشطاً" : "—"),
          String(d.totalMinutes),
          String(d.visitCount),
          d.hasAlert ? "نعم" : "",
        ]);
      }
    }
    const csv = "\uFEFF" + rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <CalendarCheck className="h-6 w-6 text-emerald-600" /> تقرير الحضور والانصراف
        </h1>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={!data || data.users.length === 0}>
          <Download className="h-4 w-4 me-1" /> تصدير CSV
        </Button>
      </div>

      {/* Help text */}
      <Card>
        <CardContent className="pt-4 text-sm text-muted-foreground">
          يُحسب الحضور تلقائياً من تسجيل دخول النظام للمستخدمين المربوطين بمنطقة تتبع.
          أول دخول لليوم = بداية الدوام. آخر خروج = نهاية الدوام. الأيام بدون تسجيل دخول تظهر "غائب".
          {!includeWeekends && <span className="block mt-1">أيام الجمعة مستبعدة افتراضياً.</span>}
        </CardContent>
      </Card>

      {/* Filter bar */}
      <Card>
        <CardContent className="pt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div className="space-y-1.5"><Label>من</Label><Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>إلى</Label><Input type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label>المستخدم</Label>
            <select className="w-full h-10 rounded-md border px-3 text-sm bg-background"
              value={userId ?? ""} onChange={e => setUserId(e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">كل المتابَعين</option>
              {(data?.users ?? []).map(u => <option key={u.userId} value={u.userId}>{u.userName}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch id="weekends" checked={includeWeekends} onCheckedChange={setIncludeWeekends} />
            <label htmlFor="weekends" className="text-sm cursor-pointer">شامل أيام الجمعة</label>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch id="vm" checked={viewMode === "matrix"} onCheckedChange={c => setViewMode(c ? "matrix" : "summary")} />
            <label htmlFor="vm" className="text-sm cursor-pointer">عرض تفصيلي (مصفوفة)</label>
          </div>
        </CardContent>
      </Card>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <KpiTile icon={Users}         label="المتابَعون"      value={data?.users.length ?? 0}            color="indigo" />
        <KpiTile icon={CalendarCheck} label="أيام حضور"        value={data?.overall.presentUserDays ?? 0} color="emerald" />
        <KpiTile icon={CalendarX}     label="أيام غياب"        value={data?.overall.absentUserDays ?? 0}  color="rose" />
        <KpiTile icon={Clock}         label="إجمالي الساعات"  value={`${totalHours} س`}                  color="amber" />
        <KpiTile icon={Activity}      label="نسبة الحضور"      value={`${attendanceRate}%`}               color="emerald" />
      </div>

      {/* Empty state */}
      {!q.isLoading && (!data || data.users.length === 0) && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-3 opacity-40" />
            <p className="font-medium mb-1">لا يوجد مستخدمون مربوطون بمناطق تتبع في هذه الفترة</p>
            <p className="text-sm">اربط المستخدمين بالمناطق من لوحة تتبع المواقع لتظهر بياناتهم هنا.</p>
          </CardContent>
        </Card>
      )}

      {/* Matrix view */}
      {data && data.users.length > 0 && viewMode === "matrix" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">مصفوفة الحضور اليومي</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="py-2 px-2 text-start sticky start-0 bg-muted/50 z-10 min-w-[140px]">المستخدم</th>
                  {data.days.map(d => (
                    <th key={d} className={`py-2 px-1 text-center whitespace-pre-line min-w-[44px] ${isFriday(d) ? "bg-amber-50" : ""}`}>
                      {fmtDay(d)}
                    </th>
                  ))}
                  <th className="py-2 px-2 text-center bg-emerald-50 sticky end-0 z-10 min-w-[80px]">إجمالي</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map(u => (
                  <tr key={u.userId} className="border-t hover:bg-muted/30">
                    <td className="py-2 px-2 font-medium sticky start-0 bg-background z-10">
                      {u.userName}
                      <div className="text-[10px] text-muted-foreground font-normal">
                        {u.summary.presentDays}/{u.days.length} يوم
                      </div>
                    </td>
                    {u.days.map(d => (
                      <td key={d.day} className="py-1 px-1 text-center" title={
                        d.status === "absent" ? `${d.day} — غائب` :
                        `${d.day}\nدخول: ${fmtTime(d.firstIn)}\nخروج: ${d.lastOut ? fmtTime(d.lastOut) : "نشط الآن"}\nالمدة: ${fmtMin(d.totalMinutes)}\nالجلسات: ${d.visitCount}`
                      }>
                        <AttendanceCell d={d} />
                      </td>
                    ))}
                    <td className="py-2 px-2 text-center bg-emerald-50/60 font-semibold tabular-nums sticky end-0 z-10">
                      {fmtMin(u.summary.totalMinutes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="p-3 text-xs text-muted-foreground flex items-center gap-4 flex-wrap border-t">
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-emerald-500" /> حاضر</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-emerald-300 animate-pulse" /> نشط الآن</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-rose-200 border border-rose-400" /> غائب</span>
              <span className="flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-amber-600" /> يوم به تنبيه (خارج النطاق)</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary view */}
      {data && data.users.length > 0 && viewMode === "summary" && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">ملخص لكل مستخدم</CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="py-2 px-3 text-start">المستخدم</th>
                  <th className="py-2 px-3 text-center">أيام الحضور</th>
                  <th className="py-2 px-3 text-center">أيام الغياب</th>
                  <th className="py-2 px-3 text-center">نسبة الحضور</th>
                  <th className="py-2 px-3 text-center">إجمالي الساعات</th>
                  <th className="py-2 px-3 text-center">متوسط يومي</th>
                  <th className="py-2 px-3 text-center">أيام تنبيه</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map(u => {
                  const total = u.summary.presentDays + u.summary.absentDays;
                  const rate = total > 0 ? Math.round((u.summary.presentDays / total) * 100) : 0;
                  return (
                    <tr key={u.userId} className="border-t hover:bg-muted/30">
                      <td className="py-2 px-3 font-medium">{u.userName}</td>
                      <td className="py-2 px-3 text-center text-emerald-700 font-semibold tabular-nums">{u.summary.presentDays}</td>
                      <td className="py-2 px-3 text-center text-rose-700 font-semibold tabular-nums">{u.summary.absentDays}</td>
                      <td className="py-2 px-3 text-center tabular-nums">
                        <Badge className={rate >= 90 ? "bg-emerald-100 text-emerald-800" : rate >= 70 ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-800"}>
                          {rate}%
                        </Badge>
                      </td>
                      <td className="py-2 px-3 text-center tabular-nums">{(u.summary.totalMinutes / 60).toFixed(1)} س</td>
                      <td className="py-2 px-3 text-center tabular-nums">{fmtMin(u.summary.avgDailyMinutes)}</td>
                      <td className="py-2 px-3 text-center tabular-nums">
                        {u.summary.alertDays > 0
                          ? <Badge variant="destructive">{u.summary.alertDays}</Badge>
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function KpiTile({ icon: Icon, label, value, color }: { icon: any; label: string; value: number | string; color: string }) {
  const cls: Record<string, string> = {
    indigo:  "bg-indigo-50 text-indigo-700 border-indigo-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rose:    "bg-rose-50 text-rose-700 border-rose-200",
    amber:   "bg-amber-50 text-amber-700 border-amber-200",
  };
  return (
    <div className={`rounded-md border p-3 flex items-center gap-3 ${cls[color] ?? cls.indigo}`}>
      <Icon className="h-7 w-7 opacity-80" />
      <div>
        <div className="text-xs">{label}</div>
        <div className="text-xl font-bold tabular-nums">{value}</div>
      </div>
    </div>
  );
}

function AttendanceCell({ d }: { d: AttendanceData["users"][number]["days"][number] }) {
  if (d.status === "absent") {
    return <div className="w-8 h-8 mx-auto rounded bg-rose-100 border border-rose-300" />;
  }
  const baseColor = d.status === "active" ? "bg-emerald-300 animate-pulse" : "bg-emerald-500";
  return (
    <div className={`w-8 h-8 mx-auto rounded ${baseColor} text-white text-[9px] leading-tight flex flex-col items-center justify-center relative`}>
      <span>{fmtTime(d.firstIn).slice(0, 5)}</span>
      {d.hasAlert && <AlertTriangle className="absolute -top-1 -end-1 w-3 h-3 text-amber-600 fill-amber-200" />}
    </div>
  );
}
