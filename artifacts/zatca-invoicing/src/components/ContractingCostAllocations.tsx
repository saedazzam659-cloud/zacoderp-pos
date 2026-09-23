import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RotateCcw, Scale } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const API = import.meta.env.VITE_API_URL || "";

type Allocation = {
  id: number;
  category: string;
  source_type: string;
  source_record_id: number;
  allocated_amount: string | number;
  reversal_of_id: number | null;
  owner_contract_id: number | null;
  subcontractor_contract_id: number | null;
  boq_line_id: number | null;
  created_at: string;
};

type Payload = {
  allocations: Allocation[];
  totals: Array<{ category: string; amount: number | null; available: boolean }>;
  coverage: { complete: boolean; missingCategories: string[]; note: string | null };
};

type CostSourceOption = {
  id: number;
  label: string;
  sourceDate: string;
  amount: number;
  allocated: number;
  available: number;
  equipmentAssetId?: number | null;
  approvedOperatingHours?: number | null;
  availableOperatingHours?: number | null;
  allocationMethod?: string | null;
};

const SOURCE_TYPES = [
  ["payroll_snapshot", "توزيع راتب مرحّل"],
  ["fixed_asset_depreciation", "إهلاك أصل مرحّل"],
  ["purchase_invoice_line", "سطر فاتورة شراء مرحلة"],
  ["subcontract_bill", "مستخلص مقاول باطن مرحّل"],
  ["journal_expense_line", "سطر مصروف من قيد/سند صرف مرحّل"],
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  material: "مواد",
  labor: "عمالة",
  equipment: "معدات",
  depreciation: "إهلاك",
  purchases: "مشتريات",
  subcontract: "مقاول باطن",
  direct_expense: "مصروف مباشر",
};

export type ContractingCostAllocationsProps = {
  projectId: number;
  ownerContractId?: number | null;
  subcontractorContractId?: number | null;
  boqLineId?: number | null;
};

