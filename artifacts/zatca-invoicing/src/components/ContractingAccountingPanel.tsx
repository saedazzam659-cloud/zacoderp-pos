import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const API = import.meta.env.VITE_API_URL || "";

type Props = { projectId: number };
type Bill = {
  id: number; billNumber: string; direction: string; status: string;
  netAmount: string | number; retentionAmount: string | number;
  ownerContractId?: number | null; subcontractorContractId?: number | null;
  journalEntryId?: number | null;
};
type Settlement = {
  id: number; kind: string; direction: string; amount: string | number;
  applied_amount?: string | number; journal_entry_id?: number | null;
  bill_id?: number | null; settlement_date: string; status: string;
};
type MaterialMovement = {
  id: number; direction: "issue" | "return"; qty_base: string | number;
  total_cost: string | number; movement_date: string; journal_entry_id?: number | null;
  batch_number?: string | null; expiry_date?: string | null;
};
type Options = {
  items: Array<{ id: number; code: string; nameAr: string; unitId: number | null; batchTrackingMode?: string | null }>;
  units: Array<{ id: number; code: string; nameAr: string }>;
  warehouses: Array<{ id: number; code: string; nameAr: string }>;
  cashBoxes: Array<{ id: number; code: string; nameAr: string }>;
  banks: Array<{ id: number; code: string; nameAr: string }>;
  balances: Array<{ itemId: number; warehouseId: number; qtyBase: string | number; avgCost: string | number | null }>;
  ownerContracts: Array<{ id: number; contractNumber: string; clientName?: string | null }>;
  subcontractorContracts: Array<{ id: number; contractNumber: string }>;
};

