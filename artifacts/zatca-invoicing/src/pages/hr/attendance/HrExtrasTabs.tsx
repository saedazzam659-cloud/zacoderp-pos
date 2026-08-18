// المخالفات المسجلة + الخروج والعودة — امتداد لشاشة الحضور والانصراف.
// المخالفات: سجل تأديبي فعلي (نوع/سبب/قيمة/خصم من الراتب) بجانب جدول مخالفات
// الحضور المحسوبة. الخروج والعودة: تتبع سفر الموظف مع تنبيه قبل العودة بأسبوع.
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { DateField } from "@/components/ui/date-field";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, Pencil, Loader2, AlertTriangle, Plane, Undo2 } from "lucide-react";
import { fmt2 } from "@/lib/format";

const today = () => new Date().toISOString().slice(0, 10);
const num = (v: any) => Number(v ?? 0) || 0;

type Common = { employees: any[]; pickName: (ar?: string, en?: string) => string; isRtl: boolean };

function EmpPicker({ employees, pickName, value, onChange }: Common & { value: string; onChange: (v: string) => void }) {
  return (
    <SearchCombobox
      items={employees.map((e: any) => ({ value: String(e.id), code: e.code, label: pickName(e.nameAr, e.nameEn) }))}
      value={value}
      onValueChange={onChange}
      placeholder="اختر الموظف"
      className="w-full"
    />
  );
}