export default function ContractingCostAllocations({
  projectId,
  ownerContractId = null,
  subcontractorContractId = null,
  boqLineId = null,
}: ContractingCostAllocationsProps) {
  const { token, actingCompanyId } = useAuth() as any;
  const { toast } = useToast();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [sourceType, setSourceType] = useState("payroll_snapshot");
  const [category, setCategory] = useState("labor");
  const [sourceRecordId, setSourceRecordId] = useState("");
  const [sourceOptions, setSourceOptions] = useState<CostSourceOption[]>([]);
  const [sourceCapabilities, setSourceCapabilities] = useState<Record<string, string>>({});
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourceRefreshGeneration, setSourceRefreshGeneration] = useState(0);
  const [amount, setAmount] = useState("");
  const [sharePct, setSharePct] = useState("");
  const [equipmentHours, setEquipmentHours] = useState("");
  const [busy, setBusy] = useState(false);
  const operationKeys = useRef(new Map<string, string>());

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token ?? ""}`,
    ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
  }), [actingCompanyId, token]);

  const load = useCallback(async () => {
    if (!token || !projectId) return;
    const response = await fetch(`${API}/api/contracting/projects/${projectId}/cost-allocations`, { headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    setPayload(body);
  }, [headers, projectId, token]);

  useEffect(() => {
    void load().catch((error: Error) => toast({
      title: "تعذر تحميل توزيعات التكلفة",
      description: error.message,
      variant: "destructive",
    }));
  }, [load, toast]);

  useEffect(() => {
    if (!token || !projectId) return;
    let cancelled = false;
    setSourcesLoading(true);
    setSourceRecordId("");
    fetch(`${API}/api/contracting/projects/${projectId}/cost-sources?sourceType=${encodeURIComponent(sourceType)}`, { headers })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
        if (!cancelled) {
          setSourceOptions(Array.isArray(body.sources) ? body.sources : []);
          setSourceCapabilities(body.capabilities ?? {});
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setSourceOptions([]);
          toast({ title: "تعذر تحميل المصادر المرحلة", description: error.message, variant: "destructive" });
        }
      })
      .finally(() => { if (!cancelled) setSourcesLoading(false); });
    return () => { cancelled = true; };
  }, [category, headers, projectId, sourceRefreshGeneration, sourceType, toast, token]);

  function key(scope: string) {
    const existing = operationKeys.current.get(scope);
    if (existing) return existing;
    const created = `${scope}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    operationKeys.current.set(scope, created);
    return created;
  }

  async function allocate() {
    const scope = `allocate:${projectId}:${sourceType}:${category}:${sourceRecordId}:${amount}:${sharePct}:${equipmentHours}:${ownerContractId}:${subcontractorContractId}:${boqLineId}`;
    setBusy(true);
    try {
      const response = await fetch(`${API}/api/contracting/projects/${projectId}/cost-allocations`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType,
          category,
          sourceRecordId: Number(sourceRecordId),
          ...(category === "equipment"
            ? { equipmentHours: Number(equipmentHours) }
            : amount ? { amount: Number(amount) } : { sharePct: Number(sharePct) }),
          ownerContractId,
          subcontractorContractId,
          boqLineId,
          idempotencyKey: key(scope),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      operationKeys.current.delete(scope);
      setAmount("");
      setSharePct("");
      setEquipmentHours("");
      setSourceRefreshGeneration(value => value + 1);
      toast({ title: "تم حفظ التوزيع التحليلي دون إنشاء قيد جديد" });
      await load();
    } catch (error: any) {
      toast({ title: "تعذر توزيع التكلفة", description: error?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function reverse(row: Allocation) {
    if (!window.confirm(`عكس أثر توزيع التكلفة #${row.id}؟ لن يُنشأ قيد محاسبي جديد.`)) return;
    const scope = `reverse:${row.id}`;
    setBusy(true);
    try {
      const response = await fetch(`${API}/api/contracting/cost-allocations/${row.id}/reverse`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: key(scope) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      operationKeys.current.delete(scope);
      setSourceRefreshGeneration(value => value + 1);
      toast({ title: "تم عكس أثر التكلفة التحليلي" });
      await load();
    } catch (error: any) {
      toast({ title: "تعذر عكس التوزيع", description: error?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const reversedIds = new Set(
    payload?.allocations.filter(row => row.reversal_of_id != null).map(row => Number(row.reversal_of_id)) ?? [],
  );
  const eligibleSourceOptions = category === "equipment"
    ? sourceOptions.filter(option =>
        option.allocationMethod === "operating_hours"
        && Number(option.approvedOperatingHours) > 0
        && Number(option.equipmentAssetId) > 0)
    : sourceOptions;

  return (
    <section dir="rtl" className="space-y-4" data-testid="contracting-cost-allocations">
      <div className="rounded-lg border bg-white p-4 shadow-sm dark:bg-slate-950">
        <div className="mb-1 flex items-center gap-2 font-bold">
          <Scale className="h-4 w-4 text-indigo-600" />
          التوزيع التحليلي للتكاليف المرحلة
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          يربط تكلفة سجلها النظام المصدر بالمشروع والعقد والبند فقط؛ لا ينشئ قيداً أو صنفاً أو موظفاً أو أصلاً جديداً.
        </p>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-sm">المصدر
            <select className="mt-1 h-10 w-full rounded-md border bg-background px-3" value={sourceType} onChange={event => {
              const value = event.target.value;
              setSourceType(value);
              setCategory(value === "payroll_snapshot" ? "labor"
                : value === "fixed_asset_depreciation" ? "depreciation"
                  : value === "subcontract_bill" ? "subcontract"
                    : value === "journal_expense_line" ? "direct_expense" : "purchases");
            }}>
              {SOURCE_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="text-sm">الفئة
            <select className="mt-1 h-10 w-full rounded-md border bg-background px-3" value={category} onChange={event => {
              setCategory(event.target.value);
              setSourceRecordId("");
            }}>
              {sourceType === "payroll_snapshot" && <option value="labor">عمالة</option>}
              {sourceType === "fixed_asset_depreciation" && <>
                <option value="depreciation">إهلاك</option><option value="equipment">معدات — توزيع إهلاك مرحّل فقط</option>
              </>}
              {sourceType === "purchase_invoice_line" && <>
                <option value="purchases">مشتريات</option><option value="direct_expense">مصروف مباشر</option>
              </>}
              {sourceType === "subcontract_bill" && <option value="subcontract">مقاول باطن</option>}
              {sourceType === "journal_expense_line" && <option value="direct_expense">مصروف مباشر عام</option>}
            </select>
          </label>
          <label className="text-sm">السجل المرحّل المتاح
            <select className="mt-1 h-10 w-full rounded-md border bg-background px-3" value={sourceRecordId} onChange={event => setSourceRecordId(event.target.value)} disabled={sourcesLoading}>
              <option value="">{sourcesLoading ? "جارٍ التحميل…" : eligibleSourceOptions.length ? "اختر المصدر" : "لا توجد مصادر قابلة للتوزيع"}</option>
              {eligibleSourceOptions.map(option => (
                <option key={option.id} value={option.id}>
                  {option.label} — {option.sourceDate} — متاح {option.available.toLocaleString("en-US")}
                </option>
              ))}
            </select>
          </label>
          {category === "equipment" ? (
            <label className="text-sm">ساعات تشغيل المعدة الفعلية
              <Input className="mt-1" type="number" min="0.0001" step="0.0001" value={equipmentHours} onChange={event => setEquipmentHours(event.target.value)} />
              <span className="mt-1 block text-xs text-muted-foreground">
                المقام المعتمد: {eligibleSourceOptions.find(option => String(option.id) === sourceRecordId)?.approvedOperatingHours ?? "—"} ساعة؛
                المتبقي القابل للتوزيع: {eligibleSourceOptions.find(option => String(option.id) === sourceRecordId)?.availableOperatingHours ?? "—"} ساعة
              </span>
            </label>
          ) : <>
            <label className="text-sm">المبلغ (أو اتركه واستخدم النسبة)
              <Input className="mt-1" type="number" min="0.01" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} />
            </label>
            <label className="text-sm">النسبة %
              <Input className="mt-1" type="number" min="0.000001" max="100" step="any" value={sharePct} onChange={event => setSharePct(event.target.value)} disabled={Boolean(amount)} />
            </label>
          </>}
        </div>
        {(sourceType === "fixed_asset_depreciation" || sourceType === "purchase_invoice_line") && (
          <p className="mt-2 text-xs text-muted-foreground">
            {sourceType === "fixed_asset_depreciation"
              ? sourceCapabilities.equipment
              : `${sourceCapabilities.directExpense ?? ""} ${sourceCapabilities.inventory ?? ""}`}
          </p>
        )}
        <Button className="mt-3" disabled={busy || !sourceRecordId || (category === "equipment" ? !equipmentHours : (!amount && !sharePct))} onClick={() => void allocate()}>
          حفظ التوزيع
        </Button>
      </div>

      {payload && (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {payload.totals.map(row => (
              <div key={row.category} className="rounded-lg border bg-white p-3 dark:bg-slate-950">
                <div className="text-xs text-muted-foreground">{CATEGORY_LABELS[row.category] ?? row.category}</div>
                <div className="mt-1 font-bold tabular-nums">
                  {row.available ? Number(row.amount).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "غير مكتمل"}
                </div>
              </div>
            ))}
          </div>
          {!payload.coverage.complete && (
            <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{payload.coverage.note} الفئات: {payload.coverage.missingCategories.map(item => CATEGORY_LABELS[item] ?? item).join("، ")}</span>
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border bg-white dark:bg-slate-950">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-right text-muted-foreground">
                <th className="p-2">#</th><th className="p-2">الفئة</th><th className="p-2">المصدر</th>
                <th className="p-2">العقد / البند</th><th className="p-2">الأثر</th><th className="p-2">الإجراء</th>
              </tr></thead>
              <tbody>{payload.allocations.map(row => (
                <tr key={row.id} className="border-b last:border-0">
                  <td className="p-2">{row.id}</td>
                  <td className="p-2"><Badge variant="outline">{CATEGORY_LABELS[row.category] ?? row.category}</Badge></td>
                  <td className="p-2">{row.source_type} #{row.source_record_id}</td>
                  <td className="p-2">
                    {row.owner_contract_id ? `مالك #${row.owner_contract_id}` : row.subcontractor_contract_id ? `باطن #${row.subcontractor_contract_id}` : "المشروع"}
                    {row.boq_line_id ? ` • بند #${row.boq_line_id}` : ""}
                  </td>
                  <td className={`p-2 tabular-nums ${Number(row.allocated_amount) < 0 ? "text-rose-600" : ""}`}>
                    {Number(row.allocated_amount).toLocaleString("en-US")}
                  </td>
                  <td className="p-2">
                    {row.reversal_of_id != null ? <span className="text-xs text-muted-foreground">عكس #{row.reversal_of_id}</span>
                      : reversedIds.has(row.id) ? <span className="text-xs text-muted-foreground">معكوس</span>
                        : <Button size="sm" variant="outline" disabled={busy} onClick={() => void reverse(row)}>
                          <RotateCcw className="me-1 h-3.5 w-3.5" />عكس
                        </Button>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}