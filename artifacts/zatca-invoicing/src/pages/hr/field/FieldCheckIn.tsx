import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fieldApi, type FieldVisit } from "@/lib/fieldServiceApi";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Smartphone, MapPin, Loader2, LogIn, LogOut, AlertTriangle, CheckCircle2, Clock,
} from "lucide-react";

const PURPOSES = [
  { v: "site_visit",  l: "زيارة موقع" },
  { v: "sales_call",  l: "زيارة مبيعات" },
  { v: "delivery",    l: "تسليم" },
  { v: "maintenance", l: "صيانة" },
  { v: "inspection",  l: "تفتيش/معاينة" },
  { v: "meeting",     l: "اجتماع" },
  { v: "other",       l: "أخرى" },
];

const STATUS_LABEL: Record<string, { ar: string; tone: "ok" | "warn" | "err" }> = {
  ok:               { ar: "داخل النطاق", tone: "ok" },
  no_gps:           { ar: "بدون GPS", tone: "warn" },
  out_of_geofence:  { ar: "خارج النطاق", tone: "warn" },
  low_accuracy:     { ar: "دقة منخفضة", tone: "warn" },
  mock_suspected:   { ar: "موقع مشكوك فيه", tone: "err" },
  denied:           { ar: "إذن مرفوض", tone: "err" },
};

interface GpsState { lat: number | null; lng: number | null; accuracy: number | null; busy: boolean; error: string | null; }

