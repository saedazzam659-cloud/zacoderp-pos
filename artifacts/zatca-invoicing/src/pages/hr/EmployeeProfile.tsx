// ملف الموظف الشامل — Employee Lifecycle Profile
// تبويبات: نظرة عامة، الصورة، تعديلات الراتب، النقل والتكليف، التقييمات، الطوارئ،
// الأسرة، المؤهلات، الشهادات، المستندات (+أرشفة سحابية/محلية مثل القيود)، السجل، نهاية الخدمة.
// كل الجداول تستخدم AdvancedReportGrid (نفس جريدات النظام: بحث/فرز/فلاتر/ألوان/ترقيم).
import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { employeesApi } from "@/lib/employeesApi";
import { hrCoreApi, type HrSubResource } from "@/lib/hrCoreApi";
import { fmt2 } from "@/lib/format";
import { getDaysRemaining } from "@/lib/dateUtils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import AdvancedReportGrid, { type GridColumn } from "@/components/auditGrid/AdvancedReportGrid";
import { JournalScanArchive } from "@/components/JournalScanArchive";
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
  FileSignature, CalendarDays, Package, CheckCircle2, Camera, ImagePlus, Loader2, Shield
} from "lucide-react";

const API = import.meta.env.VITE_API_URL ?? "";
const today = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const num = (v: any) => Number(v ?? 0) || 0;

