import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useAuth } from "@/contexts/AuthContext";

export type ContractingAllocation = {
  kind: "owner_advance" | "owner_bill" | "subcontract_advance" | "subcontract_bill";
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
};
type Options = { projects: Option[]; contracts: Option[]; bills: Option[] };
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
export const positiveId = (value: string | null): number | null =>
  value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

export function VoucherContractingAllocation({
  direction, entityId, value, onChange, onAmountSuggested, disabled = false, lineAmount, otherAllocated = 0,
}: {
  direction: "receipt" | "payment";
  entityId: string;
  value: ContractingAllocation | null;
  onChange: (value: ContractingAllocation | null) => void;
  onAmountSuggested?: (amount: string) => void;
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
       if (!Array.isArray(json.projects) || !Array.isArray(json.contracts) || !Array.isArray(json.bills))
         throw new Error("استجابة خيارات المقاولات غير صالحة");
      return json;
    },
  });
  const isBill = value?.kind.endsWith("_bill");
  const projectId = value?.projectId || 0;
  const contractId = value?.contractId || 0;
  const projects = data?.projects ?? [];
  const contracts = (data?.contracts ?? []).filter(row => Number(row.projectId) === projectId);
  const bills = (data?.bills ?? []).filter(row =>
    Number(row.projectId) === projectId &&
    Number(row.contractId ?? row.ownerContractId ?? row.subcontractorContractId) === contractId);
  const item = (row: Option, label: string) => ({
    value: String(row.id),
    label,
    description: row.remainingAmount != null || row.remaining != null || row.netAmount != null
      ? `المتبقي ${Number(row.remainingAmount ?? row.remaining ?? (Number(row.netAmount) - Number(row.paidAmount || 0))).toLocaleString("en-US")}`
      : undefined,
  });
  const suggest = (row?: Option) => {
    if (!row) return;
    const remaining = Number(row.remainingAmount ?? row.remaining ??
      (row.netAmount != null ? Number(row.netAmount) - Number(row.paidAmount || 0) : NaN));
    if (Number.isFinite(remaining) && remaining > 0)
      onAmountSuggested?.(remaining.toFixed(2));
  };
  const chooseKind = (kind: ContractingAllocation["kind"] | "") => {
    if (!kind) { onChange(null); return; }
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
      <select
        className="w-full h-9 rounded-md border bg-background px-2 text-sm"
        value={value?.kind ?? ""}
        disabled={disabled}
        onChange={event => {
          const kind = event.target.value as ContractingAllocation["kind"] | "";
           chooseKind(kind);
        }}
      >
        <option value="">بند عادي — بدون ربط مقاولات</option>
        {direction === "receipt" ? <>
          <option value="owner_advance">سلفة من المالك</option>
          <option value="owner_bill">تحصيل مستخلص المالك</option>
        </> : <>
          <option value="subcontract_advance">سلفة للمقاول الباطن</option>
          <option value="subcontract_bill">سداد مستخلص المقاول الباطن</option>
        </>}
      </select>
      {value && (!entityId ? <p className="text-xs text-amber-700">اختر {direction === "receipt" ? "العميل" : "المورد"} أولاً لعرض المشاريع المرتبطة.</p> : <>
         {error && <p role="alert" className="text-xs text-destructive">تعذر تحميل خيارات المقاولات: {(error as Error).message}</p>}
        {isLoading && <p className="text-xs text-muted-foreground">جار تحميل المشاريع والعقود...</p>}
         {data && !projects.length && <p className="text-xs text-muted-foreground">لا توجد مشاريع مرتبطة بهذا {direction === "receipt" ? "العميل" : "المورد"}.</p>}
         {data && projectId > 0 && !contracts.length &&
           <p role="alert" className="text-xs text-amber-800">لا يوجد عقد نشط أو مكتمل مرتبط بهذا المشروع وبهذا {direction === "receipt" ? "العميل" : "المورد"}؛ لا يمكن تخصيص البند قبل اختيار عقد صالح.</p>}
         {data && isBill && contractId > 0 && !bills.length &&
           <p role="alert" className="text-xs text-amber-800">لا توجد مستخلصات معتمدة متاحة لهذا العقد؛ لا يمكن تخصيص بند مستخلص حالياً.</p>}
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-xs">المشروع
            <SearchCombobox items={projects.map(row => item(row, row.projectName || row.nameAr || row.name || row.code || `مشروع #${row.id}`))}
               value={projectId ? String(projectId) : ""} onValueChange={v => {
                 const matching = data?.contracts.filter(row => Number(row.projectId) === Number(v)) ?? [];
                 const contract = matching.length === 1 ? matching[0] : undefined;
                 onChange({ kind: value.kind, projectId: Number(v) || 0, contractId: contract?.id ?? 0 });
                 if (contract && !isBill) suggest(contract);
               }}
              disabled={disabled} placeholder="اختر المشروع" searchPlaceholder="بحث عن مشروع..." />
          </label>
          <label className="text-xs">العقد
            <SearchCombobox items={contracts.map(row => item(row, row.contractNumber || row.code || `عقد #${row.id}`))}
               value={contractId ? String(contractId) : ""} onValueChange={v => {
                 onChange({ kind: value.kind, projectId, contractId: Number(v) || 0 });
                 if (!isBill) suggest(contracts.find(row => String(row.id) === v));
               }}
               disabled={disabled || !projectId || !contracts.length} placeholder="اختر العقد" searchPlaceholder="بحث عن عقد..." />
          </label>
          {isBill && <label className="text-xs">المستخلص المعتمد
            <SearchCombobox items={bills.map(row => item(row, row.billNumber || row.code || `مستخلص #${row.id}`))}
               value={value.billId ? String(value.billId) : ""} onValueChange={v => {
                 onChange({ ...value, billId: Number(v) || undefined });
                 suggest(bills.find(row => String(row.id) === v));
               }}
               disabled={disabled || !contractId || !bills.length} placeholder="اختر المستخلص" searchPlaceholder="بحث عن مستخلص..." />
          </label>}
        </div>
        {isBill && value.billId && (() => {
          const bill = bills.find(row => row.id === value.billId);
          if (!bill) return null;
          const remaining = Number(bill.remainingAmount ?? bill.remaining ?? (Number(bill.netAmount) - Number(bill.paidAmount || 0)));
          return Number.isFinite(remaining) ? <p className="text-xs text-muted-foreground">المتبقي للمستخلص: {remaining.toLocaleString("en-US")} • تخصيص هذا البند: {Number(lineAmount || 0).toLocaleString("en-US")} • بنود أخرى بهذا السند: {otherAllocated.toLocaleString("en-US")} {Number(lineAmount) + otherAllocated > remaining ? "— يتجاوز مجموع التخصيصات المتبقي (سيتحقق الخادم عند الترحيل)" : ""}</p> : null;
        })()}
        <p className="text-[11px] text-muted-foreground">يمكن توزيع المبلغ جزئياً على عدة بنود. الحساب المحاسبي يحدده النظام عند الحفظ؛ لا تُنشأ حركة نقدية إضافية.</p>
      </>)}
    </div>
  );
}