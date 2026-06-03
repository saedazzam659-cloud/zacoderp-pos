import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useListRiskAssessments, useGetRiskAssessment,
  useCreateRiskAssessment, useUpdateRiskAssessment, useDeleteRiskAssessment,
  useAddRiskControl, useUpdateRiskControl, useDeleteRiskControl,
  getListRiskAssessmentsQueryKey, getGetRiskAssessmentQueryKey,
  type RiskAssessment, type RiskControl,
  type CreateRiskAssessmentBody, type CreateRiskControlBody,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Search, ClipboardList, Edit3, Trash2, Save, X, ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchCombobox } from "@/components/ui/search-combobox";
import {
  HAZARD_CATEGORIES, RISK_STATUSES, CONTROL_TYPES, CONTROL_STATUSES,
} from "@/lib/safetyConstants";

const API = import.meta.env.VITE_API_URL || "";

const HAZARD_LABELS: Record<string, string> = {
  mechanical: "ميكانيكية", electrical: "كهربائية", chemical: "كيميائية",
  ergonomic: "بيئة العمل (Ergonomic)", biological: "بيولوجية", physical: "فيزيائية",
  psychosocial: "نفسية واجتماعية", fire: "حريق", fall: "سقوط",
  environmental: "بيئية", other: "أخرى",
};
const STATUS_LABELS: Record<string, string> = {
  open: "مفتوح", in_review: "قيد المراجعة", controlled: "تحت السيطرة", closed: "مغلق",
};
const STATUS_COLORS: Record<string, string> = {
  open: "bg-amber-100 text-amber-700", in_review: "bg-sky-100 text-sky-700",
  controlled: "bg-emerald-100 text-emerald-700", closed: "bg-slate-200 text-slate-600",
};
const LEVEL_LABELS: Record<string, string> = {
  low: "منخفض", medium: "متوسط", high: "عالٍ", critical: "حرج",
};
const LEVEL_COLORS: Record<string, string> = {
  low: "bg-emerald-100 text-emerald-700", medium: "bg-amber-100 text-amber-700",
  high: "bg-orange-100 text-orange-700", critical: "bg-red-100 text-red-700",
};
const CONTROL_TYPE_LABELS: Record<string, string> = {
  elimination: "إزالة الخطر", substitution: "استبدال", engineering: "ضوابط هندسية",
  administrative: "ضوابط إدارية", ppe: "معدات وقاية شخصية",
};
const CONTROL_STATUS_LABELS: Record<string, string> = {
  planned: "مخطط", in_progress: "قيد التنفيذ", done: "منجز",
};

function levelFromScore(score: number): string {
  if (score >= 16) return "critical";
  if (score >= 10) return "high";
  if (score >= 5) return "medium";
  return "low";
}

type Editing = Partial<RiskAssessment> & {
  likelihood: number; severity: number;
};
const EMPTY: Editing = {
  title: "", processArea: "", workCenterId: null, hazardDescription: "",
  hazardCategory: "other", likelihood: 1, severity: 1, existingControls: "",
  residualLikelihood: null, residualSeverity: null, responsibleUserId: null,
  assessmentDate: null, reviewDate: null, status: "open", notes: "",
};

type WC = { id: number; nameAr: string };
type Usr = { id: number; username: string };

