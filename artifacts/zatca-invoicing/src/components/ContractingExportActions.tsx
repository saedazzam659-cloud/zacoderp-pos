import { useState } from "react";
import { Download, FileSpreadsheet, Loader2, Printer } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  downloadContractingBillPdf,
  exportContractingBillWorkbook,
  exportContractingBillsReportPdf,
  exportContractingBillsReportWorkbook,
  exportContractingProjectPdf,
  exportContractingProjectsReportPdf,
  exportContractingProjectsReportWorkbook,
  printContractingBillsReport,
  printContractingProjectsReport,
  printContractingProject,
  exportContractingProjectWorkbook,
  exportContractingContractsPdf,
  exportContractingContractsWorkbook,
  printContractingContracts,
  printContractingBill,
  type ContractingBillDetailSnapshot,
  type ContractingBillPrintSnapshot,
  type ContractingBillSnapshot,
  type ContractingCompany,
  type ContractingContractSnapshot,
  type ContractingProjectExportSnapshot,
  type ContractingProjectSnapshot,
} from "@/lib/contractingPrintExport";

const API = import.meta.env.VITE_API_URL || "";

type ActionKind = "print" | "pdf" | "xlsx";

function filenamePart(value: unknown): string {
  return String(value ?? "document").replace(/[\\/:*?"<>|]/g, "-").trim() || "document";
}

function companyInfo(user: any): ContractingCompany | null {
  const company = user?.company;
  if (!company) return null;
  return {
    ...company,
    nameAr: company.nameAr ?? company.name ?? null,
    nameEn: company.nameEn ?? null,
    crNumber: company.crNumber ?? null,
    vatNumber: company.vatNumber ?? null,
    phone: company.phone ?? null,
    buildingNumber: company.buildingNumber ?? null,
    street: company.street ?? null,
    district: company.district ?? null,
    city: company.city ?? null,
    postalCode: company.postalCode ?? null,
    logo: company.logo ?? null,
    brandLogo: company.brandLogo ?? null,
  };
}

function Actions({
  busy,
  onAction,
  compact = false,
  prefix,
}: {
  busy: ActionKind | null;
  onAction: (kind: ActionKind) => void;
  compact?: boolean;
  prefix: string;
}) {
  const buttonClass = compact ? "h-8 px-2 text-xs" : "h-9 px-3";
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label="طباعة وتصدير">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={buttonClass}
        disabled={busy !== null}
        onClick={() => onAction("print")}
        aria-label={`${prefix}: طباعة`}
        data-testid={`${prefix}-print`}
      >
        {busy === "print" ? <Loader2 className="ms-1 h-3.5 w-3.5 animate-spin" /> : <Printer className="ms-1 h-3.5 w-3.5" />}
        <span>طباعة</span>
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={buttonClass}
        disabled={busy !== null}
        onClick={() => onAction("pdf")}
        aria-label={`${prefix}: تنزيل PDF`}
        data-testid={`${prefix}-pdf`}
      >
        {busy === "pdf" ? <Loader2 className="ms-1 h-3.5 w-3.5 animate-spin" /> : <Download className="ms-1 h-3.5 w-3.5" />}
        <span>PDF</span>
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={buttonClass}
        disabled={busy !== null}
        onClick={() => onAction("xlsx")}
        aria-label={`${prefix}: تنزيل Excel`}
        data-testid={`${prefix}-xlsx`}
      >
        {busy === "xlsx" ? <Loader2 className="ms-1 h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="ms-1 h-3.5 w-3.5" />}
        <span>XLSX</span>
      </Button>
    </div>
  );
}

function useRequestHeaders() {
  const { token, actingCompanyId } = useAuth() as any;
  return {
    token: token as string | null,
    headers: {
      Authorization: `Bearer ${token ?? ""}`,
      ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
    } as Record<string, string>,
  };
}

async function readJson(response: Response): Promise<any> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function selectedContract(
  contracts: ContractingContractSnapshot[] | undefined,
  id: unknown,
): ContractingContractSnapshot | null {
  const numericId = Number(id);
  return Number.isInteger(numericId)
    ? contracts?.find(contract => Number(contract.id) === numericId) ?? null
    : null;
}

export function ContractingBillExportActions({
  snapshot,
  compact = false,
}: {
  snapshot: ContractingBillPrintSnapshot;
  compact?: boolean;
}) {
  const { user } = useAuth() as any;
  const { toast } = useToast();
  const { token, headers } = useRequestHeaders();
  const [busy, setBusy] = useState<ActionKind | null>(null);

  async function loadSnapshot(): Promise<ContractingBillPrintSnapshot> {
    if (!token || !snapshot.bill.id) throw new Error("تعذر التحقق من جلسة المستخدم");
    // The detail endpoint is company/branch scoped server-side. Exporting
    // fetches it at click time so line amounts and certified totals are never
    // taken from an unsaved form or a stale list row.
    const response = await fetch(`${API}/api/contracting/bills/${snapshot.bill.id}/details`, { headers });
    const detail = await readJson(response) as ContractingBillDetailSnapshot & {
      bill?: Partial<ContractingBillSnapshot>;
      contracts?: { owner?: ContractingContractSnapshot[]; subcontractor?: ContractingContractSnapshot[] };
    };
    const bill = { ...snapshot.bill, ...(detail.bill ?? {}) } as ContractingBillSnapshot;
    const ownerContracts = detail.contracts?.owner ?? [];
    const subcontracts = detail.contracts?.subcontractor ?? [];
    return {
      ...snapshot,
      printedBy: snapshot.printedBy || user?.nameAr || user?.username || null,
      bill,
      detail,
      ownerContract: snapshot.ownerContract
        ?? selectedContract(ownerContracts, bill.ownerContractId),
      subcontract: snapshot.subcontract
        ?? selectedContract(subcontracts, bill.subcontractorContractId),
    };
  }

  async function run(kind: ActionKind) {
    setBusy(kind);
    try {
      const current = await loadSnapshot();
      const filename = `مستخلص-${filenamePart(current.bill.billNumber)}`;
      if (kind === "print") await printContractingBill(current);
      else if (kind === "pdf") await downloadContractingBillPdf(current, filename);
      else await exportContractingBillWorkbook(current, filename);
    } catch (error: any) {
      toast({ title: "تعذر تجهيز المستند", description: error?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  if (!snapshot.bill.id) return null;
  return <Actions busy={busy} onAction={kind => void run(kind)} compact={compact} prefix={`contracting-bill-${snapshot.bill.id}`} />;
}

export function ContractingProjectExportActions({
  project,
  compact = false,
}: {
  project: ContractingProjectSnapshot;
  compact?: boolean;
}) {
  const { user } = useAuth() as any;
  const { toast } = useToast();
  const { token, headers } = useRequestHeaders();
  const [busy, setBusy] = useState<ActionKind | null>(null);

  async function loadSnapshot(): Promise<ContractingProjectExportSnapshot> {
    if (!token || !project.id) throw new Error("تعذر التحقق من جلسة المستخدم");
    const [ownerResponse, subResponse, contractorsResponse] = await Promise.all([
      fetch(`${API}/api/contracting/projects/${project.id}/owner-contracts`, { headers }),
      fetch(`${API}/api/contracting/projects/${project.id}/sub-contracts`, { headers }),
      fetch(`${API}/api/contracting/contractors`, { headers }),
    ]);
    const ownerContracts = await readJson(ownerResponse);
    const subcontracts = await readJson(subResponse);
    const contractors = await readJson(contractorsResponse);
    const contractorNameById = new Map(
      (Array.isArray(contractors) ? contractors : [])
        .map((contractor: any) => [Number(contractor.id), contractor.name] as const),
    );
    return {
      company: companyInfo(user),
      project,
      ownerContracts: Array.isArray(ownerContracts) ? ownerContracts : [],
      subcontracts: Array.isArray(subcontracts)
        ? subcontracts.map((contract: any) => ({
            ...contract,
            contractorName: contract.contractorName
              || contractorNameById.get(Number(contract.contractorId))
              || null,
          }))
        : [],
    };
  }

  async function run(kind: ActionKind) {
    setBusy(kind);
    try {
      const current = await loadSnapshot();
      const filename = `مشروع-${filenamePart(current.project.code || current.project.id)}`;
      if (kind === "print") {
        await printContractingProject(current, filename);
      } else if (kind === "pdf") {
        await exportContractingProjectPdf(current, filename);
      } else {
        await exportContractingProjectWorkbook(current, filename);
      }
    } catch (error: any) {
      toast({ title: "تعذر تجهيز تقرير المشروع", description: error?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  if (!project.id) return null;
  return <Actions busy={busy} onAction={kind => void run(kind)} compact={compact} prefix={`contracting-project-${project.id}`} />;
}

export function ContractingBillsReportExportActions({
  rows,
  compact = false,
}: {
  rows: ContractingBillSnapshot[];
  compact?: boolean;
}) {
  const { user } = useAuth() as any;
  const { toast } = useToast();
  const [busy, setBusy] = useState<ActionKind | null>(null);

  async function run(kind: ActionKind) {
    if (rows.length === 0) {
      toast({ title: "لا توجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    setBusy(kind);
    try {
      const company = companyInfo(user);
      const filename = `تقرير-مستخلصات-${new Date().toISOString().slice(0, 10)}`;
      if (kind === "xlsx") await exportContractingBillsReportWorkbook(rows, company, filename);
      else if (kind === "pdf") await exportContractingBillsReportPdf(rows, company, filename);
      else await printContractingBillsReport(rows, company, filename);
    } catch (error: any) {
      toast({ title: "تعذر تجهيز التقرير", description: error?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return <Actions busy={busy} onAction={kind => void run(kind)} compact={compact} prefix="contracting-bills-report" />;
}

export function ContractingProjectsReportExportActions({
  rows,
  compact = false,
}: {
  rows: ContractingProjectSnapshot[];
  compact?: boolean;
}) {
  const { user } = useAuth() as any;
  const { toast } = useToast();
  const [busy, setBusy] = useState<ActionKind | null>(null);

  async function run(kind: ActionKind) {
    if (rows.length === 0) {
      toast({ title: "لا توجد بيانات للتصدير", variant: "destructive" });
      return;
    }
    setBusy(kind);
    try {
      const company = companyInfo(user);
      const filename = `تقرير-مشاريع-${new Date().toISOString().slice(0, 10)}`;
      if (kind === "xlsx") await exportContractingProjectsReportWorkbook(rows, company, filename);
      else if (kind === "pdf") await exportContractingProjectsReportPdf(rows, company, filename);
      else await printContractingProjectsReport(rows, company, filename);
    } catch (error: any) {
      toast({ title: "تعذر تجهيز التقرير", description: error?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return <Actions busy={busy} onAction={kind => void run(kind)} compact={compact} prefix="contracting-projects-report" />;
}

export function ContractingContractsExportActions({
  contracts,
  kind,
  compact = false,
}: {
  contracts: ContractingContractSnapshot[];
  kind: "owner" | "subcontract";
  compact?: boolean;
}) {
  const { user } = useAuth() as any;
  const { toast } = useToast();
  const [busy, setBusy] = useState<ActionKind | null>(null);

  async function run(action: ActionKind) {
    if (contracts.length === 0) {
      toast({ title: "لا توجد عقود محفوظة للتصدير", variant: "destructive" });
      return;
    }
    setBusy(action);
    try {
      const company = companyInfo(user);
      const filename = kind === "owner" ? "عقود-المالك" : "عقود-الباطن";
      if (action === "xlsx") await exportContractingContractsWorkbook(contracts, kind, company, filename);
      else if (action === "pdf") await exportContractingContractsPdf(contracts, kind, company, filename);
      else await printContractingContracts(contracts, kind, company, filename);
    } catch (error: any) {
      toast({ title: "تعذر تجهيز العقود", description: error?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return <Actions busy={busy} onAction={action => void run(action)} compact={compact} prefix={`contracting-${kind}-contracts`} />;
}