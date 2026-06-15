import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { faceApi, type TimelineResponse } from "@/lib/faceAttendanceApi";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Loader2, Clock, LogIn, LogOut, ScanFace, AlertTriangle, CheckCircle2,
  TrendingUp, Calendar, MapPin, Camera as CameraIcon, Activity,
} from "lucide-react";
import { DateField } from "@/components/ui/date-field";

function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysAgoISO(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const STATUS_LABEL: Record<string, { ar: string; cls: string }> = {
  ok:              { ar: "داخل النطاق", cls: "bg-emerald-100 text-emerald-700 border-emerald-300" },
  out_of_geofence: { ar: "خارج النطاق", cls: "bg-amber-100 text-amber-700 border-amber-300" },
  low_accuracy:    { ar: "دقة منخفضة",  cls: "bg-amber-100 text-amber-700 border-amber-300" },
  mock_suspected:  { ar: "موقع مزيف",   cls: "bg-rose-100 text-rose-700 border-rose-300" },
  denied:          { ar: "بدون GPS",    cls: "bg-rose-100 text-rose-700 border-rose-300" },
  no_gps:          { ar: "—",           cls: "bg-slate-100 text-slate-700 border-slate-300" },
};

export default function AttendanceTimeline() {
  const [employeeId, setEmployeeId] = useState<string>("");
  const [from, setFrom] = useState<string>(daysAgoISO(6));
  const [to, setTo] = useState<string>(todayISO());

  // Pull the work-locations list — already returns the active employees
  // in the company with avatar + dept, perfect for a picker.
  const { data: employees = [] } = useQuery({
    queryKey: ["face-employees-picker"],
    queryFn: () => faceApi.workLocations(),
  });

  const { data, isLoading, isFetching } = useQuery<TimelineResponse>({
    queryKey: ["face-timeline", employeeId, from, to],
    queryFn: () => faceApi.timeline(Number(employeeId), from, to),
    enabled: !!employeeId && !!from && !!to,
  });

  // Build a Map<dateStr, { attendance, activity[] }> for the timeline.
  const days = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, {
      date: string;
      attendance: TimelineResponse["attendance"][number] | null;
      activity: TimelineResponse["activity"];
    }>();
    for (const a of data.attendance) {
      map.set(a.date, { date: a.date, attendance: a, activity: [] });
    }
    for (const ev of data.activity) {
      const dateStr = ev.createdAt.slice(0, 10);
      let bucket = map.get(dateStr);
      if (!bucket) { bucket = { date: dateStr, attendance: null, activity: [] }; map.set(dateStr, bucket); }
      bucket.activity.push(ev);
    }
    return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [data]);

  const setQuickRange = (days: number) => {
    setFrom(daysAgoISO(days - 1));
    setTo(todayISO());
  };

  return (
    <div className="p-6 space-y-5" data-testid="page-timeline">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6 text-indigo-600" /> الخط الزمني للحضور
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تقرير يومي / أسبوعي يجمع الحضور والانصراف وكل عمليات التعرف على الوجه للموظف
          </p>
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid md:grid-cols-[2fr,1fr,1fr,auto] gap-3 items-end">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الموظف</label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger data-testid="select-employee">
                <SelectValue placeholder="اختر موظفاً..." />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.nameAr} — {e.code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">من</label>
            <DateField value={from} onChange={(e) => setFrom(e.target.value)} data-testid="input-from" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">إلى</label>
            <DateField value={to} onChange={(e) => setTo(e.target.value)} data-testid="input-to" />
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => setQuickRange(1)}>اليوم</Button>
            <Button size="sm" variant="outline" onClick={() => setQuickRange(7)}>أسبوع</Button>
            <Button size="sm" variant="outline" onClick={() => setQuickRange(30)}>شهر</Button>
          </div>
        </div>
      </Card>

      {!employeeId ? (
        <Card className="p-12 text-center text-muted-foreground">
          <Calendar className="h-12 w-12 mx-auto mb-3 opacity-40" />
          اختر موظفاً لعرض الخط الزمني
        </Card>
      ) : isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : !data ? null : (
        <>
          {/* Header tiles */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <StatTile icon={Calendar} label="أيام حضور" value={data.totals.daysPresent} color="text-emerald-600" />
            <StatTile icon={Clock} label="ساعات عمل" value={data.totals.workedHours.toFixed(1)} color="text-blue-600" />
            <StatTile icon={TrendingUp} label="ساعات إضافية" value={data.totals.overtimeHours.toFixed(1)} color="text-indigo-600" />
            <StatTile icon={AlertTriangle} label="دقائق تأخير" value={data.totals.lateMinutes} color="text-amber-600" />
            <StatTile icon={ScanFace} label="عمليات تعرّف" value={data.totals.activityCount} color="text-violet-600" />
            <StatTile icon={MapPin} label="بحاجة موافقة" value={data.totals.flagged} color="text-rose-600" />
          </div>

          {/* Employee header */}
          <Card className="p-4 bg-gradient-to-br from-indigo-50 to-violet-50 border-indigo-200">
            <div className="flex items-center gap-4">
              {data.employee.photoUrl ? (
                <img src={data.employee.photoUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
              ) : (
                <div className="h-16 w-16 rounded-full bg-white flex items-center justify-center text-2xl font-bold text-indigo-600">
                  {data.employee.nameAr.slice(0, 1)}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="font-bold text-lg">{data.employee.nameAr}</div>
                <div className="text-sm text-muted-foreground">
                  {data.employee.code} · {data.employee.jobTitle ?? "—"} · {data.employee.department ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  من {from} إلى {to}
                </div>
              </div>
              {isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
          </Card>

          {/* Timeline */}
          {days.length === 0 ? (
            <Card className="p-12 text-center text-muted-foreground">
              <Calendar className="h-12 w-12 mx-auto mb-3 opacity-40" />
              لا توجد بيانات في هذه الفترة
            </Card>
          ) : (
            <div className="relative space-y-6 ps-6">
              {/* Vertical line */}
              <div className="absolute right-2 top-2 bottom-2 w-0.5 bg-gradient-to-b from-indigo-200 via-indigo-100 to-transparent" />
              {days.map((day) => (
                <DayBlock key={day.date} day={day} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatTile({ icon: Icon, label, value, color }: { icon: any; label: string; value: any; color: string }) {
  return (
    <Card className="p-3">
      <div className="flex items-start gap-2">
        <Icon className={`h-5 w-5 ${color}`} />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-bold mt-0.5">{value}</div>
        </div>
      </div>
    </Card>
  );
}

function DayBlock({ day }: { day: { date: string; attendance: any; activity: any[] } }) {
  const a = day.attendance;
  const events: Array<{ time: string; kind: "in" | "out" | "scan"; label: string; meta?: string }> = [];
  if (a?.checkIn) events.push({ time: a.checkIn, kind: "in", label: "تسجيل حضور" });
  for (const ev of day.activity) {
    const t = ev.createdAt.slice(11, 19);
    if (ev.action === "check_in" || ev.action === "check_out") continue; // already shown above
    events.push({
      time: t,
      kind: "scan",
      label: ev.cameraName ? `تعرّف — ${ev.cameraName}` : "تعرّف على الوجه",
      meta: ev.matchedConfidence != null ? `ثقة ${(Number(ev.matchedConfidence) * 100).toFixed(0)}%` : undefined,
    });
  }
  if (a?.checkOut) events.push({ time: a.checkOut, kind: "out", label: "تسجيل انصراف" });
  events.sort((x, y) => x.time.localeCompare(y.time));

  const dateLabel = new Date(`${day.date}T00:00:00`).toLocaleDateString("ar-EG", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  return (
    <div className="relative">
      {/* Date header */}
      <div className="absolute -right-[26px] top-0 h-6 w-6 rounded-full bg-indigo-600 ring-4 ring-white shadow flex items-center justify-center">
        <Calendar className="h-3 w-3 text-white" />
      </div>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 className="font-semibold">{dateLabel}</h3>
        <div className="flex items-center gap-1.5 flex-wrap">
          {a?.workedHours && Number(a.workedHours) > 0 && (
            <Badge variant="outline" className="text-xs">{Number(a.workedHours).toFixed(1)} ساعة</Badge>
          )}
          {a?.lateMinutes ? <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-300">{a.lateMinutes} د تأخير</Badge> : null}
          {a?.needsApproval && (
            <Badge variant="outline" className={
              a.approvalStatus === "approved" ? "bg-emerald-50 text-emerald-700 border-emerald-300"
              : a.approvalStatus === "rejected" ? "bg-rose-50 text-rose-700 border-rose-300"
              : "bg-amber-50 text-amber-700 border-amber-300"
            }>
              {a.approvalStatus === "approved" ? "معتمدة"
                : a.approvalStatus === "rejected" ? "مرفوضة"
                : "تنتظر موافقة"}
            </Badge>
          )}
        </div>
      </div>

      {events.length === 0 ? (
        <p className="text-xs text-muted-foreground">— لا توجد عمليات —</p>
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y">
            {events.map((ev, i) => {
              const Icon = ev.kind === "in" ? LogIn : ev.kind === "out" ? LogOut : ScanFace;
              const color = ev.kind === "in" ? "text-emerald-600 bg-emerald-50"
                          : ev.kind === "out" ? "text-rose-600 bg-rose-50"
                          : "text-indigo-600 bg-indigo-50";
              return (
                <div key={i} className="flex items-center gap-3 p-3">
                  <div className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${color}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{ev.label}</div>
                    {ev.meta && <div className="text-xs text-muted-foreground">{ev.meta}</div>}
                  </div>
                  <div className="text-sm font-mono text-muted-foreground" dir="ltr">{ev.time.slice(0, 5)}</div>
                </div>
              );
            })}
          </div>
          {/* Location summary footer when geofence info is present */}
          {(a?.checkInLocStatus || a?.checkOutLocStatus) && (
            <div className="bg-muted/30 px-3 py-2 flex flex-wrap items-center gap-2 text-xs">
              <MapPin className="h-3 w-3 text-muted-foreground" />
              {a.checkInLocStatus && (
                <span className="inline-flex items-center gap-1">
                  حضور:
                  <Badge variant="outline" className={STATUS_LABEL[a.checkInLocStatus]?.cls}>
                    {STATUS_LABEL[a.checkInLocStatus]?.ar ?? a.checkInLocStatus}
                  </Badge>
                  {a.checkInDistanceM && <span className="text-muted-foreground">({Math.round(Number(a.checkInDistanceM))} م)</span>}
                </span>
              )}
              {a.checkOutLocStatus && (
                <span className="inline-flex items-center gap-1">
                  انصراف:
                  <Badge variant="outline" className={STATUS_LABEL[a.checkOutLocStatus]?.cls}>
                    {STATUS_LABEL[a.checkOutLocStatus]?.ar ?? a.checkOutLocStatus}
                  </Badge>
                  {a.checkOutDistanceM && <span className="text-muted-foreground">({Math.round(Number(a.checkOutDistanceM))} م)</span>}
                </span>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
