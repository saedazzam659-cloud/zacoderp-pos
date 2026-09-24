import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ensureContractingAccountingTables } from "./contracting-accounting-storage.js";
import { assertProjectBranchAccess, refreshBillPaymentState } from "./contracting-accounting-service.js";
import { calculateSignedContractingBillNet, exactCents } from "./contracting-bill-adjustment-math.js";

export type ContractingVoucherKind = "owner_advance" | "owner_bill" | "subcontract_advance" | "subcontract_bill";
export type ContractingAllocation = {
  kind: ContractingVoucherKind;
  projectId: number;
  contractId: number;
  billId?: number | null;
};
const spec = {
  owner_advance: { voucher: "receipt", direction: "outgoing", mapping: "contracting_advance_receipt", role: "advance_liability", settlement: "advance_receipt" },
  owner_bill: { voucher: "receipt", direction: "outgoing", mapping: "contracting_outgoing_bill", role: "receivable", settlement: "bill_receipt" },
  subcontract_advance: { voucher: "payment", direction: "incoming", mapping: "contracting_advance_payment", role: "advance_asset", settlement: "advance_payment" },
  subcontract_bill: { voucher: "payment", direction: "incoming", mapping: "contracting_incoming_bill", role: "payable", settlement: "bill_payment" },
} as const;
const rows = (r: any): any[] => Array.isArray(r) ? r : r?.rows ?? [];
function fail(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }

export function parseContractingAllocation(raw: any, voucher: "receipt" | "payment"): ContractingAllocation | null {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || !Object.prototype.hasOwnProperty.call(spec, raw.kind)) fail("نوع توزيع المقاولات غير صالح");
  const kind = raw.kind as ContractingVoucherKind;
  if (spec[kind].voucher !== voucher) fail("نوع توزيع المقاولات لا يطابق نوع السند");
  for (const key of ["projectId", "contractId", ...(kind.endsWith("_bill") ? ["billId"] : [])]) {
    if (!Number.isSafeInteger(Number(raw[key])) || Number(raw[key]) < 1) fail(`معرّف ${key} غير صالح`);
  }
  if (kind.endsWith("_advance") && raw.billId != null) fail("لا يرتبط بند السلفة بمستخلص");
  return { kind, projectId: Number(raw.projectId), contractId: Number(raw.contractId), billId: raw.billId == null ? null : Number(raw.billId) };
}

/** Validate exact linked party, company, project, branch, contract and role. Never guess via account/name. */
export async function resolveContractingLine(tx: any, companyId: number, voucher: "receipt" | "payment",
  partyId: number | null, allocation: ContractingAllocation, req?: any): Promise<number> {
  const s = spec[allocation.kind];
  if (s.voucher !== voucher || !partyId) fail("يجب تحديد العميل/المورد المرتبط بعقد المقاولات");
  const owner = voucher === "receipt";
  const project = rows(await tx.execute(sql`SELECT branch_id FROM contracting_projects
    WHERE id = ${allocation.projectId} AND company_id = ${companyId}`))[0];
  if (!project) fail("مشروع المقاولات غير موجود في هذه الشركة");
  if (req) assertProjectBranchAccess(req, project.branch_id);
  if (req?.voucherBranchId != null && project.branch_id != null &&
    Number(req.voucherBranchId) !== Number(project.branch_id)) fail("فرع السند لا يطابق فرع المشروع");
  const contract = owner
    ? rows(await tx.execute(sql`SELECT c.id, COALESCE(c.customer_id, p.customer_id) AS party_id, c.advance_payment, c.status
       FROM contracting_owner_contracts c JOIN contracting_projects p
         ON p.id = c.project_id AND p.company_id = c.company_id
       JOIN customers x ON x.id = COALESCE(c.customer_id, p.customer_id) AND x.company_id = c.company_id
       WHERE c.id = ${allocation.contractId}
       AND c.project_id = ${allocation.projectId} AND c.company_id = ${companyId}`))[0]
    : rows(await tx.execute(sql`SELECT c.id, p.supplier_id AS party_id, c.advance_payment, c.status
      FROM contracting_sub_contracts c
      JOIN contracting_contractors p ON p.id = c.contractor_id AND p.company_id = c.company_id
      WHERE c.id = ${allocation.contractId} AND c.project_id = ${allocation.projectId}
      AND c.company_id = ${companyId}`))[0];
  if (!contract || Number(contract.party_id) !== partyId) fail("العقد لا يرتبط بالطرف المختار في هذه الشركة والمشروع");
  if (!["active", "completed"].includes(contract.status)) fail("العقد غير مفعّل");
  if (allocation.billId) {
    const bill = rows(await tx.execute(sql`SELECT id, status, journal_entry_id FROM contracting_progress_bills
      WHERE id = ${allocation.billId} AND company_id = ${companyId} AND project_id = ${allocation.projectId}
      AND direction = ${s.direction} AND ${owner ? sql`owner_contract_id` : sql`subcontractor_contract_id`} = ${allocation.contractId}`))[0];
    if (!bill || !bill.journal_entry_id || !["approved", "posted", "partially_paid", "paid"].includes(bill.status))
      fail("المستخلص غير معتمد أو لا يتبع العقد المحدد");
  }
  const mapped = rows(await tx.execute(sql`SELECT a.id FROM accounting_mappings m
    JOIN accounts a ON a.id = m.account_id AND a.company_id = m.company_id
    WHERE m.company_id = ${companyId} AND m.document_type = ${s.mapping}
      AND m.role_key = ${s.role} LIMIT 1`))[0];
  if (!mapped) fail(`ربط محاسبي مفقود: المستند ${s.mapping}، الدور ${s.role}. افتح «ربط القيود المحاسبية» واربط حساب ترحيل مناسباً لهذا الدور قبل حفظ سند المقاولات.`);
  return Number(mapped.id);
}