export default function RiskRegister() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [workCenters, setWorkCenters] = useState<WC[]>([]);
  const [users, setUsers] = useState<Usr[]>([]);

  // Debounced params drive the generated list query.
  const [params, setParams] = useState<{ q?: string; status?: string }>({});
  useEffect(() => {
    const id = setTimeout(() => {
      setParams({ q: q.trim() || undefined, status: statusFilter || undefined });
    }, 300);
    return () => clearTimeout(id);
  }, [q, statusFilter]);

  const risksQuery = useListRiskAssessments(params, {
    query: { enabled: !!token, queryKey: getListRiskAssessmentsQueryKey(params) },
  });
  const rows = risksQuery.data ?? null;
  const loading = risksQuery.isLoading;

  // Controls drawer — full RA (with controls) fetched on demand.
  const [controlsForId, setControlsForId] = useState<number | null>(null);
  const [controlsForTitle, setControlsForTitle] = useState<string>("");
  const raDetailQuery = useGetRiskAssessment(controlsForId ?? 0, {
    query: { enabled: controlsForId != null, queryKey: getGetRiskAssessmentQueryKey(controlsForId ?? 0) },
  });
  const controls: RiskControl[] = raDetailQuery.data?.controls ?? [];
  const [newControl, setNewControl] = useState<Partial<RiskControl>>({
    controlType: "administrative", description: "", status: "planned",
  });

  const createMut = useCreateRiskAssessment();
  const updateMut = useUpdateRiskAssessment();
  const deleteMut = useDeleteRiskAssessment();
  const addControlMut = useAddRiskControl();
  const updateControlMut = useUpdateRiskControl();
  const deleteControlMut = useDeleteRiskControl();
  const saving = createMut.isPending || updateMut.isPending;

  const loadLookups = useCallback(async () => {
    if (!token) return;
    const actingCompanyId = localStorage.getItem("zatca_acting_company_id");
    const h: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (actingCompanyId) h["x-acting-company-id"] = actingCompanyId;
    try {
      const [wc, us] = await Promise.all([
        fetch(`${API}/api/production/work-centers`, { headers: h }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/api/users`, { headers: h }).then((r) => (r.ok ? r.json() : [])),
      ]);
      setWorkCenters(Array.isArray(wc) ? wc : wc?.rows ?? []);
      setUsers(Array.isArray(us) ? us : us?.rows ?? []);
    } catch { /* silent */ }
  }, [token]);
  useRefetchOnFocus(loadLookups);

  useEffect(() => {
    if (!token) return;
    void loadLookups();
  }, [token, loadLookups]);

  async function save() {
    if (!editing) return;
    if (!editing.title?.trim()) {
      toast({ title: "العنوان مطلوب", variant: "destructive" });
      return;
    }
    try {
      const body: CreateRiskAssessmentBody = {
        title: editing.title.trim(),
        processArea: editing.processArea ?? null,
        workCenterId: editing.workCenterId ?? null,
        hazardDescription: editing.hazardDescription ?? null,
        hazardCategory: editing.hazardCategory,
        likelihood: editing.likelihood,
        severity: editing.severity,
        existingControls: editing.existingControls ?? null,
        residualLikelihood: editing.residualLikelihood ?? null,
        residualSeverity: editing.residualSeverity ?? null,
        responsibleUserId: editing.responsibleUserId ?? null,
        assessmentDate: editing.assessmentDate ?? null,
        reviewDate: editing.reviewDate ?? null,
        status: editing.status,
        notes: editing.notes ?? null,
      };
      if (editing.id) await updateMut.mutateAsync({ id: editing.id, data: body });
      else await createMut.mutateAsync({ data: body });
      toast({ title: editing.id ? "✓ تم التحديث" : "✓ تم الإنشاء" });
      setEditing(null);
      await risksQuery.refetch();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  async function remove(r: RiskAssessment) {
    if (!confirm(`حذف تقييم المخاطر "${r.title}"؟`)) return;
    try {
      await deleteMut.mutateAsync({ id: r.id });
      toast({ title: "✓ تم الحذف" });
      await risksQuery.refetch();
    } catch (e: any) {
      toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" });
    }
  }

  function openControls(r: RiskAssessment) {
    setControlsForTitle(r.title ?? "");
    setControlsForId(r.id);
  }

  async function addControl() {
    if (controlsForId == null) return;
    if (!newControl.description?.trim()) {
      toast({ title: "وصف الضابط مطلوب", variant: "destructive" });
      return;
    }
    try {
      const body: CreateRiskControlBody = {
        description: newControl.description.trim(),
        controlType: newControl.controlType,
        ownerUserId: newControl.ownerUserId ?? null,
        dueDate: newControl.dueDate ?? null,
        status: newControl.status,
      };
      await addControlMut.mutateAsync({ id: controlsForId, data: body });
      setNewControl({ controlType: "administrative", description: "", status: "planned" });
      await raDetailQuery.refetch();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  async function cycleControlStatus(c: RiskControl) {
    const order = ["planned", "in_progress", "done"];
    const next = order[(order.indexOf(c.status) + 1) % order.length];
    try {
      await updateControlMut.mutateAsync({ id: c.id, data: { status: next } });
      await raDetailQuery.refetch();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  async function deleteControl(c: RiskControl) {
    try {
      await deleteControlMut.mutateAsync({ id: c.id });
      await raDetailQuery.refetch();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  const list = useMemo(() => rows ?? [], [rows]);
  const inherentScore = (editing?.likelihood ?? 1) * (editing?.severity ?? 1);
  const residualScore =
    editing?.residualLikelihood != null && editing?.residualSeverity != null
      ? editing.residualLikelihood * editing.residualSeverity
      : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-red-500 to-rose-600 p-2 text-white shadow">
            <ClipboardList className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">سجل المخاطر</h1>
            <p className="text-sm text-slate-500">
              تقييم المخاطر بمصفوفة 5×5 (الاحتمالية × الشدة) وفق ISO 45001، مع
              هرمية الضوابط والمخاطر المتبقية.
            </p>
          </div>
        </div>
        <Button onClick={() => setEditing({ ...EMPTY })} data-testid="btn-new-risk">
          <Plus className="h-4 w-4 me-1" /> تقييم مخاطر جديد
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 max-w-md flex-1">
          <Search className="h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="ابحث بالعنوان أو الكود أو المنطقة…" data-testid="input-search-risks" />
        </div>
        <div className="w-48">
          <SearchCombobox
            value={statusFilter}
            onValueChange={setStatusFilter}
            placeholder="كل الحالات"
            searchPlaceholder="الحالة…"
            items={[{ value: "", label: "كل الحالات" },
              ...RISK_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))]}
          />
        </div>
      </div>

      {editing && (
        <Card className="border-red-300">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">
              {editing.id ? `تعديل تقييم المخاطر #${editing.id}` : "تقييم مخاطر جديد"}
            </CardTitle>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} aria-label="إغلاق">
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Label>العنوان *</Label>
              <Input value={editing.title ?? ""}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                placeholder="مثال: خطر سقوط من ارتفاع في خط التعبئة" data-testid="input-risk-title" />
            </div>
            <div>
              <Label>المنطقة / العملية</Label>
              <Input value={editing.processArea ?? ""}
                onChange={(e) => setEditing({ ...editing, processArea: e.target.value })}
                placeholder="مثال: مستودع المواد الخام" />
            </div>

            <div>
              <Label>مركز العمل</Label>
              <SearchCombobox
                value={editing.workCenterId == null ? "" : String(editing.workCenterId)}
                onValueChange={(v) => setEditing({ ...editing, workCenterId: v === "" ? null : Number(v) })}
                placeholder="— غير محدد —"
                searchPlaceholder="ابحث…"
                items={[{ value: "", label: "— غير محدد —" },
                  ...workCenters.map((w) => ({ value: String(w.id), label: w.nameAr }))]}
              />
            </div>
            <div>
              <Label>تصنيف الخطر</Label>
              <SearchCombobox
                value={editing.hazardCategory ?? "other"}
                onValueChange={(v) => setEditing({ ...editing, hazardCategory: v })}
                placeholder="اختر…"
                searchPlaceholder="التصنيف…"
                items={HAZARD_CATEGORIES.map((c) => ({ value: c, label: HAZARD_LABELS[c] }))}
              />
            </div>
            <div>
              <Label>المسؤول</Label>
              <SearchCombobox
                value={editing.responsibleUserId == null ? "" : String(editing.responsibleUserId)}
                onValueChange={(v) => setEditing({ ...editing, responsibleUserId: v === "" ? null : Number(v) })}
                placeholder="— غير محدد —"
                searchPlaceholder="ابحث…"
                items={[{ value: "", label: "— غير محدد —" },
                  ...users.map((u) => ({ value: String(u.id), label: u.username }))]}
              />
            </div>

            <div className="lg:col-span-3">
              <Label>وصف الخطر</Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px]"
                value={editing.hazardDescription ?? ""}
                onChange={(e) => setEditing({ ...editing, hazardDescription: e.target.value })}
                placeholder="صف مصدر الخطر وكيف قد يسبب ضرراً…"
              />
            </div>

            {/* Inherent risk */}
            <div className="lg:col-span-3 rounded-lg border p-3 bg-slate-50/50">
              <p className="text-sm font-semibold mb-2">المخاطر الكامنة (قبل الضوابط)</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <Label>الاحتمالية (1-5)</Label>
                  <Input type="number" min={1} max={5} value={editing.likelihood ?? 1}
                    onChange={(e) => setEditing({ ...editing, likelihood: Number(e.target.value) })}
                    data-testid="input-likelihood" />
                </div>
                <div>
                  <Label>الشدة (1-5)</Label>
                  <Input type="number" min={1} max={5} value={editing.severity ?? 1}
                    onChange={(e) => setEditing({ ...editing, severity: Number(e.target.value) })}
                    data-testid="input-severity" />
                </div>
                <div>
                  <Label>درجة الخطر</Label>
                  <div className="flex items-center gap-2 h-10">
                    <span className="text-lg font-bold">{inherentScore}</span>
                    <Badge className={LEVEL_COLORS[levelFromScore(inherentScore)]}>
                      {LEVEL_LABELS[levelFromScore(inherentScore)]}
                    </Badge>
                  </div>
                </div>
              </div>
            </div>

            <div className="lg:col-span-3">
              <Label>الضوابط الحالية</Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[50px]"
                value={editing.existingControls ?? ""}
                onChange={(e) => setEditing({ ...editing, existingControls: e.target.value })}
                placeholder="الإجراءات الوقائية المطبقة حالياً…"
              />
            </div>

            {/* Residual risk */}
            <div className="lg:col-span-3 rounded-lg border p-3 bg-emerald-50/40">
              <p className="text-sm font-semibold mb-2">المخاطر المتبقية (بعد الضوابط) — اختياري</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <Label>الاحتمالية المتبقية</Label>
                  <Input type="number" min={1} max={5}
                    value={editing.residualLikelihood ?? ""}
                    onChange={(e) => setEditing({ ...editing, residualLikelihood: e.target.value === "" ? null : Number(e.target.value) })} />
                </div>
                <div>
                  <Label>الشدة المتبقية</Label>
                  <Input type="number" min={1} max={5}
                    value={editing.residualSeverity ?? ""}
                    onChange={(e) => setEditing({ ...editing, residualSeverity: e.target.value === "" ? null : Number(e.target.value) })} />
                </div>
                <div>
                  <Label>درجة الخطر المتبقي</Label>
                  <div className="flex items-center gap-2 h-10">
                    {residualScore == null ? (
                      <span className="text-sm text-slate-400">—</span>
                    ) : (
                      <>
                        <span className="text-lg font-bold">{residualScore}</span>
                        <Badge className={LEVEL_COLORS[levelFromScore(residualScore)]}>
                          {LEVEL_LABELS[levelFromScore(residualScore)]}
                        </Badge>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div>
              <Label>تاريخ التقييم</Label>
              <Input type="date" value={editing.assessmentDate ?? ""}
                onChange={(e) => setEditing({ ...editing, assessmentDate: e.target.value || null })} />
            </div>
            <div>
              <Label>تاريخ المراجعة القادمة</Label>
              <Input type="date" value={editing.reviewDate ?? ""}
                onChange={(e) => setEditing({ ...editing, reviewDate: e.target.value || null })} />
            </div>
            <div>
              <Label>الحالة</Label>
              <SearchCombobox
                value={editing.status ?? "open"}
                onValueChange={(v) => setEditing({ ...editing, status: v })}
                placeholder="اختر…"
                searchPlaceholder="الحالة…"
                items={RISK_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
              />
            </div>

            <div className="lg:col-span-3">
              <Label>ملاحظات</Label>
              <Input value={editing.notes ?? ""}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })} placeholder="اختياري" />
            </div>

            <div className="lg:col-span-3 flex items-center justify-end gap-2 pt-2 border-t">
              <Button variant="outline" onClick={() => setEditing(null)}>إلغاء</Button>
              <Button onClick={save} disabled={saving} data-testid="btn-save-risk">
                <Save className="h-4 w-4 me-1" /> {saving ? "جارٍ الحفظ…" : "حفظ"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading && rows == null ? (
        <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
      ) : list.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-slate-500">
          لا توجد تقييمات مخاطر بعد. اضغط <strong>«تقييم مخاطر جديد»</strong> للبدء.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="p-2 text-start">الكود</th>
                <th className="p-2 text-start">العنوان</th>
                <th className="p-2 text-start">التصنيف</th>
                <th className="p-2 text-center">الكامن</th>
                <th className="p-2 text-center">المتبقي</th>
                <th className="p-2 text-start">المسؤول</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-end">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-t hover:bg-slate-50">
                  <td className="p-2 font-mono text-xs">{r.code}</td>
                  <td className="p-2 font-medium">{r.title}
                    {r.processArea ? <span className="text-xs text-slate-400"> — {r.processArea}</span> : null}
                  </td>
                  <td className="p-2 text-xs">{HAZARD_LABELS[r.hazardCategory] ?? r.hazardCategory}</td>
                  <td className="p-2 text-center">
                    <Badge className={LEVEL_COLORS[r.riskLevel]}>{r.riskScore} · {LEVEL_LABELS[r.riskLevel]}</Badge>
                  </td>
                  <td className="p-2 text-center">
                    {r.residualLevel
                      ? <Badge className={LEVEL_COLORS[r.residualLevel]}>{r.residualScore} · {LEVEL_LABELS[r.residualLevel]}</Badge>
                      : <span className="text-xs text-slate-400">—</span>}
                  </td>
                  <td className="p-2 text-xs">{r.responsibleName || "—"}</td>
                  <td className="p-2 text-center">
                    <Badge className={STATUS_COLORS[r.status]}>{STATUS_LABELS[r.status] ?? r.status}</Badge>
                  </td>
                  <td className="p-2 text-end">
                    <div className="inline-flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openControls(r)} title="الضوابط">
                        <ShieldCheck className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost"
                        onClick={() => setEditing({
                          ...r,
                          processArea: r.processArea ?? "",
                          hazardDescription: r.hazardDescription ?? "",
                          existingControls: r.existingControls ?? "",
                          notes: r.notes ?? "",
                        })} title="تعديل">
                        <Edit3 className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(r)} title="حذف" className="text-red-600">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Controls drawer */}
      {controlsForId != null && (
        <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={() => setControlsForId(null)}>
          <div className="bg-white w-full max-w-lg h-full overflow-y-auto p-5 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">ضوابط: {controlsForTitle}</h2>
              <Button size="sm" variant="ghost" onClick={() => setControlsForId(null)}><X className="h-4 w-4" /></Button>
            </div>
            <p className="text-xs text-slate-500">
              هرمية الضوابط (من الأعلى فعالية): الإزالة ← الاستبدال ← الهندسية ← الإدارية ← معدات الوقاية.
            </p>

            <div className="rounded-lg border p-3 space-y-2 bg-slate-50/50">
              <Label>إضافة ضابط</Label>
              <SearchCombobox
                value={newControl.controlType ?? "administrative"}
                onValueChange={(v) => setNewControl({ ...newControl, controlType: v })}
                placeholder="النوع…"
                searchPlaceholder="النوع…"
                items={CONTROL_TYPES.map((c) => ({ value: c, label: CONTROL_TYPE_LABELS[c] }))}
              />
              <Input value={newControl.description ?? ""}
                onChange={(e) => setNewControl({ ...newControl, description: e.target.value })}
                placeholder="وصف الضابط…" data-testid="input-control-desc" />
              <SearchCombobox
                value={newControl.ownerUserId == null ? "" : String(newControl.ownerUserId)}
                onValueChange={(v) => setNewControl({ ...newControl, ownerUserId: v === "" ? null : Number(v) })}
                placeholder="المسؤول — غير محدد —"
                searchPlaceholder="ابحث…"
                items={[{ value: "", label: "— غير محدد —" },
                  ...users.map((u) => ({ value: String(u.id), label: u.username }))]}
              />
              <Input type="date" value={newControl.dueDate ?? ""}
                onChange={(e) => setNewControl({ ...newControl, dueDate: e.target.value || null })} />
              <Button size="sm" onClick={addControl} data-testid="btn-add-control">
                <Plus className="h-4 w-4 me-1" /> إضافة
              </Button>
            </div>

            {controls.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-6">لا توجد ضوابط بعد.</p>
            ) : (
              <div className="space-y-2">
                {controls.map((c) => (
                  <div key={c.id} className="rounded-lg border p-3 flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs text-slate-500">{CONTROL_TYPE_LABELS[c.controlType] ?? c.controlType}</div>
                      <div className="text-sm font-medium">{c.description}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => cycleControlStatus(c)}
                        className={`text-xs rounded px-2 py-1 ${c.status === "done" ? "bg-emerald-100 text-emerald-700" : c.status === "in_progress" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700"}`}
                        title="تغيير الحالة">
                        {CONTROL_STATUS_LABELS[c.status]}
                      </button>
                      <Button size="sm" variant="ghost" className="text-red-600" onClick={() => deleteControl(c)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-slate-400">انقر شارة الحالة للتنقل: مخطط ← قيد التنفيذ ← منجز.</p>
          </div>
        </div>
      )}
    </div>
  );
}
