/**
 * Contracting print/export surfaces.
 *
 * The document frame intentionally follows the existing sales template 14
 * (three-column header, centred logo/title, RTL A4 page frame and repeating
 * table headers), but the fiscal document mapping is contracting-specific:
 * it always says "مستخلص تقدم أعمال" and never "فاتورة".  Contracting bills
 * are not ZATCA sales invoices and must not inherit sales invoice labels.
 */
import {
  downloadHtmlAsPdf,
  exportToExcelBranded,
  exportToPDF,
  rasterizeLogo,
  safeLogoSrc,
  safeSpreadsheetText,
  type ExportColumn,
  type ExportCompanyInfo,
  type BrandedExtraSheet,
} from "@/lib/export";
import { template14 } from "@/pages/sales/SalesPrintModal";

export type ContractingCompany = ExportCompanyInfo;

export interface ContractingProjectSnapshot {
  id: number;
  code?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  branchName?: string | null;
  clientName?: string | null;
  location?: string | null;
  projectType?: string | null;
  status?: string | null;
  contractValue?: string | number | null;
  plannedBudget?: string | number | null;
  actualCost?: string | number | null;
  progressPercent?: string | number | null;
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  description?: string | null;
}

export interface ContractingContractSnapshot {
  id: number;
  contractNumber?: string | null;
  contractDate?: string | null;
  contractType?: string | null;
  clientName?: string | null;
  contractorName?: string | null;
  value?: string | number | null;
  advancePayment?: string | number | null;
  advancePercent?: string | number | null;
  retentionPercent?: string | number | null;
  vatPercent?: string | number | null;
  durationDays?: string | number | null;
  startDate?: string | null;
  endDate?: string | null;
  signedAt?: string | null;
  status?: string | null;
  scopeOfWork?: string | null;
  paymentTerms?: string | null;
  penaltiesClause?: string | null;
  notes?: string | null;
}

export interface ContractingBillSnapshot {
  id: number;
  projectId?: number;
  projectCode?: string | null;
  projectName?: string | null;
  direction: "outgoing" | "incoming";
  contractorName?: string | null;
  contractorId?: number | null;
  ownerContractId?: number | null;
  subcontractorContractId?: number | null;
  ownerContractNumber?: string | null;
  subcontractorContractNumber?: string | null;
  billNumber: string;
  billType?: string | null;
  billDate: string;
  fromDate?: string | null;
  toDate?: string | null;
  progressPercent?: string | number | null;
  grossAmount?: string | number | null;
  grossWorks?: string | number | null;
  previousWorks?: string | number | null;
  currentWorks?: string | number | null;
  cumulativeWorks?: string | number | null;
  contractValue?: string | number | null;
  remainingContract?: string | number | null;
  retentionPercent?: string | number | null;
  retentionAmount?: string | number | null;
  deductions?: string | number | null;
  additions?: string | number | null;
  signedAdjustmentAmount?: string | number | null;
  penalties?: string | number | null;
  retentions?: string | number | null;
  vatPercent?: string | number | null;
  vatAmount?: string | number | null;
  previousPaid?: string | number | null;
  dueAmount?: string | number | null;
  netAmount?: string | number | null;
  paidAmount?: string | number | null;
  payments?: string | number | null;
  outstanding?: string | number | null;
  status?: string | null;
  notes?: string | null;
}

export interface ContractingBillLineSnapshot {
  id: number;
  workItemName?: string | null;
  workItemCode?: string | null;
  unit?: string | null;
  previousQty?: string | number | null;
  currentQty?: string | number | null;
  cumulativeQty?: string | number | null;
  previousValue?: string | number | null;
  currentValue?: string | number | null;
  cumulativeValue?: string | number | null;
  changeOrderNumber?: string | null;
}

export interface ContractingBillDetailSnapshot {
  state?: string | null;
  lines?: ContractingBillLineSnapshot[];
  additions?: Array<{
    calculationType?: string | null;
    rate?: string | number | null;
    baseType?: string | null;
    baseAmount?: string | number | null;
    reason?: string | null;
    referenceType?: string | null;
    reference?: string | null;
    amount?: string | number | null;
  }>;
  deductions?: Array<{ kind?: string | null; reason?: string | null; amount?: string | number | null }>;
  penalties?: Array<{ penaltyType?: string | null; reason?: string | null; amount?: string | number | null; penaltyDate?: string | null }>;
  summary?: {
    grossWorks?: number;
    originalContractValue?: number;
    changeOrdersValue?: number;
    adjustedContractValue?: number;
    previousWorks?: number;
    currentWorks?: number;
    cumulativeWorks?: number;
    remainingContractValue?: number;
    cumulativeCompletionPercent?: number;
    deductionsTotal?: number;
    additionsTotal?: number;
    generalDeductionsTotal?: number;
    retentionAmount?: number;
    penaltyTotal?: number;
    netBeforeTax?: number;
    vatAmount?: number;
    netAmount?: number;
    adjustedNetAmount?: number;
    rawNetAmount?: number;
    signedAdjustmentAmount?: number;
    paidAmount?: number;
    remainingAmount?: number;
  };
}

export interface ContractingBillPrintSnapshot {
  company?: ContractingCompany | null;
  printedBy?: string | null;
  project?: ContractingProjectSnapshot | null;
  bill: ContractingBillSnapshot;
  detail?: ContractingBillDetailSnapshot | null;
  ownerContract?: ContractingContractSnapshot | null;
  subcontract?: ContractingContractSnapshot | null;
}

