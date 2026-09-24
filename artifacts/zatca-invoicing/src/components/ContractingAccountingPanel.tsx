import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { usePermission } from "@/hooks/usePermission";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { useLocation } from "wouter";
import ContractingOperationsLedger, { type LedgerRow } from "@/components/ContractingOperationsLedger";

const API = import.meta.env.VITE_API_URL || "";

type Props = { projectId: number; onOpenBill: (id: number, direction: "incoming" | "outgoing") => void };
type Bill = {
  id: number; billNumber: string; billDate?: string; direction: string; status: string;
  netAmount: string | number; retentionAmount: string | number;
  ownerContractId?: number | null; subcontractorContractId?: number | null;
  journalEntryId?: number | null;
  paidAmount?: string | number;
  remainingAmount?: string | number;
};
type Settlement = {
  id: number; kind: string; direction: string; amount: string | number;
  applied_amount?: string | number; journal_entry_id?: number | null;
  reversal_journal_entry_id?: number | null;
  bill_id?: number | null; settlement_date: string; status: string;
  source_settlement_id?: number | null; owner_contract_id?: number | null; subcontractor_contract_id?: number | null;
  application_origin?: string | null; payment_type?: string | null; cash_box_id?: number | null; bank_account_id?: number | null;
  voucher_code?: string | null;
  source_voucher_type?: "receipt" | "payment" | null; source_voucher_id?: number | null;
};
type MaterialMovement = {
  id: number; direction: "issue" | "return"; qty_base: string | number;
  total_cost: string | number; movement_date: string; journal_entry_id?: number | null;
  batch_number?: string | null; expiry_date?: string | null;
  item_id?: number | null; unit_id?: number | null; warehouse_id?: number | null; source_movement_id?: number | null;
  ownerContractId?: number | null; subcontractorContractId?: number | null; boqLineId?: number | null;
  owner_contract_id?: number | null; subcontractor_contract_id?: number | null; boq_line_id?: number | null;
};
type Options = {
  projectCustomerId?: number | null;
  items: Array<{ id: number; code: string; nameAr: string; unitId: number | null; batchTrackingMode?: string | null }>;
  units: Array<{ id: number; code: string; nameAr: string }>;
  warehouses: Array<{ id: number; code: string; nameAr: string }>;
  cashBoxes: Array<{ id: number; code: string; nameAr: string }>;
  banks: Array<{ id: number; code: string; nameAr: string }>;
  balances: Array<{ itemId: number; warehouseId: number; qtyBase: string | number; avgCost: string | number | null }>;
  ownerContracts: Array<{ id: number; contractNumber: string; clientName?: string | null; customerId: number | null }>;
  subcontractorContracts: Array<{ id: number; contractNumber: string }>;
  boqLines?: Array<{
    id: number;
    direction: "owner" | "subcontract";
    ownerContractId: number | null;
    subcontractorContractId: number | null;
    lineCode?: string | null;
    description?: string | null;
    workItemName?: string | null;
  }>;
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
export default function ContractingAccountingPanel({ projectId, onOpenBill }: Props) {
  const [, navigate] = useLocation();
  const { token, user } = useAuth();
  const canViewContracting = usePermission("contracting", "view");
  const permissions = (user as any)?.permissions?.contracting;
  const canUnapprove = canViewContracting && (
    user?.role === "admin" || user?.role === "superadmin"
    || permissions?.cancel === true
    || (permissions?.cancel === undefined && permissions?.unpost === true)
  );
  const { toast } = useToast();
  const [bills, setBills] = useState<Bill[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [voucherCodes, setVoucherCodes] = useState<Record<string, string>>({});
  const [movements, setMovements] = useState<MaterialMovement[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [options, setOptions] = useState<Options>({ items: [], units: [], warehouses: [], cashBoxes: [], banks: [], balances: [], ownerContracts: [], subcontractorContracts: [] });
  const [subLinks, setSubLinks] = useState<Array<{ id: number; contractorId: number | null }>>([]);
  const [contractors, setContractors] = useState<Array<{ id: number; supplierId: number | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState("advance_receipt");
  const [amount, setAmount] = useState("");
  const amountSelectionRef = useRef(0);
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
  const [materialContract, setMaterialContract] = useState("");
  const [materialBoqLineId, setMaterialBoqLineId] = useState("");
  const [materialBoqLines, setMaterialBoqLines] = useState<NonNullable<Options["boqLines"]>>([]);
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
    const [billResponse, accountingResponse, materialResponse, optionsResponse, subResponse, contractorResponse] = await Promise.all([
      fetch(`${API}/api/contracting/projects/${projectId}/bills`, { headers }),
      fetch(`${API}/api/contracting/projects/${projectId}/settlements`, { headers }),
      fetch(`${API}/api/contracting/projects/${projectId}/material-movements`, { headers }),
      fetch(`${API}/api/contracting/projects/${projectId}/accounting/options`, { headers }),
      fetch(`${API}/api/contracting/projects/${projectId}/sub-contracts`, { headers }),
      fetch(`${API}/api/contracting/contractors`, { headers }),
    ]);
    if (billResponse.ok) setBills(await billResponse.json());
    if (accountingResponse.ok) {
      const data = await accountingResponse.json();
      setSettlements(data.settlements ?? []);
      setAudit(data.audit ?? []);
    }
    if (materialResponse.ok) setMovements(await materialResponse.json());
    if (optionsResponse.ok) setOptions(await optionsResponse.json());
    else {
      const error = await optionsResponse.json().catch(() => ({}));
      toast({ title: error.error || `تعذر تحميل خيارات المحاسبة (HTTP ${optionsResponse.status})`, variant: "destructive" });
    }
    if (subResponse.ok) setSubLinks(await subResponse.json());
    if (contractorResponse.ok) setContractors(await contractorResponse.json());
  }, [headers, projectId, token, toast]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!token) return;
    const linked = settlements.filter(row => row.source_voucher_id &&
      (row.source_voucher_type === "receipt" || row.source_voucher_type === "payment"));
    const abort = new AbortController();
    void Promise.all(linked.map(async row => {
      const key = `${row.source_voucher_type}:${row.source_voucher_id}`;
      if (voucherCodes[key] || row.voucher_code) return;
      const response = await fetch(`${API}/api/${row.source_voucher_type}-vouchers/${row.source_voucher_id}`, { headers, signal: abort.signal });
      if (!response.ok) return;
      const voucher = await response.json();
      if (!abort.signal.aborted && voucher.code) setVoucherCodes(prev => ({ ...prev, [key]: voucher.code }));
    })).catch(() => {});
    return () => abort.abort();
  }, [settlements, token, headers, voucherCodes]);

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

  useEffect(() => {
    setMaterialBoqLineId("");
    if (!token || !projectId || !materialContract || movementDirection !== "issue") {
      setMaterialBoqLines([]);
      return;
    }
    const [contractDirection, contractId] = materialContract.split(":");
    const direction = contractDirection === "owner" ? "owner" : "subcontract";
    const contractParam = direction === "owner" ? "ownerContractId" : "subcontractorContractId";
    const abort = new AbortController();
    fetch(`${API}/api/contracting/projects/${projectId}/boq-lines?direction=${direction}&${contractParam}=${contractId}`, {
      headers,
      signal: abort.signal,
    }).then(async response => {
      const body = await response.json().catch(() => []);
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      if (!abort.signal.aborted) setMaterialBoqLines(Array.isArray(body) ? body : []);
    }).catch((error: any) => {
      if (error?.name !== "AbortError") {
        setMaterialBoqLines([]);
        toast({ title: error?.message || "تعذر تحميل بنود جدول الكميات للعقد", variant: "destructive" });
      }
    });
    return () => abort.abort();
  }, [headers, materialContract, movementDirection, projectId, token, toast]);

  function operationKey(scope: string) {
    const existing = operationKeys.current.get(scope);
    if (existing) return existing;
    const value = `${scope}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    operationKeys.current.set(scope, value);
    return value;
  }

  async function post(
    url: string,
    body: Record<string, unknown>,
    operationScope?: string,
    successMessage = "تم الترحيل المحاسبي بنجاح",
  ) {
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
      toast({ title: successMessage });
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
    if (unapprove) {
      const bill = bills.find(row => row.id === id);
      if (!bill || !canUnapprove || !["approved", "posted", "partially_paid", "paid"].includes(bill.status)) return;
      if (!window.confirm("إن كان القيد الأصلي مرحّلاً فسيُحفظ ويُنشأ قيد عكسي مرحّل؛ وإن كان مسودة فسيُلغى دون قيد عكسي. يجب عكس التسويات المرتبطة أولاً. هل تريد المتابعة؟")) return;
    }
    await post(`/api/contracting/bills/${id}/${unapprove ? "unapprove" : "approve"}`, {},
      undefined, unapprove ? "تم فك اعتماد المستخلص" : "تم الاعتماد والترحيل المحاسبي");
  }

  async function correct(id: number) {
    if (!window.confirm("سيُعكس القيد الأصلي وتُنشأ مسودة تصحيح جديدة. هل تريد المتابعة؟")) return;
    await post(`/api/contracting/bills/${id}/correction`, {});
  }

  async function reverseSettlement(settlement: Settlement) {
    if (settlement.source_voucher_id || settlement.status !== "posted") return;
    if (!window.confirm(
      `سيُنشأ قيد عكسي مرحّل لعملية ${labelKind[settlement.kind] || settlement.kind} #${settlement.id} بقيمة ${Number(settlement.amount).toLocaleString("en-US")} مع الاحتفاظ بالسجل الأصلي. هل تريد المتابعة؟`,
    )) return;
    await post(
      `/api/contracting/settlements/${settlement.id}/reverse`,
      {},
      undefined,
      "تم عكس العملية وإنشاء قيد عكسي",
    );
  }

  async function correctSettlement(settlement: Settlement) {
    if (settlement.source_voucher_id || settlement.status !== "posted") return;
    if (!window.confirm("سيُعكس القيد الأصلي أولاً. بعد نجاح العكس ستُملأ الحقول للتعديل فقط؛ لن يُرحّل أي مبلغ تلقائياً. متابعة؟")) return;
    const result = await post(`/api/contracting/settlements/${settlement.id}/reverse`, {}, undefined, "تم العكس؛ راجع بيانات التصحيح ثم رحّلها يدوياً");
    if (!result) return;
    if (settlement.kind === "advance_application") {
      setApplySettlementId(String(settlement.source_settlement_id ?? ""));
      setApplyBillId(String(settlement.bill_id ?? ""));
      setApplyAmount(String(settlement.amount));
    } else {
      setKind(settlement.kind);
      setAmount(String(settlement.amount));
      setBillId(String(settlement.bill_id ?? ""));
      setOwnerContractId(String(settlement.owner_contract_id ?? ""));
      setSubcontractorContractId(String(settlement.subcontractor_contract_id ?? ""));
      setSettlementDate(settlement.settlement_date?.slice(0, 10) || new Date().toISOString().slice(0, 10));
      if (settlement.payment_type === "cash" || settlement.payment_type === "bank") {
        setPaymentType(settlement.payment_type);
        setTreasuryId(String(settlement.payment_type === "cash" ? settlement.cash_box_id ?? "" : settlement.bank_account_id ?? ""));
      }
    }
  }

  const requiresBill = kind.startsWith("retention_") || kind.startsWith("bill_");
  const advances = settlements.filter((s) => s.status === "posted" && (s.kind === "advance_receipt" || s.kind === "advance_payment"));
  const statusLabel = (status: string) => ({"posted": "مرحّل", "approved": "معتمد", "reversed": "معكوس", "draft": "مسودة", "partially_paid": "مسدد جزئياً", "paid": "مسدد"} as Record<string, string>)[status] || status;
  const billLedger: LedgerRow[] = bills.map(row => ({
    id: row.id, date: row.billDate || "", type: row.direction === "incoming" ? "مستخلص مقاول باطن" : "مستخلص مالك",
    reference: `${row.billNumber} (#${row.id})`, amount: Number(row.netAmount).toLocaleString("en-US"),
    status: statusLabel(row.status), source: row.direction === "incoming" ? `عقد باطن #${row.subcontractorContractId ?? "—"}` : `عقد مالك #${row.ownerContractId ?? "—"}`,
    details: `الصافي ${row.netAmount} • المحتجز ${row.retentionAmount} • المسدد ${row.paidAmount ?? 0} • قيد #${row.journalEntryId ?? "—"}`,
  }));
  const settlementLedger = (rows: Settlement[]): LedgerRow[] => rows.map(row => ({
    id: row.id, date: row.settlement_date || "", type: labelKind[row.kind] || row.kind,
    reference: `#${row.id}`, amount: Number(row.amount).toLocaleString("en-US"),
    status: statusLabel(row.status),
    source: row.source_voucher_id
      ? `${row.voucher_code || voucherCodes[`${row.source_voucher_type}:${row.source_voucher_id}`] || (row.source_voucher_type === "receipt" ? "سند قبض" : "سند صرف")} #${row.source_voucher_id}`
      : row.source_settlement_id ? `سلفة #${row.source_settlement_id}`
      : row.bill_id ? `مستخلص ${bills.find(b => b.id === row.bill_id)?.billNumber || `#${row.bill_id}`}`
      : row.owner_contract_id ? `عقد مالك #${row.owner_contract_id}` : row.subcontractor_contract_id ? `عقد باطن #${row.subcontractor_contract_id}` : "ترحيل مباشر",
    details: `عملية #${row.id} • مستخلص #${row.bill_id ?? "—"} • قيد #${row.journal_entry_id ?? "—"}${row.reversal_journal_entry_id ? ` • قيد عكسي #${row.reversal_journal_entry_id}` : ""}${row.application_origin ? ` • منشأ التطبيق: ${row.application_origin === "auto_recovery" ? "استرداد تلقائي" : "يدوي"}` : ""}`,
  }));
  const materialLedger: LedgerRow[] = movements.map(row => ({
    id: row.id, date: row.movement_date || "", type: row.direction === "issue" ? "صرف مواد" : "إرجاع مواد",
    reference: `#${row.id}`, amount: `${row.qty_base} • تكلفة ${Number(row.total_cost).toLocaleString("en-US")}`,
    status: "مرحّل",
    source: row.source_movement_id ? `صرف أصلي #${row.source_movement_id}` : `قيد #${row.journal_entry_id ?? "—"}`,
    details: `الصنف ${options.items.find(i => i.id === row.item_id)?.nameAr || `#${row.item_id ?? "—"}`} • المخزن ${options.warehouses.find(w => w.id === row.warehouse_id)?.nameAr || `#${row.warehouse_id ?? "—"}`} • ${row.owner_contract_id ?? row.ownerContractId ? `عقد مالك #${row.owner_contract_id ?? row.ownerContractId}` : row.subcontractor_contract_id ?? row.subcontractorContractId ? `عقد باطن #${row.subcontractor_contract_id ?? row.subcontractorContractId}` : "المشروع"} • بند #${row.boq_line_id ?? row.boqLineId ?? "—"} • تشغيلة ${row.batch_number ?? "—"} • قيد #${row.journal_entry_id ?? "—"}`,
  }));
  // An explicit contract customer wins; only a missing one inherits the project's explicit ID.
  function ownerPartyId(contractId: number) {
    const contract = options.ownerContracts.find(row => row.id === contractId);
    return contract ? contract.customerId ?? options.projectCustomerId ?? null : null;
  }
  function unavailableContractReason(data: any, contractId: number) {
    const excluded = data.unavailableContracts?.find((row: any) =>
      Number(row.id) === contractId && Number(row.projectId) === projectId);
    if (excluded) {
      const status = String(excluded.status);
      return status === "draft" || status === "submitted"
        ? "العقد مسودة ولم يُعتمد بعد؛ أضف بند تنفيذ واعتمد العقد قبل إنشاء سند المقاولات"
        : `العقد حالته «${status}»؛ يلزم عقد معتمد لإنشاء سند المقاولات`;
    }
    return "العقد غير متاح للطرف المحدد في هذا الفرع؛ تحقق من ارتباط العميل/المورد وفرع المشروع";
  }
  function selectBill(value: string) {
    amountSelectionRef.current++;
    setBillId(value);
    const bill = bills.find(row => String(row.id) === value);
    if (bill && kind.startsWith("bill_")) {
      const remaining = Number(bill.remainingAmount ?? (Number(bill.netAmount) - Number(bill.paidAmount || 0)));
      setAmount(Number.isFinite(remaining) && remaining > 0 ? remaining.toFixed(2) : "");
    } else setAmount("");
  }
  async function selectAdvanceContract(value: string, direction: "receipt" | "payment") {
    const selection = ++amountSelectionRef.current;
    if (direction === "receipt") setOwnerContractId(value);
    else setSubcontractorContractId(value);
    setAmount("");
    if (!value) return;
    const partyId = direction === "receipt"
      ? ownerPartyId(Number(value))
      : contractors.find(row => row.id === subLinks.find(link => String(link.id) === value)?.contractorId)?.supplierId;
    if (!partyId) {
      toast({ title: "العقد غير مرتبط بعميل/مورد؛ تعذر تحديد المتبقي", variant: "destructive" });
      return;
    }
    try {
      const query = new URLSearchParams({ entityId: String(partyId), companyId: String(user?.companyId ?? "") });
      const response = await fetch(`${API}/api/${direction}-vouchers/contracting-options?${query}`, { headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const contract = data.contracts?.find((row: any) => String(row.id) === value && Number(row.projectId) === projectId);
       if (!contract) throw new Error(unavailableContractReason(data, Number(value)));
      const remaining = Number(contract.remainingAmount);
      if (selection === amountSelectionRef.current && Number.isFinite(remaining) && remaining > 0) setAmount(remaining.toFixed(2));
    } catch (error: any) {
      if (selection === amountSelectionRef.current)
        toast({ title: error?.message || "تعذر تحميل المبلغ المتبقي للعقد", variant: "destructive" });
    }
  }
  async function openVoucher() {
    const receipt = kind === "advance_receipt" || kind === "bill_receipt";
    const isBill = kind === "bill_receipt" || kind === "bill_payment";
    if (!["advance_receipt", "bill_receipt", "advance_payment", "bill_payment"].includes(kind)) return;
    const bill = isBill ? bills.find(row => row.id === Number(billId) && ["approved", "posted", "partially_paid"].includes(row.status)) : null;
    const contractId = isBill ? Number(receipt ? bill?.ownerContractId : bill?.subcontractorContractId)
      : Number(receipt ? ownerContractId : subcontractorContractId);
    const partyId = receipt ? ownerPartyId(contractId)
      : contractors.find(row => row.id === subLinks.find(link => link.id === contractId)?.contractorId)?.supplierId;
    if (!contractId || !partyId || (isBill && !bill)) {
      toast({ title: "يجب اختيار عقد مرتبط بعميل/مورد صريح ومستخلص معتمد عند التحصيل/السداد", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const direction = receipt ? "receipt" : "payment";
      const lookup = new URLSearchParams({ entityId: String(partyId), companyId: String(user?.companyId ?? "") });
      const response = await fetch(`${API}/api/${direction}-vouchers/contracting-options?${lookup}`, { headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const contract = data.contracts?.find((row: any) => Number(row.id) === contractId && Number(row.projectId) === projectId);
       if (!contract) throw new Error(unavailableContractReason(data, contractId));
      const eligible = isBill ? data.bills?.find((row: any) =>
        Number(row.id) === bill!.id && Number(row.projectId) === projectId && Number(row.contractId) === contractId) : contract;
      if (!eligible) throw new Error("المستخلص غير متاح لهذا الطرف أو العقد");
      const remaining = Number(eligible.remainingAmount);
      if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("لا يوجد مبلغ متبقٍ لهذا العقد/المستخلص");
      const requested = amount.trim() ? Number(amount) : remaining;
      if ((amount.trim() && !/^\d+(?:\.\d{1,2})?$/.test(amount.trim())) ||
        !Number.isFinite(requested) || requested <= 0 || requested > remaining)
        throw new Error("المبلغ يجب أن يكون أكبر من صفر ولا يتجاوز المتبقي");
      const query = new URLSearchParams({
        contractingKind: receipt ? (isBill ? "owner_bill" : "owner_advance") : (isBill ? "subcontract_bill" : "subcontract_advance"),
        projectId: String(projectId), contractId: String(contractId), entityId: String(partyId),
        amount: requested.toFixed(2),
      });
      if (isBill) query.set("billId", String(bill!.id));
      navigate(`/cash/${direction}-vouchers/multi/new?${query}`);
    } catch (error: any) {
      toast({ title: error?.message || "تعذر فتح السند", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function saveSettlement() {
    if (["advance_receipt", "bill_receipt", "advance_payment", "bill_payment"].includes(kind)
      && !window.confirm("هذا ترحيل مباشر مستقل عن السند المتعدد. إذا أنشأت سنداً لهذه العملية بالفعل فستتكرر التسوية. هل تريد المتابعة بالمسار القديم؟")) return;
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
    const [contractDirection, rawContractId] = materialContract.split(":");
    const selectedContractId = Number(rawContractId);
    const issueScope = movementDirection === "issue"
      ? `${materialContract || "project"}:${materialBoqLineId || "no-boq"}`
      : "inherit-source";
    const scope = `material:${movementDirection}:${itemId}:${unitId}:${warehouseId}:${qty}:${sourceMovementId || "new"}:${issueScope}:${lotNumber}:${lotExpiryDate}:${settlementDate}`;
    const result = await post(`/api/contracting/projects/${projectId}/material-movements`, {
      direction: movementDirection, itemId: Number(itemId), unitId: Number(unitId),
      warehouseId: Number(warehouseId), qty,
      resourceId: resourceId ? Number(resourceId) : null,
      sourceMovementId: movementDirection === "return" && sourceMovementId ? Number(sourceMovementId) : null,
      ...(movementDirection === "issue" ? {
        ownerContractId: contractDirection === "owner" && selectedContractId ? selectedContractId : null,
        subcontractorContractId: contractDirection === "subcontract" && selectedContractId ? selectedContractId : null,
        boqLineId: materialBoqLineId ? Number(materialBoqLineId) : null,
      } : {}),
      batchNumber: movementDirection === "issue" && lotNumber ? lotNumber : null,
      expiryDate: movementDirection === "issue" && lotNumber ? lotExpiryDate || null : undefined,
      movementDate: settlementDate, idempotencyKey: operationKey(scope),
    }, scope);
    if (result) setQty("");
  }

  const approvedBills = bills.filter((bill) => ["approved", "posted", "partially_paid"].includes(bill.status));
  const selectedBalance = options.balances.find((row) => row.itemId === Number(itemId) && row.warehouseId === Number(warehouseId));
  const [materialContractDirection, materialContractIdText] = materialContract.split(":");
  const materialContractId = Number(materialContractIdText);
  const filteredMaterialBoqLines = materialBoqLines.filter(line =>
    materialContractDirection === "owner"
      ? line.direction === "owner" && line.ownerContractId === materialContractId
      : materialContractDirection === "subcontract"
        ? line.direction === "subcontract" && line.subcontractorContractId === materialContractId
        : false,
  );
  function settlementActions(id: number) {
    const row = settlements.find(s => s.id === id);
    if (!row) return null;
    if (row.source_voucher_id) {
      return row.source_voucher_type === "receipt" || row.source_voucher_type === "payment"
        ? <Button size="sm" variant="outline" onClick={() => navigate(`/cash/${row.source_voucher_type}-vouchers/multi/${row.source_voucher_id}`)}>فتح السند / تعديل المصدر</Button>
        : <span className="text-xs text-muted-foreground">التصحيح من السند المصدر #{row.source_voucher_id}</span>;
    }
    if (row.status === "posted" && row.application_origin !== "auto_recovery") return <>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void correctSettlement(row)}>تصحيح بعد العكس</Button>
      <Button size="sm" variant="destructive" disabled={busy} data-testid={`button-reverse-settlement-${row.id}`} onClick={() => void reverseSettlement(row)}>عكس</Button>
    </>;
    return row.application_origin === "auto_recovery"
      ? <Button size="sm" variant="outline" onClick={() => {
          const bill = bills.find(b => b.id === row.bill_id);
          if (bill) onOpenBill(bill.id, bill.direction === "incoming" ? "incoming" : "outgoing");
        }}>عرض المستخلص المصدر (استرداد تلقائي)</Button>
      : null;
  }
  function prepareMaterialReturn(id: number) {
    const row = movements.find(m => m.id === id);
    if (!row || row.direction !== "issue") return;
    setMovementDirection("return");
    setSourceMovementId(String(row.id));
    setItemId(String(row.item_id ?? ""));
    setUnitId(String(row.unit_id ?? ""));
    setWarehouseId(String(row.warehouse_id ?? ""));
    setQty("");
    setSettlementDate(new Date().toISOString().slice(0, 10));
    toast({ title: `حركة الصرف #${row.id} جاهزة للإرجاع. أدخل الكمية وراجع البيانات قبل الترحيل.` });
  }

  return (
    <div dir="rtl" className="space-y-5">
      <div className="rounded-lg border bg-white p-4 shadow-sm dark:bg-slate-950">
        <h3 className="mb-3 text-base font-bold">اعتماد المستخلصات والدفتر العام</h3>
        <ContractingOperationsLedger title="سجل اعتماد المستخلصات" filename={`contracting-bills-${projectId}`}
          rows={billLedger} action={id => {
            const bill = bills.find(b => b.id === id);
            if (!bill) return null;
            return <>
              <Button size="sm" variant="outline" onClick={() => onOpenBill(id, bill.direction === "incoming" ? "incoming" : "outgoing")}>عرض / تعديل المستخلص</Button>
              {bill.journalEntryId != null && <Button size="sm" variant="outline" asChild><a href={`/accounting/journals/${bill.journalEntryId}`}>فتح القيد</a></Button>}
              {["approved", "posted", "partially_paid", "paid"].includes(bill.status) ? <>
                {canUnapprove && (user?.role === "admin" || user?.role === "superadmin"
                  || (user as any)?.postingPermissions?.[bill.direction === "incoming" ? "ctgIncomingBill" : "ctgOutgoingBill"]?.unpost !== false) &&
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void approve(id, true)}>فك الاعتماد</Button>}
                {["approved", "posted"].includes(bill.status) &&
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => void correct(id)}>تصحيح مرحّل</Button>}
              </> : bill.status !== "reversed" &&
                <Button size="sm" disabled={busy} onClick={() => void approve(id)}>اعتماد وترحيل ذري</Button>}
            </>;
          }} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border bg-white p-4 shadow-sm dark:bg-slate-950">
          <h3 className="mb-3 font-bold">السلف والمحتجزات — قيود القبض والصرف</h3>
          <div className="grid gap-2 sm:grid-cols-2">
             <PickerField label="نوع العملية" value={kind} onValueChange={value => {
               amountSelectionRef.current++;
               setKind(value);
               setAmount("");
               setBillId("");
               setOwnerContractId("");
               setSubcontractorContractId("");
             }} items={[
              { value: "advance_receipt", label: "قبض سلفة من المالك" },
              { value: "advance_payment", label: "صرف سلفة للمقاول الباطن" },
              { value: "retention_receipt", label: "إفراج محتجزات من المالك" },
              { value: "retention_payment", label: "صرف محتجزات للمقاول الباطن" },
              { value: "bill_receipt", label: "تحصيل مستخلص من المالك" },
              { value: "bill_payment", label: "سداد مستخلص المقاول الباطن" },
             ]} testId="accounting-settlement-kind" />
             <label className="text-sm">المبلغ<Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => { amountSelectionRef.current++; setAmount(e.target.value); }} /></label>
             {requiresBill && <PickerField label="المستخلص المعتمد" value={billId} onValueChange={selectBill} placeholder="اختر مستخلصاً" items={approvedBills.map((bill) => ({ value: String(bill.id), label: `${bill.billNumber} — محتجز ${bill.retentionAmount}` }))} testId="accounting-bill-picker" />}
             {!requiresBill && kind === "advance_receipt" && <PickerField label="عقد المالك" value={ownerContractId} onValueChange={value => void selectAdvanceContract(value, "receipt")} placeholder="اختر عقداً" items={options.ownerContracts.map((contract) => ({ value: String(contract.id), label: `${contract.contractNumber}${contract.clientName ? ` — ${contract.clientName}` : ""}` }))} testId="accounting-owner-contract-picker" />}
             {!requiresBill && kind === "advance_payment" && <PickerField label="عقد المقاول الباطن" value={subcontractorContractId} onValueChange={value => void selectAdvanceContract(value, "payment")} placeholder="اختر عقداً" items={options.subcontractorContracts.map((contract) => ({ value: String(contract.id), label: contract.contractNumber }))} testId="accounting-subcontractor-contract-picker" />}
            <label className="text-sm">التاريخ<Input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} /></label>
            <PickerField label="طريقة السداد" value={paymentType} onValueChange={(value) => { setPaymentType(value as "cash" | "bank"); setTreasuryId(""); }} items={[
              { value: "cash", label: "نقدي — خزنة" },
              { value: "bank", label: "بنكي — حساب بنكي" },
            ]} testId="accounting-payment-type-picker" />
            <PickerField label={paymentType === "cash" ? "الخزنة" : "الحساب البنكي"} value={treasuryId} onValueChange={setTreasuryId} placeholder="اختر الحساب" items={(paymentType === "cash" ? options.cashBoxes : options.banks).map((row) => ({ value: String(row.id), label: `${row.code} — ${row.nameAr}` }))} testId="accounting-treasury-picker" />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy || !["advance_receipt", "bill_receipt", "advance_payment", "bill_payment"].includes(kind) || (requiresBill && !billId) || (!requiresBill && kind === "advance_receipt" && !ownerContractId) || (!requiresBill && kind === "advance_payment" && !subcontractorContractId)} onClick={openVoucher}>فتح سند {kind.endsWith("receipt") ? "قبض" : "صرف"} متعدد (بدون ترحيل تلقائي)</Button>
            <Button variant="outline" disabled={busy || !amount || !treasuryId || (requiresBill && !billId) || (!requiresBill && kind === "advance_receipt" && !ownerContractId) || (!requiresBill && kind === "advance_payment" && !subcontractorContractId)} onClick={() => void saveSettlement()}>ترحيل مباشر (النظام القديم)</Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">اختر مساراً واحداً للعملية: السند المتعدد أو الترحيل المباشر. لا تستخدم الاثنين لنفس التحصيل أو السداد.</p>
          <ContractingOperationsLedger title="سجل السلف والمحتجزات والتسويات النقدية" filename={`contracting-settlements-${projectId}`}
            rows={settlementLedger(settlements.filter(row => row.kind !== "advance_application"))} action={settlementActions} />
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm dark:bg-slate-950">
          <h3 className="mb-3 font-bold">تطبيق سلفة على مستخلص</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            <PickerField label="السلفة" value={applySettlementId} onValueChange={setApplySettlementId} placeholder="اختر السلفة" items={advances.map((row) => ({ value: String(row.id), label: `${labelKind[row.kind]} #${row.id} — متاح ${(Number(row.amount) - Number(row.applied_amount || 0)).toLocaleString("en-US")}` }))} testId="accounting-advance-picker" />
            <PickerField label="المستخلص" value={applyBillId} onValueChange={setApplyBillId} placeholder="اختر مستخلصاً" items={approvedBills.map((bill) => ({ value: String(bill.id), label: bill.billNumber }))} testId="accounting-apply-bill-picker" />
            <label className="text-sm">مبلغ التطبيق<Input type="number" min="0.01" step="0.01" value={applyAmount} onChange={(e) => setApplyAmount(e.target.value)} /></label>
          </div>
          <Button className="mt-3" variant="outline" disabled={busy || !applySettlementId || !applyBillId || !applyAmount} onClick={() => void applyAdvance()}>ترحيل تطبيق السلفة</Button>
          <ContractingOperationsLedger title="سجل تطبيقات السلف" filename={`contracting-advance-applications-${projectId}`}
            rows={settlementLedger(settlements.filter(row => row.kind === "advance_application"))} action={settlementActions} />
        </section>
      </div>

      <section className="rounded-lg border bg-white p-4 shadow-sm dark:bg-slate-950">
        <h3 className="mb-3 font-bold">صرف وإرجاع مواد فعلية للمشروع</h3>
        <p className="mb-3 text-xs text-slate-500">لا يغيّر هذا النموذج حالة المورد المخطط؛ بل ينشئ حركة مخزون فعلية وقيد تكلفة مشروع متوازناً.</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <PickerField label="الحركة" value={movementDirection} onValueChange={(value) => {
            const next = value as "issue" | "return";
            setMovementDirection(next);
            if (next === "return") {
              setMaterialContract("");
              setMaterialBoqLineId("");
            }
          }} items={[{ value: "issue", label: "صرف مواد" }, { value: "return", label: "إرجاع مواد" }]} testId="accounting-movement-direction-picker" />
          <PickerField label="الصنف" value={itemId} onValueChange={setItemId} placeholder="اختر الصنف" items={options.items.map((row) => ({ value: String(row.id), label: `${row.code} — ${row.nameAr}` }))} testId="accounting-item-picker" />
          <PickerField label="الوحدة" value={unitId} onValueChange={setUnitId} placeholder="اختر الوحدة" items={options.units.map((row) => ({ value: String(row.id), label: `${row.code} — ${row.nameAr}` }))} testId="accounting-unit-picker" />
          <div>
            <PickerField label="المخزن" value={warehouseId} onValueChange={setWarehouseId} placeholder="اختر المخزن" items={options.warehouses.map((row) => ({ value: String(row.id), label: `${row.code} — ${row.nameAr}` }))} testId="accounting-warehouse-picker" />
            {selectedBalance && <span className="mt-1 block text-xs text-slate-500">الرصيد الفعلي: {Number(selectedBalance.qtyBase).toLocaleString("en-US")} • تكلفة الوحدة: {Number(selectedBalance.avgCost || 0).toLocaleString("en-US")}</span>}
          </div>
          {movementDirection === "issue" && selectedBatchMode && <label className="text-sm">التشغيلة ({selectedBatchMode === "fefo" ? "FEFO" : "FIFO"})
            <SearchCombobox
              items={[
                { value: "__auto__|", label: `تخصيص تلقائي حسب ${selectedBatchMode.toUpperCase()}` },
                ...lots.map((lot) => {
                  const key = `${lot.batchNumber ?? "__unbatched__"}|${lot.expiryDate ?? ""}`;
                  return {
                    value: key,
                    label: `${lot.batchNumber ?? "بدون رقم تشغيلة"} — متاح ${lot.remainingBase} — تكلفة ${lot.unitCost}${lot.expiryDate ? ` — انتهاء ${lot.expiryDate}` : ""}${lot.expired ? " — منتهية" : ""}`,
                    disabled: lot.expired,
                    disabledReason: "التشغيلة منتهية",
                  };
                }),
              ]}
              value={`${lotNumber || "__auto__"}|${lotExpiryDate}`}
              onValueChange={(value) => {
                const [batch, expiry = ""] = value.split("|");
                setLotNumber(batch === "__auto__" ? "" : batch === "__unbatched__" ? "__unbatched__" : batch);
                setLotExpiryDate(expiry);
              }}
              placeholder="اختر التشغيلة"
              searchPlaceholder="بحث برقم التشغيلة..."
              testId="accounting-lot-picker"
              openOnFocus={false}
            />
            <span className="mt-1 block text-[11px] text-slate-500">اتركها تلقائياً لتطبيق ترتيب {selectedBatchMode.toUpperCase()} عبر طبقات التقييم الفعلية.</span>
          </label>}
          <label className="text-sm">الكمية<Input type="number" min="0.000000000000000001" step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
          <label className="text-sm">معرّف المورد (اختياري)<Input type="number" value={resourceId} onChange={(e) => setResourceId(e.target.value)} /></label>
          {movementDirection === "issue" && (
            <PickerField
              label="العقد (اختياري)"
              value={materialContract || "__none__"}
              onValueChange={(value) => {
                setMaterialContract(value === "__none__" ? "" : value);
                setMaterialBoqLineId("");
              }}
              placeholder="بدون ربط بعقد"
              items={[
                { value: "__none__", label: "بدون ربط بعقد" },
                ...options.ownerContracts.map(contract => ({
                  value: `owner:${contract.id}`,
                  label: `مالك — ${contract.contractNumber}`,
                })),
                ...options.subcontractorContracts.map(contract => ({
                  value: `subcontract:${contract.id}`,
                  label: `باطن — ${contract.contractNumber}`,
                })),
              ]}
              testId="accounting-material-contract-picker"
            />
          )}
          {movementDirection === "issue" && materialContract && (
            <PickerField
              label="سطر جدول الكميات (اختياري)"
              value={materialBoqLineId || "__none__"}
              onValueChange={value => setMaterialBoqLineId(value === "__none__" ? "" : value)}
              placeholder="بدون ربط بسطر"
              items={[
                { value: "__none__", label: "بدون ربط بسطر جدول الكميات" },
                ...filteredMaterialBoqLines.map(line => ({
                  value: String(line.id),
                  label: `${line.lineCode ? `${line.lineCode} — ` : ""}${line.workItemName || line.description || `سطر #${line.id}`}`,
                })),
              ]}
              testId="accounting-material-boq-picker"
            />
          )}
          {movementDirection === "return" && <label className="text-sm">رقم حركة الصرف الأصلية<Input type="number" value={sourceMovementId} onChange={(e) => setSourceMovementId(e.target.value)} /></label>}
        </div>
        {movementDirection === "return" && (
          <p className="mt-2 text-xs text-muted-foreground">الإرجاع يرث العقد وسطر جدول الكميات من حركة الصرف الأصلية ولا يستبدلهما.</p>
        )}
        <Button className="mt-3" disabled={busy || !itemId || !unitId || !warehouseId || !qty || (movementDirection === "return" && !sourceMovementId)} onClick={() => void saveMaterialMovement()}>ترحيل حركة المواد والقيد</Button>
        <ContractingOperationsLedger title="سجل صرف وإرجاع المواد" filename={`contracting-materials-${projectId}`}
          rows={materialLedger} action={id => movements.find(m => m.id === id)?.direction === "issue"
            ? <Button size="sm" variant="outline" disabled={busy} onClick={() => prepareMaterialReturn(id)}>إرجاع مرتبط بالمصدر</Button>
            : null} />
      </section>

      <section className="rounded-lg border bg-white p-4 shadow-sm dark:bg-slate-950">
        <h3 className="mb-3 font-bold">التدقيق المحاسبي</h3>
        <div className="space-y-1 text-sm">
          {audit.slice(0, 10).map((row) => <div key={`audit-${row.id}`} className="text-xs text-slate-500">#{row.id} — {row.action} — {new Date(row.created_at).toLocaleString("ar-SA")}</div>)}
        </div>
      </section>
    </div>
  );
}

function PickerField({
  label,
  value,
  onValueChange,
  items,
  placeholder = "اختر...",
  testId,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  items: ComboboxItem[];
  placeholder?: string;
  testId: string;
}) {
  return (
    <label className="text-sm">
      {label}
      <SearchCombobox
        className="mt-1"
        items={items}
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
        searchPlaceholder={`بحث في ${label}...`}
        emptyText="لا توجد نتائج"
        testId={testId}
        openOnFocus={false}
      />
    </label>
  );
}