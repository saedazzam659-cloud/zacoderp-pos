import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, BarChart3, FileText, Wallet } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ContractingProjectReportExportActions,
} from "@/components/ContractingExportActions";
import type {
  ContractingProjectReportKey,
  ContractingProjectReportsSnapshot,
} from "@/lib/contractingPrintExport";

const API = import.meta.env.VITE_API_URL || "";

type DashboardSide = {
  baseContractValue: number;
  approvedVariationsValue: number;
  adjustedContractValue: number;
  executedValue: number;
  remainingValue: number;
  billCount: number;
  certifiedBillCount: number;
  actualPaid: number;
  due: number;
  advanceActual: number;
  advanceRecovered: number;
  advanceRemaining: number;
  retention: number;
};

type ProjectReportsPayload = ContractingProjectReportsSnapshot & {
  project: { id: number; code: string; nameAr: string; branchId: number | null; status: string };
  dashboard: DashboardSide & {
    state: string;
    ownerRevenue: DashboardSide;
    subcontractCost: DashboardSide;
    latestBill: {
      id: number;
      billNumber: string;
      billDate: string;
      direction: string;
      status: string;
      state: string;
      contractorName: string | null;
      settlementStatus: string;
    } | null;
  };
  reports: Record<ContractingProjectReportKey, unknown>;
  limitations: string[];
  completeness: {
    certifiedBillCount: number;
    unmappedCertifiedLineCount: number;
    profitabilityActualCostAvailable: boolean;
  };
};

const REPORT_OPTIONS: Array<{ value: ContractingProjectReportKey; label: string }> = [
  { value: "boqStatement", label: "كشف بنود العقد" },
  { value: "executedQuantities", label: "كشف الكميات المنفذة" },
  { value: "bills", label: "كشف المستخلصات" },
  { value: "cumulative", label: "المستخلص التراكمي" },
  { value: "advance", label: "الدفعة المقدمة واستردادها" },
  { value: "retention", label: "المحتجز" },
  { value: "deductions", label: "الاستقطاعات والغرامات والتسويات" },
  { value: "variations", label: "مقارنة العقد الأصلي والمعدل" },
  { value: "profitability", label: "ربحية المشروع" },
];

const LABELS: Record<string, string> = {
  direction: "الاتجاه",
  lineCode: "كود البند",
  description: "الوصف",
  unit: "الوحدة",
  contractQuantity: "كمية العقد",
  priorQuantity: "السابق",
  currentQuantity: "الحالي",
  cumulativeQuantity: "التراكمي",
  remainingQuantity: "المتبقي",
  contractValue: "قيمة العقد",
  priorValue: "قيمة السابق",
  currentValue: "قيمة الحالي",
  cumulativeValue: "القيمة التراكمية",
  remainingValue: "القيمة المتبقية",
  completionPercent: "الإنجاز %",
  latestBillStatus: "حالة آخر مستخلص",
  billNumber: "رقم المستخلص",
  billDate: "التاريخ",
  status: "الحالة",
  grossWorks: "الأعمال",
  currentWorks: "الأعمال الحالية",
  cumulativeWorks: "الأعمال التراكمية",
  retentions: "المحتجز",
  additions: "الإضافات",
  signedAdjustmentAmount: "أثر التسوية الصافي",
  deductions: "الاستقطاعات",
  penalties: "الغرامات",
  netAmount: "الصافي",
  actualPaid: "المدفوع فعلياً",
  dueAmount: "المستحق",
  settlementStatus: "حالة التسوية",
  settlementDate: "تاريخ التسوية",
  kind: "النوع",
  amount: "المبلغ",
  appliedAmount: "المطبق",
  statusLabel: "حالة التسوية",
  notes: "ملاحظات",
  released: "المفرج عنه",
  billId: "المستخلص",
  source: "المصدر",
  reason: "السبب",
  reference: "المرجع",
  penaltyType: "تصنيف الغرامة",
  contractNumber: "رقم العقد/الأمر",
  contractType: "نوع العقد",
  originalValue: "القيمة الأصلية",
  variationValue: "قيمة التغيير",
  adjustedValue: "القيمة المعدلة",
  revenue: "إيراد المالك المنفذ",
  actualCost: "التكلفة الفعلية",
  estimatedCost: "التكلفة التقديرية",
  profit: "الربح",
  marginPercent: "الهامش %",
  costSource: "مصدر التكلفة",
  note: "حدود التقرير",
};