export async function contractingVoucherOptions(companyId: number, voucher: "receipt" | "payment", partyId: number, req: any) {
  await ensureContractingAccountingTables();
  const owner = voucher === "receipt";
  // Project ownership is an explicit ID link independently of any owner contract.
  // Legacy name snapshots are deliberately never used to infer a customer.
  const ownedProjects = owner ? rows(await db.execute(sql`SELECT p.id, p.name_ar AS "nameAr", p.branch_id AS "branchId"
    FROM contracting_projects p JOIN customers x ON x.id = p.customer_id AND x.company_id = p.company_id
    WHERE p.company_id = ${companyId} AND p.customer_id = ${partyId}`)) : [];
  const contracts = owner
    ? rows(await db.execute(sql`SELECT c.id, c.project_id AS "projectId", c.contract_number AS "contractNumber",
      c.advance_payment AS "advancePayment", c.status, p.branch_id AS "branchId",
      p.name_ar AS "projectName"
      FROM contracting_owner_contracts c JOIN contracting_projects p ON p.id = c.project_id
      JOIN customers x ON x.id = COALESCE(c.customer_id, p.customer_id) AND x.company_id = c.company_id
      WHERE c.company_id = ${companyId} AND p.company_id = ${companyId}
      AND (c.customer_id = ${partyId} OR (c.customer_id IS NULL AND p.customer_id = ${partyId}))
      AND c.status IN ('active','completed')`))
    : rows(await db.execute(sql`SELECT c.id, c.project_id AS "projectId", c.contract_number AS "contractNumber",
      c.advance_payment AS "advancePayment", c.status, p.branch_id AS "branchId",
      p.name_ar AS "projectName"
      FROM contracting_sub_contracts c JOIN contracting_projects p ON p.id = c.project_id
      JOIN contracting_contractors x ON x.id = c.contractor_id AND x.company_id = c.company_id
      WHERE c.company_id = ${companyId} AND p.company_id = ${companyId} AND x.supplier_id = ${partyId}
      AND c.status IN ('active','completed')`));
  const allowed = contracts.filter((c) => { try { assertProjectBranchAccess(req, c.branchId); return true; } catch { return false; } });
  const ids = allowed.map((c) => Number(c.id));
  const rawBills = ids.length
    ? rows(await db.execute(sql`SELECT id, project_id AS "projectId", ${owner ? sql`owner_contract_id` : sql`subcontractor_contract_id`} AS "contractId",
      bill_number AS "billNumber", status, net_amount AS "netAmount", paid_amount AS "paidAmount"
      FROM contracting_progress_bills WHERE company_id = ${companyId}
      AND direction = ${owner ? "outgoing" : "incoming"}
      AND ${owner ? sql`owner_contract_id` : sql`subcontractor_contract_id`} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      AND journal_entry_id IS NOT NULL AND status IN ('approved','posted','partially_paid')`))
    : [];
  const bills = await Promise.all(rawBills.map(async (bill: any) => {
    const [additions, deductions, penalties, paid] = await Promise.all([
      db.execute(sql`SELECT amount FROM contracting_bill_additions
        WHERE company_id = ${companyId} AND bill_id = ${bill.id}`),
      db.execute(sql`SELECT amount, kind FROM contracting_bill_deductions
        WHERE company_id = ${companyId} AND bill_id = ${bill.id}`),
      db.execute(sql`SELECT amount FROM contracting_bill_penalties
        WHERE company_id = ${companyId} AND bill_id = ${bill.id}`),
      db.execute(sql`SELECT COALESCE(SUM(amount),0) AS amount FROM contracting_accounting_settlements
        WHERE company_id = ${companyId} AND bill_id = ${bill.id} AND status = 'posted'
        AND kind IN ('bill_receipt','bill_payment','advance_application')`),
    ]);
    const net = calculateSignedContractingBillNet({
      rawNetAmount: bill.netAmount, additions: rows(additions), deductions: rows(deductions), penalties: rows(penalties),
    }).adjustedNetAmount;
    const remainingCents = exactCents(net) - exactCents(rows(paid)[0]?.amount ?? "0");
    return { ...bill, remainingAmount: Number(remainingCents > 0n ? remainingCents : 0n) / 100 };
  }));
  const advanceUsed = ids.length ? rows(await db.execute(sql`
    SELECT ${owner ? sql`owner_contract_id` : sql`subcontractor_contract_id`} AS id,
      COALESCE(SUM(amount),0) AS amount
    FROM contracting_accounting_settlements WHERE company_id = ${companyId}
      AND ${owner ? sql`owner_contract_id` : sql`subcontractor_contract_id`} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      AND kind = ${owner ? "advance_receipt" : "advance_payment"} AND status = 'posted'
    GROUP BY ${owner ? sql`owner_contract_id` : sql`subcontractor_contract_id`}`)) : [];
  const used = new Map(advanceUsed.map((r) => [Number(r.id), exactCents(r.amount)]));
  const projects = owner
    ? ownedProjects.filter((p) => { try { assertProjectBranchAccess(req, p.branchId); return true; } catch { return false; } })
      .map((p) => ({ id: Number(p.id), nameAr: p.nameAr }))
    : [];
  return {
    projects: [...new Map([...projects, ...allowed.map((c) => ({ id: Number(c.projectId), nameAr: c.projectName }))]
      .map((p) => [p.id, p])).values()],
    contracts: allowed.map((c) => {
      const remaining = exactCents(c.advancePayment) - (used.get(Number(c.id)) ?? 0n);
      return { ...c, remainingAmount: Number(remaining > 0n ? remaining : 0n) / 100 };
    }),
    bills,
  };
}

