import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { FileText, Pencil, Plus, Trash2, UploadCloud } from "lucide-react";

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

type BillLine = {
  id: number;
  workItemId: number | null;
  changeOrderId: number | null;
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
  lines: BillLine[];
  deductions: Deduction[];
  penalties: Penalty[];
  attachments: Attachment[];
  workflow: Array<{ id: number; state: string; action: string; note: string | null; createdAt: string }>;
  contracts?: {
    owner: Array<{ id: number; contractNumber: string; contractType: string; status: string; value: string; parentContractId: number | null }>;
  };
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
    retentionAmount: number;
    penaltyTotal: number;
    netBeforeTax: number;
    vatAmount: number;
    netAmount: number;
    paidAmount: number;
    remainingAmount: number;
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

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-slate-600">{label}</label>
      {children}
    </div>
  );
}

export default function ContractingBillDetailEditor({
  billId,
  projectId,
}: {
  billId: number;
  projectId: number;
}) {
  const { token, user } = useAuth() as any;
  const { toast } = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [line, setLine] = useState({ workItemId: "", changeOrderId: "", currentQty: "0", currentValue: "0", excessApproved: false, excessApprovalReason: "" });
  const [deduction, setDeduction] = useState<DeductionDraft>({
    kind: "advance", percentage: "", amount: "0", reason: "", reference: "", notes: "",
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
  const [savingEdit, setSavingEdit] = useState<"deduction" | "penalty" | "attachment" | null>(null);
  const [uploading, setUploading] = useState(false);

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }), [token]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [detailResponse, workItemsResponse] = await Promise.all([
        fetch(`${API}/api/contracting/bills/${billId}/details`, { headers }),
        fetch(`${API}/api/contracting/projects/${projectId}/work-items`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (!detailResponse.ok) throw new Error((await detailResponse.json()).error || `HTTP ${detailResponse.status}`);
      const next = await detailResponse.json();
      setDetail(next);
      setWorkflowState(next.state);
      if (workItemsResponse.ok) setWorkItems(await workItemsResponse.json());
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
    if (!line.workItemId) {
      toast({ title: "اختر بند تنفيذ", variant: "destructive" });
      return;
    }
    try {
      await request(`/bills/${billId}/lines`, "POST", line);
      setLine({ workItemId: "", changeOrderId: "", currentQty: "0", currentValue: "0", excessApproved: false, excessApprovalReason: "" });
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
    }
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
      setDeduction({ kind: "advance", percentage: "", amount: "0", reason: "", reference: "", notes: "" });
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
  const ownerChangeOrders = (detail.contracts?.owner ?? []).filter((contract) =>
    ["change_order", "addendum"].includes(contract.contractType)
    && ["active", "approved"].includes(contract.status),
  );
  const selectedChangeOrder = ownerChangeOrders.find((contract) => String(contract.id) === line.changeOrderId);

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-sky-200 bg-sky-50/40 p-4 dark:border-sky-900 dark:bg-sky-950/20" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-bold text-sky-800 dark:text-sky-200">تفاصيل المستخلص والرقابة</h4>
          <p className="text-[11px] text-slate-500">الكميات السابقة والتراكمية يحسبها الخادم من المستخلصات السابقة.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={locked ? "secondary" : "default"}>{STATUS_LABEL[detail.state] || detail.state}</Badge>
          {nextStates.length > 0 && (
            <>
              <Select value={workflowState} onValueChange={setWorkflowState}>
                <SelectTrigger className="h-8 w-36"><SelectValue placeholder="الإجراء التالي" /></SelectTrigger>
                <SelectContent>
                  {nextStates.map((state) => <SelectItem key={state} value={state}>{STATUS_LABEL[state] || state}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={() => void transition()} disabled={transitioning || !workflowState || workflowState === detail.state}>{transitioning ? "جار الحفظ…" : "تسجيل"}</Button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
        {[
          ["قيمة العقد الأصلية", detail.summary.originalContractValue],
          ["أوامر التغيير", detail.summary.changeOrdersValue],
          ["القيمة المعدلة", detail.summary.adjustedContractValue],
          ["أعمال سابق", detail.summary.previousWorks],
          ["أعمال حالية", detail.summary.currentWorks],
          ["أعمال تراكمية", detail.summary.cumulativeWorks],
          ["المتبقي من العقد", detail.summary.remainingContractValue],
          ["إجمالي الاستقطاعات", detail.summary.deductionsTotal],
          ["المتبقي للسداد", detail.summary.remainingAmount],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded border bg-white p-2 dark:bg-slate-900">
            <div className="text-slate-500">{label}</div>
            <div className="font-bold tabular-nums">{money(Number(value))} ر.س</div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-slate-500">
        نسبة الإنجاز التراكمية: {detail.summary.cumulativeCompletionPercent.toFixed(2)}% ·{" "}
        قبل الضريبة: {money(detail.summary.netBeforeTax)} ر.س · الضريبة الحالية: {money(detail.summary.vatAmount)} ر.س ·
        صافي المستخلص الحالي: {money(detail.summary.netAmount)} ر.س · الغرامات المستقلة: {money(detail.summary.penaltyTotal)} ر.س
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h5 className="font-semibold">بنود المستخلص ({detail.lines.length})</h5>
          {!locked && <Badge variant="outline">يُمنع التجاوز دون اعتماد صريح</Badge>}
        </div>
        {!locked && (
          <div className="grid grid-cols-2 gap-2 rounded border bg-white p-3 md:grid-cols-6 dark:bg-slate-900">
            <DetailField label="بند التنفيذ">
              <Select value={line.workItemId} onValueChange={(value) => setLine({ ...line, workItemId: value })}>
                <SelectTrigger><SelectValue placeholder="اختر بنداً" /></SelectTrigger>
                <SelectContent>{workItems.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.code ? `${item.code} — ` : ""}{item.nameAr}</SelectItem>)}</SelectContent>
              </Select>
            </DetailField>
            <DetailField label="أمر التغيير المعتمد (اختياري)">
              <Select value={line.changeOrderId || "__none__"} onValueChange={(value) => setLine({ ...line, changeOrderId: value === "__none__" ? "" : value })}>
                <SelectTrigger><SelectValue placeholder="بدون أمر تغيير" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">بدون أمر تغيير — بند legacy</SelectItem>
                  {ownerChangeOrders.map((contract) => <SelectItem key={contract.id} value={String(contract.id)}>#{contract.contractNumber} · {money(Number(contract.value))} ر.س</SelectItem>)}
                </SelectContent>
              </Select>
            </DetailField>
            <DetailField label="الكمية الحالية"><Input type="number" min="0" value={line.currentQty} onChange={(e) => setLine({ ...line, currentQty: e.target.value })} /></DetailField>
            <DetailField label="قيمة الأعمال الحالية"><Input type="number" min="0" value={line.currentValue} onChange={(e) => setLine({ ...line, currentValue: e.target.value })} /></DetailField>
            <DetailField label="سبب اعتماد التجاوز (اختياري)">
              <Input value={line.excessApprovalReason} onChange={(e) => setLine({ ...line, excessApprovalReason: e.target.value, excessApproved: Boolean(e.target.value) })} />
            </DetailField>
            <div className="flex items-end"><Button className="w-full" size="sm" onClick={() => void addLine()}><Plus className="mx-1 h-4 w-4" />إضافة بند</Button></div>
          </div>
        )}
        {!locked && selectedChangeOrder && (
          <div className="rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
            سقف أمر التغيير #{selectedChangeOrder.contractNumber}: {money(Number(selectedChangeOrder.value))} ر.س
            · الحالي: {money(Number(line.currentValue))} ر.س
            · التراكمي بعد الحفظ سيحسبه الخادم من المستخلصات السابقة.
          </div>
        )}
        <div className="overflow-x-auto rounded border bg-white dark:bg-slate-900">
          <Table>
            <TableHeader><TableRow>
              <TableHead>البند / أمر التغيير</TableHead><TableHead>الوحدة</TableHead>
              <TableHead>كمية: سابق/حالي/تراكمي</TableHead><TableHead>قيمة: سابق/حالي/تراكمي</TableHead><TableHead>—</TableHead>
            </TableRow></TableHeader>
            <TableBody>{detail.lines.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.workItemCode ? `${row.workItemCode} — ` : ""}{row.workItemName || "بند محذوف"}{row.changeOrderNumber && <Badge className="mx-1" variant="secondary">أمر {row.changeOrderNumber}</Badge>}{row.excessApproved && <Badge className="mx-1" variant="outline">اعتماد تجاوز</Badge>}</TableCell>
                <TableCell>{row.unit || "—"}</TableCell>
                <TableCell className="tabular-nums">{Number(row.previousQty).toLocaleString()} / {Number(row.currentQty).toLocaleString()} / {Number(row.cumulativeQty).toLocaleString()}</TableCell>
                <TableCell className="tabular-nums">{money(Number(row.previousValue))} / {money(Number(row.currentValue))} / {money(Number(row.cumulativeValue))}</TableCell>
                <TableCell>{!locked && <Button size="sm" variant="ghost" onClick={() => void remove(`/bill-lines/${row.id}`)}><Trash2 className="h-4 w-4 text-red-500" /></Button>}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h5 className="font-semibold">الاستقطاعات ({detail.deductions.length})</h5>
        {!locked && (
          <div className="grid grid-cols-2 gap-2 rounded border bg-white p-3 md:grid-cols-6 dark:bg-slate-900">
            <DetailField label="النوع"><Select value={deduction.kind} onValueChange={(value) => setDeduction({ ...deduction, kind: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="advance">دفعة مقدمة</SelectItem><SelectItem value="retention">ضمان أعمال (القيمة الحالية)</SelectItem><SelectItem value="materials">مواد / عهد</SelectItem><SelectItem value="settlement">تسوية</SelectItem><SelectItem value="other">أخرى</SelectItem>
            </SelectContent></Select></DetailField>
            <DetailField label="النسبة"><Input type="number" min="0" max="100" value={deduction.percentage} onChange={(e) => setDeduction({ ...deduction, percentage: e.target.value })} /></DetailField>
            <DetailField label="القيمة"><Input type="number" min="0" value={deduction.amount} onChange={(e) => setDeduction({ ...deduction, amount: e.target.value })} /></DetailField>
            <DetailField label="السبب"><Input value={deduction.reason} onChange={(e) => setDeduction({ ...deduction, reason: e.target.value })} /></DetailField>
            <DetailField label="المرجع"><Input value={deduction.reference} onChange={(e) => setDeduction({ ...deduction, reference: e.target.value })} /></DetailField>
            <div className="flex items-end"><Button className="w-full" size="sm" onClick={() => void addDeduction()}><Plus className="mx-1 h-4 w-4" />إضافة</Button></div>
          </div>
        )}
        <div className="space-y-2 text-xs">{detail.deductions.map((row) => (
          editingDeduction?.id === row.id ? (
            <div key={row.id} className="grid grid-cols-2 gap-2 rounded border bg-white p-3 dark:bg-slate-900 md:grid-cols-7" data-testid={`editor-deduction-${row.id}`}>
              <DetailField label="النوع"><Select value={editingDeduction.draft.kind} onValueChange={(value) => setEditingDeduction({ ...editingDeduction, draft: { ...editingDeduction.draft, kind: value } })}><SelectTrigger data-testid={`select-edit-deduction-kind-${row.id}`}><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="advance">دفعة مقدمة</SelectItem><SelectItem value="retention">ضمان أعمال (القيمة الحالية)</SelectItem><SelectItem value="materials">مواد / عهد</SelectItem><SelectItem value="settlement">تسوية</SelectItem><SelectItem value="other">أخرى</SelectItem>
              </SelectContent></Select></DetailField>
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
              <span>{row.kind === "retention" ? "ضمان" : row.kind} · {row.reason}</span><b>{money(Number(row.amount))} ر.س</b>
              {!locked && (
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
            <DetailField label="نوع المرفق"><Select value={fileCategory} onValueChange={setFileCategory}><SelectTrigger className="w-48"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="invoice">فاتورة</SelectItem><SelectItem value="completion_certificate">شهادة إنجاز</SelectItem><SelectItem value="handover">محضر استلام</SelectItem><SelectItem value="penalty">مستند غرامة</SelectItem><SelectItem value="other">أخرى</SelectItem>
            </SelectContent></Select></DetailField>
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
              <DetailField label="نوع المرفق"><Select value={editingAttachment.category} onValueChange={(value) => setEditingAttachment({ ...editingAttachment, category: value })}><SelectTrigger className="w-48" data-testid={`select-edit-attachment-category-${row.id}`}><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="invoice">فاتورة</SelectItem><SelectItem value="completion_certificate">شهادة إنجاز</SelectItem><SelectItem value="handover">محضر استلام</SelectItem><SelectItem value="penalty">مستند غرامة</SelectItem><SelectItem value="other">أخرى</SelectItem>
              </SelectContent></Select></DetailField>
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
    </div>
  );
}