export interface ContractingProjectExportSnapshot {
  company?: ContractingCompany | null;
  project: ContractingProjectSnapshot;
  ownerContracts?: ContractingContractSnapshot[];
  subcontracts?: ContractingContractSnapshot[];
  bills?: ContractingBillSnapshot[];
}

export const CONTRACTING_MODEL14_DOCUMENT_MAP = {
  outgoing: {
    titleAr: "مستخلص تقدم أعمال صادر للمالك",
    titleEn: "OWNER PROGRESS BILL",
    partyAr: "المالك / العميل",
  },
  incoming: {
    titleAr: "مستخلص تقدم أعمال وارد من المقاول الباطن",
    titleEn: "SUBCONTRACTOR PROGRESS BILL",
    partyAr: "المقاول الباطن",
  },
} as const;

const CONTRACTING_STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  submitted: "مُرسل",
  under_review: "قيد المراجعة",
  approved: "معتمد",
  posted: "مرحّل",
  partially_paid: "مدفوع جزئياً",
  paid: "مدفوع",
  rejected: "مرفوض",
  reversed: "معكوس",
  cancelled: "ملغى",
};

const CONTRACTING_DIRECTION_LABEL = {
  outgoing: "صادر للمالك",
  incoming: "وارد من المقاول الباطن",
} as const;

const CONTRACTING_BILL_COLUMNS: ExportColumn[] = [
  { key: "recordType", header: "نوع السجل", width: 18 },
  { key: "project", header: "المشروع", width: 28 },
  { key: "billNumber", header: "رقم المستخلص", width: 18 },
  { key: "billDate", header: "التاريخ", width: 14 },
  { key: "direction", header: "الاتجاه", width: 22 },
  { key: "party", header: "الطرف المرتبط", width: 24 },
  { key: "status", header: "الحالة", width: 16 },
  { key: "item", header: "بند التنفيذ", width: 28 },
  { key: "unit", header: "الوحدة", width: 12 },
  { key: "previousQty", header: "الكمية السابقة", width: 14, numFmt: "#,##0.###" },
  { key: "currentQty", header: "الكمية الحالية", width: 14, numFmt: "#,##0.###" },
  { key: "cumulativeQty", header: "الكمية التراكمية", width: 16, numFmt: "#,##0.###" },
  { key: "previousWorks", header: "الأعمال السابقة", width: 16, numFmt: "#,##0.00" },
  { key: "currentWorks", header: "الأعمال الحالية", width: 16, numFmt: "#,##0.00" },
  { key: "cumulativeWorks", header: "الأعمال التراكمية", width: 18, numFmt: "#,##0.00" },
  { key: "contractValue", header: "قيمة العقد", width: 16, numFmt: "#,##0.00" },
  { key: "remainingContract", header: "المتبقي من العقد", width: 18, numFmt: "#,##0.00" },
  { key: "retentions", header: "المحتجز", width: 14, numFmt: "#,##0.00" },
  { key: "additions", header: "الإضافات المالية", width: 16, numFmt: "#,##0.00" },
  { key: "deductions", header: "الاستقطاعات", width: 14, numFmt: "#,##0.00" },
  { key: "penalties", header: "الغرامات", width: 14, numFmt: "#,##0.00" },
  { key: "signedAdjustment", header: "أثر التسوية الصافي", width: 18, numFmt: "#,##0.00" },
  { key: "vatAmount", header: "الضريبة", width: 14, numFmt: "#,##0.00" },
  { key: "netAmount", header: "الصافي", width: 16, numFmt: "#,##0.00" },
  { key: "paidAmount", header: "المدفوع", width: 16, numFmt: "#,##0.00" },
  { key: "outstanding", header: "المتبقي للسداد", width: 18, numFmt: "#,##0.00" },
];

