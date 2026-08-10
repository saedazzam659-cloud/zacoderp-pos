// ملف الموظف الشامل — Employee Lifecycle Profile
// تبويبات: نظرة عامة، تعديلات الراتب، النقل والتكليف، التقييمات، جهات الطوارئ،
// الأسرة والتابعون، المؤهلات، الشهادات، المستندات، السجل الوظيفي، نهاية الخدمة.
// لا يكرر الشاشات الموجودة (العقود/الحضور/الإجازات/العهد لها شاشاتها) — يضيف
// الأجزاء الناقصة فقط ويعرض روابط سريعة للأجزاء القائمة.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { employeesApi } from "@/lib/employeesApi";
import { hrCoreApi, type HrSubResource } from "@/lib/hrCoreApi";
import { fmt2 } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { DateField } from "@/components/ui/date-field";
import {
  ArrowRight, Plus, Trash2, Pencil, UserRound, Wallet, ArrowLeftRight, Star,
  PhoneCall, Users, GraduationCap, BadgeCheck, FolderOpen, History, DoorOpen,
  FileSignature, CalendarDays, Package, CheckCircle2,
} from "lucide-react";

const today = () => new Date().toISOString().slice(0, 10);
const num = (v: any) => Number(v ?? 0) || 0;

// ─── أوصاف الحقول لكل sub-resource (يبني الجدول والنموذج تلقائياً) ────────────
type FieldDef = { key: string; label: string; type?: "text" | "date" | "number" | "bool" | "textarea"; required?: boolean };
const SUBS: Record<string, { title: string; icon: any; fields: FieldDef[] }> = {
  "emergency-contacts": {
    title: "جهات اتصال الطوارئ", icon: PhoneCall,
    fields: [
      { key: "name", label: "الاسم", required: true },
      { key: "relation", label: "صلة القرابة" },
      { key: "phone", label: "الهاتف" },
      { key: "phone2", label: "هاتف إضافي" },
      { key: "email", label: "البريد" },
      { key: "address", label: "العنوان" },
      { key: "isPrimary", label: "أساسية", type: "bool" },
    ],
  },
  "dependents": {
    title: "الأسرة والتابعون", icon: Users,
    fields: [
      { key: "name", label: "الاسم", required: true },
      { key: "relation", label: "صلة القرابة" },
      { key: "birthDate", label: "تاريخ الميلاد", type: "date" },
      { key: "gender", label: "النوع" },
      { key: "idNumber", label: "رقم الهوية" },
      { key: "benefitsEligible", label: "مستحق للمزايا/التأمين", type: "bool" },
      { key: "notes", label: "ملاحظات", type: "textarea" },
    ],
  },
  "qualifications": {
    title: "المؤهلات العلمية", icon: GraduationCap,
    fields: [
      { key: "degree", label: "المؤهل", required: true },
      { key: "specialty", label: "التخصص" },
      { key: "institution", label: "الجامعة/الجهة" },
      { key: "gradYear", label: "سنة التخرج" },
      { key: "grade", label: "التقدير" },
    ],
  },
  "certificates": {
    title: "الشهادات", icon: BadgeCheck,
    fields: [
      { key: "name", label: "اسم الشهادة", required: true },
      { key: "issuer", label: "الجهة المانحة" },
      { key: "certNumber", label: "رقم الشهادة" },
      { key: "issueDate", label: "تاريخ الحصول", type: "date" },
      { key: "expiryDate", label: "تاريخ الانتهاء", type: "date" },
      { key: "notes", label: "ملاحظات", type: "textarea" },
    ],
  },
  "documents": {
    title: "المستندات", icon: FolderOpen,
    fields: [
      { key: "docType", label: "نوع المستند", required: true },
      { key: "docNumber", label: "رقم المستند" },
      { key: "issueDate", label: "تاريخ الإصدار", type: "date" },
      { key: "expiryDate", label: "تاريخ الانتهاء", type: "date" },
      { key: "fileUrl", label: "رابط الملف" },
      { key: "notes", label: "ملاحظات", type: "textarea" },
    ],
  },
  "evaluations": {
    title: "التقييمات", icon: Star,
    fields: [
      { key: "evalDate", label: "تاريخ التقييم", type: "date", required: true },
      { key: "periodFrom", label: "الفترة من", type: "date" },
      { key: "periodTo", label: "الفترة إلى", type: "date" },
      { key: "evaluator", label: "المقيِّم" },
      { key: "score", label: "الدرجة", type: "number" },
      { key: "result", label: "النتيجة" },
      { key: "strengths", label: "نقاط القوة", type: "textarea" },
      { key: "weaknesses", label: "نقاط الضعف", type: "textarea" },
      { key: "recommendations", label: "التوصيات", type: "textarea" },
      { key: "nextEvalDate", label: "التقييم القادم", type: "date" },
    ],
  },
};

