import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Trash2, X, Save, AlertOctagon, Gauge, Timer,
  Activity, CheckCircle2, Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.VITE_API_URL || "";

const CATEGORY_LABEL: Record<string, { label: string; cls: string }> = {
  planned:   { label: "مخطط",     cls: "bg-blue-100 text-blue-800" },
  unplanned: { label: "غير مخطط", cls: "bg-rose-100 text-rose-800" },
};

type Reason = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  category: string; isActive: boolean;
};
type WorkCenter = { id: number; code: string; nameAr: string; nameEn?: string };
type Event = {
  id: number; workCenterId: number; reasonId: number | null;
  startAt: string; endAt: string; durationMinutes: number; notes: string | null;
  workCenterCode?: string; workCenterNameAr?: string;
  reasonCode?: string; reasonNameAr?: string; reasonCategory?: string;
};
type OeeRow = {
  workCenterId: number; code: string; nameAr: string;
  capacityHoursPerDay: number;
  plannedMinutes: number; downtimeMinutes: number; availableMinutes: number;
  downtimePlanned: number; downtimeUnplanned: number; downtimeUncategorized: number;
  producedQty: number; wasteQty: number; goodQty: number;
  availability: number; quality: number; oee: number;
};

const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtMin = (n: number) => {
  if (n < 60) return `${n}د`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m === 0 ? `${h}س` : `${h}س ${m}د`;
};
const oeeColor = (v: number) => {
  if (v >= 0.85) return "text-emerald-700 bg-emerald-50 border-emerald-200";
  if (v >= 0.6) return "text-amber-700 bg-amber-50 border-amber-200";
  return "text-rose-700 bg-rose-50 border-rose-200";
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n: number) => new Date(Date.now() - n * 86400 * 1000).toISOString().slice(0, 10);
const nowDateTimeLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export default function DowntimeOee() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [tab, setTab] = useState<"oee" | "events" | "reasons">("oee");
  const [from, setFrom] = useState(daysAgoISO(7));
  const [to, setTo] = useState(todayISO());

  const [reasons, setReasons] = useState<Reason[]>([]);
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [events, setEvents] = useState<Event[] | null>(null);
  const [oee, setOee] = useState<OeeRow[] | null>(null);

  const [showEventForm, setShowEventForm] = useState(false);
  const [newEvent, setNewEvent] = useState({
    workCenterId: "" as string,
    reasonId: "" as string,
    startAt: nowDateTimeLocal(),
    endAt: nowDateTimeLocal(),
    notes: "",
  });
  const [showReasonForm, setShowReasonForm] = useState(false);
  const [newReason, setNewReason] = useState({
    code: "", nameAr: "", nameEn: "", category: "unplanned" as "planned" | "unplanned",
  });
  const [editingReasonId, setEditingReasonId] = useState<number | null>(null);

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }), [token]);

  const loadCore = useCallback(async () => {
    if (!token) return;
    const [rR, wR] = await Promise.all([
      fetch(`${API}/api/production/downtime-reasons`, { headers }),
      fetch(`${API}/api/production/work-centers`, { headers }),
    ]);
    if (rR.ok) setReasons(await rR.json());
    if (wR.ok) {
      const d = await wR.json();
      setWorkCenters(Array.isArray(d) ? d : (d.items ?? []));
    }
  }, [token, headers]);

  const loadEvents = useCallback(async () => {
    if (!token) return;
    const qs = new URLSearchParams({ from, to });
    const r = await fetch(`${API}/api/production/downtime-events?${qs}`, { headers });
    if (r.ok) setEvents(await r.json());
  }, [token, headers, from, to]);

  const loadOee = useCallback(async () => {
    if (!token) return;
    const qs = new URLSearchParams({ from, to });
    const r = await fetch(`${API}/api/production/oee?${qs}`, { headers });
    if (r.ok) {
      const d = await r.json();
      setOee(d.centers ?? []);
    } else {
      const e = await r.json().catch(() => ({}));
      toast({ title: "فشل تحميل OEE", description: e?.error, variant: "destructive" });
    }
  }, [token, headers, from, to, toast]);

  useEffect(() => { void loadCore(); }, [loadCore]);
  useEffect(() => { void loadEvents(); void loadOee(); }, [loadEvents, loadOee]);

  const saveEvent = async () => {
    if (!newEvent.workCenterId) {
      toast({ title: "اختر مركز العمل", variant: "destructive" }); return;
    }
    const r = await fetch(`${API}/api/production/downtime-events`, {
      method: "POST", headers,
      body: JSON.stringify({
        workCenterId: Number(newEvent.workCenterId),
        reasonId: newEvent.reasonId ? Number(newEvent.reasonId) : null,
        startAt: new Date(newEvent.startAt).toISOString(),
        endAt: new Date(newEvent.endAt).toISOString(),
        notes: newEvent.notes,
      }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      toast({ title: "فشل الحفظ", description: e?.error, variant: "destructive" }); return;
    }
    toast({ title: "تم تسجيل التوقف" });
    setShowEventForm(false);
    setNewEvent({ workCenterId: "", reasonId: "", startAt: nowDateTimeLocal(), endAt: nowDateTimeLocal(), notes: "" });
    void loadEvents();
    void loadOee();
  };

  const removeEvent = async (id: number) => {
    if (!confirm("حذف هذا التوقف؟")) return;
    const r = await fetch(`${API}/api/production/downtime-events/${id}`, { method: "DELETE", headers });
    if (r.ok) { void loadEvents(); void loadOee(); }
  };

  const saveReason = async () => {
    const url = editingReasonId
      ? `${API}/api/production/downtime-reasons/${editingReasonId}`
      : `${API}/api/production/downtime-reasons`;
    const r = await fetch(url, {
      method: editingReasonId ? "PUT" : "POST",
      headers,
      body: JSON.stringify(newReason),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      toast({ title: "فشل الحفظ", description: e?.error, variant: "destructive" }); return;
    }
    toast({ title: editingReasonId ? "تم التحديث" : "تم الإضافة" });
    setShowReasonForm(false);
    setEditingReasonId(null);
    setNewReason({ code: "", nameAr: "", nameEn: "", category: "unplanned" });
    void loadCore();
  };

  const startEditReason = (r: Reason) => {
    setEditingReasonId(r.id);
    setNewReason({
      code: r.code, nameAr: r.nameAr, nameEn: r.nameEn ?? "",
      category: (r.category === "planned" ? "planned" : "unplanned"),
    });
    setShowReasonForm(true);
  };

  const removeReason = async (id: number) => {
    if (!confirm("حذف هذا السبب؟ الأحداث المرتبطة ستبقى بدون سبب.")) return;
    const r = await fetch(`${API}/api/production/downtime-reasons/${id}`, { method: "DELETE", headers });
    if (r.ok) void loadCore();
  };

  // Aggregate totals across all centers for the dashboard.
  const totals = useMemo(() => {
    if (!oee || oee.length === 0) return null;
    const sum = oee.reduce((acc, r) => ({
      plannedMinutes:   acc.plannedMinutes   + r.plannedMinutes,
      downtimeMinutes:  acc.downtimeMinutes  + r.downtimeMinutes,
      availableMinutes: acc.availableMinutes + r.availableMinutes,
      producedQty:      acc.producedQty      + r.producedQty,
      wasteQty:         acc.wasteQty         + r.wasteQty,
    }), { plannedMinutes: 0, downtimeMinutes: 0, availableMinutes: 0, producedQty: 0, wasteQty: 0 });
    const avg = oee.reduce((a, r) => a + r.oee, 0) / oee.length;
    return { ...sum, avgOee: avg };
  }, [oee]);

  return (
    <div className="container mx-auto p-4 space-y-4" dir="rtl">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Gauge className="h-6 w-6 text-purple-600" />
          <div>
            <h1 className="text-2xl font-bold">التوقفات وكفاءة المعدات (OEE)</h1>
            <p className="text-sm text-slate-500">
              سجّل أحداث التوقف لكل مركز عمل، واطّلع على مؤشرات الكفاءة (التوافر × الجودة).
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div>
              <Label className="text-xs">من تاريخ</Label>
              <DateField value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">إلى تاريخ</Label>
              <DateField value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="md:col-span-2 flex gap-2 flex-wrap">
              <Button variant="outline" onClick={() => { setFrom(daysAgoISO(0)); setTo(todayISO()); }}>اليوم</Button>
              <Button variant="outline" onClick={() => { setFrom(daysAgoISO(7)); setTo(todayISO()); }}>7 أيام</Button>
              <Button variant="outline" onClick={() => { setFrom(daysAgoISO(30)); setTo(todayISO()); }}>30 يوم</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="oee"><Gauge className="h-4 w-4 me-1" />لوحة OEE</TabsTrigger>
          <TabsTrigger value="events"><Timer className="h-4 w-4 me-1" />سجل التوقفات</TabsTrigger>
          <TabsTrigger value="reasons"><AlertOctagon className="h-4 w-4 me-1" />أسباب التوقف</TabsTrigger>
        </TabsList>

        <TabsContent value="oee" className="space-y-3">
          {totals && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <Card><CardContent className="p-3 text-center">
                <div className="text-xs text-slate-500">متوسط OEE</div>
                <div className={`text-2xl font-bold mt-1 inline-block px-2 rounded border ${oeeColor(totals.avgOee)}`}>
                  {fmtPct(totals.avgOee)}
                </div>
              </CardContent></Card>
              <Card><CardContent className="p-3 text-center">
                <div className="text-xs text-slate-500">وقت مخطط</div>
                <div className="text-lg font-bold mt-2">{fmtMin(totals.plannedMinutes)}</div>
              </CardContent></Card>
              <Card><CardContent className="p-3 text-center">
                <div className="text-xs text-slate-500">وقت توقف</div>
                <div className="text-lg font-bold mt-2 text-rose-700">{fmtMin(totals.downtimeMinutes)}</div>
              </CardContent></Card>
              <Card><CardContent className="p-3 text-center">
                <div className="text-xs text-slate-500">إنتاج جيد</div>
                <div className="text-lg font-bold mt-2 text-emerald-700">{totals.producedQty.toLocaleString("en-US")}</div>
              </CardContent></Card>
              <Card><CardContent className="p-3 text-center">
                <div className="text-xs text-slate-500">هدر</div>
                <div className="text-lg font-bold mt-2 text-amber-700">{totals.wasteQty.toLocaleString("en-US")}</div>
              </CardContent></Card>
            </div>
          )}

          <Card>
            <CardContent className="p-0">
              {!oee ? (
                <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
              ) : oee.length === 0 ? (
                <div className="p-8 text-center text-slate-500">
                  <Gauge className="h-10 w-10 mx-auto mb-2 opacity-40" />
                  لا توجد مراكز عمل نشطة
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-100/60 text-xs">
                      <tr>
                        <th className="p-3 text-start">مركز العمل</th>
                        <th className="p-3 text-end">وقت مخطط</th>
                        <th className="p-3 text-end">توقف مخطط</th>
                        <th className="p-3 text-end">توقف غير مخطط</th>
                        <th className="p-3 text-end">وقت متاح</th>
                        <th className="p-3 text-center">التوافر</th>
                        <th className="p-3 text-center">الجودة</th>
                        <th className="p-3 text-center">OEE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {oee.map((r) => (
                        <tr key={r.workCenterId} className="border-t hover:bg-slate-50">
                          <td className="p-3">
                            <div className="font-bold">{r.nameAr}</div>
                            <div className="text-[10px] text-slate-500 font-mono">{r.code}</div>
                          </td>
                          <td className="p-3 text-end font-mono">{fmtMin(r.plannedMinutes)}</td>
                          <td className="p-3 text-end font-mono text-blue-700">{fmtMin(r.downtimePlanned)}</td>
                          <td className="p-3 text-end font-mono text-rose-700">{fmtMin(r.downtimeUnplanned)}</td>
                          <td className="p-3 text-end font-mono text-emerald-700">{fmtMin(r.availableMinutes)}</td>
                          <td className="p-3 text-center font-mono">{fmtPct(r.availability)}</td>
                          <td className="p-3 text-center font-mono">
                            {r.producedQty + r.wasteQty > 0
                              ? fmtPct(r.quality)
                              : <span className="text-slate-400">—</span>}
                          </td>
                          <td className="p-3 text-center">
                            {r.producedQty + r.wasteQty > 0 ? (
                              <span className={`px-2 py-0.5 rounded border font-bold ${oeeColor(r.oee)}`}>
                                {fmtPct(r.oee)}
                              </span>
                            ) : (
                              <span className="text-slate-400 text-xs">لا إنتاج</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="text-xs text-slate-500 px-1">
            OEE = التوافر × الجودة. بُعد الأداء (cycle time) غير مدرج بعد ويُضاف لاحقاً.
          </div>
        </TabsContent>

        <TabsContent value="events" className="space-y-3">
          <div className="flex justify-end">
            <Button onClick={() => setShowEventForm((v) => !v)}>
              <Plus className="h-4 w-4 me-1" />تسجيل توقف
            </Button>
          </div>
          {showEventForm && (
            <Card className="border-purple-200">
              <CardContent className="p-3 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">مركز العمل *</Label>
                    <select className="h-10 rounded border border-input bg-background px-2 text-sm w-full"
                      value={newEvent.workCenterId}
                      onChange={(e) => setNewEvent({ ...newEvent, workCenterId: e.target.value })}>
                      <option value="">— اختر —</option>
                      {workCenters.map((w) => (
                        <option key={w.id} value={w.id}>{w.code} — {w.nameAr}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs">السبب</Label>
                    <select className="h-10 rounded border border-input bg-background px-2 text-sm w-full"
                      value={newEvent.reasonId}
                      onChange={(e) => setNewEvent({ ...newEvent, reasonId: e.target.value })}>
                      <option value="">— بدون سبب محدد —</option>
                      {reasons.filter((r) => r.isActive).map((r) => (
                        <option key={r.id} value={r.id}>
                          [{CATEGORY_LABEL[r.category]?.label ?? r.category}] {r.code} — {r.nameAr}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs">البداية *</Label>
                    <Input type="datetime-local" value={newEvent.startAt}
                      onChange={(e) => setNewEvent({ ...newEvent, startAt: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-xs">النهاية *</Label>
                    <Input type="datetime-local" value={newEvent.endAt}
                      onChange={(e) => setNewEvent({ ...newEvent, endAt: e.target.value })} />
                  </div>
                  <div className="md:col-span-2">
                    <Label className="text-xs">ملاحظات</Label>
                    <Input value={newEvent.notes} onChange={(e) => setNewEvent({ ...newEvent, notes: e.target.value })} />
                  </div>
                </div>
                <div className="flex justify-end gap-2 border-t pt-2">
                  <Button variant="outline" onClick={() => setShowEventForm(false)}>
                    <X className="h-4 w-4 me-1" />إلغاء
                  </Button>
                  <Button onClick={saveEvent}><Save className="h-4 w-4 me-1" />حفظ</Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0">
              {!events ? (
                <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
              ) : events.length === 0 ? (
                <div className="p-8 text-center text-slate-500">
                  <Timer className="h-10 w-10 mx-auto mb-2 opacity-40" />
                  لا توجد توقفات في هذه الفترة
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-100/60 text-xs">
                      <tr>
                        <th className="p-3 text-start">مركز العمل</th>
                        <th className="p-3 text-start">السبب</th>
                        <th className="p-3 text-start">البداية</th>
                        <th className="p-3 text-start">النهاية</th>
                        <th className="p-3 text-end">المدة</th>
                        <th className="p-3 text-start">ملاحظات</th>
                        <th className="p-3 text-center w-12"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((e) => (
                        <tr key={e.id} className="border-t hover:bg-slate-50">
                          <td className="p-3 font-bold">{e.workCenterNameAr ?? `#${e.workCenterId}`}</td>
                          <td className="p-3">
                            {e.reasonId ? (
                              <div>
                                {e.reasonCategory && (
                                  <Badge className={`text-[10px] me-1 ${CATEGORY_LABEL[e.reasonCategory]?.cls ?? ""}`}>
                                    {CATEGORY_LABEL[e.reasonCategory]?.label ?? e.reasonCategory}
                                  </Badge>
                                )}
                                {e.reasonNameAr}
                              </div>
                            ) : (
                              <span className="text-slate-400 text-xs">—</span>
                            )}
                          </td>
                          <td className="p-3 font-mono text-xs">{new Date(e.startAt).toLocaleString("ar-SA")}</td>
                          <td className="p-3 font-mono text-xs">{new Date(e.endAt).toLocaleString("ar-SA")}</td>
                          <td className="p-3 text-end font-mono">{fmtMin(e.durationMinutes)}</td>
                          <td className="p-3 text-xs text-slate-600">{e.notes || "—"}</td>
                          <td className="p-3 text-center">
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600"
                              onClick={() => removeEvent(e.id)}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reasons" className="space-y-3">
          <div className="flex justify-end">
            <Button onClick={() => {
              setEditingReasonId(null);
              setNewReason({ code: "", nameAr: "", nameEn: "", category: "unplanned" });
              setShowReasonForm((v) => !v);
            }}>
              <Plus className="h-4 w-4 me-1" />سبب جديد
            </Button>
          </div>
          {showReasonForm && (
            <Card className="border-purple-200">
              <CardContent className="p-3 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div>
                    <Label className="text-xs">الرمز *</Label>
                    <Input value={newReason.code} onChange={(e) => setNewReason({ ...newReason, code: e.target.value })} />
                  </div>
                  <div className="md:col-span-2">
                    <Label className="text-xs">الاسم العربي *</Label>
                    <Input value={newReason.nameAr} onChange={(e) => setNewReason({ ...newReason, nameAr: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-xs">التصنيف</Label>
                    <select className="h-10 rounded border border-input bg-background px-2 text-sm w-full"
                      value={newReason.category}
                      onChange={(e) => setNewReason({ ...newReason, category: e.target.value as any })}>
                      <option value="unplanned">غير مخطط</option>
                      <option value="planned">مخطط</option>
                    </select>
                  </div>
                </div>
                <div className="flex justify-end gap-2 border-t pt-2">
                  <Button variant="outline" onClick={() => { setShowReasonForm(false); setEditingReasonId(null); }}>
                    <X className="h-4 w-4 me-1" />إلغاء
                  </Button>
                  <Button onClick={saveReason}><Save className="h-4 w-4 me-1" />حفظ</Button>
                </div>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardContent className="p-0">
              {reasons.length === 0 ? (
                <div className="p-8 text-center text-slate-500">
                  <AlertOctagon className="h-10 w-10 mx-auto mb-2 opacity-40" />
                  لا توجد أسباب — أضف الأول
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-100/60 text-xs">
                    <tr>
                      <th className="p-3 text-start">الرمز</th>
                      <th className="p-3 text-start">الاسم</th>
                      <th className="p-3 text-center">التصنيف</th>
                      <th className="p-3 text-center w-24"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {reasons.map((r) => (
                      <tr key={r.id} className="border-t hover:bg-slate-50">
                        <td className="p-3 font-mono">{r.code}</td>
                        <td className="p-3">{r.nameAr}{r.nameEn ? ` / ${r.nameEn}` : ""}</td>
                        <td className="p-3 text-center">
                          <Badge className={`text-[10px] ${CATEGORY_LABEL[r.category]?.cls ?? ""}`}>
                            {CATEGORY_LABEL[r.category]?.label ?? r.category}
                          </Badge>
                        </td>
                        <td className="p-3 text-center">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                            onClick={() => startEditReason(r)}>
                            <Wrench className="h-3 w-3" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600"
                            onClick={() => removeReason(r.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
