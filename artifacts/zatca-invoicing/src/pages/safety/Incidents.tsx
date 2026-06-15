import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useListIncidents, useGetIncident,
  useCreateIncident, useUpdateIncident, useDeleteIncident,
  useAddIncidentAction, useUpdateIncidentAction, useDeleteIncidentAction,
  getListIncidentsQueryKey, getGetIncidentQueryKey,
  type Incident, type IncidentAction,
  type CreateIncidentBody, type CreateIncidentActionBody,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Search, AlertTriangle, Edit3, Trash2, Save, X, ListChecks,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchCombobox } from "@/components/ui/search-combobox";
import {
  INCIDENT_TYPES, SEVERITY_CLASSES, INCIDENT_STATUSES, ACTION_TYPES,
} from "@/lib/safetyConstants";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.VITE_API_URL || "";

const TYPE_LABELS: Record<string, string> = {
  near_miss: "حادث وشيك (Near-miss)", unsafe_condition: "حالة غير آمنة",
  property_damage: "ضرر بالممتلكات", injury: "إصابة",
  occupational_illness: "مرض مهني", environmental: "بيئي",
};
const SEVERITY_LABELS: Record<string, string> = {
  no_treatment: "بدون علاج", first_aid: "إسعافات أولية",
  medical_treatment: "علاج طبي", lost_time: "فقد وقت العمل", fatality: "وفاة",
};
const SEVERITY_COLORS: Record<string, string> = {
  no_treatment: "bg-slate-100 text-slate-600", first_aid: "bg-sky-100 text-sky-700",
  medical_treatment: "bg-amber-100 text-amber-700", lost_time: "bg-orange-100 text-orange-700",
  fatality: "bg-red-100 text-red-700",
};
const STATUS_LABELS: Record<string, string> = {
  open: "مفتوح", investigating: "قيد التحقيق", action_pending: "بانتظار إجراء", closed: "مغلق",
};
const STATUS_COLORS: Record<string, string> = {
  open: "bg-amber-100 text-amber-700", investigating: "bg-sky-100 text-sky-700",
  action_pending: "bg-orange-100 text-orange-700", closed: "bg-emerald-100 text-emerald-700",
};
const ACTION_TYPE_LABELS: Record<string, string> = {
  corrective: "تصحيحي", preventive: "وقائي",
};
const ACTION_STATUS_LABELS: Record<string, string> = {
  open: "مفتوح", in_progress: "قيد التنفيذ", done: "منجز",
};

