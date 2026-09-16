import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { FileText, Pencil, Plus, Trash2, UploadCloud } from "lucide-react";
import { ContractingBillExportActions } from "@/components/ContractingExportActions";
import type { ContractingBillSnapshot, ContractingProjectSnapshot } from "@/lib/contractingPrintExport";

const API = import.meta.env.VITE_API_URL || "";

type WorkItem = {
  id: number;
  code: string | null;
  nameAr: string;
  unit: string;
  plannedQty: string;
  unitCost: string;
  totalPlannedCost: string;
};

type BoqLine = {
  id: number;
  workItemId: number;
  direction: "owner" | "subcontract";
  ownerContractId: number | null;
  subcontractorContractId: number | null;
  sourceOwnerLineId: number | null;
  lineCode: string | null;
  unit: string;
  quantity: string;
  unitPrice: string;
  totalAmount: string;
  workItemCode: string | null;
  workItemName: string | null;
};

type BillLine = {
  id: number | null;
  workItemId: number | null;
  boqLineId: number | null;
  boqLineCode: string | null;
  boqLineDescription: string | null;
  boqUnitPrice: string | null;
  contractQty: string | null;
  contractAmount: string | null;
  remainingQty?: string;
  completionPercent?: number;
  unitSnapshot: string | null;
  unitPriceSnapshot: string | null;
  changeOrderId: number | null;
  changeOrderSubcontractId: number | null;
  changeOrderNumber: string | null;
  changeOrderValue: string | null;
  changeOrderStatus: string | null;
  workItemName: string | null;
  workItemCode: string | null;
  unit: string | null;
  previousQty: string;
  currentQty: string;
  cumulativeQty: string;
  previousValue: string;
  currentValue: string;
  cumulativeValue: string;
  excessApproved: boolean;
  excessApprovalReason: string | null;
};

type Deduction = {
  id: number;
  deductionKey: string;
  kind: string;
  percentage: string | null;
  amount: string;
  reason: string;
  reference: string | null;
  notes: string | null;
};

type Addition = {
  id: number;
  additionKey: string;
  calculationType: "fixed" | "rate";
  rate: string | null;
  baseType: string;
  baseAmount: string;
  amount: string;
  reason: string;
  referenceType: "attachment" | "variation";
  reference: string;
  taxTreatment: string;
  accountMappingKey: string;
  notes: string | null;
};

type Penalty = {
  id: number;
  penaltyKey: string;
  penaltyType: string;
  reason: string;
  amount: string;
  penaltyDate: string;
  reference: string | null;
  notes: string | null;
  accountMappingKey: string | null;
};

type Attachment = {
  id: number;
  category: string;
  filename: string;
  objectPath: string;
  contentType: string | null;
  bytes: number | null;
};

type DeductionDraft = {
  kind: string;
  percentage: string;
  amount: string;
  reason: string;
  reference: string;
  notes: string;
};

type AdditionDraft = {
  calculationType: "fixed" | "rate";
  rate: string;
  baseType: string;
  baseAmount: string;
  amount: string;
  reason: string;
  referenceType: "attachment" | "variation";
  reference: string;
  taxTreatment: "non_taxable_settlement_adjustment";
  accountMappingKey: string;
  notes: string;
};

type PenaltyDraft = {
  penaltyType: string;
  reason: string;
  amount: string;
  penaltyDate: string;
  reference: string;
  notes: string;
  accountMappingKey: string;
};

type Detail = {
  state: string;
  bill: {
    direction: "outgoing" | "incoming";
    ownerContractId: number | null;
    subcontractorContractId: number | null;
  };
  lines: BillLine[];
  additions: Addition[];
  deductions: Deduction[];
  penalties: Penalty[];
  attachments: Attachment[];
  workflow: Array<{ id: number; state: string; action: string; note: string | null; createdAt: string }>;
  contracts?: {
    owner: Array<{ id: number; contractNumber: string; contractType: string; status: string; value: string; parentContractId: number | null }>;
    subcontractor?: Array<{ id: number; contractNumber: string; contractType: string; status: string; value: string; parentContractId: number | null }>;
  };
  approvedVariations?: Array<{
    id: number;
    contractNumber: string;
    value: string;
    status: string;
    direction: "owner" | "subcontract";
    parentContractId: number | null;
    signedAt: string | null;
  }>;
  summary: {
    grossWorks: number;
    originalContractValue: number;
    changeOrdersValue: number;
    adjustedContractValue: number;
    previousWorks: number;
    currentWorks: number;
    cumulativeWorks: number;
    remainingContractValue: number;
    cumulativeCompletionPercent: number;
    deductionsTotal: number;
    additionsTotal: number;
    generalDeductionsTotal: number;
    retentionAmount: number;
    penaltyTotal: number;
    rawNetAmount: number;
    signedAdjustmentAmount: number;
    netBeforeTax: number;
    vatAmount: number;
    netAmount: number;
    adjustedNetAmount: number;
    paidAmount: number;
    remainingAmount: number;
    advanceRecovery?: {
      enabled: boolean;
      eligible: boolean;
      startReached: boolean;
      progressPercent: string;
      startProgressPercent: string;
      advanceRecoveryPercent: string;
      currentCertifiedWorkBeforeVat: string;
      actualAdvanceRemaining: string;
      requestedRecoveryAmount: string;
      recoveryAmount: string;
      remainingAdvanceAfter: string;
    };
  };
};

const STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  submitted: "مُرسل",
  under_review: "قيد المراجعة",
  approved: "معتمد",
  posted: "مرحّل",
  partially_paid: "مدفوع جزئياً",
  paid: "مدفوع",
  rejected: "مرفوض",
  reversed: "معكوس — مسودة تصحيح مطلوبة",
};

function newKey(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function money(value: number): string {
  return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const DEDUCTION_KIND_ITEMS: ComboboxItem[] = [
  { value: "materials", label: "مواد / عهد" },
  { value: "settlement", label: "تسوية" },
  { value: "other", label: "أخرى" },
];

const ADDITION_CALCULATION_ITEMS: ComboboxItem[] = [
  { value: "fixed", label: "مبلغ ثابت" },
  { value: "rate", label: "نسبة من أساس صريح" },
];

const ADDITION_BASE_ITEMS: ComboboxItem[] = [
  { value: "current_works", label: "الأعمال الحالية" },
  { value: "gross_works", label: "إجمالي الأعمال التراكمي" },
  { value: "contract_value", label: "قيمة العقد المعدلة" },
  { value: "custom", label: "أساس مخصص موثق" },
];

const ADDITION_REFERENCE_ITEMS: ComboboxItem[] = [
  { value: "attachment", label: "مرفق" },
  { value: "variation", label: "مرجع تغيير / مطالبة" },
];

const ATTACHMENT_CATEGORY_ITEMS: ComboboxItem[] = [
  { value: "invoice", label: "فاتورة" },
  { value: "completion_certificate", label: "شهادة إنجاز" },
  { value: "handover", label: "محضر استلام" },
  { value: "penalty", label: "مستند غرامة" },
  { value: "other", label: "أخرى" },
];

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-slate-600">{label}</label>
      {children}
    </div>
  );
}

