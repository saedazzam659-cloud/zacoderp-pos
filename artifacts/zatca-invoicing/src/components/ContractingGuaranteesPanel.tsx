import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ShieldCheck, Plus, Pencil, Archive, Award, RefreshCw } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { usePermission } from "@/hooks/usePermission";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { ContractingArchiveAction } from "@/components/ContractingArchiveAction";

const API = import.meta.env.VITE_API_URL || "";

type ContractKind = "owner" | "subcontract";
type Guarantee = {
  id: number;
  project_id: number;
  tender_id: number | null;
  contract_kind: ContractKind | null;
  owner_contract_id: number | null;
  subcontract_id: number | null;
  parent_guarantee_id: number | null;
  bank_account_id: number;
  beneficiary_customer_id: number | null;
  guarantee_number: string;
  guarantee_type: string;
  amount: string;
  issue_date: string;
  expiry_date: string;
  status: string;
  purpose: string | null;
  notes: string | null;
  projectName?: string;
  tenderNumber?: string;
  contractNumber?: string;
  bankName?: string;
  beneficiaryName?: string;
  parentGuaranteeNumber?: string;
};
type Tender = {
  id: number;
  project_id: number;
  customer_id: number | null;
  tender_number: string;
  title: string;
  tender_date: string;
  submission_date: string | null;
  estimated_value: string;
  status: string;
  awarded_contract_kind: ContractKind | null;
  awarded_owner_contract_id: number | null;
  awarded_subcontract_id: number | null;
  notes: string | null;
  awardedContractNumber?: string;
};
type Contract = { id: number; contractNumber: string; status: string };
type GuaranteeSummary = {
  contractKind: ContractKind;
  contractId: number;
  totalCount: number;
  totalAmount: string;
  rows: Array<{ guaranteeType: string; status: string; count: number; amount: string }>;
};

export type ContractingGuaranteesPanelProps = {
  projectId: number;
  contractKind?: ContractKind;
  contractId?: number;
  /** Called after any tender/guarantee mutation so a contract header can refresh its unified summary. */
  onSummaryChange?: () => void;
  className?: string;
};

const TYPE_LABEL: Record<string, string> = {
  initial: "ابتدائي",
  performance: "نهائي / حسن تنفيذ",
  advance_payment: "دفعة مقدمة",
  maintenance: "صيانة",
  other: "آخر",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  issued: "مُصدر",
  active: "ساري",
  extended: "ممدد",
  released: "مفرج عنه",
  expired: "منتهي",
  cancelled: "ملغي",
  submitted: "مقدمة",
  under_review: "قيد المراجعة",
  awarded: "تمت الترسية",
  lost: "غير فائزة",
};
const NEXT_STATUS: Record<string, string[]> = {
  draft: ["issued", "cancelled"],
  issued: ["active", "cancelled"],
  active: ["extended", "released", "expired", "cancelled"],
  extended: ["active", "released", "expired", "cancelled"],
  expired: ["released"],
};


