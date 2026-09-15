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
import { FileText, Plus, Trash2, UploadCloud } from "lucide-react";

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

type Detail = {
  state: string;
  lines: BillLine[];
  deductions: Deduction[];
  penalties: Penalty[];
  attachments: Attachment[];
  workflow: Array<{ id: number; state: string; action: string; note: string | null; createdAt: string }>;
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
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [line, setLine] = useState({ workItemId: "", currentQty: "0", currentValue: "0", excessApproved: false, excessApprovalReason: "" });
  const [deduction, setDeduction] = useState({
    kind: "advance", percentage: "", amount: "0", reason: "", reference: "", notes: "",
  });
  const [penalty, setPenalty] = useState({
    penaltyType: "other", reason: "", amount: "0", penaltyDate: new Date().toISOString().slice(0, 10),
    reference: "", notes: "", accountMappingKey: "",
  });
  const [workflowState, setWorkflowState] = useState("");
  const [fileCategory, setFileCategory] = useState("other");
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
      setLine({ workItemId: "", currentQty: "0", currentValue: "0", excessApproved: false, excessApprovalReason: "" });
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

  async function transition() {
    if (!workflowState || workflowState === detail?.state) return;
    try {
      await request(`/bills/${billId}/workflow`, "POST", { state: workflowState });
      await load();
    } catch (caught: any) {
      toast({ title: caught?.message, variant: "destructive" });
      setWorkflowState(detail?.state || "");
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
  const locked = ["approved", "posted", "partially_paid", "paid"].includes(detail.state);
  const nextStates = detail.state === "draft"
    ? ["submitted"]
    : detail.state === "submitted"
      ? ["under_review"]
      : detail.state === "under_review"
        ? ["approved"]
        : detail.state === "approved"
          ? ["posted"]
          : detail.state === "posted"
            ? ["partially_paid", "paid"]
            : detail.state === "partially_paid"
              ? ["paid"]
              : detail.state === "rejected" ? ["draft"] : [];

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
              <Button size="sm" onClick={() => void transition()} disabled={!workflowState || workflowState === detail.state}>تسجيل</Button>
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
          <div className="grid grid-cols-2 gap-2 rounded border bg-white p-3 md:grid-cols-5 dark:bg-slate-900">
            <DetailField label="بند التنفيذ">
              <Select value={line.workItemId} onValueChange={(value) => setLine({ ...line, workItemId: value })}>
                <SelectTrigger><SelectValue placeholder="اختر بنداً" /></SelectTrigger>
                <SelectContent>{workItems.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.code ? `${item.code} — ` : ""}{item.nameAr}</SelectItem>)}</SelectContent>
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
        <div className="overflow-x-auto rounded border bg-white dark:bg-slate-900">
          <Table>
            <TableHeader><TableRow>
              <TableHead>البند</TableHead><TableHead>الوحدة</TableHead>
              <TableHead>كمية: سابق/حالي/تراكمي</TableHead><TableHead>قيمة: سابق/حالي/تراكمي</TableHead><TableHead>—</TableHead>
            </TableRow></TableHeader>
            <TableBody>{detail.lines.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.workItemCode ? `${row.workItemCode} — ` : ""}{row.workItemName || "بند محذوف"}{row.excessApproved && <Badge className="mx-1" variant="outline">اعتماد تجاوز</Badge>}</TableCell>
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
        <div className="flex flex-wrap gap-2 text-xs">{detail.deductions.map((row) => (
          <div key={row.id} className="flex items-center gap-2 rounded border bg-white px-2 py-1 dark:bg-slate-900">
            <span>{row.kind === "retention" ? "ضمان" : row.kind} · {row.reason}</span><b>{money(Number(row.amount))} ر.س</b>
            {!locked && <Button size="sm" variant="ghost" onClick={() => void remove(`/bill-deductions/${row.id}`)}><Trash2 className="h-3 w-3 text-red-500" /></Button>}
          </div>
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
        <div className="flex flex-wrap gap-2 text-xs">{detail.penalties.map((row) => (
          <div key={row.id} className="flex items-center gap-2 rounded border bg-white px-2 py-1 dark:bg-slate-900">
            <span>{row.penaltyType} · {row.reason} · {row.penaltyDate}</span><b>{money(Number(row.amount))} ر.س</b>
            {!locked && <Button size="sm" variant="ghost" onClick={() => void remove(`/bill-penalties/${row.id}`)}><Trash2 className="h-3 w-3 text-red-500" /></Button>}
          </div>
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
        <div className="flex flex-wrap gap-2 text-xs">{detail.attachments.map((row) => (
          <div key={row.id} className="flex items-center gap-2 rounded border bg-white px-2 py-1 dark:bg-slate-900">
             <a className="underline" href={`${API}/api/contracting/bills/${billId}/attachments/${row.id}/download?token=${encodeURIComponent(token)}`} target="_blank" rel="noreferrer">{row.filename} · {row.category}</a>
            {!locked && <Button size="sm" variant="ghost" onClick={() => void remove(`/bill-attachments/${row.id}`)}><Trash2 className="h-3 w-3 text-red-500" /></Button>}
          </div>
        ))}</div>
      </section>
    </div>
  );
}