const HISTORY_LABEL: Record<string, string> = {
  salary_adjustment: "تعديل راتب", transfer: "نقل", assignment: "تكليف",
  promotion: "ترقية", evaluation: "تقييم", termination: "نهاية خدمة",
  status_change: "تغيير حالة", contract: "عقد", hire: "تعيين",
};
const MOVE_LABEL: Record<string, string> = {
  transfer: "نقل", assignment: "تكليف مؤقت", promotion: "ترقية",
  job_change: "تغيير وظيفة", branch_change: "تغيير فرع",
  department_change: "تغيير إدارة", manager_change: "تغيير مدير",
};
const TERM_LABEL: Record<string, string> = {
  resignation: "استقالة", contract_end: "انتهاء عقد", termination: "إنهاء خدمة",
  dismissal: "فصل", retirement: "تقاعد", other: "أخرى",
};

function FieldInput({ def, value, onChange }: { def: FieldDef; value: any; onChange: (v: any) => void }) {
  if (def.type === "bool") return (
    <label className="flex h-9 items-center gap-2 text-sm cursor-pointer">
      <input type="checkbox" className="h-4 w-4 accent-primary" checked={!!value} onChange={e => onChange(e.target.checked)} />
      <span>{def.label}</span>
    </label>
  );
  if (def.type === "date") return <DateField value={value ?? ""} onChange={onChange} />;
  if (def.type === "textarea") return <Textarea rows={2} value={value ?? ""} onChange={e => onChange(e.target.value)} />;
  return <Input type="text" inputMode={def.type === "number" ? "decimal" : undefined} value={value ?? ""} onChange={e => onChange(e.target.value)} />;
}