const labelKind: Record<string, string> = {
  advance_receipt: "قبض سلفة من المالك",
  advance_payment: "صرف سلفة للمقاول الباطن",
  retention_receipt: "إفراج محتجزات من المالك",
  retention_payment: "صرف محتجزات للمقاول الباطن",
  bill_receipt: "تحصيل مستخلص من المالك",
  bill_payment: "سداد مستخلص المقاول الباطن",
  advance_application: "تطبيق سلفة",
};
export default function ContractingAccountingPanel({ projectId }: Props) {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [bills, setBills] = useState<Bill[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [movements, setMovements] = useState<MaterialMovement[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [options, setOptions] = useState<Options>({ items: [], units: [], warehouses: [], cashBoxes: [], banks: [], balances: [], ownerContracts: [], subcontractorContracts: [] });
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState("advance_receipt");
  const [amount, setAmount] = useState("");
  const [billId, setBillId] = useState("");
  const [ownerContractId, setOwnerContractId] = useState("");
  const [subcontractorContractId, setSubcontractorContractId] = useState("");
  const [paymentType, setPaymentType] = useState<"cash" | "bank">("cash");
  const [treasuryId, setTreasuryId] = useState("");
  const [settlementDate, setSettlementDate] = useState(new Date().toISOString().slice(0, 10));
  const [itemId, setItemId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [qty, setQty] = useState("");
  const [movementDirection, setMovementDirection] = useState<"issue" | "return">("issue");
  const [sourceMovementId, setSourceMovementId] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [lotExpiryDate, setLotExpiryDate] = useState("");
  const [lots, setLots] = useState<Array<{
    batchNumber: string | null; expiryDate: string | null;
    remainingBase: string; unitCost: string; expired: boolean;
  }>>([]);
  const [resourceId, setResourceId] = useState("");
  const [applySettlementId, setApplySettlementId] = useState("");
  const [applyBillId, setApplyBillId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");
  const operationKeys = useRef(new Map<string, string>());

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const reload = useCallback(async () => {
    if (!token || !projectId) return;
    const [billResponse, accountingResponse, materialResponse, optionsResponse] = await Promise.all([
      fetch(`${API}/api/contracting/projects/${projectId}/bills`, { headers }),
      fetch(`${API}/api/contracting/projects/${projectId}/settlements`, { headers }),
      fetch(`${API}/api/contracting/projects/${projectId}/material-movements`, { headers }),
      fetch(`${API}/api/contracting/projects/${projectId}/accounting/options`, { headers }),
    ]);
    if (billResponse.ok) setBills(await billResponse.json());
    if (accountingResponse.ok) {
      const data = await accountingResponse.json();
      setSettlements(data.settlements ?? []);
      setAudit(data.audit ?? []);
    }
    if (materialResponse.ok) setMovements(await materialResponse.json());
    if (optionsResponse.ok) setOptions(await optionsResponse.json());
  }, [headers, projectId, token]);
  useEffect(() => { void reload(); }, [reload]);

  const selectedItem = options.items.find((row) => row.id === Number(itemId));
  const selectedBatchMode = selectedItem?.batchTrackingMode === "fifo" || selectedItem?.batchTrackingMode === "fefo"
    ? selectedItem.batchTrackingMode
    : null;
  useEffect(() => {
    setLotNumber("");
    setLotExpiryDate("");
    if (!token || !projectId || !itemId || !warehouseId || !selectedBatchMode || movementDirection !== "issue") {
      setLots([]);
      return;
    }
    fetch(`${API}/api/contracting/projects/${projectId}/material-lots?itemId=${itemId}&warehouseId=${warehouseId}&movementDate=${encodeURIComponent(settlementDate)}`, { headers })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => setLots(data.lots ?? []))
      .catch((error: any) => {
        setLots([]);
        toast({ title: error?.message || "تعذر تحميل التشغيلات", variant: "destructive" });
      });
  }, [headers, itemId, warehouseId, movementDirection, projectId, selectedBatchMode, settlementDate, token, toast]);

  function operationKey(scope: string) {
    const existing = operationKeys.current.get(scope);
    if (existing) return existing;
    const value = `${scope}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    operationKeys.current.set(scope, value);
    return value;
  }

  async function post(url: string, body: Record<string, unknown>, operationScope?: string) {
    setBusy(true);
    try {
      const response = await fetch(`${API}${url}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (operationScope) operationKeys.current.delete(operationScope);
      toast({ title: "تم الترحيل المحاسبي بنجاح" });
      await reload();
      return data;
    } catch (error: any) {
      toast({ title: error?.message || "تعذر تنفيذ العملية", variant: "destructive" });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function approve(id: number, unapprove = false) {
    if (unapprove && !window.confirm("سيُنشأ قيد عكسي مرحّل مع الاحتفاظ بسجل التدقيق. هل تريد المتابعة؟")) return;
    await post(`/api/contracting/bills/${id}/${unapprove ? "unapprove" : "approve"}`, {});
  }

  async function correct(id: number) {
    if (!window.confirm("سيُعكس القيد الأصلي وتُنشأ مسودة تصحيح جديدة. هل تريد المتابعة؟")) return;
    await post(`/api/contracting/bills/${id}/correction`, {});
  }

  const requiresBill = kind.startsWith("retention_") || kind.startsWith("bill_");
  const advances = settlements.filter((s) => s.kind === "advance_receipt" || s.kind === "advance_payment");

  async function saveSettlement() {
    const scope = `settlement:${kind}:${billId || (kind === "advance_receipt" ? ownerContractId : subcontractorContractId) || "contract"}:${amount}:${paymentType}:${treasuryId}:${settlementDate}`;
    const result = await post(`/api/contracting/projects/${projectId}/settlements`, {
      kind, amount: Number(amount), billId: requiresBill ? Number(billId) : null,
      ownerContractId: !requiresBill && kind === "advance_receipt" ? Number(ownerContractId) : null,
      subcontractorContractId: !requiresBill && kind === "advance_payment" ? Number(subcontractorContractId) : null,
      settlementDate, paymentType,
      cashBoxId: paymentType === "cash" ? Number(treasuryId) : null,
      bankAccountId: paymentType === "bank" ? Number(treasuryId) : null,
      idempotencyKey: operationKey(scope),
    }, scope);
    if (result) setAmount("");
  }

  async function applyAdvance() {
    if (!applySettlementId || !applyBillId) return;
    const scope = `application:${applySettlementId}:${applyBillId}:${applyAmount}`;
    const result = await post(`/api/contracting/settlements/${applySettlementId}/apply`, {
      billId: Number(applyBillId), amount: Number(applyAmount), idempotencyKey: operationKey(scope),
    }, scope);
    if (result) setApplyAmount("");
  }

  async function saveMaterialMovement() {
    const scope = `material:${movementDirection}:${itemId}:${unitId}:${warehouseId}:${qty}:${sourceMovementId || "new"}:${lotNumber}:${lotExpiryDate}:${settlementDate}`;
    const result = await post(`/api/contracting/projects/${projectId}/material-movements`, {
      direction: movementDirection, itemId: Number(itemId), unitId: Number(unitId),
      warehouseId: Number(warehouseId), qty,
      resourceId: resourceId ? Number(resourceId) : null,
      sourceMovementId: movementDirection === "return" && sourceMovementId ? Number(sourceMovementId) : null,
      batchNumber: movementDirection === "issue" && lotNumber ? lotNumber : null,
      expiryDate: movementDirection === "issue" && lotNumber ? lotExpiryDate || null : undefined,
      movementDate: settlementDate, idempotencyKey: operationKey(scope),
    }, scope);
    if (result) setQty("");
  }

  const approvedBills = bills.filter((bill) => bill.status === "approved");
  const selectedBalance = options.balances.find((row) => row.itemId === Number(itemId) && row.warehouseId === Number(warehouseId));

  return (
    <div dir="rtl" className="space-y-5">
      <div className="rounded-lg border bg-white p-4 shadow-sm dark:bg-slate-950">
        <h3 className="mb-3 text-base font-bold">اعتماد المستخلصات والدفتر العام</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-right text-slate-500">
              <th className="p-2">المستخلص</th><th className="p-2">الاتجاه</th><th className="p-2">الصافي</th>
              <th className="p-2">الحالة</th><th className="p-2">الإجراء</th>
            </tr></thead>
            <tbody>{bills.map((bill) => (
              <tr key={bill.id} className="border-b last:border-0">
                <td className="p-2 font-medium">{bill.billNumber}</td>
                <td className="p-2">{bill.direction === "incoming" ? "مقاول باطن" : "مالك"}</td>
                <td className="p-2">{Number(bill.netAmount || 0).toLocaleString("en-US")}</td>
                <td className="p-2">{bill.status === "approved" ? "معتمد ومرحل" : bill.status === "reversed" ? "معكوس" : bill.status}</td>
                <td className="p-2">
                  {bill.status === "approved" ? (
                    <>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void approve(bill.id, true)}>فك الاعتماد بقيد عكسي</Button>
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void correct(bill.id)}>تصحيح مرحّل</Button>
                    </>
                  ) : bill.status === "posted" ? (
                    <Button size="sm" variant="destructive" disabled={busy} onClick={() => void correct(bill.id)}>تصحيح مرحّل</Button>
                ) : bill.status === "reversed" ? (
                    <span className="text-xs text-slate-500">معكوس — راجع مسودة التصحيح المرتبطة</span>
                  ) : ["posted", "partially_paid", "paid"].includes(bill.status) ? (
                    <span className="text-xs text-slate-500">مقيد محاسبياً — لا تعديل مباشر</span>
                  ) : (
                    <Button size="sm" disabled={busy} onClick={() => void approve(bill.id)}>اعتماد وترحيل ذري</Button>
                  )}
                </td>
              </tr>
            ))}</tbody>
          </table>
          {!bills.length && <div className="py-5 text-center text-sm text-slate-500">لا توجد مستخلصات</div>}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border bg-white p-4 shadow-sm dark:bg-slate-950">
          <h3 className="mb-3 font-bold">السلف والمحتجزات — قيود القبض والصرف</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">نوع العملية
              <select className="mt-1 w-full rounded-md border bg-transparent p-2" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="advance_receipt">قبض سلفة من المالك</option>
                <option value="advance_payment">صرف سلفة للمقاول الباطن</option>
                <option value="retention_receipt">إفراج محتجزات من المالك</option>
                <option value="retention_payment">صرف محتجزات للمقاول الباطن</option>
                <option value="bill_receipt">تحصيل مستخلص من المالك</option>
                <option value="bill_payment">سداد مستخلص المقاول الباطن</option>
              </select>
            </label>
            <label className="text-sm">المبلغ<Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            {requiresBill && <label className="text-sm">المستخلص المعتمد
              <select className="mt-1 w-full rounded-md border bg-transparent p-2" value={billId} onChange={(e) => setBillId(e.target.value)}>
                <option value="">اختر مستخلصاً</option>
                {approvedBills.map((bill) => <option key={bill.id} value={bill.id}>{bill.billNumber} — محتجز {bill.retentionAmount}</option>)}
              </select>
            </label>}
            {!requiresBill && kind === "advance_receipt" && <label className="text-sm">عقد المالك
              <select className="mt-1 w-full rounded-md border bg-transparent p-2" value={ownerContractId} onChange={(e) => setOwnerContractId(e.target.value)}>
                <option value="">اختر عقداً</option>
                {options.ownerContracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.contractNumber}{contract.clientName ? ` — ${contract.clientName}` : ""}</option>)}
              </select>
            </label>}
            {!requiresBill && kind === "advance_payment" && <label className="text-sm">عقد المقاول الباطن
              <select className="mt-1 w-full rounded-md border bg-transparent p-2" value={subcontractorContractId} onChange={(e) => setSubcontractorContractId(e.target.value)}>
                <option value="">اختر عقداً</option>
                {options.subcontractorContracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.contractNumber}</option>)}
              </select>
            </label>}
            <label className="text-sm">التاريخ<Input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} /></label>
            <label className="text-sm">طريقة السداد
              <select className="mt-1 w-full rounded-md border bg-transparent p-2" value={paymentType} onChange={(e) => { setPaymentType(e.target.value as any); setTreasuryId(""); }}>
                <option value="cash">نقدي — خزنة</option><option value="bank">بنكي — حساب بنكي</option>
              </select>
            </label>
            <label className="text-sm">{paymentType === "cash" ? "الخزنة" : "الحساب البنكي"}
              <select className="mt-1 w-full rounded-md border bg-transparent p-2" value={treasuryId} onChange={(e) => setTreasuryId(e.target.value)}>
                <option value="">اختر الحساب</option>
                {(paymentType === "cash" ? options.cashBoxes : options.banks).map((row) => <option key={row.id} value={row.id}>{row.code} — {row.nameAr}</option>)}
              </select>
            </label>
          </div>
          <Button className="mt-3" disabled={busy || !amount || !treasuryId || (requiresBill && !billId) || (!requiresBill && kind === "advance_receipt" && !ownerContractId) || (!requiresBill && kind === "advance_payment" && !subcontractorContractId)} onClick={() => void saveSettlement()}>ترحيل القيد</Button>
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm dark:bg-slate-950">
          <h3 className="mb-3 font-bold">تطبيق سلفة على مستخلص</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-sm">السلفة
              <select className="mt-1 w-full rounded-md border bg-transparent p-2" value={applySettlementId} onChange={(e) => setApplySettlementId(e.target.value)}>
                <option value="">اختر السلفة</option>
                {advances.map((row) => <option key={row.id} value={row.id}>{labelKind[row.kind]} #{row.id} — متاح {(Number(row.amount) - Number(row.applied_amount || 0)).toLocaleString("en-US")}</option>)}
              </select>
            </label>
            <label className="text-sm">المستخلص
              <select className="mt-1 w-full rounded-md border bg-transparent p-2" value={applyBillId} onChange={(e) => setApplyBillId(e.target.value)}>
                <option value="">اختر مستخلصاً</option>
                {approvedBills.map((bill) => <option key={bill.id} value={bill.id}>{bill.billNumber}</option>)}
              </select>
            </label>
            <label className="text-sm">مبلغ التطبيق<Input type="number" min="0.01" step="0.01" value={applyAmount} onChange={(e) => setApplyAmount(e.target.value)} /></label>
          </div>
          <Button className="mt-3" variant="outline" disabled={busy || !applySettlementId || !applyBillId || !applyAmount} onClick={() => void applyAdvance()}>ترحيل تطبيق السلفة</Button>
        </section>
      </div>

      <section className="rounded-lg border bg-white p-4 shadow-sm dark:bg-slate-950">
        <h3 className="mb-3 font-bold">صرف وإرجاع مواد فعلية للمشروع</h3>
        <p className="mb-3 text-xs text-slate-500">لا يغيّر هذا النموذج حالة المورد المخطط؛ بل ينشئ حركة مخزون فعلية وقيد تكلفة مشروع متوازناً.</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm">الحركة<select className="mt-1 w-full rounded-md border bg-transparent p-2" value={movementDirection} onChange={(e) => setMovementDirection(e.target.value as any)}><option value="issue">صرف مواد</option><option value="return">إرجاع مواد</option></select></label>
          <label className="text-sm">الصنف<select className="mt-1 w-full rounded-md border bg-transparent p-2" value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">اختر الصنف</option>{options.items.map((row) => <option key={row.id} value={row.id}>{row.code} — {row.nameAr}</option>)}</select></label>
          <label className="text-sm">الوحدة<select className="mt-1 w-full rounded-md border bg-transparent p-2" value={unitId} onChange={(e) => setUnitId(e.target.value)}><option value="">اختر الوحدة</option>{options.units.map((row) => <option key={row.id} value={row.id}>{row.code} — {row.nameAr}</option>)}</select></label>
          <label className="text-sm">المخزن<select className="mt-1 w-full rounded-md border bg-transparent p-2" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}><option value="">اختر المخزن</option>{options.warehouses.map((row) => <option key={row.id} value={row.id}>{row.code} — {row.nameAr}</option>)}</select>{selectedBalance && <span className="mt-1 block text-xs text-slate-500">الرصيد الفعلي: {Number(selectedBalance.qtyBase).toLocaleString("en-US")} • تكلفة الوحدة: {Number(selectedBalance.avgCost || 0).toLocaleString("en-US")}</span>}</label>
          {movementDirection === "issue" && selectedBatchMode && <label className="text-sm">التشغيلة ({selectedBatchMode === "fefo" ? "FEFO" : "FIFO"})
            <select className="mt-1 w-full rounded-md border bg-transparent p-2" value={`${lotNumber}|${lotExpiryDate}`} onChange={(e) => {
              const [batch, expiry = ""] = e.target.value.split("|");
              setLotNumber(batch === "__auto__" ? "" : batch === "__unbatched__" ? "__unbatched__" : batch);
              setLotExpiryDate(expiry);
            }}>
              <option value="__auto__|">تخصيص تلقائي حسب {selectedBatchMode.toUpperCase()}</option>
              {lots.map((lot) => {
                const key = `${lot.batchNumber ?? "__unbatched__"}|${lot.expiryDate ?? ""}`;
                return <option key={key} value={key} disabled={lot.expired}>
                  {(lot.batchNumber ?? "بدون رقم تشغيلة")} — متاح {lot.remainingBase} — تكلفة {lot.unitCost}{lot.expiryDate ? ` — انتهاء ${lot.expiryDate}` : ""}{lot.expired ? " — منتهية" : ""}
                </option>;
              })}
            </select>
            <span className="mt-1 block text-[11px] text-slate-500">اتركها تلقائياً لتطبيق ترتيب {selectedBatchMode.toUpperCase()} عبر طبقات التقييم الفعلية.</span>
          </label>}
          <label className="text-sm">الكمية<Input type="number" min="0.000000000000000001" step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
          <label className="text-sm">معرّف المورد (اختياري)<Input type="number" value={resourceId} onChange={(e) => setResourceId(e.target.value)} /></label>
          {movementDirection === "return" && <label className="text-sm">رقم حركة الصرف الأصلية<Input type="number" value={sourceMovementId} onChange={(e) => setSourceMovementId(e.target.value)} /></label>}
        </div>
        <Button className="mt-3" disabled={busy || !itemId || !unitId || !warehouseId || !qty || (movementDirection === "return" && !sourceMovementId)} onClick={() => void saveMaterialMovement()}>ترحيل حركة المواد والقيد</Button>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs">
             <thead><tr className="border-b text-right text-slate-500"><th className="p-2">الحركة</th><th className="p-2">التاريخ</th><th className="p-2">التشغيلة</th><th className="p-2">كمية الأساس</th><th className="p-2">التكلفة</th><th className="p-2">القيد</th></tr></thead>
            <tbody>{movements.map((row) => (
              <tr key={row.id} className="border-b last:border-0">
                <td className="p-2">{row.direction === "issue" ? "صرف" : "إرجاع"} #{row.id}</td>
                <td className="p-2">{row.movement_date}</td>
                 <td className="p-2">{row.batch_number ?? "—"}{row.expiry_date ? ` • ${row.expiry_date}` : ""}</td>
                 <td className="p-2">{String(row.qty_base)}</td>
                 <td className="p-2">{String(row.total_cost)}</td>
                <td className="p-2">#{row.journal_entry_id ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table>
          {!movements.length && <div className="py-3 text-center text-xs text-slate-500">لا توجد حركات مواد مرحّلة</div>}
        </div>
      </section>

      <section className="rounded-lg border bg-white p-4 shadow-sm dark:bg-slate-950">
        <h3 className="mb-3 font-bold">سجل التسويات والتدقيق المحاسبي</h3>
        <div className="space-y-1 text-sm">
          {settlements.map((row) => <div key={row.id} className="flex flex-wrap justify-between gap-2 border-b py-2"><span>{labelKind[row.kind] || row.kind} #{row.id}{row.bill_id ? ` — مستخلص #${row.bill_id}` : ""}</span><span>{Number(row.amount).toLocaleString("en-US")} • قيد #{row.journal_entry_id ?? "—"}</span></div>)}
          {!settlements.length && <div className="text-slate-500">لا توجد تسويات مرحّلة</div>}
          {audit.slice(0, 10).map((row) => <div key={`audit-${row.id}`} className="text-xs text-slate-500">#{row.id} — {row.action} — {new Date(row.created_at).toLocaleString("ar-SA")}</div>)}
        </div>
      </section>
    </div>
  );
}