function numberValue(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function optionalNumber(value: unknown): number | "" {
  if (value === null || value === undefined || value === "") return "";
  const result = Number(value);
  return Number.isFinite(result) ? result : "";
}

function text(value: unknown): string {
  return safeSpreadsheetText(value == null ? "" : value);
}

function statusLabel(value: unknown): string {
  const key = String(value ?? "");
  return text(CONTRACTING_STATUS_LABEL[key] ?? (key || "—"));
}

function partyName(snapshot: ContractingBillPrintSnapshot): string {
  const { bill, ownerContract, subcontract } = snapshot;
  if (bill.direction === "outgoing") {
    return ownerContract?.clientName || "—";
  }
  return bill.contractorName || subcontract?.contractorName || "—";
}

function reportRow(
  bill: ContractingBillSnapshot,
  detail?: ContractingBillDetailSnapshot | null,
  line?: ContractingBillLineSnapshot,
): Record<string, unknown> {
  const summary = detail?.summary;
  const isLine = Boolean(line);
  return {
    recordType: isLine ? "بند مستخلص" : "ملخص مستخلص",
    project: text([bill.projectCode, bill.projectName].filter(Boolean).join(" — ")),
    billNumber: text(bill.billNumber),
    billDate: text(bill.billDate),
    direction: CONTRACTING_DIRECTION_LABEL[bill.direction],
    party: text(bill.contractorName || ""),
    status: statusLabel(bill.status),
    item: text(line?.workItemName || line?.workItemCode || ""),
    unit: text(line?.unit || ""),
    previousQty: optionalNumber(line?.previousQty),
    currentQty: optionalNumber(line?.currentQty),
    cumulativeQty: optionalNumber(line?.cumulativeQty),
    previousWorks: optionalNumber(line?.previousValue ?? summary?.previousWorks ?? bill.previousWorks),
    currentWorks: optionalNumber(line?.currentValue ?? summary?.currentWorks ?? bill.currentWorks ?? bill.grossAmount),
    cumulativeWorks: optionalNumber(line?.cumulativeValue ?? summary?.cumulativeWorks ?? bill.cumulativeWorks ?? bill.grossAmount),
    contractValue: optionalNumber(summary?.adjustedContractValue ?? bill.contractValue),
    remainingContract: optionalNumber(summary?.remainingContractValue ?? bill.remainingContract),
    retentions: optionalNumber(summary?.retentionAmount ?? bill.retentionAmount ?? bill.retentions),
    additions: optionalNumber(summary?.additionsTotal ?? bill.additions),
    deductions: optionalNumber(summary?.generalDeductionsTotal ?? bill.deductions),
    penalties: optionalNumber(summary?.penaltyTotal ?? bill.penalties),
    signedAdjustment: optionalNumber(summary?.signedAdjustmentAmount ?? bill.signedAdjustmentAmount),
    vatAmount: optionalNumber(summary?.vatAmount ?? bill.vatAmount),
    netAmount: optionalNumber(summary?.adjustedNetAmount ?? summary?.netAmount ?? bill.netAmount),
    paidAmount: optionalNumber(summary?.paidAmount ?? bill.paidAmount ?? bill.payments),
    outstanding: optionalNumber(summary?.remainingAmount ?? bill.outstanding),
  };
}

function billTotalsRow(snapshot: ContractingBillPrintSnapshot): Record<string, unknown> {
  const { bill, detail } = snapshot;
  const summary = detail?.summary;
  return {
    recordType: "الإجمالي المعتمد",
    project: text([bill.projectCode, bill.projectName].filter(Boolean).join(" — ")),
    billNumber: text(bill.billNumber),
    direction: CONTRACTING_DIRECTION_LABEL[bill.direction],
    previousWorks: optionalNumber(summary?.previousWorks ?? bill.previousWorks),
    currentWorks: optionalNumber(summary?.currentWorks ?? bill.currentWorks ?? bill.grossAmount),
    cumulativeWorks: optionalNumber(summary?.cumulativeWorks ?? bill.cumulativeWorks ?? bill.grossAmount),
    contractValue: optionalNumber(summary?.adjustedContractValue ?? bill.contractValue),
    remainingContract: optionalNumber(summary?.remainingContractValue ?? bill.remainingContract),
    retentions: optionalNumber(summary?.retentionAmount ?? bill.retentionAmount ?? bill.retentions),
    additions: optionalNumber(summary?.additionsTotal ?? bill.additions),
    deductions: optionalNumber(summary?.generalDeductionsTotal ?? bill.deductions),
    penalties: optionalNumber(summary?.penaltyTotal ?? bill.penalties),
    signedAdjustment: optionalNumber(summary?.signedAdjustmentAmount ?? bill.signedAdjustmentAmount),
    vatAmount: optionalNumber(summary?.vatAmount ?? bill.vatAmount),
    netAmount: optionalNumber(summary?.adjustedNetAmount ?? summary?.netAmount ?? bill.netAmount),
    paidAmount: optionalNumber(summary?.paidAmount ?? bill.paidAmount ?? bill.payments),
    outstanding: optionalNumber(summary?.remainingAmount ?? bill.outstanding),
  };
}

/** Shared row builder used by the branded XLSX exporter and fast export tests. */
/** Shared row builder used by the branded XLSX exporter and fast export tests. */
export function buildContractingBillExportRows(
  snapshot: ContractingBillPrintSnapshot,
): Record<string, unknown>[] {
  const lines = snapshot.detail?.lines ?? [];
  const additions = snapshot.detail?.additions ?? [];
  const party = text(partyName(snapshot));
  return [
    { ...reportRow(snapshot.bill, snapshot.detail), party },
    ...lines.map(line => ({ ...reportRow(snapshot.bill, snapshot.detail, line), party })),
    ...additions.map(addition => ({
      ...reportRow(snapshot.bill, snapshot.detail),
      party,
      recordType: "إضافة مالية",
      item: text(addition.reason || "إضافة مالية"),
      unit: text(addition.reference ? `${addition.referenceType || "مرجع"}: ${addition.reference}` : "—"),
      currentWorks: optionalNumber(addition.amount),
      cumulativeWorks: optionalNumber(addition.amount),
      additions: optionalNumber(addition.amount),
    })),
  ];
}

/**
 * Render a saved contracting bill through the actual sales model-14 renderer.
 * The adapter only supplies contracting rows/totals and title labels; all
 * model-14 structure, styles, header, logo, pagination and footer remain
 * shared with saved sales documents.
 */
/**
 * Render a saved contracting bill through the actual sales model-14 renderer.
 * The adapter only supplies contracting rows/totals and title labels; all
 * model-14 structure, styles, header, logo, pagination and footer remain
 * shared with saved sales documents.
 */
export function buildContractingModel14Html(snapshot: ContractingBillPrintSnapshot): string {
  const { bill, detail, company, project } = snapshot;
  const map = CONTRACTING_MODEL14_DOCUMENT_MAP[bill.direction];
  const summary = detail?.summary;
  const lines = (detail?.lines ?? []).map(line => ({
    itemName: line.workItemName || line.workItemCode || "—",
    unit: line.unit || "—",
    qty: line.currentQty ?? 0,
    unitPrice: numberValue(line.currentQty) > 0
      ? numberValue(line.currentValue) / numberValue(line.currentQty)
      : 0,
    vatRate: bill.vatPercent ?? 0,
    previousQty: line.previousQty ?? 0,
    currentQty: line.currentQty ?? 0,
    cumulativeQty: line.cumulativeQty ?? 0,
    previousValue: line.previousValue ?? 0,
    currentValue: line.currentValue ?? 0,
    cumulativeValue: line.cumulativeValue ?? 0,
    changeOrderNumber: line.changeOrderNumber ?? null,
  }));
  const current = summary?.currentWorks ?? bill.currentWorks ?? bill.grossAmount ?? 0;
  const net = summary?.netAmount ?? bill.netAmount;
  const vat = summary?.vatAmount ?? bill.vatAmount ?? 0;
  const syntheticDoc = {
    id: bill.id,
    docNumber: bill.billNumber,
    invoiceDate: bill.billDate,
    createdAt: bill.billDate,
    priceIncludesVat: false,
    currencyCode: "SAR",
    paymentType: "credit",
    notes: bill.notes,
    buyerName: partyName(snapshot),
    createdByName: snapshot.printedBy ?? "—",
  };
  const contractingData = {
    titleAr: map.titleAr,
    titleEn: map.titleEn,
    directionLabel: CONTRACTING_DIRECTION_LABEL[bill.direction],
    footerLabel: "مستند مقاولات",
    billNumber: bill.billNumber,
    billDate: bill.billDate,
    totals: {
      previousWorks: summary?.previousWorks ?? bill.previousWorks ?? 0,
      currentWorks: current,
      cumulativeWorks: summary?.cumulativeWorks ?? bill.cumulativeWorks ?? bill.grossAmount ?? 0,
      contractValue: summary?.adjustedContractValue ?? bill.contractValue ?? 0,
      remainingContract: summary?.remainingContractValue ?? bill.remainingContract ?? 0,
      retention: summary?.retentionAmount ?? bill.retentionAmount ?? bill.retentions ?? 0,
      additions: summary?.additionsTotal ?? bill.additions ?? 0,
       deductions: summary?.generalDeductionsTotal ?? bill.deductions ?? 0,
      penalties: summary?.penaltyTotal ?? bill.penalties ?? 0,
      paid: summary?.paidAmount ?? bill.paidAmount ?? bill.payments ?? 0,
      outstanding: summary?.remainingAmount ?? bill.outstanding ?? 0,
      subtotalPreDiscount: numberValue(current),
      discountTotal: 0,
      netPreVat: numberValue(current),
      vatAmount: numberValue(vat),
      grandTotal: numberValue(summary?.adjustedNetAmount ?? net ?? numberValue(current) + numberValue(vat)),
    },
  };
  const customer = {
    nameAr: partyName(snapshot),
    code: project?.code || bill.projectCode || "",
    address: project?.location || "",
  };
  return template14({
    type: "invoice",
    doc: syntheticDoc,
    lines,
    customer,
    company,
    _contracting: contractingData,
  } as any);
}

export async function printContractingBill(snapshot: ContractingBillPrintSnapshot): Promise<void> {
  const html = buildContractingModel14Html(snapshot);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (!win) {
    URL.revokeObjectURL(url);
    throw new Error("تعذر فتح نافذة الطباعة");
  }
  win.addEventListener("afterprint", () => URL.revokeObjectURL(url), { once: true });
  win.addEventListener("load", () => {
    window.setTimeout(() => {
      win.focus();
      win.print();
    }, 350);
  }, { once: true });
}

export async function downloadContractingBillPdf(
  snapshot: ContractingBillPrintSnapshot,
  filename = `مستخلص-${snapshot.bill.billNumber}`,
): Promise<void> {
  let prepared = snapshot;
  const logo = safeLogoSrc(snapshot.company?.logo);
  if (logo) {
    const raster = await rasterizeLogo(logo, 170, 62);
    if (raster) prepared = { ...snapshot, company: { ...snapshot.company, logo: raster.src } };
  }
  await downloadHtmlAsPdf(buildContractingModel14Html(prepared), filename, { orientation: "portrait" });
}

function projectRows(snapshot: ContractingProjectExportSnapshot): Record<string, unknown>[] {
  const project = snapshot.project;
  return [{
    projectCode: text(project.code),
    projectName: text(project.nameAr || project.nameEn),
    branch: text(project.branchName),
    client: text(project.clientName),
    type: text(project.projectType),
    status: statusLabel(project.status),
    location: text(project.location),
    contractValue: optionalNumber(project.contractValue),
    plannedBudget: optionalNumber(project.plannedBudget),
    actualCost: optionalNumber(project.actualCost),
    progress: optionalNumber(project.progressPercent),
    startDate: text(project.plannedStartDate),
    endDate: text(project.plannedEndDate),
  }];
}

function projectReportRows(projects: ContractingProjectSnapshot[]): Record<string, unknown>[] {
  return projects.flatMap(project => projectRows({ project }));
}

const PROJECT_COLUMNS: ExportColumn[] = [
  { key: "projectCode", header: "كود المشروع", width: 18 },
  { key: "projectName", header: "اسم المشروع", width: 30 },
  { key: "branch", header: "الفرع", width: 20 },
  { key: "client", header: "العميل", width: 24 },
  { key: "type", header: "نوع المشروع", width: 18 },
  { key: "status", header: "الحالة", width: 16 },
  { key: "location", header: "الموقع", width: 24 },
  { key: "contractValue", header: "قيمة العقد", width: 16, numFmt: "#,##0.00" },
  { key: "plannedBudget", header: "الميزانية المخططة", width: 18, numFmt: "#,##0.00" },
  { key: "actualCost", header: "التكلفة الفعلية", width: 18, numFmt: "#,##0.00" },
  { key: "progress", header: "الإنجاز %", width: 14, numFmt: "0.00" },
  { key: "startDate", header: "البداية المخططة", width: 16 },
  { key: "endDate", header: "النهاية المخططة", width: 16 },
];

const CONTRACT_COLUMNS: ExportColumn[] = [
  { key: "contractNumber", header: "رقم العقد", width: 18 },
  { key: "contractType", header: "النوع", width: 16 },
  { key: "party", header: "الطرف", width: 26 },
  { key: "contractDate", header: "تاريخ العقد", width: 15 },
  { key: "value", header: "القيمة", width: 16, numFmt: "#,##0.00" },
  { key: "advancePayment", header: "الدفعة المقدمة", width: 17, numFmt: "#,##0.00" },
  { key: "advancePercent", header: "دفعة %", width: 12, numFmt: "0.00" },
  { key: "retentionPercent", header: "محتجز %", width: 12, numFmt: "0.00" },
  { key: "vatPercent", header: "ضريبة %", width: 12, numFmt: "0.00" },
  { key: "durationDays", header: "المدة (يوم)", width: 14, numFmt: "0" },
  { key: "startDate", header: "البداية", width: 14 },
  { key: "endDate", header: "النهاية", width: 14 },
  { key: "signedAt", header: "التوقيع", width: 14 },
  { key: "status", header: "الحالة", width: 16 },
  { key: "scopeOfWork", header: "نطاق العمل", width: 32 },
];

function contractRows(contracts: ContractingContractSnapshot[], fallbackParty = ""): Record<string, unknown>[] {
  return contracts.map(contract => ({
    contractNumber: text(contract.contractNumber),
    contractType: text(contract.contractType),
    party: text(contract.clientName || contract.contractorName || fallbackParty),
    contractDate: text(contract.contractDate),
    value: optionalNumber(contract.value),
    advancePayment: optionalNumber(contract.advancePayment),
    advancePercent: optionalNumber(contract.advancePercent),
    retentionPercent: optionalNumber(contract.retentionPercent),
    vatPercent: optionalNumber(contract.vatPercent),
    durationDays: optionalNumber(contract.durationDays),
    startDate: text(contract.startDate),
    endDate: text(contract.endDate),
    signedAt: text(contract.signedAt),
    status: statusLabel(contract.status),
    scopeOfWork: text(contract.scopeOfWork),
  }));
}

function contractPdfRows(contracts: ContractingContractSnapshot[]): Record<string, unknown>[] {
  return contractRows(contracts);
}

/**
 * Export a project plus its saved owner/subcontract relations. Contract data
 * is passed by the authorized caller; this helper never invents relations or
 * writes to the server.
 */
export async function exportContractingProjectWorkbook(
  snapshot: ContractingProjectExportSnapshot,
  filename = `مشروع-${snapshot.project.code || snapshot.project.id}`,
): Promise<void> {
  const extraSheets: BrandedExtraSheet[] = [
    ...(snapshot.ownerContracts?.length
      ? [{ sheetName: "عقود المالك", rows: contractRows(snapshot.ownerContracts), columns: CONTRACT_COLUMNS }]
      : []),
    ...(snapshot.subcontracts?.length
      ? [{ sheetName: "عقود الباطن", rows: contractRows(snapshot.subcontracts), columns: CONTRACT_COLUMNS }]
      : []),
  ];
  await exportToExcelBranded(projectRows(snapshot), PROJECT_COLUMNS, filename, {
    sheetName: "المشروع",
    company: snapshot.company,
    title: "تقرير مشروع مقاولات",
    subtitle: snapshot.project.nameAr || snapshot.project.nameEn || snapshot.project.code || "",
    extraSheets,
  });
}

export async function exportContractingProjectPdf(
  snapshot: ContractingProjectExportSnapshot,
  filename = `مشروع-${snapshot.project.code || snapshot.project.id}`,
): Promise<void> {
  const extraSections = [
    ...(snapshot.ownerContracts?.length ? [{ title: "عقود المالك", rows: contractPdfRows(snapshot.ownerContracts), columns: CONTRACT_COLUMNS }] : []),
    ...(snapshot.subcontracts?.length ? [{ title: "عقود الباطن", rows: contractPdfRows(snapshot.subcontracts), columns: CONTRACT_COLUMNS }] : []),
  ];
  await exportToPDF(
    projectRows(snapshot),
    PROJECT_COLUMNS,
    filename,
    "تقرير مشروع مقاولات",
    snapshot.project.nameAr || snapshot.project.nameEn || snapshot.project.code || "",
    false,
    null,
    null,
    snapshot.company?.logo,
    extraSections,
    snapshot.company,
  );
}

export async function exportContractingProjectsReportWorkbook(
  projects: ContractingProjectSnapshot[],
  company?: ContractingCompany | null,
  filename = "تقرير-مشاريع-المقاولات",
): Promise<void> {
  await exportToExcelBranded(projectReportRows(projects), PROJECT_COLUMNS, filename, {
    sheetName: "المشاريع",
    company,
    title: "تقرير مشاريع المقاولات",
  });
}

export async function exportContractingProjectsReportPdf(
  projects: ContractingProjectSnapshot[],
  company?: ContractingCompany | null,
  filename = "تقرير-مشاريع-المقاولات",
): Promise<void> {
  await exportToPDF(
    projectReportRows(projects),
    PROJECT_COLUMNS,
    filename,
    "تقرير مشاريع المقاولات",
    "بيانات المشاريع من نطاق الشركة والفروع المصرح بها",
    false,
    null,
    null,
    company?.logo,
    null,
    company,
  );
}

export async function printContractingProjectsReport(
  projects: ContractingProjectSnapshot[],
  company?: ContractingCompany | null,
  filename = "تقرير-مشاريع-المقاولات",
): Promise<void> {
  await exportToPDF(
    projectReportRows(projects),
    PROJECT_COLUMNS,
    filename,
    "تقرير مشاريع المقاولات",
    "بيانات المشاريع من نطاق الشركة والفروع المصرح بها",
    true,
    null,
    null,
    company?.logo,
    null,
    company,
  );
}

export async function exportContractingContractsWorkbook(
  contracts: ContractingContractSnapshot[],
  kind: "owner" | "subcontract",
  company?: ContractingCompany | null,
  filename = kind === "owner" ? "عقود-المالك" : "عقود-الباطن",
): Promise<void> {
  await exportToExcelBranded(contractRows(contracts), CONTRACT_COLUMNS, filename, {
    sheetName: kind === "owner" ? "عقود المالك" : "عقود الباطن",
    company,
    title: kind === "owner" ? "عقود المالك" : "عقود المقاولين الباطنين",
  });
}

export async function exportContractingContractsPdf(
  contracts: ContractingContractSnapshot[],
  kind: "owner" | "subcontract",
  company?: ContractingCompany | null,
  filename = kind === "owner" ? "عقود-المالك" : "عقود-الباطن",
): Promise<void> {
  await exportToPDF(
    contractPdfRows(contracts),
    CONTRACT_COLUMNS,
    filename,
    kind === "owner" ? "عقود المالك" : "عقود المقاولين الباطنين",
    "بيانات العقود المحفوظة للمشروع",
    false,
    null,
    null,
    company?.logo,
    null,
    company,
  );
}

export async function printContractingContracts(
  contracts: ContractingContractSnapshot[],
  kind: "owner" | "subcontract",
  company?: ContractingCompany | null,
  filename = kind === "owner" ? "عقود-المالك" : "عقود-الباطن",
): Promise<void> {
  await exportToPDF(
    contractPdfRows(contracts),
    CONTRACT_COLUMNS,
    filename,
    kind === "owner" ? "عقود المالك" : "عقود المقاولين الباطنين",
    "بيانات العقود المحفوظة للمشروع",
    true,
    null,
    null,
    company?.logo,
    null,
    company,
  );
}

export async function printContractingProject(
  snapshot: ContractingProjectExportSnapshot,
  filename = `مشروع-${snapshot.project.code || snapshot.project.id}`,
): Promise<void> {
  const extraSections = [
    ...(snapshot.ownerContracts?.length ? [{ title: "عقود المالك", rows: contractPdfRows(snapshot.ownerContracts), columns: CONTRACT_COLUMNS }] : []),
    ...(snapshot.subcontracts?.length ? [{ title: "عقود الباطن", rows: contractPdfRows(snapshot.subcontracts), columns: CONTRACT_COLUMNS }] : []),
  ];
  await exportToPDF(
    projectRows(snapshot),
    PROJECT_COLUMNS,
    filename,
    "تقرير مشروع مقاولات",
    snapshot.project.nameAr || snapshot.project.nameEn || snapshot.project.code || "",
    true,
    null,
    null,
    snapshot.company?.logo,
    extraSections,
    snapshot.company,
  );
}

export async function exportContractingBillWorkbook(
  snapshot: ContractingBillPrintSnapshot,
  filename = `مستخلص-${snapshot.bill.billNumber}`,
): Promise<void> {
  await exportToExcelBranded(buildContractingBillExportRows(snapshot), CONTRACTING_BILL_COLUMNS, filename, {
    sheetName: "المستخلص",
    totalsRow: billTotalsRow(snapshot),
    company: snapshot.company,
    title: CONTRACTING_MODEL14_DOCUMENT_MAP[snapshot.bill.direction].titleAr,
    subtitle: `رقم المستخلص: ${text(snapshot.bill.billNumber)} — ${text(snapshot.bill.billDate)}`,
  });
}

export async function exportContractingBillsReportWorkbook(
  rows: ContractingBillSnapshot[],
  company?: ContractingCompany | null,
  filename = "تقرير-مستخلصات-المقاولات",
): Promise<void> {
  const workbookRows = rows.map(row => reportRow(row));
  const totals: Record<string, unknown> = {
    recordType: "عدد السجلات",
    billNumber: rows.length,
    grossWorks: rows.reduce((sum, row) => sum + numberValue(row.grossWorks ?? row.grossAmount), 0),
  };
  await exportToExcelBranded(workbookRows, CONTRACTING_BILL_COLUMNS, filename, {
    sheetName: "تقرير المستخلصات",
    totalsRow: totals,
    company,
    title: "تقرير مستخلصات المقاولات",
  });
}

export async function exportContractingBillsReportPdf(
  rows: ContractingBillSnapshot[],
  company?: ContractingCompany | null,
  filename = "تقرير-مستخلصات-المقاولات",
): Promise<void> {
  const reportRows = rows.map(row => reportRow(row));
  await exportToPDF(
    reportRows,
    CONTRACTING_BILL_COLUMNS,
    filename,
    "تقرير مستخلصات المقاولات",
    "بيانات التقرير من نطاق الشركة والفروع المصرح بها",
    false,
    null,
    null,
    company?.logo,
    null,
    company,
    { fitOneLine: true },
  );
}

export async function printContractingBillsReport(
  rows: ContractingBillSnapshot[],
  company?: ContractingCompany | null,
  filename = "تقرير-مستخلصات-المقاولات",
): Promise<void> {
  await exportToPDF(
    rows.map(row => reportRow(row)),
    CONTRACTING_BILL_COLUMNS,
    filename,
    "تقرير مستخلصات المقاولات",
    "بيانات التقرير من نطاق الشركة والفروع المصرح بها",
    true,
    null,
    null,
    company?.logo,
    null,
    company,
    { fitOneLine: true },
  );
}

export function buildContractingReportColumns(): ExportColumn[] {
  return CONTRACTING_BILL_COLUMNS.map(column => ({ ...column }));
}

export type ContractingProjectReportKey =
  | "boqStatement"
  | "executedQuantities"
  | "bills"
  | "cumulative"
  | "advance"
  | "retention"
  | "deductions"
  | "variations"
  | "profitability";

export interface ContractingProjectReportsSnapshot {
  project?: {
    id?: number;
    code?: string | null;
    nameAr?: string | null;
  } | null;
  reports?: Partial<Record<ContractingProjectReportKey, unknown>>;
}

const PROJECT_REPORT_COLUMNS: Record<ContractingProjectReportKey, ExportColumn[]> = {
  boqStatement: [
    { key: "direction", header: "الاتجاه", width: 14 },
    { key: "lineCode", header: "كود البند", width: 18 },
    { key: "description", header: "الوصف", width: 28 },
    { key: "unit", header: "الوحدة", width: 12 },
    { key: "contractQuantity", header: "كمية العقد", width: 14, numFmt: "#,##0.###" },
    { key: "priorQuantity", header: "الكمية السابقة", width: 14, numFmt: "#,##0.###" },
    { key: "currentQuantity", header: "الكمية الحالية", width: 14, numFmt: "#,##0.###" },
    { key: "cumulativeQuantity", header: "الكمية التراكمية", width: 16, numFmt: "#,##0.###" },
    { key: "remainingQuantity", header: "الكمية المتبقية", width: 16, numFmt: "#,##0.###" },
    { key: "contractValue", header: "قيمة العقد", width: 16, numFmt: "#,##0.00" },
    { key: "priorValue", header: "قيمة السابق", width: 16, numFmt: "#,##0.00" },
    { key: "currentValue", header: "قيمة الحالي", width: 16, numFmt: "#,##0.00" },
    { key: "cumulativeValue", header: "القيمة التراكمية", width: 18, numFmt: "#,##0.00" },
    { key: "remainingValue", header: "القيمة المتبقية", width: 18, numFmt: "#,##0.00" },
    { key: "completionPercent", header: "الإنجاز %", width: 13, numFmt: "0.00" },
    { key: "latestBillStatus", header: "حالة آخر مستخلص", width: 18 },
  ],
  executedQuantities: [],
  bills: [
    { key: "billNumber", header: "رقم المستخلص", width: 18 },
    { key: "billDate", header: "التاريخ", width: 14 },
    { key: "direction", header: "الاتجاه", width: 15 },
    { key: "status", header: "الحالة", width: 16 },
    { key: "grossWorks", header: "الأعمال التراكمية", width: 18, numFmt: "#,##0.00" },
    { key: "currentWorks", header: "الأعمال الحالية", width: 16, numFmt: "#,##0.00" },
    { key: "cumulativeWorks", header: "الأعمال التراكمية", width: 18, numFmt: "#,##0.00" },
    { key: "retentions", header: "المحتجز", width: 14, numFmt: "#,##0.00" },
    { key: "additions", header: "الإضافات", width: 14, numFmt: "#,##0.00" },
    { key: "deductions", header: "الاستقطاعات", width: 14, numFmt: "#,##0.00" },
    { key: "penalties", header: "الغرامات", width: 14, numFmt: "#,##0.00" },
    { key: "signedAdjustmentAmount", header: "أثر التسوية الصافي", width: 18, numFmt: "#,##0.00" },
    { key: "netAmount", header: "الصافي", width: 16, numFmt: "#,##0.00" },
    { key: "actualPaid", header: "المدفوع فعلياً", width: 16, numFmt: "#,##0.00" },
    { key: "dueAmount", header: "المستحق", width: 16, numFmt: "#,##0.00" },
    { key: "settlementStatus", header: "حالة التسوية", width: 18 },
  ],
  cumulative: [
    { key: "billNumber", header: "رقم المستخلص", width: 18 },
    { key: "billDate", header: "التاريخ", width: 14 },
    { key: "direction", header: "الاتجاه", width: 15 },
    { key: "status", header: "الحالة", width: 16 },
    { key: "previousValue", header: "الأعمال السابقة", width: 17, numFmt: "#,##0.00" },
    { key: "currentValue", header: "الأعمال الحالية", width: 17, numFmt: "#,##0.00" },
    { key: "cumulativeValue", header: "الأعمال التراكمية", width: 19, numFmt: "#,##0.00" },
    { key: "remainingValue", header: "الأعمال المتبقية", width: 18, numFmt: "#,##0.00" },
    { key: "completionPercent", header: "الإنجاز %", width: 13, numFmt: "0.00" },
    { key: "actualPaid", header: "المدفوع فعلياً", width: 16, numFmt: "#,##0.00" },
    { key: "dueAmount", header: "المستحق", width: 16, numFmt: "#,##0.00" },
    { key: "settlementStatus", header: "حالة التسوية", width: 18 },
  ],
  advance: [
    { key: "settlementDate", header: "تاريخ التسوية", width: 16 },
    { key: "billNumber", header: "رقم المستخلص", width: 18 },
    { key: "direction", header: "الاتجاه", width: 15 },
    { key: "kind", header: "نوع الحركة", width: 20 },
    { key: "amount", header: "المبلغ", width: 16, numFmt: "#,##0.00" },
    { key: "appliedAmount", header: "المطبق", width: 16, numFmt: "#,##0.00" },
    { key: "statusLabel", header: "حالة التسوية", width: 18 },
    { key: "notes", header: "ملاحظات", width: 28 },
  ],
  retention: [
    { key: "billNumber", header: "رقم المستخلص", width: 18 },
    { key: "billDate", header: "التاريخ", width: 14 },
    { key: "direction", header: "الاتجاه", width: 15 },
    { key: "status", header: "الحالة", width: 16 },
    { key: "retention", header: "المحتجز", width: 16, numFmt: "#,##0.00" },
    { key: "released", header: "المفرج عنه", width: 16, numFmt: "#,##0.00" },
    { key: "settlementStatus", header: "حالة التسوية", width: 18 },
  ],
  deductions: [
    { key: "billId", header: "المستخلص", width: 16 },
    { key: "source", header: "المصدر", width: 16 },
    { key: "kind", header: "النوع", width: 18 },
    { key: "reason", header: "السبب", width: 30 },
    { key: "amount", header: "القيمة", width: 16, numFmt: "#,##0.00" },
    { key: "reference", header: "المرجع", width: 20 },
  ],
  variations: [
    { key: "contractNumber", header: "رقم العقد/الأمر", width: 20 },
    { key: "contractType", header: "النوع", width: 16 },
    { key: "status", header: "الحالة", width: 16 },
    { key: "originalValue", header: "القيمة الأصلية", width: 17, numFmt: "#,##0.00" },
    { key: "variationValue", header: "قيمة التغيير", width: 17, numFmt: "#,##0.00" },
    { key: "adjustedValue", header: "القيمة المعدلة", width: 17, numFmt: "#,##0.00" },
  ],
  profitability: [
    { key: "revenue", header: "إيراد المالك المنفذ", width: 21, numFmt: "#,##0.00" },
    { key: "actualCost", header: "التكلفة الفعلية", width: 18, numFmt: "#,##0.00" },
    { key: "estimatedCost", header: "التكلفة التقديرية", width: 18, numFmt: "#,##0.00" },
    { key: "profit", header: "الربح", width: 16, numFmt: "#,##0.00" },
    { key: "marginPercent", header: "الهامش %", width: 14, numFmt: "0.00" },
    { key: "costSource", header: "مصدر التكلفة", width: 28 },
    { key: "note", header: "حدود التقرير", width: 46 },
  ],
};
PROJECT_REPORT_COLUMNS.executedQuantities = PROJECT_REPORT_COLUMNS.boqStatement;

const PROJECT_REPORT_TITLES: Record<ContractingProjectReportKey, string> = {
  boqStatement: "كشف بنود العقد",
  executedQuantities: "كشف الكميات المنفذة",
  bills: "كشف المستخلصات",
  cumulative: "المستخلص التراكمي",
  advance: "كشف الدفعة المقدمة واستردادها",
  retention: "كشف المحتجز",
  deductions: "كشف الاستقطاعات والغرامات والتسويات",
  variations: "مقارنة العقد الأصلي والمعدل",
  profitability: "ربحية المشروع من التكلفة الفعلية المتاحة",
};

function reportRows(
  snapshot: ContractingProjectReportsSnapshot,
  key: ContractingProjectReportKey,
): Record<string, unknown>[] {
  const value = snapshot.reports?.[key];
  if (key === "profitability") return value && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

export function buildContractingProjectReportRows(
  snapshot: ContractingProjectReportsSnapshot,
  key: ContractingProjectReportKey,
): Record<string, unknown>[] {
  return reportRows(snapshot, key);
}

export async function exportContractingProjectReportWorkbook(
  snapshot: ContractingProjectReportsSnapshot,
  key: ContractingProjectReportKey,
  company?: ContractingCompany | null,
  filename = `تقرير-المشروع-${snapshot.project?.code || snapshot.project?.id || "project"}`,
): Promise<void> {
  await exportToExcelBranded(reportRows(snapshot, key), PROJECT_REPORT_COLUMNS[key], filename, {
    sheetName: "تقرير المشروع",
    company,
    title: PROJECT_REPORT_TITLES[key],
    subtitle: snapshot.project?.nameAr || snapshot.project?.code || "",
  });
}

export async function exportContractingProjectReportPdf(
  snapshot: ContractingProjectReportsSnapshot,
  key: ContractingProjectReportKey,
  company?: ContractingCompany | null,
  filename = `تقرير-المشروع-${snapshot.project?.code || snapshot.project?.id || "project"}`,
): Promise<void> {
  await exportToPDF(
    reportRows(snapshot, key),
    PROJECT_REPORT_COLUMNS[key],
    filename,
    PROJECT_REPORT_TITLES[key],
    snapshot.project?.nameAr || snapshot.project?.code || "بيانات المشروع",
    false,
    null,
    null,
    company?.logo,
    null,
    company,
    { fitOneLine: true },
  );
}

export async function printContractingProjectReport(
  snapshot: ContractingProjectReportsSnapshot,
  key: ContractingProjectReportKey,
  company?: ContractingCompany | null,
  filename = `تقرير-المشروع-${snapshot.project?.code || snapshot.project?.id || "project"}`,
): Promise<void> {
  await exportToPDF(
    reportRows(snapshot, key),
    PROJECT_REPORT_COLUMNS[key],
    filename,
    PROJECT_REPORT_TITLES[key],
    snapshot.project?.nameAr || snapshot.project?.code || "بيانات المشروع",
    true,
    null,
    null,
    company?.logo,
    null,
    company,
    { fitOneLine: true },
  );
}

export function contractingProjectReportTitle(key: ContractingProjectReportKey): string {
  return PROJECT_REPORT_TITLES[key];
}
