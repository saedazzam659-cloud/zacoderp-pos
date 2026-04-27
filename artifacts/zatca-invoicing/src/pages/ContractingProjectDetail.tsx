import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Link, useRoute } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, Briefcase, Plus, Pencil, Trash2, Sparkles, Download,
  TrendingUp, Wallet, Activity, AlertTriangle, FileSpreadsheet, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import ContractingAIAssistant from "@/components/ContractingAIAssistant";

const API = import.meta.env.VITE_API_URL || "";

type Project = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  clientName: string | null; location: string | null; projectType: string;
  status: string; contractValue: string; plannedBudget: string; actualCost: string;
  plannedStartDate: string | null; plannedEndDate: string | null;
  progressPercent: string; description: string | null;
};
type WorkItem = {
  id: number; projectId: number; code: string | null; nameAr: string;
  category: string; unit: string; plannedQty: string; actualQty: string;
  unitCost: string; totalPlannedCost: string; totalActualCost: string;
  progressPercent: string; status: string; notes: string | null;
};
type Resource = {
  id: number; projectId: number | null; name: string; type: string; unit: string;
  qty: string; unitCost: string; totalCost: string; status: string; notes: string | null;
};
type Bill = {
  id: number; billNumber: string; billType: string; billDate: string;
  fromDate: string | null; toDate: string | null; progressPercent: string;
  grossAmount: string; retentionPercent: string; retentionAmount: string;
  previousPaid: string; dueAmount: string; vatAmount: string; netAmount: string;
  status: string; notes: string | null;
};
type Risk = {
  id: number; title: string; description: string | null; category: string;
  likelihood: string; impact: string; score: number;
  mitigationPlan: string | null; status: string;
};
type Event = {
  id: number; eventType: string; title: string; description: string | null;
  severity: string; createdAt: string;
};
// Mirrors the backend response shape from POST /api/contracting-ai/analyze/:id
// (see api-server/src/routes/contracting-ai.ts ~line 307 + fallback ~line 235).
// Risk levels are simple "low|medium|high" enums, not nested {score,reason} objects.
type RiskLevel = "low" | "medium" | "high";
type AIAnalysis = {
  summary: string;
  delay_risk: RiskLevel;
  cost_risk: RiskLevel;
  findings: string[];
  recommendations: string[];
  indicators?: {
    actualProgress?: number;
    expectedProgress?: number;
    schedulePerformanceIndex?: number | null;
    costOverrun?: number;
    projectedFinalCost?: number | null;
    blockedItems?: number;
    openHighRisks?: number;
  };
  source: "ai" | "fallback";
};

const RISK_LABEL: Record<RiskLevel, string> = { low: "منخفضة", medium: "متوسطة", high: "عالية" };
const RISK_TONE:  Record<RiskLevel, string> = {
  low:    "bg-emerald-100 text-emerald-700",
  medium: "bg-amber-100   text-amber-700",
  high:   "bg-red-100     text-red-700",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "مسودة", in_progress: "قيد التنفيذ", on_hold: "متوقفة",
  completed: "مكتملة", cancelled: "ملغاة",
};