// ─── المخالفات المسجلة ────────────────────────────────────────────────────────
const V_EMPTY: any = { employeeId: "", violationType: "", violationDate: today(), reason: "", amount: 0, deductFromSalary: false, notes: "" };
const V_TYPES = ["تأخير متكرر", "غياب بدون إذن", "إهمال في العمل", "مخالفة تعليمات", "سوء سلوك", "إتلاف ممتلكات", "أخرى"];
const V_STATUS: Record<string, { label: string; cls: string }> = {
  pending:  { label: "قائمة",  cls: "bg-amber-50 text-amber-700 border-amber-200" },
  deducted: { label: "مخصومة من الراتب", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  waived:   { label: "معفاة", cls: "bg-slate-50 text-slate-600 border-slate-200" },
};

export function RegisteredViolationsSection({ employees, pickName, isRtl }: Common) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<any>(V_EMPTY);

  const { data: rows = [], isLoading } = useQuery<any[]>({
    queryKey: ["hr-violations"],
    queryFn: () => employeesApi.violations(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["hr-violations"] });
  const onError = (e: any) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        employeeId: Number(form.employeeId),
        violationType: form.violationType,
        violationDate: form.violationDate,
        reason: form.reason || undefined,
        amount: num(form.amount),
        deductFromSalary: !!form.deductFromSalary,
        notes: form.notes || undefined,
        ...(form.status ? { status: form.status } : {}),
      };
      return editingId ? employeesApi.updateViolation(editingId, payload) : employeesApi.addViolation(payload);
    },
    onSuccess: () => { invalidate(); setOpen(false); setForm(V_EMPTY); setEditingId(null); toast({ title: editingId ? "تم التعديل" : "تمت إضافة المخالفة" }); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: number) => employeesApi.deleteViolation(id),
    onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); },
    onError,
  });

  function openEdit(v: any) {
    setEditingId(v.id);
    setForm({
      employeeId: String(v.employeeId), violationType: v.violationType, violationDate: v.violationDate,
      reason: v.reason || "", amount: v.amount, deductFromSalary: !!v.deductFromSalary, notes: v.notes || "",
      status: v.status === "waived" ? "waived" : "pending",
    });
    setOpen(true);
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between p-3 border-b flex-wrap gap-2">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangle className="size-4 text-amber-600" /> المخالفات المسجلة
          <span className="text-xs text-muted-foreground font-normal">(مخالفات تأديبية بقرار — يمكن خصمها من الراتب)</span>
        </div>
        <Button size="sm" onClick={() => { setEditingId(null); setForm(V_EMPTY); setOpen(true); }} data-testid="btn-new-violation">
          <Plus className="size-3.5 me-1" /> مخالفة جديدة
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase">
            <tr>
              <th className="p-2 text-start">الموظف</th>
              <th className="p-2">النوع</th>
              <th className="p-2">التاريخ</th>
              <th className="p-2 text-start">السبب</th>
              <th className="p-2">القيمة</th>
              <th className="p-2">خصم من الراتب</th>
              <th className="p-2">الحالة</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={8} className="p-4"><Skeleton className="h-10" /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="p-5 text-center text-muted-foreground">لا توجد مخالفات مسجلة</td></tr>
            ) : rows.map((v: any) => {
              const st = V_STATUS[v.status] || V_STATUS.pending;
              return (
                <tr key={v.id} className="border-t" data-testid={`row-violation-${v.id}`}>
                  <td className="p-2">
                    <div className="font-medium">{pickName(v.empNameAr, v.empNameEn)}</div>
                    <div className="text-xs text-muted-foreground">{v.empCode}</div>
                  </td>
                  <td className="p-2 text-center text-xs">{v.violationType}</td>
                  <td className="p-2 text-center text-xs">{v.violationDate}</td>
                  <td className="p-2 text-xs">{v.reason || "—"}</td>
                  <td className="p-2 text-center text-xs tabular-nums">{fmt2(num(v.amount))}</td>
                  <td className="p-2 text-center text-xs">{v.deductFromSalary ? "نعم" : "لا"}</td>
                  <td className="p-2 text-center"><Badge variant="outline" className={st.cls}>{st.label}</Badge></td>
                  <td className="p-2 text-end whitespace-nowrap">
                    {v.status !== "deducted" && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(v)} data-testid={`btn-edit-violation-${v.id}`}>
                          <Pencil className="size-3.5 text-sky-600" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { if (confirm("حذف المخالفة؟")) del.mutate(v.id); }} data-testid={`btn-del-violation-${v.id}`}>
                          <Trash2 className="size-3.5 text-rose-600" />
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-muted-foreground border-t p-2">
        المخالفات المعلَّمة «خصم من الراتب» تُخصم تلقائيًا في أول مسير رواتب قادم (بند «خصم مخالفات»)، وتصبح غير قابلة للتعديل بعد الخصم.
      </div>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setForm(V_EMPTY); setEditingId(null); } }}>
        <DialogContent className="max-w-lg" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader><DialogTitle>{editingId ? "تعديل مخالفة" : "مخالفة جديدة"}</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <label className="text-xs font-medium">الموظف</label>
              <EmpPicker employees={employees} pickName={pickName} isRtl={isRtl} value={form.employeeId} onChange={(v) => setForm({ ...form, employeeId: v })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium">نوع المخالفة</label>
                <SearchCombobox
                  items={V_TYPES.map((t) => ({ value: t, label: t }))}
                  value={form.violationType}
                  onValueChange={(v) => setForm({ ...form, violationType: v })}
                  placeholder="اختر النوع"
                  className="w-full"
                />
              </div>
              <div>
                <label className="text-xs font-medium">التاريخ</label>
                <DateField value={form.violationDate} onChange={(e) => setForm({ ...form, violationDate: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium">السبب</label>
              <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3 items-end">
              <div>
                <label className="text-xs font-medium">القيمة (ر.س)</label>
                <Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </div>
              <label className="flex items-center gap-2 text-xs font-medium pb-2 cursor-pointer">
                <input type="checkbox" checked={!!form.deductFromSalary} onChange={(e) => setForm({ ...form, deductFromSalary: e.target.checked })} />
                خصم من الراتب في المسير القادم
              </label>
            </div>
            {editingId && (
              <div>
                <label className="text-xs font-medium">الحالة</label>
                <select className="h-9 w-full rounded border bg-background px-2 text-sm" value={form.status || "pending"}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="pending">قائمة</option>
                  <option value="waived">معفاة</option>
                </select>
              </div>
            )}
            <div>
              <label className="text-xs font-medium">ملاحظات</label>
              <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !form.employeeId || !form.violationType} data-testid="btn-save-violation">
              {save.isPending && <Loader2 className="size-4 me-1 animate-spin" />} حفظ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── الخروج والعودة ──────────────────────────────────────────────────────────
const T_EMPTY: any = { employeeId: "", exitDate: today(), exitTime: "", expectedReturnDate: "", expectedReturnTime: "", notes: "" };

function daysUntil(date?: string | null): number | null {
  if (!date) return null;
  return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
}

export function TravelsTab({ employees, pickName, isRtl }: Common) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<any>(T_EMPTY);
  const [returnFor, setReturnFor] = useState<any | null>(null);
  const [retDate, setRetDate] = useState(today());
  const [retTime, setRetTime] = useState("");

  const { data: rows = [], isLoading } = useQuery<any[]>({
    queryKey: ["hr-travels"],
    queryFn: () => employeesApi.travels(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["hr-travels"] });
  const onError = (e: any) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        employeeId: Number(form.employeeId),
        exitDate: form.exitDate,
        exitTime: form.exitTime || undefined,
        expectedReturnDate: form.expectedReturnDate || undefined,
        expectedReturnTime: form.expectedReturnTime || undefined,
        notes: form.notes || undefined,
      };
      return editingId ? employeesApi.updateTravel(editingId, payload) : employeesApi.addTravel(payload);
    },
    onSuccess: () => { invalidate(); setOpen(false); setForm(T_EMPTY); setEditingId(null); toast({ title: "تم الحفظ" }); },
    onError,
  });
  const markReturn = useMutation({
    mutationFn: () => employeesApi.updateTravel(returnFor.id, { actualReturnDate: retDate, actualReturnTime: retTime || undefined }),
    onSuccess: () => { invalidate(); setReturnFor(null); toast({ title: "تم تسجيل العودة" }); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: number) => employeesApi.deleteTravel(id),
    onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); },
    onError,
  });

  const alerts = useMemo(() => rows.filter((r: any) => {
    if (r.status !== "out" || !r.expectedReturnDate) return false;
    const d = daysUntil(r.expectedReturnDate);
    return d != null && d <= 7;
  }), [rows]);

  return (
    <div className="space-y-3">
      {alerts.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm space-y-1" data-testid="travel-alerts">
          <div className="font-medium text-amber-800 flex items-center gap-2"><Plane className="size-4" /> تنبيه: موعد عودة قريب (خلال أسبوع)</div>
          {alerts.map((r: any) => {
            const d = daysUntil(r.expectedReturnDate)!;
            return (
              <div key={r.id} className="text-xs text-amber-800">
                • {pickName(r.empNameAr, r.empNameEn)} — العودة المتوقعة {r.expectedReturnDate}{" "}
                {d < 0 ? <strong className="text-rose-700">(متأخر {Math.abs(d)} يوم)</strong> : d === 0 ? <strong>(اليوم)</strong> : `(باقي ${d} يوم)`}
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between p-3 border-b">
          <div className="flex items-center gap-2 font-medium"><Plane className="size-4 text-sky-600" /> سجل الخروج والعودة</div>
          <Button size="sm" onClick={() => { setEditingId(null); setForm(T_EMPTY); setOpen(true); }} data-testid="btn-new-travel">
            <Plus className="size-3.5 me-1" /> تسجيل خروج
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase">
              <tr>
                <th className="p-2 text-start">الموظف</th>
                <th className="p-2">الخروج</th>
                <th className="p-2">العودة المتوقعة</th>
                <th className="p-2">العودة الفعلية</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-start">ملاحظات</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={7} className="p-4"><Skeleton className="h-10" /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="p-5 text-center text-muted-foreground">لا توجد سجلات خروج وعودة</td></tr>
              ) : rows.map((r: any) => {
                const d = r.status === "out" ? daysUntil(r.expectedReturnDate) : null;
                const overdue = d != null && d < 0;
                return (
                  <tr key={r.id} className="border-t" data-testid={`row-travel-${r.id}`}>
                    <td className="p-2">
                      <div className="font-medium">{pickName(r.empNameAr, r.empNameEn)}</div>
                      <div className="text-xs text-muted-foreground">{r.empCode}</div>
                    </td>
                    <td className="p-2 text-center text-xs">{r.exitDate}{r.exitTime ? ` ${r.exitTime}` : ""}</td>
                    <td className="p-2 text-center text-xs">
                      {r.expectedReturnDate || "—"}{r.expectedReturnTime ? ` ${r.expectedReturnTime}` : ""}
                      {d != null && d <= 7 && r.status === "out" && (
                        <div className={`text-[10px] ${overdue ? "text-rose-600 font-semibold" : "text-amber-600"}`}>
                          {overdue ? `متأخر ${Math.abs(d)} يوم` : d === 0 ? "اليوم" : `باقي ${d} يوم`}
                        </div>
                      )}
                    </td>
                    <td className="p-2 text-center text-xs">{r.actualReturnDate || "—"}{r.actualReturnTime ? ` ${r.actualReturnTime}` : ""}</td>
                    <td className="p-2 text-center">
                      {r.status === "out"
                        ? <Badge variant="outline" className={overdue ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-sky-50 text-sky-700 border-sky-200"}>{overdue ? "متأخر عن العودة" : "خارج"}</Badge>
                        : <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">عاد</Badge>}
                    </td>
                    <td className="p-2 text-xs">{r.notes || "—"}</td>
                    <td className="p-2 text-end whitespace-nowrap">
                      {r.status === "out" && (
                        <Button size="sm" variant="ghost" title="تسجيل العودة" onClick={() => { setReturnFor(r); setRetDate(today()); setRetTime(""); }} data-testid={`btn-return-travel-${r.id}`}>
                          <Undo2 className="size-3.5 text-emerald-600" />
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => {
                        setEditingId(r.id);
                        setForm({
                          employeeId: String(r.employeeId), exitDate: r.exitDate, exitTime: r.exitTime || "",
                          expectedReturnDate: r.expectedReturnDate || "", expectedReturnTime: r.expectedReturnTime || "", notes: r.notes || "",
                        });
                        setOpen(true);
                      }} data-testid={`btn-edit-travel-${r.id}`}>
                        <Pencil className="size-3.5 text-sky-600" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { if (confirm("حذف السجل؟")) del.mutate(r.id); }} data-testid={`btn-del-travel-${r.id}`}>
                        <Trash2 className="size-3.5 text-rose-600" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setForm(T_EMPTY); setEditingId(null); } }}>
        <DialogContent className="max-w-lg" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader><DialogTitle>{editingId ? "تعديل سجل خروج" : "تسجيل خروج"}</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <label className="text-xs font-medium">الموظف</label>
              <EmpPicker employees={employees} pickName={pickName} isRtl={isRtl} value={form.employeeId} onChange={(v) => setForm({ ...form, employeeId: v })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium">تاريخ الخروج</label>
                <DateField value={form.exitDate} onChange={(e) => setForm({ ...form, exitDate: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-medium">وقت الخروج</label>
                <Input type="time" value={form.exitTime} onChange={(e) => setForm({ ...form, exitTime: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-medium">تاريخ العودة المتوقع</label>
                <DateField value={form.expectedReturnDate} onChange={(e) => setForm({ ...form, expectedReturnDate: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-medium">وقت العودة المتوقع</label>
                <Input type="time" value={form.expectedReturnTime} onChange={(e) => setForm({ ...form, expectedReturnTime: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium">ملاحظات</label>
              <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="text-[11px] text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2">
              يظهر تنبيه تلقائي هنا وفي تنبيهات الموظفين قبل موعد العودة المتوقع بأسبوع.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !form.employeeId || !form.exitDate} data-testid="btn-save-travel">
              {save.isPending && <Loader2 className="size-4 me-1 animate-spin" />} حفظ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!returnFor} onOpenChange={(o) => { if (!o) setReturnFor(null); }}>
        <DialogContent className="max-w-sm" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader><DialogTitle>تسجيل العودة</DialogTitle></DialogHeader>
          {returnFor && (
            <div className="space-y-3 text-sm">
              <div className="rounded border bg-muted/30 p-2 text-xs">
                <strong>{pickName(returnFor.empNameAr, returnFor.empNameEn)}</strong> — خرج بتاريخ {returnFor.exitDate}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium">تاريخ العودة الفعلي</label>
                  <DateField value={retDate} onChange={(e) => setRetDate(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-medium">وقت العودة</label>
                  <Input type="time" value={retTime} onChange={(e) => setRetTime(e.target.value)} />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturnFor(null)}>إلغاء</Button>
            <Button onClick={() => markReturn.mutate()} disabled={markReturn.isPending || !retDate} data-testid="btn-confirm-return">
              {markReturn.isPending && <Loader2 className="size-4 me-1 animate-spin" />} تأكيد العودة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