type SourceLine = {
  id: number; contractingKind: string | null; contractingProjectId: number | null;
  contractingContractId: number | null; contractingBillId: number | null;
  accountId: number | null; amount: string;
};

/** Lock order shared with direct contracting settlement: bill then contract. */
export async function lockVoucherContractScope(tx: any, companyId: number, lines: SourceLine[]) {
  const linked = lines.filter((l) => l.contractingKind != null);
  const bills = [...new Set(linked.map((l) => l.contractingBillId).filter((id): id is number => id != null))].sort((a, b) => a - b);
  for (const id of bills) await tx.execute(sql`SELECT id FROM contracting_progress_bills
    WHERE company_id = ${companyId} AND id = ${id} FOR UPDATE`);
  const contracts = [...new Map(linked.map((l) => [`${l.contractingKind?.startsWith("owner") ? "owner" : "subcontract"}:${l.contractingContractId}`, l])).values()]
    .sort((a, b) => (a.contractingContractId ?? 0) - (b.contractingContractId ?? 0));
  for (const l of contracts) {
    if (l.contractingKind?.startsWith("owner")) await tx.execute(sql`SELECT id FROM contracting_owner_contracts
      WHERE company_id = ${companyId} AND id = ${l.contractingContractId} FOR UPDATE`);
    else await tx.execute(sql`SELECT id FROM contracting_sub_contracts
      WHERE company_id = ${companyId} AND id = ${l.contractingContractId} FOR UPDATE`);
  }
}

