import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { CalendarClock, Plus, Trash2, X, Save, Edit3, CalendarX, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.VITE_API_URL || "";

// 0=Sun … 6=Sat — matches JS getDay()
const DAYS_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

type Shift = {
  id: number;
  name: string;
  code: string;
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
  breakMinutes: number;
  color: string;
  isActive: boolean;
  notes: string | null;
};
type Holiday = {
  id: number;
  shiftId: number | null;
  date: string;
  name: string;
  isFullDay: boolean;
  notes: string | null;
};

const EMPTY_SHIFT = {
  id: null as number | null,
  name: "",
  code: "",
  startTime: "08:00",
  endTime: "16:00",
  daysOfWeek: [0, 1, 2, 3, 4] as number[],
  breakMinutes: 60,
  color: "#3b82f6",
  isActive: true,
  notes: "",
};

const EMPTY_HOLIDAY = {
  shiftId: null as number | null,
  date: new Date().toISOString().slice(0, 10),
  name: "",
  isFullDay: true,
  notes: "",
};

function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60; // overnight
  return mins;
}

export default function ShiftCalendar() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [holidays, setHolidays] = useState<Holiday[] | null>(null);
  const [editingShift, setEditingShift] = useState<typeof EMPTY_SHIFT | null>(null);
  const [editingHoliday, setEditingHoliday] = useState<typeof EMPTY_HOLIDAY | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"shifts" | "holidays">("shifts");

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }),
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [sR, hR] = await Promise.all([
        fetch(`${API}/api/production/shifts`, { headers }),
        fetch(`${API}/api/production/shift-holidays`, { headers }),
      ]);
      if (sR.ok) setShifts(await sR.json());
      if (hR.ok) setHolidays(await hR.json());
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }, [token, headers, toast]);

  useEffect(() => { void load(); }, [load]);

  const toggleDay = (d: number) => {
    if (!editingShift) return;
    const has = editingShift.daysOfWeek.includes(d);
    setEditingShift({
      ...editingShift,
      daysOfWeek: has
        ? editingShift.daysOfWeek.filter((x) => x !== d)
        : [...editingShift.daysOfWeek, d].sort(),
    });
  };

  const saveShift = async () => {
    if (!editingShift) return;
    if (!editingShift.name.trim() || !editingShift.code.trim()) {
      toast({ title: "الاسم والرمز مطلوبان", variant: "destructive" });
      return;
    }
    if (editingShift.daysOfWeek.length === 0) {
      toast({ title: "اختر يوماً واحداً على الأقل", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const url = editingShift.id
        ? `${API}/api/production/shifts/${editingShift.id}`
        : `${API}/api/production/shifts`;
      const r = await fetch(url, {
        method: editingShift.id ? "PUT" : "POST",
        headers,
        body: JSON.stringify({
          name: editingShift.name.trim(),
          code: editingShift.code.trim(),
          startTime: editingShift.startTime,
          endTime: editingShift.endTime,
          daysOfWeek: editingShift.daysOfWeek,
          breakMinutes: editingShift.breakMinutes,
          color: editingShift.color,
          isActive: editingShift.isActive,
          notes: editingShift.notes.trim() || null,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${r.status}`);
      }
      toast({ title: editingShift.id ? "تم التحديث" : "تم الإنشاء" });
      setEditingShift(null);
      void load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const saveHoliday = async () => {
    if (!editingHoliday) return;
    if (!editingHoliday.name.trim() || !editingHoliday.date) {
      toast({ title: "الاسم والتاريخ مطلوبان", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/production/shift-holidays`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          shiftId: editingHoliday.shiftId,
          date: editingHoliday.date,
          name: editingHoliday.name.trim(),
          isFullDay: editingHoliday.isFullDay,
          notes: editingHoliday.notes.trim() || null,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${r.status}`);
      }
      toast({ title: "تم إضافة العطلة" });
      setEditingHoliday(null);
      void load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const removeShift = async (id: number) => {
    if (!confirm("حذف الوردية نهائياً؟ (سيُحذف معها سجل العطلات الخاص بها)")) return;
    const r = await fetch(`${API}/api/production/shifts/${id}`, { method: "DELETE", headers });
    if (r.ok) { toast({ title: "تم الحذف" }); void load(); }
    else toast({ title: "فشل الحذف", variant: "destructive" });
  };

  const removeHoliday = async (id: number) => {
    if (!confirm("حذف العطلة؟")) return;
    const r = await fetch(`${API}/api/production/shift-holidays/${id}`, { method: "DELETE", headers });
    if (r.ok) { toast({ title: "تم الحذف" }); void load(); }
    else toast({ title: "فشل الحذف", variant: "destructive" });
  };

  // Weekly grid: 7 columns (days), shifts shown as colored blocks under each
  // day where they're active. Helps visualize coverage at a glance.
  const shiftsForDay = (d: number) =>
    (shifts ?? []).filter((s) => s.isActive && s.daysOfWeek.includes(d));

  return (
    <div className="container mx-auto p-4 space-y-4" dir="rtl">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <CalendarClock className="h-6 w-6 text-blue-600" />
          <div>
            <h1 className="text-2xl font-bold">تقويم الورديات</h1>
            <p className="text-sm text-slate-500">
              عرّف ورديات العمل وأوقاتها وأيام النشاط، وسجّل العطلات والاستثناءات.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant={tab === "shifts" ? "default" : "outline"}
            size="sm"
            onClick={() => setTab("shifts")}
          >الورديات ({shifts?.length ?? 0})</Button>
          <Button
            variant={tab === "holidays" ? "default" : "outline"}
            size="sm"
            onClick={() => setTab("holidays")}
          >العطلات ({holidays?.length ?? 0})</Button>
        </div>
      </div>

      {/* Weekly overview — always visible */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Sun className="h-4 w-4" />تغطية الأسبوع
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!shifts ? (
            <Skeleton className="h-24" />
          ) : (
            <div className="grid grid-cols-7 gap-2">
              {DAYS_AR.map((d, idx) => {
                const dayShifts = shiftsForDay(idx);
                return (
                  <div key={idx} className="rounded-md border bg-slate-50 min-h-[100px] p-2 space-y-1">
                    <div className="text-xs font-bold text-slate-600 text-center mb-1">{d}</div>
                    {dayShifts.length === 0 ? (
                      <div className="text-[10px] text-slate-400 text-center mt-3">إجازة</div>
                    ) : (
                      dayShifts.map((s) => (
                        <div
                          key={s.id}
                          className="rounded px-1.5 py-1 text-[10px] text-white"
                          style={{ backgroundColor: s.color }}
                          title={`${s.name} • ${s.startTime}-${s.endTime}`}
                        >
                          <div className="font-bold truncate">{s.code}</div>
                          <div className="opacity-90 text-[9px]">{s.startTime}-{s.endTime}</div>
                        </div>
                      ))
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* TAB: Shifts */}
      {tab === "shifts" && (
        <>
          <div className="flex justify-end">
            <Button onClick={() => setEditingShift({ ...EMPTY_SHIFT })} data-testid="btn-new-shift">
              <Plus className="h-4 w-4 me-1" />وردية جديدة
            </Button>
          </div>

          {editingShift && (
            <Card className="border-blue-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {editingShift.id ? `تعديل الوردية #${editingShift.id}` : "وردية جديدة"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">الاسم *</Label>
                    <Input
                      value={editingShift.name}
                      onChange={(e) => setEditingShift({ ...editingShift, name: e.target.value })}
                      placeholder="وردية الصباح"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">الرمز * (فريد)</Label>
                    <Input
                      value={editingShift.code}
                      onChange={(e) => setEditingShift({ ...editingShift, code: e.target.value })}
                      placeholder="M"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">اللون</Label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={editingShift.color}
                        onChange={(e) => setEditingShift({ ...editingShift, color: e.target.value })}
                        className="h-10 w-12 rounded border"
                      />
                      <Input
                        value={editingShift.color}
                        onChange={(e) => setEditingShift({ ...editingShift, color: e.target.value })}
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">وقت البداية *</Label>
                    <Input
                      type="time"
                      value={editingShift.startTime}
                      onChange={(e) => setEditingShift({ ...editingShift, startTime: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">وقت النهاية *</Label>
                    <Input
                      type="time"
                      value={editingShift.endTime}
                      onChange={(e) => setEditingShift({ ...editingShift, endTime: e.target.value })}
                    />
                    {editingShift.startTime && editingShift.endTime && (
                      <div className="text-[11px] text-slate-500 mt-1">
                        المدة: {(minutesBetween(editingShift.startTime, editingShift.endTime) / 60).toFixed(1)} ساعة
                        {editingShift.endTime <= editingShift.startTime && " (تمتد لليوم التالي)"}
                      </div>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs">مدة الراحة (دقيقة)</Label>
                    <Input
                      type="number"
                      min={0}
                      value={editingShift.breakMinutes}
                      onChange={(e) => setEditingShift({ ...editingShift, breakMinutes: Number(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs">أيام العمل *</Label>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {DAYS_AR.map((d, idx) => {
                      const active = editingShift.daysOfWeek.includes(idx);
                      return (
                        <Button
                          key={idx}
                          type="button"
                          size="sm"
                          variant={active ? "default" : "outline"}
                          onClick={() => toggleDay(idx)}
                          className="h-8"
                        >
                          {d}
                        </Button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editingShift.isActive}
                      onChange={(e) => setEditingShift({ ...editingShift, isActive: e.target.checked })}
                      className="h-4 w-4"
                    />
                    مفعّلة
                  </label>
                </div>

                <div>
                  <Label className="text-xs">ملاحظات</Label>
                  <Textarea
                    rows={2}
                    value={editingShift.notes}
                    onChange={(e) => setEditingShift({ ...editingShift, notes: e.target.value })}
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t">
                  <Button variant="outline" onClick={() => setEditingShift(null)} disabled={saving}>
                    <X className="h-4 w-4 me-1" />إلغاء
                  </Button>
                  <Button onClick={saveShift} disabled={saving}>
                    <Save className="h-4 w-4 me-1" />{saving ? "جاري الحفظ..." : "حفظ"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0">
              {!shifts ? (
                <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
              ) : shifts.length === 0 ? (
                <div className="p-8 text-center text-slate-500">
                  <CalendarClock className="h-10 w-10 mx-auto mb-2 opacity-40" />
                  لا توجد ورديات — أضف الأولى
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-100/60 text-xs">
                      <tr>
                        <th className="p-3 text-start">الاسم</th>
                        <th className="p-3 text-start">الرمز</th>
                        <th className="p-3 text-center">الوقت</th>
                        <th className="p-3 text-start">الأيام</th>
                        <th className="p-3 text-center">الراحة</th>
                        <th className="p-3 text-center">الحالة</th>
                        <th className="p-3 text-center w-24">إجراءات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shifts.map((s) => (
                        <tr key={s.id} className="border-t hover:bg-slate-50">
                          <td className="p-3">
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded" style={{ backgroundColor: s.color }} />
                              <span className="font-bold">{s.name}</span>
                            </div>
                          </td>
                          <td className="p-3 font-mono text-xs">{s.code}</td>
                          <td className="p-3 text-center font-mono text-xs">
                            {s.startTime} – {s.endTime}
                          </td>
                          <td className="p-3 text-xs">
                            {s.daysOfWeek.map((d) => (
                              <Badge key={d} variant="outline" className="me-1 text-[10px]">
                                {DAYS_AR[d]}
                              </Badge>
                            ))}
                          </td>
                          <td className="p-3 text-center text-xs">{s.breakMinutes}د</td>
                          <td className="p-3 text-center">
                            {s.isActive ? (
                              <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">مفعّلة</Badge>
                            ) : (
                              <Badge variant="outline">معطّلة</Badge>
                            )}
                          </td>
                          <td className="p-3">
                            <div className="flex items-center justify-center gap-1">
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                                onClick={() => setEditingShift({
                                  id: s.id,
                                  name: s.name,
                                  code: s.code,
                                  startTime: s.startTime,
                                  endTime: s.endTime,
                                  daysOfWeek: s.daysOfWeek,
                                  breakMinutes: s.breakMinutes,
                                  color: s.color,
                                  isActive: s.isActive,
                                  notes: s.notes ?? "",
                                })}>
                                <Edit3 className="h-3 w-3" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600"
                                onClick={() => removeShift(s.id)}>
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* TAB: Holidays */}
      {tab === "holidays" && (
        <>
          <div className="flex justify-end">
            <Button onClick={() => setEditingHoliday({ ...EMPTY_HOLIDAY })}>
              <Plus className="h-4 w-4 me-1" />عطلة جديدة
            </Button>
          </div>

          {editingHoliday && (
            <Card className="border-amber-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">عطلة / استثناء</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">الاسم *</Label>
                    <Input
                      value={editingHoliday.name}
                      onChange={(e) => setEditingHoliday({ ...editingHoliday, name: e.target.value })}
                      placeholder="اليوم الوطني"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">التاريخ *</Label>
                    <DateField
                      value={editingHoliday.date}
                      onChange={(e) => setEditingHoliday({ ...editingHoliday, date: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">الوردية المتأثرة</Label>
                    <select
                      value={editingHoliday.shiftId ?? ""}
                      onChange={(e) => setEditingHoliday({
                        ...editingHoliday,
                        shiftId: e.target.value ? Number(e.target.value) : null,
                      })}
                      className="h-10 rounded border border-input bg-background px-2 text-sm w-full"
                    >
                      <option value="">— جميع الورديات —</option>
                      {(shifts ?? []).map((s) => (
                        <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
                      ))}
                    </select>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editingHoliday.isFullDay}
                    onChange={(e) => setEditingHoliday({ ...editingHoliday, isFullDay: e.target.checked })}
                    className="h-4 w-4"
                  />
                  يوم كامل (إيقاف العمل بالكامل)
                </label>
                <div>
                  <Label className="text-xs">ملاحظات</Label>
                  <Textarea
                    rows={2}
                    value={editingHoliday.notes}
                    onChange={(e) => setEditingHoliday({ ...editingHoliday, notes: e.target.value })}
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2 border-t">
                  <Button variant="outline" onClick={() => setEditingHoliday(null)} disabled={saving}>
                    <X className="h-4 w-4 me-1" />إلغاء
                  </Button>
                  <Button onClick={saveHoliday} disabled={saving}>
                    <Save className="h-4 w-4 me-1" />{saving ? "جاري الحفظ..." : "حفظ"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0">
              {!holidays ? (
                <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
              ) : holidays.length === 0 ? (
                <div className="p-8 text-center text-slate-500">
                  <CalendarX className="h-10 w-10 mx-auto mb-2 opacity-40" />
                  لا توجد عطلات مسجلة
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-100/60 text-xs">
                      <tr>
                        <th className="p-3 text-start">التاريخ</th>
                        <th className="p-3 text-start">الاسم</th>
                        <th className="p-3 text-start">الوردية</th>
                        <th className="p-3 text-center">يوم كامل</th>
                        <th className="p-3 text-start">ملاحظات</th>
                        <th className="p-3 text-center w-16">حذف</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holidays.map((h) => {
                        const shift = h.shiftId
                          ? (shifts ?? []).find((s) => s.id === h.shiftId)
                          : null;
                        return (
                          <tr key={h.id} className="border-t hover:bg-slate-50">
                            <td className="p-3 font-mono text-xs">{h.date}</td>
                            <td className="p-3 font-bold">{h.name}</td>
                            <td className="p-3">
                              {shift ? (
                                <Badge variant="outline" className="gap-1">
                                  <div className="w-2 h-2 rounded" style={{ backgroundColor: shift.color }} />
                                  {shift.name}
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-slate-500">جميع الورديات</Badge>
                              )}
                            </td>
                            <td className="p-3 text-center">
                              {h.isFullDay ? "✓" : "—"}
                            </td>
                            <td className="p-3 text-xs text-slate-500 max-w-[300px] truncate">{h.notes ?? "—"}</td>
                            <td className="p-3 text-center">
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-600"
                                onClick={() => removeHoliday(h.id)}>
                                <Trash2 className="h-3 w-3" />
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
        </>
      )}
    </div>
  );
}
