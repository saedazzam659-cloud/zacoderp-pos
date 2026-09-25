import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";

export type ContractingAllocation = {
  kind: "owner_advance" | "owner_bill" | "owner_retention_release" | "subcontract_advance" | "subcontract_bill" | "subcontract_retention_release";
  projectId: number;
  contractId: number;
  billId?: number;
};

type Option = {
  id: number;
  projectId?: number | null;
  contractId?: number | null;
  ownerContractId?: number | null;
  subcontractorContractId?: number | null;
  projectName?: string;
  name?: string;
  nameAr?: string;
  code?: string;
  contractNumber?: string;
  billNumber?: string;
  remainingAmount?: number | string;
  remaining?: number | string;
  netAmount?: number | string;
  paidAmount?: number | string;
  status?: string;
  retentionAmount?: number | string;
  retentionReleasedAmount?: number | string;
  retentionRemainingAmount?: number | string;
};
type Options = { projects: Option[]; contracts: Option[]; bills: Option[]; retentionBills: Option[] };
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
export const positiveId = (value: string | null): number | null =>
  value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
export const retainedRemaining = (row: Option): number => Number(row.retentionRemainingAmount);
export const isRetentionRelease = (kind?: ContractingAllocation["kind"]) => kind?.endsWith("_retention_release") ?? false;