/** Called within the SAME transaction that creates and attaches the voucher JE. */
export async function postVoucherSettlements(tx: any, companyId: number, voucher: "receipt" | "payment",
  v: any, lines: SourceLine[], journalId: number, req: any): Promise<void> {
  const linked = lines.filter((l) => l.contractingKind != null);
  if (!linked.length) return;
  const journal = rows(await tx.execute(sql`SELECT status FROM journal_entries
    WHERE id = ${journalId} AND company_id = ${companyId}`))[0];
  if (journal?.status !== "posted") fail("لا يمكن ترحيل تسوية المقاولات مع قيد محاسبي مسودة؛ فعّل ترحيل القيود لهذا النوع أولاً");
  if (Number(v.exchangeRate ?? 1) !== 1) fail("بنود المقاولات تتطلب سعر صرف 1");
  if (!v.entityId) fail("طرف عقد المقاولات مطلوب");
  const treasury = v.paymentType === "bank"
    ? rows(await tx.execute(sql`SELECT branch_id FROM bank_accounts WHERE company_id = ${companyId}
        AND id = ${v.bankAccountId ?? 0} AND is_active = true`))[0]
    : rows(await tx.execute(sql`SELECT branch_id FROM cash_boxes WHERE company_id = ${companyId}
        AND id = ${v.cashBoxId ?? 0} AND is_active = true`))[0];
  if (!treasury) fail("الخزنة/البنك غير نشط أو لا يتبع هذه الشركة");
  await lockVoucherContractScope(tx, companyId, linked);
  const touchedBills = new Set<number>();
  for (const line of linked) {
    const allocation = parseContractingAllocation({
      kind: line.contractingKind, projectId: line.contractingProjectId,
      contractId: line.contractingContractId, billId: line.contractingBillId,
    }, voucher)!;
    const correctAccount = await resolveContractingLine(tx, companyId, voucher, Number(v.entityId), allocation,
      { ...req, voucherBranchId: v.branchId });
    const projectBranch = rows(await tx.execute(sql`SELECT branch_id FROM contracting_projects
      WHERE company_id = ${companyId} AND id = ${allocation.projectId}`))[0]?.branch_id;
    if (treasury.branch_id != null && projectBranch != null && Number(treasury.branch_id) !== Number(projectBranch))
      fail("فرع الخزنة/البنك لا يطابق فرع المشروع");
    if (correctAccount !== line.accountId) fail("تغير ربط حساب المقاولات؛ عدّل البند ثم أعد الترحيل");
    const amount = Number(line.amount);
    if (!Number.isFinite(amount) || amount <= 0 || !/^\d+(?:\.\d{1,2})?$/.test(String(line.amount))) fail("مبلغ توزيع المقاولات غير صالح");
    const s = spec[allocation.kind];
    const replay = rows(await tx.execute(sql`SELECT journal_entry_id, amount, kind, project_id, bill_id,
      owner_contract_id, subcontractor_contract_id FROM contracting_accounting_settlements
      WHERE company_id = ${companyId} AND source_voucher_type = ${voucher}
        AND source_voucher_line_id = ${line.id} AND status = 'posted' LIMIT 1`))[0];
    if (replay) {
      if (Number(replay.journal_entry_id) !== journalId || Number(replay.amount) !== amount ||
        replay.kind !== s.settlement || Number(replay.project_id) !== allocation.projectId ||
        Number(replay.bill_id ?? 0) !== Number(allocation.billId ?? 0) ||
        Number((voucher === "receipt" ? replay.owner_contract_id : replay.subcontractor_contract_id) ?? 0) !== allocation.contractId)
        fail("سطر السند مرتبط بتسوية سابقة مختلفة");
      continue;
    }
    if (allocation.billId) {
      const bill = rows(await tx.execute(sql`SELECT net_amount FROM contracting_progress_bills
        WHERE company_id = ${companyId} AND id = ${allocation.billId}`))[0];
      const additions = rows(await tx.execute(sql`SELECT amount FROM contracting_bill_additions WHERE company_id = ${companyId} AND bill_id = ${allocation.billId}`));
      const deductions = rows(await tx.execute(sql`SELECT amount, kind FROM contracting_bill_deductions WHERE company_id = ${companyId} AND bill_id = ${allocation.billId}`));
      const penalties = rows(await tx.execute(sql`SELECT amount FROM contracting_bill_penalties WHERE company_id = ${companyId} AND bill_id = ${allocation.billId}`));
      const net = exactCents(calculateSignedContractingBillNet({ rawNetAmount: bill.net_amount, additions, deductions, penalties }).adjustedNetAmount);
      const used = rows(await tx.execute(sql`SELECT COALESCE(SUM(amount), 0) AS amount FROM contracting_accounting_settlements
        WHERE company_id = ${companyId} AND bill_id = ${allocation.billId} AND status = 'posted'
        AND kind IN ('bill_receipt','bill_payment','advance_application')`))[0];
      if (exactCents(line.amount) > net - exactCents(used.amount)) fail("مبلغ التوزيع يتجاوز الرصيد المتبقي للمستخلص");
      touchedBills.add(allocation.billId);
    } else {
      const table = voucher === "receipt" ? sql`contracting_owner_contracts` : sql`contracting_sub_contracts`;
      const contract = rows(await tx.execute(sql`SELECT advance_payment FROM ${table}
        WHERE company_id = ${companyId} AND id = ${allocation.contractId}`))[0];
      const used = rows(await tx.execute(sql`SELECT COALESCE(SUM(amount), 0) AS amount FROM contracting_accounting_settlements
        WHERE company_id = ${companyId} AND project_id = ${allocation.projectId}
          AND ${voucher === "receipt" ? sql`owner_contract_id` : sql`subcontractor_contract_id`} = ${allocation.contractId}
          AND kind = ${s.settlement} AND status = 'posted'`))[0];
      if (exactCents(line.amount) > exactCents(contract.advance_payment) - exactCents(used.amount))
        fail("مبلغ السلفة يتجاوز المتبقي من قيمة سلفة العقد");
    }
    await tx.execute(sql`INSERT INTO contracting_accounting_settlements
      (company_id, project_id, bill_id, owner_contract_id, subcontractor_contract_id,
       kind, direction, amount, settlement_date, payment_type, cash_box_id, bank_account_id,
       journal_entry_id, source_voucher_type, source_voucher_id, source_voucher_line_id, source_line_snapshot, created_by)
      VALUES (${companyId}, ${allocation.projectId}, ${allocation.billId ?? null},
       ${voucher === "receipt" ? allocation.contractId : null}, ${voucher === "payment" ? allocation.contractId : null},
       ${s.settlement}, ${s.direction}, ${amount.toFixed(2)}, ${v.date}, ${v.paymentType},
       ${v.cashBoxId ?? null}, ${v.bankAccountId ?? null}, ${journalId},
       ${voucher}, ${v.id}, ${line.id},
       ${JSON.stringify({ accountId: line.accountId, amount: line.amount, ...allocation })}::jsonb,
       ${req.authUser?.id ?? null})`);
  }
  for (const billId of touchedBills) await refreshBillPaymentState(tx, companyId, billId, req.authUser?.id ?? null);
}

