import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Copy, Pencil, Trash2, Plus, RefreshCw, Building2, Layers, CheckCircle2,
  XCircle, ShieldAlert, History, Wand2,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Types ───────────────────────────────────────────────────────────────────
type SourceCompany = {
  id: number; code: string | null; nameAr: string; nameEn: string | null;
  vatNumber: string | null; industryName: string | null; status: string | null;
};
type Template = {
  id: number; nameAr: string; nameEn: string | null; description: string | null;
  industryName: string | null; sourceCompanyId: number; isActive: boolean;
  createdAt: string; sourceNameAr: string | null; sourceCode: string | null;
};
type CloneRun = {
  id: number; sourceCompanyId: number; targetCompanyId: number | null;
  templateId: number | null; status: string; error: string | null;
  summary: Record<string, number> | null; createdAt: string;
};
type TemplateForm = {
  id?: number; nameAr: string; nameEn: string; description: string;
  industryName: string; sourceCompanyId: number | null; isActive: boolean;
};

const EMPTY_TEMPLATE: TemplateForm = {
  nameAr: "", nameEn: "", description: "", industryName: "",
  sourceCompanyId: null, isActive: true,
};

type IdentityForm = {
  nameAr: string; nameEn: string; vatNumber: string; crNumber: string;
  city: string; district: string; street: string; buildingNumber: string;
  postalCode: string; additionalNumber: string; phone: string;
};
type AdminForm = {
  username: string; password: string; nameAr: string; nameEn: string; email: string;
};
const EMPTY_IDENTITY: IdentityForm = {
  nameAr: "", nameEn: "", vatNumber: "", crNumber: "", city: "", district: "",
  street: "", buildingNumber: "", postalCode: "", additionalNumber: "", phone: "",
};
const EMPTY_ADMIN: AdminForm = { username: "", password: "", nameAr: "", nameEn: "", email: "" };

