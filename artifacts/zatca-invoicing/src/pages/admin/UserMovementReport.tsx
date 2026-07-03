import { saveBlob } from "@/lib/saveFile";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import {
  userTrackingApi,
  type MovementReportData,
  type MovementUser,
  type MovementSegment,
} from "@/lib/userTrackingApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  LogIn, LogOut, Clock, AlertTriangle, Download, Users, MapPin,
  Activity, ChevronDown, ChevronUp, Route as RouteIcon, Calendar,
} from "lucide-react";
import { DateField } from "@/components/ui/date-field";

function fmtTime(s: string | null): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" }); }
  catch { return "—"; }
}
function fmtDateTime(s: string | null): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" }); }
  catch { return "—"; }
}
function fmtMin(min: number | null): string {
  if (min == null || min <= 0) return "—";
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return `${m}د`;
  return `${h}س ${m}د`;
}
function liveMinutes(fromIso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(fromIso).getTime()) / 60000));
}

export default function UserMovementReport() {
  const { user } = useAuth();
  const cid = user?.companyId ?? undefined;

  // Local-time today (avoid toISOString which uses UTC and can shift the
  // date by ±1 day for users near midnight in their timezone).
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const [mode, setMode] = useState<"day" | "range">("day");
  const [day, setDay] = useState(todayStr);
  const [from, setFrom] = useState(todayStr);
  const [to, setTo] = useState(todayStr);
  const [userId, setUserId] = useState<number | undefined>(undefined);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const queryParams = mode === "day"
    ? { companyId: cid, day, userId }
    : { companyId: cid, from, to, userId };

  const q = useQuery({
    queryKey: ["movement-report", cid, mode, day, from, to, userId],
    queryFn: () => userTrackingApi.movementReport(queryParams),
    enabled: !!cid,
    refetchInterval: 30_000, // live-ish refresh while watching today
  });

  const data: MovementReportData | undefined = q.data;
  const allUsers = useMemo(() => data?.users ?? [], [data]);
  const totalHours = useMemo(() => data ? (data.overall.totalMinutes / 60).toFixed(1) : "0", [data]);

  const toggleExpand = (uid: number) =>
    setExpanded(prev => ({ ...prev, [uid]: !prev[uid] }));
  const expandAll = (open: boolean) => {
    const next: Record<number, boolean> = {};
    for (const u of allUsers) next[u.userId] = open;
    setExpanded(next);
  };

  const exportCsv = () => {
    if (!data) return;
    const rows: string[][] = [];
    rows.push(["المستخدم", "المنطقة", "الزيارة", "وقت الدخول", "وقت الخروج", "المدة (دقيقة)", "حالة", "خارج النطاق", "مكان الدخول", "مكان الخروج"]);
    for (const u of data.users) {
      for (const s of u.segments) {
        rows.push([
          u.userName,
          s.zoneName ?? "—",
          String(s.visitId),
          fmtDateTime(s.fromAt),
          s.toAt ? fmtDateTime(s.toAt) : (s.isActive ? "ما زال نشطاً" : "—"),
          String(s.durationMinutes ?? (s.isActive ? liveMinutes(s.fromAt) : "")),
          s.isActive ? "نشط" : "مكتمل",
          s.outOfZone ? "نعم" : "",
          s.fromPlace ?? "—",
          s.toPlace ?? "—",
        ]);
      }
    }
    const csv = "\uFEFF" + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    void saveBlob(blob, `movement_${mode === "day" ? day : `${from}_${to}`}.csv`);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <RouteIcon className="h-6 w-6 text-indigo-600" /> تقرير تحركات المستخدمين المربوطين بالمناطق
        </h1>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            <Activity className="h-4 w-4 me-1" /> تحديث
          </Button>
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={!data || data.users.length === 0}>
            <Download className="h-4 w-4 me-1" /> تصدير CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-4 text-sm text-muted-foreground">
          يعرض هذا التقرير كل مرات الدخول والخروج للمستخدمين المربوطين بمناطق تتبع نشطة، مع المواقع
          والأوقات وعدد الأماكن التي وقع فيها التحرك خارج النطاق المسموح به.
        </CardContent>
      </Card>

      {/* Filter bar */}
      <Card>
        <CardContent className="pt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
          <div className="space-y-1.5">
            <Label>الفترة</Label>
            <select
              className="w-full h-10 rounded-md border px-3 text-sm bg-background"
              value={mode}
              onChange={e => setMode(e.target.value as "day" | "range")}
            >
              <option value="day">يوم واحد</option>
              <option value="range">فترة زمنية</option>
            </select>
          </div>
          {mode === "day" ? (
            <div className="space-y-1.5">
              <Label>اليوم</Label>
              <DateField value={day} onChange={e => setDay(e.target.value)} />
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>من</Label>
                <DateField value={from} onChange={e => setFrom(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>إلى</Label>
                <DateField value={to} onChange={e => setTo(e.target.value)} />
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <Label>المستخدم</Label>
            <select
              className="w-full h-10 rounded-md border px-3 text-sm bg-background"
              value={userId ?? ""}
              onChange={e => setUserId(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">كل المتابَعين</option>
              {allUsers.map(u => <option key={u.userId} value={u.userId}>{u.userName}</option>)}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <Button size="sm" variant="outline" onClick={() => expandAll(true)} disabled={allUsers.length === 0}>
              فتح الكل
            </Button>
            <Button size="sm" variant="outline" onClick={() => expandAll(false)} disabled={allUsers.length === 0}>
              طي الكل
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <KpiTile icon={Users}    label="المتابَعون"        value={data?.overall.trackedUsers ?? 0}   color="indigo" />
        <KpiTile icon={LogIn}    label="مرات الدخول"        value={data?.overall.totalCheckins ?? 0}  color="emerald" />
        <KpiTile icon={LogOut}   label="مرات الخروج"        value={data?.overall.totalCheckouts ?? 0} color="sky" />
        <KpiTile icon={AlertTriangle} label="مرات خارج النطاق" value={data?.overall.totalOutOfZone ?? 0} color="rose" />
        <KpiTile icon={Clock}    label="إجمالي الساعات"    value={`${totalHours} س`}                  color="amber" />
      </div>

      {/* Empty state */}
      {!q.isLoading && allUsers.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <MapPin className="h-12 w-12 mx-auto mb-3 opacity-40" />
            <p className="font-medium mb-1">لا توجد تحركات في الفترة المحددة</p>
            <p className="text-sm">جرّب يوم آخر أو تأكد من ربط المستخدمين بمناطق تتبع.</p>
          </CardContent>
        </Card>
      )}

      {/* Per-user cards */}
      <div className="space-y-3">
        {allUsers.map(u => (
          <UserMovementCard
            key={u.userId}
            user={u}
            expanded={expanded[u.userId] ?? true}
            onToggle={() => toggleExpand(u.userId)}
          />
        ))}
      </div>
    </div>
  );
}

function KpiTile({ icon: Icon, label, value, color }: { icon: any; label: string; value: number | string; color: string }) {
  const cls: Record<string, string> = {
    indigo:  "bg-indigo-50 text-indigo-700 border-indigo-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    sky:     "bg-sky-50 text-sky-700 border-sky-200",
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

function UserMovementCard({
  user, expanded, onToggle,
}: {
  user: MovementUser;
  expanded: boolean;
  onToggle: () => void;
}) {
  const s = user.summary;
  const hasOut = s.outOfZoneCount > 0;
  return (
    <Card className={hasOut ? "border-rose-300" : ""}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggle}
              className="p-1 rounded hover:bg-muted"
              aria-label={expanded ? "طي" : "فتح"}
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-indigo-600" />
              {user.userName}
            </CardTitle>
            {user.assignedZones.map(z => (
              <Badge key={z.id} variant="outline" className="text-xs">
                <MapPin className="h-3 w-3 me-1" />
                {z.name}
                {!z.isAllowed && <span className="ms-1 text-rose-600">(محظورة)</span>}
              </Badge>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Badge className="bg-emerald-100 text-emerald-800">
              <LogIn className="h-3 w-3 me-1" /> دخول: {s.checkinCount}
            </Badge>
            <Badge className="bg-sky-100 text-sky-800">
              <LogOut className="h-3 w-3 me-1" /> خروج: {s.checkoutCount}
            </Badge>
            <Badge className={hasOut ? "bg-rose-100 text-rose-800" : "bg-muted text-muted-foreground"}>
              <AlertTriangle className="h-3 w-3 me-1" /> خارج النطاق: {s.outOfZoneCount}
            </Badge>
            <Badge variant="outline" className="tabular-nums">
              <Clock className="h-3 w-3 me-1" /> {fmtMin(s.totalMinutes)}
            </Badge>
            {s.firstAt && (
              <Badge variant="outline" className="tabular-nums">
                <Calendar className="h-3 w-3 me-1" />
                من {fmtTime(s.firstAt)} إلى {fmtTime(s.lastAt)}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="p-0 overflow-x-auto">
          {user.segments.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              لا توجد تحركات لهذا المستخدم في الفترة المحددة.
            </div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th className="py-2 px-3 text-center">#</th>
                  <th className="py-2 px-3 text-start">من وقت</th>
                  <th className="py-2 px-3 text-start">إلى وقت</th>
                  <th className="py-2 px-3 text-center">المدة</th>
                  <th className="py-2 px-3 text-start">المنطقة</th>
                  <th className="py-2 px-3 text-start">المكان</th>
                  <th className="py-2 px-3 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {user.segments.map((seg, i) => (
                  <SegmentRow key={seg.visitId} idx={i + 1} seg={seg} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function SegmentRow({ idx, seg }: { idx: number; seg: MovementSegment }) {
  // For an active visit we show the live elapsed minutes; otherwise the
  // server-computed durationMinutes (which is null while active).
  const dur = seg.isActive && !seg.durationMinutes
    ? liveMinutes(seg.fromAt)
    : seg.durationMinutes;
  return (
    <tr className={`border-t hover:bg-muted/30 ${seg.outOfZone ? "bg-rose-50/50" : ""}`}>
      <td className="py-2 px-3 text-center text-xs text-muted-foreground">{idx}</td>
      <td className="py-2 px-3 tabular-nums">
        <div className="flex items-center gap-1.5">
          <LogIn className="h-3.5 w-3.5 text-emerald-600" />
          <span>{fmtTime(seg.fromAt)}</span>
        </div>
        <div className="text-[10px] text-muted-foreground">{fmtDateTime(seg.fromAt)}</div>
      </td>
      <td className="py-2 px-3 tabular-nums">
        {seg.toAt ? (
          <>
            <div className="flex items-center gap-1.5">
              <LogOut className="h-3.5 w-3.5 text-sky-600" />
              <span>{fmtTime(seg.toAt)}</span>
            </div>
            <div className="text-[10px] text-muted-foreground">{fmtDateTime(seg.toAt)}</div>
          </>
        ) : (
          <Badge className="bg-emerald-100 text-emerald-800 animate-pulse">نشط الآن</Badge>
        )}
      </td>
      <td className="py-2 px-3 text-center tabular-nums">{fmtMin(dur)}</td>
      <td className="py-2 px-3">
        {seg.zoneName ? (
          <Badge variant="outline" className="text-xs">
            <MapPin className="h-3 w-3 me-1" />{seg.zoneName}
          </Badge>
        ) : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-2 px-3 text-xs">
        <div>{seg.fromPlace ?? "—"}</div>
        {seg.toPlace && seg.toPlace !== seg.fromPlace && (
          <div className="text-muted-foreground">↓ {seg.toPlace}</div>
        )}
      </td>
      <td className="py-2 px-3 text-center">
        {seg.outOfZone ? (
          <Badge variant="destructive" className="text-xs">
            <AlertTriangle className="h-3 w-3 me-1" /> خارج النطاق
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs text-emerald-700 border-emerald-300">داخل النطاق</Badge>
        )}
      </td>
    </tr>
  );
}
