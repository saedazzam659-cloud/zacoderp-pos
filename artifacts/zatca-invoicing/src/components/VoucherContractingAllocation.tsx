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
  direction, entityId, value, onChange, disabled = false, lineAmount, otherAllocated = 0,
}: {
  direction: "receipt" | "payment";
  entityId: string;
  value: ContractingAllocation | null;
  onChange: (value: ContractingAllocation | null) => void;
  disabled?: boolean;
  lineAmount: string;
  otherAllocated?: number;
}) {
  const { user, token } = useAuth();
  const { data, isLoading, error } = useQuery<Options>({
    queryKey: [`${direction}-contracting-options`, user?.companyId, entityId],
    enabled: !!user?.companyId && !!token && !!entityId && !!value,
    queryFn: async () => {
      const query = new URLSearchParams({ companyId: String(user!.companyId), entityId });
      const response = await fetch(`${API}/api/${direction === "receipt" ? "receipt" : "payment"}-vouchers/contracting-options?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
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
  return (
    <div className="rounded-md border border-sky-200 bg-sky-50/50 p-3 space-y-2" data-testid="voucher-contracting-allocation">
      <label className="block text-xs font-semibold">توزيع مقاولات (اختياري)</label>
      <select
        className="w-full h-9 rounded-md border bg-background px-2 text-sm"
        value={value?.kind ?? ""}
        disabled={disabled}
        onChange={event => {
          const kind = event.target.value as ContractingAllocation["kind"] | "";
          onChange(kind ? { kind, projectId: 0, contractId: 0 } : null);
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
        {error && <p role="alert" className="text-xs text-destructive">{(error as Error).message}</p>}
        {isLoading && <p className="text-xs text-muted-foreground">جار تحميل المشاريع والعقود...</p>}
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-xs">المشروع
            <SearchCombobox items={projects.map(row => item(row, row.projectName || row.nameAr || row.name || row.code || `مشروع #${row.id}`))}
              value={projectId ? String(projectId) : ""} onValueChange={v => onChange({ kind: value.kind, projectId: Number(v) || 0, contractId: 0 })}
              disabled={disabled} placeholder="اختر المشروع" searchPlaceholder="بحث عن مشروع..." />
          </label>
          <label className="text-xs">العقد
            <SearchCombobox items={contracts.map(row => item(row, row.contractNumber || row.code || `عقد #${row.id}`))}
              value={contractId ? String(contractId) : ""} onValueChange={v => onChange({ kind: value.kind, projectId, contractId: Number(v) || 0 })}
              disabled={disabled || !projectId} placeholder="اختر العقد" searchPlaceholder="بحث عن عقد..." />
          </label>
          {isBill && <label className="text-xs">المستخلص المعتمد
            <SearchCombobox items={bills.map(row => item(row, row.billNumber || row.code || `مستخلص #${row.id}`))}
              value={value.billId ? String(value.billId) : ""} onValueChange={v => onChange({ ...value, billId: Number(v) || undefined })}
              disabled={disabled || !contractId} placeholder="اختر المستخلص" searchPlaceholder="بحث عن مستخلص..." />
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