import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CalendarClock, Save, Trash2, Loader2, CheckCircle2, XCircle, Clock, Sparkles, Wand2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

const STATUS: Record<string, { label: string; cls: string; icon: any }> = {
  present:  { label: "حاضر",   cls: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  absent:   { label: "غائب",   cls: "bg-rose-50 text-rose-700 border-rose-200", icon: XCircle },
  leave:    { label: "إجازة",  cls: "bg-sky-50 text-sky-700 border-sky-200", icon: CalendarClock },
  late:     { label: "متأخر",  cls: "bg-amber-50 text-amber-700 border-amber-200", icon: Clock },
  weekend:  { label: "إجازة أسبوعية", cls: "bg-slate-50 text-slate-600 border-slate-200", icon: CalendarClock },
};

const today = () => new Date().toISOString().slice(0, 10);

export default function Attendance() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [date, setDate] = useState(today());
  const [tab, setTab] = useState("daily");

  const { data: employees = [] } = useQuery<any[]>({ queryKey: ["employees"], queryFn: () => employeesApi.list() });
  const { data: attendance = [], isLoading } = useQuery<any[]>({
    queryKey: ["attendance", date],
    queryFn: () => employeesApi.attendance({ date }),
  });

  const activeEmps = useMemo(() => employees.filter((e: any) => e.status === "active"), [employees]);

  const [draft, setDraft] = useState<Record<number, { checkIn: string; checkOut: string; status: string; notes: string }>>({});
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState("");
  const [aiPreview, setAiPreview] = useState<any[] | null>(null);
  const [aiSummary, setAiSummary] = useState<string>("");

  const aiParse = useMutation({
    mutationFn: () => employeesApi.aiParseAttendance({
      text: aiText, employees: activeEmps, date,
      defaultCheckIn: "08:00", defaultCheckOut: "17:00",
    }),
    onSuccess: (r: any) => {
      setAiPreview(r.records || []);
      setAiSummary(r.summary || "");
      if (!r.records?.length) toast({ variant: "destructive", title: "لم نستطع استخراج أي سجل من النص" });
    },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  function applyAiPreview() {
    if (!aiPreview) return;
    const next: any = { ...draft };
    for (const rec of aiPreview) {
      next[rec.employeeId] = {
        checkIn: rec.checkIn || "",
        checkOut: rec.checkOut || "",
        status: rec.status || "present",
        notes: rec.notes || merged[rec.employeeId]?.notes || "",
      };
    }
    setDraft(next);
    toast({ title: `تم تطبيق ${aiPreview.length} سجل`, description: "راجع البيانات ثم اضغط حفظ الكل" });
    setAiOpen(false); setAiText(""); setAiPreview(null); setAiSummary("");
  }

  // Pre-fill draft from existing attendance
  const merged = useMemo(() => {
    const map: any = {};
    for (const e of activeEmps) {
      const existing = attendance.find((a: any) => a.employeeId === e.id);
      const d = draft[e.id];
      map[e.id] = {
        checkIn: d?.checkIn ?? existing?.checkIn ?? "",
        checkOut: d?.checkOut ?? existing?.checkOut ?? "",
        status: d?.status ?? existing?.status ?? "present",
        notes: d?.notes ?? existing?.notes ?? "",
        existingId: existing?.id,
        workedHours: existing?.workedHours,
        overtimeHours: existing?.overtimeHours,
      };
    }
    return map;
  }, [activeEmps, attendance, draft]);

  function setEmpField(empId: number, field: string, value: string) {
    setDraft(d => ({ ...d, [empId]: { ...merged[empId], ...d[empId], [field]: value } }));
  }

  const bulkSave = useMutation({
    mutationFn: async () => {
      const records = activeEmps.map((e: any) => {
        const r = merged[e.id];
        return {
          employeeId: e.id,
          checkIn: r.checkIn || null,
          checkOut: r.checkOut || null,
          status: r.status,
          notes: r.notes || null,
        };
      });
      return employeesApi.bulkAttendance(date, records);
    },
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["attendance"] });
      setDraft({});
      toast({ title: `تم حفظ ${r.saved} سجل حضور`, description: date });
    },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  const delAtt = useMutation({
    mutationFn: (id: number) => employeesApi.deleteAttendance(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["attendance"] }); toast({ title: "تم الحذف" }); },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  function markAll(status: string, ci: string = "08:00", co: string = "17:00") {
    const next: any = {};
    for (const e of activeEmps) {
      next[e.id] = {
        checkIn: status === "present" ? ci : "",
        checkOut: status === "present" ? co : "",
        status,
        notes: merged[e.id]?.notes || "",
      };
    }
    setDraft(next);
    toast({ title: status === "present" ? "تم تعليم الجميع كحاضرين" : status === "weekend" ? "تم تعليم الجميع كإجازة أسبوعية" : "تم تعليم الجميع كغائبين" });
  }

  // Monthly summary
  const monthFrom = `${date.slice(0, 7)}-01`;
  const monthTo = new Date(new Date(date).getFullYear(), new Date(date).getMonth() + 1, 0).toISOString().slice(0, 10);
  const { data: monthAtt = [] } = useQuery<any[]>({
    queryKey: ["attendance-month", monthFrom, monthTo],
    queryFn: () => employeesApi.attendance({ from: monthFrom, to: monthTo }),
    enabled: tab === "monthly",
  });

  const monthSummary = useMemo(() => {
    const byEmp: Record<number, any> = {};
    for (const e of activeEmps) byEmp[e.id] = { emp: e, present: 0, absent: 0, leave: 0, late: 0, weekend: 0, overtime: 0, workedHrs: 0 };
    for (const a of monthAtt) {
      const s = byEmp[a.employeeId]; if (!s) continue;
      s[a.status] = (s[a.status] || 0) + 1;
      s.overtime += Number(a.overtimeHours || 0);
      s.workedHrs += Number(a.workedHours || 0);
    }
    return Object.values(byEmp);
  }, [activeEmps, monthAtt]);

  const STATUS_AI: any = STATUS;

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-attendance">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <CalendarClock className="size-6 text-primary" />
          <h1 className="text-xl font-semibold">الحضور والانصراف</h1>
        </div>
        <div className="flex items-center gap-2">
          <Input type="date" value={date} onChange={e => { setDate(e.target.value); setDraft({}); }} className="w-40" data-testid="input-date" />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="daily" data-testid="tab-daily">إدخال يومي</TabsTrigger>
          <TabsTrigger value="monthly" data-testid="tab-monthly">ملخص شهري</TabsTrigger>
        </TabsList>

        <TabsContent value="daily" className="space-y-3">
          <div className="rounded-lg border bg-card p-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">إجراءات سريعة:</span>
            <Button variant="outline" size="sm" onClick={() => markAll("present")} data-testid="btn-mark-all-present">
              <CheckCircle2 className="size-3.5 me-1" /> تعليم الجميع حاضر
            </Button>
            <Button variant="outline" size="sm" onClick={() => markAll("weekend", "", "")} data-testid="btn-mark-weekend">
              <CalendarClock className="size-3.5 me-1" /> إجازة أسبوعية
            </Button>
            <Button variant="outline" size="sm" onClick={() => markAll("absent", "", "")} data-testid="btn-mark-absent">
              <XCircle className="size-3.5 me-1" /> الكل غائب
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAiOpen(true)}
              className="bg-gradient-to-l from-violet-50 to-blue-50 border-violet-200 text-violet-700 hover:bg-violet-100"
              data-testid="btn-ai-attendance">
              <Wand2 className="size-3.5 me-1" /> إدخال ذكي بالـ AI
            </Button>
            <div className="ms-auto">
              <Button onClick={() => bulkSave.mutate()} disabled={bulkSave.isPending} data-testid="btn-save-attendance">
                {bulkSave.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Save className="size-4 me-1" />}
                حفظ الكل
              </Button>
            </div>
          </div>

          <div className="rounded-lg border overflow-x-auto bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase">
                <tr>
                  <th className="p-2 text-start">الموظف</th>
                  <th className="p-2">الحالة</th>
                  <th className="p-2">حضور</th>
                  <th className="p-2">انصراف</th>
                  <th className="p-2">ساعات</th>
                  <th className="p-2">إضافي</th>
                  <th className="p-2 text-start">ملاحظات</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={8} className="p-4"><Skeleton className="h-12" /></td></tr>
                ) : activeEmps.length === 0 ? (
                  <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">لا يوجد موظفون نشطون</td></tr>
                ) : activeEmps.map((e: any) => {
                  const r = merged[e.id];
                  const st = STATUS[r.status] || STATUS.present;
                  const Icon = st.icon;
                  return (
                    <tr key={e.id} className="border-t" data-testid={`row-att-${e.id}`}>
                      <td className="p-2">
                        <div className="font-medium">{e.nameAr}</div>
                        <div className="text-xs text-muted-foreground">{e.code} · {e.jobTitle || "—"}</div>
                      </td>
                      <td className="p-2">
                        <select value={r.status} onChange={ev => setEmpField(e.id, "status", ev.target.value)}
                          className="h-8 rounded border bg-background px-2 text-xs" data-testid={`sel-status-${e.id}`}>
                          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </select>
                      </td>
                      <td className="p-2">
                        <Input type="time" value={r.checkIn} onChange={ev => setEmpField(e.id, "checkIn", ev.target.value)}
                          className="h-8 w-24 text-xs" disabled={r.status === "absent" || r.status === "weekend"}
                          data-testid={`in-${e.id}`} />
                      </td>
                      <td className="p-2">
                        <Input type="time" value={r.checkOut} onChange={ev => setEmpField(e.id, "checkOut", ev.target.value)}
                          className="h-8 w-24 text-xs" disabled={r.status === "absent" || r.status === "weekend"}
                          data-testid={`out-${e.id}`} />
                      </td>
                      <td className="p-2 text-center text-xs tabular-nums">{r.workedHours || "—"}</td>
                      <td className="p-2 text-center text-xs tabular-nums">{Number(r.overtimeHours || 0) > 0 ? <span className="text-emerald-700 font-medium">{r.overtimeHours}</span> : "—"}</td>
                      <td className="p-2">
                        <Input value={r.notes} onChange={ev => setEmpField(e.id, "notes", ev.target.value)} className="h-8 text-xs" placeholder="—" />
                      </td>
                      <td className="p-2">
                        <Badge variant="outline" className={st.cls}><Icon className="size-3 me-1" />{st.label}</Badge>
                        {r.existingId && (
                          <button onClick={() => delAtt.mutate(r.existingId)} className="ms-2 text-rose-500 hover:text-rose-700" title="حذف">
                            <Trash2 className="size-3.5 inline" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="text-xs text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2 flex items-start gap-2">
            <Sparkles className="size-3.5 text-blue-600 mt-0.5" />
            <div>
              <strong>تلميح ذكي:</strong> يتم احتساب ساعات العمل تلقائياً من وقت الحضور والانصراف. أي ساعات تزيد عن 8 تُعتبر <strong>وقتاً إضافياً</strong> ويتم احتساب أجرها 1.5× في مسير الرواتب وفق المادة 107 من نظام العمل.
            </div>
          </div>
        </TabsContent>

        <TabsContent value="monthly" className="space-y-3">
          <div className="rounded-lg border overflow-x-auto bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase">
                <tr>
                  <th className="p-2 text-start">الموظف</th>
                  <th className="p-2">حضور</th>
                  <th className="p-2">غياب</th>
                  <th className="p-2">إجازة</th>
                  <th className="p-2">إجازة أسبوعية</th>
                  <th className="p-2">إجمالي ساعات</th>
                  <th className="p-2">ساعات إضافية</th>
                </tr>
              </thead>
              <tbody>
                {monthSummary.length === 0 ? (
                  <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا توجد بيانات</td></tr>
                ) : monthSummary.map((s: any) => (
                  <tr key={s.emp.id} className="border-t" data-testid={`row-month-${s.emp.id}`}>
                    <td className="p-2">
                      <div className="font-medium">{s.emp.nameAr}</div>
                      <div className="text-xs text-muted-foreground">{s.emp.code}</div>
                    </td>
                    <td className="p-2 text-center font-semibold text-emerald-700">{s.present}</td>
                    <td className="p-2 text-center font-semibold text-rose-700">{s.absent}</td>
                    <td className="p-2 text-center text-sky-700">{s.leave}</td>
                    <td className="p-2 text-center text-slate-600">{s.weekend}</td>
                    <td className="p-2 text-center tabular-nums">{s.workedHrs.toFixed(1)}</td>
                    <td className="p-2 text-center tabular-nums text-emerald-700">{s.overtime.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={aiOpen} onOpenChange={(o) => { setAiOpen(o); if (!o) { setAiText(""); setAiPreview(null); setAiSummary(""); } }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wand2 className="size-5 text-violet-600" /> إدخال الحضور بالذكاء الاصطناعي
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded border bg-violet-50/40 border-violet-200 p-3 text-xs space-y-1">
              <div className="font-semibold text-violet-900">اكتب أو الصق ملخص الحضور بلغتك العادية. أمثلة:</div>
              <ul className="list-disc list-inside text-violet-800 space-y-0.5">
                <li>"كل الموظفين حضروا 8 صباحاً وانصرفوا 5 مساءً"</li>
                <li>"محمد متأخر 9:30، أحمد غايب، سارة إجازة، الباقي عادي"</li>
                <li>"حسن من 8 إلى 7" (سيُحسب الإضافي تلقائياً بعد 8 ساعات عمل)</li>
                <li>"الجميع إجازة أسبوعية" (يوم جمعة مثلاً)</li>
              </ul>
            </div>

            <Textarea
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              rows={5}
              placeholder="اكتب هنا… مثال: كل الموظفين 8 إلى 5 ما عدا حسن متأخر 9 ومحمد غايب"
              className="text-sm"
              data-testid="ai-attendance-text"
              dir="rtl"
            />

            <div className="flex items-center gap-2">
              <Button onClick={() => aiParse.mutate()} disabled={!aiText.trim() || aiParse.isPending} data-testid="btn-ai-parse">
                {aiParse.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Sparkles className="size-4 me-1" />}
                تحليل بالذكاء الاصطناعي
              </Button>
              {aiSummary && <span className="text-xs text-muted-foreground">{aiSummary}</span>}
            </div>

            {aiPreview && aiPreview.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-semibold flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-emerald-600" />
                  معاينة ({aiPreview.length} سجل) — راجع ثم طبّق:
                </div>
                <div className="rounded border overflow-hidden max-h-72 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 sticky top-0">
                      <tr>
                        <th className="p-1.5 text-start">الموظف</th>
                        <th className="p-1.5">الحالة</th>
                        <th className="p-1.5">حضور</th>
                        <th className="p-1.5">انصراف</th>
                        <th className="p-1.5 text-start">ملاحظات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aiPreview.map((rec: any, i: number) => {
                        const st = STATUS_AI[rec.status] || STATUS_AI.present;
                        const Icon = st.icon;
                        return (
                          <tr key={i} className="border-t">
                            <td className="p-1.5 font-medium">{rec.empNameAr}</td>
                            <td className="p-1.5">
                              <Badge variant="outline" className={st.cls}><Icon className="size-3 me-1" />{st.label}</Badge>
                            </td>
                            <td className="p-1.5 text-center tabular-nums">{rec.checkIn || "—"}</td>
                            <td className="p-1.5 text-center tabular-nums">{rec.checkOut || "—"}</td>
                            <td className="p-1.5 text-muted-foreground">{rec.notes || "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAiOpen(false)}>إلغاء</Button>
            <Button onClick={applyAiPreview} disabled={!aiPreview || aiPreview.length === 0} data-testid="btn-ai-apply">
              <CheckCircle2 className="size-4 me-1" /> تطبيق على الجدول
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