function toLocalInput(iso: string): string {
  // Convert an ISO timestamp to the value a datetime-local input expects.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Editing = Partial<Incident> & { occurredLocal: string };
const EMPTY: Editing = {
  title: "", incidentType: "near_miss", severityClass: "no_treatment",
  description: "", location: "", workCenterId: null, productionOrderId: null,
  injuredEmployeeId: null,
  occurredLocal: toLocalInput(new Date().toISOString()), immediateActions: "",
  rootCause: "", whys: [], lostDays: 0, status: "open",
};

type WC = { id: number; nameAr: string };
type Emp = { id: number; nameAr: string };
type Usr = { id: number; username?: string; fullName?: string };
type PO = { id: number; orderNumber?: string; title?: string };

export default function Incidents() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [workCenters, setWorkCenters] = useState<WC[]>([]);
  const [employees, setEmployees] = useState<Emp[]>([]);
  const [users, setUsers] = useState<Usr[]>([]);
  const [productionOrders, setProductionOrders] = useState<PO[]>([]);

  // Debounced params drive the generated list query.
  const [params, setParams] = useState<{ q?: string; status?: string; type?: string }>({});
  useEffect(() => {
    const id = setTimeout(() => {
      setParams({
        q: q.trim() || undefined,
        status: statusFilter || undefined,
        type: typeFilter || undefined,
      });
    }, 300);
    return () => clearTimeout(id);
  }, [q, statusFilter, typeFilter]);

  const incidentsQuery = useListIncidents(params, {
    query: { enabled: !!token, queryKey: getListIncidentsQueryKey(params) },
  });
  const rows = incidentsQuery.data ?? null;
  const loading = incidentsQuery.isLoading;

  // CAPA drawer — full incident (with actions) fetched on demand.
  const [capaForId, setCapaForId] = useState<number | null>(null);
  const [capaForNumber, setCapaForNumber] = useState<string>("");
  const incidentDetailQuery = useGetIncident(capaForId ?? 0, {
    query: { enabled: capaForId != null, queryKey: getGetIncidentQueryKey(capaForId ?? 0) },
  });
  const actions: IncidentAction[] = incidentDetailQuery.data?.actions ?? [];
  const [newAction, setNewAction] = useState<Partial<IncidentAction>>({
    actionType: "corrective", description: "", status: "open",
  });

  const createMut = useCreateIncident();
  const updateMut = useUpdateIncident();
  const deleteMut = useDeleteIncident();
  const addActionMut = useAddIncidentAction();
  const updateActionMut = useUpdateIncidentAction();
  const deleteActionMut = useDeleteIncidentAction();
  const saving = createMut.isPending || updateMut.isPending;

  const loadLookups = useCallback(async () => {
    if (!token) return;
    const actingCompanyId = localStorage.getItem("zatca_acting_company_id");
    const h: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (actingCompanyId) h["x-acting-company-id"] = actingCompanyId;
    try {
      const [wc, emp, usr, po] = await Promise.all([
        fetch(`${API}/api/production/work-centers`, { headers: h }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/api/employees`, { headers: h }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/api/users`, { headers: h }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/api/production/orders`, { headers: h }).then((r) => (r.ok ? r.json() : [])),
      ]);
      setWorkCenters(Array.isArray(wc) ? wc : wc?.rows ?? []);
      setEmployees(Array.isArray(emp) ? emp : emp?.rows ?? []);
      setUsers(Array.isArray(usr) ? usr : usr?.rows ?? []);
      setProductionOrders(Array.isArray(po) ? po : po?.rows ?? []);
    } catch { /* silent */ }
  }, [token]);
  useRefetchOnFocus(loadLookups);

  useEffect(() => {
    if (!token) return;
    void loadLookups();
  }, [token, loadLookups]);

  function setWhy(idx: number, val: string) {
    if (!editing) return;
    const whys = [...(editing.whys ?? [])];
    whys[idx] = val;
    setEditing({ ...editing, whys });
  }

  async function save() {
    if (!editing) return;
    if (!editing.title?.trim()) {
      toast({ title: "العنوان مطلوب", variant: "destructive" });
      return;
    }
    if (!editing.occurredLocal) {
      toast({ title: "تاريخ ووقت الحادث مطلوب", variant: "destructive" });
      return;
    }
    try {
      const whys = (editing.whys ?? []).map((w) => (w ?? "").trim()).filter(Boolean);
      const body: CreateIncidentBody = {
        title: editing.title.trim(),
        occurredAt: new Date(editing.occurredLocal).toISOString(),
        incidentType: editing.incidentType,
        severityClass: editing.severityClass,
        description: editing.description ?? null,
        location: editing.location ?? null,
        workCenterId: editing.workCenterId ?? null,
        productionOrderId: editing.productionOrderId ?? null,
        injuredEmployeeId: editing.injuredEmployeeId ?? null,
        immediateActions: editing.immediateActions ?? null,
        rootCause: editing.rootCause ?? null,
        whys,
        lostDays: editing.lostDays ?? 0,
        status: editing.status,
      };
      if (editing.id) await updateMut.mutateAsync({ id: editing.id, data: body });
      else await createMut.mutateAsync({ data: body });
      toast({ title: editing.id ? "✓ تم التحديث" : "✓ تم تسجيل الحادث" });
      setEditing(null);
      await incidentsQuery.refetch();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  async function remove(r: Incident) {
    if (!confirm(`حذف الحادث "${r.title}"؟`)) return;
    try {
      await deleteMut.mutateAsync({ id: r.id });
      toast({ title: "✓ تم الحذف" });
      await incidentsQuery.refetch();
    } catch (e: any) {
      toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" });
    }
  }

  function openCapa(r: Incident) {
    setCapaForNumber(r.incidentNumber ?? "");
    setCapaForId(r.id);
  }

  async function addAction() {
    if (capaForId == null) return;
    if (!newAction.description?.trim()) {
      toast({ title: "وصف الإجراء مطلوب", variant: "destructive" });
      return;
    }
    try {
      const body: CreateIncidentActionBody = {
        description: newAction.description.trim(),
        actionType: newAction.actionType,
        ownerUserId: newAction.ownerUserId ?? null,
        dueDate: newAction.dueDate ?? null,
        status: newAction.status,
      };
      await addActionMut.mutateAsync({ id: capaForId, data: body });
      setNewAction({ actionType: "corrective", description: "", status: "open" });
      await incidentDetailQuery.refetch();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  async function cycleActionStatus(a: IncidentAction) {
    const order = ["open", "in_progress", "done"];
    const next = order[(order.indexOf(a.status) + 1) % order.length];
    try {
      await updateActionMut.mutateAsync({ id: a.id, data: { status: next } });
      await incidentDetailQuery.refetch();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  async function deleteAction(a: IncidentAction) {
    try {
      await deleteActionMut.mutateAsync({ id: a.id });
      await incidentDetailQuery.refetch();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  const list = useMemo(() => rows ?? [], [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-red-500 to-rose-600 p-2 text-white shadow">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">الحوادث والإصابات</h1>
            <p className="text-sm text-slate-500">
              تسجيل الحوادث من الوشيكة حتى الوفيات، تحليل السبب الجذري (5 لماذا)،
              والإجراءات التصحيحية والوقائية (CAPA).
            </p>
          </div>
        </div>
        <Button onClick={() => setEditing({ ...EMPTY, occurredLocal: toLocalInput(new Date().toISOString()), whys: [] })}
          data-testid="btn-new-incident">
          <Plus className="h-4 w-4 me-1" /> تسجيل حادث
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 max-w-sm flex-1">
          <Search className="h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="ابحث بالعنوان أو الرقم أو الموقع…" data-testid="input-search-incidents" />
        </div>
        <div className="w-44">
          <SearchCombobox value={typeFilter} onValueChange={setTypeFilter}
            placeholder="كل الأنواع" searchPlaceholder="النوع…"
            items={[{ value: "", label: "كل الأنواع" },
              ...INCIDENT_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))]} />
        </div>
        <div className="w-44">
          <SearchCombobox value={statusFilter} onValueChange={setStatusFilter}
            placeholder="كل الحالات" searchPlaceholder="الحالة…"
            items={[{ value: "", label: "كل الحالات" },
              ...INCIDENT_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))]} />
        </div>
      </div>

      {editing && (
        <Card className="border-red-300">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">
              {editing.id ? `تعديل الحادث ${editing.incidentNumber ?? `#${editing.id}`}` : "تسجيل حادث جديد"}
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
                placeholder="مثال: انزلاق عامل على أرضية مبللة" data-testid="input-incident-title" />
            </div>
            <div>
              <Label>تاريخ ووقت الحادث *</Label>
              <Input type="datetime-local" value={editing.occurredLocal}
                onChange={(e) => setEditing({ ...editing, occurredLocal: e.target.value })}
                data-testid="input-occurred-at" />
            </div>

            <div>
              <Label>نوع الحادث</Label>
              <SearchCombobox value={editing.incidentType ?? "near_miss"}
                onValueChange={(v) => setEditing({ ...editing, incidentType: v })}
                placeholder="اختر…" searchPlaceholder="النوع…"
                items={INCIDENT_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))} />
            </div>
            <div>
              <Label>تصنيف الشدة</Label>
              <SearchCombobox value={editing.severityClass ?? "no_treatment"}
                onValueChange={(v) => setEditing({ ...editing, severityClass: v })}
                placeholder="اختر…" searchPlaceholder="الشدة…"
                items={SEVERITY_CLASSES.map((s) => ({ value: s, label: SEVERITY_LABELS[s] }))} />
              <p className="text-[11px] text-slate-400 mt-1">«علاج طبي» فأعلى يُحتسب حادثاً مسجَّلاً تلقائياً.</p>
            </div>
            <div>
              <Label>الموقع</Label>
              <Input value={editing.location ?? ""}
                onChange={(e) => setEditing({ ...editing, location: e.target.value })}
                placeholder="مثال: بوابة المستودع رقم 3" />
            </div>

            <div>
              <Label>مركز العمل</Label>
              <SearchCombobox value={editing.workCenterId == null ? "" : String(editing.workCenterId)}
                onValueChange={(v) => setEditing({ ...editing, workCenterId: v === "" ? null : Number(v) })}
                placeholder="— غير محدد —" searchPlaceholder="ابحث…"
                items={[{ value: "", label: "— غير محدد —" },
                  ...workCenters.map((w) => ({ value: String(w.id), label: w.nameAr }))]} />
            </div>
            <div>
              <Label>الموظف المصاب</Label>
              <SearchCombobox value={editing.injuredEmployeeId == null ? "" : String(editing.injuredEmployeeId)}
                onValueChange={(v) => setEditing({ ...editing, injuredEmployeeId: v === "" ? null : Number(v) })}
                placeholder="— غير محدد —" searchPlaceholder="ابحث…"
                items={[{ value: "", label: "— غير محدد —" },
                  ...employees.map((e) => ({ value: String(e.id), label: e.nameAr }))]} />
            </div>
            <div>
              <Label>أمر الإنتاج المرتبط</Label>
              <SearchCombobox value={editing.productionOrderId == null ? "" : String(editing.productionOrderId)}
                onValueChange={(v) => setEditing({ ...editing, productionOrderId: v === "" ? null : Number(v) })}
                placeholder="— غير محدد —" searchPlaceholder="ابحث…"
                items={[{ value: "", label: "— غير محدد —" },
                  ...productionOrders.map((p) => ({
                    value: String(p.id),
                    label: [p.orderNumber, p.title].filter(Boolean).join(" — ") || `#${p.id}`,
                  }))]} />
            </div>
            <div>
              <Label>أيام العمل المفقودة</Label>
              <Input type="number" min={0} value={editing.lostDays ?? 0}
                onChange={(e) => setEditing({ ...editing, lostDays: Math.max(0, Number(e.target.value)) })} />
            </div>

            <div className="lg:col-span-3">
              <Label>وصف الحادث</Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px]"
                value={editing.description ?? ""}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                placeholder="ماذا حدث بالضبط؟" />
            </div>
            <div className="lg:col-span-3">
              <Label>الإجراءات الفورية المتخذة</Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[50px]"
                value={editing.immediateActions ?? ""}
                onChange={(e) => setEditing({ ...editing, immediateActions: e.target.value })}
                placeholder="ما تم فعله مباشرة بعد الحادث…" />
            </div>

            {/* 5-Whys root cause */}
            <div className="lg:col-span-3 rounded-lg border p-3 bg-slate-50/50">
              <p className="text-sm font-semibold mb-2">تحليل السبب الجذري — 5 لماذا</p>
              <div className="space-y-2">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 w-16 shrink-0">لماذا {i + 1}؟</span>
                    <Input value={editing.whys?.[i] ?? ""}
                      onChange={(e) => setWhy(i, e.target.value)}
                      placeholder={i === 0 ? "لماذا وقع الحادث؟" : "ولماذا حدث ذلك؟"} />
                  </div>
                ))}
              </div>
            </div>
            <div className="lg:col-span-3">
              <Label>السبب الجذري (الخلاصة)</Label>
              <Input value={editing.rootCause ?? ""}
                onChange={(e) => setEditing({ ...editing, rootCause: e.target.value })}
                placeholder="السبب الجذري النهائي بعد التحليل…" />
            </div>

            <div>
              <Label>الحالة</Label>
              <SearchCombobox value={editing.status ?? "open"}
                onValueChange={(v) => setEditing({ ...editing, status: v })}
                placeholder="اختر…" searchPlaceholder="الحالة…"
                items={INCIDENT_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} />
            </div>

            <div className="lg:col-span-3 flex items-center justify-end gap-2 pt-2 border-t">
              <Button variant="outline" onClick={() => setEditing(null)}>إلغاء</Button>
              <Button onClick={save} disabled={saving} data-testid="btn-save-incident">
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
          لا توجد حوادث مسجَّلة. اضغط <strong>«تسجيل حادث»</strong> للبدء.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="p-2 text-start">الرقم</th>
                <th className="p-2 text-start">العنوان</th>
                <th className="p-2 text-start">النوع</th>
                <th className="p-2 text-center">الشدة</th>
                <th className="p-2 text-start">التاريخ</th>
                <th className="p-2 text-center">مسجَّل</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-end">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-t hover:bg-slate-50">
                  <td className="p-2 font-mono text-xs">{r.incidentNumber}</td>
                  <td className="p-2 font-medium">{r.title}
                    {r.location ? <span className="text-xs text-slate-400"> — {r.location}</span> : null}
                  </td>
                  <td className="p-2 text-xs">{TYPE_LABELS[r.incidentType] ?? r.incidentType}</td>
                  <td className="p-2 text-center">
                    <Badge className={SEVERITY_COLORS[r.severityClass]}>{SEVERITY_LABELS[r.severityClass]}</Badge>
                  </td>
                  <td className="p-2 text-xs whitespace-nowrap">
                    {new Date(r.occurredAt).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" })}
                  </td>
                  <td className="p-2 text-center">
                    {r.isRecordable ? <Badge className="bg-red-100 text-red-700">نعم</Badge>
                      : <span className="text-xs text-slate-400">—</span>}
                  </td>
                  <td className="p-2 text-center">
                    <Badge className={STATUS_COLORS[r.status]}>{STATUS_LABELS[r.status] ?? r.status}</Badge>
                  </td>
                  <td className="p-2 text-end">
                    <div className="inline-flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openCapa(r)} title="الإجراءات (CAPA)">
                        <ListChecks className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost"
                        onClick={() => setEditing({
                          ...r,
                          occurredLocal: toLocalInput(r.occurredAt),
                          description: r.description ?? "",
                          location: r.location ?? "",
                          immediateActions: r.immediateActions ?? "",
                          rootCause: r.rootCause ?? "",
                          whys: r.whys ?? [],
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

      {/* CAPA drawer */}
      {capaForId != null && (
        <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={() => setCapaForId(null)}>
          <div className="bg-white w-full max-w-lg h-full overflow-y-auto p-5 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">إجراءات: {capaForNumber}</h2>
              <Button size="sm" variant="ghost" onClick={() => setCapaForId(null)}><X className="h-4 w-4" /></Button>
            </div>
            <p className="text-xs text-slate-500">
              الإجراءات التصحيحية تعالج الحادث الحالي، والوقائية تمنع تكراره مستقبلاً.
            </p>

            <div className="rounded-lg border p-3 space-y-2 bg-slate-50/50">
              <Label>إضافة إجراء</Label>
              <SearchCombobox value={newAction.actionType ?? "corrective"}
                onValueChange={(v) => setNewAction({ ...newAction, actionType: v })}
                placeholder="النوع…" searchPlaceholder="النوع…"
                items={ACTION_TYPES.map((a) => ({ value: a, label: ACTION_TYPE_LABELS[a] }))} />
              <Input value={newAction.description ?? ""}
                onChange={(e) => setNewAction({ ...newAction, description: e.target.value })}
                placeholder="وصف الإجراء…" data-testid="input-action-desc" />
              <SearchCombobox value={newAction.ownerUserId == null ? "" : String(newAction.ownerUserId)}
                onValueChange={(v) => setNewAction({ ...newAction, ownerUserId: v === "" ? null : Number(v) })}
                placeholder="المسؤول — غير محدد —" searchPlaceholder="ابحث…"
                items={[{ value: "", label: "— غير محدد —" },
                  ...users.map((u) => ({ value: String(u.id), label: u.fullName || u.username || `#${u.id}` }))]} />
              <DateField value={newAction.dueDate ?? ""}
                onChange={(e) => setNewAction({ ...newAction, dueDate: e.target.value || null })} />
              <Button size="sm" onClick={addAction} data-testid="btn-add-action">
                <Plus className="h-4 w-4 me-1" /> إضافة
              </Button>
            </div>

            {actions.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-6">لا توجد إجراءات بعد.</p>
            ) : (
              <div className="space-y-2">
                {actions.map((a) => (
                  <div key={a.id} className="rounded-lg border p-3 flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs text-slate-500">
                        {ACTION_TYPE_LABELS[a.actionType] ?? a.actionType}
                        {a.dueDate ? ` · استحقاق ${a.dueDate}` : ""}
                      </div>
                      <div className="text-sm font-medium">{a.description}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => cycleActionStatus(a)}
                        className={`text-xs rounded px-2 py-1 ${a.status === "done" ? "bg-emerald-100 text-emerald-700" : a.status === "in_progress" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700"}`}
                        title="تغيير الحالة">
                        {ACTION_STATUS_LABELS[a.status]}
                      </button>
                      <Button size="sm" variant="ghost" className="text-red-600" onClick={() => deleteAction(a)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-slate-400">انقر شارة الحالة للتنقل: مفتوح ← قيد التنفيذ ← منجز.</p>
          </div>
        </div>
      )}
    </div>
  );
}