async function readResponse(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

export default function ContractingGuaranteesPanel({
  projectId,
  contractKind,
  contractId,
  onSummaryChange,
  className,
}: ContractingGuaranteesPanelProps) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { token, user, actingCompanyId } = useAuth() as any;
  const { toast } = useToast();
  const canCreate = usePermission("contracting", "create");
  const canEdit = usePermission("contracting", "edit");
  const canDelete = usePermission("contracting", "delete");
  const canApprove = user?.role === "admin"
    || user?.role === "super_admin"
    || user?.permissions?.contracting?.approve === true;
  const [tab, setTab] = useState(new URLSearchParams(search).get("records") === "tenders" ? "tenders" : "guarantees");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [guarantees, setGuarantees] = useState<Guarantee[]>([]);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [ownerContracts, setOwnerContracts] = useState<Contract[]>([]);
  const [subcontracts, setSubcontracts] = useState<Contract[]>([]);
  const [summary, setSummary] = useState<GuaranteeSummary | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [awardTender, setAwardTender] = useState<Tender | null>(null);
  const [award, setAward] = useState({ contractKind: "owner" as ContractKind, contractId: "" });

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
  }), [token, actingCompanyId]);

  const load = useCallback(async () => {
    if (!token || !projectId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const query = new URLSearchParams({ projectId: String(projectId) });
      if (contractKind) query.set("contractKind", contractKind);
      if (contractId) query.set("contractId", String(contractId));
      if (typeFilter) query.set("guaranteeType", typeFilter);
      if (statusFilter) query.set("status", statusFilter);
      const [guaranteeRows, tenderRows, owners, subs, contractSummary] = await Promise.all([
        fetch(`${API}/api/contracting/guarantees?${query}`, { headers }).then(readResponse),
        fetch(`${API}/api/contracting/tenders?projectId=${projectId}`, { headers }).then(readResponse),
        fetch(`${API}/api/contracting/projects/${projectId}/owner-contracts`, { headers }).then(readResponse),
        fetch(`${API}/api/contracting/projects/${projectId}/sub-contracts`, { headers }).then(readResponse),
        contractKind && contractId
          ? fetch(`${API}/api/contracting/contracts/${contractKind}/${contractId}/guarantee-summary`, { headers }).then(readResponse)
          : Promise.resolve(null),
      ]);
      setGuarantees(Array.isArray(guaranteeRows) ? guaranteeRows : []);
      setTenders(Array.isArray(tenderRows) ? tenderRows : []);
      setOwnerContracts(Array.isArray(owners) ? owners : []);
      setSubcontracts(Array.isArray(subs) ? subs : []);
      setSummary(contractSummary);
    } catch (error: any) {
      setLoadError(error?.message || "تعذر تحميل المناقصات والضمانات");
      setGuarantees([]);
      setTenders([]);
      setSummary(null);
      toast({ title: "تعذر تحميل المناقصات والضمانات", description: error?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token, projectId, contractKind, contractId, typeFilter, statusFilter, headers, toast]);

  useEffect(() => { void load(); }, [load]);

  async function mutate(path: string, method: string, body?: unknown) {
    setSaving(true);
    try {
      const result = await fetch(`${API}/api/contracting${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(readResponse);
      await load();
      onSummaryChange?.();
      return result;
    } catch (error: any) {
      toast({ title: "تعذر حفظ العملية", description: error?.message, variant: "destructive" });
      throw error;
    } finally {
      setSaving(false);
    }
  }

  function openEditor(kind: "guarantees" | "tenders", id?: number, parent?: number) {
    const query = new URLSearchParams();
    if (contractKind && contractId) {
      query.set("contractKind", contractKind);
      query.set("contractId", String(contractId));
    }
    if (parent) query.set("parent", String(parent));
    navigate(`/contracting/projects/${projectId}/${kind}/${id ? `${id}/edit` : "new"}${query.size ? `?${query}` : ""}`);
  }

  const selectedContracts = award.contractKind === "owner" ? ownerContracts : subcontracts;

  function updateLifecycle(row: Guarantee, status: string) {
    if (status !== "extended") {
      void mutate(`/guarantees/${row.id}/lifecycle`, "PUT", { status });
      return;
    }
    const expiryDate = window.prompt("أدخل تاريخ الانتهاء الجديد بصيغة YYYY-MM-DD", row.expiry_date);
    if (expiryDate) void mutate(`/guarantees/${row.id}/lifecycle`, "PUT", { status, expiryDate });
  }

  return (
    <section className={className}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 font-bold"><ShieldCheck className="h-5 w-5 text-emerald-600" /> {contractKind && contractId ? "ضمانات العقد الموحدة" : "المناقصات وخطابات الضمان"}</h3>
          <p className="text-xs text-muted-foreground">لا تنشئ هذه الدورة قيوداً محاسبية أو مستخلصات تلقائياً.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className="me-1 h-4 w-4" /> تحديث</Button>
      </div>
      {loadError && <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        تعذر تحميل المناقصات أو خطابات الضمان: {loadError}
        <Button size="sm" variant="outline" className="ms-2" onClick={() => void load()}>إعادة المحاولة</Button>
      </div>}

      {contractKind && contractId && summary && (
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">عدد ضمانات العقد</div>
            <div className="mt-1 text-xl font-bold">{summary.totalCount}</div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">إجمالي القيمة</div>
            <div className="mt-1 text-xl font-bold">{Number(summary.totalAmount).toLocaleString("en-US")}</div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">الساري والممدد</div>
            <div className="mt-1 text-xl font-bold">
              {summary.rows.filter(row => ["active", "extended"].includes(row.status)).reduce((sum, row) => sum + Number(row.count), 0)}
            </div>
          </div>
        </div>
      )}
      <Tabs value={contractKind && contractId ? "guarantees" : tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="guarantees">خطابات الضمان ({guarantees.length})</TabsTrigger>
          {!contractId && <TabsTrigger value="tenders">المناقصات ({tenders.length})</TabsTrigger>}
        </TabsList>
        <TabsContent value="guarantees" className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <SearchCombobox className="w-44" value={typeFilter} onValueChange={setTypeFilter} clearable
              placeholder="كل الأنواع" searchPlaceholder="بحث عن نوع..." testId="filter-guarantee-type"
              items={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
            <SearchCombobox className="w-44" value={statusFilter} onValueChange={setStatusFilter} clearable
              placeholder="كل الحالات" searchPlaceholder="بحث عن حالة..." testId="filter-guarantee-status"
              items={["draft", "issued", "active", "extended", "released", "expired", "cancelled"].map(value => ({ value, label: STATUS_LABEL[value] }))} />
            {canCreate && <Button size="sm" onClick={() => openEditor("guarantees")}><Plus className="me-1 h-4 w-4" /> خطاب ضمان</Button>}
          </div>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>الرقم</TableHead><TableHead>النوع</TableHead><TableHead>العقد/المناقصة</TableHead>
                <TableHead>البنك</TableHead><TableHead>المستفيد</TableHead><TableHead>القيمة</TableHead>
                <TableHead>الانتهاء</TableHead><TableHead>الحالة</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>
                 {loading && guarantees.length === 0 && <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">جارٍ تحميل خطابات الضمان...</TableCell></TableRow>}
                 {!loading && !loadError && guarantees.length === 0 && <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">لا توجد خطابات ضمان ضمن النطاق المحدد</TableCell></TableRow>}
                {guarantees.map(row => <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.guarantee_number}</TableCell>
                  <TableCell>{TYPE_LABEL[row.guarantee_type] ?? row.guarantee_type}</TableCell>
                  <TableCell>{row.contractNumber || row.tenderNumber || "—"}{row.parentGuaranteeNumber && <div className="text-xs text-muted-foreground">الأصل: {row.parentGuaranteeNumber}</div>}</TableCell>
                  <TableCell>{row.bankName || `#${row.bank_account_id}`}</TableCell>
                  <TableCell>{row.beneficiaryName || "الشركة"}</TableCell>
                  <TableCell>{Number(row.amount).toLocaleString("en-US")}</TableCell>
                  <TableCell>{row.expiry_date}</TableCell>
                  <TableCell><Badge variant="outline">{STATUS_LABEL[row.status] ?? row.status}</Badge></TableCell>
                  <TableCell><div className="flex flex-wrap gap-1">
                    {canEdit && <Button variant="ghost" size="icon" onClick={() => openEditor("guarantees", row.id)}><Pencil className="h-4 w-4" /></Button>}
                    {canApprove && NEXT_STATUS[row.status]?.map(status => <Button key={status} variant="outline" size="sm" disabled={saving} onClick={() => updateLifecycle(row, status)}>{STATUS_LABEL[status]}</Button>)}
                    {canCreate && row.guarantee_type === "initial" && <Button variant="outline" size="sm" onClick={() => openEditor("guarantees", undefined, row.id)}>إنشاء نهائي</Button>}
                    <ContractingArchiveAction entityType="guarantee" entityId={row.id} readOnly={!canEdit} />
                    {canDelete && <Button variant="ghost" size="icon" onClick={() => void mutate(`/guarantees/${row.id}`, "DELETE")}><Archive className="h-4 w-4" /></Button>}
                  </div></TableCell>
                </TableRow>)}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
        <TabsContent value="tenders" className="space-y-3">
          {canCreate && <Button size="sm" onClick={() => openEditor("tenders")}><Plus className="me-1 h-4 w-4" /> مناقصة</Button>}
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader><TableRow><TableHead>الرقم</TableHead><TableHead>العنوان</TableHead><TableHead>التاريخ</TableHead><TableHead>القيمة</TableHead><TableHead>الحالة</TableHead><TableHead>العقد المرسي</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                 {loading && tenders.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">جارٍ تحميل المناقصات...</TableCell></TableRow>}
                 {!loading && !loadError && tenders.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">لا توجد مناقصات لهذا المشروع</TableCell></TableRow>}
                {tenders.map(row => <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.tender_number}</TableCell><TableCell>{row.title}</TableCell>
                  <TableCell>{row.tender_date}</TableCell><TableCell>{Number(row.estimated_value).toLocaleString("en-US")}</TableCell>
                  <TableCell><Badge variant="outline">{STATUS_LABEL[row.status] ?? row.status}</Badge></TableCell>
                  <TableCell>{row.awardedContractNumber || "—"}</TableCell>
                  <TableCell><div className="flex gap-1">
                    {canEdit && row.status !== "awarded" && <Button variant="ghost" size="icon" onClick={() => openEditor("tenders", row.id)}><Pencil className="h-4 w-4" /></Button>}
                    {canApprove && row.status !== "awarded" && <Button variant="outline" size="sm" onClick={() => { setAwardTender(row); setAward({ contractKind: "owner", contractId: "" }); }}><Award className="me-1 h-4 w-4" /> ترسية</Button>}
                    <ContractingArchiveAction entityType="tender" entityId={row.id} readOnly={!canEdit} />
                    {canDelete && row.status !== "awarded" && <Button variant="ghost" size="icon" onClick={() => void mutate(`/tenders/${row.id}`, "DELETE")}><Archive className="h-4 w-4" /></Button>}
                  </div></TableCell>
                </TableRow>)}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>


      <Dialog open={Boolean(awardTender)} onOpenChange={open => !open && setAwardTender(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>ترسية المناقصة على عقد موجود</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="نوع العقد"><Select value={award.contractKind} onChange={value => setAward({ contractKind: value as ContractKind, contractId: "" })} options={[["owner", "عقد مالك"], ["subcontract", "عقد باطن"]]} /></Field>
            <Field label="العقد"><Select value={award.contractId} onChange={value => setAward({ ...award, contractId: value })} options={selectedContracts.map(row => [String(row.id), `${row.contractNumber} — ${STATUS_LABEL[row.status] ?? row.status}`])} /></Field>
          </div>
          <DialogFooter><Button disabled={saving || !award.contractId} onClick={() => void mutate(`/tenders/${awardTender?.id}/award`, "PUT", award).then(() => setAwardTender(null))}>تأكيد الترسية</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="space-y-1 text-sm"><span className="font-medium">{label}</span>{children}</label>;
}

function Select({ value, onChange, options, allowEmpty = false }: {
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  allowEmpty?: boolean;
}) {
  return <select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={value} onChange={event => onChange(event.target.value)}>
    {allowEmpty && <option value="">بدون</option>}
    {!allowEmpty && <option value="">اختر…</option>}
    {options.map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
  </select>;
}