function BillDetailPicker({
  items,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyText = "لا توجد نتائج",
  className,
  testId,
  disabled = false,
}: {
  items: ComboboxItem[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <SearchCombobox
      className={className}
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

export default function ContractingBillDetailEditor({
  billId,
  projectId,
  bill,
  project,
}: {
  billId: number;
  projectId: number;
  bill?: Partial<ContractingBillSnapshot>;
  project?: ContractingProjectSnapshot;
}) {
  const { token, user } = useAuth() as any;
  const { toast } = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [boqLines, setBoqLines] = useState<BoqLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [line, setLine] = useState({ boqLineId: "", changeOrderId: "", currentQty: "0", currentValue: "0", excessApproved: false, excessApprovalReason: "" });
  const [editingLineId, setEditingLineId] = useState<number | null>(null);
  const [lineQuantities, setLineQuantities] = useState<Record<number, string>>({});
  const [lineVariations, setLineVariations] = useState<Record<number, string>>({});
  const [addition, setAddition] = useState<AdditionDraft>({
    calculationType: "fixed",
    rate: "",
    baseType: "current_works",
    baseAmount: "0",
    amount: "0",
    reason: "",
    referenceType: "attachment",
    reference: "",
    taxTreatment: "non_taxable_settlement_adjustment",
    accountMappingKey: "",
    notes: "",
  });
  const [editingAddition, setEditingAddition] = useState<{ id: number; draft: AdditionDraft } | null>(null);
  const [deduction, setDeduction] = useState<DeductionDraft>({
    kind: "materials", percentage: "", amount: "0", reason: "", reference: "", notes: "",
  });
  const [editingDeduction, setEditingDeduction] = useState<{ id: number; draft: DeductionDraft } | null>(null);
  const [penalty, setPenalty] = useState<PenaltyDraft>({
    penaltyType: "other", reason: "", amount: "0", penaltyDate: new Date().toISOString().slice(0, 10),
    reference: "", notes: "", accountMappingKey: "",
  });
  const [editingPenalty, setEditingPenalty] = useState<{ id: number; draft: PenaltyDraft } | null>(null);
  const [workflowState, setWorkflowState] = useState("");
  const [transitioning, setTransitioning] = useState(false);
  const [fileCategory, setFileCategory] = useState("other");
  const [editingAttachment, setEditingAttachment] = useState<{ id: number; category: string; filename: string } | null>(null);
  const [savingEdit, setSavingEdit] = useState<"addition" | "deduction" | "penalty" | "attachment" | null>(null);
  const [uploading, setUploading] = useState(false);

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }), [token]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const detailResponse = await fetch(`${API}/api/contracting/bills/${billId}/details`, { headers });
      if (!detailResponse.ok) throw new Error((await detailResponse.json()).error || `HTTP ${detailResponse.status}`);
      const next = await detailResponse.json();
      setDetail(next);
      setWorkflowState(next.state);
      setLineQuantities(Object.fromEntries(
        (next.lines ?? [])
          .filter((row: BillLine) => row.boqLineId != null)
          .map((row: BillLine) => [row.boqLineId, String(row.currentQty ?? "0")]),
      ));
      setLineVariations(Object.fromEntries(
        (next.lines ?? [])
          .filter((row: BillLine) => row.boqLineId != null)
          .map((row: BillLine) => [
            row.boqLineId,
            row.changeOrderId ?? row.changeOrderSubcontractId
              ? String(row.changeOrderId ?? row.changeOrderSubcontractId)
              : "__none__",
          ]),
      ));
      const contractId = next.bill.direction === "incoming"
        ? next.bill.subcontractorContractId
        : next.bill.ownerContractId;
      if (contractId != null) {
        const contractParam = next.bill.direction === "incoming"
          ? `subcontractorContractId=${contractId}`
          : `ownerContractId=${contractId}`;
        const boqResponse = await fetch(
          `${API}/api/contracting/projects/${projectId}/boq-lines?direction=${next.bill.direction === "incoming" ? "subcontract" : "owner"}&${contractParam}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (boqResponse.ok) setBoqLines(await boqResponse.json());
      } else {
        setBoqLines([]);
      }
    } catch (caught: any) {
      toast({ title: caught?.message || "تعذر تحميل تفاصيل المستخلص", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [billId, headers, projectId, toast, token]);

  useEffect(() => { void load(); }, [load]);

  async function request(path: string, method: string, body?: unknown) {
    const response = await fetch(`${API}/api/contracting${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return response.json();
  }

  async function addLine() {
    const selected = boqLines.find(item => String(item.id) === line.boqLineId);
    if (!selected) {
      toast({ title: "اختر سطر جدول كميات من العقد المحدد", variant: "destructive" });
      return;
    }
    try {
      const payload = {
        boqLineId: selected.id,
        currentQty: line.currentQty,
        currentValue: Number(line.currentQty || 0) * Number(selected.unitPrice || 0),
        changeOrderId: line.changeOrderId || null,
        excessApproved: line.excessApproved,
        excessApprovalReason: line.excessApprovalReason,
      };
      await request(editingLineId == null ? `/bills/${billId}/lines` : `/bill-lines/${editingLineId}`, editingLineId == null ? "POST" : "PUT", payload);
      setLine({ boqLineId: "", changeOrderId: "", currentQty: "0", currentValue: "0", excessApproved: false, excessApprovalReason: "" });
      setEditingLineId(null);
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
    }
  }

  async function saveAllLines() {
    if (locked || !detail) return;
    try {
      await request(`/bills/${billId}/lines`, "POST", {
        lines: detail?.lines
          .filter((row) => row.boqLineId != null)
          .map((row) => ({
            boqLineId: row.boqLineId,
            currentQty: lineQuantities[row.boqLineId!] ?? "0",
            approvedChangeOrderId: (lineVariations[row.boqLineId!] ?? "__none__") === "__none__"
              ? null
              : Number(lineVariations[row.boqLineId!]),
          })),
      });
      await load();
      toast({ title: "تم حفظ كميات المستخلص وإعادة احتساب القيم من الخادم" });
    } catch (caught: any) {
      toast({ title: caught?.message || "تعذر حفظ كميات المستخلص", variant: "destructive" });
    }
  }

  function editLine(row: BillLine) {
    if (row.boqLineId == null) {
      toast({ title: "السطر legacy لا يملك ربطاً بجدول كميات؛ لا يمكن تعيينه تلقائياً", variant: "destructive" });
      return;
    }
    setEditingLineId(row.id);
    setLine({
      boqLineId: String(row.boqLineId),
      changeOrderId: row.changeOrderId == null ? "" : String(row.changeOrderId),
      currentQty: row.currentQty,
      currentValue: row.currentValue,
      excessApproved: row.excessApproved,
      excessApprovalReason: row.excessApprovalReason ?? "",
    });
  }

  async function remove(path: string) {
    if (!confirm("تأكيد الحذف؟")) return;
    try {
      await request(path, "DELETE");
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
    }
  }

  async function addAddition() {
    if (!addition.reason.trim() || !addition.reference.trim() || !addition.accountMappingKey.trim()) {
      toast({ title: "سبب الإضافة والمرجع ومفتاح الحساب مطلوبة", variant: "destructive" });
      return;
    }
    if (addition.calculationType === "rate" && !addition.rate.trim()) {
      toast({ title: "نسبة الإضافة مطلوبة", variant: "destructive" });
      return;
    }
    try {
      await request(`/bills/${billId}/additions`, "POST", {
        ...addition,
        additionKey: newKey("addition"),
      });
      setAddition({
        calculationType: "fixed",
        rate: "",
        baseType: "current_works",
        baseAmount: "0",
        amount: "0",
        reason: "",
        referenceType: "attachment",
        reference: "",
        taxTreatment: "non_taxable_settlement_adjustment",
        accountMappingKey: "",
        notes: "",
      });
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
    }
  }

  async function updateAddition() {
    if (!editingAddition) return;
    if (!editingAddition.draft.reason.trim() || !editingAddition.draft.reference.trim() || !editingAddition.draft.accountMappingKey.trim()) {
      toast({ title: "سبب الإضافة والمرجع ومفتاح الحساب مطلوبة", variant: "destructive" });
      return;
    }
    try {
      setSavingEdit("addition");
      await request(`/bill-additions/${editingAddition.id}`, "PUT", editingAddition.draft);
      setEditingAddition(null);
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
    } finally {
      setSavingEdit(null);
    }
  }

  async function addDeduction() {
    if (!deduction.reason.trim()) {
      toast({ title: "سبب الاستقطاع مطلوب", variant: "destructive" });
      return;
    }
    try {
      await request(`/bills/${billId}/deductions`, "POST", {
        ...deduction,
        deductionKey: newKey("deduction"),
      });
      setDeduction({ kind: "materials", percentage: "", amount: "0", reason: "", reference: "", notes: "" });
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
    }
  }

  async function addPenalty() {
    if (!penalty.reason.trim()) {
      toast({ title: "سبب الغرامة مطلوب", variant: "destructive" });
      return;
    }
    try {
      await request(`/bills/${billId}/penalties`, "POST", {
        ...penalty,
        penaltyKey: newKey("penalty"),
      });
      setPenalty({
        penaltyType: "other", reason: "", amount: "0", penaltyDate: new Date().toISOString().slice(0, 10),
        reference: "", notes: "", accountMappingKey: "",
      });
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
    }
  }

  async function updateDeduction() {
    if (!editingDeduction || !editingDeduction.draft.reason.trim()) {
      toast({ title: "سبب الاستقطاع مطلوب", variant: "destructive" });
      return;
    }
    try {
      setSavingEdit("deduction");
      await request(`/bill-deductions/${editingDeduction.id}`, "PUT", editingDeduction.draft);
      setEditingDeduction(null);
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
    } finally {
      setSavingEdit(null);
    }
  }

  async function updatePenalty() {
    if (!editingPenalty || !editingPenalty.draft.reason.trim()) {
      toast({ title: "سبب الغرامة مطلوب", variant: "destructive" });
      return;
    }
    try {
      setSavingEdit("penalty");
      await request(`/bill-penalties/${editingPenalty.id}`, "PUT", editingPenalty.draft);
      setEditingPenalty(null);
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
    } finally {
      setSavingEdit(null);
    }
  }

  async function updateAttachment() {
    if (!editingAttachment || !editingAttachment.filename.trim()) {
      toast({ title: "اسم الملف مطلوب", variant: "destructive" });
      return;
    }
    try {
      setSavingEdit("attachment");
      await request(`/bill-attachments/${editingAttachment.id}`, "PUT", {
        category: editingAttachment.category,
        filename: editingAttachment.filename.trim(),
      });
      setEditingAttachment(null);
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
    } finally {
      setSavingEdit(null);
    }
  }

  async function transition() {
    if (!workflowState || workflowState === detail?.state) return;
    try {
      setTransitioning(true);
      await request(`/bills/${billId}/workflow`, "POST", { state: workflowState });
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
      setWorkflowState(detail?.state || "");
    } finally {
      setTransitioning(false);
    }
  }

  async function uploadAttachment(file: File) {
    setUploading(true);
    try {
      // The server creates a bill/uploader-bound namespace. Generic
      // /objects/uploads paths are deliberately rejected by the API.
      const uploadResponse = await fetch(`${API}/api/contracting/bills/${billId}/attachments/upload-url`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" }),
      });
      if (!uploadResponse.ok) throw new Error((await uploadResponse.json()).error || `HTTP ${uploadResponse.status}`);
      const upload = await uploadResponse.json();
      const uploadUrl = String(upload.uploadURL).startsWith("http")
        ? String(upload.uploadURL)
        : `${API}${upload.uploadURL}`;
      const putHeaders: Record<string, string> = { "Content-Type": file.type || "application/octet-stream" };
      if (upload.direct) {
        putHeaders["Authorization"] = `Bearer ${token}`;
        putHeaders["X-Zacod-Upload-Size"] = String(file.size);
      }
      const put = await fetch(uploadUrl, { method: "PUT", headers: putHeaders, body: file });
      if (!put.ok) throw new Error("تعذر رفع الملف");
      await request(`/bills/${billId}/attachments`, "POST", {
        category: fileCategory,
        filename: file.name,
        objectPath: upload.objectPath,
        contentType: file.type || "application/octet-stream",
        bytes: file.size,
      });
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message || "تعذر حفظ المرفق", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  if (loading || !detail) {
    return <div className="rounded-md border bg-white/50 p-4 text-sm text-slate-500">جار تحميل تفاصيل المستخلص…</div>;
  }
  const locked = ["approved", "posted", "partially_paid", "paid", "reversed"].includes(detail.state);
  const permissions = user?.permissions?.contracting ?? {};
  const can = (capability: string, fallback = "post") =>
    user?.role === "admin" || user?.role === "superadmin"
      || permissions[capability] === true
      || permissions[capability] === undefined && permissions[fallback] === true;
  const candidateStates = detail.state === "draft"
    ? [["submitted", "edit"], ["rejected", "cancel"]]
    : detail.state === "submitted"
      ? [["under_review", "review"], ["rejected", "cancel"]]
      : detail.state === "under_review"
        ? [["approved", "approve"], ["rejected", "cancel"]]
        : detail.state === "approved"
          ? [["posted", "post"]]
          : detail.state === "rejected" ? [["draft", "edit"]] : [];
  const nextStates = candidateStates
    .filter(([, capability]) => can(capability))
    .map(([state]) => state);
  const approvedVariationItems: ComboboxItem[] = [
    { value: "__none__", label: "بدون مرجع تغيير" },
    ...(detail.approvedVariations ?? []).map((variation) => ({
      value: String(variation.id),
      label: `#${variation.contractNumber} · ${money(Number(variation.value))} ر.س · موقع ومعتمد`,
    })),
  ];

  return (
    <div className="mt-4 space-y-4" dir="rtl">
      {/* 1. TOP: Metadata / Project context */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div>
          <h4 className="font-bold text-lg flex items-center gap-2">
            تفاصيل المستخلص والرقابة
            {bill?.billNumber && <span className="font-mono text-sm bg-muted text-muted-foreground px-2 py-0.5 rounded">{bill.billNumber}</span>}
          </h4>
          <p className="text-[11px] text-slate-500 mt-1">الكميات السابقة والتراكمية يحسبها الخادم تلقائيًا من المستخلصات المعتمدة السابقة لتجنب الأخطاء البشرية.</p>
          
          {project && (
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="font-medium text-foreground">المشروع:</span> {project.nameAr} {project.code ? `(${project.code})` : ''}</span>
              {detail.bill.direction === "outgoing" ? (
                <span className="flex items-center gap-1.5"><span className="font-medium text-foreground">العميل:</span> {project.clientName || '—'}</span>
              ) : null}
              <span className="flex items-center gap-1.5">
                <span className="font-medium text-foreground">قيمة العقد المعدلة:</span> {money(detail.summary.adjustedContractValue)} ر.س
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant={locked ? "secondary" : "default"} className="text-sm px-3 py-1">{STATUS_LABEL[detail.state] || detail.state}</Badge>
        </div>
      </div>
<section className="space-y-2">
        <div className="flex items-center justify-between">
          <h5 className="font-semibold">بنود المستخلص ({detail.lines.length})</h5>
          {!locked && (
            <Button size="sm" onClick={() => void saveAllLines()} data-testid="bill-details-save">
              حفظ تفاصيل البنود
            </Button>
          )}
        </div>
        <div className="overflow-x-auto rounded border bg-white dark:bg-slate-900 shadow-sm">
          <Table className="min-w-[1100px]">
            <TableHeader className="bg-slate-50 dark:bg-slate-800/50">
              <TableRow>
                <TableHead className="w-1/4">البند</TableHead>
                <TableHead>الوحدة</TableHead>
                <TableHead className="w-[220px]">مرجع التغيير المعتمد</TableHead>
                <TableHead className="text-end">كمية العقد</TableHead>
                <TableHead className="text-end">سابق</TableHead>
                <TableHead className="text-end text-sky-700 dark:text-sky-300 font-bold">حالي</TableHead>
                <TableHead className="text-end">تراكمي</TableHead>
                <TableHead className="text-end">متبقي</TableHead>
                <TableHead className="text-end">الإنجاز</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.lines.map((row) => (
                <TableRow key={row.boqLineId ?? `legacy-${row.id}`} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                  <TableCell>
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {row.boqLineCode && <span className="font-mono text-slate-500 text-xs ml-1">{row.boqLineCode}</span>}
                      {row.workItemCode ? <span className="font-mono text-slate-500 text-xs ml-1">{row.workItemCode}</span> : ""}
                      {row.workItemName || "بند محذوف"}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {row.boqLineId == null && <Badge variant="outline" className="text-[10px] h-5">legacy</Badge>}
                      {row.changeOrderNumber && <Badge variant="secondary" className="text-[10px] h-5 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 border-indigo-200">أمر {row.changeOrderNumber}</Badge>}
                      {row.excessApproved && <Badge variant="outline" className="text-[10px] h-5 border-amber-200 text-amber-700 bg-amber-50">اعتماد تجاوز</Badge>}
                      <span className="text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                        السعر: {money(Number(row.unitPriceSnapshot ?? row.boqUnitPrice ?? 0))} ر.س
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-500">{row.unitSnapshot || row.unit || "—"}</TableCell>
                   <TableCell>
                     {row.boqLineId == null
                       ? <span className="text-xs text-slate-500">legacy — بدون ربط تلقائي</span>
                       : <BillDetailPicker
                           items={approvedVariationItems}
                           value={lineVariations[row.boqLineId] ?? "__none__"}
                           onValueChange={(value) => setLineVariations((current) => ({ ...current, [row.boqLineId!]: value }))}
                           placeholder="بدون تغيير"
                           searchPlaceholder="بحث في أوامر التغيير المعتمدة..."
                           emptyText="لا توجد أوامر تغيير معتمدة لهذا العقد"
                           className="min-w-[190px]"
                           disabled={locked}
                           testId={`bill-line-variation-picker-${row.boqLineId}`}
                         />}
                   </TableCell>
                   <TableCell className="text-end tabular-nums">{Number(row.contractQty ?? 0).toLocaleString()}<div className="text-xs text-slate-500">{money(Number(row.contractAmount ?? 0))}</div></TableCell>
                   <TableCell className="text-end tabular-nums"><div>{Number(row.previousQty).toLocaleString()}</div><div className="text-xs text-slate-500">{money(Number(row.previousValue))}</div></TableCell>
                   <TableCell className="text-end tabular-nums bg-sky-50/30 dark:bg-sky-900/10">
                     {row.boqLineId == null
                       ? <><div className="text-sky-700">{Number(row.currentQty).toLocaleString()}</div><div className="text-xs text-slate-500">{money(Number(row.currentValue))}</div></>
                       : <><Input className="h-8 w-24 text-end" type="number" min="0" value={lineQuantities[row.boqLineId] ?? "0"} disabled={locked} onChange={(event) => setLineQuantities((current) => ({ ...current, [row.boqLineId!]: event.target.value }))} /><div className="text-xs text-sky-700">{money(Number(lineQuantities[row.boqLineId] ?? 0) * Number(row.unitPriceSnapshot ?? row.boqUnitPrice ?? 0))}</div></>}
                   </TableCell>
                   <TableCell className="text-end tabular-nums"><div>{Number(row.cumulativeQty).toLocaleString()}</div><div className="text-xs text-slate-500">{money(Number(row.cumulativeValue))}</div></TableCell>
                   <TableCell className="text-end tabular-nums"><div>{Number(row.remainingQty ?? 0).toLocaleString()}</div><div className="text-xs text-slate-500">{money(Math.max(0, Number(row.contractAmount ?? 0) - Number(row.cumulativeValue ?? 0)))}</div></TableCell>
                   <TableCell className="text-end tabular-nums">{Number(row.completionPercent ?? 0).toFixed(1)}%</TableCell>
                </TableRow>
              ))}
              {detail.lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-slate-500">
                    لا توجد بنود في هذا المستخلص
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>
<section className="space-y-2">
         <div className="flex items-center justify-between">
           <h5 className="font-semibold">الإضافات المالية المعتمدة ({detail.additions.length})</h5>
           <span className="text-[11px] text-slate-500">لا تغيّر VAT؛ التسوية غير الخاضعة مدعومة فقط</span>
         </div>
         {!locked && (
           <div className="grid grid-cols-2 gap-2 rounded border bg-white p-3 dark:bg-slate-900 md:grid-cols-6">
             <DetailField label="طريقة الحساب">
               <BillDetailPicker
                 items={ADDITION_CALCULATION_ITEMS}
                 value={addition.calculationType}
                 onValueChange={(value) => setAddition({ ...addition, calculationType: value as AdditionDraft["calculationType"] })}
                 placeholder="طريقة الحساب"
                 searchPlaceholder="بحث في طرق الحساب..."
                 testId="bill-addition-calculation-picker"
               />
             </DetailField>
             <DetailField label="أساس الإضافة">
               <BillDetailPicker
                 items={ADDITION_BASE_ITEMS}
                 value={addition.baseType}
                 onValueChange={(value) => setAddition({ ...addition, baseType: value })}
                 placeholder="اختر أساساً"
                 searchPlaceholder="بحث في الأسس..."
                 testId="bill-addition-base-picker"
               />
             </DetailField>
             <DetailField label="قيمة الأساس *"><Input data-testid="input-bill-addition-base" type="number" min="0" value={addition.baseAmount} onChange={(e) => setAddition({ ...addition, baseAmount: e.target.value })} /></DetailField>
             {addition.calculationType === "rate"
               ? <DetailField label="النسبة % *"><Input data-testid="input-bill-addition-rate" type="number" min="0" max="100" value={addition.rate} onChange={(e) => setAddition({ ...addition, rate: e.target.value })} /></DetailField>
               : <DetailField label="المبلغ الثابت *"><Input data-testid="input-bill-addition-amount" type="number" min="0" value={addition.amount} onChange={(e) => setAddition({ ...addition, amount: e.target.value })} /></DetailField>}
             <DetailField label="السبب *"><Input data-testid="input-bill-addition-reason" value={addition.reason} onChange={(e) => setAddition({ ...addition, reason: e.target.value })} /></DetailField>
             <DetailField label="نوع المرجع *">
               <BillDetailPicker
                 items={ADDITION_REFERENCE_ITEMS}
                 value={addition.referenceType}
                 onValueChange={(value) => setAddition({ ...addition, referenceType: value as AdditionDraft["referenceType"] })}
                 placeholder="نوع المرجع"
                 searchPlaceholder="بحث في أنواع المراجع..."
                 testId="bill-addition-reference-type-picker"
               />
             </DetailField>
             <DetailField label="مرجع مرفق/تغيير *"><Input data-testid="input-bill-addition-reference" value={addition.reference} onChange={(e) => setAddition({ ...addition, reference: e.target.value })} /></DetailField>
             <DetailField label="مفتاح الحساب *"><Input data-testid="input-bill-addition-account" value={addition.accountMappingKey} onChange={(e) => setAddition({ ...addition, accountMappingKey: e.target.value })} /></DetailField>
             <DetailField label="المعالجة الضريبية"><Input value="تسوية غير خاضعة — VAT محفوظة" readOnly disabled /></DetailField>
             <DetailField label="ملاحظات"><Input data-testid="input-bill-addition-notes" value={addition.notes} onChange={(e) => setAddition({ ...addition, notes: e.target.value })} /></DetailField>
             <div className="flex items-end"><Button className="w-full" size="sm" onClick={() => void addAddition()}><Plus className="mx-1 h-4 w-4" />إضافة مالية</Button></div>
           </div>
         )}
         <div className="space-y-2 text-xs">{detail.additions.map((row) => (
           editingAddition?.id === row.id ? (
             <div key={row.id} className="grid grid-cols-2 gap-2 rounded border bg-white p-3 dark:bg-slate-900 md:grid-cols-7" data-testid={`editor-addition-${row.id}`}>
               <DetailField label="طريقة الحساب">
                 <BillDetailPicker items={ADDITION_CALCULATION_ITEMS} value={editingAddition.draft.calculationType} onValueChange={(value) => setEditingAddition({ ...editingAddition, draft: { ...editingAddition.draft, calculationType: value as AdditionDraft["calculationType"] } })} placeholder="طريقة الحساب" searchPlaceholder="بحث..." testId={`select-edit-addition-calculation-${row.id}`} />
               </DetailField>
               <DetailField label="أساس الإضافة">
                 <BillDetailPicker items={ADDITION_BASE_ITEMS} value={editingAddition.draft.baseType} onValueChange={(value) => setEditingAddition({ ...editingAddition, draft: { ...editingAddition.draft, baseType: value } })} placeholder="الأساس" searchPlaceholder="بحث..." testId={`select-edit-addition-base-${row.id}`} />
               </DetailField>
               <DetailField label="قيمة الأساس *"><Input data-testid={`input-edit-addition-base-${row.id}`} type="number" min="0" value={editingAddition.draft.baseAmount} onChange={(e) => setEditingAddition({ ...editingAddition, draft: { ...editingAddition.draft, baseAmount: e.target.value } })} /></DetailField>
               {editingAddition.draft.calculationType === "rate"
                 ? <DetailField label="النسبة % *"><Input data-testid={`input-edit-addition-rate-${row.id}`} type="number" min="0" max="100" value={editingAddition.draft.rate} onChange={(e) => setEditingAddition({ ...editingAddition, draft: { ...editingAddition.draft, rate: e.target.value } })} /></DetailField>
                 : <DetailField label="المبلغ الثابت *"><Input data-testid={`input-edit-addition-amount-${row.id}`} type="number" min="0" value={editingAddition.draft.amount} onChange={(e) => setEditingAddition({ ...editingAddition, draft: { ...editingAddition.draft, amount: e.target.value } })} /></DetailField>}
               <DetailField label="السبب *"><Input data-testid={`input-edit-addition-reason-${row.id}`} value={editingAddition.draft.reason} onChange={(e) => setEditingAddition({ ...editingAddition, draft: { ...editingAddition.draft, reason: e.target.value } })} /></DetailField>
               <DetailField label="نوع المرجع *"><BillDetailPicker items={ADDITION_REFERENCE_ITEMS} value={editingAddition.draft.referenceType} onValueChange={(value) => setEditingAddition({ ...editingAddition, draft: { ...editingAddition.draft, referenceType: value as AdditionDraft["referenceType"] } })} placeholder="نوع المرجع" searchPlaceholder="بحث..." testId={`select-edit-addition-reference-type-${row.id}`} /></DetailField>
               <DetailField label="مرجع مرفق/تغيير *"><Input data-testid={`input-edit-addition-reference-${row.id}`} value={editingAddition.draft.reference} onChange={(e) => setEditingAddition({ ...editingAddition, draft: { ...editingAddition.draft, reference: e.target.value } })} /></DetailField>
               <DetailField label="مفتاح الحساب *"><Input data-testid={`input-edit-addition-account-${row.id}`} value={editingAddition.draft.accountMappingKey} onChange={(e) => setEditingAddition({ ...editingAddition, draft: { ...editingAddition.draft, accountMappingKey: e.target.value } })} /></DetailField>
               <div className="flex items-end gap-1">
                 <Button size="sm" disabled={savingEdit !== null} onClick={() => void updateAddition()} data-testid={`button-save-addition-${row.id}`}>{savingEdit === "addition" ? "جار الحفظ…" : "حفظ"}</Button>
                 <Button size="sm" variant="outline" disabled={savingEdit !== null} onClick={() => setEditingAddition(null)} data-testid={`button-cancel-addition-${row.id}`}>إلغاء</Button>
               </div>
             </div>
           ) : (
             <div key={row.id} className="flex flex-wrap items-center gap-2 rounded border bg-white px-2 py-1 dark:bg-slate-900" data-testid={`row-addition-${row.id}`}>
               <span>{row.calculationType === "rate" ? `${row.rate}% من ${row.baseType}` : "مبلغ ثابت"} · {row.reason} · {row.referenceType}: {row.reference} · حساب: {row.accountMappingKey}</span>
               <b>{money(Number(row.amount))} ر.س</b>
               <span className="text-slate-500">غير خاضعة — لا تخفيض VAT</span>
               {!locked && <><Button size="sm" variant="ghost" onClick={() => setEditingAddition({
                 id: row.id,
                 draft: {
                   calculationType: row.calculationType,
                   rate: row.rate ?? "",
                   baseType: row.baseType,
                   baseAmount: row.baseAmount,
                   amount: row.amount,
                   reason: row.reason,
                   referenceType: row.referenceType,
                   reference: row.reference,
                   taxTreatment: "non_taxable_settlement_adjustment",
                   accountMappingKey: row.accountMappingKey,
                   notes: row.notes ?? "",
                 },
               })} data-testid={`button-edit-addition-${row.id}`}><Pencil className="h-3 w-3" /></Button><Button size="sm" variant="ghost" onClick={() => void remove(`/bill-additions/${row.id}`)} data-testid={`button-delete-addition-${row.id}`}><Trash2 className="h-3 w-3 text-red-500" /></Button></>}
             </div>
           )
         ))}</div>
       </section>
<section className="space-y-2">
        <h5 className="font-semibold">الاستقطاعات ({detail.deductions.length})</h5>
        {!locked && (
          <div className="grid grid-cols-2 gap-2 rounded border bg-white p-3 md:grid-cols-6 dark:bg-slate-900">
            <DetailField label="النوع">
              <BillDetailPicker
                items={DEDUCTION_KIND_ITEMS}
                value={deduction.kind}
                onValueChange={(value) => setDeduction({ ...deduction, kind: value })}
                placeholder="اختر النوع"
                searchPlaceholder="بحث في أنواع الاستقطاع..."
                testId="bill-deduction-kind-picker"
              />
            </DetailField>
            <DetailField label="النسبة"><Input type="number" min="0" max="100" value={deduction.percentage} onChange={(e) => setDeduction({ ...deduction, percentage: e.target.value })} /></DetailField>
            <DetailField label="القيمة"><Input type="number" min="0" value={deduction.amount} onChange={(e) => setDeduction({ ...deduction, amount: e.target.value })} /></DetailField>
            <DetailField label="السبب"><Input value={deduction.reason} onChange={(e) => setDeduction({ ...deduction, reason: e.target.value })} /></DetailField>
            <DetailField label="المرجع"><Input value={deduction.reference} onChange={(e) => setDeduction({ ...deduction, reference: e.target.value })} /></DetailField>
            <div className="flex items-end"><Button className="w-full" size="sm" onClick={() => void addDeduction()}><Plus className="mx-1 h-4 w-4" />إضافة</Button></div>
          </div>
        )}
        <div className="space-y-2 text-xs">{detail.deductions.map((row) => (
           editingDeduction?.id === row.id && !["retention", "advance"].includes(row.kind) ? (
            <div key={row.id} className="grid grid-cols-2 gap-2 rounded border bg-white p-3 dark:bg-slate-900 md:grid-cols-7" data-testid={`editor-deduction-${row.id}`}>
              <DetailField label="النوع">
                <BillDetailPicker
                  items={DEDUCTION_KIND_ITEMS}
                  value={editingDeduction.draft.kind}
                  onValueChange={(value) => setEditingDeduction({ ...editingDeduction, draft: { ...editingDeduction.draft, kind: value } })}
                  placeholder="اختر النوع"
                  searchPlaceholder="بحث في أنواع الاستقطاع..."
                  testId={`select-edit-deduction-kind-${row.id}`}
                />
              </DetailField>
              <DetailField label="النسبة"><Input data-testid={`input-edit-deduction-percentage-${row.id}`} type="number" min="0" max="100" value={editingDeduction.draft.percentage} onChange={(e) => setEditingDeduction({ ...editingDeduction, draft: { ...editingDeduction.draft, percentage: e.target.value } })} /></DetailField>
              <DetailField label="القيمة"><Input data-testid={`input-edit-deduction-amount-${row.id}`} type="number" min="0" value={editingDeduction.draft.amount} onChange={(e) => setEditingDeduction({ ...editingDeduction, draft: { ...editingDeduction.draft, amount: e.target.value } })} /></DetailField>
              <DetailField label="السبب"><Input data-testid={`input-edit-deduction-reason-${row.id}`} value={editingDeduction.draft.reason} onChange={(e) => setEditingDeduction({ ...editingDeduction, draft: { ...editingDeduction.draft, reason: e.target.value } })} /></DetailField>
              <DetailField label="المرجع"><Input data-testid={`input-edit-deduction-reference-${row.id}`} value={editingDeduction.draft.reference} onChange={(e) => setEditingDeduction({ ...editingDeduction, draft: { ...editingDeduction.draft, reference: e.target.value } })} /></DetailField>
              <DetailField label="الملاحظات"><Input data-testid={`input-edit-deduction-notes-${row.id}`} value={editingDeduction.draft.notes} onChange={(e) => setEditingDeduction({ ...editingDeduction, draft: { ...editingDeduction.draft, notes: e.target.value } })} /></DetailField>
              <div className="flex items-end gap-1">
                <Button size="sm" disabled={savingEdit !== null} onClick={() => void updateDeduction()} data-testid={`button-save-deduction-${row.id}`}>{savingEdit === "deduction" ? "جار الحفظ…" : "حفظ"}</Button>
                <Button size="sm" variant="outline" disabled={savingEdit !== null} onClick={() => setEditingDeduction(null)} data-testid={`button-cancel-deduction-${row.id}`}>إلغاء</Button>
              </div>
            </div>
          ) : (
            <div key={row.id} className="flex items-center gap-2 rounded border bg-white px-2 py-1 dark:bg-slate-900" data-testid={`row-deduction-${row.id}`}>
               <span>{row.kind === "retention" ? "ضمان محسوب" : row.kind === "advance" ? "استرداد سلفة محسوب" : row.kind} · {row.reason}</span><b>{money(Number(row.amount))} ر.س</b>
               {["retention", "advance"].includes(row.kind) && <span className="text-slate-500">سطر للعرض فقط — يُدار من المسار المحاسبي</span>}
               {!locked && !["retention", "advance"].includes(row.kind) && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditingDeduction({
                    id: row.id,
                    draft: {
                      kind: row.kind,
                      percentage: row.percentage ?? "",
                      amount: row.amount,
                      reason: row.reason,
                      reference: row.reference ?? "",
                      notes: row.notes ?? "",
                    },
                  })} data-testid={`button-edit-deduction-${row.id}`}><Pencil className="h-3 w-3" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(`/bill-deductions/${row.id}`)} data-testid={`button-delete-deduction-${row.id}`}><Trash2 className="h-3 w-3 text-red-500" /></Button>
                </>
              )}
            </div>
          )
        ))}</div>
      </section>
<section className="space-y-2">
        <h5 className="font-semibold">الغرامات المستقلة ({detail.penalties.length})</h5>
        {!locked && (
          <div className="grid grid-cols-2 gap-2 rounded border bg-white p-3 md:grid-cols-7 dark:bg-slate-900">
            <DetailField label="النوع"><Input value={penalty.penaltyType} onChange={(e) => setPenalty({ ...penalty, penaltyType: e.target.value })} /></DetailField>
            <DetailField label="السبب"><Input value={penalty.reason} onChange={(e) => setPenalty({ ...penalty, reason: e.target.value })} /></DetailField>
            <DetailField label="القيمة"><Input type="number" min="0" value={penalty.amount} onChange={(e) => setPenalty({ ...penalty, amount: e.target.value })} /></DetailField>
            <DetailField label="التاريخ"><Input type="date" value={penalty.penaltyDate} onChange={(e) => setPenalty({ ...penalty, penaltyDate: e.target.value })} /></DetailField>
            <DetailField label="رقم القرار"><Input value={penalty.reference} onChange={(e) => setPenalty({ ...penalty, reference: e.target.value })} /></DetailField>
            <DetailField label="مفتاح الحساب"><Input value={penalty.accountMappingKey} onChange={(e) => setPenalty({ ...penalty, accountMappingKey: e.target.value })} /></DetailField>
            <div className="flex items-end"><Button className="w-full" size="sm" onClick={() => void addPenalty()}><Plus className="mx-1 h-4 w-4" />إضافة</Button></div>
          </div>
        )}
        <div className="space-y-2 text-xs">{detail.penalties.map((row) => (
          editingPenalty?.id === row.id ? (
            <div key={row.id} className="grid grid-cols-2 gap-2 rounded border bg-white p-3 dark:bg-slate-900 md:grid-cols-8" data-testid={`editor-penalty-${row.id}`}>
              <DetailField label="النوع"><Input data-testid={`input-edit-penalty-type-${row.id}`} value={editingPenalty.draft.penaltyType} onChange={(e) => setEditingPenalty({ ...editingPenalty, draft: { ...editingPenalty.draft, penaltyType: e.target.value } })} /></DetailField>
              <DetailField label="السبب"><Input data-testid={`input-edit-penalty-reason-${row.id}`} value={editingPenalty.draft.reason} onChange={(e) => setEditingPenalty({ ...editingPenalty, draft: { ...editingPenalty.draft, reason: e.target.value } })} /></DetailField>
              <DetailField label="القيمة"><Input data-testid={`input-edit-penalty-amount-${row.id}`} type="number" min="0" value={editingPenalty.draft.amount} onChange={(e) => setEditingPenalty({ ...editingPenalty, draft: { ...editingPenalty.draft, amount: e.target.value } })} /></DetailField>
              <DetailField label="التاريخ"><Input data-testid={`input-edit-penalty-date-${row.id}`} type="date" value={editingPenalty.draft.penaltyDate} onChange={(e) => setEditingPenalty({ ...editingPenalty, draft: { ...editingPenalty.draft, penaltyDate: e.target.value } })} /></DetailField>
              <DetailField label="رقم القرار"><Input data-testid={`input-edit-penalty-reference-${row.id}`} value={editingPenalty.draft.reference} onChange={(e) => setEditingPenalty({ ...editingPenalty, draft: { ...editingPenalty.draft, reference: e.target.value } })} /></DetailField>
              <DetailField label="مفتاح الحساب"><Input data-testid={`input-edit-penalty-account-${row.id}`} value={editingPenalty.draft.accountMappingKey} onChange={(e) => setEditingPenalty({ ...editingPenalty, draft: { ...editingPenalty.draft, accountMappingKey: e.target.value } })} /></DetailField>
              <DetailField label="الملاحظات"><Input data-testid={`input-edit-penalty-notes-${row.id}`} value={editingPenalty.draft.notes} onChange={(e) => setEditingPenalty({ ...editingPenalty, draft: { ...editingPenalty.draft, notes: e.target.value } })} /></DetailField>
              <div className="flex items-end gap-1">
                <Button size="sm" disabled={savingEdit !== null} onClick={() => void updatePenalty()} data-testid={`button-save-penalty-${row.id}`}>{savingEdit === "penalty" ? "جار الحفظ…" : "حفظ"}</Button>
                <Button size="sm" variant="outline" disabled={savingEdit !== null} onClick={() => setEditingPenalty(null)} data-testid={`button-cancel-penalty-${row.id}`}>إلغاء</Button>
              </div>
            </div>
          ) : (
            <div key={row.id} className="flex items-center gap-2 rounded border bg-white px-2 py-1 dark:bg-slate-900" data-testid={`row-penalty-${row.id}`}>
              <span>{row.penaltyType} · {row.reason} · {row.penaltyDate}</span><b>{money(Number(row.amount))} ر.س</b>
              {!locked && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditingPenalty({
                    id: row.id,
                    draft: {
                      penaltyType: row.penaltyType,
                      reason: row.reason,
                      amount: row.amount,
                      penaltyDate: row.penaltyDate,
                      reference: row.reference ?? "",
                      notes: row.notes ?? "",
                      accountMappingKey: row.accountMappingKey ?? "",
                    },
                  })} data-testid={`button-edit-penalty-${row.id}`}><Pencil className="h-3 w-3" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(`/bill-penalties/${row.id}`)} data-testid={`button-delete-penalty-${row.id}`}><Trash2 className="h-3 w-3 text-red-500" /></Button>
                </>
              )}
            </div>
          )
        ))}</div>
      </section>
<section className="space-y-2">
        <div className="flex items-center justify-between"><h5 className="font-semibold"><FileText className="ml-1 inline h-4 w-4" />المرفقات ({detail.attachments.length})</h5></div>
        {!locked && (
          <div className="flex flex-wrap items-end gap-2 rounded border bg-white p-3 dark:bg-slate-900">
            <DetailField label="نوع المرفق">
              <BillDetailPicker
                className="w-48"
                items={ATTACHMENT_CATEGORY_ITEMS}
                value={fileCategory}
                onValueChange={setFileCategory}
                placeholder="اختر نوع المرفق"
                searchPlaceholder="بحث في أنواع المرفقات..."
                testId="bill-attachment-category-picker"
              />
            </DetailField>
            <label className="inline-flex h-9 cursor-pointer items-center rounded-md bg-sky-600 px-3 text-sm text-white hover:bg-sky-700">
              <UploadCloud className="ml-1 h-4 w-4" />{uploading ? "جار الرفع…" : "رفع ملف"}
              <input type="file" className="hidden" disabled={uploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadAttachment(file); e.currentTarget.value = ""; }} />
            </label>
          </div>
        )}
        <div className="space-y-2 text-xs">{detail.attachments.map((row) => (
          editingAttachment?.id === row.id ? (
            <div key={row.id} className="flex flex-wrap items-end gap-2 rounded border bg-white p-3 dark:bg-slate-900" data-testid={`editor-attachment-${row.id}`}>
              <DetailField label="اسم الملف"><Input value={editingAttachment.filename} onChange={(e) => setEditingAttachment({ ...editingAttachment, filename: e.target.value })} data-testid={`input-edit-attachment-filename-${row.id}`} /></DetailField>
              <DetailField label="نوع المرفق">
                <BillDetailPicker
                  className="w-48"
                  items={ATTACHMENT_CATEGORY_ITEMS}
                  value={editingAttachment.category}
                  onValueChange={(value) => setEditingAttachment({ ...editingAttachment, category: value })}
                  placeholder="اختر نوع المرفق"
                  searchPlaceholder="بحث في أنواع المرفقات..."
                  testId={`select-edit-attachment-category-${row.id}`}
                />
              </DetailField>
              <Button size="sm" disabled={savingEdit !== null} onClick={() => void updateAttachment()} data-testid={`button-save-attachment-${row.id}`}>{savingEdit === "attachment" ? "جار الحفظ…" : "حفظ"}</Button>
              <Button size="sm" variant="outline" disabled={savingEdit !== null} onClick={() => setEditingAttachment(null)} data-testid={`button-cancel-attachment-${row.id}`}>إلغاء</Button>
            </div>
          ) : (
            <div key={row.id} className="flex items-center gap-2 rounded border bg-white px-2 py-1 dark:bg-slate-900" data-testid={`row-attachment-${row.id}`}>
              <a className="underline" href={`${API}/api/contracting/bills/${billId}/attachments/${row.id}/download?token=${encodeURIComponent(token)}`} target="_blank" rel="noreferrer">{row.filename} · {row.category}</a>
              {!locked && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditingAttachment({ id: row.id, category: row.category, filename: row.filename })} data-testid={`button-edit-attachment-${row.id}`}><Pencil className="h-3 w-3" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(`/bill-attachments/${row.id}`)} data-testid={`button-delete-attachment-${row.id}`}><Trash2 className="h-3 w-3 text-red-500" /></Button>
                </>
              )}
            </div>
          )
        ))}</div>
      </section>

      {/* 3. BOTTOM: Financial values and adjustments summary */}
      <div className="flex flex-wrap items-start justify-end gap-4 mt-8 pt-4 border-t">
        <div className="w-80 space-y-2 text-sm border rounded-xl p-4 bg-muted/30">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground -mt-1 mb-3">
            <span>الملخص المالي للمستخلص</span>
            <span className="font-semibold px-2 py-0.5 rounded bg-muted text-foreground/70">
              إنجاز: {detail.summary.cumulativeCompletionPercent.toFixed(2)}%
            </span>
          </div>
          
          <div className="flex justify-between"><span className="text-muted-foreground">أعمال سابقة (معتمدة)</span><span className="font-mono">{money(detail.summary.previousWorks)}</span></div>
          <div className="flex justify-between font-bold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-900/20 px-2 py-1 rounded -mx-2 -my-1"><span className="ms-2">أعمال حالية</span><span className="font-mono me-2">{money(detail.summary.currentWorks)}</span></div>
          <div className="flex justify-between text-slate-700 dark:text-slate-300"><span className="text-muted-foreground">أعمال تراكمية</span><span className="font-mono font-semibold">{money(detail.summary.cumulativeWorks)}</span></div>
          
          <div className="flex justify-between border-t pt-2 mt-2"><span className="text-muted-foreground">الإضافات المالية</span><span className="font-mono text-emerald-600">{money(detail.summary.additionsTotal)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">إجمالي الاستقطاعات</span><span className="font-mono text-amber-700">−{money(detail.summary.deductionsTotal)}</span></div>
          {detail.summary.advanceRecovery && detail.summary.advanceRecovery.enabled && (
            <div className="flex justify-between text-[11px]"><span className="text-muted-foreground ms-2">↳ استرداد سلفة</span><span className="font-mono text-amber-700">−{money(Number(detail.summary.advanceRecovery.recoveryAmount))}</span></div>
          )}
          <div className="flex justify-between"><span className="text-muted-foreground">الغرامات المستقلة</span><span className="font-mono text-rose-700">−{money(detail.summary.penaltyTotal)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">الضريبة (VAT)</span><span className="font-mono">{money(detail.summary.vatAmount)}</span></div>
          
          <div className="flex justify-between font-bold border-t pt-2 text-base">
            <span>صافي المستخلص الحالي</span>
            <span className="font-mono text-primary">{money(detail.summary.adjustedNetAmount)}</span>
          </div>
        </div>
      </div>

      {/* 4. FOOTER: Save / Approve / Print */}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-4 pt-4 border-t bg-muted/20 p-4 rounded-xl">
        <div className="text-xs text-muted-foreground">
          {detail.summary.advanceRecovery && detail.summary.advanceRecovery.enabled && (
            <p>الرصيد الفعلي للسلفة قبل التطبيق: {money(Number(detail.summary.advanceRecovery.actualAdvanceRemaining))} ر.س · بعد التطبيق: {money(Number(detail.summary.advanceRecovery.remainingAdvanceAfter))} ر.س</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {bill?.direction && bill.billNumber && (
            <ContractingBillExportActions
              compact
              snapshot={{
                bill: {
                  ...(bill ?? {}),
                  id: billId,
                  projectId,
                  projectCode: project?.code,
                  projectName: project?.nameAr || project?.nameEn,
                  direction: bill.direction,
                  billNumber: bill.billNumber,
                  billDate: bill.billDate ?? "",
                } as ContractingBillSnapshot,
                project,
              }}
            />
          )}
          {nextStates.length > 0 && (
            <>
              <BillDetailPicker
                className="w-40 bg-white dark:bg-slate-950"
                items={nextStates.map((state) => ({ value: state, label: STATUS_LABEL[state] || state }))}
                value={workflowState}
                onValueChange={setWorkflowState}
                placeholder="الإجراء التالي"
                searchPlaceholder="بحث في الإجراءات..."
                testId="bill-workflow-picker"
              />
              <Button onClick={() => void transition()} disabled={transitioning || !workflowState || workflowState === detail.state}>{transitioning ? "جار الحفظ…" : "تسجيل حالة المستخلص"}</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