export default function ContractingProjectDetail() {
  const { t } = useTranslation();
  const [, params] = useRoute("/contracting/projects/:id");
  const projectId = Number(params?.id);
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState("overview");

  const loadProject = useCallback(async () => {
    if (!token || !projectId) return;
    try {
      const r = await fetch(`${API}/api/contracting/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setProject(await r.json());
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    }
  }, [token, projectId, t, toast]);

  useEffect(() => { void loadProject(); }, [loadProject]);

  const fmt = (n: string | number) => Number(n || 0).toLocaleString("ar-SA");

  if (!project) {
    return <div className="p-6"><Skeleton className="h-32 w-full" /></div>;
  }

  const overrunPct = Number(project.plannedBudget) > 0
    ? ((Number(project.actualCost) - Number(project.plannedBudget)) / Number(project.plannedBudget)) * 100
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/contracting/projects">
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div className="rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 p-2 text-white shadow">
          <Briefcase className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{project.nameAr}</h1>
          <div className="text-sm text-slate-500">
            {project.code} • {STATUS_LABEL[project.status] ?? project.status}
            {project.location && ` • ${project.location}`}
          </div>
        </div>
        <Badge variant={project.status === "completed" ? "secondary" : project.status === "cancelled" ? "destructive" : "default"}>
          {STATUS_LABEL[project.status] ?? project.status}
        </Badge>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid grid-cols-7 w-full">
          <TabsTrigger value="overview">{t("contracting.tabs.overview", "نظرة عامة")}</TabsTrigger>
          <TabsTrigger value="work-items">{t("contracting.tabs.workItems", "بنود التنفيذ")}</TabsTrigger>
          <TabsTrigger value="resources">{t("contracting.tabs.resources", "الموارد")}</TabsTrigger>
          <TabsTrigger value="bills">{t("contracting.tabs.bills", "المستخلصات")}</TabsTrigger>
          <TabsTrigger value="risks">{t("contracting.tabs.risks", "المخاطر")}</TabsTrigger>
          <TabsTrigger value="events">{t("contracting.tabs.events", "الأحداث")}</TabsTrigger>
          <TabsTrigger value="ai">
            <Sparkles className="h-3.5 w-3.5 mx-1" />{t("contracting.tabs.ai", "الذكاء الاصطناعي")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi icon={<Wallet />} label={t("contracting.projects.contractValue", "قيمة العقد")} value={fmt(project.contractValue) + " ر.س"} tone="violet" />
            <Kpi icon={<TrendingUp />} label={t("contracting.projects.plannedBudget", "الميزانية المخططة")} value={fmt(project.plannedBudget) + " ر.س"} tone="emerald" />
            <Kpi icon={<Wallet />} label={t("contracting.projects.actualCost", "التكلفة الفعلية")} value={fmt(project.actualCost) + " ر.س"}
                 tone={overrunPct > 0 ? "amber" : "indigo"} subtitle={overrunPct !== 0 ? `${overrunPct > 0 ? "+" : ""}${overrunPct.toFixed(1)}%` : ""} />
            <Kpi icon={<Activity />} label={t("contracting.projects.progress", "نسبة الإنجاز")} value={`${Number(project.progressPercent).toFixed(1)}%`} tone="indigo" />
          </div>
          <div className="rounded-lg border bg-white dark:bg-slate-900 p-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <Meta label={t("contracting.projects.client", "العميل")} value={project.clientName || "—"} />
            <Meta label={t("contracting.projects.type", "نوع المشروع")} value={project.projectType} />
            <Meta label={t("contracting.projects.plannedStartDate", "تاريخ البداية المخطط")} value={project.plannedStartDate || "—"} />
            <Meta label={t("contracting.projects.plannedEndDate", "تاريخ النهاية المخطط")} value={project.plannedEndDate || "—"} />
            {project.description && (
              <div className="md:col-span-2">
                <Meta label={t("contracting.projects.description", "الوصف")} value={project.description} />
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="work-items" className="mt-4"><WorkItemsTab projectId={projectId} onChange={loadProject} /></TabsContent>
        <TabsContent value="resources"  className="mt-4"><ResourcesTab projectId={projectId} /></TabsContent>
        <TabsContent value="bills"      className="mt-4"><BillsTab projectId={projectId} /></TabsContent>
        <TabsContent value="risks"      className="mt-4"><RisksTab projectId={projectId} /></TabsContent>
        <TabsContent value="events"     className="mt-4"><EventsTab projectId={projectId} /></TabsContent>
        <TabsContent value="ai"         className="mt-4"><AITab projectId={projectId} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ─────────────────── small helpers ───────────────────
function Kpi({ icon, label, value, tone, subtitle }: {
  icon: React.ReactNode; label: string; value: React.ReactNode;
  tone: "violet" | "emerald" | "amber" | "indigo"; subtitle?: string;
}) {
  const toneCls: Record<typeof tone, string> = {
    violet:  "from-violet-500 to-fuchsia-500",
    emerald: "from-emerald-500 to-teal-500",
    amber:   "from-amber-500 to-orange-500",
    indigo:  "from-indigo-500 to-blue-500",
  };
  return (
    <div className="rounded-lg border bg-white dark:bg-slate-900 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] text-slate-500 truncate">{label}</div>
          <div className="text-lg font-bold mt-1">{value}</div>
          {subtitle && <div className={`text-[11px] mt-0.5 ${subtitle.startsWith("+") ? "text-red-600" : "text-emerald-600"}`}>{subtitle}</div>}
        </div>
        <div className={`rounded-md bg-gradient-to-br ${toneCls[tone]} p-1.5 text-white shrink-0`}>
          <div className="h-4 w-4">{icon}</div>
        </div>
      </div>
    </div>
  );
}
function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-slate-600">{label}{required && <span className="text-red-500"> *</span>}</label>
      {children}
    </div>
  );
}

// ─────────────────── WORK ITEMS TAB ───────────────────
function WorkItemsTab({ projectId, onChange }: { projectId: number; onChange: () => void }) {
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<WorkItem> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/contracting/projects/${projectId}/work-items`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    } finally { setLoading(false); }
  }, [token, projectId, t, toast]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!editing?.nameAr?.trim()) {
      toast({ title: t("common.required", "الاسم مطلوب"), variant: "destructive" }); return;
    }
    try {
      const isEdit = (editing as any).id != null;
      const url = isEdit
        ? `${API}/api/contracting/work-items/${(editing as any).id}`
        : `${API}/api/contracting/projects/${projectId}/work-items`;
      const r = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(editing),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      setEditing(null);
      await load();
      onChange();
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    }
  }

  async function del(id: number) {
    if (!confirm(t("common.confirmDelete", "تأكيد الحذف؟"))) return;
    try {
      await fetch(`${API}/api/contracting/work-items/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      await load(); onChange();
    } catch (e: any) {
      toast({ title: e?.message, variant: "destructive" });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between">
        <h3 className="font-bold">{t("contracting.workItems.title", "بنود التنفيذ")} ({rows.length})</h3>
        <Button size="sm" onClick={() => setEditing({
          nameAr: "", category: "other", unit: "m3", plannedQty: "0", actualQty: "0",
          unitCost: "0", progressPercent: "0", status: "pending",
        })}>
          <Plus className="h-4 w-4 mx-1" /> {t("contracting.workItems.add", "إضافة بند")}
        </Button>
      </div>
      <div className="rounded-lg border bg-white dark:bg-slate-900 overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t("contracting.workItems.name", "الاسم")}</TableHead>
            <TableHead>{t("contracting.workItems.unit", "الوحدة")}</TableHead>
            <TableHead>{t("contracting.workItems.plannedQty", "كمية مخططة")}</TableHead>
            <TableHead>{t("contracting.workItems.actualQty", "كمية فعلية")}</TableHead>
            <TableHead>{t("contracting.workItems.unitCost", "سعر الوحدة")}</TableHead>
            <TableHead>{t("contracting.workItems.totalActual", "تكلفة فعلية")}</TableHead>
            <TableHead>{t("contracting.workItems.progress", "إنجاز %")}</TableHead>
            <TableHead className="text-end">—</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {loading && rows.length === 0 && <TableRow><TableCell colSpan={8}><Skeleton className="h-16 w-full" /></TableCell></TableRow>}
            {!loading && rows.length === 0 && <TableRow><TableCell colSpan={8} className="text-center text-sm text-slate-500 py-4">{t("contracting.workItems.empty", "لا توجد بنود — أضف بنود التنفيذ للبدء")}</TableCell></TableRow>}
            {rows.map(r => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.nameAr}<div className="text-[10px] text-slate-400">{r.code || ""}</div></TableCell>
                <TableCell>{r.unit}</TableCell>
                <TableCell className="tabular-nums">{Number(r.plannedQty).toLocaleString()}</TableCell>
                <TableCell className="tabular-nums">{Number(r.actualQty).toLocaleString()}</TableCell>
                <TableCell className="tabular-nums">{Number(r.unitCost).toLocaleString()}</TableCell>
                <TableCell className="tabular-nums">{Number(r.totalActualCost).toLocaleString()}</TableCell>
                <TableCell className="tabular-nums">{Number(r.progressPercent).toFixed(0)}%</TableCell>
                <TableCell className="text-end">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => del(r.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{(editing as any)?.id ? t("contracting.workItems.edit", "تعديل البند") : t("contracting.workItems.add", "إضافة بند")}</DialogTitle></DialogHeader>
          {editing && <div className="grid grid-cols-2 gap-3">
            <Field label={t("contracting.workItems.code", "الكود")}><Input value={editing.code ?? ""} onChange={e => setEditing({ ...editing, code: e.target.value })} /></Field>
            <Field label={t("contracting.workItems.name", "الاسم")} required><Input value={editing.nameAr ?? ""} onChange={e => setEditing({ ...editing, nameAr: e.target.value })} /></Field>
            <Field label={t("contracting.workItems.unit", "الوحدة")}><Input value={editing.unit ?? "m3"} onChange={e => setEditing({ ...editing, unit: e.target.value })} /></Field>
            <Field label={t("contracting.workItems.category", "التصنيف")}>
              <Select value={editing.category ?? "other"} onValueChange={v => setEditing({ ...editing, category: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["earthworks","concrete","steel","masonry","mep","finishing","other"].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("contracting.workItems.plannedQty", "كمية مخططة")}><Input type="number" value={editing.plannedQty ?? "0"} onChange={e => setEditing({ ...editing, plannedQty: e.target.value })} /></Field>
            <Field label={t("contracting.workItems.actualQty", "كمية فعلية")}><Input type="number" value={editing.actualQty ?? "0"} onChange={e => setEditing({ ...editing, actualQty: e.target.value })} /></Field>
            <Field label={t("contracting.workItems.unitCost", "سعر الوحدة (ر.س)")}><Input type="number" value={editing.unitCost ?? "0"} onChange={e => setEditing({ ...editing, unitCost: e.target.value })} /></Field>
            <Field label={t("contracting.workItems.progress", "نسبة الإنجاز %")}><Input type="number" min={0} max={100} value={editing.progressPercent ?? "0"} onChange={e => setEditing({ ...editing, progressPercent: e.target.value })} /></Field>
            <Field label={t("contracting.workItems.status", "الحالة")}>
              <Select value={editing.status ?? "pending"} onValueChange={v => setEditing({ ...editing, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["pending","in_progress","completed","blocked"].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>{t("common.cancel", "إلغاء")}</Button>
            <Button onClick={save}>{t("common.save", "حفظ")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────── RESOURCES TAB ───────────────────
function ResourcesTab({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<Resource> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/contracting/resources?projectId=${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) { toast({ title: e?.message, variant: "destructive" }); }
    finally { setLoading(false); }
  }, [token, projectId, toast]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!editing?.name?.trim()) { toast({ title: t("common.required", "الاسم مطلوب"), variant: "destructive" }); return; }
    try {
      const isEdit = (editing as any).id != null;
      const url = isEdit
        ? `${API}/api/contracting/resources/${(editing as any).id}`
        : `${API}/api/contracting/resources`;
      const body = { ...editing, projectId };
      const r = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      setEditing(null); await load();
    } catch (e: any) { toast({ title: e?.message, variant: "destructive" }); }
  }
  async function del(id: number) {
    if (!confirm(t("common.confirmDelete", "تأكيد الحذف؟"))) return;
    await fetch(`${API}/api/contracting/resources/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    await load();
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between">
        <h3 className="font-bold">{t("contracting.resources.title", "الموارد")} ({rows.length})</h3>
        <Button size="sm" onClick={() => setEditing({ name: "", type: "material", unit: "hr", qty: "0", unitCost: "0", status: "planned" })}>
          <Plus className="h-4 w-4 mx-1" /> {t("contracting.resources.add", "إضافة مورد")}
        </Button>
      </div>
      <div className="rounded-lg border bg-white dark:bg-slate-900 overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t("contracting.resources.name", "المورد")}</TableHead>
            <TableHead>{t("contracting.resources.type", "النوع")}</TableHead>
            <TableHead>{t("contracting.resources.qty", "الكمية")}</TableHead>
            <TableHead>{t("contracting.resources.totalCost", "التكلفة")}</TableHead>
            <TableHead>{t("contracting.resources.status", "الحالة")}</TableHead>
            <TableHead className="text-end">—</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {loading && rows.length === 0 && <TableRow><TableCell colSpan={6}><Skeleton className="h-16 w-full" /></TableCell></TableRow>}
            {!loading && rows.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-sm text-slate-500 py-4">{t("contracting.resources.empty", "لا توجد موارد")}</TableCell></TableRow>}
            {rows.map(r => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell><Badge variant="outline">{r.type}</Badge></TableCell>
                <TableCell className="tabular-nums">{Number(r.qty).toLocaleString()} {r.unit}</TableCell>
                <TableCell className="tabular-nums">{Number(r.totalCost).toLocaleString()} ر.س</TableCell>
                <TableCell><Badge>{r.status}</Badge></TableCell>
                <TableCell className="text-end">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => del(r.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{(editing as any)?.id ? t("contracting.resources.edit", "تعديل المورد") : t("contracting.resources.add", "إضافة مورد")}</DialogTitle></DialogHeader>
          {editing && <div className="grid grid-cols-2 gap-3">
            <Field label={t("contracting.resources.name", "اسم المورد")} required><Input value={editing.name ?? ""} onChange={e => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label={t("contracting.resources.type", "النوع")}>
              <Select value={editing.type ?? "material"} onValueChange={v => setEditing({ ...editing, type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["labor","equipment","material","subcontractor","other"].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("contracting.resources.unit", "الوحدة")}><Input value={editing.unit ?? "hr"} onChange={e => setEditing({ ...editing, unit: e.target.value })} /></Field>
            <Field label={t("contracting.resources.qty", "الكمية")}><Input type="number" value={editing.qty ?? "0"} onChange={e => setEditing({ ...editing, qty: e.target.value })} /></Field>
            <Field label={t("contracting.resources.unitCost", "سعر الوحدة")}><Input type="number" value={editing.unitCost ?? "0"} onChange={e => setEditing({ ...editing, unitCost: e.target.value })} /></Field>
            <Field label={t("contracting.resources.status", "الحالة")}>
              <Select value={editing.status ?? "planned"} onValueChange={v => setEditing({ ...editing, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["planned","in_use","consumed","returned"].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>{t("common.cancel", "إلغاء")}</Button>
            <Button onClick={save}>{t("common.save", "حفظ")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────── BILLS TAB ───────────────────
function BillsTab({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<Bill> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/contracting/projects/${projectId}/bills`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) { toast({ title: e?.message, variant: "destructive" }); }
    finally { setLoading(false); }
  }, [token, projectId, toast]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!editing?.billNumber || !editing?.billDate) { toast({ title: t("contracting.bills.required", "الرقم والتاريخ مطلوبان"), variant: "destructive" }); return; }
    try {
      const isEdit = (editing as any).id != null;
      const url = isEdit
        ? `${API}/api/contracting/bills/${(editing as any).id}`
        : `${API}/api/contracting/projects/${projectId}/bills`;
      const r = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(editing),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      setEditing(null); await load();
    } catch (e: any) { toast({ title: e?.message, variant: "destructive" }); }
  }
  async function del(id: number) {
    if (!confirm(t("common.confirmDelete", "تأكيد الحذف؟"))) return;
    await fetch(`${API}/api/contracting/bills/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    await load();
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between">
        <h3 className="font-bold">{t("contracting.bills.title", "المستخلصات")} ({rows.length})</h3>
        <Button size="sm" onClick={() => setEditing({ billNumber: "", billType: "interim", billDate: new Date().toISOString().slice(0,10), progressPercent: "0", grossAmount: "0", retentionPercent: "10", previousPaid: "0", status: "draft" })}>
          <Plus className="h-4 w-4 mx-1" /> {t("contracting.bills.add", "مستخلص جديد")}
        </Button>
      </div>
      <div className="rounded-lg border bg-white dark:bg-slate-900 overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t("contracting.bills.number", "الرقم")}</TableHead>
            <TableHead>{t("contracting.bills.date", "التاريخ")}</TableHead>
            <TableHead>{t("contracting.bills.gross", "إجمالي")}</TableHead>
            <TableHead>{t("contracting.bills.retention", "محتجز")}</TableHead>
            <TableHead>{t("contracting.bills.due", "مستحق")}</TableHead>
            <TableHead>{t("contracting.bills.net", "صافي")}</TableHead>
            <TableHead>{t("contracting.bills.status", "الحالة")}</TableHead>
            <TableHead className="text-end">—</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {loading && rows.length === 0 && <TableRow><TableCell colSpan={8}><Skeleton className="h-16 w-full" /></TableCell></TableRow>}
            {!loading && rows.length === 0 && <TableRow><TableCell colSpan={8} className="text-center text-sm text-slate-500 py-4">{t("contracting.bills.empty", "لا توجد مستخلصات")}</TableCell></TableRow>}
            {rows.map(b => (
              <TableRow key={b.id}>
                <TableCell className="font-mono">{b.billNumber}</TableCell>
                <TableCell>{b.billDate}</TableCell>
                <TableCell className="tabular-nums">{Number(b.grossAmount).toLocaleString()}</TableCell>
                <TableCell className="tabular-nums">{Number(b.retentionAmount).toLocaleString()}</TableCell>
                <TableCell className="tabular-nums">{Number(b.dueAmount).toLocaleString()}</TableCell>
                <TableCell className="tabular-nums font-bold">{Number(b.netAmount).toLocaleString()}</TableCell>
                <TableCell><Badge>{b.status}</Badge></TableCell>
                <TableCell className="text-end">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(b)}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => del(b.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{(editing as any)?.id ? t("contracting.bills.edit", "تعديل المستخلص") : t("contracting.bills.add", "مستخلص جديد")}</DialogTitle></DialogHeader>
          {editing && <div className="grid grid-cols-2 gap-3">
            <Field label={t("contracting.bills.number", "الرقم")} required><Input value={editing.billNumber ?? ""} onChange={e => setEditing({ ...editing, billNumber: e.target.value })} /></Field>
            <Field label={t("contracting.bills.date", "التاريخ")} required><Input type="date" value={editing.billDate ?? ""} onChange={e => setEditing({ ...editing, billDate: e.target.value })} /></Field>
            <Field label={t("contracting.bills.type", "النوع")}>
              <Select value={editing.billType ?? "interim"} onValueChange={v => setEditing({ ...editing, billType: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["interim","final","advance","retention_release"].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("contracting.bills.progress", "إنجاز %")}><Input type="number" value={editing.progressPercent ?? "0"} onChange={e => setEditing({ ...editing, progressPercent: e.target.value })} /></Field>
            <Field label={t("contracting.bills.gross", "إجمالي (ر.س)")} required><Input type="number" value={editing.grossAmount ?? "0"} onChange={e => setEditing({ ...editing, grossAmount: e.target.value })} /></Field>
            <Field label={t("contracting.bills.retentionPercent", "% محتجز")}><Input type="number" value={editing.retentionPercent ?? "10"} onChange={e => setEditing({ ...editing, retentionPercent: e.target.value })} /></Field>
            <Field label={t("contracting.bills.previousPaid", "المدفوع سابقاً")}><Input type="number" value={editing.previousPaid ?? "0"} onChange={e => setEditing({ ...editing, previousPaid: e.target.value })} /></Field>
            <Field label={t("contracting.bills.status", "الحالة")}>
              <Select value={editing.status ?? "draft"} onValueChange={v => setEditing({ ...editing, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["draft","submitted","approved","rejected","paid"].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>{t("common.cancel", "إلغاء")}</Button>
            <Button onClick={save}>{t("common.save", "حفظ")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────── RISKS TAB ───────────────────
function RisksTab({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<Risk[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<Risk> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/contracting/projects/${projectId}/risks`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) { toast({ title: e?.message, variant: "destructive" }); }
    finally { setLoading(false); }
  }, [token, projectId, toast]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!editing?.title?.trim()) { toast({ title: t("common.required", "العنوان مطلوب"), variant: "destructive" }); return; }
    try {
      const isEdit = (editing as any).id != null;
      const url = isEdit
        ? `${API}/api/contracting/risks/${(editing as any).id}`
        : `${API}/api/contracting/projects/${projectId}/risks`;
      const r = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(editing),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      setEditing(null); await load();
    } catch (e: any) { toast({ title: e?.message, variant: "destructive" }); }
  }
  async function del(id: number) {
    if (!confirm(t("common.confirmDelete", "تأكيد الحذف؟"))) return;
    await fetch(`${API}/api/contracting/risks/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    await load();
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between">
        <h3 className="font-bold">{t("contracting.risks.title", "المخاطر")} ({rows.length})</h3>
        <Button size="sm" onClick={() => setEditing({ title: "", category: "other", likelihood: "medium", impact: "medium", status: "open" })}>
          <Plus className="h-4 w-4 mx-1" /> {t("contracting.risks.add", "إضافة مخاطرة")}
        </Button>
      </div>
      <div className="rounded-lg border bg-white dark:bg-slate-900 overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t("contracting.risks.title2", "المخاطرة")}</TableHead>
            <TableHead>{t("contracting.risks.category", "التصنيف")}</TableHead>
            <TableHead>{t("contracting.risks.likelihood", "الاحتمال")}</TableHead>
            <TableHead>{t("contracting.risks.impact", "الأثر")}</TableHead>
            <TableHead>{t("contracting.risks.score", "الدرجة")}</TableHead>
            <TableHead>{t("contracting.risks.status", "الحالة")}</TableHead>
            <TableHead className="text-end">—</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {loading && rows.length === 0 && <TableRow><TableCell colSpan={7}><Skeleton className="h-16 w-full" /></TableCell></TableRow>}
            {!loading && rows.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-sm text-slate-500 py-4">{t("contracting.risks.empty", "لا توجد مخاطر")}</TableCell></TableRow>}
            {rows.map(r => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.title}{r.description && <div className="text-[11px] text-slate-500">{r.description}</div>}</TableCell>
                <TableCell><Badge variant="outline">{r.category}</Badge></TableCell>
                <TableCell>{r.likelihood}</TableCell>
                <TableCell>{r.impact}</TableCell>
                <TableCell><span className={`px-2 py-0.5 rounded-full text-xs font-bold ${r.score >= 6 ? "bg-red-100 text-red-700" : r.score >= 4 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>{r.score}</span></TableCell>
                <TableCell><Badge>{r.status}</Badge></TableCell>
                <TableCell className="text-end">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => del(r.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{(editing as any)?.id ? t("contracting.risks.edit", "تعديل مخاطرة") : t("contracting.risks.add", "إضافة مخاطرة")}</DialogTitle></DialogHeader>
          {editing && <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><Field label={t("contracting.risks.title2", "العنوان")} required><Input value={editing.title ?? ""} onChange={e => setEditing({ ...editing, title: e.target.value })} /></Field></div>
            <div className="col-span-2"><Field label={t("contracting.risks.description", "الوصف")}><Input value={editing.description ?? ""} onChange={e => setEditing({ ...editing, description: e.target.value })} /></Field></div>
            <Field label={t("contracting.risks.category", "التصنيف")}>
              <Select value={editing.category ?? "other"} onValueChange={v => setEditing({ ...editing, category: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["schedule","cost","quality","safety","environmental","contractual","other"].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("contracting.risks.status", "الحالة")}>
              <Select value={editing.status ?? "open"} onValueChange={v => setEditing({ ...editing, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["open","mitigating","resolved","accepted"].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("contracting.risks.likelihood", "الاحتمال")}>
              <Select value={editing.likelihood ?? "medium"} onValueChange={v => setEditing({ ...editing, likelihood: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["low","medium","high"].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("contracting.risks.impact", "الأثر")}>
              <Select value={editing.impact ?? "medium"} onValueChange={v => setEditing({ ...editing, impact: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["low","medium","high"].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <div className="col-span-2"><Field label={t("contracting.risks.mitigationPlan", "خطة المعالجة")}><Input value={editing.mitigationPlan ?? ""} onChange={e => setEditing({ ...editing, mitigationPlan: e.target.value })} /></Field></div>
          </div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>{t("common.cancel", "إلغاء")}</Button>
            <Button onClick={save}>{t("common.save", "حفظ")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────── EVENTS TAB ───────────────────
function EventsTab({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const [rows, setRows] = useState<Event[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${API}/api/contracting/projects/${projectId}/events`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setRows).finally(() => setLoading(false));
  }, [token, projectId]);

  return (
    <div className="rounded-lg border bg-white dark:bg-slate-900 p-4">
      <h3 className="font-bold mb-3">{t("contracting.events.title", "سجل الأحداث")} ({rows.length})</h3>
      {loading && <Skeleton className="h-32 w-full" />}
      {!loading && rows.length === 0 && <div className="text-sm text-slate-500">{t("contracting.events.empty", "لا توجد أحداث بعد")}</div>}
      <div className="space-y-1.5">
        {rows.map(e => (
          <div key={e.id} className="flex items-start gap-2 text-sm py-1.5 border-b last:border-0">
            <div className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${
              e.severity === "error" ? "bg-red-500" : e.severity === "warn" ? "bg-amber-500" : "bg-emerald-500"
            }`} />
            <div className="flex-1">
              <div className="font-medium">{e.title}</div>
              {e.description && <div className="text-[11px] text-slate-500">{e.description}</div>}
              <div className="text-[10px] text-slate-400 mt-0.5">{new Date(e.createdAt).toLocaleString("ar-SA")}</div>
            </div>
            <Badge variant="outline" className="text-[10px]">{e.eventType}</Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────── AI TAB ───────────────────
function AITab({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [analysis, setAnalysis] = useState<AIAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [downloading, setDownloading] = useState(false);

  async function analyze() {
    setAnalyzing(true);
    setAnalysis(null);
    try {
      const r = await fetch(`${API}/api/contracting-ai/analyze/${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lang: "ar" }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setAnalysis(await r.json());
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    } finally { setAnalyzing(false); }
  }

  async function downloadCsv() {
    setDownloading(true);
    try {
      const r = await fetch(`${API}/api/contracting-ai/training-csv`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `contracting-training-${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: t("contracting.ai.csvDownloaded", "تم تنزيل ملف بيانات التدريب") });
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    } finally { setDownloading(false); }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <div className="rounded-lg border bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-orange-500" />
              <h3 className="font-bold">{t("contracting.ai.analysisTitle", "تحليل ذكي للمشروع")}</h3>
            </div>
            <Button onClick={analyze} disabled={analyzing}>
              {analyzing ? <Loader2 className="h-4 w-4 animate-spin mx-1" /> : <Sparkles className="h-4 w-4 mx-1" />}
              {t("contracting.ai.runAnalysis", "تشغيل التحليل")}
            </Button>
          </div>
          {!analysis && !analyzing && (
            <div className="text-sm text-slate-500">
              {t("contracting.ai.analysisHint", "اضغط «تشغيل التحليل» لإجراء تحليل ذكي للمشروع: مخاطر التأخير، تجاوز التكاليف، والتوصيات.")}
            </div>
          )}
          {analyzing && <div className="space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-20 w-full" /></div>}
          {analysis && (() => {
            // Defensive parsing: even though the backend normalises risk levels
            // (see contracting-ai.ts ~line 310), guard against legacy/proxied
            // payloads where the field could be missing or of a different shape.
            const delayLvl: RiskLevel = (["low","medium","high"] as const).includes(analysis.delay_risk as RiskLevel) ? analysis.delay_risk : "low";
            const costLvl:  RiskLevel = (["low","medium","high"] as const).includes(analysis.cost_risk  as RiskLevel) ? analysis.cost_risk  : "low";
            const ind = analysis.indicators ?? {};
            const findings = Array.isArray(analysis.findings) ? analysis.findings : [];
            const recs     = Array.isArray(analysis.recommendations) ? analysis.recommendations : [];
            return (
              <div className="space-y-4 text-sm">
                <div>
                  <div className="text-xs font-semibold text-slate-500 mb-1">{t("contracting.ai.summary", "الملخص")}</div>
                  <div className="leading-relaxed">{analysis.summary}</div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="rounded-md border p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-xs font-semibold text-slate-500">{t("contracting.ai.delayRisk", "مخاطر التأخير")}</div>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${RISK_TONE[delayLvl]}`}>{RISK_LABEL[delayLvl]}</span>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      SPI: {ind.schedulePerformanceIndex != null ? Number(ind.schedulePerformanceIndex).toFixed(2) : "—"}
                      {ind.actualProgress != null && ind.expectedProgress != null && (
                        <> • {t("contracting.ai.actualVsExpected", "فعلي/متوقع")}: {Number(ind.actualProgress).toFixed(1)}% / {Number(ind.expectedProgress).toFixed(1)}%</>
                      )}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-xs font-semibold text-slate-500">{t("contracting.ai.costRisk", "مخاطر تجاوز التكاليف")}</div>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${RISK_TONE[costLvl]}`}>{RISK_LABEL[costLvl]}</span>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {t("contracting.ai.costOverrun", "تجاوز التكلفة")}: {Number(ind.costOverrun ?? 0).toLocaleString()} ر.س
                      {ind.projectedFinalCost != null && (
                        <> • {t("contracting.ai.projectedFinalCost", "متوقع عند الإكمال")}: {Number(ind.projectedFinalCost).toLocaleString()} ر.س</>
                      )}
                    </div>
                  </div>
                </div>

                {findings.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-slate-500 mb-1">{t("contracting.ai.findings", "النتائج الرئيسية")}</div>
                    <ul className="list-disc ps-5 space-y-1">
                      {findings.map((f, i) => <li key={i} className="leading-relaxed">{f}</li>)}
                    </ul>
                  </div>
                )}

                {recs.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-slate-500 mb-1">{t("contracting.ai.recommendations", "التوصيات")}</div>
                    <ul className="list-disc ps-5 space-y-1">
                      {recs.map((r, i) => <li key={i} className="leading-relaxed">{r}</li>)}
                    </ul>
                  </div>
                )}

                <div className="text-[10px] text-slate-400 italic">
                  {analysis.source === "ai" ? t("contracting.ai.poweredAi", "مدعوم بالذكاء الاصطناعي") : t("contracting.ai.poweredLocal", "تحليل قائم على القواعد المحلية")}
                </div>
              </div>
            );
          })()}
        </div>

        <div className="rounded-lg border bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
              <h3 className="font-bold">{t("contracting.ai.trainingCsv", "بيانات التدريب (CSV)")}</h3>
            </div>
            <Button onClick={downloadCsv} disabled={downloading} variant="outline">
              {downloading ? <Loader2 className="h-4 w-4 animate-spin mx-1" /> : <Download className="h-4 w-4 mx-1" />}
              {t("contracting.ai.downloadCsv", "تنزيل CSV")}
            </Button>
          </div>
          <p className="text-sm text-slate-500 leading-relaxed">
            {t("contracting.ai.trainingCsvDesc", "يصدّر هذا الزر ملف CSV يحتوي على بيانات المشاريع التاريخية (المدد المخططة/الفعلية، التكاليف، نسب الإنجاز، عدد المخاطر) — يمكن استخدامه لتدريب نماذج تعلّم آلي للتنبؤ بالتأخير وتجاوز التكاليف لشركتك.")}
          </p>
        </div>
      </div>

      <ContractingAIAssistant screenContext="contracting.project.detail" projectId={projectId} currentAction="reviewing project" />
    </div>
  );
}
