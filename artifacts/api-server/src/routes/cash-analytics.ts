import { Router } from "express";
import { db } from "@workspace/db";
import {
  cashBoxesTable, bankAccountsTable,
  receiptVouchersTable, paymentVouchersTable, cashTransfersTable,
} from "@workspace/db";
import { and, eq, sql, gte, lte, asc, inArray, or } from "drizzle-orm";
import { extractAuth, resolveCompanyId, pushBranchScope, branchScopeSpread, getAllowedBranchIds } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

router.use((req: any, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

function getBid(req: any): number | undefined {
  const v = req.query.branchId;
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolves the effective allowed-branch set for endpoints that filter
 * accounts (cash boxes / bank accounts) by branch:
 *   - deny=true                     → restricted user requested a forbidden branch
 *   - allowedSet=null               → no restriction (admin/superadmin, no filter)
 *   - allowedSet=[]                 → restricted user with zero branches (empty result)
 *   - allowedSet=[N]                → restricted to a single branch (explicit or auto)
 *   - allowedSet=[N1,N2,...]        → restricted to user's allowed list
 */
function resolveAllowedBranchSet(
  req: any,
  bid: number | undefined,
): { deny: boolean; allowedSet: number[] | null } {
  const allowed = getAllowedBranchIds(req);
  if (bid !== undefined) {
    if (allowed !== null && !allowed.includes(bid)) return { deny: true, allowedSet: [] };
    return { deny: false, allowedSet: [bid] };
  }
  return { deny: false, allowedSet: allowed };
}

const TRANSFER_TYPE_LABEL: Record<string, string> = {
  cash_to_cash: "خزينة → خزينة",
  cash_to_bank: "خزينة → بنك",
  bank_to_cash: "بنك → خزينة",
  bank_to_bank: "بنك → بنك",
};

const PAYMENT_TYPE_LABEL: Record<string, string> = {
  cash: "نقدي",
  bank: "بنكي",
};

const ENTITY_TYPE_LABEL: Record<string, string> = {
  customer: "عميل",
  supplier: "مورد",
  other:    "أخرى",
};

/**
 * Cash box balances as of a given date.
 * Cash is an asset: inflow (receipts + transfers in) increases balance, outflow decreases.
 */
router.get("/cash-balances", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const asOf = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);

    const scope = resolveAllowedBranchSet(req, bid);
    if (scope.deny) { res.json([]); return; }
    const boxConds: any[] = [eq(cashBoxesTable.companyId, cid)];
    if (scope.allowedSet) {
      if (scope.allowedSet.length === 0) { res.json([]); return; }
      boxConds.push(inArray(cashBoxesTable.branchId, scope.allowedSet));
    }
    const boxes = await db.select().from(cashBoxesTable).where(and(...boxConds));

    const inAgg = await db.select({
      cashBoxId: receiptVouchersTable.cashBoxId,
      total:     sql<string>`coalesce(sum(${receiptVouchersTable.amount}), 0)`,
    })
      .from(receiptVouchersTable)
      .where(and(
        eq(receiptVouchersTable.companyId, cid),
        eq(receiptVouchersTable.status, "posted"),
        eq(receiptVouchersTable.paymentType, "cash"),
        lte(receiptVouchersTable.date, asOf),
        ...branchScopeSpread(req, receiptVouchersTable.branchId, bid),
      ))
      .groupBy(receiptVouchersTable.cashBoxId);

    const outAgg = await db.select({
      cashBoxId: paymentVouchersTable.cashBoxId,
      total:     sql<string>`coalesce(sum(${paymentVouchersTable.amount}), 0)`,
    })
      .from(paymentVouchersTable)
      .where(and(
        eq(paymentVouchersTable.companyId, cid),
        eq(paymentVouchersTable.status, "posted"),
        eq(paymentVouchersTable.paymentType, "cash"),
        lte(paymentVouchersTable.date, asOf),
        ...branchScopeSpread(req, paymentVouchersTable.branchId, bid),
      ))
      .groupBy(paymentVouchersTable.cashBoxId);

    // NOTE: cashTransfersTable has no branchId column (transfers are
    // inter-account movements; branch is implicit in the source/destination
    // cash box / bank account). Skip branch filter on transfers.
    const trIn = await db.select({
      cashBoxId: cashTransfersTable.toCashBoxId,
      total:     sql<string>`coalesce(sum(${cashTransfersTable.amount}), 0)`,
    })
      .from(cashTransfersTable)
      .where(and(
        eq(cashTransfersTable.companyId, cid),
        eq(cashTransfersTable.status, "posted"),
        lte(cashTransfersTable.date, asOf),
      ))
      .groupBy(cashTransfersTable.toCashBoxId);

    const trOut = await db.select({
      cashBoxId: cashTransfersTable.fromCashBoxId,
      total:     sql<string>`coalesce(sum(${cashTransfersTable.amount}), 0)`,
    })
      .from(cashTransfersTable)
      .where(and(
        eq(cashTransfersTable.companyId, cid),
        eq(cashTransfersTable.status, "posted"),
        lte(cashTransfersTable.date, asOf),
      ))
      .groupBy(cashTransfersTable.fromCashBoxId);

    const inMap  = new Map<number, number>();
    const outMap = new Map<number, number>();
    for (const r of inAgg)  if (r.cashBoxId) inMap.set(r.cashBoxId,  (inMap.get(r.cashBoxId)  ?? 0) + Number(r.total));
    for (const r of trIn)   if (r.cashBoxId) inMap.set(r.cashBoxId,  (inMap.get(r.cashBoxId)  ?? 0) + Number(r.total));
    for (const r of outAgg) if (r.cashBoxId) outMap.set(r.cashBoxId, (outMap.get(r.cashBoxId) ?? 0) + Number(r.total));
    for (const r of trOut)  if (r.cashBoxId) outMap.set(r.cashBoxId, (outMap.get(r.cashBoxId) ?? 0) + Number(r.total));

    const rows = boxes.map(b => {
      const totalIn  = inMap.get(b.id)  ?? 0;
      const totalOut = outMap.get(b.id) ?? 0;
      return {
        id: b.id, code: b.code, nameAr: b.nameAr, nameEn: b.nameEn,
        currencyId: b.currencyId, isActive: b.isActive,
        totalIn, totalOut, balance: totalIn - totalOut,
      };
    });
    res.json(rows.sort((a, b) => b.balance - a.balance));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Bank account balances as of a given date.
 */
router.get("/bank-balances", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const asOf = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);

    const scope = resolveAllowedBranchSet(req, bid);
    if (scope.deny) { res.json([]); return; }
    const bankConds: any[] = [eq(bankAccountsTable.companyId, cid)];
    if (scope.allowedSet) {
      if (scope.allowedSet.length === 0) { res.json([]); return; }
      bankConds.push(inArray(bankAccountsTable.branchId, scope.allowedSet));
    }
    const banks = await db.select().from(bankAccountsTable).where(and(...bankConds));

    const inAgg = await db.select({
      bankAccountId: receiptVouchersTable.bankAccountId,
      total: sql<string>`coalesce(sum(${receiptVouchersTable.amount}), 0)`,
    })
      .from(receiptVouchersTable)
      .where(and(
        eq(receiptVouchersTable.companyId, cid),
        eq(receiptVouchersTable.status, "posted"),
        eq(receiptVouchersTable.paymentType, "bank"),
        lte(receiptVouchersTable.date, asOf),
        ...branchScopeSpread(req, receiptVouchersTable.branchId, bid),
      ))
      .groupBy(receiptVouchersTable.bankAccountId);

    const outAgg = await db.select({
      bankAccountId: paymentVouchersTable.bankAccountId,
      total: sql<string>`coalesce(sum(${paymentVouchersTable.amount}), 0)`,
    })
      .from(paymentVouchersTable)
      .where(and(
        eq(paymentVouchersTable.companyId, cid),
        eq(paymentVouchersTable.status, "posted"),
        eq(paymentVouchersTable.paymentType, "bank"),
        lte(paymentVouchersTable.date, asOf),
        ...branchScopeSpread(req, paymentVouchersTable.branchId, bid),
      ))
      .groupBy(paymentVouchersTable.bankAccountId);

    // Transfers: no branchId on cashTransfersTable (see note in /cash-balances).
    const trIn = await db.select({
      bankAccountId: cashTransfersTable.toBankId,
      total: sql<string>`coalesce(sum(${cashTransfersTable.amount}), 0)`,
    })
      .from(cashTransfersTable)
      .where(and(
        eq(cashTransfersTable.companyId, cid),
        eq(cashTransfersTable.status, "posted"),
        lte(cashTransfersTable.date, asOf),
      ))
      .groupBy(cashTransfersTable.toBankId);

    const trOut = await db.select({
      bankAccountId: cashTransfersTable.fromBankId,
      total: sql<string>`coalesce(sum(${cashTransfersTable.amount}), 0)`,
    })
      .from(cashTransfersTable)
      .where(and(
        eq(cashTransfersTable.companyId, cid),
        eq(cashTransfersTable.status, "posted"),
        lte(cashTransfersTable.date, asOf),
      ))
      .groupBy(cashTransfersTable.fromBankId);

    const inMap  = new Map<number, number>();
    const outMap = new Map<number, number>();
    for (const r of inAgg)  if (r.bankAccountId) inMap.set(r.bankAccountId,  (inMap.get(r.bankAccountId)  ?? 0) + Number(r.total));
    for (const r of trIn)   if (r.bankAccountId) inMap.set(r.bankAccountId,  (inMap.get(r.bankAccountId)  ?? 0) + Number(r.total));
    for (const r of outAgg) if (r.bankAccountId) outMap.set(r.bankAccountId, (outMap.get(r.bankAccountId) ?? 0) + Number(r.total));
    for (const r of trOut)  if (r.bankAccountId) outMap.set(r.bankAccountId, (outMap.get(r.bankAccountId) ?? 0) + Number(r.total));

    const rows = banks.map(b => {
      const totalIn  = inMap.get(b.id)  ?? 0;
      const totalOut = outMap.get(b.id) ?? 0;
      return {
        id: b.id, code: b.code, nameAr: b.nameAr, nameEn: b.nameEn,
        bankName: b.bankName, accountNumber: b.accountNumber, iban: b.iban,
        currencyId: b.currencyId, isActive: b.isActive,
        totalIn, totalOut, balance: totalIn - totalOut,
      };
    });
    res.json(rows.sort((a, b) => b.balance - a.balance));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

type StatementLine = {
  date: string;
  type: "receipt" | "payment" | "transfer_in" | "transfer_out";
  docNumber: string | null;
  description: string;
  debit: number;   // increases balance
  credit: number;  // decreases balance
};

async function buildAccountStatement(opts: {
  req: any;
  cid: number;
  kind: "cash" | "bank";
  accountId: number;
  from?: string;
  to?: string;
  bid?: number;
}) {
  const { req, cid, kind, accountId, from, to, bid } = opts;
  const idCol = kind === "cash" ? receiptVouchersTable.cashBoxId : receiptVouchersTable.bankAccountId;
  const idCol2 = kind === "cash" ? paymentVouchersTable.cashBoxId : paymentVouchersTable.bankAccountId;
  const trToCol   = kind === "cash" ? cashTransfersTable.toCashBoxId   : cashTransfersTable.toBankId;
  const trFromCol = kind === "cash" ? cashTransfersTable.fromCashBoxId : cashTransfersTable.fromBankId;
  const paymentType = kind === "cash" ? "cash" : "bank";

  // Branch filter applies only to receipts/payments (which have a branchId).
  // Transfers are inter-account movements and cashTransfersTable has no
  // branchId column, so transfers are included unfiltered for both branches.
  async function priorSumVoucher(table: any, col: any, dateCol: any, extraConds: any[] = []) {
    if (!from) return 0;
    const [row] = await db.select({ s: sql<string>`coalesce(sum(${table.amount}), 0)` })
      .from(table)
      .where(and(
        eq(table.companyId, cid),
        eq(table.status, "posted"),
        eq(col, accountId),
        ...extraConds,
        ...branchScopeSpread(req, table.branchId, bid),
        sql`${dateCol} < ${from}`,
      ));
    return Number(row.s);
  }
  async function priorSumTransfer(col: any) {
    if (!from) return 0;
    const [row] = await db.select({ s: sql<string>`coalesce(sum(${cashTransfersTable.amount}), 0)` })
      .from(cashTransfersTable)
      .where(and(
        eq(cashTransfersTable.companyId, cid),
        eq(cashTransfersTable.status, "posted"),
        eq(col, accountId),
        sql`${cashTransfersTable.date} < ${from}`,
      ));
    return Number(row.s);
  }

  // Opening balance = (receipts before from) + (transfers in before from)
  //                 - (payments before from) - (transfers out before from)
  const openIn  = await priorSumVoucher(receiptVouchersTable, idCol,  receiptVouchersTable.date, [eq(receiptVouchersTable.paymentType, paymentType)]);
  const openOut = await priorSumVoucher(paymentVouchersTable, idCol2, paymentVouchersTable.date, [eq(paymentVouchersTable.paymentType, paymentType)]);
  const openTrIn  = await priorSumTransfer(trToCol);
  const openTrOut = await priorSumTransfer(trFromCol);
  const opening = openIn + openTrIn - openOut - openTrOut;

  // Receipts (debit)
  const recConds: any[] = [
    eq(receiptVouchersTable.companyId, cid),
    eq(receiptVouchersTable.status, "posted"),
    eq(receiptVouchersTable.paymentType, paymentType),
    eq(idCol, accountId),
  ];
  pushBranchScope(req, recConds, receiptVouchersTable.branchId, bid);
  if (from) recConds.push(gte(receiptVouchersTable.date, from));
  if (to)   recConds.push(lte(receiptVouchersTable.date, to));
  const receipts = await db.select({
    id: receiptVouchersTable.id, date: receiptVouchersTable.date,
    code: receiptVouchersTable.code, amount: receiptVouchersTable.amount,
    entityName: receiptVouchersTable.entityName, description: receiptVouchersTable.description,
  }).from(receiptVouchersTable).where(and(...recConds));

  // Payments (credit)
  const payConds: any[] = [
    eq(paymentVouchersTable.companyId, cid),
    eq(paymentVouchersTable.status, "posted"),
    eq(paymentVouchersTable.paymentType, paymentType),
    eq(idCol2, accountId),
  ];
  pushBranchScope(req, payConds, paymentVouchersTable.branchId, bid);
  if (from) payConds.push(gte(paymentVouchersTable.date, from));
  if (to)   payConds.push(lte(paymentVouchersTable.date, to));
  const payments = await db.select({
    id: paymentVouchersTable.id, date: paymentVouchersTable.date,
    code: paymentVouchersTable.code, amount: paymentVouchersTable.amount,
    entityName: paymentVouchersTable.entityName, description: paymentVouchersTable.description,
  }).from(paymentVouchersTable).where(and(...payConds));

  // Transfers in (debit) and out (credit) — no branch filter (see note above).
  const trInConds: any[] = [
    eq(cashTransfersTable.companyId, cid),
    eq(cashTransfersTable.status, "posted"),
    eq(trToCol, accountId),
  ];
  if (from) trInConds.push(gte(cashTransfersTable.date, from));
  if (to)   trInConds.push(lte(cashTransfersTable.date, to));
  const transfersIn = await db.select({
    id: cashTransfersTable.id, date: cashTransfersTable.date,
    code: cashTransfersTable.code, amount: cashTransfersTable.amount,
    transferType: cashTransfersTable.transferType, description: cashTransfersTable.description,
  }).from(cashTransfersTable).where(and(...trInConds));

  const trOutConds: any[] = [
    eq(cashTransfersTable.companyId, cid),
    eq(cashTransfersTable.status, "posted"),
    eq(trFromCol, accountId),
  ];
  if (from) trOutConds.push(gte(cashTransfersTable.date, from));
  if (to)   trOutConds.push(lte(cashTransfersTable.date, to));
  const transfersOut = await db.select({
    id: cashTransfersTable.id, date: cashTransfersTable.date,
    code: cashTransfersTable.code, amount: cashTransfersTable.amount,
    transferType: cashTransfersTable.transferType, description: cashTransfersTable.description,
  }).from(cashTransfersTable).where(and(...trOutConds));

  const lines: StatementLine[] = [
    ...receipts.map(r => ({
      date: r.date, type: "receipt" as const, docNumber: r.code,
      description: r.description ?? `سند قبض${r.entityName ? ` — ${r.entityName}` : ""}`,
      debit: Number(r.amount), credit: 0,
    })),
    ...payments.map(p => ({
      date: p.date, type: "payment" as const, docNumber: p.code,
      description: p.description ?? `سند صرف${p.entityName ? ` — ${p.entityName}` : ""}`,
      debit: 0, credit: Number(p.amount),
    })),
    ...transfersIn.map(t => ({
      date: t.date, type: "transfer_in" as const, docNumber: t.code,
      description: t.description ?? `تحويل وارد (${TRANSFER_TYPE_LABEL[t.transferType] ?? t.transferType})`,
      debit: Number(t.amount), credit: 0,
    })),
    ...transfersOut.map(t => ({
      date: t.date, type: "transfer_out" as const, docNumber: t.code,
      description: t.description ?? `تحويل صادر (${TRANSFER_TYPE_LABEL[t.transferType] ?? t.transferType})`,
      debit: 0, credit: Number(t.amount),
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));

  return { opening, lines };
}

router.get("/cash-box-statement", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json({ opening: 0, lines: [] }); return; }
    const bid = getBid(req);
    const { cashBoxId, from, to } = req.query as Record<string, string>;
    const id = Number(cashBoxId);
    if (!cashBoxId || !Number.isFinite(id)) { res.status(400).json({ error: "cashBoxId مطلوب" }); return; }
    // Authorize: ensure cash box belongs to the user's allowed branches
    const scope = resolveAllowedBranchSet(req, bid);
    if (scope.deny) { res.json({ opening: 0, lines: [] }); return; }
    const [box] = await db.select({ branchId: cashBoxesTable.branchId, companyId: cashBoxesTable.companyId })
      .from(cashBoxesTable).where(eq(cashBoxesTable.id, id)).limit(1);
    if (!box || box.companyId !== cid) { res.json({ opening: 0, lines: [] }); return; }
    if (scope.allowedSet && !scope.allowedSet.includes(box.branchId)) { res.json({ opening: 0, lines: [] }); return; }
    const data = await buildAccountStatement({ req, cid, kind: "cash", accountId: id, from, to, bid });
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/bank-statement", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json({ opening: 0, lines: [] }); return; }
    const bid = getBid(req);
    const { bankAccountId, from, to } = req.query as Record<string, string>;
    const id = Number(bankAccountId);
    if (!bankAccountId || !Number.isFinite(id)) { res.status(400).json({ error: "bankAccountId مطلوب" }); return; }
    // Authorize: ensure bank account belongs to the user's allowed branches
    const scope = resolveAllowedBranchSet(req, bid);
    if (scope.deny) { res.json({ opening: 0, lines: [] }); return; }
    const [bank] = await db.select({ branchId: bankAccountsTable.branchId, companyId: bankAccountsTable.companyId })
      .from(bankAccountsTable).where(eq(bankAccountsTable.id, id)).limit(1);
    if (!bank || bank.companyId !== cid) { res.json({ opening: 0, lines: [] }); return; }
    if (scope.allowedSet && !scope.allowedSet.includes(bank.branchId)) { res.json({ opening: 0, lines: [] }); return; }
    const data = await buildAccountStatement({ req, cid, kind: "bank", accountId: id, from, to, bid });
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Daily cash flow summary: per day total in/out/net for a given scope (all/cash/bank).
 */
router.get("/daily-summary", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to, scope = "all" } = req.query as Record<string, string>;

    const recConds: any[] = [eq(receiptVouchersTable.companyId, cid), eq(receiptVouchersTable.status, "posted")];
    pushBranchScope(req, recConds, receiptVouchersTable.branchId, bid);
    if (scope === "cash") recConds.push(eq(receiptVouchersTable.paymentType, "cash"));
    else if (scope === "bank") recConds.push(eq(receiptVouchersTable.paymentType, "bank"));
    if (from) recConds.push(gte(receiptVouchersTable.date, from));
    if (to)   recConds.push(lte(receiptVouchersTable.date, to));

    const recAgg = await db.select({
      date:  receiptVouchersTable.date,
      total: sql<string>`coalesce(sum(${receiptVouchersTable.amount}), 0)`,
      cnt:   sql<number>`count(*)::int`,
    }).from(receiptVouchersTable).where(and(...recConds))
      .groupBy(receiptVouchersTable.date);

    const payConds: any[] = [eq(paymentVouchersTable.companyId, cid), eq(paymentVouchersTable.status, "posted")];
    pushBranchScope(req, payConds, paymentVouchersTable.branchId, bid);
    if (scope === "cash") payConds.push(eq(paymentVouchersTable.paymentType, "cash"));
    else if (scope === "bank") payConds.push(eq(paymentVouchersTable.paymentType, "bank"));
    if (from) payConds.push(gte(paymentVouchersTable.date, from));
    if (to)   payConds.push(lte(paymentVouchersTable.date, to));

    const payAgg = await db.select({
      date:  paymentVouchersTable.date,
      total: sql<string>`coalesce(sum(${paymentVouchersTable.amount}), 0)`,
      cnt:   sql<number>`count(*)::int`,
    }).from(paymentVouchersTable).where(and(...payConds))
      .groupBy(paymentVouchersTable.date);

    type Row = { date: string; totalIn: number; totalOut: number; receiptCount: number; paymentCount: number; net: number };
    const map = new Map<string, Row>();
    const ensure = (d: string): Row => {
      let r = map.get(d);
      if (!r) { r = { date: d, totalIn: 0, totalOut: 0, receiptCount: 0, paymentCount: 0, net: 0 }; map.set(d, r); }
      return r;
    };
    for (const r of recAgg) {
      const row = ensure(r.date);
      row.totalIn += Number(r.total);
      row.receiptCount += r.cnt;
    }
    for (const r of payAgg) {
      const row = ensure(r.date);
      row.totalOut += Number(r.total);
      row.paymentCount += r.cnt;
    }
    map.forEach(r => { r.net = r.totalIn - r.totalOut; });
    res.json(Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date)));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Receipt vouchers list with filters (for the receipts report).
 */
router.get("/receipts", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to, paymentType, cashBoxId, bankAccountId, entityType } = req.query as Record<string, string>;
    const conds: any[] = [eq(receiptVouchersTable.companyId, cid), eq(receiptVouchersTable.status, "posted")];
    pushBranchScope(req, conds, receiptVouchersTable.branchId, bid);
    if (from) conds.push(gte(receiptVouchersTable.date, from));
    if (to)   conds.push(lte(receiptVouchersTable.date, to));
    if (paymentType === "cash" || paymentType === "bank") conds.push(eq(receiptVouchersTable.paymentType, paymentType));
    if (cashBoxId)     conds.push(eq(receiptVouchersTable.cashBoxId, Number(cashBoxId)));
    if (bankAccountId) conds.push(eq(receiptVouchersTable.bankAccountId, Number(bankAccountId)));
    if (entityType === "customer" || entityType === "supplier" || entityType === "other") {
      conds.push(eq(receiptVouchersTable.entityType, entityType));
    }
    const rows = await db.select().from(receiptVouchersTable).where(and(...conds))
      .orderBy(asc(receiptVouchersTable.date), asc(receiptVouchersTable.id));
    res.json(rows.map(r => ({
      id: r.id, code: r.code, date: r.date,
      paymentType: r.paymentType, paymentTypeLabel: PAYMENT_TYPE_LABEL[r.paymentType] ?? r.paymentType,
      cashBoxId: r.cashBoxId, bankAccountId: r.bankAccountId,
      entityType: r.entityType, entityTypeLabel: ENTITY_TYPE_LABEL[r.entityType] ?? r.entityType,
      entityName: r.entityName, description: r.description,
      amount: Number(r.amount),
    })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/payments", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to, paymentType, cashBoxId, bankAccountId, entityType } = req.query as Record<string, string>;
    const conds: any[] = [eq(paymentVouchersTable.companyId, cid), eq(paymentVouchersTable.status, "posted")];
    pushBranchScope(req, conds, paymentVouchersTable.branchId, bid);
    if (from) conds.push(gte(paymentVouchersTable.date, from));
    if (to)   conds.push(lte(paymentVouchersTable.date, to));
    if (paymentType === "cash" || paymentType === "bank") conds.push(eq(paymentVouchersTable.paymentType, paymentType));
    if (cashBoxId)     conds.push(eq(paymentVouchersTable.cashBoxId, Number(cashBoxId)));
    if (bankAccountId) conds.push(eq(paymentVouchersTable.bankAccountId, Number(bankAccountId)));
    if (entityType === "customer" || entityType === "supplier" || entityType === "other") {
      conds.push(eq(paymentVouchersTable.entityType, entityType));
    }
    const rows = await db.select().from(paymentVouchersTable).where(and(...conds))
      .orderBy(asc(paymentVouchersTable.date), asc(paymentVouchersTable.id));
    res.json(rows.map(r => ({
      id: r.id, code: r.code, date: r.date,
      paymentType: r.paymentType, paymentTypeLabel: PAYMENT_TYPE_LABEL[r.paymentType] ?? r.paymentType,
      cashBoxId: r.cashBoxId, bankAccountId: r.bankAccountId,
      entityType: r.entityType, entityTypeLabel: ENTITY_TYPE_LABEL[r.entityType] ?? r.entityType,
      entityName: r.entityName, description: r.description,
      amount: Number(r.amount),
    })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/transfers", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { from, to, transferType } = req.query as Record<string, string>;
    const conds: any[] = [eq(cashTransfersTable.companyId, cid), eq(cashTransfersTable.status, "posted")];

    // Branch scoping for transfers: cashTransfersTable has no branchId, so
    // derive scope from the source/dest cash box and bank account branchIds.
    // A transfer is visible if EITHER endpoint belongs to an allowed branch.
    const allowed = getAllowedBranchIds(req);
    let allowedSet: number[] | null = null;
    if (bid !== undefined) {
      // explicit branch filter
      if (allowed !== null && !allowed.includes(bid)) {
        // restricted user requested forbidden branch → empty
        res.json([]); return;
      }
      allowedSet = [bid];
    } else if (allowed !== null) {
      if (allowed.length === 0) { res.json([]); return; }
      allowedSet = allowed;
    }
    if (allowedSet) {
      const cbIds = (await db.select({ id: cashBoxesTable.id })
        .from(cashBoxesTable)
        .where(and(eq(cashBoxesTable.companyId, cid), inArray(cashBoxesTable.branchId, allowedSet)))).map(r => r.id);
      const baIds = (await db.select({ id: bankAccountsTable.id })
        .from(bankAccountsTable)
        .where(and(eq(bankAccountsTable.companyId, cid), inArray(bankAccountsTable.branchId, allowedSet)))).map(r => r.id);
      const branchClauses: any[] = [];
      if (cbIds.length) {
        branchClauses.push(inArray(cashTransfersTable.fromCashBoxId, cbIds));
        branchClauses.push(inArray(cashTransfersTable.toCashBoxId,   cbIds));
      }
      if (baIds.length) {
        branchClauses.push(inArray(cashTransfersTable.fromBankId, baIds));
        branchClauses.push(inArray(cashTransfersTable.toBankId,   baIds));
      }
      if (branchClauses.length === 0) { res.json([]); return; }
      conds.push(or(...branchClauses));
    }
    if (from) conds.push(gte(cashTransfersTable.date, from));
    if (to)   conds.push(lte(cashTransfersTable.date, to));
    if (transferType === "cash_to_cash" || transferType === "cash_to_bank" ||
        transferType === "bank_to_cash" || transferType === "bank_to_bank") {
      conds.push(eq(cashTransfersTable.transferType, transferType));
    }
    const rows = await db.select().from(cashTransfersTable).where(and(...conds))
      .orderBy(asc(cashTransfersTable.date), asc(cashTransfersTable.id));

    // Name lookups must be scoped to allowed branches too — otherwise a
    // restricted user viewing a transfer with one allowed and one forbidden
    // endpoint would see the forbidden account's name. Unauthorized
    // counterparts are masked as "—" below.
    const boxConds: any[] = [eq(cashBoxesTable.companyId, cid)];
    const bankConds: any[] = [eq(bankAccountsTable.companyId, cid)];
    if (allowedSet) {
      boxConds.push(inArray(cashBoxesTable.branchId, allowedSet));
      bankConds.push(inArray(bankAccountsTable.branchId, allowedSet));
    }
    const boxes = await db.select().from(cashBoxesTable).where(and(...boxConds));
    const banks = await db.select().from(bankAccountsTable).where(and(...bankConds));
    const boxMap  = new Map(boxes.map(b => [b.id, b.nameAr]));
    const bankMap = new Map(banks.map(b => [b.id, b.nameAr]));

    const fromName = (r: any) => r.fromCashBoxId ? boxMap.get(r.fromCashBoxId) : (r.fromBankId ? bankMap.get(r.fromBankId) : null);
    const toName   = (r: any) => r.toCashBoxId   ? boxMap.get(r.toCashBoxId)   : (r.toBankId   ? bankMap.get(r.toBankId)   : null);

    res.json(rows.map(r => ({
      id: r.id, code: r.code, date: r.date,
      transferType: r.transferType,
      transferTypeLabel: TRANSFER_TYPE_LABEL[r.transferType] ?? r.transferType,
      fromName: fromName(r) ?? "—",
      toName:   toName(r)   ?? "—",
      description: r.description,
      amount: Number(r.amount),
    })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
