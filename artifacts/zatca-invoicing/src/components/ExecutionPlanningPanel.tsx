import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Pencil, Plus, Trash2, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useCostCenters } from "@/hooks/useCostCenters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ContractingArchiveAction } from "@/components/ContractingArchiveAction";

const API = import.meta.env.VITE_API_URL || "";

type ResourceAnalysis = {
  id: number;
  workItemId: number;
  resourceId: number;
  plannedQty: string;
  wastagePercent: string | null;
  estimatedUnitCost: string;
  estimatedTotalCost: string;
  notes: string | null;
  resourceName: string;
  resourceType: string;
  resourceUnit: string;
};

type WorkItem = {
  id: number;
  projectId: number;
  parentWorkItemId: number | null;
  code: string | null;
  nameAr: string;
  description: string | null;
  category: string;
  unit: string;
  plannedQty: string;
  actualQty: string;
  unitCost: string;
  estimatedUnitCost: string;
  totalPlannedCost: string;
  estimatedBudget: string;
  totalActualCost: string;
  actualCostComplete: boolean;
  actualCostIncomplete: boolean;
  earnedValue: string;
  costPerformanceIndex: number;
  costVariance: string;
  progressPercent: string;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  status: string;
  costCenterId: number | null;
  notes: string | null;
  resourceAnalyses: ResourceAnalysis[];
};

type Resource = {
  id: number;
  projectId: number | null;
  name: string;
  type: string;
  unit: string;
  qty: string;
  unitCost: string;
  totalCost: string;
  status: string;
  notes: string | null;
  itemId?: number | null;
  unitId?: number | null;
  warehouseId?: number | null;
  unitNameAr?: string | null;
  warehouseNameAr?: string | null;
};

type InventoryOptions = {
  items: Array<{
    id: number;
    code: string;
    nameAr: string;
    baseUnitId: number;
    baseUnit: { id: number; code: string; nameAr: string };
    units: Array<{ id: number; code: string; nameAr: string; factor: string; isBase: boolean }>;
  }>;
  warehouses: Array<{ id: number; code: string; nameAr: string }>;
  balances: Array<{ itemId: number; warehouseId: number; qtyBase: string }>;
  requiresProjectBranch?: boolean;
};

export type ExecutionArchiveAdapterContext = {
  entityType: "workItem";
  entityId: number;
  projectId: number;
};

export type ExecutionPlanningPanelProps = {
  projectId: number;
  section: "work-items" | "resources";
  active?: boolean;
  onChange?: () => void;
  /**
   * Generic host adapter for the existing archival component. This panel does
   * not upload files or introduce a contracting-specific archive path.
   */
  renderArchive?: (context: ExecutionArchiveAdapterContext) => ReactNode;
};

const categories = ["earthworks", "excavation", "concrete", "steel", "masonry", "electrical", "plumbing", "mep", "finishing", "other"];
const statuses = ["pending", "in_progress", "completed", "blocked"];
const resourceTypes = ["labor", "equipment", "material", "subcontractor", "other"];
const resourceStatuses = ["planned", "in_use", "consumed", "returned"];
const labels: Record<string, string> = {
  earthworks: "أعمال ترابية", excavation: "حفر", concrete: "خرسانة", steel: "حديد",
  masonry: "مباني", electrical: "كهرباء", plumbing: "سباكة", mep: "كهروميكانيك",
  finishing: "تشطيبات", other: "أخرى", pending: "لم يبدأ", in_progress: "قيد التنفيذ",
  completed: "مكتمل", blocked: "متوقف", labor: "عمالة", equipment: "معدات",
  material: "مواد", subcontractor: "مقاول باطن", planned: "مخطط",
  in_use: "قيد الاستخدام", consumed: "مستهلك", returned: "مرتجع",
};

function Field({ label, required, children, className = "" }: {
  label: string; required?: boolean; children: ReactNode; className?: string;
}) {
  return <label className={`space-y-1 text-sm ${className}`}>
    <span className="font-medium">{label}{required ? " *" : ""}</span>
    {children}
  </label>;
}