export default function CompanyCloning() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<TemplateForm | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Template | null>(null);

  const companiesQ = useQuery<SourceCompany[]>({
    queryKey: ["clone-companies"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/company-cloning/companies`, { headers });
      if (!r.ok) throw new Error((await r.json()).error || "فشل جلب الشركات");
      return (await r.json()).companies ?? [];
    },
  });

  const templatesQ = useQuery<Template[]>({
    queryKey: ["clone-templates"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/company-cloning/templates`, { headers });
      if (!r.ok) throw new Error((await r.json()).error || "فشل جلب القوالب");
      return (await r.json()).templates ?? [];
    },
  });

  const runsQ = useQuery<CloneRun[]>({
    queryKey: ["clone-runs"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/company-cloning/runs`, { headers });
      if (!r.ok) throw new Error((await r.json()).error || "فشل جلب السجل");
      return (await r.json()).runs ?? [];
    },
  });

  const saveTemplateMut = useMutation({
    mutationFn: async (form: TemplateForm) => {
      const isUpdate = typeof form.id === "number";
      const url = isUpdate
        ? `${API}/api/admin/company-cloning/templates/${form.id}`
        : `${API}/api/admin/company-cloning/templates`;
      const r = await fetch(url, {
        method: isUpdate ? "PATCH" : "POST",
        headers,
        body: JSON.stringify(form),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "فشل الحفظ");
      return d;
    },
    onSuccess: () => {
      toast({ title: "تم حفظ القالب" });
      setEditingTemplate(null);
      qc.invalidateQueries({ queryKey: ["clone-templates"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const deleteTemplateMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/company-cloning/templates/${id}`, { method: "DELETE", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "فشل الحذف");
      return d;
    },
    onSuccess: () => {
      toast({ title: "تم حذف القالب" });
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ["clone-templates"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const companyName = (id: number | null) =>
    id == null ? "—" : (companiesQ.data?.find(c => c.id === id)?.nameAr ?? `#${id}`);

  return (
    <div className="space-y-6 p-4 md:p-6" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Copy className="text-primary" /> استنساخ الشركة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            أنشئ شركة جديدة بنسخ <span className="font-medium">إعدادات</span> شركة قائمة أو قالب
            (الوحدات، الصلاحيات، دليل الحسابات، ربط القيود، القوالب، المستخدمون الافتراضيون).
            <span className="font-medium text-foreground"> لا يتم نسخ أي بيانات حركية</span> (فواتير، قيود، أرصدة).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => { templatesQ.refetch(); runsQ.refetch(); }}>
            <RefreshCw className="h-4 w-4 ml-2" /> تحديث
          </Button>
          <Button onClick={() => setWizardOpen(true)}>
            <Wand2 className="h-4 w-4 ml-2" /> استنساخ شركة جديدة
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900 p-3 flex items-start gap-2 text-sm">
        <ShieldAlert className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
        <div className="text-amber-800 dark:text-amber-300">
          الاستنساخ عملية <span className="font-semibold">إضافية فقط</span>: يقرأ من الشركة المصدر دون أي تعديل عليها،
          ويُدخل النسخ في الشركة الجديدة ضمن معاملة واحدة. تُنشأ سنة مالية جديدة تلقائياً.
        </div>
      </div>

      {/* Templates */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" /> قوالب الاستنساخ
          </h2>
          <Button size="sm" variant="secondary" onClick={() => setEditingTemplate({ ...EMPTY_TEMPLATE })}>
            <Plus className="h-4 w-4 ml-2" /> قالب جديد
          </Button>
        </div>

        {templatesQ.isLoading ? (
          <div className="text-center text-muted-foreground py-8">جاري التحميل…</div>
        ) : (templatesQ.data?.length ?? 0) === 0 ? (
          <Card><CardContent className="py-10 text-center space-y-2">
            <Layers className="h-10 w-10 mx-auto text-muted-foreground/50" />
            <div className="text-sm text-muted-foreground">
              لا توجد قوالب بعد. أنشئ قالباً يشير إلى شركة مرجعية لاستخدامه عند الاستنساخ.
            </div>
          </CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {templatesQ.data!.map(t => (
              <Card key={t.id} className={t.isActive ? "" : "opacity-60"}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold truncate flex items-center gap-2">
                        {t.nameAr}
                        {!t.isActive && <Badge variant="outline" className="text-[10px]">مُعطَّل</Badge>}
                      </div>
                      {t.industryName && (
                        <div className="text-xs text-muted-foreground truncate">{t.industryName}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="ghost" onClick={() => setEditingTemplate({
                        id: t.id, nameAr: t.nameAr, nameEn: t.nameEn ?? "",
                        description: t.description ?? "", industryName: t.industryName ?? "",
                        sourceCompanyId: t.sourceCompanyId, isActive: t.isActive,
                      })}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive"
                        onClick={() => setConfirmDelete(t)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
                  <div className="flex items-center gap-1.5 text-xs pt-1 border-t">
                    <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">المصدر:</span>
                    <span className="font-medium">{t.sourceNameAr ?? `#${t.sourceCompanyId}`}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Clone history */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <History className="h-5 w-5 text-primary" /> سجل عمليات الاستنساخ
        </h2>
        {runsQ.isLoading ? (
          <div className="text-center text-muted-foreground py-8">جاري التحميل…</div>
        ) : (runsQ.data?.length ?? 0) === 0 ? (
          <div className="text-sm text-muted-foreground py-4">لا توجد عمليات بعد.</div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-right">
                  <th className="p-2 font-medium">الحالة</th>
                  <th className="p-2 font-medium">المصدر</th>
                  <th className="p-2 font-medium">الشركة الجديدة</th>
                  <th className="p-2 font-medium">التفاصيل</th>
                  <th className="p-2 font-medium">التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {runsQ.data!.map(run => (
                  <tr key={run.id} className="border-t">
                    <td className="p-2">
                      {run.status === "success" ? (
                        <span className="inline-flex items-center gap-1 text-green-600">
                          <CheckCircle2 className="h-4 w-4" /> نجح
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-destructive">
                          <XCircle className="h-4 w-4" /> فشل
                        </span>
                      )}
                    </td>
                    <td className="p-2">{companyName(run.sourceCompanyId)}</td>
                    <td className="p-2">{companyName(run.targetCompanyId)}</td>
                    <td className="p-2 text-xs text-muted-foreground max-w-xs truncate">
                      {run.status === "success" && run.summary
                        ? Object.entries(run.summary).filter(([, v]) => v > 0)
                            .map(([k, v]) => `${k}:${v}`).join("، ")
                        : (run.error ?? "—")}
                    </td>
                    <td className="p-2 text-xs whitespace-nowrap">
                      {new Date(run.createdAt).toLocaleString("ar-SA")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CloneWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        companies={companiesQ.data ?? []}
        templates={(templatesQ.data ?? []).filter(t => t.isActive)}
        headers={headers}
        onDone={() => {
          setWizardOpen(false);
          qc.invalidateQueries({ queryKey: ["clone-runs"] });
          qc.invalidateQueries({ queryKey: ["clone-companies"] });
        }}
      />

      <TemplateEditDialog
        editing={editingTemplate}
        setEditing={setEditingTemplate}
        companies={companiesQ.data ?? []}
        saveMut={saveTemplateMut}
      />

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف القالب</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حذف القالب <span className="font-bold">{confirmDelete?.nameAr}</span>؟
              لن يؤثر هذا على أي شركة سبق استنساخها.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => confirmDelete && deleteTemplateMut.mutate(confirmDelete.id)}
            >
              حذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Template add/edit dialog
// ─────────────────────────────────────────────────────────────────────────────
function TemplateEditDialog({
  editing, setEditing, companies, saveMut,
}: {
  editing: TemplateForm | null;
  setEditing: (s: TemplateForm | null) => void;
  companies: SourceCompany[];
  saveMut: ReturnType<typeof useMutation<any, any, TemplateForm, any>>;
}) {
  const canSave = !!editing && editing.nameAr.trim() && editing.sourceCompanyId != null;
  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
      <DialogContent className="max-w-lg" dir="rtl">
        <DialogHeader>
          <DialogTitle>{editing?.id ? "تعديل قالب" : "قالب استنساخ جديد"}</DialogTitle>
          <DialogDescription>
            القالب يحفظ إشارة إلى شركة مرجعية تُنسخ إعداداتها عند الاستنساخ.
          </DialogDescription>
        </DialogHeader>
        {editing && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>اسم القالب بالعربي *</Label>
              <Input value={editing.nameAr}
                onChange={(e) => setEditing({ ...editing, nameAr: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>اسم القالب بالإنجليزي</Label>
              <Input dir="ltr" value={editing.nameEn}
                onChange={(e) => setEditing({ ...editing, nameEn: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>الشركة المرجعية (المصدر) *</Label>
              <select
                className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                value={editing.sourceCompanyId ?? ""}
                onChange={(e) => setEditing({ ...editing, sourceCompanyId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">— اختر شركة —</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.nameAr}{c.code ? ` (${c.code})` : ""}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>النشاط / الصناعة</Label>
              <Input value={editing.industryName}
                onChange={(e) => setEditing({ ...editing, industryName: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>الوصف</Label>
              <Input value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={editing.isActive}
                onCheckedChange={(v) => setEditing({ ...editing, isActive: v })} />
              <span className="text-sm">مفعّل</span>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditing(null)}>إلغاء</Button>
          <Button disabled={!canSave || saveMut.isPending}
            onClick={() => editing && saveMut.mutate(editing)}>
            {saveMut.isPending ? "جارٍ الحفظ…" : "حفظ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Clone wizard
// ─────────────────────────────────────────────────────────────────────────────
function CloneWizard({
  open, onClose, companies, templates, headers, onDone,
}: {
  open: boolean;
  onClose: () => void;
  companies: SourceCompany[];
  templates: Template[];
  headers: Record<string, string>;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"company" | "template">("company");
  const [sourceCompanyId, setSourceCompanyId] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [copyUsers, setCopyUsers] = useState(true);
  const [identity, setIdentity] = useState<IdentityForm>({ ...EMPTY_IDENTITY });
  const [admin, setAdmin] = useState<AdminForm>({ ...EMPTY_ADMIN });

  const resolvedSourceId = useMemo(() => {
    if (mode === "template") {
      return templates.find(t => t.id === templateId)?.sourceCompanyId ?? null;
    }
    return sourceCompanyId;
  }, [mode, templateId, sourceCompanyId, templates]);

  const reset = () => {
    setMode("company"); setSourceCompanyId(null); setTemplateId(null);
    setCopyUsers(true); setIdentity({ ...EMPTY_IDENTITY }); setAdmin({ ...EMPTY_ADMIN });
  };

  const cloneMut = useMutation({
    mutationFn: async () => {
      const body: any = {
        copyUsers,
        identity: {
          nameAr: identity.nameAr, nameEn: identity.nameEn, vatNumber: identity.vatNumber,
          crNumber: identity.crNumber, city: identity.city, district: identity.district,
          street: identity.street, buildingNumber: identity.buildingNumber,
          postalCode: identity.postalCode, additionalNumber: identity.additionalNumber,
          phone: identity.phone,
        },
        admin,
      };
      if (mode === "template") body.templateId = templateId;
      else body.sourceCompanyId = sourceCompanyId;
      const r = await fetch(`${API}/api/admin/company-cloning/clone`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "فشل الاستنساخ");
      return d;
    },
    onSuccess: (d: any) => {
      const total = d.counts ? Object.values(d.counts as Record<string, number>).reduce((a, b) => a + b, 0) : 0;
      toast({
        title: "تم إنشاء الشركة بنجاح",
        description: `${d.companyCode ?? ""} — نُسخ ${total} سجل إعدادات.`,
      });
      reset();
      onDone();
    },
    onError: (e: any) => toast({ title: "فشل الاستنساخ", description: e.message, variant: "destructive" }),
  });

  const canSubmit =
    resolvedSourceId != null &&
    identity.nameAr.trim() && identity.vatNumber.trim() && identity.crNumber.trim() &&
    identity.city.trim() && identity.street.trim() && identity.buildingNumber.trim() &&
    identity.postalCode.trim() && admin.username.trim() && admin.password.length >= 6;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-primary" /> استنساخ شركة جديدة
          </DialogTitle>
          <DialogDescription>
            اختر المصدر، ثم أدخل بيانات الشركة الجديدة وحساب المدير. تُنسخ الإعدادات فقط.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Source selection */}
          <div className="space-y-2">
            <Label className="font-semibold">١. مصدر الاستنساخ</Label>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant={mode === "company" ? "default" : "outline"}
                onClick={() => setMode("company")}>من شركة قائمة</Button>
              <Button type="button" size="sm" variant={mode === "template" ? "default" : "outline"}
                onClick={() => setMode("template")}>من قالب</Button>
            </div>
            {mode === "company" ? (
              <select
                className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                value={sourceCompanyId ?? ""}
                onChange={(e) => setSourceCompanyId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— اختر الشركة المصدر —</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.nameAr}{c.code ? ` (${c.code})` : ""}</option>
                ))}
              </select>
            ) : (
              <select
                className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                value={templateId ?? ""}
                onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— اختر القالب —</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.nameAr}{t.sourceNameAr ? ` ← ${t.sourceNameAr}` : ""}</option>
                ))}
              </select>
            )}
            {resolvedSourceId != null && (
              <div className="text-xs text-muted-foreground">
                ستُنسخ إعدادات: <span className="font-medium">
                  {companies.find(c => c.id === resolvedSourceId)?.nameAr ?? `#${resolvedSourceId}`}
                </span>
              </div>
            )}
          </div>

          {/* New company identity */}
          <div className="space-y-2">
            <Label className="font-semibold">٢. بيانات الشركة الجديدة</Label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="الاسم بالعربي *" value={identity.nameAr}
                onChange={(v) => setIdentity({ ...identity, nameAr: v })} />
              <Field label="الاسم بالإنجليزي" dir="ltr" value={identity.nameEn}
                onChange={(v) => setIdentity({ ...identity, nameEn: v })} />
              <Field label="الرقم الضريبي *" dir="ltr" value={identity.vatNumber}
                onChange={(v) => setIdentity({ ...identity, vatNumber: v })} />
              <Field label="السجل التجاري *" dir="ltr" value={identity.crNumber}
                onChange={(v) => setIdentity({ ...identity, crNumber: v })} />
              <Field label="المدينة *" value={identity.city}
                onChange={(v) => setIdentity({ ...identity, city: v })} />
              <Field label="الحي" value={identity.district}
                onChange={(v) => setIdentity({ ...identity, district: v })} />
              <Field label="الشارع *" value={identity.street}
                onChange={(v) => setIdentity({ ...identity, street: v })} />
              <Field label="رقم المبنى *" dir="ltr" value={identity.buildingNumber}
                onChange={(v) => setIdentity({ ...identity, buildingNumber: v })} />
              <Field label="الرمز البريدي *" dir="ltr" value={identity.postalCode}
                onChange={(v) => setIdentity({ ...identity, postalCode: v })} />
              <Field label="الرقم الإضافي" dir="ltr" value={identity.additionalNumber}
                onChange={(v) => setIdentity({ ...identity, additionalNumber: v })} />
              <Field label="الهاتف" dir="ltr" value={identity.phone}
                onChange={(v) => setIdentity({ ...identity, phone: v })} />
            </div>
          </div>

          {/* Admin user */}
          <div className="space-y-2">
            <Label className="font-semibold">٣. حساب مدير الشركة</Label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="اسم المستخدم *" dir="ltr" value={admin.username}
                onChange={(v) => setAdmin({ ...admin, username: v })} />
              <Field label="كلمة المرور * (٦ أحرف على الأقل)" type="password" dir="ltr" value={admin.password}
                onChange={(v) => setAdmin({ ...admin, password: v })} />
              <Field label="الاسم بالعربي" value={admin.nameAr}
                onChange={(v) => setAdmin({ ...admin, nameAr: v })} />
              <Field label="البريد الإلكتروني" dir="ltr" value={admin.email}
                onChange={(v) => setAdmin({ ...admin, email: v })} />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Switch checked={copyUsers} onCheckedChange={setCopyUsers} />
              <span className="text-sm">نسخ مستخدمي الشركة المصدر الآخرين (بصلاحياتهم)</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>إلغاء</Button>
          <Button disabled={!canSubmit || cloneMut.isPending} onClick={() => cloneMut.mutate()}>
            {cloneMut.isPending ? "جارٍ الاستنساخ…" : "استنساخ الآن"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label, value, onChange, dir, type,
}: {
  label: string; value: string; onChange: (v: string) => void;
  dir?: "ltr" | "rtl"; type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input dir={dir} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