// ─── تبويب sub-resource عام (جدول + نموذج إضافة/تعديل + حذف) ─────────────────
function SubTab({ empId, subKey }: { empId: number; subKey: HrSubResource }) {
  const cfg = SUBS[subKey];
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["hr-core", empId, subKey], queryFn: () => hrCoreApi.sub(empId, subKey) });
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<any>({});
  const invalidate = () => qc.invalidateQueries({ queryKey: ["hr-core", empId, subKey] });

  const saveMut = useMutation({
    mutationFn: (d: any) => editId ? hrCoreApi.updateSub(empId, subKey, editId, d) : hrCoreApi.addSub(empId, subKey, d),
    onSuccess: () => { invalidate(); setOpen(false); toast({ title: "تم الحفظ" }); },
    onError: (e: any) => toast({ title: "فشل الحفظ", description: String(e.message ?? e), variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: number) => hrCoreApi.deleteSub(empId, subKey, id),
    onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); },
    onError: (e: any) => toast({ title: "فشل الحذف", description: String(e.message ?? e), variant: "destructive" }),
  });

  const rows = (q.data ?? []) as any[];
  const cols = cfg.fields.filter(f => f.type !== "textarea").slice(0, 6);
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <h3 className="font-semibold text-sm flex items-center gap-2"><cfg.icon className="h-4 w-4" />{cfg.title}</h3>
        <Button size="sm" onClick={() => { setEditId(null); setForm({}); setOpen(true); }} data-testid={`button-add-${subKey}`}>
          <Plus className="h-4 w-4 ms-1" />إضافة
        </Button>
      </div>
      {q.isLoading ? <Skeleton className="h-24 w-full" /> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground border rounded-lg p-4 text-center">لا توجد بيانات</p>
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                {cols.map(c => <th key={c.key} className="p-2 text-start font-medium">{c.label}</th>)}
                <th className="p-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t">
                  {cols.map(c => (
                    <td key={c.key} className="p-2">
                      {c.type === "bool" ? (r[c.key] ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : "—") : (r[c.key] ?? "—")}
                    </td>
                  ))}
                  <td className="p-2">
                    <div className="flex gap-1 justify-end">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditId(r.id); setForm(r); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-600" onClick={() => { if (confirm("تأكيد الحذف؟")) delMut.mutate(r.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editId ? "تعديل" : "إضافة"} — {cfg.title}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {cfg.fields.map(f => (
              <div key={f.key} className={f.type === "textarea" ? "col-span-2" : ""}>
                {f.type !== "bool" && <label className="text-xs text-muted-foreground block mb-1">{f.label}{f.required && " *"}</label>}
                <FieldInput def={f} value={form[f.key]} onChange={v => setForm((p: any) => ({ ...p, [f.key]: v }))} />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button onClick={() => {
              const missing = cfg.fields.find(f => f.required && !String(form[f.key] ?? "").trim());
              if (missing) { toast({ title: `${missing.label} مطلوب`, variant: "destructive" }); return; }
              saveMut.mutate(form);
            }} disabled={saveMut.isPending}>حفظ</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── تعديلات الرواتب ─────────────────────────────────────────────────────────
function SalaryTab({ empId, emp }: { empId: number; emp: any }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["hr-core", empId, "salary-adjustments"], queryFn: () => hrCoreApi.salaryAdjustments(empId) });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({});
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["hr-core", empId, "salary-adjustments"] });
    qc.invalidateQueries({ queryKey: ["employee", empId] });
    qc.invalidateQueries({ queryKey: ["hr-core", empId, "history"] });
  };
  const addMut = useMutation({
    mutationFn: (d: any) => hrCoreApi.addSalaryAdjustment(empId, d),
    onSuccess: () => { invalidate(); setOpen(false); toast({ title: "تم تسجيل تعديل الراتب" }); },
    onError: (e: any) => toast({ title: "فشل الحفظ", description: String(e.message ?? e), variant: "destructive" }),
  });
  const applyMut = useMutation({
    mutationFn: (id: number) => hrCoreApi.applySalaryAdjustment(empId, id),
    onSuccess: () => { invalidate(); toast({ title: "تم تطبيق التعديل" }); },
    onError: (e: any) => toast({ title: "فشل التطبيق", description: String(e.message ?? e), variant: "destructive" }),
  });
  const rows = (q.data ?? []) as any[];
  const curTotal = num(emp?.basicSalary) + num(emp?.housingAllow) + num(emp?.transportAllow) + num(emp?.otherAllow);
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm">
          <span className="text-muted-foreground">الراتب الحالي: </span>
          <span className="font-semibold">{fmt2(curTotal)}</span>
          <span className="text-xs text-muted-foreground"> (أساسي {fmt2(num(emp?.basicSalary))})</span>
        </div>
        <Button size="sm" onClick={() => {
          setForm({
            adjustmentDate: today(), effectiveDate: today(),
            newBasic: num(emp?.basicSalary), newHousing: num(emp?.housingAllow),
            newTransport: num(emp?.transportAllow), newOther: num(emp?.otherAllow),
          }); setOpen(true);
        }} data-testid="button-add-salary-adjustment"><Plus className="h-4 w-4 ms-1" />تعديل راتب</Button>
      </div>
      {q.isLoading ? <Skeleton className="h-24 w-full" /> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground border rounded-lg p-4 text-center">لا توجد تعديلات — الراتب السابق يُحفظ دائماً ولا يُستبدل</p>
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr>
              <th className="p-2 text-start">تاريخ السريان</th><th className="p-2 text-start">السابق</th>
              <th className="p-2 text-start">الجديد</th><th className="p-2 text-start">الزيادة</th>
              <th className="p-2 text-start">%</th><th className="p-2 text-start">السبب</th>
              <th className="p-2 text-start">الحالة</th><th className="p-2 w-24"></th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">{r.effectiveDate}</td>
                  <td className="p-2">{fmt2(num(r.prevTotal))}</td>
                  <td className="p-2 font-medium">{fmt2(num(r.newTotal))}</td>
                  <td className="p-2" dir="ltr">{fmt2(num(r.amount))}</td>
                  <td className="p-2" dir="ltr">{fmt2(num(r.percent))}%</td>
                  <td className="p-2">{r.reason ?? "—"}</td>
                  <td className="p-2">
                    <Badge variant="outline" className={r.status === "applied" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-amber-50 text-amber-700 border-amber-200"}>
                      {r.status === "applied" ? "مطبَّق" : r.status === "scheduled" ? "مجدول" : "ملغى"}
                    </Badge>
                  </td>
                  <td className="p-2">
                    {r.status === "scheduled" && (
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => applyMut.mutate(r.id)}>تطبيق الآن</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>تعديل الراتب</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-muted-foreground block mb-1">تاريخ القرار</label><DateField value={form.adjustmentDate ?? ""} onChange={v => setForm((p: any) => ({ ...p, adjustmentDate: v }))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">تاريخ السريان *</label><DateField value={form.effectiveDate ?? ""} onChange={v => setForm((p: any) => ({ ...p, effectiveDate: v }))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">الأساسي الجديد *</label><Input inputMode="decimal" dir="ltr" value={form.newBasic ?? ""} onChange={e => setForm((p: any) => ({ ...p, newBasic: e.target.value }))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">بدل السكن</label><Input inputMode="decimal" dir="ltr" value={form.newHousing ?? ""} onChange={e => setForm((p: any) => ({ ...p, newHousing: e.target.value }))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">بدل النقل</label><Input inputMode="decimal" dir="ltr" value={form.newTransport ?? ""} onChange={e => setForm((p: any) => ({ ...p, newTransport: e.target.value }))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">بدلات أخرى</label><Input inputMode="decimal" dir="ltr" value={form.newOther ?? ""} onChange={e => setForm((p: any) => ({ ...p, newOther: e.target.value }))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">قرار التعديل</label><Input value={form.decisionRef ?? ""} onChange={e => setForm((p: any) => ({ ...p, decisionRef: e.target.value }))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">السبب</label><Input value={form.reason ?? ""} onChange={e => setForm((p: any) => ({ ...p, reason: e.target.value }))} /></div>
            <div className="col-span-2"><label className="text-xs text-muted-foreground block mb-1">ملاحظات</label><Textarea rows={2} value={form.notes ?? ""} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button onClick={() => {
              if (!form.effectiveDate) { toast({ title: "تاريخ السريان مطلوب", variant: "destructive" }); return; }
              if (num(form.newBasic) <= 0) { toast({ title: "الأساسي الجديد مطلوب", variant: "destructive" }); return; }
              addMut.mutate(form);
            }} disabled={addMut.isPending}>حفظ</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── النقل والتكليف ──────────────────────────────────────────────────────────
function TransfersTab({ empId, emp }: { empId: number; emp: any }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["hr-core", empId, "transfers"], queryFn: () => hrCoreApi.transfers(empId) });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({});
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["hr-core", empId, "transfers"] });
    qc.invalidateQueries({ queryKey: ["employee", empId] });
    qc.invalidateQueries({ queryKey: ["hr-core", empId, "history"] });
  };
  const addMut = useMutation({
    mutationFn: (d: any) => hrCoreApi.addTransfer(empId, d),
    onSuccess: () => { invalidate(); setOpen(false); toast({ title: "تم تسجيل الحركة" }); },
    onError: (e: any) => toast({ title: "فشل الحفظ", description: String(e.message ?? e), variant: "destructive" }),
  });
  const applyMut = useMutation({
    mutationFn: (id: number) => hrCoreApi.applyTransfer(empId, id),
    onSuccess: () => { invalidate(); toast({ title: "تم التطبيق" }); },
    onError: (e: any) => toast({ title: "فشل", description: String(e.message ?? e), variant: "destructive" }),
  });
  const endMut = useMutation({
    mutationFn: (id: number) => hrCoreApi.endTransfer(empId, id),
    onSuccess: () => { invalidate(); toast({ title: "تم إنهاء التكليف" }); },
    onError: (e: any) => toast({ title: "فشل", description: String(e.message ?? e), variant: "destructive" }),
  });
  const rows = (q.data ?? []) as any[];
  const parse = (s: any) => { try { return typeof s === "string" ? JSON.parse(s) : (s ?? {}); } catch { return {}; } };
  const fmtSnap = (s: any) => {
    const o = parse(s);
    return [o.department && `إدارة: ${o.department}`, o.jobTitle && `وظيفة: ${o.jobTitle}`, o.branchId && `فرع: ${o.branchId}`].filter(Boolean).join(" · ") || "—";
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-muted-foreground">التكليف المؤقت لا يغيّر التبعية الأساسية — النقل الدائم يُطبَّق على ملف الموظف بتاريخ السريان</p>
        <Button size="sm" onClick={() => { setForm({ moveType: "transfer", effectiveFrom: today(), decisionDate: today(), newValue: { department: emp?.department ?? "", jobTitle: emp?.jobTitle ?? "" } }); setOpen(true); }} data-testid="button-add-transfer">
          <Plus className="h-4 w-4 ms-1" />حركة جديدة
        </Button>
      </div>
      {q.isLoading ? <Skeleton className="h-24 w-full" /> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground border rounded-lg p-4 text-center">لا توجد حركات</p>
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr>
              <th className="p-2 text-start">النوع</th><th className="p-2 text-start">من</th>
              <th className="p-2 text-start">إلى</th><th className="p-2 text-start">السريان</th>
              <th className="p-2 text-start">حتى</th><th className="p-2 text-start">السبب</th>
              <th className="p-2 text-start">الحالة</th><th className="p-2 w-28"></th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">
                    {MOVE_LABEL[r.moveType] ?? r.moveType}
                    {r.isTemporary && <Badge variant="outline" className="ms-1 text-[10px]">مؤقت</Badge>}
                  </td>
                  <td className="p-2 text-xs">{fmtSnap(r.prevValue)}</td>
                  <td className="p-2 text-xs">{fmtSnap(r.newValue)}</td>
                  <td className="p-2">{r.effectiveFrom}</td>
                  <td className="p-2">{r.effectiveTo ?? "—"}</td>
                  <td className="p-2">{r.reason ?? "—"}</td>
                  <td className="p-2">
                    <Badge variant="outline" className={
                      r.status === "applied" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : r.status === "scheduled" ? "bg-amber-50 text-amber-700 border-amber-200"
                      : "bg-slate-50 text-slate-600 border-slate-200"}>
                      {r.status === "applied" ? "مطبَّقة" : r.status === "scheduled" ? "مجدولة" : r.status === "ended" ? "منتهية" : "ملغاة"}
                    </Badge>
                  </td>
                  <td className="p-2">
                    <div className="flex gap-1 justify-end">
                      {r.status === "scheduled" && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => applyMut.mutate(r.id)}>تطبيق</Button>}
                      {r.isTemporary && r.status !== "ended" && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => endMut.mutate(r.id)}>إنهاء</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>حركة نقل / تكليف</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">نوع الحركة *</label>
              <Select value={form.moveType ?? "transfer"} onValueChange={v => setForm((p: any) => ({ ...p, moveType: v, isTemporary: v === "assignment" }))}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(MOVE_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <label className="flex h-9 items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={!!form.isTemporary} onChange={e => setForm((p: any) => ({ ...p, isTemporary: e.target.checked }))} />
                <span>تكليف مؤقت (لا يغيّر التبعية)</span>
              </label>
            </div>
            <div><label className="text-xs text-muted-foreground block mb-1">تاريخ القرار</label><DateField value={form.decisionDate ?? ""} onChange={v => setForm((p: any) => ({ ...p, decisionDate: v }))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">سريان من *</label><DateField value={form.effectiveFrom ?? ""} onChange={v => setForm((p: any) => ({ ...p, effectiveFrom: v }))} /></div>
            {form.isTemporary && (
              <div><label className="text-xs text-muted-foreground block mb-1">ينتهي في *</label><DateField value={form.effectiveTo ?? ""} onChange={v => setForm((p: any) => ({ ...p, effectiveTo: v }))} /></div>
            )}
            <div><label className="text-xs text-muted-foreground block mb-1">الإدارة الجديدة</label><Input value={form.newValue?.department ?? ""} onChange={e => setForm((p: any) => ({ ...p, newValue: { ...p.newValue, department: e.target.value } }))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">الوظيفة الجديدة</label><Input value={form.newValue?.jobTitle ?? ""} onChange={e => setForm((p: any) => ({ ...p, newValue: { ...p.newValue, jobTitle: e.target.value } }))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">جهة الاعتماد</label><Input value={form.approvedBy ?? ""} onChange={e => setForm((p: any) => ({ ...p, approvedBy: e.target.value }))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">السبب</label><Input value={form.reason ?? ""} onChange={e => setForm((p: any) => ({ ...p, reason: e.target.value }))} /></div>
            <div className="col-span-2"><label className="text-xs text-muted-foreground block mb-1">ملاحظات</label><Textarea rows={2} value={form.notes ?? ""} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button onClick={() => {
              if (!form.effectiveFrom) { toast({ title: "تاريخ السريان مطلوب", variant: "destructive" }); return; }
              if (form.isTemporary && !form.effectiveTo) { toast({ title: "التكليف المؤقت يتطلب تاريخ انتهاء", variant: "destructive" }); return; }
              addMut.mutate(form);
            }} disabled={addMut.isPending}>حفظ</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── نهاية الخدمة ────────────────────────────────────────────────────────────
function TerminationTab({ empId }: { empId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["hr-core", empId, "termination"], queryFn: () => hrCoreApi.terminations(empId) });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({});
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["hr-core", empId, "termination"] });
    qc.invalidateQueries({ queryKey: ["employee", empId] });
    qc.invalidateQueries({ queryKey: ["hr-core", empId, "history"] });
  };
  const addMut = useMutation({
    mutationFn: (d: any) => hrCoreApi.addTermination(empId, d),
    onSuccess: () => { invalidate(); setOpen(false); toast({ title: "تم تسجيل نهاية الخدمة — الملف محفوظ بالكامل" }); },
    onError: (e: any) => toast({ title: "فشل", description: String(e.message ?? e), variant: "destructive" }),
  });
  const updMut = useMutation({
    mutationFn: ({ id, d }: any) => hrCoreApi.updateTermination(empId, id, d),
    onSuccess: invalidate,
    onError: (e: any) => toast({ title: "فشل", description: String(e.message ?? e), variant: "destructive" }),
  });
  const cancelMut = useMutation({
    mutationFn: (id: number) => hrCoreApi.cancelTermination(empId, id),
    onSuccess: () => { invalidate(); toast({ title: "تم إلغاء نهاية الخدمة وإعادة الموظف" }); },
    onError: (e: any) => toast({ title: "فشل", description: String(e.message ?? e), variant: "destructive" }),
  });
  const rows = (q.data ?? []) as any[];
  const active = rows.find(r => r.status === "active");
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Link href={`/hr/end-of-service`} className="text-primary hover:underline flex items-center gap-1">
            <CalendarDays className="h-3.5 w-3.5" />حاسبة مكافأة نهاية الخدمة
          </Link>
        </div>
        {!active && (
          <Button size="sm" variant="destructive" onClick={() => { setForm({ terminationType: "resignation", lastWorkDay: today() }); setOpen(true); }} data-testid="button-add-termination">
            <DoorOpen className="h-4 w-4 ms-1" />تسجيل نهاية خدمة
          </Button>
        )}
      </div>
      {q.isLoading ? <Skeleton className="h-24 w-full" /> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground border rounded-lg p-4 text-center">الموظف على رأس العمل</p>
      ) : rows.map(r => (
        <div key={r.id} className="border rounded-lg p-4 space-y-3">
          <div className="flex justify-between items-start">
            <div>
              <div className="font-medium">{TERM_LABEL[r.terminationType] ?? r.terminationType}
                <Badge variant="outline" className={`ms-2 ${r.status === "active" ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-slate-50 text-slate-600"}`}>
                  {r.status === "active" ? "نشط" : "ملغى"}
                </Badge>
              </div>
              <div className="text-sm text-muted-foreground mt-1">آخر يوم عمل: {r.lastWorkDay}{r.reason ? ` · ${r.reason}` : ""}</div>
            </div>
            {r.status === "active" && (
              <Button variant="outline" size="sm" onClick={() => { if (confirm("إلغاء نهاية الخدمة وإعادة الموظف للعمل؟")) cancelMut.mutate(r.id); }}>إلغاء وإعادة للعمل</Button>
            )}
          </div>
          {r.status === "active" && (
            <div className="flex flex-wrap gap-4 text-sm">
              {([["settlementDone", "تسوية المستحقات"], ["custodyReturned", "تسليم العهد"], ["accessClosed", "إغلاق الصلاحيات"]] as const).map(([k, l]) => (
                <label key={k} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={!!r[k]} onChange={e => updMut.mutate({ id: r.id, d: { [k]: e.target.checked } })} />
                  <span>{l}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      ))}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>تسجيل نهاية الخدمة</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">النوع *</label>
              <Select value={form.terminationType ?? "resignation"} onValueChange={v => setForm((p: any) => ({ ...p, terminationType: v }))}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(TERM_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><label className="text-xs text-muted-foreground block mb-1">آخر يوم عمل *</label><DateField value={form.lastWorkDay ?? ""} onChange={v => setForm((p: any) => ({ ...p, lastWorkDay: v }))} /></div>
            <div className="col-span-2"><label className="text-xs text-muted-foreground block mb-1">السبب</label><Input value={form.reason ?? ""} onChange={e => setForm((p: any) => ({ ...p, reason: e.target.value }))} /></div>
            <div className="col-span-2"><label className="text-xs text-muted-foreground block mb-1">ملاحظات</label><Textarea rows={2} value={form.notes ?? ""} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} /></div>
          </div>
          <p className="text-xs text-muted-foreground">ملف الموظف وتاريخه يُحفظان بالكامل — تتغير حالته فقط ولا يُحذف من النظام.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button variant="destructive" onClick={() => {
              if (!form.lastWorkDay) { toast({ title: "آخر يوم عمل مطلوب", variant: "destructive" }); return; }
              addMut.mutate(form);
            }} disabled={addMut.isPending}>تسجيل</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── السجل الوظيفي ───────────────────────────────────────────────────────────
function HistoryTab({ empId }: { empId: number }) {
  const q = useQuery({ queryKey: ["hr-core", empId, "history"], queryFn: () => hrCoreApi.history(empId) });
  const rows = (q.data ?? []) as any[];
  const fmtVal = (s: any) => {
    if (!s) return "—";
    try {
      const o = typeof s === "string" ? JSON.parse(s) : s;
      return Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(" · ");
    } catch { return String(s); }
  };
  return q.isLoading ? <Skeleton className="h-32 w-full" /> : rows.length === 0 ? (
    <p className="text-sm text-muted-foreground border rounded-lg p-4 text-center">لا توجد أحداث بعد — كل تعديل راتب أو نقل أو تقييم أو نهاية خدمة يُسجَّل هنا تلقائياً</p>
  ) : (
    <div className="border rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50"><tr>
          <th className="p-2 text-start">التاريخ</th><th className="p-2 text-start">الحدث</th>
          <th className="p-2 text-start">القيمة السابقة</th><th className="p-2 text-start">القيمة الجديدة</th>
          <th className="p-2 text-start">السبب</th>
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t">
              <td className="p-2 whitespace-nowrap">{r.eventDate}</td>
              <td className="p-2"><Badge variant="outline">{HISTORY_LABEL[r.eventType] ?? r.eventType}</Badge></td>
              <td className="p-2 text-xs text-muted-foreground">{fmtVal(r.prevValue)}</td>
              <td className="p-2 text-xs">{fmtVal(r.newValue)}</td>
              <td className="p-2 text-xs">{r.reason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── الصفحة الرئيسية ─────────────────────────────────────────────────────────
export default function EmployeeProfile() {
  const [, params] = useRoute("/hr/employees/:id/profile");
  const empId = Number(params?.id);
  const empQ = useQuery({ queryKey: ["employee", empId], queryFn: () => employeesApi.get(empId), enabled: !!empId });
  const emp = empQ.data as any;
  const [tab, setTab] = useState("overview");

  const STATUS_LABEL: Record<string, string> = {
    active: "على رأس العمل", probation: "تحت التجربة", vacation: "إجازة",
    suspended: "موقوف", resigned: "مستقيل", terminated: "منتهي الخدمة", absent: "متغيب",
  };

  if (!empId) return null;
  return (
    <div className="p-4 space-y-4" dir="rtl">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/hr/employees"><Button variant="ghost" size="icon"><ArrowRight className="h-4 w-4" /></Button></Link>
        {empQ.isLoading ? <Skeleton className="h-10 w-64" /> : (
          <>
            <div className="h-11 w-11 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
              {emp?.photoUrl ? <img src={emp.photoUrl} alt="" className="h-full w-full object-cover" /> : <UserRound className="h-5 w-5 text-primary" />}
            </div>
            <div>
              <h1 className="text-lg font-bold">{emp?.nameAr}</h1>
              <div className="text-xs text-muted-foreground">
                {emp?.code} · {emp?.jobTitle ?? "—"} · {emp?.department ?? "—"}
                <Badge variant="outline" className="ms-2">{STATUS_LABEL[emp?.status] ?? emp?.status}</Badge>
              </div>
            </div>
          </>
        )}
        <div className="ms-auto flex gap-2 flex-wrap">
          <Link href={`/hr/employees/${empId}/contracts`}><Button variant="outline" size="sm"><FileSignature className="h-4 w-4 ms-1" />العقود والإجازات</Button></Link>
          <Link href="/hr/custody"><Button variant="outline" size="sm"><Package className="h-4 w-4 ms-1" />العهد</Button></Link>
          <Link href="/hr/attendance"><Button variant="outline" size="sm"><CalendarDays className="h-4 w-4 ms-1" />الحضور</Button></Link>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto justify-start">
          <TabsTrigger value="overview"><UserRound className="h-3.5 w-3.5 ms-1" />نظرة عامة</TabsTrigger>
          <TabsTrigger value="salary"><Wallet className="h-3.5 w-3.5 ms-1" />تعديلات الراتب</TabsTrigger>
          <TabsTrigger value="transfers"><ArrowLeftRight className="h-3.5 w-3.5 ms-1" />النقل والتكليف</TabsTrigger>
          <TabsTrigger value="evaluations"><Star className="h-3.5 w-3.5 ms-1" />التقييمات</TabsTrigger>
          <TabsTrigger value="emergency-contacts"><PhoneCall className="h-3.5 w-3.5 ms-1" />الطوارئ</TabsTrigger>
          <TabsTrigger value="dependents"><Users className="h-3.5 w-3.5 ms-1" />الأسرة</TabsTrigger>
          <TabsTrigger value="qualifications"><GraduationCap className="h-3.5 w-3.5 ms-1" />المؤهلات</TabsTrigger>
          <TabsTrigger value="certificates"><BadgeCheck className="h-3.5 w-3.5 ms-1" />الشهادات</TabsTrigger>
          <TabsTrigger value="documents"><FolderOpen className="h-3.5 w-3.5 ms-1" />المستندات</TabsTrigger>
          <TabsTrigger value="history"><History className="h-3.5 w-3.5 ms-1" />السجل الوظيفي</TabsTrigger>
          <TabsTrigger value="termination"><DoorOpen className="h-3.5 w-3.5 ms-1" />نهاية الخدمة</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          {empQ.isLoading ? <Skeleton className="h-40 w-full" /> : (
            <div className="grid md:grid-cols-3 gap-3 text-sm">
              {[
                ["الرقم القومي/الهوية", emp?.idNumber], ["الجنسية", emp?.nationality], ["النوع", emp?.gender === "male" ? "ذكر" : emp?.gender === "female" ? "أنثى" : emp?.gender],
                ["تاريخ الميلاد", emp?.birthDate], ["الهاتف", emp?.mobile], ["البريد", emp?.email],
                ["تاريخ التعيين", emp?.hireDate], ["الإدارة", emp?.department], ["الوظيفة", emp?.jobTitle],
                ["الأساسي", emp?.basicSalary != null ? fmt2(num(emp.basicSalary)) : null],
                ["إجمالي الراتب", fmt2(num(emp?.basicSalary) + num(emp?.housingAllow) + num(emp?.transportAllow) + num(emp?.otherAllow))],
                ["الكفيل", emp?.sponsor],
              ].map(([l, v]) => (
                <div key={String(l)} className="border rounded-lg p-3">
                  <div className="text-xs text-muted-foreground">{l}</div>
                  <div className="font-medium mt-0.5">{v || "—"}</div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="salary" className="mt-4"><SalaryTab empId={empId} emp={emp} /></TabsContent>
        <TabsContent value="transfers" className="mt-4"><TransfersTab empId={empId} emp={emp} /></TabsContent>
        {(["evaluations", "emergency-contacts", "dependents", "qualifications", "certificates", "documents"] as HrSubResource[]).map(k => (
          <TabsContent key={k} value={k} className="mt-4"><SubTab empId={empId} subKey={k} /></TabsContent>
        ))}
        <TabsContent value="history" className="mt-4"><HistoryTab empId={empId} /></TabsContent>
        <TabsContent value="termination" className="mt-4"><TerminationTab empId={empId} /></TabsContent>
      </Tabs>
    </div>
  );
}