/** Keep source rows and the voucher JE as audit evidence; never delete a posted settlement. */
export async function assertVoucherCanUnpost(tx: any, companyId: number, voucher: "receipt" | "payment", voucherId: number) {
  const links = rows(await tx.execute(sql`SELECT id, bill_id, kind, amount, applied_amount FROM contracting_accounting_settlements
    WHERE company_id = ${companyId} AND source_voucher_type = ${voucher}
      AND source_voucher_id = ${voucherId} AND status = 'posted' FOR UPDATE`));
  for (const link of links) {
    if (Number(link.applied_amount) > 0) fail("لا يمكن فك ترحيل سلفة مطبقة على مستخلص؛ اعكس تطبيق السلفة أولاً");
    const dependent = rows(await tx.execute(sql`SELECT id FROM contracting_accounting_settlements
      WHERE company_id = ${companyId} AND source_settlement_id = ${link.id} AND status = 'posted' LIMIT 1`));
    if (dependent.length) fail("لا يمكن فك الترحيل: توجد تسويات لاحقة تعتمد على هذا السند");
    if (link.bill_id != null) {
      const later = rows(await tx.execute(sql`SELECT id FROM contracting_accounting_settlements
        WHERE company_id = ${companyId} AND bill_id = ${link.bill_id}
          AND id > ${link.id} AND status = 'posted'
          AND kind IN ('bill_receipt','bill_payment','advance_application') LIMIT 1`));
      if (later.length) fail("لا يمكن فك الترحيل: توجد دفعات لاحقة على المستخلص؛ اعكسها أولاً");
    }
  }
  return links;
}