// Advisory preflight; posting rechecks under the server's financial locks.
export async function validateRetentionReleaseLines(
  direction: "receipt" | "payment", companyId: number, entityId: string, token: string,
  lines: Array<{ contractingAllocation: ContractingAllocation | null; amount: string }>,
) {
  const grouped = new Map<string, { allocation: ContractingAllocation; cents: number }>();
  for (const line of lines) {
    const a = line.contractingAllocation;
    if (!a || !isRetentionRelease(a.kind)) continue;
    const key = `${a.kind}:${a.projectId}:${a.contractId}:${a.billId}`;
    const existing = grouped.get(key);
    grouped.set(key, { allocation: a, cents: (existing?.cents ?? 0) + Math.round(Number(line.amount) * 100) });
  }
  if (!grouped.size) return;
  const query = new URLSearchParams({ companyId: String(companyId), entityId });
  const response = await fetch(`${API}/api/${direction}-vouchers/contracting-options?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.retentionBills))
    throw new Error(data.error || "تعذر تحديث أرصدة المحتجزات؛ أعد المحاولة قبل حفظ السند");
  for (const { allocation: a, cents } of grouped.values()) {
    const bill = (data.retentionBills as Option[]).find(row => Number(row.id) === a.billId &&
      Number(row.projectId) === a.projectId && Number(row.contractId) === a.contractId &&
      ["approved", "posted", "partially_paid", "paid"].includes(row.status || ""));
    if (!bill) throw new Error(`المستخلص #${a.billId} غير متاح للإفراج؛ راجع حالة المستخلص والقيد والطرف.`);
    const available = Math.round(retainedRemaining(bill) * 100);
    if (!Number.isFinite(available) || cents > available)
      throw new Error(`إفراج المستخلص ${bill.billNumber || `#${bill.id}`} يتجاوز المحتجز المتبقي ${retainedRemaining(bill).toLocaleString("en-US")} (مجموع بنود السند ${(cents / 100).toLocaleString("en-US")}).`);
  }
}

export function VoucherContractingAllocation({
  direction, entityId, value, onChange, onAmountSuggested, onAddRemainingBills, disabled = false, lineAmount, otherAllocated = 0,
}: {
  direction: "receipt" | "payment";
  entityId: string;
  value: ContractingAllocation | null;
  onChange: (value: ContractingAllocation | null) => void;
  onAmountSuggested?: (amount: string) => void;
  onAddRemainingBills?: (bills: Array<{ allocation: ContractingAllocation; amount: string; billNumber: string }>) => void;
  disabled?: boolean;
  lineAmount: string;
  otherAllocated?: number;
}) {
  const { user, token } = useAuth();
  const pendingKind = useRef<ContractingAllocation["kind"] | null>(null);
  const { data, isLoading, error } = useQuery<Options>({
    queryKey: [`${direction}-contracting-options`, user?.companyId, entityId],
    enabled: !!user?.companyId && !!token && !!entityId,
    queryFn: async () => {
      const query = new URLSearchParams({ companyId: String(user!.companyId), entityId });
      const response = await fetch(`${API}/api/${direction === "receipt" ? "receipt" : "payment"}-vouchers/contracting-options?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
       const json = await response.json().catch(() => ({}));
       if (!response.ok) throw new Error(json.error || `تعذر تحميل خيارات المقاولات (HTTP ${response.status})`);
       if (!Array.isArray(json.projects) || !Array.isArray(json.contracts) || !Array.isArray(json.bills) || !Array.isArray(json.retentionBills))
         throw new Error("استجابة خيارات المقاولات غير صالحة");
      return json;
    },
  });
  const isRetention = isRetentionRelease(value?.kind);
  const isBill = value?.kind.endsWith("_bill") || isRetention;
  const projectId = value?.projectId || 0;
  const contractId = value?.contractId || 0;
  const projects = data?.projects ?? [];
  const contracts = (data?.contracts ?? []).filter(row => Number(row.projectId) === projectId);
  const bills = (isRetention ? data?.retentionBills ?? [] : data?.bills ?? []).filter(row =>
    Number(row.projectId) === projectId &&
    Number(row.contractId ?? row.ownerContractId ?? row.subcontractorContractId) === contractId &&
    (!isRetention || (["approved", "posted", "partially_paid", "paid"].includes(row.status || "") &&
      Number.isFinite(retainedRemaining(row)) && retainedRemaining(row) > 0)));
  const retentionSummary = (data?.retentionBills ?? []).filter(row =>
    Number(row.projectId) === projectId && (!contractId || Number(row.contractId ?? row.ownerContractId ?? row.subcontractorContractId) === contractId));
  const retentionTotals = retentionSummary.reduce((totals, row) => ({
    retained: totals.retained + Number(row.retentionAmount || 0),
    released: totals.released + Number(row.retentionReleasedAmount || 0),
    remaining: totals.remaining + retainedRemaining(row),
  }), { retained: 0, released: 0, remaining: 0 });
  const item = (row: Option, label: string) => ({
    value: String(row.id),
    label,
    description: isRetention && row.retentionRemainingAmount != null
      ? `المحتجز ${Number(row.retentionAmount || 0).toLocaleString("en-US")} • المفرج ${Number(row.retentionReleasedAmount || 0).toLocaleString("en-US")} • المتبقي ${retainedRemaining(row).toLocaleString("en-US")}`
      : row.remainingAmount != null || row.remaining != null || row.netAmount != null
      ? `المتبقي ${Number(row.remainingAmount ?? row.remaining ?? (Number(row.netAmount) - Number(row.paidAmount || 0))).toLocaleString("en-US")}`
      : undefined,
  });
  const suggest = (row?: Option) => {
    if (!row) return;
    const remaining = isRetention ? retainedRemaining(row) : Number(row.remainingAmount ?? row.remaining ??
      (row.netAmount != null ? Number(row.netAmount) - Number(row.paidAmount || 0) : NaN));
    if (Number.isFinite(remaining) && remaining > 0)
      onAmountSuggested?.(remaining.toFixed(2));
  };
  const chooseKind = (kind: ContractingAllocation["kind"] | "") => {
    if (!kind) { onChange(null); return; }
    onAmountSuggested?.("");
    pendingKind.current = data ? null : kind;
    const project = data?.projects.length === 1 ? data.projects[0] : undefined;
    const contractsForProject = data?.contracts.filter(row => row.projectId === project?.id) ?? [];
    const contract = contractsForProject.length === 1 ? contractsForProject[0] : undefined;
    onChange({ kind, projectId: project?.id ?? 0, contractId: contract?.id ?? 0 });
    if (contract && kind.endsWith("_advance")) suggest(contract);
  };
  useEffect(() => {
    if (!data || !value || value.projectId || value.contractId) return;
    pendingKind.current = null;
    const project = data.projects.length === 1 ? data.projects[0] : undefined;
    const matching = data.contracts.filter(row => Number(row.projectId) === project?.id);
    const contract = matching.length === 1 ? matching[0] : undefined;
    if (project) onChange({ ...value, projectId: project.id, contractId: contract?.id ?? 0 });
    if (contract && value.kind.endsWith("_advance") && (!lineAmount || Number(lineAmount) === 0)) suggest(contract);
  }, [data, value, lineAmount]);
  return (
    <div className="rounded-md border border-sky-200 bg-sky-50/50 p-3 space-y-2" data-testid="voucher-contracting-allocation">
      <label className="block text-xs font-semibold">توزيع مقاولات (اختياري)</label>
       <SearchCombobox
         items={[
           { value: "none", label: "بند عادي — بدون ربط مقاولات" },
           ...(direction === "receipt"
             ? [{ value: "owner_advance", label: "سلفة من المالك" }, { value: "owner_bill", label: "تحصيل مستخلص المالك" }, { value: "owner_retention_release", label: "إفراج محتجزات مستخلص المالك" }]
             : [{ value: "subcontract_advance", label: "سلفة للمقاول الباطن" }, { value: "subcontract_bill", label: "سداد مستخلص المقاول الباطن" }, { value: "subcontract_retention_release", label: "صرف محتجزات مستخلص المقاول الباطن" }]),
         ]}
         value={value?.kind ?? "none"}
         onValueChange={kind => chooseKind(kind === "none" ? "" : kind as ContractingAllocation["kind"])}
         disabled={disabled}
         placeholder="نوع التوزيع"
         searchPlaceholder="بحث عن نوع التوزيع..."
         testId="combobox-contracting-allocation-kind"
       />
      {value && (!entityId ? <p className="text-xs text-amber-700">اختر {direction === "receipt" ? "العميل" : "المورد"} أولاً لعرض المشاريع المرتبطة.</p> : <>
         {error && <p role="alert" className="text-xs text-destructive">تعذر تحميل خيارات المقاولات: {(error as Error).message}</p>}
        {isLoading && <p className="text-xs text-muted-foreground">جار تحميل المشاريع والعقود...</p>}
         {data && !projects.length && <p className="text-xs text-muted-foreground">لا توجد مشاريع مرتبطة بهذا {direction === "receipt" ? "العميل" : "المورد"}.</p>}
         {data && projectId > 0 && !contracts.length &&
           <p role="alert" className="text-xs text-amber-800">لا يوجد عقد نشط أو مكتمل مرتبط بهذا المشروع وبهذا {direction === "receipt" ? "العميل" : "المورد"}؛ لا يمكن تخصيص البند قبل اختيار عقد صالح.</p>}
         {data && isBill && contractId > 0 && !bills.length &&
           <p role="alert" className="text-xs text-amber-800">{isRetention ? "لا توجد مستخلصات ذات محتجز متبقٍ ومقيّدة محاسبياً لهذا العقد." : "لا توجد مستخلصات معتمدة متاحة لهذا العقد؛ لا يمكن تخصيص بند مستخلص حالياً."}</p>}
         {data && isRetention && projectId > 0 && <p className="text-xs text-muted-foreground">ملخص المحتجزات {contractId ? "للعقد" : "للمشروع"} (المستخلصات المؤهلة وفق الخادم): المحتجز {retentionTotals.retained.toLocaleString("en-US")} • المفرج عنه {retentionTotals.released.toLocaleString("en-US")} • المتبقي {retentionTotals.remaining.toLocaleString("en-US")}</p>}
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-xs">المشروع
            <SearchCombobox items={projects.map(row => item(row, row.projectName || row.nameAr || row.name || row.code || `مشروع #${row.id}`))}
               value={projectId ? String(projectId) : ""} onValueChange={v => {
                 const matching = data?.contracts.filter(row => Number(row.projectId) === Number(v)) ?? [];
                 const contract = matching.length === 1 ? matching[0] : undefined;
                 onChange({ kind: value.kind, projectId: Number(v) || 0, contractId: contract?.id ?? 0 });
                 onAmountSuggested?.("");
                 if (contract && !isBill) suggest(contract);
               }}
              disabled={disabled} placeholder="اختر المشروع" searchPlaceholder="بحث عن مشروع..." />
          </label>
          <label className="text-xs">العقد
            <SearchCombobox items={contracts.map(row => item(row, row.contractNumber || row.code || `عقد #${row.id}`))}
               value={contractId ? String(contractId) : ""} onValueChange={v => {
                 onChange({ kind: value.kind, projectId, contractId: Number(v) || 0 });
                 onAmountSuggested?.("");
                 if (!isBill) suggest(contracts.find(row => String(row.id) === v));
               }}
               disabled={disabled || !projectId || !contracts.length} placeholder="اختر العقد" searchPlaceholder="بحث عن عقد..." />
          </label>
          {isBill && <label className="text-xs">{isRetention ? "المستخلص ذو المحتجز المتبقي" : "المستخلص المعتمد"}
            <SearchCombobox items={bills.map(row => item(row, row.billNumber || row.code || `مستخلص #${row.id}`))}
               value={value.billId ? String(value.billId) : ""} onValueChange={v => {
                 onChange({ ...value, billId: Number(v) || undefined });
                 if (v) suggest(bills.find(row => String(row.id) === v));
                 else onAmountSuggested?.("");
               }}
               disabled={disabled || !contractId || !bills.length} placeholder="اختر المستخلص" searchPlaceholder="بحث عن مستخلص..." />
          </label>}
        </div>
        {isRetention && contractId > 0 && bills.length > 0 && onAddRemainingBills && !disabled && (
          <Button type="button" size="sm" variant="outline" onClick={() => onAddRemainingBills(bills
            .filter(row => Number.isFinite(retainedRemaining(row)) && retainedRemaining(row) > 0)
            .map(row => ({ allocation: { kind: value.kind, projectId, contractId, billId: row.id },
              amount: retainedRemaining(row).toFixed(2), billNumber: row.billNumber || `#${row.id}` })))}>
            إضافة كل مستخلصات المحتجز المتبقية كبنود مستقلة
          </Button>
        )}
        {isBill && value.billId && (() => {
          const bill = bills.find(row => row.id === value.billId);
          if (!bill) return <p role="alert" className="text-xs text-amber-800">المستخلص لم يعد ضمن الخيارات المتاحة؛ حدّث الاختيار قبل الحفظ.</p>;
          const remaining = isRetention ? retainedRemaining(bill) : Number(bill.remainingAmount ?? bill.remaining ?? (Number(bill.netAmount) - Number(bill.paidAmount || 0)));
          return Number.isFinite(remaining) ? <p role={Number(lineAmount) + otherAllocated > remaining ? "alert" : undefined} className="text-xs text-muted-foreground">{isRetention ? `محتجز المستخلص: ${Number(bill.retentionAmount || 0).toLocaleString("en-US")} • المفرج سابقاً: ${Number(bill.retentionReleasedAmount || 0).toLocaleString("en-US")} • المتبقي للإفراج: ` : "المتبقي للمستخلص: "}{remaining.toLocaleString("en-US")} • تخصيص هذا البند: {Number(lineAmount || 0).toLocaleString("en-US")} • بنود أخرى بهذا السند: {otherAllocated.toLocaleString("en-US")} {Number(lineAmount) + otherAllocated > remaining ? "— يتجاوز مجموع التخصيصات المتبقي؛ سيعيد الخادم التحقق عند الحفظ/الترحيل" : ""}</p> : null;
        })()}
        <p className="text-[11px] text-muted-foreground">يمكن توزيع المبلغ جزئياً على عدة بنود. الحساب المحاسبي يحدده النظام عند الحفظ؛ لا تُنشأ حركة نقدية إضافية.</p>
      </>)}
    </div>
  );
}