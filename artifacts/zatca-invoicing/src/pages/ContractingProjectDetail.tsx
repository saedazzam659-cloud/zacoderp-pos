import { saveBlob } from "@/lib/saveFile";
import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useRoute, useSearch } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { usePermission } from "@/hooks/usePermission";
import {
  ArrowLeft, Briefcase, Plus, Pencil, Trash2, Sparkles, Download,
  TrendingUp, Wallet, Activity, AlertTriangle, FileSpreadsheet, Loader2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { eligibleContractors, withHistoricalParty } from "@/lib/partyEligibility";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import ContractingAIAssistant from "@/components/ContractingAIAssistant";
import ContractingAccountingPanel from "@/components/ContractingAccountingPanel";
import ContractingCostAllocations from "@/components/ContractingCostAllocations";
import ContractingGuaranteesPanel from "@/components/ContractingGuaranteesPanel";
import ExecutionPlanningPanel from "@/components/ExecutionPlanningPanel";
import ContractingBillDetailEditor from "@/components/ContractingBillDetailEditor";
import ContractingContractBoqEditor, { type PendingContractBoqLine } from "@/components/ContractingContractBoqEditor";
import { ContractingArchiveAction } from "@/components/ContractingArchiveAction";
import ContractingProjectScope from "@/components/ContractingProjectScope";
import ContractingAdvanceRecoveryFields, { type AdvanceRecoveryPolicy } from "@/components/ContractingAdvanceRecoveryFields";
import ContractingAdvanceRecoverySummary, { type RecoveryOverride } from "@/components/ContractingAdvanceRecoverySummary";
import ContractingDraftExecution, { emptyDraftExecution, draftExecutionScope, type DraftExecutionState } from "@/components/ContractingDraftExecution";
import { ContractingProjectReports } from "@/components/ContractingProjectReports";
import { executionEstimate, executionInput, executionPayload, executionValidation, type ExecutionInputs } from "@/lib/contractingExecution";
import {
  ContractingBillExportActions,
  ContractingContractsExportActions,
  ContractingProjectExportActions,
} from "@/components/ContractingExportActions";
import type { ContractingContractSnapshot } from "@/lib/contractingPrintExport";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { useCostCenters, type CostCenter } from "@/hooks/useCostCenters";
import { DateField } from "@/components/ui/date-field";
import { useDemoActionGate } from "@/hooks/use-demo-action-gate";
import {
  retryableCreateAttempt,
  shouldRetainCreateAttemptAfterFailure,
  type RetryableCreateAttempt,
} from "@/lib/contractingSaveRetry";
import {
  BILL_STATUS_LABEL,
  BILL_TYPE_LABEL,
  CONTRACT_STATUS_LABEL,
  CONTRACT_TYPE_LABEL,
  EVENT_SEVERITY_LABEL,
  EVENT_TYPE_LABEL,
  PROJECT_STATUS_LABEL,
  PROJECT_TYPE_LABEL,
  RISK_CATEGORY_LABEL,
  RISK_LEVEL_LABEL,
  RISK_STATUS_LABEL,
  labelEnum,
} from "@/lib/contractingLabels";

const API = import.meta.env.VITE_API_URL || "";

type Project = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  parentId: number | null;
  branchId: number | null;
  clientName: string | null; location: string | null; projectType: string;
  costCenterId: number | null;
  status: string; contractValue: string; plannedBudget: string; actualCost: string;
  plannedStartDate: string | null; plannedEndDate: string | null;
  progressPercent: string; description: string | null;
};
type ProjectBranch = { id: number; code: string; nameAr: string; nameEn: string | null };
type IntegrityDiagnostics = {
  deferredValidation: boolean;
  offendingIds: Record<string, number[]>;
};
type Bill = AdvanceRecoveryPolicy & Partial<RecoveryOverride> & {
  id: number; billNumber: string; billType: string; billDate: string;
  direction: "outgoing" | "incoming";
  contractorId: number | null;
  ownerContractId: number | null;
  subcontractorContractId: number | null;
  fromDate: string | null; toDate: string | null; progressPercent: string;
  grossAmount: string; retentionPercent: string; retentionAmount: string;
  previousPaid: string; dueAmount: string; vatAmount: string; netAmount: string;
  paidAmount: string;
  costCenterId: number | null;
  reversalJournalEntryId?: number | null;
  journalEntryId?: number | null;
  aggregateProgress?: boolean;
  status: string; notes: string | null;
};
type OwnerContract = AdvanceRecoveryPolicy & {
  id: number; projectId: number; customerId: number | null; clientName: string | null;
  contractNumber: string; contractDate: string; signedAt: string | null;
  contractType: string; parentContractId: number | null;
  value: string; advancePayment: string; advancePercent: string;
  retentionPercent: string; vatPercent: string;
  retentionEnabled?: boolean; retentionCapPercent?: string | null;
  durationDays: number; startDate: string | null; endDate: string | null;
  paymentTerms: string | null; scopeOfWork: string | null; penaltiesClause: string | null;
  status: string; notes: string | null;
};
type SubContract = AdvanceRecoveryPolicy & {
  id: number; projectId: number; contractorId: number;
  contractNumber: string; contractDate: string; signedAt: string | null;
  scopeOfWork: string | null;
  value: string; advancePayment: string; advancePercent: string;
  retentionPercent: string; vatPercent: string;
  retentionEnabled?: boolean; retentionCapPercent?: string | null;
  durationDays: number; startDate: string | null; endDate: string | null;
  paymentTerms: string | null; penaltiesClause: string | null;
  status: string; notes: string | null;
};
type Contractor = {
  id: number; name: string; specialty: string; phone: string | null; status: string; supplierId: number | null;
  supplierPartyClassification?: string | null;
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

const STATUS_LABEL = PROJECT_STATUS_LABEL;

function calculateAdvancePayment(value: unknown, percent: unknown): string {
  const contractValue = Number(value);
  const advancePercent = Number(percent);
  if (!Number.isFinite(contractValue) || !Number.isFinite(advancePercent)) return "0";
  return String(Math.round((contractValue * advancePercent / 100 + Number.EPSILON) * 100) / 100);
}

type BillDirection = "outgoing" | "incoming";

function parseProjectDetailQuery(search: string): {
  tab: string;
  billDirection: BillDirection;
  createBill: boolean;
} {
  const params = new URLSearchParams(search);
  const rawDirection = params.get("direction") ?? params.get("billDirection");
  return {
    // Only known tabs are accepted from the URL. The create-bill shortcut
    // uses the bills tab; all other values retain the normal overview start.
    tab: params.get("tab") === "bills" ? "bills" : params.get("tab") === "guarantees" ? "guarantees" : "overview",
    billDirection: rawDirection === "incoming" ? "incoming" : "outgoing",
    createBill: params.get("createBill") === "1",
  };
}

export default function ContractingProjectDetail() {
    const gate = useDemoActionGate();
  const { t } = useTranslation();
  const [, params] = useRoute("/contracting/projects/:id");
  const search = useSearch();
  const projectId = Number(params?.id);
  const { token, user, actingCompanyId } = useAuth() as any;
  const { toast } = useToast();
  const routeQuery = parseProjectDetailQuery(search);
  const [project, setProject] = useState<Project | null>(null);
  const [projectBranches, setProjectBranches] = useState<ProjectBranch[]>([]);
  const [projectOptions, setProjectOptions] = useState<Project[]>([]);
  const [integrityDiagnostics, setIntegrityDiagnostics] = useState<IntegrityDiagnostics | null>(null);
  const [tab, setTab] = useState(routeQuery.tab);

  const loadProject = useCallback(async () => {
    if (!token || !projectId) return;
    try {
      const r = await fetch(`${API}/api/contracting/projects/${projectId}`, {
         headers: { Authorization: `Bearer ${token}`, ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}) },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setProject(await r.json());
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    }
   }, [token, actingCompanyId, projectId, t, toast]);

  useEffect(() => { void loadProject(); }, [loadProject]);
  useEffect(() => {
    if (!token) return;
    void fetch(`${API}/api/contracting/projects/options`, {
       headers: { Authorization: `Bearer ${token}`, ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}) },
    }).then(async response => {
      if (!response.ok) return;
      const payload = await response.json();
      if (Array.isArray(payload?.branches)) setProjectBranches(payload.branches);
      if (Array.isArray(payload?.projects)) setProjectOptions(payload.projects);
      setIntegrityDiagnostics(payload?.integrityDiagnostics?.deferredValidation
        ? payload.integrityDiagnostics
        : null);
    }).catch(() => undefined);
   }, [token, actingCompanyId]);
  useEffect(() => { setTab(routeQuery.tab); }, [routeQuery.tab]);

  const fmt = (n: string | number) => Number(n || 0).toLocaleString("en-US");

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
            {project.code} • {labelEnum(STATUS_LABEL, project.status)}
            {project.location && ` • ${project.location}`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ContractingArchiveAction
            entityType="project"
            entityId={project.id}
            companyName={user?.company?.nameAr || user?.company?.nameEn}
          />
          <ContractingProjectExportActions
            project={{
              ...project,
              branchName: project.branchId == null
                ? null
                : projectBranches.find(branch => branch.id === project.branchId)?.nameAr || `#${project.branchId}`,
            }}
          />
          <Badge variant={project.status === "completed" ? "secondary" : project.status === "cancelled" ? "destructive" : "default"}>
            {labelEnum(STATUS_LABEL, project.status)}
          </Badge>
        </div>
      </div>

      {(project.parentId != null || projectOptions.some(item => item.parentId === project.id)) && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 text-sm dark:border-indigo-900 dark:bg-indigo-950/20">
          {project.parentId != null && (
            <div>
              <span className="text-muted-foreground">{t("contracting.projects.parentProject", "المشروع الأب")}: </span>
              <Link href={`/contracting/projects/${project.parentId}`} className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300">
                {projectOptions.find(item => item.id === project.parentId)?.nameAr || `#${project.parentId}`}
              </Link>
            </div>
          )}
          {projectOptions.some(item => item.parentId === project.id) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{t("contracting.projects.children", "المشاريع الفرعية")}:</span>
              {projectOptions.filter(item => item.parentId === project.id).map(child => (
                <Link key={child.id} href={`/contracting/projects/${child.id}`} className="rounded border border-indigo-200 bg-white px-2 py-1 font-medium text-indigo-700 hover:underline dark:bg-slate-900 dark:text-indigo-300">
                  {child.code} — {child.nameAr}
                </Link>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{t("contracting.projects.independentAccounting", "لكل مشروع فرعي عقوده ومستخلصاته وتكاليفه المستقلة.")}</p>
        </div>
      )}

      {integrityDiagnostics?.deferredValidation && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100" data-testid="contracting-integrity-warning">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-bold">{t("contracting.projects.deferredIntegrityTitle", "توجد مستخلصات قديمة بلا عقد مرتبط")}</p>
              <p>{t("contracting.projects.deferredIntegrityHelp", "أنشئ أو اختر العقد الصحيح لهذا المشروع أولاً، ثم افتح المستخلص القديم وعدّله لاختيار العقد. لا يتم إنشاء ربط تلقائي أو تخمينه.")}</p>
              <p className="font-mono text-xs">
                {Object.entries(integrityDiagnostics.offendingIds ?? {})
                  .filter(([, ids]) => Array.isArray(ids) && ids.length > 0)
                  .map(([kind, ids]) => `${kind}: ${ids.join(", ")}`)
                  .join(" · ")}
              </p>
              <Button size="sm" variant="outline" onClick={() => setTab("bills")} data-testid="button-open-project-bills-integrity">
                {t("contracting.projects.openProjectBillsToRepair", "فتح مستخلصات المشروع وربط العقد")}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap w-full h-auto gap-1 justify-start">
          <TabsTrigger value="overview">{t("contracting.tabs.overview", "نظرة عامة")}</TabsTrigger>
          <TabsTrigger value="owner-contract">{t("contracting.tabs.ownerContract", "عقد المالك")}</TabsTrigger>
          <TabsTrigger value="sub-contracts">{t("contracting.tabs.subContracts", "عقود الباطن")}</TabsTrigger>
          <TabsTrigger value="work-items">{t("contracting.tabs.workItems", "بنود التنفيذ")}</TabsTrigger>
          <TabsTrigger value="resources">{t("contracting.tabs.resources", "الموارد")}</TabsTrigger>
          <TabsTrigger value="bills">{t("contracting.tabs.bills", "المستخلصات")}</TabsTrigger>
          <TabsTrigger value="accounting">{t("contracting.tabs.accounting", "المحاسبة والتسويات")}</TabsTrigger>
          <TabsTrigger value="guarantees">{t("contracting.tabs.guarantees", "الضمانات والمناقصات")}</TabsTrigger>
          <TabsTrigger value="reports">{t("contracting.tabs.reports", "التقارير")}</TabsTrigger>
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
             <Meta
               label={t("contracting.projects.branch", "الفرع")}
               value={project.branchId == null
                 ? "—"
                 : projectBranches.find(branch => branch.id === project.branchId)?.nameAr || `#${project.branchId}`}
             />
            <Meta label={t("contracting.projects.type", "نوع المشروع")} value={labelEnum(PROJECT_TYPE_LABEL, project.projectType)} />
            <Meta label={t("contracting.projects.plannedStartDate", "تاريخ البداية المخطط")} value={project.plannedStartDate || "—"} />
            <Meta label={t("contracting.projects.plannedEndDate", "تاريخ النهاية المخطط")} value={project.plannedEndDate || "—"} />
            {project.description && (
              <div className="md:col-span-2">
                <Meta label={t("contracting.projects.description", "الوصف")} value={project.description} />
              </div>
            )}
          </div>
          <ContractingProjectReports projectId={projectId} mode="dashboard" />
        </TabsContent>

        <TabsContent value="owner-contract" className="mt-4"><OwnerContractTab projectId={projectId} project={project} /></TabsContent>
        <TabsContent value="sub-contracts"  className="mt-4"><SubContractsTab  projectId={projectId} project={project} /></TabsContent>
        <TabsContent value="work-items" className="mt-4 space-y-3">
          <ContractingProjectScope projectId={projectId} projectName={project.nameAr} projectCode={project.code} />
          <ExecutionPlanningPanel key={`${projectId}:work-items`} projectId={projectId} section="work-items" onChange={loadProject} />
        </TabsContent>
        <TabsContent value="resources" className="mt-4">
          <ExecutionPlanningPanel key={`${projectId}:resources`} projectId={projectId} section="resources" onChange={loadProject} />
        </TabsContent>
        <TabsContent value="bills" className="mt-4">
          <BillsTab
            projectId={projectId}
            project={project}
            projectCostCenterId={project?.costCenterId ?? null}
            initialDirection={routeQuery.billDirection}
            autoOpen={routeQuery.createBill}
          />
        </TabsContent>
        <TabsContent value="accounting" className="mt-4 space-y-4">
          <ContractingAccountingPanel projectId={projectId} />
          <ContractingCostAllocations projectId={projectId} />
        </TabsContent>
        <TabsContent value="guarantees" className="mt-4">
          <ContractingGuaranteesPanel projectId={projectId} />
        </TabsContent>
        <TabsContent value="reports" className="mt-4"><ContractingProjectReports projectId={projectId} mode="hub" /></TabsContent>
        <TabsContent value="risks"      className="mt-4"><RisksTab     projectId={projectId} /></TabsContent>
        <TabsContent value="events"     className="mt-4"><EventsTab    projectId={projectId} /></TabsContent>
        <TabsContent value="ai"         className="mt-4"><AITab        projectId={projectId} /></TabsContent>
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
function ProjectContext({ project }: { project: Project }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900/60">
      <span className="text-xs text-slate-500">{t("contracting.projectContext.label", "المشروع الحالي")}</span>
      <div className="font-medium">{project.nameAr}</div>
      <div className="font-mono text-xs text-slate-500">{project.code}</div>
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

// ─────────────────── BILLS TAB ───────────────────
function aggregateMoney(value: number): string {
  return (Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100).toFixed(2);
}

function selectedAggregateContractValue(
  direction: BillDirection,
  bill: Partial<Bill> | null,
  ownerContracts: OwnerContract[],
  subContracts: SubContract[],
): number {
  if (!bill) return 0;
  if (direction === "incoming") {
    return Number(subContracts.find(c => c.id === Number(bill.subcontractorContractId))?.value ?? 0);
  }
  const selected = ownerContracts.find(c => c.id === Number(bill.ownerContractId));
  if (!selected) return 0;
  const base = ["change_order", "addendum"].includes(selected.contractType)
    ? ownerContracts.find(c => c.id === selected.parentContractId) ?? selected
    : selected;
  return Number(base.value || 0) + ownerContracts
    .filter(c =>
      ["change_order", "addendum"].includes(c.contractType)
      && c.status === "approved"
      && c.parentContractId === base.id,
    )
    .reduce((sum, c) => sum + Number(c.value || 0), 0);
}

function selectedPriorCertifiedGross(rows: Bill[], direction: BillDirection, bill: Partial<Bill> | null): number {
  if (!bill) return 0;
  const contractId = direction === "incoming" ? bill.subcontractorContractId : bill.ownerContractId;
  if (contractId == null) return 0;
  const currentId = (bill as any).id == null ? null : Number((bill as any).id);
  return rows.filter(row =>
    row.direction === direction
    && (direction === "incoming"
      ? Number(row.subcontractorContractId) === Number(contractId)
      : Number(row.ownerContractId) === Number(contractId))
    && ["approved", "posted", "partially_paid", "paid"].includes(String(row.status))
    && row.reversalJournalEntryId == null
    && (currentId == null || row.id !== currentId),
  ).reduce((max, row) => Math.max(max, Number(row.grossAmount || 0)), 0);
}

function BillsTab({
  projectId,
  project,
  projectCostCenterId,
  initialDirection = "outgoing",
  autoOpen = false,
}: {
  projectId: number;
  project: Project;
  projectCostCenterId: number | null;
  initialDirection?: BillDirection;
  autoOpen?: boolean;
}) {
  const { t } = useTranslation();
  const { token, user, actingCompanyId } = useAuth() as any;
  const { toast } = useToast();
  const canCreate = usePermission("contracting", "create");
  const routeSearch = useSearch();
  const [, navigate] = useLocation();
  const [direction, setDirection] = useState<BillDirection>(initialDirection);
  const [rows, setRows] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<Bill> | null>(null);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const [draftExecution, setDraftExecution] = useState<DraftExecutionState>(emptyDraftExecution);
  const [recoveredExecution, setRecoveredExecution] = useState<{ billId: number; values: ExecutionInputs } | null>(null);
  const [detailsRevision, setDetailsRevision] = useState(0);
  const [billOptionsLoaded, setBillOptionsLoaded] = useState(false);
  const autoOpenAttempted = useRef(false);
  const createAttempt = useRef<RetryableCreateAttempt | null>(null);
  // Peek the next bill-number from the central sequence engine while a NEW
  // bill is being created (id is still nullish).
  const isCreatingBill = !!editing && (editing as any).id == null;
  const newExecutionMode = isCreatingBill && ["interim", "final"].includes(editing?.billType ?? "interim");
  const draftContractId = (direction === "incoming" ? editing?.subcontractorContractId : editing?.ownerContractId) ?? null;
  const expectedExecutionScope = draftExecutionScope(projectId, direction, draftContractId, editing?.billDate ?? "");
  const nextBillCode = useNextSequenceNumber("contracting_bill", isCreatingBill);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [ownerContracts, setOwnerContracts] = useState<OwnerContract[]>([]);
  const [subContracts,   setSubContracts]   = useState<SubContract[]>([]);
  const [detailLineCount, setDetailLineCount] = useState<number | null>(null);
  const companyId = actingCompanyId ?? user?.companyId ?? user?.company?.id ?? null;
  const { data: costCenters = [], isLoading: costCentersLoading } = useCostCenters({
    companyId,
    includeInactive: true,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/contracting/projects/${projectId}/bills?direction=${direction}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) { toast({ title: e?.message, variant: "destructive" }); }
    finally { setLoading(false); }
  }, [token, projectId, direction, toast]);
  useEffect(() => { void load(); }, [load]);

  const editingBillId = editing && (editing as any).id != null ? Number((editing as any).id) : null;
  useEffect(() => {
    setDetailLineCount(null);
    if (!editingBillId) return;
    let active = true;
    void fetch(`${API}/api/contracting/bills/${editingBillId}/details`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(async response => {
      if (!response.ok) return;
      const detail = await response.json();
      if (active) setDetailLineCount(Array.isArray(detail?.lines) ? detail.lines.length : 0);
    }).catch(() => {
      // Keep the percentage control disabled until the authoritative detail
      // endpoint has answered; never invent a line mode in the UI.
    });
    return () => { active = false; };
  }, [editingBillId, token]);

  // Auxiliary loads (contractors, contracts) — needed for the dialog form
  // dropdowns. Pulled lazily once on mount (rarely changes).
  useEffect(() => {
    if (!token) return;
    setBillOptionsLoaded(false);
    void (async () => {
      try {
        const [c, oc, sc] = await Promise.all([
          fetch(`${API}/api/contracting/contractors`,                          { headers: { Authorization: `Bearer ${token}` } }).then(r => r.ok ? r.json() : []),
          fetch(`${API}/api/contracting/projects/${projectId}/owner-contracts`,{ headers: { Authorization: `Bearer ${token}` } }).then(r => r.ok ? r.json() : []),
          fetch(`${API}/api/contracting/projects/${projectId}/sub-contracts`,  { headers: { Authorization: `Bearer ${token}` } }).then(r => r.ok ? r.json() : []),
        ]);
        setContractors(c); setOwnerContracts(oc); setSubContracts(sc);
      } catch { /* non-fatal — form still works without auto-fill */ }
      finally { setBillOptionsLoaded(true); }
    })();
  }, [token, projectId]);

  async function save() {
    if (saveLock.current) return;
    if (!editing || saving) return;
    if (!editing?.billDate) { toast({ title: t("contracting.bills.dateRequired", "التاريخ مطلوب"), variant: "destructive" }); return; }
    if (direction === "incoming" && !editing.contractorId) {
      toast({ title: t("contracting.bills.contractorRequired", "يجب اختيار المقاول الباطن"), variant: "destructive" }); return;
    }
    if (direction === "outgoing" && !editing.ownerContractId) {
      toast({ title: t("contracting.bills.ownerContractRequired", "يجب اختيار عقد المالك المرتبط بهذا المشروع"), variant: "destructive" }); return;
    }
    if (direction === "incoming" && !editing.subcontractorContractId) {
      toast({ title: t("contracting.bills.subcontractRequired", "يجب اختيار عقد الباطن المرتبط بالمشروع والمقاول"), variant: "destructive" }); return;
    }
    const isEdit = (editing as any).id != null;
    const executionRows = newExecutionMode ? executionPayload(draftExecution.lines, draftExecution.values) : null;
    if (newExecutionMode) {
      if (draftExecution.scope !== expectedExecutionScope || draftExecution.loading || draftExecution.error) {
        toast({ title: "انتظر تحميل بنود العقد بنجاح قبل الحفظ", variant: "destructive" }); return;
      }
      if (!executionRows?.length) {
        toast({ title: "أضف بنود العقد المرتبطة ببنود التنفيذ أولًا", variant: "destructive" }); return;
      }
      const validation = executionValidation(draftExecution.lines, draftExecution.values);
      if (validation) { toast({ title: validation, variant: "destructive" }); return; }
    }
    const payload: Record<string, unknown> = { ...editing, direction };
    // Contract policy and posting snapshots are server-owned. Only an explicit
    // authorized exception on a new draft is submitted from this form.
    for (const field of Object.keys(payload)) {
      if (field.startsWith("advanceRecovery")
        && (isEdit || !["advanceRecoveryOverrideAmount", "advanceRecoveryOverrideReason"].includes(field))) delete payload[field];
    }
    if (newExecutionMode) {
      // Persist a zero-value draft header, then save the authoritative lines.
      // Never use aggregate progress to overwrite detailed certification.
      Object.assign(payload, { grossAmount: "0", progressPercent: "0", aggregateProgress: false, previousPaid: "0" });
    }
    // Settlement posting owns the read-only paid amount.
    if (isEdit) delete payload.paidAmount;
    if (isEdit && detailLineCount != null && detailLineCount > 0) {
      for (const field of ["grossAmount", "progressPercent", "aggregateProgress", "previousPaid", "dueAmount", "vatAmount", "netAmount", "retentionAmount"]) delete payload[field];
    }
    const attempt = isEdit ? null : retryableCreateAttempt(payload, createAttempt.current);
    if (attempt) createAttempt.current = attempt;
    saveLock.current = true;
    let persistedId: number | null = null;
    try {
      const url = isEdit
        ? `${API}/api/contracting/bills/${(editing as any).id}`
        : `${API}/api/contracting/projects/${projectId}/bills`;
      if (attempt) payload.idempotencyKey = attempt.idempotencyKey;
      setSaving(true);
      const r = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(attempt ? { "Idempotency-Key": attempt.idempotencyKey } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const responseMayBeLost = !isEdit && shouldRetainCreateAttemptAfterFailure(r.status);
        if (!responseMayBeLost) createAttempt.current = null;
        const data = await r.json().catch(() => ({}));
        throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { responseMayBeLost });
      }
      const savedBill = await r.json();
      if (!isEdit && (!Number.isInteger(savedBill.id) || savedBill.id <= 0)) throw new Error("استجابة حفظ المستخلص لا تحتوي على رقم صالح");
      persistedId = Number(savedBill.id);
      createAttempt.current = null;
      if (newExecutionMode && executionRows) {
        // Capture the ID immediately: a failed details request must never
        // repeat POST /bills and create a second header on retry.
        setRecoveredExecution({ billId: persistedId, values: draftExecution.values });
        setEditing(savedBill);
        const detailsResponse = await fetch(`${API}/api/contracting/bills/${persistedId}/lines`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ lines: executionRows }),
        });
        if (!detailsResponse.ok) {
          const body = await detailsResponse.json().catch(() => ({}));
          throw new Error(`حُفظت المسودة، لكن تعذر حفظ التنفيذ والاعتماد: ${body.error || detailsResponse.status}. بيانات البنود باقية بالأسفل لإعادة حفظها.`);
        }
        setRecoveredExecution(null);
        setDetailsRevision(value => value + 1);
        toast({ title: "تم حفظ التنفيذ والاعتماد في المسودة", description: "راجع الإجماليات والتسويات بالأسفل قبل الاعتماد المالي." });
      } else {
        setEditing(null);
      }
      await load();
    } catch (e: any) {
      const responseMayBeLost = !isEdit && persistedId == null && (
        e?.responseMayBeLost === true || shouldRetainCreateAttemptAfterFailure(undefined, e)
      );
      toast({
        title: responseMayBeLost ? "تعذر التحقق من حفظ المستخلص" : e?.message || "تعذر حفظ المستخلص",
        description: responseMayBeLost
          ? "قد يكون الحفظ قد تم. أعد الضغط على «حفظ البيانات الأساسية» دون تغيير البيانات؛ لن ينشئ ذلك مستخلصاً مكرراً."
          : undefined,
        variant: "destructive",
      });
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  async function del(id: number) {
    if (!confirm(t("common.confirmDelete", "تأكيد الحذف؟"))) return;
    await fetch(`${API}/api/contracting/bills/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    await load();
  }

  // When opening the "add new" form, prefill retention from the most
  // recent active contract on the relevant side (saves typing for the
  // common case where retention% is identical across all bills).
  function openNew() {
    if (saveLock.current) return;
    setDraftExecution(emptyDraftExecution);
    setRecoveredExecution(null);
    createAttempt.current = null;
    const today = new Date().toISOString().slice(0,10);
    let retention = "10";
    let ownerContractId: number | null = null;
    let subcontractorContractId: number | null = null;
    if (direction === "outgoing") {
      const latest = ownerContracts.find(c => c.status === "active") ?? ownerContracts[0];
      if (latest) {
        retention = latest.retentionPercent;
        // A single project contract is unambiguous; never silently pick a
        // contract when the project has multiple owner contracts.
        if (ownerContracts.length === 1) ownerContractId = latest.id;
      }
    } else {
      // For incoming we don't preselect — user picks contractor first.
    }
    setEditing({
      billNumber: "", billType: "interim", billDate: today,
      progressPercent: "0", grossAmount: "0", retentionPercent: retention,
      previousPaid: "0", paidAmount: "0", status: "draft",
      ownerContractId, subcontractorContractId,
      contractorId: null,
      costCenterId: projectCostCenterId,
      aggregateProgress: false,
    });
  }

  useEffect(() => {
    if (!autoOpen || autoOpenAttempted.current || !billOptionsLoaded) return;
    autoOpenAttempted.current = true;
    if (canCreate) openNew();

    // Consume the one-shot command after starting the existing inline form.
    // Keeping tab/direction in the URL preserves the user's context while
    // preventing a remount or refresh from creating a second draft form.
    const params = new URLSearchParams(routeSearch);
    params.delete("createBill");
    const nextSearch = params.toString();
    navigate(
      `/contracting/projects/${projectId}${nextSearch ? `?${nextSearch}` : ""}`,
      { replace: true },
    );
  }, [autoOpen, billOptionsLoaded, canCreate, navigate, projectId, routeSearch]);

  // Quick totals for the header (helps SuperAdmins see exposure at a glance)
  const totals = rows.reduce((acc, b) => {
    acc.gross += Number(b.grossAmount); acc.due += Number(b.dueAmount);
    acc.net   += Number(b.netAmount);   acc.paid += Number(b.paidAmount);
    return acc;
  }, { gross: 0, due: 0, net: 0, paid: 0 });

  // Sub-contract auto-fill: when contractor is picked in incoming bill,
  // narrow to that contractor's contracts on this project and pick latest.
  function onContractorChange(cid: number | null) {
    let retention = editing?.retentionPercent ?? "10";
    let scId: number | null = null;
    if (cid) {
      const matches = subContracts.filter(s => s.contractorId === cid).sort((a,b)=>b.id-a.id);
      const match = matches[0];
      if (match) {
        retention = match.retentionPercent;
        // A single contract is safe to default; multiple contracts require
        // an explicit user selection below.
        if (matches.length === 1) scId = match.id;
      }
    }
    const next: Partial<Bill> = {
      ...editing,
      contractorId: cid,
      retentionPercent: retention,
      subcontractorContractId: scId,
      advanceRecoveryOverrideAmount: undefined,
      advanceRecoveryOverrideReason: undefined,
    };
    if (scId) {
      const percent = Number(editing?.progressPercent ?? 0);
      const value = selectedAggregateContractValue(direction, next, ownerContracts, subContracts);
      next.grossAmount = aggregateMoney(value * (Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0) / 100);
      next.aggregateProgress = true;
    }
    setEditing(next);
  }

  const selectedSubContracts = editing?.contractorId
    ? subContracts.filter(contract => contract.contractorId === Number(editing.contractorId))
    : [];
  const aggregateContractSelected = direction === "outgoing"
    ? editing?.ownerContractId != null
    : editing?.subcontractorContractId != null;
  const adjustedContractValue = selectedAggregateContractValue(direction, editing, ownerContracts, subContracts);
  const priorCertifiedGross = selectedPriorCertifiedGross(rows, direction, editing);
  const draftCertifiedCurrent = draftExecution.scope === expectedExecutionScope
    ? draftExecution.lines.reduce((total, row) => total + executionEstimate(row, draftExecution.values[row.boqLineId!] ?? executionInput(row)).certifiedTotal, 0)
    : 0;
  const cumulativeGross = newExecutionMode ? priorCertifiedGross + draftCertifiedCurrent : Number(editing?.grossAmount ?? 0);
  const currentPeriodGross = newExecutionMode ? draftCertifiedCurrent : Math.max(0, cumulativeGross - priorCertifiedGross);
  const selectedContract = direction === "incoming"
    ? subContracts.find(contract => contract.id === Number(editing?.subcontractorContractId))
    : ownerContracts.find(contract => contract.id === Number(editing?.ownerContractId));
  const priorRetained = rows.filter(row =>
    row.id !== editingBillId
    && row.direction === direction
    && ["approved", "posted", "partially_paid", "paid"].includes(row.status)
    && row.reversalJournalEntryId == null
    && (direction === "incoming"
      ? row.subcontractorContractId === editing?.subcontractorContractId
      : row.ownerContractId === editing?.ownerContractId),
  ).reduce((sum, row) => sum + Number(row.retentionAmount || 0), 0);
  // Display-only draft estimate. Saving/approval still re-derives these
  // amounts on the server under the contract lock.
  const retentionRequested = selectedContract?.retentionEnabled === false
    ? 0 : Number(aggregateMoney(cumulativeGross * Number(editing?.retentionPercent ?? selectedContract?.retentionPercent ?? 0) / 100));
  const retentionCeiling = selectedContract?.retentionCapPercent == null
    ? Infinity : Number(aggregateMoney(adjustedContractValue * Number(selectedContract.retentionCapPercent) / 100));
  const previewRetention = Math.max(0, Math.min(retentionRequested, retentionCeiling) - priorRetained);
  const previewDue = Math.max(0, currentPeriodGross - previewRetention);
  const previewVat = Number(aggregateMoney(previewDue * Number(selectedContract?.vatPercent ?? 0) / 100));
  const financiallyLocked = Boolean(
    editing && (
      ["approved", "posted", "partially_paid", "paid", "reversed"].includes(String(editing.status))
      || (editing.journalEntryId && !editing.reversalJournalEntryId)
    ),
  );
  const detailMode = detailLineCount != null && detailLineCount > 0;
  const aggregatePercentDisabled = financiallyLocked || Boolean(editingBillId && (detailLineCount == null || detailMode));

  function updateAggregateProgress(value: string) {
    if (!editing) return;
    const parsed = Number(value);
    const percent = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
    setEditing({
      ...editing,
      progressPercent: value,
      grossAmount: aggregateContractSelected
        ? aggregateMoney(adjustedContractValue * percent / 100)
        : editing.grossAmount,
      aggregateProgress: aggregateContractSelected,
    });
  }

  function updateAggregateContract(next: Partial<Bill>) {
    if (!editing) return;
    const nextValue = selectedAggregateContractValue(direction, { ...editing, ...next }, ownerContracts, subContracts);
    const percent = Number(editing.progressPercent ?? 0);
    setEditing({
      ...editing,
      ...next,
      advanceRecoveryOverrideAmount: undefined,
      advanceRecoveryOverrideReason: undefined,
      grossAmount: nextValue > 0
        ? aggregateMoney(nextValue * Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0)) / 100)
        : editing.grossAmount,
      aggregateProgress: nextValue > 0,
    });
    setDraftExecution(emptyDraftExecution);
    setRecoveredExecution(null);
  }

  return (
    <div className="space-y-3">
      <Tabs value={direction} onValueChange={v => {
        setDirection(v as BillDirection);
        setEditing(null);
        setDraftExecution(emptyDraftExecution);
        setRecoveredExecution(null);
        createAttempt.current = null;
      }}>
        <TabsList className="grid grid-cols-2 w-full max-w-md">
          <TabsTrigger value="outgoing">{t("contracting.bills.outgoing", "للمالك (صادر)")}</TabsTrigger>
          <TabsTrigger value="incoming">{t("contracting.bills.incoming", "من الباطن (وارد)")}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <div className="rounded-md border p-2 bg-white dark:bg-slate-900"><div className="text-slate-500">{t("contracting.bills.totalGross", "إجمالي")}</div><div className="font-bold tabular-nums">{totals.gross.toLocaleString("en-US")} ر.س</div></div>
        <div className="rounded-md border p-2 bg-white dark:bg-slate-900"><div className="text-slate-500">{t("contracting.bills.totalDue", "مستحق")}</div><div className="font-bold tabular-nums">{totals.due.toLocaleString("en-US")} ر.س</div></div>
        <div className="rounded-md border p-2 bg-white dark:bg-slate-900"><div className="text-slate-500">{t("contracting.bills.totalNet", "صافي")}</div><div className="font-bold tabular-nums">{totals.net.toLocaleString("en-US")} ر.س</div></div>
        <div className="rounded-md border p-2 bg-white dark:bg-slate-900"><div className="text-slate-500">{t("contracting.bills.totalPaid", "مدفوع")}</div><div className="font-bold tabular-nums text-emerald-600">{totals.paid.toLocaleString("en-US")} ر.س</div></div>
      </div>

      <div className="flex justify-between items-center">
        <h3 className="font-bold">
          {direction === "outgoing"
            ? t("contracting.bills.outgoingTitle", "مستخلصات صادرة للمالك")
            : t("contracting.bills.incomingTitle", "مستخلصات واردة من المقاولين الباطنين")}
          <span className="text-slate-500 font-normal text-sm mx-2">({rows.length})</span>
        </h3>
        {canCreate && (
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mx-1" /> {t("contracting.bills.add", "مستخلص جديد")}
          </Button>
        )}
      </div>

      <div className="rounded-lg border bg-white dark:bg-slate-900 overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t("contracting.bills.number", "الرقم")}</TableHead>
            <TableHead>{t("contracting.bills.date", "التاريخ")}</TableHead>
            {direction === "incoming" && <TableHead>{t("contracting.bills.contractor", "المقاول الباطن")}</TableHead>}
            <TableHead>{t("contracting.bills.certificationPercent", "اعتماد مالي %")}</TableHead>
            <TableHead>{t("contracting.bills.gross", "إجمالي")}</TableHead>
            <TableHead>{t("contracting.bills.retention", "محتجز")}</TableHead>
            <TableHead>{t("contracting.bills.due", "مستحق")}</TableHead>
            <TableHead>{t("contracting.bills.net", "صافي")}</TableHead>
            <TableHead>{t("contracting.bills.paid", "مدفوع")}</TableHead>
            <TableHead>{t("contracting.bills.status", "الحالة")}</TableHead>
            <TableHead className="text-end">—</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {loading && rows.length === 0 && <TableRow><TableCell colSpan={11}><Skeleton className="h-16 w-full" /></TableCell></TableRow>}
            {!loading && rows.length === 0 && <TableRow><TableCell colSpan={11} className="text-center text-sm text-slate-500 py-4">{t("contracting.bills.empty", "لا توجد مستخلصات")}</TableCell></TableRow>}
            {rows.map(b => {
              const contractor = contractors.find(c => c.id === b.contractorId);
              return (
                <TableRow key={b.id}>
                  <TableCell className="font-mono">{b.billNumber}</TableCell>
                  <TableCell>{b.billDate}</TableCell>
                  {direction === "incoming" && <TableCell>{contractor?.name ?? "—"}</TableCell>}
                  <TableCell className="tabular-nums">{Number(b.progressPercent).toFixed(1)}%</TableCell>
                  <TableCell className="tabular-nums">{Number(b.grossAmount).toLocaleString("en-US")}</TableCell>
                  <TableCell className="tabular-nums">{Number(b.retentionAmount).toLocaleString("en-US")}</TableCell>
                  <TableCell className="tabular-nums">{Number(b.dueAmount).toLocaleString("en-US")}</TableCell>
                  <TableCell className="tabular-nums font-bold">{Number(b.netAmount).toLocaleString("en-US")}</TableCell>
                  <TableCell className="tabular-nums text-emerald-600">{Number(b.paidAmount).toLocaleString("en-US")}</TableCell>
                   <TableCell><Badge>{labelEnum(BILL_STATUS_LABEL, b.status)}</Badge></TableCell>
                  <TableCell className="text-end">
                     <ContractingBillExportActions
                       compact
                       snapshot={{
                         bill: {
                           ...b,
                           projectId,
                           projectCode: project.code,
                           projectName: project.nameAr,
                           contractorName: contractor?.name ?? null,
                         },
                         project,
                       }}
                     />
                    <Button size="sm" variant="ghost" onClick={() => setEditing(b)}><Pencil className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => del(b.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {editing && (
        <div className="rounded-lg border bg-white dark:bg-slate-900 shadow-sm p-4 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-sky-100 dark:border-sky-900/40">
            <h4 className="font-bold text-sky-800 dark:text-sky-200 flex items-center gap-2">
              {(editing as any)?.id ? t("contracting.bills.edit", "تعديل المستخلص") : t("contracting.bills.add", "مستخلص جديد")}
              <span className="text-xs font-normal text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">
                ({direction === "outgoing" ? t("contracting.bills.outgoing", "للمالك (صادر)") : t("contracting.bills.incoming", "من الباطن (وارد)")})
              </span>
            </h4>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => { createAttempt.current = null; setEditing(null); }} aria-label={t("common.close", "إغلاق")}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* TOP METADATA GRID */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 bg-muted/20 p-3 rounded-lg border">
             <Field label="اسم المشروع">
               <Input value={project.nameAr ?? ""} readOnly disabled data-testid="input-bill-project-name" />
             </Field>
             <Field label="كود المشروع">
               <Input value={project.code ?? ""} readOnly disabled data-testid="input-bill-project-code" />
             </Field>
            {direction === "incoming" && (
              <Field label={t("contracting.bills.contractor", "المقاول الباطن")} required>
                <ContractingPicker
                  items={withHistoricalParty(eligibleContractors(contractors, editing.contractorId).map(c => ({ value: String(c.id), label: `${c.name}${c.specialty ? ` (${c.specialty})` : ""}` })), editing.contractorId, `#${editing.contractorId} — المقاول المرتبط سابقاً`)}
                  value={editing.contractorId ? String(editing.contractorId) : ""}
                  onValueChange={value => onContractorChange(value ? Number(value) : null)}
                  placeholder={t("contracting.bills.pickContractor", "اختر مقاولاً")}
                  searchPlaceholder={t("contracting.bills.searchContractor", "بحث باسم المقاول...")}
                  emptyText={t("contracting.bills.noContractors", "لا توجد مقاولات متاحة")}
                   disabled={!billOptionsLoaded || Boolean(editingBillId && (detailMode || financiallyLocked))}
                  testId="bill-contractor-picker"
                />
              </Field>
            )}
            {direction === "outgoing" && (
              <Field label={t("contracting.bills.ownerContract", "عقد المالك المرتبط")} required>
                <ContractingPicker
                  items={ownerContracts.map(c => ({ value: String(c.id), label: `#${c.contractNumber} (${labelEnum(CONTRACT_TYPE_LABEL, c.contractType)})` }))}
                  value={editing.ownerContractId ? String(editing.ownerContractId) : ""}
                   onValueChange={value => updateAggregateContract({ ownerContractId: value ? Number(value) : null })}
                  placeholder={t("contracting.bills.ownerContractPlaceholder", "اختر عقد المالك")}
                  searchPlaceholder={t("contracting.bills.searchContract", "بحث برقم العقد...")}
                  emptyText={t("contracting.bills.noOwnerContracts", "لا توجد عقود مالك لهذا المشروع")}
                   disabled={!billOptionsLoaded || Boolean(editingBillId && (detailMode || financiallyLocked))}
                  testId="bill-owner-contract-picker"
                />
              </Field>
            )}
            {direction === "incoming" && (
              <Field label={t("contracting.bills.subcontract", "عقد الباطن المرتبط")} required>
                <ContractingPicker
                  items={selectedSubContracts.map(contract => ({
                    value: String(contract.id),
                    label: `#${contract.contractNumber} · ${contract.retentionPercent}%`,
                  }))}
                  value={editing.subcontractorContractId ? String(editing.subcontractorContractId) : ""}
                  onValueChange={value => {
                    const selected = selectedSubContracts.find(contract => contract.id === Number(value));
                    updateAggregateContract({
                      subcontractorContractId: value ? Number(value) : null,
                      retentionPercent: selected?.retentionPercent ?? editing.retentionPercent,
                    });
                  }}
                  placeholder={editing.contractorId
                    ? t("contracting.bills.subcontractPlaceholder", "اختر عقد الباطن")
                    : t("contracting.bills.selectContractorFirst", "اختر المقاول أولاً")}
                  searchPlaceholder={t("contracting.bills.searchSubcontract", "بحث برقم عقد الباطن...")}
                  emptyText={editing.contractorId
                    ? t("contracting.bills.noSubcontractsForContractor", "لا توجد عقود باطن لهذا المقاول في المشروع")
                    : t("contracting.bills.selectContractorFirst", "اختر المقاول أولاً")}
                   disabled={!billOptionsLoaded || !editing.contractorId || Boolean(editingBillId && (detailMode || financiallyLocked))}
                  testId="bill-subcontract-picker"
                />
              </Field>
            )}
            <Field label={t("contracting.bills.number", "الرقم")}>
              <Input
                value={
                  isCreatingBill
                    ? (nextBillCode.number ?? (nextBillCode.loading ? "..." : t("contracting.bills.autoCode", "تلقائي")))
                    : (editing.billNumber ?? "")
                }
                readOnly
                disabled
                className="font-mono text-sm bg-muted/30"
                data-testid="input-bill-number"
              />
            </Field>
            <Field label={t("contracting.bills.date", "التاريخ")} required><DateField value={editing.billDate ?? ""} onChange={e => setEditing({ ...editing, billDate: e.target.value })} /></Field>
            <Field label={t("contracting.bills.type", "النوع")}>
              <ContractingPicker
                items={["interim","final","advance","retention_release"].map(x => ({ value: x, label: labelEnum(BILL_TYPE_LABEL, x) }))}
                value={editing.billType ?? "interim"}
                onValueChange={billType => setEditing({ ...editing, billType })}
                placeholder={t("contracting.bills.typePlaceholder", "اختر النوع")}
                searchPlaceholder={t("contracting.bills.typeSearchPlaceholder", "بحث في أنواع المستخلصات...")}
                testId="bill-type-picker"
              />
            </Field>

            <Field label={t("contracting.bills.costCenter", "مركز التكلفة")}>
              <ContractingPicker
                items={[
                  { value: "__none", label: t("contracting.bills.noCostCenter", "بدون مركز تكلفة") },
                  ...(costCenters as CostCenter[]).map(center => {
                    const active = center.isActive !== false;
                    const current = editing.costCenterId === center.id;
                    return {
                      value: String(center.id),
                      label: `${center.code} — ${center.nameAr || center.nameEn || `#${center.id}`}${!active ? ` (${t("contracting.bills.inactiveCostCenter", "غير نشط")})` : ""}`,
                      disabled: !active && !current,
                      disabledReason: t("contracting.bills.inactiveCostCenter", "غير نشط"),
                    };
                  }),
                ]}
                value={editing.costCenterId == null ? "__none" : String(editing.costCenterId)}
                onValueChange={value => setEditing({ ...editing, costCenterId: value === "__none" ? null : Number(value) })}
                placeholder={t("contracting.bills.noCostCenter", "بدون مركز تكلفة")}
                searchPlaceholder={t("contracting.bills.costCenterSearchPlaceholder", "بحث بالكود أو الاسم...")}
                disabled={costCentersLoading}
                testId="bill-cost-center-picker"
              />
            </Field>
            {aggregateContractSelected && (
              <Field label="أساس العقد المعدل قبل الضريبة (ر.س)">
                <Input value={aggregateMoney(adjustedContractValue)} readOnly disabled data-testid="input-bill-contract-base" />
              </Field>
            )}
            {!newExecutionMode && !detailMode && <Field label={t("contracting.bills.progress", "الإنجاز التراكمي %")}>
              <Input
                type="number"
                min="0"
                max="100"
                value={editing.progressPercent ?? "0"}
                onChange={event => updateAggregateProgress(event.target.value)}
                disabled={aggregatePercentDisabled}
                data-testid="input-bill-progress-percent"
              />
              {aggregatePercentDisabled && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">
                  {financiallyLocked
                    ? "هذا المستخلص مرتبط بأثر مالي مرحّل ولا يمكن تعديله."
                    : "هذا المستخلص تفصيلي ببنود الكميات؛ عدّل الكميات في جدول البنود."}
                </p>
              )}
            </Field>}
            {!editingBillId && (
              <Field label={t("contracting.bills.retentionPercent", "% محتجز")}>
                <Input
                  type="number" min="0" max="100"
                  value={editing.retentionPercent ?? selectedContract?.retentionPercent ?? "0"}
                  onChange={event => setEditing({ ...editing, retentionPercent: event.target.value })}
                  disabled={financiallyLocked || selectedContract?.retentionEnabled === false}
                />
              </Field>
            )}

            <Field label={t("contracting.bills.status", "الحالة")}>
              <ContractingPicker
                items={["draft","submitted","approved","posted","partially_paid","rejected","paid"].map(x => ({
                  value: x,
                  label: labelEnum(BILL_STATUS_LABEL, x),
                  disabled: ["approved","posted","partially_paid","paid"].includes(x),
                  disabledReason: t("contracting.bills.lockedStatus", "الحالة المرحّلة لا يمكن اختيارها يدوياً"),
                }))}
                value={editing.status ?? "draft"}
                onValueChange={status => setEditing({ ...editing, status })}
                placeholder={t("contracting.bills.statusPlaceholder", "اختر الحالة")}
                searchPlaceholder={t("contracting.bills.statusSearchPlaceholder", "بحث في الحالات...")}
                testId="bill-status-picker"
              />
            </Field>
          </div>

          {!editingBillId && <ContractingAdvanceRecoverySummary
            key={expectedExecutionScope}
            projectId={projectId} direction={direction}
            contractId={direction === "incoming" ? editing.subcontractorContractId ?? null : editing.ownerContractId ?? null}
            billDate={editing.billDate ?? ""} currentValue={currentPeriodGross}
            retentionPercent={editing.retentionPercent}
            override={editing.advanceRecoveryOverrideAmount !== undefined ? {
              advanceRecoveryOverrideAmount: editing.advanceRecoveryOverrideAmount,
              advanceRecoveryOverrideReason: editing.advanceRecoveryOverrideReason ?? null,
            } : undefined}
            onOverrideChange={values => setEditing(current => current ? { ...current, ...values } : current)}
          />}
          <p className="rounded border bg-muted/20 p-3 text-xs leading-5">
            «السابق» و«الرصيد المعلّق السابق» يُحمّلان من المستخلصات المعتمدة ماليًا لنفس العقد فقط.
            المسودة والمرسل وتحت المراجعة لا تُضاف إلى السابق؛ احفظ البنود ثم أكمل الاعتماد المالي للمستخلص السابق أولًا.
          </p>
          {(editing as any)?.id != null ? (
            <ContractingBillDetailEditor
              key={`${(editing as any).id}:${detailsRevision}`}
              billId={Number((editing as any).id)}
              projectId={projectId}
              bill={editing as any}
              project={project}
              initialExecutionValues={recoveredExecution?.billId === Number((editing as any).id) ? recoveredExecution.values : undefined}
              onLinesLoaded={setDetailLineCount}
              onSaved={load}
            />
          ) : (
            <>
            {newExecutionMode && <ContractingDraftExecution
              projectId={projectId} direction={direction} contractId={draftContractId}
              date={editing.billDate ?? ""} state={draftExecution}
              onChange={setDraftExecution} disabled={saving}
            />}
            <div className="mt-8 pt-4">
              <h5 className="font-semibold text-sky-800 dark:text-sky-200 mb-4">القيم المالية المحسوبة</h5>
              <p className="text-xs text-muted-foreground mb-3">معاينة حسب العقد والسابق المعتمد؛ يُثبّت الخادم الحساب عند الحفظ. الإضافات والاستقطاعات واسترداد المقدم تظهر في تفاصيل المسودة المحفوظة.</p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 bg-muted/10 border p-4 rounded-xl">
                <Field label={t("contracting.bills.gross", "الإجمالي التراكمي قبل الضريبة (ر.س)")} required>
                  <Input type="number" value={aggregateMoney(cumulativeGross)} readOnly disabled />
                </Field>
                <Field label="محتجز الفترة">
                  <Input value={aggregateMoney(previewRetention)} readOnly disabled />
                </Field>
                <Field label="السابق المعتمد لنفس العقد">
                  <Input type="number" value={aggregateMoney(priorCertifiedGross)} readOnly disabled />
                </Field>
                <Field label="الحالي للفترة">
                  <Input type="number" value={aggregateMoney(currentPeriodGross)} readOnly disabled />
                </Field>
                <Field label="المستحق قبل الضريبة">
                  <Input type="number" value={aggregateMoney(previewDue)} readOnly disabled />
                </Field>
                <Field label="الضريبة">
                  <Input type="number" value={aggregateMoney(previewVat)} readOnly disabled />
                </Field>
                <Field label="الصافي قبل التسويات الإضافية">
                  <Input type="number" value={aggregateMoney(previewDue + previewVat)} readOnly disabled className="font-bold bg-sky-50 dark:bg-sky-950/20" />
                </Field>
              </div>
            </div>
            </>
          )}

          <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t bg-muted/20 p-4 rounded-xl">
            <Button variant="outline" disabled={saving} onClick={() => { createAttempt.current = null; setEditing(null); }}>{t("common.cancel", "إلغاء")}</Button>
            <Button onClick={() => void save()} disabled={saving} data-testid="button-save-contracting-bill">
              {saving ? t("common.saving", "جار الحفظ…") : t("common.save", "حفظ البيانات الأساسية")}
            </Button>
          </div>
        </div>
      )}
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

      {editing && (
        <div className="rounded-lg border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-950/20 p-4 space-y-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-emerald-700 dark:text-emerald-300">
              {(editing as any)?.id ? t("contracting.risks.edit", "تعديل مخاطرة") : t("contracting.risks.add", "إضافة مخاطرة")}
            </h4>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} aria-label={t("common.close", "إغلاق")}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><Field label={t("contracting.risks.title2", "العنوان")} required><Input value={editing.title ?? ""} onChange={e => setEditing({ ...editing, title: e.target.value })} /></Field></div>
            <div className="col-span-2"><Field label={t("contracting.risks.description", "الوصف")}><Input value={editing.description ?? ""} onChange={e => setEditing({ ...editing, description: e.target.value })} /></Field></div>
            <Field label={t("contracting.risks.category", "التصنيف")}>
              <ContractingPicker
                items={["schedule","cost","quality","safety","environmental","contractual","other"].map(x => ({ value: x, label: labelEnum(RISK_CATEGORY_LABEL, x) }))}
                value={editing.category ?? "other"}
                onValueChange={category => setEditing({ ...editing, category })}
                placeholder={t("contracting.risks.categoryPlaceholder", "اختر التصنيف")}
                searchPlaceholder={t("contracting.risks.categorySearchPlaceholder", "بحث في التصنيفات...")}
                testId="risk-category-picker"
              />
            </Field>
            <Field label={t("contracting.risks.status", "الحالة")}>
              <ContractingPicker
                items={["open","mitigating","resolved","accepted"].map(x => ({ value: x, label: labelEnum(RISK_STATUS_LABEL, x) }))}
                value={editing.status ?? "open"}
                onValueChange={status => setEditing({ ...editing, status })}
                placeholder={t("contracting.risks.statusPlaceholder", "اختر الحالة")}
                searchPlaceholder={t("contracting.risks.statusSearchPlaceholder", "بحث في الحالات...")}
                testId="risk-status-picker"
              />
            </Field>
            <Field label={t("contracting.risks.likelihood", "الاحتمال")}>
              <ContractingPicker
                items={["low","medium","high"].map(x => ({ value: x, label: labelEnum(RISK_LEVEL_LABEL, x) }))}
                value={editing.likelihood ?? "medium"}
                onValueChange={likelihood => setEditing({ ...editing, likelihood })}
                placeholder={t("contracting.risks.likelihoodPlaceholder", "اختر مستوى الاحتمال")}
                searchPlaceholder={t("contracting.risks.levelSearchPlaceholder", "بحث في المستويات...")}
                testId="risk-likelihood-picker"
              />
            </Field>
            <Field label={t("contracting.risks.impact", "الأثر")}>
              <ContractingPicker
                items={["low","medium","high"].map(x => ({ value: x, label: labelEnum(RISK_LEVEL_LABEL, x) }))}
                value={editing.impact ?? "medium"}
                onValueChange={impact => setEditing({ ...editing, impact })}
                placeholder={t("contracting.risks.impactPlaceholder", "اختر مستوى الأثر")}
                searchPlaceholder={t("contracting.risks.levelSearchPlaceholder", "بحث في المستويات...")}
                testId="risk-impact-picker"
              />
            </Field>
            <div className="col-span-2"><Field label={t("contracting.risks.mitigationPlan", "خطة المعالجة")}><Input value={editing.mitigationPlan ?? ""} onChange={e => setEditing({ ...editing, mitigationPlan: e.target.value })} /></Field></div>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-emerald-200 dark:border-emerald-800">
            <Button variant="outline" onClick={() => setEditing(null)}>{t("common.cancel", "إلغاء")}</Button>
            <Button onClick={save}>{t("common.save", "حفظ")}</Button>
          </div>
        </div>
      )}

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
                 <TableCell><Badge variant="outline">{labelEnum(RISK_CATEGORY_LABEL, r.category)}</Badge></TableCell>
                 <TableCell>{labelEnum(RISK_LEVEL_LABEL, r.likelihood)}</TableCell>
                 <TableCell>{labelEnum(RISK_LEVEL_LABEL, r.impact)}</TableCell>
                <TableCell><span className={`px-2 py-0.5 rounded-full text-xs font-bold ${r.score >= 6 ? "bg-red-100 text-red-700" : r.score >= 4 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>{r.score}</span></TableCell>
                 <TableCell><Badge>{labelEnum(RISK_STATUS_LABEL, r.status)}</Badge></TableCell>
                <TableCell className="text-end">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => del(r.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
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
              <div className="text-[10px] text-slate-400 mt-0.5">{new Date(e.createdAt).toLocaleString("ar-SA-u-ca-gregory-nu-latn")}</div>
            </div>
             <Badge variant="outline" className="text-[10px]">{labelEnum(EVENT_TYPE_LABEL, e.eventType)} · {labelEnum(EVENT_SEVERITY_LABEL, e.severity)}</Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────── AI TAB ───────────────────
function AITab({ projectId }: { projectId: number }) {
  const gate = useDemoActionGate();
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
      if (!(await gate('export'))) return;
    setDownloading(true);
    try {
      const r = await fetch(`${API}/api/contracting-ai/training-csv`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      await saveBlob(blob, `contracting-training-${new Date().toISOString().slice(0,10)}.csv`);
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
                      {t("contracting.ai.costOverrun", "تجاوز التكلفة")}: {Number(ind.costOverrun ?? 0).toLocaleString("en-US")} ر.س
                      {ind.projectedFinalCost != null && (
                        <> • {t("contracting.ai.projectedFinalCost", "متوقع عند الإكمال")}: {Number(ind.projectedFinalCost).toLocaleString("en-US")} ر.س</>
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

// ─────────────────── OWNER CONTRACT TAB ───────────────────
function OwnerContractTab({ projectId, project }: { projectId: number; project: Project }) {
  const { t } = useTranslation();
  const { token, user } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<OwnerContract[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<OwnerContract> | null>(null);
  const [pendingBoqLines, setPendingBoqLines] = useState<PendingContractBoqLine[] | null>(null);
  const createRequestId = useRef<string | null>(null);
  const persistedContractId = useRef<number | null>(null);
  const saveInFlight = useRef(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/contracting/projects/${projectId}/owner-contracts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) { toast({ title: e?.message, variant: "destructive" }); }
    finally { setLoading(false); }
  }, [token, projectId, toast]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (saveInFlight.current) return;
    if (!editing?.contractNumber || !editing?.contractDate) {
      toast({ title: t("contracting.ownerContract.required", "رقم العقد والتاريخ مطلوبان"), variant: "destructive" }); return;
    }
    const advancePercent = Number(editing.advancePercent ?? 0);
    if (!Number.isFinite(advancePercent) || advancePercent < 0 || advancePercent > 100) {
      toast({ title: t("contracting.ownerContract.advancePercentInvalid", "نسبة الدفعة المقدمة يجب أن تكون بين 0 و100"), variant: "destructive" }); return;
    }
    saveInFlight.current = true;
    setSaving(true);
    let savedContract = false;
    try {
      const isEdit = editing.id != null || persistedContractId.current != null;
      const existingStatus = isEdit
        ? rows.find(row => row.id === Number(editing.id ?? persistedContractId.current))?.status
          ?? (persistedContractId.current ? "draft" : undefined)
        : undefined;
      const approvalRequested = ["active", "approved"].includes(String(editing.status))
        && editing.status !== existingStatus
        && existingStatus !== "approved";
      // The contract endpoint deliberately rejects direct approval. Stage a
      // draft first, attach its actual BOQ lines, then use the approval route.
      const contractBody = approvalRequested ? { ...editing, status: "draft" } : editing;
      if (!isEdit) createRequestId.current ??= crypto.randomUUID();
      const url = isEdit
        ? `${API}/api/contracting/owner-contracts/${editing.id ?? persistedContractId.current}`
        : `${API}/api/contracting/projects/${projectId}/owner-contracts`;
      const r = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(isEdit ? contractBody : { ...contractBody, clientRequestId: createRequestId.current }),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      const saved = await r.json() as OwnerContract;
      const contractId = isEdit ? Number(editing.id ?? persistedContractId.current) : saved.id;
      if (!Number.isInteger(contractId) || contractId <= 0) throw new Error("تعذر تحديد العقد المحفوظ");
      persistedContractId.current = contractId;
      savedContract = true;
      createRequestId.current = null;
      if (!isEdit) setEditing({ ...editing, id: contractId });
      // Persist each proposed line once. A failed line keeps the saved contract
      // open and leaves only uncommitted drafts for a deliberate retry.
      for (const line of pendingBoqLines ?? []) {
        const lineBody = {
            direction: "owner", ownerContractId: contractId,
            workItemId: Number(line.workItemId), lineCode: line.lineCode,
            description: line.description, unit: line.unit,
            quantity: line.quantity, unitPrice: line.unitPrice,
            baseLineId: ["change_order", "addendum"].includes(String(editing.contractType)) && line.baseLineId ? Number(line.baseLineId) : null,
            quantityDelta: line.baseLineId ? line.quantityDelta : null,
            unitPriceDelta: line.baseLineId ? line.unitPriceDelta : null,
            unitPriceOverride: line.baseLineId && line.unitPriceOverride ? line.unitPriceOverride : null,
        };
        try {
          const lineResponse = await fetch(`${API}/api/contracting/projects/${projectId}/boq-lines`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(lineBody),
          });
          if (!lineResponse.ok) throw new Error((await lineResponse.json().catch(() => ({}))).error || `HTTP ${lineResponse.status}`);
        } catch (error) {
          // BOQ POST has no idempotency key. On a lost response (or 409 after
          // one), confirm the exact saved line before marking this draft done.
          const existingResponse = await fetch(`${API}/api/contracting/projects/${projectId}/boq-lines?direction=owner&ownerContractId=${contractId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!existingResponse.ok) throw error;
          const existing = await existingResponse.json() as Array<typeof lineBody>;
          const matches = Array.isArray(existing) && existing.some(row =>
            row.workItemId === lineBody.workItemId
            && (row.lineCode ?? "") === lineBody.lineCode.trim()
            && (row.description ?? "") === lineBody.description.trim()
            && row.unit === lineBody.unit
            && Number(row.quantity) === Number(lineBody.quantity)
            && Number(row.unitPrice) === Number(lineBody.unitPrice)
            && row.baseLineId === lineBody.baseLineId
            && Number(row.quantityDelta ?? 0) === Number(lineBody.quantityDelta ?? 0)
            && Number(row.unitPriceDelta ?? 0) === Number(lineBody.unitPriceDelta ?? 0)
            && Number(row.unitPriceOverride ?? 0) === Number(lineBody.unitPriceOverride ?? 0),
          );
          if (!matches) throw error;
        }
        setPendingBoqLines(current => (current ?? []).slice(1));
      }
      if (approvalRequested) {
        const approvalUrl = ["change_order", "addendum"].includes(String(editing.contractType))
          ? `${API}/api/contracting/owner-contracts/${contractId}/change-order-decision`
          : `${API}/api/contracting/owner-contracts/${contractId}/approve`;
        const approvalResponse = await fetch(approvalUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ decision: "approved" }),
        });
        if (!approvalResponse.ok) throw new Error((await approvalResponse.json().catch(() => ({}))).error || `HTTP ${approvalResponse.status}`);
      }
      persistedContractId.current = null;
      setEditing(null);
      void load();
    } catch (e: any) {
      toast({
        title: savedContract
          ? "حُفظ العقد كمسودة، لكن تعذر حفظ بعض البنود أو اعتماد العقد. بقيت البنود غير المحفوظة في النموذج لإعادة المحاولة."
          : "تعذر حفظ عقد المالك",
        description: e?.message,
        variant: "destructive",
      });
    }
    finally { saveInFlight.current = false; setSaving(false); }
  }
  async function del(id: number) {
    if (!confirm(t("common.confirmDelete", "تأكيد الحذف؟"))) return;
    await fetch(`${API}/api/contracting/owner-contracts/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    await load();
  }

  function openNew() {
    if (saveInFlight.current) return;
    createRequestId.current = null;
    persistedContractId.current = null;
    setPendingBoqLines(null);
    setEditing({
      contractNumber: "", contractDate: new Date().toISOString().slice(0,10),
      contractType: rows.length === 0 ? "main" : "change_order",
      clientName: project.clientName ?? "",
      value: project.contractValue ?? "0",
      advancePayment: "0", advancePercent: "0",
      retentionPercent: "5", vatPercent: "15",
      durationDays: 0, status: "draft",
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center gap-2">
        <div>
          <h3 className="font-bold">{t("contracting.ownerContract.title", "عقد المالك")}</h3>
          <div className="text-xs text-slate-500">{t("contracting.ownerContract.subtitle", "العقد الرئيسي وأوامر التغيير")}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ContractingContractsExportActions
            compact
            kind="owner"
            contracts={rows as ContractingContractSnapshot[]}
          />
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mx-1" />
            {rows.length === 0
              ? t("contracting.ownerContract.addMain", "إضافة العقد الرئيسي")
              : t("contracting.ownerContract.addChangeOrder", "إضافة أمر تغيير")}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-white dark:bg-slate-900 overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t("contracting.ownerContract.number", "رقم العقد")}</TableHead>
            <TableHead>{t("contracting.ownerContract.type", "النوع")}</TableHead>
            <TableHead>{t("contracting.ownerContract.client", "العميل")}</TableHead>
            <TableHead>{t("contracting.ownerContract.value", "القيمة")}</TableHead>
            <TableHead>{t("contracting.ownerContract.advance", "دفعة مقدمة")}</TableHead>
            <TableHead>{t("contracting.ownerContract.retention", "محتجز %")}</TableHead>
            <TableHead>{t("contracting.ownerContract.duration", "المدة (يوم)")}</TableHead>
            <TableHead>{t("contracting.ownerContract.signedAt", "تاريخ التوقيع")}</TableHead>
            <TableHead>{t("contracting.ownerContract.status", "الحالة")}</TableHead>
            <TableHead className="text-end">—</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {loading && rows.length === 0 && <TableRow><TableCell colSpan={10}><Skeleton className="h-16 w-full" /></TableCell></TableRow>}
            {!loading && rows.length === 0 && <TableRow><TableCell colSpan={10} className="text-center text-sm text-slate-500 py-6">{t("contracting.ownerContract.empty", "لم يتم تسجيل عقد المالك بعد")}</TableCell></TableRow>}
            {rows.map(c => (
              <TableRow key={c.id}>
                <TableCell className="font-mono">{c.contractNumber}</TableCell>
                <TableCell><Badge variant={c.contractType === "main" ? "default" : "secondary"}>{labelEnum(CONTRACT_TYPE_LABEL, c.contractType)}</Badge></TableCell>
                <TableCell>{c.clientName ?? "—"}</TableCell>
                <TableCell className="tabular-nums font-bold">{Number(c.value).toLocaleString("en-US")}</TableCell>
                <TableCell className="tabular-nums">{Number(c.advancePayment).toLocaleString("en-US")}</TableCell>
                <TableCell className="tabular-nums">{Number(c.retentionPercent).toFixed(1)}%</TableCell>
                <TableCell className="tabular-nums">{c.durationDays}</TableCell>
                <TableCell>{c.signedAt ?? "—"}</TableCell>
               <TableCell><Badge>{labelEnum(CONTRACT_STATUS_LABEL, c.status)}</Badge></TableCell>
                <TableCell className="text-end">
                  <ContractingArchiveAction
                    entityType="ownerContract"
                    entityId={c.id}
                    companyName={user?.company?.nameAr || user?.company?.nameEn}
                    className="h-8 gap-1.5 text-xs"
                  />
                  <Button size="sm" variant="ghost" onClick={() => { persistedContractId.current = null; setPendingBoqLines([]); setEditing(c); }}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => del(c.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {editing && (
        <div className="rounded-lg border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-950/20 p-4 space-y-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-emerald-700 dark:text-emerald-300">
              {(editing as any)?.id ? t("contracting.ownerContract.edit", "تعديل عقد المالك") : t("contracting.ownerContract.add", "إضافة عقد")}
            </h4>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} aria-label={t("common.close", "إغلاق")}>
              <X className="h-4 w-4" />
            </Button>
           </div>
           <ProjectContext project={project} />
           <div className="grid grid-cols-2 gap-3">
            <Field label={t("contracting.ownerContract.number", "رقم العقد")} required><Input value={editing.contractNumber ?? ""} onChange={e => setEditing({ ...editing, contractNumber: e.target.value })} /></Field>
            <Field label={t("contracting.ownerContract.date", "تاريخ العقد")} required><DateField value={editing.contractDate ?? ""} onChange={e => setEditing({ ...editing, contractDate: e.target.value })} /></Field>
            <Field label={t("contracting.ownerContract.type", "النوع")}>
              <ContractingPicker
                items={["main", "addendum", "change_order"].map(type => ({ value: type, label: labelEnum(CONTRACT_TYPE_LABEL, type) }))}
                value={editing.contractType ?? "main"}
                onValueChange={contractType => setEditing({ ...editing, contractType, ...(contractType === "main" ? { parentContractId: null } : {}) })}
                placeholder={t("contracting.ownerContract.typePlaceholder", "اختر نوع العقد")}
                searchPlaceholder={t("contracting.ownerContract.typeSearchPlaceholder", "بحث في أنواع العقود...")}
                testId="owner-contract-type-picker"
              />
            </Field>
            {["change_order", "addendum"].includes(String(editing.contractType)) && (
              <Field label={t("contracting.ownerContract.parent", "العقد الأساسي")}>
                <ContractingPicker
                  items={[
                    { value: "__none__", label: t("contracting.ownerContract.noParent", "بدون ربط") },
                    ...rows.filter(c => c.id !== (editing as any).id && c.contractType === "main").map(c => ({ value: String(c.id), label: `#${c.contractNumber}` })),
                  ]}
                  value={editing.parentContractId ? String(editing.parentContractId) : "__none__"}
                  onValueChange={value => setEditing({ ...editing, parentContractId: value === "__none__" ? null : Number(value) })}
                  placeholder={t("contracting.ownerContract.parentPlaceholder", "اختر العقد الأساسي")}
                  searchPlaceholder={t("contracting.ownerContract.parentSearchPlaceholder", "بحث برقم العقد...")}
                  testId="owner-contract-parent-picker"
                />
              </Field>
            )}
            <Field label={t("contracting.ownerContract.client", "اسم العميل")}><Input value={editing.clientName ?? ""} onChange={e => setEditing({ ...editing, clientName: e.target.value })} /></Field>
            <Field label={t("contracting.ownerContract.value", "قيمة العقد (ر.س)")}><Input type="number" value={editing.value ?? "0"} onChange={e => setEditing(current => current ? { ...current, value: e.target.value, advancePayment: calculateAdvancePayment(e.target.value, current.advancePercent) } : current)} /></Field>
            <Field label={t("contracting.ownerContract.advance", "دفعة مقدمة (ر.س)")}><Input type="number" value={editing.advancePayment ?? "0"} onChange={e => setEditing({ ...editing, advancePayment: e.target.value })} /></Field>
            <Field label={t("contracting.ownerContract.advancePercent", "% دفعة مقدمة")}><Input type="number" min="0" max="100" step="0.01" value={editing.advancePercent ?? "0"} onChange={e => setEditing(current => current ? { ...current, advancePercent: e.target.value, advancePayment: calculateAdvancePayment(current.value, e.target.value) } : current)} /></Field>
            <Field label={t("contracting.ownerContract.retention", "محتجز %")}><Input type="number" value={editing.retentionPercent ?? "5"} onChange={e => setEditing({ ...editing, retentionPercent: e.target.value })} /></Field>
            <Field label={t("contracting.ownerContract.vat", "ضريبة %")}><Input type="number" value={editing.vatPercent ?? "15"} onChange={e => setEditing({ ...editing, vatPercent: e.target.value })} /></Field>
            <Field label={t("contracting.ownerContract.duration", "المدة (يوم)")}><Input type="number" value={editing.durationDays ?? 0} onChange={e => setEditing({ ...editing, durationDays: Number(e.target.value) })} /></Field>
            <Field label={t("contracting.ownerContract.startDate", "تاريخ البدء")}><DateField value={editing.startDate ?? ""} onChange={e => setEditing({ ...editing, startDate: e.target.value })} /></Field>
            <Field label={t("contracting.ownerContract.endDate", "تاريخ الانتهاء")}><DateField value={editing.endDate ?? ""} onChange={e => setEditing({ ...editing, endDate: e.target.value })} /></Field>
            <Field label={t("contracting.ownerContract.signedAt", "تاريخ التوقيع")}><DateField value={editing.signedAt ?? ""} onChange={e => setEditing({ ...editing, signedAt: e.target.value })} /></Field>
            <Field label={t("contracting.ownerContract.status", "الحالة")}>
              <ContractingPicker
                items={["draft","active","approved","suspended","completed","terminated","on_hold"].map(x => ({ value: x, label: labelEnum(CONTRACT_STATUS_LABEL, x) }))}
                value={editing.status ?? "draft"}
                onValueChange={status => setEditing({ ...editing, status })}
                placeholder={t("contracting.ownerContract.statusPlaceholder", "اختر الحالة")}
                searchPlaceholder={t("contracting.ownerContract.statusSearchPlaceholder", "بحث في الحالات...")}
                testId="owner-contract-status-picker"
              />
            </Field>
            <div className="col-span-2">
              <Field label={t("contracting.ownerContract.scope", "نطاق العمل")}>
                <textarea className="w-full rounded-md border p-2 min-h-[80px] text-sm bg-white dark:bg-slate-900" value={editing.scopeOfWork ?? ""} onChange={e => setEditing({ ...editing, scopeOfWork: e.target.value })} />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label={t("contracting.ownerContract.paymentTerms", "شروط الدفع")}>
                <textarea className="w-full rounded-md border p-2 min-h-[60px] text-sm bg-white dark:bg-slate-900" value={editing.paymentTerms ?? ""} onChange={e => setEditing({ ...editing, paymentTerms: e.target.value })} />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label={t("contracting.ownerContract.penalties", "بنود الغرامات")}>
                <textarea className="w-full rounded-md border p-2 min-h-[60px] text-sm bg-white dark:bg-slate-900" value={editing.penaltiesClause ?? ""} onChange={e => setEditing({ ...editing, penaltiesClause: e.target.value })} />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label={t("contracting.ownerContract.notes", "ملاحظات")}>
                <textarea className="w-full rounded-md border p-2 min-h-[60px] text-sm bg-white dark:bg-slate-900" value={editing.notes ?? ""} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
              </Field>
            </div>
          </div>
          <ContractingAdvanceRecoveryFields value={editing} disabled={saving}
            onChange={values => setEditing(current => current ? { ...current, ...values } : current)} />
          <ContractingContractBoqEditor key={`${projectId}:owner:${editing.id ?? "new"}`} projectId={projectId} projectName={project.nameAr} projectCode={project.code} direction="owner"
            contractId={editing.id ?? null} contractType={editing.contractType}
            parentContractId={editing.parentContractId ?? null}
            pendingLines={pendingBoqLines} onPendingLinesChange={setPendingBoqLines} />
          {editing.id != null && (
            <details className="rounded-lg border bg-background">
              <summary className="cursor-pointer px-4 py-3 font-medium">
                {t("contracting.guarantees.contractSection", "خطابات الضمان المرتبطة بالعقد")}
              </summary>
              <div className="border-t p-4">
                <ContractingGuaranteesPanel
                  projectId={projectId}
                  contractKind="owner"
                  contractId={editing.id}
                  onSummaryChange={load}
                />
              </div>
            </details>
          )}
          <div className="flex justify-end gap-2 pt-3 border-t border-emerald-200 dark:border-emerald-800">
            <Button variant="outline" disabled={saving} onClick={() => setEditing(null)}>{t("common.cancel", "إلغاء")}</Button>
            <Button disabled={saving || pendingBoqLines === null} onClick={save}>{saving ? t("common.saving", "جارٍ الحفظ...") : t("common.save", "حفظ")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────── SUB CONTRACTS TAB ───────────────────
function SubContractsTab({ projectId, project }: { projectId: number; project: Project }) {
  const { t } = useTranslation();
  const { token, user } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<SubContract[]>([]);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<SubContract> | null>(null);
  const createRequestId = useRef<string | null>(null);
  const saveInFlight = useRef(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, cr] = await Promise.all([
        fetch(`${API}/api/contracting/projects/${projectId}/sub-contracts`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API}/api/contracting/contractors`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
      const contractorData = await cr.json().catch(() => ({}));
      if (!cr.ok) throw new Error(contractorData.error || `تعذر تحميل المقاولين (HTTP ${cr.status})`);
      if (!Array.isArray(contractorData)) throw new Error("استجابة المقاولين غير صالحة");
      setContractors(contractorData);
    } catch (e: any) { toast({ title: e?.message, variant: "destructive" }); }
    finally { setLoading(false); }
  }, [token, projectId, toast]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (saveInFlight.current) return;
    if (!editing?.contractorId) {
      toast({ title: t("contracting.subContract.contractorRequired", "يجب اختيار المقاول الباطن"), variant: "destructive" }); return;
    }
    if (!editing?.contractNumber || !editing?.contractDate) {
      toast({ title: t("contracting.subContract.required", "رقم العقد والتاريخ مطلوبان"), variant: "destructive" }); return;
    }
    const advancePercent = Number(editing.advancePercent ?? 0);
    if (!Number.isFinite(advancePercent) || advancePercent < 0 || advancePercent > 100) {
      toast({ title: t("contracting.subContract.advancePercentInvalid", "نسبة الدفعة المقدمة يجب أن تكون بين 0 و100"), variant: "destructive" }); return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      const isEdit = (editing as any).id != null;
      if (!isEdit) createRequestId.current ??= crypto.randomUUID();
      const url = isEdit
        ? `${API}/api/contracting/sub-contracts/${(editing as any).id}`
        : `${API}/api/contracting/projects/${projectId}/sub-contracts`;
      const r = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(isEdit ? editing : { ...editing, clientRequestId: createRequestId.current }),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      createRequestId.current = null;
      setEditing(null); await load();
    } catch (e: any) { toast({ title: e?.message, variant: "destructive" }); }
    finally { saveInFlight.current = false; setSaving(false); }
  }
  async function del(id: number) {
    if (!confirm(t("common.confirmDelete", "تأكيد الحذف؟"))) return;
    await fetch(`${API}/api/contracting/sub-contracts/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    await load();
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center gap-2">
        <div>
          <h3 className="font-bold">{t("contracting.subContract.title", "عقود المقاولين الباطنين")} <span className="text-slate-500 font-normal text-sm mx-2">({rows.length})</span></h3>
          <div className="text-xs text-slate-500">{t("contracting.subContract.subtitle", "عقود إسناد العمل لمقاولين الباطن")}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ContractingContractsExportActions
            compact
            kind="subcontract"
            contracts={rows.map(contract => ({
              ...contract,
              contractorName: contractors.find(item => item.id === contract.contractorId)?.name || null,
            })) as ContractingContractSnapshot[]}
          />
          <Button size="sm" disabled={saving} onClick={() => { createRequestId.current = null; setEditing({ contractNumber: "", contractDate: new Date().toISOString().slice(0,10), value: "0", advancePayment: "0", advancePercent: "0", retentionPercent: "10", vatPercent: "15", durationDays: 0, status: "draft" }); }}>
            <Plus className="h-4 w-4 mx-1" /> {t("contracting.subContract.add", "عقد باطن جديد")}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-white dark:bg-slate-900 overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t("contracting.subContract.number", "رقم العقد")}</TableHead>
            <TableHead>{t("contracting.subContract.contractor", "المقاول الباطن")}</TableHead>
            <TableHead>{t("contracting.subContract.scope", "نطاق العمل")}</TableHead>
            <TableHead>{t("contracting.subContract.value", "القيمة")}</TableHead>
            <TableHead>{t("contracting.subContract.retention", "محتجز %")}</TableHead>
            <TableHead>{t("contracting.subContract.duration", "المدة (يوم)")}</TableHead>
            <TableHead>{t("contracting.subContract.signedAt", "تاريخ التوقيع")}</TableHead>
            <TableHead>{t("contracting.subContract.status", "الحالة")}</TableHead>
            <TableHead className="text-end">—</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {loading && rows.length === 0 && <TableRow><TableCell colSpan={9}><Skeleton className="h-16 w-full" /></TableCell></TableRow>}
            {!loading && rows.length === 0 && <TableRow><TableCell colSpan={9} className="text-center text-sm text-slate-500 py-6">{t("contracting.subContract.empty", "لا توجد عقود باطن")}</TableCell></TableRow>}
            {rows.map(c => {
              const con = contractors.find(x => x.id === c.contractorId);
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-mono">{c.contractNumber}</TableCell>
                  <TableCell>{con?.name ?? `#${c.contractorId}`}{con?.specialty && <span className="text-xs text-slate-500 mx-1">({con.specialty})</span>}</TableCell>
                  <TableCell className="max-w-[240px] truncate" title={c.scopeOfWork ?? ""}>{c.scopeOfWork ?? "—"}</TableCell>
                  <TableCell className="tabular-nums font-bold">{Number(c.value).toLocaleString("en-US")}</TableCell>
                  <TableCell className="tabular-nums">{Number(c.retentionPercent).toFixed(1)}%</TableCell>
                  <TableCell className="tabular-nums">{c.durationDays}</TableCell>
                  <TableCell>{c.signedAt ?? "—"}</TableCell>
               <TableCell><Badge>{labelEnum(CONTRACT_STATUS_LABEL, c.status)}</Badge></TableCell>
                  <TableCell className="text-end">
                     <ContractingArchiveAction
                       entityType="subcontract"
                       entityId={c.id}
                       companyName={user?.company?.nameAr || user?.company?.nameEn}
                       className="h-8 gap-1.5 text-xs"
                     />
                    <Button size="sm" variant="ghost" onClick={() => setEditing(c)}><Pencil className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => del(c.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {editing && (
        <div className="rounded-lg border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-950/20 p-4 space-y-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-emerald-700 dark:text-emerald-300">
              {(editing as any)?.id ? t("contracting.subContract.edit", "تعديل عقد الباطن") : t("contracting.subContract.add", "عقد باطن جديد")}
            </h4>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} aria-label={t("common.close", "إغلاق")}>
              <X className="h-4 w-4" />
            </Button>
           </div>
           <ProjectContext project={project} />
           <div className="grid grid-cols-2 gap-3">
            <Field label={t("contracting.subContract.contractor", "المقاول الباطن")} required>
              <ContractingPicker
                items={withHistoricalParty(eligibleContractors(contractors, editing.contractorId).map(c => ({ value: String(c.id), label: `${c.name}${c.specialty ? ` (${c.specialty})` : ""}` })), editing.contractorId, `#${editing.contractorId} — المقاول المرتبط سابقاً`)}
                value={editing.contractorId ? String(editing.contractorId) : ""}
                onValueChange={value => setEditing({ ...editing, contractorId: value ? Number(value) : undefined })}
                placeholder={t("contracting.bills.pickContractor", "اختر مقاولاً")}
                searchPlaceholder={t("contracting.subContract.searchContractor", "بحث باسم المقاول...")}
                emptyText="لا يوجد مقاولون باطن مسجلون. أضف مقاولاً واربطه بمورد موجود."
                testId="subcontract-contractor-picker"
              />
              {!contractors.length && <p className="mt-1 text-xs text-amber-700">قائمة المقاولين منفصلة عن الموردين. <Link href="/contracting/contractors" className="underline">إضافة مقاول باطن وربطه بمورد</Link></p>}
              {editing.contractorId && !contractors.find(c => c.id === editing.contractorId)?.supplierId && <p className="mt-1 text-xs text-amber-700">هذا المقاول غير مرتبط بمورد؛ يلزم ربطه بمورد موجود قبل صرف سند متعدد. <Link href="/contracting/contractors" className="underline">إدارة المقاولين</Link></p>}
            </Field>
            <Field label={t("contracting.subContract.number", "رقم العقد")} required><Input value={editing.contractNumber ?? ""} onChange={e => setEditing({ ...editing, contractNumber: e.target.value })} /></Field>
            <Field label={t("contracting.subContract.date", "تاريخ العقد")} required><DateField value={editing.contractDate ?? ""} onChange={e => setEditing({ ...editing, contractDate: e.target.value })} /></Field>
            <Field label={t("contracting.subContract.signedAt", "تاريخ التوقيع")}><DateField value={editing.signedAt ?? ""} onChange={e => setEditing({ ...editing, signedAt: e.target.value })} /></Field>
            <Field label={t("contracting.subContract.value", "قيمة العقد (ر.س)")}><Input type="number" value={editing.value ?? "0"} onChange={e => setEditing(current => current ? { ...current, value: e.target.value, advancePayment: calculateAdvancePayment(e.target.value, current.advancePercent) } : current)} /></Field>
            <Field label={t("contracting.subContract.advance", "دفعة مقدمة (ر.س)")}><Input type="number" value={editing.advancePayment ?? "0"} onChange={e => setEditing({ ...editing, advancePayment: e.target.value })} /></Field>
            <Field label={t("contracting.subContract.advancePercent", "% دفعة مقدمة")}><Input type="number" min="0" max="100" step="0.01" value={editing.advancePercent ?? "0"} onChange={e => setEditing(current => current ? { ...current, advancePercent: e.target.value, advancePayment: calculateAdvancePayment(current.value, e.target.value) } : current)} /></Field>
            <Field label={t("contracting.subContract.retention", "محتجز %")}><Input type="number" value={editing.retentionPercent ?? "10"} onChange={e => setEditing({ ...editing, retentionPercent: e.target.value })} /></Field>
            <Field label={t("contracting.subContract.vat", "ضريبة %")}><Input type="number" value={editing.vatPercent ?? "15"} onChange={e => setEditing({ ...editing, vatPercent: e.target.value })} /></Field>
            <Field label={t("contracting.subContract.duration", "المدة (يوم)")}><Input type="number" value={editing.durationDays ?? 0} onChange={e => setEditing({ ...editing, durationDays: Number(e.target.value) })} /></Field>
            <Field label={t("contracting.subContract.startDate", "تاريخ البدء")}><DateField value={editing.startDate ?? ""} onChange={e => setEditing({ ...editing, startDate: e.target.value })} /></Field>
            <Field label={t("contracting.subContract.endDate", "تاريخ الانتهاء")}><DateField value={editing.endDate ?? ""} onChange={e => setEditing({ ...editing, endDate: e.target.value })} /></Field>
            <Field label={t("contracting.subContract.status", "الحالة")}>
              <ContractingPicker
                items={["draft","active","suspended","completed","terminated","on_hold"].map(x => ({ value: x, label: labelEnum(CONTRACT_STATUS_LABEL, x) }))}
                value={editing.status ?? "draft"}
                onValueChange={status => setEditing({ ...editing, status })}
                placeholder={t("contracting.subContract.statusPlaceholder", "اختر الحالة")}
                searchPlaceholder={t("contracting.subContract.statusSearchPlaceholder", "بحث في الحالات...")}
                testId="subcontract-status-picker"
              />
            </Field>
            <div className="col-span-2">
              <Field label={t("contracting.subContract.scope", "نطاق العمل")}>
                <textarea className="w-full rounded-md border p-2 min-h-[80px] text-sm bg-white dark:bg-slate-900" value={editing.scopeOfWork ?? ""} onChange={e => setEditing({ ...editing, scopeOfWork: e.target.value })} />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label={t("contracting.subContract.paymentTerms", "شروط الدفع")}>
                <textarea className="w-full rounded-md border p-2 min-h-[60px] text-sm bg-white dark:bg-slate-900" value={editing.paymentTerms ?? ""} onChange={e => setEditing({ ...editing, paymentTerms: e.target.value })} />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label={t("contracting.subContract.penalties", "بنود الغرامات")}>
                <textarea className="w-full rounded-md border p-2 min-h-[60px] text-sm bg-white dark:bg-slate-900" value={editing.penaltiesClause ?? ""} onChange={e => setEditing({ ...editing, penaltiesClause: e.target.value })} />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label={t("contracting.subContract.notes", "ملاحظات")}>
                <textarea className="w-full rounded-md border p-2 min-h-[60px] text-sm bg-white dark:bg-slate-900" value={editing.notes ?? ""} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
              </Field>
            </div>
          </div>
          <ContractingAdvanceRecoveryFields value={editing} disabled={saving}
            onChange={values => setEditing(current => current ? { ...current, ...values } : current)} />
          {editing.id != null ? (
            <ContractingContractBoqEditor key={`${projectId}:subcontract:${editing.id}`} projectId={projectId} projectName={project.nameAr} projectCode={project.code} direction="subcontract" contractId={editing.id} />
          ) : <p className="text-xs text-muted-foreground">احفظ العقد أولًا، ثم افتحه لإضافة بنود الباطن بأسعارها المستقلة وربطها ببنود التنفيذ أو مصدرها في عقد المالك.</p>}
          {editing.id != null && (
            <details className="rounded-lg border bg-background">
              <summary className="cursor-pointer px-4 py-3 font-medium">
                {t("contracting.guarantees.contractSection", "خطابات الضمان المرتبطة بالعقد")}
              </summary>
              <div className="border-t p-4">
                <ContractingGuaranteesPanel
                  projectId={projectId}
                  contractKind="subcontract"
                  contractId={editing.id}
                  onSummaryChange={load}
                />
              </div>
            </details>
          )}
          <div className="flex justify-end gap-2 pt-3 border-t border-emerald-200 dark:border-emerald-800">
            <Button variant="outline" disabled={saving} onClick={() => setEditing(null)}>{t("common.cancel", "إلغاء")}</Button>
            <Button disabled={saving} onClick={save}>{saving ? t("common.saving", "جارٍ الحفظ...") : t("common.save", "حفظ")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ContractingPicker({
  items,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyText = "لا توجد نتائج",
  disabled,
  testId,
}: {
  items: ComboboxItem[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <SearchCombobox
      items={items}
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      disabled={disabled}
      openOnFocus={false}
      testId={testId}
    />
  );
}