function money(value: unknown): string {
  return Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function direction(value: unknown): string {
  return value === "incoming" ? "تكلفة الباطن" : value === "outgoing" ? "إيراد المالك" : String(value ?? "—");
}

function status(value: unknown): string {
  const labels: Record<string, string> = {
    draft: "مسودة", submitted: "مرسل", under_review: "قيد المراجعة", approved: "معتمد",
    posted: "مرحّل", partially_paid: "مدفوع جزئياً", paid: "مدفوع", rejected: "مرفوض",
    cancelled: "ملغى", reversed: "معكوس", unsettled: "غير مسدد",
  };
  return labels[String(value)] ?? String(value ?? "—");
}

function displayValue(key: string, value: unknown): ReactNode {
  if (value == null || value === "") return "—";
  if (key === "direction") return direction(value);
  if (key.toLowerCase().includes("status") || key === "state" || key === "kind" || key === "source") {
    return status(value);
  }
  if (typeof value === "number") return money(value);
  return String(value);
}

function ReportTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = useMemo(() => {
    const keys: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!keys.includes(key) && key !== "id" && !key.endsWith("Id")) keys.push(key);
      }
    }
    return keys.slice(0, 16);
  }, [rows]);
  if (rows.length === 0) {
    return <div className="rounded-lg border bg-white p-8 text-center text-sm text-slate-500">لا توجد بيانات لهذا التقرير.</div>;
  }
  return (
    <div className="rounded-lg border bg-white dark:bg-slate-900 overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>{columns.map(key => <TableHead key={key} className="whitespace-nowrap">{LABELS[key] ?? key}</TableHead>)}</TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={String(row.id ?? `${index}`)}>
              {columns.map(key => <TableCell key={key} className="whitespace-nowrap tabular-nums">{displayValue(key, row[key])}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Metric({ label, value, tone = "slate", icon }: {
  label: string; value: unknown; tone?: "slate" | "emerald" | "amber" | "sky" | "violet"; icon?: ReactNode;
}) {
  const tones = {
    slate: "bg-slate-50 text-slate-800 border-slate-200",
    emerald: "bg-emerald-50 text-emerald-800 border-emerald-200",
    amber: "bg-amber-50 text-amber-800 border-amber-200",
    sky: "bg-sky-50 text-sky-800 border-sky-200",
    violet: "bg-violet-50 text-violet-800 border-violet-200",
  };
  return (
    <div className={`rounded-lg border p-3 ${tones[tone]}`}>
      <div className="flex items-center justify-between gap-2 text-[11px] opacity-80">
        <span>{label}</span>{icon}
      </div>
      <div className="mt-1 text-lg font-bold tabular-nums">{typeof value === "number" ? money(value) : String(value ?? "—")}</div>
    </div>
  );
}

function SideSummary({ title, side, cost = false }: { title: string; side: DashboardSide; cost?: boolean }) {
  return (
    <div className="rounded-lg border bg-white dark:bg-slate-900 p-3 space-y-2">
      <div className="flex items-center gap-2 font-bold text-sm"><Wallet className="h-4 w-4 text-indigo-500" />{title}</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Metric label={cost ? "تكلفة العقد" : "الأساس"} value={side.baseContractValue} />
        <Metric label={cost ? "التكلفة المعدلة" : "القيمة المعدلة"} value={side.adjustedContractValue} tone="violet" />
        <Metric label={cost ? "التنفيذ/التكلفة" : "الإيراد المنفذ"} value={side.executedValue} tone="emerald" />
        <Metric label="المتبقي" value={side.remainingValue} tone="amber" />
        <Metric label="المدفوع فعلياً" value={side.actualPaid} tone="emerald" />
        <Metric label="المستحق" value={side.due} tone="sky" />
        <Metric label="الدفعة المقدمة المتبقية" value={side.advanceRemaining} tone="amber" />
        <Metric label="المحتجز" value={side.retention} tone="violet" />
      </div>
    </div>
  );
}

export function ContractingProjectReports({
  projectId,
  mode,
}: {
  projectId: number;
  mode: "dashboard" | "hub";
}) {
  const { t } = useTranslation();
  const { token, actingCompanyId } = useAuth() as any;
  const { toast } = useToast();
  const [payload, setPayload] = useState<ProjectReportsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ContractingProjectReportKey>("boqStatement");

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token ?? ""}`,
    ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
  }), [token, actingCompanyId]);

  const load = useCallback(async () => {
    if (!token || !projectId) return;
    setLoading(true);
    try {
      const response = await fetch(`${API}/api/contracting/projects/${projectId}/reports`, { headers });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setPayload(body);
    } catch (error: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: error?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [headers, projectId, t, toast, token]);

  useEffect(() => { void load(); }, [load]);

  if (loading && !payload) return <Skeleton className="h-48 w-full" />;
  if (!payload) return null;

  const snapshot = payload as ContractingProjectReportsSnapshot;
  const reportRows = selected === "profitability"
    ? (payload.reports.profitability ? [payload.reports.profitability as Record<string, unknown>] : [])
    : (Array.isArray(payload.reports[selected]) ? payload.reports[selected] as Record<string, unknown>[] : []);

  if (mode === "dashboard") {
    const d = payload.dashboard;
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-indigo-600" /><h3 className="font-bold">لوحة متابعة المشروع</h3><Badge variant="outline">{status(d.state)}</Badge></div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Metric label="قيمة العقد الأساسية" value={d.baseContractValue} tone="violet" />
          <Metric label="الأوامر التغييرية المعتمدة" value={d.approvedVariationsValue} tone="amber" />
          <Metric label="القيمة المعدلة" value={d.adjustedContractValue} tone="violet" />
          <Metric label="إجمالي الأعمال المنفذة" value={d.executedValue} tone="emerald" />
          <Metric label="الأعمال المتبقية" value={d.remainingValue} tone="amber" />
          <Metric label="عدد المستخلصات المعتمدة" value={d.billCount} tone="sky" />
          <Metric label="المدفوع فعلياً" value={d.actualPaid} tone="emerald" />
          <Metric label="المستحق" value={d.due} tone="sky" />
          <Metric label="الدفعة المقدمة الفعلية" value={d.advanceActual} />
          <Metric label="المسترد فعلياً" value={d.advanceRecovered} tone="emerald" />
          <Metric label="المتبقي من الدفعة" value={d.advanceRemaining} tone="amber" />
          <Metric label="إجمالي المحتجز" value={d.retention} tone="violet" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <SideSummary title="إيراد المالك (لا يُجمع مع تكلفة الباطن)" side={d.ownerRevenue} />
          <SideSummary title="تكلفة عقود الباطن (عرض مستقل)" side={d.subcontractCost} cost />
        </div>
        <div className="rounded-lg border bg-white dark:bg-slate-900 p-3 text-sm">
          <div className="font-bold mb-1">آخر مستخلص وحالته</div>
          {d.latestBill ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-600">
              <span className="font-mono">{d.latestBill.billNumber}</span>
              <span>{d.latestBill.billDate}</span>
              <Badge>{direction(d.latestBill.direction)}</Badge>
              <Badge variant="outline">{status(d.latestBill.state)}</Badge>
              <span>{status(d.latestBill.settlementStatus)}</span>
            </div>
          ) : <span className="text-slate-500">لا يوجد مستخلص محفوظ.</span>}
        </div>
        <Limitations payload={payload} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-bold flex items-center gap-2"><FileText className="h-5 w-5 text-indigo-600" />تقارير المشروع</h3>
          <p className="text-xs text-slate-500 mt-1">مصدر واحد للبيانات المعتمدة مع فصل إيراد المالك عن تكلفة الباطن.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selected}
            onChange={event => setSelected(event.target.value as ContractingProjectReportKey)}
            className="h-9 rounded-md border bg-white px-3 text-sm"
            aria-label="اختيار تقرير المشروع"
          >
            {REPORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <ContractingProjectReportExportActions snapshot={snapshot} report={selected} />
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>تحديث</Button>
        </div>
      </div>
      <div className="rounded-lg border bg-indigo-50/60 p-3 text-sm flex flex-wrap items-center gap-x-5 gap-y-1">
        <span>المنفذ للمالك: <b>{money(payload.dashboard.ownerRevenue.executedValue)}</b></span>
        <span>تكلفة الباطن: <b>{money(payload.dashboard.subcontractCost.executedValue)}</b></span>
        <span>المستخلصات المعتمدة: <b>{payload.completeness.certifiedBillCount}</b></span>
      </div>
      <ReportTable rows={reportRows} />
      <Limitations payload={payload} />
    </div>
  );
}

function Limitations({ payload }: { payload: ProjectReportsPayload }) {
  if (!payload.limitations?.length) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900">
      <div className="flex items-center gap-1.5 font-bold mb-1"><AlertTriangle className="h-3.5 w-3.5" />حدود اكتمال التقرير</div>
      <ul className="list-disc ps-5 space-y-0.5">{payload.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </div>
  );
}