// صور الموظفين تُخزَّن كمسار /objects/... في التخزين السحابي — تُعرض عبر
// المسار المحمي مع token في الاستعلام (الـ <img> لا يرسل ترويسة Authorization).
function photoSrc(u: string | null | undefined, token: string | null): string | null {
  if (!u) return null;
  if (u.startsWith("/objects/")) return `${API}/api/storage${u}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  return u;
}

// ─── أوصاف الحقول لكل sub-resource (يبني الجريدة والنموذج تلقائياً) ──────────
type FieldDef = { key: string; label: string; type?: "text" | "date" | "number" | "bool" | "textarea"; required?: boolean };
const SUBS: Record<string, { title: string; icon: any; unit: string; fields: FieldDef[] }> = {
  "emergency-contacts": {
    title: "جهات اتصال الطوارئ", icon: PhoneCall, unit: "جهة",
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
    title: "الأسرة والتابعون", icon: Users, unit: "تابع",
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
    title: "المؤهلات العلمية", icon: GraduationCap, unit: "مؤهل",
    fields: [
      { key: "degree", label: "المؤهل", required: true },
      { key: "specialty", label: "التخصص" },
      { key: "institution", label: "الجامعة/الجهة" },
      { key: "gradYear", label: "سنة التخرج" },
      { key: "grade", label: "التقدير" },
    ],
  },
  "certificates": {
    title: "الشهادات", icon: BadgeCheck, unit: "شهادة",
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
    title: "المستندات", icon: FolderOpen, unit: "مستند",
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
    title: "التقييمات", icon: Star, unit: "تقييم",
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

// عمود إجراءات موحّد (لا يدخل في الفرز/التجميع/التصدير)
const actionsCol = (render: (r: any) => React.ReactNode): GridColumn<any> => ({
  key: "__actions", label: "إجراءات", type: "none", align: "center", width: 110,
  value: () => "", render,
});

// ─── تبويب sub-resource عام (جريدة + نموذج إضافة/تعديل + حذف) ────────────────
function SubTab({ empId, subKey, cid, companyName }: { empId: number; subKey: HrSubResource; cid?: number; companyName?: string | null }) {
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
  const columns = useMemo<GridColumn<any>[]>(() => [
    ...cfg.fields.filter(f => f.type !== "textarea").map<GridColumn<any>>(f => ({
      key: f.key, label: f.label,
      type: f.type === "number" ? "num" : "text",
      align: f.type === "number" ? "end" : "start",
      value: (r: any) => f.type === "bool" ? (r[f.key] ? "نعم" : "لا") : (r[f.key] ?? ""),
      render: f.type === "bool"
        ? (r: any) => (r[f.key] ? <CheckCircle2 className="h-4 w-4 text-emerald-600 inline" /> : <span>—</span>)
        : undefined,
    })),
    actionsCol(r => (
      <div className="flex gap-1 justify-center">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditId(r.id); setForm(r); setOpen(true); }} data-testid={`button-edit-${subKey}-${r.id}`}><Pencil className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-600" onClick={() => { if (confirm("تأكيد الحذف؟")) delMut.mutate(r.id); }} data-testid={`button-delete-${subKey}-${r.id}`}><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>
    )),
  ], [subKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h3 className="font-semibold text-sm flex items-center gap-2"><cfg.icon className="h-4 w-4" />{cfg.title}</h3>
        <div className="flex items-center gap-2">
          {subKey === "documents" && (
            <JournalScanArchive jeKey={`EMP-${empId}`} screenKey="hr_documents" companyName={companyName} />
          )}
          <Button size="sm" onClick={() => { setEditId(null); setForm({}); setOpen(true); }} data-testid={`button-add-${subKey}`}>
            <Plus className="h-4 w-4 ms-1" />إضافة
          </Button>
        </div>
      </div>
      {subKey === "documents" && (
        <p className="text-xs text-muted-foreground">
          زر «أرشفة مستند» يرفع صور/ملفات المستندات (كاميرا أو ملف) ويعرضها في نفس الشاشة — تماماً مثل أرشفة القيود المحاسبية والفواتير.
        </p>
      )}
      {q.isLoading ? <Skeleton className="h-24 w-full" /> : (
        <AdvancedReportGrid
          slug={`hrEmp_${subKey}`}
          cid={cid}
          rows={rows}
          rowKey={(r: any) => r.id}
          columns={columns}
          unitLabel={cfg.unit}
          emptyMessage="لا توجد بيانات"
        />
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

// ─── تبويب صورة الموظف ───────────────────────────────────────────────────────
function PhotoTab({ empId, emp }: { empId: number; emp: any }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { token } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const src = photoSrc(emp?.photoUrl, token);

  const saveMut = useMutation({
    mutationFn: (photoUrl: string | null) => employeesApi.update(empId, { photoUrl }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee", empId] });
      qc.invalidateQueries({ queryKey: ["employees"] });
    },
    onError: (e: any) => toast({ title: "فشل الحفظ", description: String(e.message ?? e), variant: "destructive" }),
  });

  const upload = async (file: File) => {
    if (!file.type.startsWith("image/")) { toast({ title: "الملف يجب أن يكون صورة", variant: "destructive" }); return; }
    if (file.size > 8 * 1024 * 1024) { toast({ title: "حجم الصورة أكبر من 8MB", variant: "destructive" }); return; }
    setUploading(true);
    try {
      const reqRes = await fetch(`${API}/api/storage/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!reqRes.ok) throw new Error(await reqRes.text());
      const { uploadURL, objectPath } = await reqRes.json();
      const putRes = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) throw new Error("فشل رفع الصورة إلى التخزين");
      await saveMut.mutateAsync(objectPath);
      toast({ title: "تم حفظ صورة الموظف" });
    } catch (e: any) {
      toast({ title: "فشل رفع الصورة", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
      if (cameraRef.current) cameraRef.current.value = "";
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row gap-6 items-start">
        <div className="border rounded-xl p-3 bg-muted/20 w-full md:w-auto flex justify-center">
          {src ? (
            <img src={src} alt={emp?.nameAr ?? "صورة الموظف"} className="max-h-80 rounded-lg object-contain" data-testid="img-employee-photo" />
          ) : (
            <div className="h-64 w-64 rounded-lg bg-primary/5 flex flex-col items-center justify-center text-muted-foreground gap-2">
              <UserRound className="h-16 w-16 text-primary/40" />
              <span className="text-sm">لا توجد صورة بعد</span>
            </div>
          )}
        </div>
        <div className="space-y-3">
          <h3 className="font-semibold text-sm flex items-center gap-2"><Camera className="h-4 w-4" />صورة الموظف</h3>
          <p className="text-xs text-muted-foreground max-w-md">
            ارفع صورة من الجهاز أو التقطها بالكاميرا مباشرة — تُحفظ في التخزين السحابي للشركة
            وتظهر هنا وفي رأس ملف الموظف فوراً.
          </p>
          <div className="flex gap-2 flex-wrap">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
            <input ref={cameraRef} type="file" accept="image/*" capture="user" className="hidden" onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading} data-testid="button-upload-photo">
              {uploading ? <Loader2 className="h-4 w-4 ms-1 animate-spin" /> : <ImagePlus className="h-4 w-4 ms-1" />}رفع صورة
            </Button>
            <Button size="sm" variant="outline" onClick={() => cameraRef.current?.click()} disabled={uploading} data-testid="button-capture-photo">
              <Camera className="h-4 w-4 ms-1" />التقاط بالكاميرا
            </Button>
            {emp?.photoUrl && (
              <Button size="sm" variant="outline" className="text-rose-600" disabled={uploading || saveMut.isPending}
                onClick={() => { if (confirm("إزالة صورة الموظف؟")) saveMut.mutate(null as any); }} data-testid="button-remove-photo">
                <Trash2 className="h-4 w-4 ms-1" />إزالة الصورة
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── تعديلات الرواتب ─────────────────────────────────────────────────────────
function SalaryTab({ empId, emp, cid }: { empId: number; emp: any; cid?: number }) {
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

  const columns = useMemo<GridColumn<any>[]>(() => [
    { key: "effectiveDate", label: "تاريخ السريان", type: "text", value: r => r.effectiveDate ?? "" },
    { key: "prevTotal", label: "السابق", type: "num", align: "end", className: "tabular-nums", value: r => num(r.prevTotal), render: r => <span>{fmt2(num(r.prevTotal))}</span>, totalable: false },
    { key: "newTotal", label: "الجديد", type: "num", align: "end", className: "tabular-nums font-medium", value: r => num(r.newTotal), render: r => <span>{fmt2(num(r.newTotal))}</span> },
    { key: "amount", label: "الزيادة", type: "num", align: "end", className: "tabular-nums", value: r => num(r.amount), render: r => <span dir="ltr">{fmt2(num(r.amount))}</span> },
    { key: "percent", label: "%", type: "num", align: "end", value: r => num(r.percent), render: r => <span dir="ltr">{fmt2(num(r.percent))}%</span> },
    { key: "reason", label: "السبب", type: "text", value: r => r.reason ?? "" },
    {
      key: "status", label: "الحالة", type: "text",
      value: r => r.status === "applied" ? "مطبَّق" : r.status === "scheduled" ? "مجدول" : "ملغى",
      render: r => (
        <Badge variant="outline" className={r.status === "applied" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : r.status === "scheduled" ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-slate-50 text-slate-600"}>
          {r.status === "applied" ? "مطبَّق" : r.status === "scheduled" ? "مجدول" : "ملغى"}
        </Badge>
      ),
    },
    actionsCol(r => r.status === "scheduled" ? (
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => applyMut.mutate(r.id)}>تطبيق الآن</Button>
    ) : <span />),
  ], []); // eslint-disable-line react-hooks/exhaustive-deps

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
      {q.isLoading ? <Skeleton className="h-24 w-full" /> : (
        <AdvancedReportGrid
          slug="hrEmp_salaryAdj" cid={cid}
          rows={rows} rowKey={(r: any) => r.id} columns={columns}
          unitLabel="تعديل" emptyMessage="لا توجد تعديلات — الراتب السابق يُحفظ دائماً ولا يُستبدل"
        />
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
function TransfersTab({ empId, emp, cid }: { empId: number; emp: any; cid?: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["hr-core", empId, "transfers"], queryFn: () => hrCoreApi.transfers(empId) });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({});
  const [editingId, setEditingId] = useState<number | null>(null);
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
  const updateMut = useMutation({
    mutationFn: ({ id, d }: any) => hrCoreApi.updateTransfer(empId, id, d),
    onSuccess: () => { invalidate(); setOpen(false); setEditingId(null); toast({ title: "تم تعديل الحركة المستقبلية" }); },
    onError: (e: any) => toast({ title: "فشل التعديل", description: String(e.message ?? e), variant: "destructive" }),
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

  const columns = useMemo<GridColumn<any>[]>(() => [
    {
      key: "moveType", label: "النوع", type: "text",
      value: r => MOVE_LABEL[r.moveType] ?? r.moveType,
      render: r => (
        <span>{MOVE_LABEL[r.moveType] ?? r.moveType}{r.isTemporary && <Badge variant="outline" className="ms-1 text-[10px]">مؤقت</Badge>}</span>
      ),
    },
    { key: "from", label: "من", type: "text", value: r => fmtSnap(r.prevValue), className: "text-xs" },
    { key: "to", label: "إلى", type: "text", value: r => fmtSnap(r.newValue), className: "text-xs" },
    { key: "effectiveFrom", label: "السريان", type: "text", value: r => r.effectiveFrom ?? "" },
    { key: "effectiveTo", label: "حتى", type: "text", value: r => r.effectiveTo ?? "—" },
    { key: "reason", label: "السبب", type: "text", value: r => r.reason ?? "" },
    {
      key: "status", label: "الحالة", type: "text",
      value: r => r.status === "applied" ? "مطبَّقة" : r.status === "scheduled" ? "مجدولة" : r.status === "ended" ? "منتهية" : "ملغاة",
      render: r => (
        <Badge variant="outline" className={
          r.status === "applied" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
          : r.status === "scheduled" ? "bg-amber-50 text-amber-700 border-amber-200"
          : "bg-slate-50 text-slate-600 border-slate-200"}>
          {r.status === "applied" ? "مطبَّقة" : r.status === "scheduled" ? "مجدولة" : r.status === "ended" ? "منتهية" : "ملغاة"}
        </Badge>
      ),
    },
    actionsCol(r => (
      <div className="flex gap-1 justify-center">
        {r.status === "scheduled" && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => applyMut.mutate(r.id)}>تطبيق</Button>}
        {r.isTemporary && r.status !== "ended" && r.status !== "cancelled" && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => endMut.mutate(r.id)}>إنهاء</Button>}
        {r.status === "scheduled" && r.effectiveFrom >= today() && <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="تعديل الحركة" onClick={() => { setEditingId(r.id); setForm({ ...r, newValue: parse(r.newValue), effectiveTo: r.effectiveTo ?? "" }); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>}
      </div>
    )),
  ], []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-muted-foreground">اختر «من» من اليوم فصاعدًا، واترك «إلى» فارغًا للاستمرار حتى حركة لاحقة. لا تُعدّل الحركات السابقة.</p>
        <Button size="sm" onClick={() => { setEditingId(null); setForm({ moveType: "transfer", effectiveFrom: today(), decisionDate: today(), newValue: { department: emp?.department ?? "", jobTitle: emp?.jobTitle ?? "" } }); setOpen(true); }} data-testid="button-add-transfer">
          <Plus className="h-4 w-4 ms-1" />حركة جديدة
        </Button>
      </div>
      {q.isLoading ? <Skeleton className="h-24 w-full" /> : (
        <AdvancedReportGrid
          slug="hrEmp_transfers" cid={cid}
          rows={rows} rowKey={(r: any) => r.id} columns={columns}
          unitLabel="حركة" emptyMessage="لا توجد حركات"
        />
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editingId ? "تعديل حركة مستقبلية" : "حركة نقل / تكليف"}</DialogTitle></DialogHeader>
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
            <div><label className="text-xs text-muted-foreground block mb-1">إلى (اختياري — مستمر حتى تغيير لاحق)</label><DateField value={form.effectiveTo ?? ""} onChange={v => setForm((p: any) => ({ ...p, effectiveTo: v }))} /></div>
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
               if (form.effectiveFrom < today()) { toast({ title: "لا يمكن حفظ أو تعديل تاريخ سابق", variant: "destructive" }); return; }
               if (form.effectiveTo && form.effectiveTo < form.effectiveFrom) { toast({ title: "تاريخ النهاية لا يسبق تاريخ البداية", variant: "destructive" }); return; }
               if (editingId) updateMut.mutate({ id: editingId, d: form }); else addMut.mutate(form);
             }} disabled={addMut.isPending || updateMut.isPending}>حفظ</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AssignmentManager empId={empId} cid={cid} />
    </div>
  );
}

// ─── توزيع راتب الموظف على المشروع / مركز التكلفة ─────────────────────────────
function AssignmentManager({ empId, cid }: { empId: number; cid?: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({ projectId: "", costCenterId: "", effectiveFrom: today(), effectiveTo: "", notes: "" });
  const [editingId, setEditingId] = useState<number | null>(null);
  const assignmentsQ = useQuery({ queryKey: ["employee-assignments", empId], queryFn: () => employeesApi.assignments(empId) });
  const projectsQ = useQuery({ queryKey: ["contracting-projects"], queryFn: employeesApi.projects });
  const centersQ = useQuery({ queryKey: ["cost-centers"], queryFn: employeesApi.costCenters });
  const addMut = useMutation({
    mutationFn: () => employeesApi.addAssignment(empId, {
      projectId: form.projectId && form.projectId !== "none" ? Number(form.projectId) : null,
      costCenterId: form.costCenterId && form.costCenterId !== "none" ? Number(form.costCenterId) : null,
      effectiveFrom: form.effectiveFrom,
      effectiveTo: form.effectiveTo || null,
      notes: form.notes || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee-assignments", empId] });
      setForm({ projectId: "", costCenterId: "", effectiveFrom: today(), effectiveTo: "", notes: "" });
      toast({ title: "تمت إضافة التوزيعة" });
    },
    onError: (e: any) => toast({ title: "فشل حفظ التوزيعة", description: String(e.message ?? e), variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => employeesApi.deleteAssignment(empId, id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employee-assignments", empId] }); toast({ title: "تم حذف التوزيعة" }); },
    onError: (e: any) => toast({ title: "فشل الحذف", description: String(e.message ?? e), variant: "destructive" }),
  });
  const updateMut = useMutation({
    mutationFn: () => employeesApi.updateAssignment(empId, editingId!, { projectId: form.projectId && form.projectId !== "none" ? Number(form.projectId) : null, costCenterId: form.costCenterId && form.costCenterId !== "none" ? Number(form.costCenterId) : null, effectiveFrom: form.effectiveFrom, effectiveTo: form.effectiveTo || null, notes: form.notes || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employee-assignments", empId] }); setEditingId(null); setForm({ projectId: "", costCenterId: "", effectiveFrom: today(), effectiveTo: "", notes: "" }); toast({ title: "تم تعديل التوزيعة المستقبلية" }); },
    onError: (e: any) => toast({ title: "فشل تعديل التوزيعة", description: String(e.message ?? e), variant: "destructive" }),
  });
  const rows = assignmentsQ.data ?? [];
  const projectName = (p: any) => p.nameAr ?? p.name ?? p.code ?? `#${p.id}`;
  const centerName = (c: any) => c.nameAr ?? c.name ?? c.code ?? `#${c.id}`;
  const columns = useMemo<GridColumn<any>[]>(() => [
    { key: "project", label: "المشروع", type: "text", value: r => r.projectNameAr ?? r.projectName ?? r.project?.nameAr ?? r.project?.name ?? "—" },
    { key: "costCenter", label: "مركز التكلفة", type: "text", value: r => r.costCenterNameAr ?? r.costCenterName ?? r.costCenter?.nameAr ?? r.costCenter?.name ?? "—" },
    { key: "effectiveFrom", label: "من", type: "text", value: r => r.effectiveFrom ?? r.startDate ?? "" },
    { key: "effectiveTo", label: "إلى", type: "text", value: r => r.effectiveTo ?? r.endDate ?? "مستمر حتى تغيير لاحق" },
    { key: "notes", label: "ملاحظات", type: "text", value: r => r.notes ?? "" },
    actionsCol(r => <div className="flex justify-center gap-1">{r.effectiveFrom >= today() && <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditingId(r.id); setForm({ projectId: r.projectId ? String(r.projectId) : "none", costCenterId: r.costCenterId ? String(r.costCenterId) : "none", effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? "", notes: r.notes ?? "" }); }} aria-label="تعديل التوزيعة"><Pencil className="h-3.5 w-3.5" /></Button>}<Button variant="ghost" size="icon" className="h-7 w-7 text-rose-600" onClick={() => { if (confirm("حذف هذه التوزيعة؟")) deleteMut.mutate(r.id); }} aria-label="حذف التوزيعة"><Trash2 className="h-3.5 w-3.5" /></Button></div>),
  ], []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="border-t pt-4 mt-5 space-y-3">
       <div><h3 className="font-semibold text-sm">توزيع الراتب على المشاريع ومراكز التكلفة</h3><p className="text-xs text-muted-foreground mt-1">اترك «إلى» فارغًا ليستمر التوزيع حتى تغيير لاحق. السجلات السابقة للعرض فقط.</p></div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2 items-end rounded-lg bg-muted/30 p-3">
        <div><label className="text-xs text-muted-foreground block mb-1">المشروع</label><Select value={form.projectId} onValueChange={v => setForm(p => ({ ...p, projectId: v }))}><SelectTrigger className="h-9"><SelectValue placeholder={projectsQ.isLoading ? "جارٍ التحميل…" : "بدون مشروع"} /></SelectTrigger><SelectContent><SelectItem value="none">بدون مشروع</SelectItem>{(projectsQ.data ?? []).map((p: any) => <SelectItem key={p.id} value={String(p.id)}>{projectName(p)}</SelectItem>)}</SelectContent></Select></div>
        <div><label className="text-xs text-muted-foreground block mb-1">مركز التكلفة</label><Select value={form.costCenterId} onValueChange={v => setForm(p => ({ ...p, costCenterId: v }))}><SelectTrigger className="h-9"><SelectValue placeholder={centersQ.isLoading ? "جارٍ التحميل…" : "بدون مركز"} /></SelectTrigger><SelectContent><SelectItem value="none">بدون مركز</SelectItem>{(centersQ.data ?? []).map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{centerName(c)}</SelectItem>)}</SelectContent></Select></div>
        <div><label className="text-xs text-muted-foreground block mb-1">سريان من *</label><DateField value={form.effectiveFrom} onChange={e => setForm(p => ({ ...p, effectiveFrom: e.target.value }))} /></div>
         <div><label className="text-xs text-muted-foreground block mb-1">إلى (اختياري — مستمر)</label><DateField value={form.effectiveTo} onChange={e => setForm(p => ({ ...p, effectiveTo: e.target.value }))} /></div>
         <Button size="sm" onClick={() => { if (!form.effectiveFrom || form.effectiveFrom < today()) { toast({ title: "اختر تاريخ سريان من اليوم أو تاريخ لاحق", variant: "destructive" }); return; } if (form.effectiveTo && form.effectiveTo < form.effectiveFrom) { toast({ title: "تاريخ النهاية لا يسبق البداية", variant: "destructive" }); return; } if ((!form.projectId || form.projectId === "none") && (!form.costCenterId || form.costCenterId === "none")) { toast({ title: "اختر مشروعاً أو مركز تكلفة", variant: "destructive" }); return; } if (editingId) updateMut.mutate(); else addMut.mutate(); }} disabled={addMut.isPending || updateMut.isPending || projectsQ.isLoading || centersQ.isLoading}>{editingId ? <Pencil className="h-4 w-4 ms-1" /> : <Plus className="h-4 w-4 ms-1" />}{editingId ? "حفظ التعديل" : "إضافة"}</Button>
        <div className="sm:col-span-2 lg:col-span-5"><label className="text-xs text-muted-foreground block mb-1">ملاحظات</label><Input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} /></div>
      </div>
      {assignmentsQ.isLoading ? <Skeleton className="h-24 w-full" /> : assignmentsQ.isError ? <p className="text-sm text-rose-600 border border-rose-200 rounded-lg p-3">تعذر تحميل التوزيعات. حاول تحديث الصفحة.</p> : <AdvancedReportGrid slug="hrEmp_assignments" cid={cid} rows={rows} rowKey={(r: any) => r.id} columns={columns} unitLabel="توزيعة" emptyMessage="لا توجد توزيعات للمشاريع أو مراكز التكلفة" />}
    </section>
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
function HistoryTab({ empId, cid }: { empId: number; cid?: number }) {
  const q = useQuery({ queryKey: ["hr-core", empId, "history"], queryFn: () => hrCoreApi.history(empId) });
  const rows = (q.data ?? []) as any[];
  const fmtVal = (s: any) => {
    if (!s) return "—";
    try {
      const o = typeof s === "string" ? JSON.parse(s) : s;
      return Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(" · ");
    } catch { return String(s); }
  };
  const columns = useMemo<GridColumn<any>[]>(() => [
    { key: "eventDate", label: "التاريخ", type: "text", value: r => r.eventDate ?? "", className: "whitespace-nowrap" },
    {
      key: "eventType", label: "الحدث", type: "text",
      value: r => HISTORY_LABEL[r.eventType] ?? r.eventType,
      render: r => <Badge variant="outline">{HISTORY_LABEL[r.eventType] ?? r.eventType}</Badge>,
    },
    { key: "prevValue", label: "القيمة السابقة", type: "text", value: r => fmtVal(r.prevValue), className: "text-xs text-muted-foreground" },
    { key: "newValue", label: "القيمة الجديدة", type: "text", value: r => fmtVal(r.newValue), className: "text-xs" },
    { key: "reason", label: "السبب", type: "text", value: r => r.reason ?? "", className: "text-xs" },
  ], []); // eslint-disable-line react-hooks/exhaustive-deps
  return q.isLoading ? <Skeleton className="h-32 w-full" /> : (
    <AdvancedReportGrid
      slug="hrEmp_history" cid={cid}
      rows={rows} rowKey={(r: any) => r.id} columns={columns}
      unitLabel="حدث" emptyMessage="لا توجد أحداث بعد — كل تعديل راتب أو نقل أو تقييم أو نهاية خدمة يُسجَّل هنا تلقائياً"
    />
  );
}

// ─── تبويب التأمين الطبي ───────────────────────────────────────────────────────
function MedicalInsuranceTab({ empId, cid }: { empId: number; cid?: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useTranslation();
  const tr = (k: string, opts?: any) => t(`hrPages.insurance.${k}`, opts) as string;
  const q = useQuery({ queryKey: ["hr-core", empId, "medical-insurance"], queryFn: () => hrCoreApi.sub(empId, "medical-insurance") });
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<any>({});
  const invalidate = () => qc.invalidateQueries({ queryKey: ["hr-core", empId, "medical-insurance"] });

  const saveMut = useMutation({
    mutationFn: (d: any) => editId ? hrCoreApi.updateSub(empId, "medical-insurance", editId, d) : hrCoreApi.addSub(empId, "medical-insurance", d),
    onSuccess: () => { invalidate(); setOpen(false); toast({ title: t("common.savedToast.saved") }); },
    onError: (e: any) => toast({ title: t("common.errorTitle"), description: String(e.message ?? e), variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: number) => hrCoreApi.deleteSub(empId, "medical-insurance", id),
    onSuccess: () => { invalidate(); toast({ title: t("common.deleted") }); },
    onError: (e: any) => toast({ title: t("common.errorTitle"), description: String(e.message ?? e), variant: "destructive" }),
  });

  const rows = (q.data ?? []) as any[];

  const sorted = [...rows].sort((a, b) => new Date(b.endDate || "2099").getTime() - new Date(a.endDate || "2099").getTime());
  const activePolicy = sorted.find(r => {
    const days = getDaysRemaining(r.endDate);
    return days !== null && days >= 0;
  });

  const columns = useMemo<GridColumn<any>[]>(() => [
    { key: "policyNumber", label: tr("policyNumber"), type: "text", value: r => r.policyNumber ?? "" },
    { key: "insuranceCompany", label: tr("insuranceCompany"), type: "text", value: r => r.insuranceCompany ?? "" },
    { key: "coverageDetails", label: tr("coverageDetails"), type: "text", value: r => r.coverageDetails ?? "" },
    { key: "startDate", label: tr("startDate"), type: "text", value: r => r.startDate ?? "" },
    { key: "endDate", label: tr("endDate"), type: "text", value: r => r.endDate ?? "" },
    {
      key: "status", label: tr("insuranceStatus"), type: "none", align: "center", value: r => r.endDate,
      render: r => {
        if (!r.endDate) return <span className="text-muted-foreground">—</span>;
        const days = getDaysRemaining(r.endDate);
        if (days === null) return null;
        if (days < 0) return <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">{tr("insuranceExpired", { days: Math.abs(days) })}</Badge>;
        if (days <= 30) return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">{tr("insuranceExpiring", { days })}</Badge>;
        return <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">{tr("insuranceActive", { days })}</Badge>;
      }
    },
    actionsCol(r => (
      <div className="flex gap-1 justify-center">
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("common.edit")} title={t("common.edit")} onClick={() => { setEditId(r.id); setForm(r); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-600" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => { if (confirm(t("common.deleteConfirm"))) delMut.mutate(r.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>
    ))
  ], [t, tr, delMut]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="font-semibold text-sm flex items-center gap-2"><Shield className="h-4 w-4" />{tr("medicalInsuranceTab")}</h3>
        <Button size="sm" onClick={() => { setEditId(null); setForm({}); setOpen(true); }}><Plus className="h-4 w-4 ms-1" />{tr("addInsurance")}</Button>
      </div>

      {q.isLoading ? <Skeleton className="h-32 w-full" /> : q.isError ? (
        <div className="text-rose-600 text-sm p-4 border border-rose-200 bg-rose-50 rounded-lg">{t("common.errorTitle")}</div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-8 border rounded-lg bg-muted/20 text-muted-foreground">
          <Shield className="h-12 w-12 text-muted mb-2 opacity-50" />
          <p className="text-sm font-medium">{tr("noMedicalInsurance")}</p>
          <p className="text-xs">{tr("addInsuranceToRegister")}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {activePolicy && (
            <div className="border border-emerald-200 bg-emerald-50/50 rounded-lg p-4 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-emerald-100 text-emerald-700 rounded-full shrink-0">
                  <Shield className="h-5 w-5" />
                </div>
                <div>
                  <h4 className="font-bold text-emerald-900">{activePolicy.insuranceCompany}</h4>
                  <div className="text-xs text-emerald-700 flex flex-wrap gap-2 mt-1">
                    <span dir="ltr">{tr("policy")} {activePolicy.policyNumber}</span>
                    <span>• {tr("coverageDetails")}: {activePolicy.coverageDetails || "—"}</span>
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                {(() => {
                  const days = getDaysRemaining(activePolicy.endDate) ?? 0;
                  return (
                    <>
                      <Badge className={days <= 30 ? "bg-amber-500 hover:bg-amber-600 text-white" : "bg-emerald-500 hover:bg-emerald-600 text-white"}>
                        {days <= 30 ? tr("insuranceExpiring", { days }) : tr("insuranceActive", { days })}
                      </Badge>
                      <span className="text-xs text-emerald-800">{tr("validUntil")} {activePolicy.endDate}</span>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          <AdvancedReportGrid slug="hrEmp_medicalInsurance" cid={cid} rows={rows} rowKey={(r:any)=>r.id} columns={columns} unitLabel={tr("policy")} emptyMessage={t("common.noResults")} />
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editId ? tr("editMedicalInsurance") : tr("addMedicalInsurance")}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-muted-foreground block mb-1">{tr("policyNumber")} *</label><Input dir="ltr" value={form.policyNumber ?? ""} onChange={e => setForm((p:any)=>({...p, policyNumber: e.target.value}))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">{tr("insuranceCompany")} *</label><Input value={form.insuranceCompany ?? ""} onChange={e => setForm((p:any)=>({...p, insuranceCompany: e.target.value}))} /></div>
            <div className="col-span-2"><label className="text-xs text-muted-foreground block mb-1">{tr("coverageDetails")}</label><Input value={form.coverageDetails ?? ""} onChange={e => setForm((p:any)=>({...p, coverageDetails: e.target.value}))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">{tr("startDate")} *</label><DateField value={form.startDate ?? ""} onChange={e => setForm((p:any)=>({...p, startDate: e.target.value}))} /></div>
            <div><label className="text-xs text-muted-foreground block mb-1">{tr("endDate")} *</label><DateField value={form.endDate ?? ""} onChange={e => setForm((p:any)=>({...p, endDate: e.target.value}))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={() => {
              if (!form.policyNumber || !form.insuranceCompany || !form.startDate || !form.endDate) {
                toast({ title: tr("fillRequiredFields"), variant: "destructive" }); return;
              }
              if (form.startDate > form.endDate) {
                toast({ title: t("common.validationError"), description: tr("dateOrderError"), variant: "destructive" }); return;
              }
              saveMut.mutate(form);
            }} disabled={saveMut.isPending}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── الصفحة الرئيسية ─────────────────────────────────────────────────────────
export default function EmployeeProfile() {
  const { i18n, t } = useTranslation();
  const [, params] = useRoute("/hr/employees/:id/profile");
  const empId = Number(params?.id);
  const { user, token } = useAuth();
  const cid = (user as any)?.company?.id as number | undefined;
  const companyName = ((user as any)?.company?.nameAr ?? (user as any)?.company?.name ?? null) as string | null;
  const empQ = useQuery({ queryKey: ["employee", empId], queryFn: () => employeesApi.get(empId), enabled: !!empId });
  const emp = empQ.data as any;
  const [tab, setTab] = useState("overview");
  const headerSrc = photoSrc(emp?.photoUrl, token);

  const STATUS_LABEL: Record<string, string> = {
    active: "على رأس العمل", probation: "تحت التجربة", vacation: "إجازة",
    suspended: "موقوف", resigned: "مستقيل", terminated: "منتهي الخدمة", absent: "متغيب",
  };

  if (!empId) return null;
  return (
    <div className="p-4 space-y-4" dir={i18n.dir()}>
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/hr/employees"><Button variant="ghost" size="icon"><ArrowRight className="h-4 w-4" /></Button></Link>
        {empQ.isLoading ? <Skeleton className="h-10 w-64" /> : (
          <>
            <button
              type="button"
              className="h-11 w-11 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden ring-offset-background hover:ring-2 hover:ring-primary/30 transition"
              onClick={() => setTab("photo")}
              title="صورة الموظف"
              data-testid="button-header-photo"
            >
              {headerSrc ? <img src={headerSrc} alt="" className="h-full w-full object-cover" /> : <UserRound className="h-5 w-5 text-primary" />}
            </button>
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
          <TabsTrigger value="photo" data-testid="tab-photo"><Camera className="h-3.5 w-3.5 ms-1" />الصورة</TabsTrigger>
          <TabsTrigger value="salary"><Wallet className="h-3.5 w-3.5 ms-1" />تعديلات الراتب</TabsTrigger>
          <TabsTrigger value="transfers"><ArrowLeftRight className="h-3.5 w-3.5 ms-1" />النقل والتكليف</TabsTrigger>
          <TabsTrigger value="evaluations"><Star className="h-3.5 w-3.5 ms-1" />التقييمات</TabsTrigger>
          <TabsTrigger value="emergency-contacts"><PhoneCall className="h-3.5 w-3.5 ms-1" />الطوارئ</TabsTrigger>
          <TabsTrigger value="dependents"><Users className="h-3.5 w-3.5 ms-1" />الأسرة</TabsTrigger>
          <TabsTrigger value="medical-insurance"><Shield className="h-3.5 w-3.5 ms-1" />{t("hrPages.insurance.medicalInsuranceTab")}</TabsTrigger>
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
        <TabsContent value="photo" className="mt-4"><PhotoTab empId={empId} emp={emp} /></TabsContent>
        <TabsContent value="salary" className="mt-4"><SalaryTab empId={empId} emp={emp} cid={cid} /></TabsContent>
        <TabsContent value="transfers" className="mt-4"><TransfersTab empId={empId} emp={emp} cid={cid} /></TabsContent>
        {(["evaluations", "emergency-contacts", "dependents", "qualifications", "certificates", "documents"] as HrSubResource[]).map(k => (
          <TabsContent key={k} value={k} className="mt-4"><SubTab empId={empId} subKey={k} cid={cid} companyName={companyName} /></TabsContent>
        ))}
        <TabsContent value="medical-insurance" className="mt-4"><MedicalInsuranceTab empId={empId} cid={cid} /></TabsContent>
        <TabsContent value="history" className="mt-4"><HistoryTab empId={empId} cid={cid} /></TabsContent>
        <TabsContent value="termination" className="mt-4"><TerminationTab empId={empId} /></TabsContent>
      </Tabs>
    </div>
  );
}