function money(value: unknown): string {
  return Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as T & { error?: string };
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

export default function ExecutionPlanningPanel(props: ExecutionPlanningPanelProps) {
  return props.section === "resources"
    ? <ResourcesSection projectId={props.projectId} onChange={props.onChange} active={props.active} />
    : <WorkItemsSection {...props} />;
}

function WorkItemsSection({ projectId, onChange, renderArchive, active = true }: ExecutionPlanningPanelProps) {
  const { token, user } = useAuth() as any;
  const { toast } = useToast();
  const { data: costCenters = [] } = useCostCenters();
  const [rows, setRows] = useState<WorkItem[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [editing, setEditing] = useState<Partial<WorkItem> | null>(null);
  const [analysis, setAnalysis] = useState<Partial<ResourceAnalysis> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [itemsResponse, resourcesResponse] = await Promise.all([
        fetch(`${API}/api/contracting/projects/${projectId}/work-items`, { headers }),
        fetch(`${API}/api/contracting/resources?projectId=${projectId}`, { headers }),
      ]);
      const [items, projectResources] = await Promise.all([
        responseJson<WorkItem[]>(itemsResponse),
        responseJson<Resource[]>(resourcesResponse),
      ]);
      setRows(items);
      setResources(projectResources);
    } catch (error: any) {
      setLoadError(error?.message || "تعذر تحميل خطة التنفيذ");
      toast({ title: "تعذر تحميل خطة التنفيذ", description: error?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [headers, projectId, toast]);
  useEffect(() => { if (token && active) void load(); }, [load, token, active]);

  const parentOptions = rows
    .filter(row => row.id !== editing?.id)
    .map(row => ({ value: String(row.id), label: `${row.code ? `${row.code} — ` : ""}${row.nameAr}` }));
  const costCenterOptions = costCenters
    .filter(center => center.isActive !== false)
    .map(center => ({ value: String(center.id), label: `${center.code} — ${center.nameAr}` }));

  async function saveWorkItem() {
    if (!editing?.nameAr?.trim()) {
      toast({ title: "اسم بند التنفيذ مطلوب", variant: "destructive" }); return;
    }
    setSaving(true);
    try {
      const isEdit = editing.id != null;
      const response = await fetch(isEdit
        ? `${API}/api/contracting/work-items/${editing.id}`
        : `${API}/api/contracting/projects/${projectId}/work-items`, {
        method: isEdit ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      await responseJson(response);
      setEditing(null);
      setAnalysis(null);
      await load();
      onChange?.();
    } catch (error: any) {
      toast({ title: "تعذر حفظ بند التنفيذ", description: error?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function deleteWorkItem(id: number) {
    if (!confirm("تأكيد حذف بند التنفيذ؟")) return;
    try {
      await responseJson(await fetch(`${API}/api/contracting/work-items/${id}`, { method: "DELETE", headers }));
      await load();
      onChange?.();
    } catch (error: any) {
      toast({ title: "تعذر الحذف", description: error?.message, variant: "destructive" });
    }
  }

  async function saveAnalysis() {
    if (!editing?.id || !analysis?.resourceId) {
      toast({ title: "احفظ البند واختر مورداً موجوداً أولاً", variant: "destructive" }); return;
    }
    try {
      const isEdit = analysis.id != null;
      const response = await fetch(
        isEdit
          ? `${API}/api/contracting/projects/${projectId}/work-items/${editing.id}/resource-analysis/${analysis.id}`
          : `${API}/api/contracting/projects/${projectId}/work-items/${editing.id}/resource-analysis`,
        {
          method: isEdit ? "PUT" : "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(analysis),
        },
      );
      await responseJson(response);
      setAnalysis(null);
      await load();
      const refreshed = (await responseJson<WorkItem[]>(await fetch(
        `${API}/api/contracting/projects/${projectId}/work-items`, { headers },
      ))).find(row => row.id === editing.id);
      if (refreshed) setEditing(refreshed);
    } catch (error: any) {
      toast({ title: "تعذر حفظ تحليل المورد", description: error?.message, variant: "destructive" });
    }
  }

  async function deleteAnalysis(id: number) {
    if (!confirm("تأكيد حذف المورد من تحليل البند؟")) return;
    try {
      await responseJson(await fetch(`${API}/api/contracting/work-item-resource-analysis/${id}`, {
        method: "DELETE", headers,
      }));
      setAnalysis(null);
      await load();
      if (editing?.id) {
        const refreshed = (await responseJson<WorkItem[]>(await fetch(
          `${API}/api/contracting/projects/${projectId}/work-items`, { headers },
        ))).find(row => row.id === editing.id);
        if (refreshed) setEditing(refreshed);
      }
    } catch (error: any) {
      toast({ title: "تعذر حذف تحليل المورد", description: error?.message, variant: "destructive" });
    }
  }

  return <div className="space-y-4">
    {loadError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      تعذر تحميل بنود التنفيذ أو مواردها: {loadError}
      <Button size="sm" variant="outline" className="ms-2" onClick={() => void load()}>إعادة المحاولة</Button>
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="font-bold">خطة التنفيذ و WBS ({rows.length})</h3>
        <p className="text-xs text-muted-foreground">التكلفة الفعلية للعرض فقط من تكاملات المصدر، وليست حقلاً يدوياً.</p>
      </div>
      <Button size="sm" onClick={() => setEditing({
        nameAr: "", category: "other", unit: "m3", plannedQty: "0", actualQty: "0",
        unitCost: "0", progressPercent: "0", status: "pending", parentWorkItemId: null,
        costCenterId: null,
      })}><Plus className="me-1 h-4 w-4" />إضافة بند</Button>
    </div>

    {editing && <div className="space-y-4 rounded-lg border-2 border-emerald-300 bg-emerald-50/40 p-4 dark:border-emerald-800 dark:bg-emerald-950/20">
      <div className="flex items-center justify-between">
        <h4 className="font-bold text-emerald-700">{editing.id ? "تعديل بند التنفيذ" : "إضافة بند تنفيذ"}</h4>
        <Button size="icon" variant="ghost" onClick={() => { setEditing(null); setAnalysis(null); }}><X className="h-4 w-4" /></Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Field label="الكود"><Input value={editing.code ?? ""} onChange={event => setEditing({ ...editing, code: event.target.value })} /></Field>
        <Field label="الاسم" required><Input value={editing.nameAr ?? ""} onChange={event => setEditing({ ...editing, nameAr: event.target.value })} /></Field>
        <Field label="بند WBS الأب">
          <SearchCombobox clearable items={parentOptions} value={editing.parentWorkItemId ? String(editing.parentWorkItemId) : ""}
            onValueChange={value => setEditing({ ...editing, parentWorkItemId: value ? Number(value) : null })}
            placeholder="بند رئيسي" searchPlaceholder="بحث في بنود المشروع..." />
        </Field>
        <Field label="التصنيف"><SearchCombobox items={categories.map(value => ({ value, label: labels[value] }))}
          value={editing.category ?? "other"} onValueChange={category => setEditing({ ...editing, category })} /></Field>
        <Field label="الوحدة"><Input value={editing.unit ?? ""} onChange={event => setEditing({ ...editing, unit: event.target.value })} /></Field>
        <Field label="مركز التكلفة">
          <SearchCombobox clearable items={costCenterOptions} value={editing.costCenterId ? String(editing.costCenterId) : ""}
            onValueChange={value => setEditing({ ...editing, costCenterId: value ? Number(value) : null })}
            placeholder="بدون مركز تكلفة" searchPlaceholder="بحث بالكود أو الاسم..." />
        </Field>
        <Field label="الكمية المخططة"><Input type="number" min="0" value={editing.plannedQty ?? "0"} onChange={event => setEditing({ ...editing, plannedQty: event.target.value })} /></Field>
        <Field label="تكلفة الوحدة التقديرية"><Input type="number" min="0" value={editing.unitCost ?? "0"} onChange={event => setEditing({ ...editing, unitCost: event.target.value })} /></Field>
        <Field label="الميزانية المحسوبة"><Input readOnly value={money(Number(editing.plannedQty || 0) * Number(editing.unitCost || 0))} /></Field>
        <Field label="الكمية المنفذة"><Input type="number" min="0" value={editing.actualQty ?? "0"} onChange={event => setEditing({ ...editing, actualQty: event.target.value })} /></Field>
        <Field label="نسبة الإنجاز %"><Input type="number" min="0" max="100" value={editing.progressPercent ?? "0"} onChange={event => setEditing({ ...editing, progressPercent: event.target.value })} /></Field>
        <Field label="الحالة"><SearchCombobox items={statuses.map(value => ({ value, label: labels[value] }))}
          value={editing.status ?? "pending"} onValueChange={status => setEditing({ ...editing, status })} /></Field>
        <Field label="بداية مخططة"><DateField value={editing.plannedStartDate ?? ""} onChange={event => setEditing({ ...editing, plannedStartDate: event.target.value || null })} /></Field>
        <Field label="نهاية مخططة"><DateField value={editing.plannedEndDate ?? ""} onChange={event => setEditing({ ...editing, plannedEndDate: event.target.value || null })} /></Field>
        <Field label="بداية فعلية"><DateField value={editing.actualStartDate ?? ""} onChange={event => setEditing({ ...editing, actualStartDate: event.target.value || null })} /></Field>
        <Field label="نهاية فعلية"><DateField value={editing.actualEndDate ?? ""} onChange={event => setEditing({ ...editing, actualEndDate: event.target.value || null })} /></Field>
        <Field label="الوصف" className="md:col-span-2"><Textarea value={editing.description ?? ""} onChange={event => setEditing({ ...editing, description: event.target.value })} /></Field>
        <Field label="ملاحظات"><Textarea value={editing.notes ?? ""} onChange={event => setEditing({ ...editing, notes: event.target.value })} /></Field>
      </div>
      {editing.id && <>
        <div className="grid gap-2 rounded-md border bg-background p-3 sm:grid-cols-4">
          <div><span className="text-xs text-muted-foreground">EV</span><div className="font-semibold">{money(editing.earnedValue)} ر.س</div></div>
          <div><span className="text-xs text-muted-foreground">AC</span><div className="font-semibold">{money(editing.totalActualCost)} ر.س</div></div>
          <div><span className="text-xs text-muted-foreground">CPI</span><div className="font-semibold">{Number(editing.costPerformanceIndex || 0).toFixed(2)}</div></div>
          <div><span className="text-xs text-muted-foreground">الانحراف</span><div className="font-semibold">{money(editing.costVariance)} ر.س</div></div>
          {editing.actualCostIncomplete && <div className="col-span-full flex items-center gap-2 text-xs text-amber-700">
            <AlertTriangle className="h-4 w-4" />التكلفة الفعلية غير مكتملة حتى ترد جميع مصادر التكلفة المتكاملة.
          </div>}
        </div>
        <div className="space-y-2 rounded-md border bg-background p-3">
          <div className="flex items-center justify-between">
            <h5 className="font-semibold">تحليل الموارد الموجودة</h5>
            <Button size="sm" variant="outline" disabled={!resources.length} onClick={() => setAnalysis({
              plannedQty: "0", wastagePercent: null, estimatedUnitCost: "0",
            })}><Plus className="me-1 h-4 w-4" />ربط مورد</Button>
          </div>
          {analysis && <div className="grid gap-2 rounded border p-3 md:grid-cols-5">
            <Field label="المورد" required><SearchCombobox items={resources.map(resource => ({
              value: String(resource.id), label: `${resource.name} — ${labels[resource.type] ?? resource.type}`,
            }))} value={analysis.resourceId ? String(analysis.resourceId) : ""} onValueChange={value => {
              const resource = resources.find(item => item.id === Number(value));
              setAnalysis({ ...analysis, resourceId: Number(value), estimatedUnitCost: resource?.unitCost ?? "0" });
            }} /></Field>
            <Field label="الكمية"><Input type="number" min="0" value={analysis.plannedQty ?? "0"} onChange={event => setAnalysis({ ...analysis, plannedQty: event.target.value })} /></Field>
            <Field label="الهالك % (اختياري)"><Input type="number" min="0" max="100" value={analysis.wastagePercent ?? ""} onChange={event => setAnalysis({ ...analysis, wastagePercent: event.target.value || null })} /></Field>
            <Field label="تكلفة تقديرية/وحدة"><Input type="number" min="0" value={analysis.estimatedUnitCost ?? "0"} onChange={event => setAnalysis({ ...analysis, estimatedUnitCost: event.target.value })} /></Field>
            <div className="flex items-end gap-1"><Button onClick={saveAnalysis}>حفظ</Button><Button variant="ghost" onClick={() => setAnalysis(null)}>إلغاء</Button></div>
          </div>}
          <Table><TableHeader><TableRow><TableHead>المورد</TableHead><TableHead>الكمية</TableHead><TableHead>الهالك</TableHead><TableHead>التكلفة التقديرية</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{(editing.resourceAnalyses ?? []).map(item => <TableRow key={item.id}>
              <TableCell>{item.resourceName}<div className="text-xs text-muted-foreground">{labels[item.resourceType] ?? item.resourceType}</div></TableCell>
              <TableCell>{Number(item.plannedQty).toLocaleString("en-US")} {item.resourceUnit}</TableCell>
              <TableCell>{item.wastagePercent == null ? "—" : `${Number(item.wastagePercent)}%`}</TableCell>
              <TableCell>{money(item.estimatedTotalCost)} ر.س</TableCell>
              <TableCell className="text-end"><Button size="icon" variant="ghost" onClick={() => setAnalysis(item)}><Pencil className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" onClick={() => void deleteAnalysis(item.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button></TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </div>
        {renderArchive
          ? renderArchive({ entityType: "workItem", entityId: editing.id, projectId })
          : <ContractingArchiveAction
              entityType="workItem"
              entityId={editing.id}
              companyName={user?.company?.nameAr || user?.company?.nameEn}
            />}
      </>}
      <div className="flex justify-end gap-2 border-t pt-3">
        <Button variant="outline" onClick={() => setEditing(null)}>إلغاء</Button>
        <Button disabled={saving} onClick={saveWorkItem}>{saving ? "جارٍ الحفظ..." : "حفظ"}</Button>
      </div>
    </div>}

    <div className="overflow-x-auto rounded-lg border bg-background">
      <Table><TableHeader><TableRow><TableHead>WBS / البند</TableHead><TableHead>الميزانية</TableHead><TableHead>EV</TableHead><TableHead>AC</TableHead><TableHead>CPI</TableHead><TableHead>الانحراف</TableHead><TableHead>الإنجاز</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {loading && !rows.length && <TableRow><TableCell colSpan={8}><Skeleton className="h-16" /></TableCell></TableRow>}
           {!loading && !loadError && !rows.length && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">لا توجد بنود تنفيذ.</TableCell></TableRow>}
          {rows.map(row => <TableRow key={row.id}>
            <TableCell className="font-medium">{row.nameAr}<div className="text-xs text-muted-foreground">{row.code || ""}</div></TableCell>
            <TableCell>{money(row.estimatedBudget)} ر.س</TableCell><TableCell>{money(row.earnedValue)}</TableCell>
            <TableCell>{money(row.totalActualCost)}{row.actualCostIncomplete && <AlertTriangle className="ms-1 inline h-3.5 w-3.5 text-amber-500" />}</TableCell>
            <TableCell>{Number(row.costPerformanceIndex || 0).toFixed(2)}</TableCell><TableCell>{money(row.costVariance)}</TableCell>
            <TableCell><Badge variant="outline">{Number(row.progressPercent).toFixed(0)}%</Badge></TableCell>
            <TableCell className="text-end">
              {renderArchive
                ? renderArchive({ entityType: "workItem", entityId: row.id, projectId })
                : <ContractingArchiveAction
                    entityType="workItem"
                    entityId={row.id}
                    companyName={user?.company?.nameAr || user?.company?.nameEn}
                    className="h-8 gap-1.5 text-xs"
                  />}
              <Button size="icon" variant="ghost" onClick={() => { setEditing(row); setAnalysis(null); }}><Pencil className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" onClick={() => void deleteWorkItem(row.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button></TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </div>
  </div>;
}

function ResourcesSection({ projectId, onChange, active = true }: Pick<ExecutionPlanningPanelProps, "projectId" | "onChange" | "active">) {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<Resource[]>([]);
  const [inventory, setInventory] = useState<InventoryOptions>({ items: [], warehouses: [], balances: [] });
  const [editing, setEditing] = useState<Partial<Resource> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [resourceResponse, inventoryResponse] = await Promise.all([
        fetch(`${API}/api/contracting/resources?projectId=${projectId}`, { headers }),
        fetch(`${API}/api/contracting/resources/inventory-options?projectId=${projectId}`, { headers }),
      ]);
       const [projectResources, inventoryOptions] = await Promise.all([
         responseJson<Resource[]>(resourceResponse),
         responseJson<InventoryOptions>(inventoryResponse),
       ]);
       setRows(projectResources);
       setInventory(inventoryOptions);
    } catch (error: any) {
      setLoadError(error?.message || "تعذر تحميل موارد المشروع");
      toast({ title: "تعذر تحميل موارد المشروع", description: error?.message, variant: "destructive" });
    } finally { setLoading(false); }
  }, [headers, projectId, toast]);
  useEffect(() => { if (token && active) void load(); }, [load, token, active]);

  async function save() {
    if (editing?.type !== "material" && !editing?.name?.trim()) {
      toast({ title: "اسم المورد مطلوب", variant: "destructive" }); return;
    }
    if (editing?.type === "material" && (!editing.itemId || !editing.unitId || !editing.warehouseId)) {
      toast({ title: "اختر صنف المخزون ووحدته ومخزنه", variant: "destructive" }); return;
    }
    try {
      const isEdit = editing?.id != null;
      await responseJson(await fetch(isEdit
        ? `${API}/api/contracting/resources/${editing.id}`
        : `${API}/api/contracting/resources`, {
        method: isEdit ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...editing, projectId }),
      }));
      setEditing(null); await load(); onChange?.();
    } catch (error: any) {
      toast({ title: "تعذر حفظ المورد", description: error?.message, variant: "destructive" });
    }
  }
  async function remove(id: number) {
    if (!confirm("تأكيد حذف المورد؟")) return;
    try {
      await responseJson(await fetch(`${API}/api/contracting/resources/${id}`, { method: "DELETE", headers }));
      await load(); onChange?.();
    } catch (error: any) {
      toast({ title: "تعذر حذف المورد", description: error?.message, variant: "destructive" });
    }
  }

  const selectedItem = inventory.items.find(item => item.id === Number(editing?.itemId));
  const selectedUnit = selectedItem?.units.find(unit => unit.id === Number(editing?.unitId));
  const selectedBalance = inventory.balances.find(balance =>
    balance.itemId === Number(editing?.itemId)
    && balance.warehouseId === Number(editing?.warehouseId));
  return <div className="space-y-4">
    {loadError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      تعذر تحميل موارد المشروع أو خيارات المخزون: {loadError}
      <Button size="sm" variant="outline" className="ms-2" onClick={() => void load()}>إعادة المحاولة</Button>
    </div>}
    <div className="flex items-center justify-between"><div><h3 className="font-bold">موارد المشروع ({rows.length})</h3>
      <p className="text-xs text-muted-foreground">التخطيط لا يصرف المخزون ولا ينشئ تكلفة فعلية أو قيداً.</p></div>
      <Button size="sm" onClick={() => setEditing({ name: "", type: "material", unit: "", qty: "0", unitCost: "0", status: "planned" })}><Plus className="me-1 h-4 w-4" />إضافة مورد</Button>
    </div>
    {inventory.requiresProjectBranch && <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">المشروع بلا فرع؛ تتاح المخازن المشتركة فقط حتى تحديد الفرع.</div>}
    {editing && <div className="space-y-3 rounded-lg border-2 border-emerald-300 bg-emerald-50/40 p-4 dark:border-emerald-800 dark:bg-emerald-950/20">
      <div className="flex justify-between"><h4 className="font-bold">{editing.id ? "تعديل المورد" : "إضافة مورد"}</h4><Button size="icon" variant="ghost" onClick={() => setEditing(null)}><X className="h-4 w-4" /></Button></div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Field label="النوع"><SearchCombobox items={resourceTypes.map(value => ({ value, label: labels[value] ?? value }))} value={editing.type ?? "material"}
          onValueChange={type => setEditing({ ...editing, type, ...(type === "material" ? {} : { itemId: null, unitId: null, warehouseId: null, unit: "hr" }) })} /></Field>
        {editing.type === "material" ? <>
          <Field label="صنف المخزون" required><SearchCombobox items={inventory.items.map(item => ({ value: String(item.id), label: `${item.code} — ${item.nameAr}` }))}
            value={editing.itemId ? String(editing.itemId) : ""} onValueChange={value => {
              const item = inventory.items.find(candidate => candidate.id === Number(value));
              setEditing({ ...editing, itemId: Number(value), name: item?.nameAr ?? "", unitId: item?.baseUnitId, unit: item?.baseUnit.code ?? "" });
            }} /></Field>
          <Field label="الوحدة" required><SearchCombobox items={(selectedItem?.units ?? []).map(unit => ({ value: String(unit.id), label: `${unit.nameAr}${unit.isBase ? " (أساسية)" : ""}` }))}
            value={editing.unitId ? String(editing.unitId) : ""} onValueChange={value => {
              const unit = selectedItem?.units.find(candidate => candidate.id === Number(value));
              setEditing({ ...editing, unitId: Number(value), unit: unit?.code ?? "" });
            }} /></Field>
          <Field label="المخزن" required><SearchCombobox items={inventory.warehouses.map(warehouse => ({ value: String(warehouse.id), label: `${warehouse.code} — ${warehouse.nameAr}` }))}
            value={editing.warehouseId ? String(editing.warehouseId) : ""} onValueChange={value => setEditing({ ...editing, warehouseId: Number(value) })} /></Field>
        </> : <>
          <Field label="الاسم" required><Input value={editing.name ?? ""} onChange={event => setEditing({ ...editing, name: event.target.value })} /></Field>
          <Field label="الوحدة"><Input value={editing.unit ?? "hr"} onChange={event => setEditing({ ...editing, unit: event.target.value })} /></Field>
        </>}
        <Field label="الكمية"><Input type="number" min="0" value={editing.qty ?? "0"} onChange={event => setEditing({ ...editing, qty: event.target.value })} /></Field>
        <Field label="تكلفة الوحدة المخططة"><Input type="number" min="0" value={editing.unitCost ?? "0"} onChange={event => setEditing({ ...editing, unitCost: event.target.value })} /></Field>
        <Field label="الحالة"><SearchCombobox items={resourceStatuses.map(value => ({ value, label: labels[value] }))} value={editing.status ?? "planned"} onValueChange={status => setEditing({ ...editing, status })} /></Field>
        <Field label="ملاحظات" className="md:col-span-2"><Textarea value={editing.notes ?? ""} onChange={event => setEditing({ ...editing, notes: event.target.value })} /></Field>
      </div>
      {editing.type === "material" && selectedItem && selectedUnit && editing.warehouseId && (
        <div className="rounded-md border border-blue-200 bg-blue-50/70 p-3 text-sm dark:bg-blue-950/20">
          <span className="font-medium">المتاح في المخزن:</span>{" "}
          {Number(selectedBalance?.qtyBase ?? 0).toLocaleString("en-US")} {selectedItem.baseUnit.nameAr}
          {" · "}
          {(Number(selectedUnit.factor) > 0
            ? Number(selectedBalance?.qtyBase ?? 0) / Number(selectedUnit.factor)
            : 0).toLocaleString("en-US")} {selectedUnit.nameAr}
          <div className="mt-1 text-[11px] text-muted-foreground">العرض للتخطيط فقط؛ لا يتم صرف المخزون أو إنشاء قيد.</div>
        </div>
      )}
      <div className="flex justify-end gap-2 border-t pt-3"><Button variant="outline" onClick={() => setEditing(null)}>إلغاء</Button><Button onClick={save}>حفظ</Button></div>
    </div>}
    <div className="overflow-x-auto rounded-lg border bg-background"><Table><TableHeader><TableRow><TableHead>المورد</TableHead><TableHead>النوع</TableHead><TableHead>الكمية</TableHead><TableHead>التكلفة المخططة</TableHead><TableHead>الحالة</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>{loading && !rows.length && <TableRow><TableCell colSpan={6}><Skeleton className="h-16" /></TableCell></TableRow>}
         {!loading && !loadError && !rows.length && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">لا توجد موارد.</TableCell></TableRow>}
        {rows.map(row => <TableRow key={row.id}><TableCell className="font-medium">{row.name}<div className="text-xs text-muted-foreground">{row.warehouseNameAr || ""}</div></TableCell>
          <TableCell><Badge variant="outline">{labels[row.type] ?? row.type}</Badge></TableCell><TableCell>{Number(row.qty).toLocaleString("en-US")} {row.unitNameAr ?? row.unit}</TableCell>
          <TableCell>{money(row.totalCost)} ر.س</TableCell><TableCell>{labels[row.status] ?? row.status}</TableCell>
          <TableCell className="text-end"><Button size="icon" variant="ghost" onClick={() => setEditing(row)}><Pencil className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" onClick={() => void remove(row.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button></TableCell></TableRow>)}
      </TableBody></Table></div>
  </div>;
}