export default function FieldCheckIn() {
  const qc = useQueryClient();
  const { toast } = useToast();

  // Resolve current employee — persisted in localStorage so the user picks
  // their profile once. (The existing /hr/check-in face flow identifies via
  // selfie; this field-staff flow assumes the user already logged in.)
  const [employeeId, setEmployeeId] = useState<number | null>(() => {
    const v = localStorage.getItem("zatca_field_employee_id");
    return v ? Number(v) : null;
  });
  useEffect(() => {
    if (employeeId) localStorage.setItem("zatca_field_employee_id", String(employeeId));
  }, [employeeId]);

  const { data: employees } = useQuery<Array<{ id: number; nameAr: string; code: string }>>({
    queryKey: ["fsm-employees"],
    queryFn: async () => {
      const session = localStorage.getItem("zatca_token");
      const acting = localStorage.getItem("zatca_acting_company_id");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (session) headers.Authorization = `Bearer ${session}`;
      if (acting) headers["x-acting-company-id"] = acting;
      const r = await fetch("/api/employees?status=active", { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const { data: locations } = useQuery({ queryKey: ["fsm-locations"], queryFn: () => fieldApi.listLocations({}) });
  const { data: today, refetch: refetchToday } = useQuery({
    queryKey: ["fsm-today-visits", employeeId],
    queryFn: () => employeeId ? fieldApi.todayVisits(employeeId) : Promise.resolve([] as FieldVisit[]),
    enabled: !!employeeId,
  });
  const { data: planToday } = useQuery({
    queryKey: ["fsm-plan-today", employeeId],
    queryFn: () => employeeId ? fieldApi.todayPlan(employeeId) : Promise.resolve(null),
    enabled: !!employeeId,
  });

  const openVisit = today?.find((v) => v.status === "open") ?? null;

  const [locationId, setLocationId] = useState<string>("");
  const [purpose, setPurpose] = useState<string>("site_visit");
  const [planItemId, setPlanItemId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [outcome, setOutcome] = useState<string>("");
  const [gps, setGps] = useState<GpsState>({ lat: null, lng: null, accuracy: null, busy: false, error: null });

  const captureGps = (): Promise<GpsState> => new Promise((resolve) => {
    if (!navigator.geolocation) {
      const s: GpsState = { lat: null, lng: null, accuracy: null, busy: false, error: "متصفح بدون دعم GPS" };
      setGps(s); resolve(s); return;
    }
    setGps((g) => ({ ...g, busy: true, error: null }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const s: GpsState = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, busy: false, error: null };
        setGps(s); resolve(s);
      },
      (e) => {
        const s: GpsState = { lat: null, lng: null, accuracy: null, busy: false, error: e.message };
        setGps(s); resolve(s);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  });

  const startMut = useMutation({
    mutationFn: async () => {
      if (!employeeId) throw new Error("اختر موظفك أولاً");
      const g = await captureGps();
      return fieldApi.startVisit({
        employeeId,
        locationId: locationId ? Number(locationId) : null,
        lat: g.lat, lng: g.lng, accuracy: g.accuracy,
        purpose, notes: notes || undefined,
        planItemId: planItemId ?? undefined,
      });
    },
    onSuccess: (v) => {
      const s = STATUS_LABEL[v.arrivalLocStatus ?? "ok"];
      toast({
        title: "تم بدء الزيارة",
        description: `الحالة: ${s?.ar ?? v.arrivalLocStatus} • المسافة: ${v.arrivalDistanceM ? Math.round(Number(v.arrivalDistanceM)) + " م" : "—"}`,
      });
      setNotes(""); setLocationId(""); setPlanItemId(null);
      qc.invalidateQueries({ queryKey: ["fsm-today-visits"] });
      qc.invalidateQueries({ queryKey: ["fsm-plan-today"] });
    },
    onError: (e: any) => toast({ title: "تعذر بدء الزيارة", description: e.message, variant: "destructive" }),
  });

  const endMut = useMutation({
    mutationFn: async () => {
      if (!openVisit) throw new Error("لا توجد زيارة مفتوحة");
      const g = await captureGps();
      return fieldApi.endVisit(openVisit.id, {
        employeeId: employeeId ?? undefined,
        lat: g.lat, lng: g.lng, accuracy: g.accuracy,
        outcome: outcome || undefined, notes: notes || undefined,
      });
    },
    onSuccess: () => {
      toast({ title: "تم إنهاء الزيارة", description: "شكراً — تم تسجيل وقت المغادرة" });
      setNotes(""); setOutcome("");
      refetchToday();
      qc.invalidateQueries({ queryKey: ["fsm-today-visits"] });
    },
    onError: (e: any) => toast({ title: "تعذر إنهاء الزيارة", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4" dir="rtl" data-testid="page-field-checkin">
      <div className="flex items-center gap-2">
        <Smartphone className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">تسجيل زيارة ميدانية</h1>
      </div>

      {/* Employee selector */}
      <Card className="p-4">
        <Label>أنا الموظف</Label>
        <Select value={employeeId ? String(employeeId) : ""} onValueChange={(v) => setEmployeeId(Number(v))}>
          <SelectTrigger className="mt-2"><SelectValue placeholder="اختر اسمك من القائمة" /></SelectTrigger>
          <SelectContent>
            {(employees ?? []).map((e) => (
              <SelectItem key={e.id} value={String(e.id)}>{e.nameAr} {e.code ? `— ${e.code}` : ""}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Card>

      {/* Today's plan (if any) */}
      {planToday?.plan && planToday.items.length > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-5 w-5 text-violet-600" />
            <h3 className="font-semibold">جولة اليوم — {planToday.items.length} موقع</h3>
          </div>
          <div className="space-y-1">
            {planToday.items.map((it) => (
              <div key={it.id} className={`flex items-center gap-2 p-2 rounded border text-sm ${it.status === "done" ? "bg-emerald-50 dark:bg-emerald-950/20" : ""}`}>
                <Badge variant="outline">{it.sequenceNo}</Badge>
                <div className="flex-1 truncate">{it.locationName ?? "—"}</div>
                {it.status === "done" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : (
                  <Button size="sm" variant="outline" onClick={() => {
                    setLocationId(String(it.locationId ?? ""));
                    setPlanItemId(it.id);
                    if (it.purpose) setPurpose(it.purpose);
                  }}>اختر</Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Open visit panel */}
      {openVisit ? (
        <Card className="p-4 border-emerald-500 border-2">
          <div className="flex items-center gap-2 mb-2">
            <Badge className="bg-emerald-500">زيارة مفتوحة</Badge>
            <span className="text-sm">{openVisit.locationName ?? "—"}</span>
          </div>
          <div className="text-xs text-muted-foreground mb-3">
            بدأت في: {new Date(openVisit.arrivedAt).toLocaleTimeString("ar-SA")}
          </div>
          <div className="space-y-2">
            <div><Label>نتيجة الزيارة</Label>
              <Select value={outcome} onValueChange={setOutcome}>
                <SelectTrigger><SelectValue placeholder="اختر النتيجة" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="completed">مكتملة بنجاح</SelectItem>
                  <SelectItem value="quote_sent">عرض سعر مُرسل</SelectItem>
                  <SelectItem value="deal_closed">صفقة مُغلقة</SelectItem>
                  <SelectItem value="issue_found">مشكلة تم تحديدها</SelectItem>
                  <SelectItem value="no_answer">العميل غير متواجد</SelectItem>
                  <SelectItem value="rescheduled">إعادة جدولة</SelectItem>
                  <SelectItem value="nothing">لا شيء</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>ملاحظات</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></div>
            <Button className="w-full" onClick={() => endMut.mutate()} disabled={endMut.isPending}>
              {endMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4 ms-2" />}
              إنهاء الزيارة
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="p-4">
          <h3 className="font-semibold mb-3">بدء زيارة جديدة</h3>
          <div className="space-y-3">
            <div><Label>الموقع</Label>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger><SelectValue placeholder="اختر الموقع" /></SelectTrigger>
                <SelectContent>
                  {(locations ?? []).map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div><Label>الغرض</Label>
              <Select value={purpose} onValueChange={setPurpose}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PURPOSES.map((p) => <SelectItem key={p.v} value={p.v}>{p.l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>ملاحظات</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></div>
            <Button className="w-full" size="lg" onClick={() => startMut.mutate()} disabled={!employeeId || startMut.isPending || !locationId}>
              {startMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4 ms-2" />}
              ابدأ الزيارة
            </Button>
            {gps.error && (
              <div className="text-xs text-rose-600 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> {gps.error}
              </div>
            )}
            {gps.lat && (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <MapPin className="h-3 w-3" /> {gps.lat.toFixed(5)}, {gps.lng?.toFixed(5)} • دقة {gps.accuracy?.toFixed(0)} م
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Today's visit history */}
      {today && today.length > 0 && (
        <Card className="p-4">
          <h3 className="font-semibold mb-2">زيارات اليوم</h3>
          <div className="space-y-2">
            {today.map((v) => (
              <div key={v.id} className="flex items-center gap-2 text-sm border-b pb-2">
                <Badge variant={v.status === "open" ? "default" : v.status === "completed" ? "secondary" : "outline"}>
                  {v.status === "open" ? "مفتوحة" : v.status === "completed" ? "مكتملة" : "ملغاة"}
                </Badge>
                <span className="flex-1">{v.locationName ?? "—"}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(v.arrivedAt).toLocaleTimeString("ar-SA")}
                  {v.durationMin ? ` • ${v.durationMin} د` : ""}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
