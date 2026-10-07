import { Router } from "express";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  accountsTable,
  branchesTable,
  cashBoxesTable,
  currenciesTable,
  journalEntriesTable,
  paymentVoucherLinesTable,
  paymentVouchersTable,
  salesRepsTable,
  settlementLinksTable,
  userBranchesTable,
  usersTable,
} from "@workspace/db";
import {
  CreateCashExpenseBody,
  DeleteCashExpenseReceiptUploadBody,
  UpdateCashExpenseBody,
  UploadCashExpenseReceiptBody,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { draftLinkedSourceJournalEntry, getLinkedSourceJournalEntry } from "../lib/sourceJournalEntryLifecycle.js";
import { nextSequenceOrFallback } from "../lib/sequences.js";
import { mobilePermAllowed } from "../lib/mobilePerms.js";
import { cashExpenseBoxAllowed, cashExpenseRecordVisible, summarizeCashExpenseCurrencyTotals } from "../lib/cashExpenseAccessPolicy.js";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage.js";
import { extractAuth } from "../middleware/auth.js";
import { buildPaymentJournal } from "./payment-vouchers.js";

const router = Router();
router.use(extractAuth);

const objectStorage = new ObjectStorageService();
const RECEIPT_LIMIT_BYTES = 5 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type QueryExecutor = typeof db | any;
type CashExpenseScope = {
  user: any;
  userId: number;
  companyId: number;
  branchIds: Set<number>;
  allBranchBoxes: boolean;
  cashBoxIds: Set<number>;
  salesRepId: number | null;
  salesRepName: string | null;
};

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function toDateString(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  }
  return validDate(value) ? value : null;
}

function validAmount(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return false;
  return Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
}

async function loadScope(userId: number, companyId?: number, executor: QueryExecutor = db): Promise<CashExpenseScope | null> {
  const [user] = await executor.select({
    id: usersTable.id,
    companyId: usersTable.companyId,
    role: usersTable.role,
    isActive: usersTable.isActive,
    viewAllBranches: usersTable.viewAllBranches,
    mobilePermissions: usersTable.mobilePermissions,
    username: usersTable.username,
    nameAr: usersTable.nameAr,
  }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user?.isActive || user.companyId == null || (companyId != null && user.companyId !== companyId)) return null;

  const reps = await executor.select({
    id: salesRepsTable.id,
    branchId: salesRepsTable.branchId,
    nameAr: salesRepsTable.nameAr,
  }).from(salesRepsTable).where(and(
    eq(salesRepsTable.companyId, user.companyId),
    eq(salesRepsTable.userId, userId),
    eq(salesRepsTable.isActive, true),
  )).orderBy(asc(salesRepsTable.id));

  let branchIds: Set<number>;
  if (reps.length > 0) {
    branchIds = new Set(reps.map((rep: any) => rep.branchId).filter((id: any): id is number => Number.isInteger(id) && id > 0));
  } else {
    const links = await executor.select({ branchId: userBranchesTable.branchId })
      .from(userBranchesTable)
      .innerJoin(branchesTable, eq(branchesTable.id, userBranchesTable.branchId))
      .where(and(
        eq(userBranchesTable.userId, userId),
        eq(branchesTable.companyId, user.companyId),
      ));
    branchIds = new Set(links.map((link: any) => link.branchId).filter((id: any): id is number => Number.isInteger(id) && id > 0));
  }

  // viewAllBranches is not sufficient by itself: the user must also have the
  // new, explicit cash-expense all-view grant.
  const allBranchBoxes = user.viewAllBranches === true && mobilePermAllowed(user, "cash_expenses_view_all");
  const boxes = await executor.select({
    id: cashBoxesTable.id,
    branchId: cashBoxesTable.branchId,
    branchCompanyId: branchesTable.companyId,
    cashExpenseManagerUserId: cashBoxesTable.cashExpenseManagerUserId,
  }).from(cashBoxesTable)
    .leftJoin(branchesTable, eq(branchesTable.id, cashBoxesTable.branchId))
    .where(eq(cashBoxesTable.companyId, user.companyId));
  const cashBoxIds = new Set<number>();
  for (const box of boxes) {
    if (cashExpenseBoxAllowed(box, {
      userId,
      companyId: user.companyId,
      branchIds,
      allBranchBoxes,
    })) cashBoxIds.add(box.id);
  }

  const rep = reps[0] ?? null;
  return {
    user,
    userId,
    companyId: user.companyId,
    branchIds,
    allBranchBoxes,
    cashBoxIds,
    salesRepId: rep?.id ?? null,
    salesRepName: rep?.nameAr ?? null,
  };
}

async function requestScope(req: any): Promise<CashExpenseScope | null> {
  const userId = Number(req.authUser?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  return loadScope(userId);
}

function hasRight(scope: CashExpenseScope, key: string): boolean {
  return mobilePermAllowed(scope.user, key);
}

function responseDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function toCashExpense(row: any, userId: number) {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    date: String(row.date).slice(0, 10),
    branchId: row.branchId ?? null,
    cashBoxId: row.cashBoxId,
    cashBoxName: row.cashBoxName || "خزنة",
    currencyCode: row.currencyCode ?? null,
    expenseAccountId: row.expenseAccountId,
    expenseAccountName: row.expenseAccountName || "حساب مصروف",
    amount: Number(row.amount) || 0,
    description: row.lineDescription || row.description || "",
    status: row.status,
    journalEntryId: row.journalEntryId ?? null,
    createdByUserId: row.cashExpenseCreatedByUserId,
    employeeName: row.employeeName || row.username || `#${row.cashExpenseCreatedByUserId}`,
    salesRepId: row.cashExpenseSalesRepId ?? null,
    salesRepName: row.salesRepName ?? null,
    receiptAvailable: !!row.cashExpenseReceiptPath,
    createdAt: responseDate(row.createdAt),
    isMine: row.cashExpenseCreatedByUserId === userId,
    cancelledAt: row.cashExpenseCancelledAt ? responseDate(row.cashExpenseCancelledAt) : null,
  };
}

const expenseSelect = {
  id: paymentVouchersTable.id,
  companyId: paymentVouchersTable.companyId,
  code: paymentVouchersTable.code,
  date: paymentVouchersTable.date,
  branchId: paymentVouchersTable.branchId,
  cashBoxId: paymentVouchersTable.cashBoxId,
  amount: paymentVouchersTable.amount,
  description: paymentVouchersTable.description,
  status: paymentVouchersTable.status,
  journalEntryId: paymentVouchersTable.journalEntryId,
  cashExpenseCreatedByUserId: paymentVouchersTable.cashExpenseCreatedByUserId,
  cashExpenseSalesRepId: paymentVouchersTable.cashExpenseSalesRepId,
  cashExpenseReceiptPath: paymentVouchersTable.cashExpenseReceiptPath,
  cashExpenseCancelledAt: paymentVouchersTable.cashExpenseCancelledAt,
  createdAt: paymentVouchersTable.createdAt,
  cashBoxName: cashBoxesTable.nameAr,
  currencyCode: currenciesTable.code,
  expenseAccountId: paymentVoucherLinesTable.accountId,
  expenseAccountName: accountsTable.nameAr,
  lineDescription: paymentVoucherLinesTable.description,
  username: usersTable.username,
  employeeName: usersTable.nameAr,
  salesRepName: salesRepsTable.nameAr,
};

async function selectExpense(executor: QueryExecutor, id: number, companyId: number): Promise<any | null> {
  const [row] = await executor.select(expenseSelect)
    .from(paymentVouchersTable)
    .innerJoin(cashBoxesTable, eq(cashBoxesTable.id, paymentVouchersTable.cashBoxId))
    .leftJoin(currenciesTable, and(
      eq(currenciesTable.id, cashBoxesTable.currencyId),
      eq(currenciesTable.companyId, companyId),
    ))
    .innerJoin(paymentVoucherLinesTable, eq(paymentVoucherLinesTable.voucherId, paymentVouchersTable.id))
    .leftJoin(accountsTable, eq(accountsTable.id, paymentVoucherLinesTable.accountId))
    .leftJoin(usersTable, eq(usersTable.id, paymentVouchersTable.cashExpenseCreatedByUserId))
    .leftJoin(salesRepsTable, eq(salesRepsTable.id, paymentVouchersTable.cashExpenseSalesRepId))
    .where(and(
      eq(paymentVouchersTable.id, id),
      eq(paymentVouchersTable.companyId, companyId),
      eq(paymentVouchersTable.sourceType, "cash_expense"),
    )).limit(1);
  return row ?? null;
}

async function selectExpenseReceiptPath(executor: QueryExecutor, id: number, companyId: number): Promise<string | null> {
  const [row] = await executor.select({ path: paymentVouchersTable.cashExpenseReceiptPath })
    .from(paymentVouchersTable)
    .where(and(
      eq(paymentVouchersTable.id, id),
      eq(paymentVouchersTable.companyId, companyId),
      eq(paymentVouchersTable.sourceType, "cash_expense"),
    )).limit(1);
  return row?.path ?? null;
}

async function canReadExpense(scope: CashExpenseScope, expense: any, allowEdit = false): Promise<boolean> {
  if (!expense || !scope.cashBoxIds.has(expense.cashBoxId)) return false;
  return cashExpenseRecordVisible(
    expense.cashExpenseCreatedByUserId,
    scope.userId,
    hasRight(scope, "cash_expenses_view_own"),
    hasRight(scope, "cash_expenses_view_all"),
  ) || (allowEdit && hasRight(scope, "cash_expenses_edit"));
}

async function assertAllowedReceiptPath(path: string, scope: CashExpenseScope): Promise<void> {
  const ownPath = new RegExp(
    `^/objects/cash-expenses/${scope.companyId}/${scope.userId}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(jpg|png|webp)$`,
    "i",
  );
  if (!ownPath.test(path)) throw Object.assign(new Error("مسار إيصال غير صالح"), { status: 400 });
  const file = objectStorage.getPrivateObjectFile(path.slice("/objects/".length));
  const [exists] = await file.exists();
  if (!exists) throw Object.assign(new Error("ملف الإيصال غير موجود"), { status: 400 });
}

async function removeReceiptIfUnreferenced(path: string | null, companyId: number): Promise<void> {
  if (!path?.startsWith(`/objects/cash-expenses/${companyId}/`)) return;
  const [reference] = await db.select({ id: paymentVouchersTable.id }).from(paymentVouchersTable).where(and(
    eq(paymentVouchersTable.companyId, companyId),
    eq(paymentVouchersTable.sourceType, "cash_expense"),
    eq(paymentVouchersTable.cashExpenseReceiptPath, path),
  )).limit(1);
  if (reference) return;
  try {
    await objectStorage.getPrivateObjectFile(path.slice("/objects/".length)).delete({ ignoreNotFound: true });
  } catch (error) {
    console.warn("Could not remove an unreferenced cash expense receipt", error);
  }
}

function validImageBytes(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/webp") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

function receiptExtension(mimeType: string): string {
  return mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "webp";
}

router.get("/options", async (req: any, res) => {
  const scope = await requestScope(req);
  if (!scope) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (!hasRight(scope, "cash_expenses_create") && !hasRight(scope, "cash_expenses_edit")) {
    res.status(403).json({ error: "لا تملك صلاحية تسجيل أو تعديل مصروفات الصندوق" }); return;
  }
  if (!scope.cashBoxIds.size) {
    res.json({
      cashBoxes: [], expenseAccounts: [], defaultCashBoxId: null,
      employeeName: scope.user.nameAr || scope.user.username || `#${scope.userId}`,
      salesRepId: scope.salesRepId, salesRepName: scope.salesRepName,
    });
    return;
  }
  const cashBoxes = await db.select({
    id: cashBoxesTable.id,
    code: cashBoxesTable.code,
    name: cashBoxesTable.nameAr,
    branchId: cashBoxesTable.branchId,
    currencyId: cashBoxesTable.currencyId,
    currencyCode: currenciesTable.code,
  }).from(cashBoxesTable).leftJoin(currenciesTable, and(
    eq(currenciesTable.id, cashBoxesTable.currencyId),
    eq(currenciesTable.companyId, scope.companyId),
  )).where(and(
    eq(cashBoxesTable.companyId, scope.companyId),
    eq(cashBoxesTable.isActive, true),
    inArray(cashBoxesTable.id, [...scope.cashBoxIds]),
  )).orderBy(asc(cashBoxesTable.code));
  const expenseAccounts = await db.select({
    id: accountsTable.id,
    code: accountsTable.code,
    name: accountsTable.nameAr,
  }).from(accountsTable).where(and(
    eq(accountsTable.companyId, scope.companyId),
    eq(accountsTable.accountType, "expense"),
    eq(accountsTable.isPosting, true),
    eq(accountsTable.isActive, true),
  )).orderBy(asc(accountsTable.code));
  const defaultCashBoxId = cashBoxes.length === 1 ? cashBoxes[0].id : null;
  res.json({
    cashBoxes,
    expenseAccounts,
    defaultCashBoxId,
    employeeName: scope.user.nameAr || scope.user.username || `#${scope.userId}`,
    salesRepId: scope.salesRepId,
    salesRepName: scope.salesRepName,
  });
});

router.get("/", async (req: any, res) => {
  const scope = await requestScope(req);
  if (!scope) { res.status(401).json({ error: "غير مصرح" }); return; }
  const canViewOwn = hasRight(scope, "cash_expenses_view_own");
  const canViewAll = hasRight(scope, "cash_expenses_view_all");
  if (!canViewOwn && !canViewAll) { res.status(403).json({ error: "لا تملك صلاحية عرض مصروفات الصندوق" }); return; }
  if (!scope.cashBoxIds.size) { res.json([]); return; }

  const where: any[] = [
    eq(paymentVouchersTable.companyId, scope.companyId),
    eq(paymentVouchersTable.sourceType, "cash_expense"),
    inArray(paymentVouchersTable.cashBoxId, [...scope.cashBoxIds]),
  ];
  if (!canViewAll) where.push(eq(paymentVouchersTable.cashExpenseCreatedByUserId, scope.userId));
  const from = req.query.from == null ? null : String(req.query.from);
  const to = req.query.to == null ? null : String(req.query.to);
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) {
    res.status(400).json({ error: "نطاق التاريخ غير صالح" }); return;
  }
  if (from) where.push(gte(paymentVouchersTable.date, from));
  if (to) where.push(lte(paymentVouchersTable.date, to));
  const status = req.query.status == null ? null : String(req.query.status);
  if (status && !["draft", "posted", "cancelled"].includes(status)) {
    res.status(400).json({ error: "حالة المصروف غير صالحة" }); return;
  }
  if (status) where.push(eq(paymentVouchersTable.status, status as any));
  const rows = await db.select(expenseSelect)
    .from(paymentVouchersTable)
    .innerJoin(cashBoxesTable, eq(cashBoxesTable.id, paymentVouchersTable.cashBoxId))
    .leftJoin(currenciesTable, and(
      eq(currenciesTable.id, cashBoxesTable.currencyId),
      eq(currenciesTable.companyId, scope.companyId),
    ))
    .innerJoin(paymentVoucherLinesTable, eq(paymentVoucherLinesTable.voucherId, paymentVouchersTable.id))
    .leftJoin(accountsTable, eq(accountsTable.id, paymentVoucherLinesTable.accountId))
    .leftJoin(usersTable, eq(usersTable.id, paymentVouchersTable.cashExpenseCreatedByUserId))
    .leftJoin(salesRepsTable, eq(salesRepsTable.id, paymentVouchersTable.cashExpenseSalesRepId))
    .where(and(...where))
    .orderBy(desc(paymentVouchersTable.date), desc(paymentVouchersTable.id))
    .limit(200);
  res.json(rows.map((row: any) => toCashExpense(row, scope.userId)));
});

router.post("/", async (req: any, res) => {
  const scope = await requestScope(req);
  if (!scope) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (!hasRight(scope, "cash_expenses_create")) { res.status(403).json({ error: "لا تملك صلاحية تسجيل مصروفات الصندوق" }); return; }
  const parsed = CreateCashExpenseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const input = parsed.data;
  const expenseDate = toDateString(input.date);
  if (!expenseDate) { res.status(400).json({ error: "التاريخ غير صالح" }); return; }
  if (!validAmount(input.amount)) { res.status(400).json({ error: "المبلغ يجب أن يكون موجباً وبحد أقصى منزلتين عشريتين" }); return; }
  const description = input.description.trim();
  if (!description) { res.status(400).json({ error: "البيان مطلوب" }); return; }

  try {
    const receiptPath = input.receiptPath ?? null;
    if (receiptPath) await assertAllowedReceiptPath(receiptPath, scope);
    const createdId = await db.transaction(async (tx) => {
      const freshScope = await loadScope(scope.userId, scope.companyId, tx);
      if (!freshScope || !hasRight(freshScope, "cash_expenses_create")) throw Object.assign(new Error("لا تملك صلاحية تسجيل مصروفات الصندوق"), { status: 403 });
      const [box] = await tx.select({
        id: cashBoxesTable.id,
        companyId: cashBoxesTable.companyId,
        branchId: cashBoxesTable.branchId,
        currencyId: cashBoxesTable.currencyId,
        branchCompanyId: branchesTable.companyId,
        cashExpenseManagerUserId: cashBoxesTable.cashExpenseManagerUserId,
      }).from(cashBoxesTable)
        .leftJoin(branchesTable, eq(branchesTable.id, cashBoxesTable.branchId))
        .where(and(eq(cashBoxesTable.id, input.cashBoxId), eq(cashBoxesTable.companyId, scope.companyId), eq(cashBoxesTable.isActive, true)))
        .for("update");
      if (!box || !cashExpenseBoxAllowed(box, freshScope)) throw Object.assign(new Error("الخزنة غير متاحة لفروعك أو للمستخدم الحالي"), { status: 403 });
      const [account] = await tx.select({ id: accountsTable.id })
        .from(accountsTable).where(and(
          eq(accountsTable.id, input.expenseAccountId),
          eq(accountsTable.companyId, scope.companyId),
          eq(accountsTable.accountType, "expense"),
          eq(accountsTable.isPosting, true),
          eq(accountsTable.isActive, true),
        )).limit(1);
      if (!account) throw Object.assign(new Error("اختر حساب مصروف نشطاً وقابلاً للترحيل من الشركة"), { status: 400 });

      const code = await nextSequenceOrFallback(
        scope.companyId,
        "payment_voucher",
        { userId: scope.userId, refTable: "payment_vouchers", branchId: box.branchId ?? null },
        async () => `CE-${expenseDate.replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
      );
      const [voucher] = await tx.insert(paymentVouchersTable).values({
        companyId: scope.companyId,
        branchId: box.branchId ?? null,
        code,
        date: expenseDate,
        paymentType: "cash",
        cashBoxId: box.id,
        bankAccountId: null,
        entityType: "other",
        entityId: null,
        entityName: "مصروفات الصندوق",
        accountId: account.id,
        amount: input.amount.toFixed(2),
        currencyId: box.currencyId ?? null,
        exchangeRate: "1",
        description,
        status: "draft",
        sourceType: "cash_expense",
        cashExpenseCreatedByUserId: scope.userId,
        cashExpenseSalesRepId: freshScope.salesRepId,
        cashExpenseReceiptPath: receiptPath,
      }).returning({ id: paymentVouchersTable.id });
      if (!voucher) throw new Error("تعذّر إنشاء المصروف");
      await tx.insert(paymentVoucherLinesTable).values({
        voucherId: voucher.id,
        accountId: account.id,
        description,
        amount: input.amount.toFixed(2),
        taxRate: "0",
        taxAmount: "0",
        taxAccountId: null,
        branchId: box.branchId ?? null,
        opType: "direct",
        sortOrder: 0,
      });
      return voucher.id;
    });
    const row = await selectExpense(db, createdId, scope.companyId);
    if (!row) { res.status(500).json({ error: "تم الحفظ لكن تعذّر تحميل المصروف" }); return; }
    res.status(201).json(toCashExpense(row, scope.userId));
  } catch (error: any) {
    (req as any).log?.error({ err: error }, "Cash expense creation failed");
    res.status(error?.status ?? 400).json({ error: error?.message ?? "تعذّر حفظ المصروف" });
  }
});

router.get("/report", async (req: any, res) => {
  const scope = await requestScope(req);
  if (!scope) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (!hasRight(scope, "cash_expenses_report")) { res.status(403).json({ error: "لا تملك صلاحية تقارير مصروفات الصندوق" }); return; }
  const canViewOwn = hasRight(scope, "cash_expenses_view_own");
  const canViewAll = hasRight(scope, "cash_expenses_view_all");
  if (!canViewOwn && !canViewAll) { res.status(403).json({ error: "التقرير يتطلب صلاحية عرض المصروفات" }); return; }
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (!validDate(from) || !validDate(to) || from > to) { res.status(400).json({ error: "نطاق التاريخ غير صالح" }); return; }
  if (!scope.cashBoxIds.size) { res.json({ from, to, totalAmount: 0, currencyCode: null, count: 0, rows: [] }); return; }
  const where: any[] = [
    eq(paymentVouchersTable.companyId, scope.companyId),
    eq(paymentVouchersTable.sourceType, "cash_expense"),
    eq(paymentVouchersTable.status, "posted"),
    inArray(paymentVouchersTable.cashBoxId, [...scope.cashBoxIds]),
    gte(paymentVouchersTable.date, from),
    lte(paymentVouchersTable.date, to),
  ];
  if (!canViewAll) where.push(eq(paymentVouchersTable.cashExpenseCreatedByUserId, scope.userId));
  const groups = await db.select({
    cashBoxId: paymentVouchersTable.cashBoxId,
    cashBoxName: cashBoxesTable.nameAr,
    currencyCode: currenciesTable.code,
    expenseAccountId: paymentVoucherLinesTable.accountId,
    expenseAccountName: accountsTable.nameAr,
    amount: sql<string>`COALESCE(SUM(${paymentVouchersTable.amount}), 0)`,
    count: sql<number>`COUNT(*)`,
  }).from(paymentVouchersTable)
    .innerJoin(cashBoxesTable, eq(cashBoxesTable.id, paymentVouchersTable.cashBoxId))
     .leftJoin(currenciesTable, and(
       eq(currenciesTable.id, cashBoxesTable.currencyId),
       eq(currenciesTable.companyId, scope.companyId),
     ))
    .innerJoin(paymentVoucherLinesTable, eq(paymentVoucherLinesTable.voucherId, paymentVouchersTable.id))
    .innerJoin(accountsTable, eq(accountsTable.id, paymentVoucherLinesTable.accountId))
    .where(and(...where))
    .groupBy(
      paymentVouchersTable.cashBoxId,
      cashBoxesTable.nameAr,
      currenciesTable.code,
      paymentVoucherLinesTable.accountId,
      accountsTable.nameAr,
    )
    .orderBy(asc(cashBoxesTable.nameAr), asc(accountsTable.nameAr));
  const rows = groups.map((row: any) => ({
    cashBoxId: row.cashBoxId!,
    cashBoxName: row.cashBoxName,
    expenseAccountId: row.expenseAccountId!,
    expenseAccountName: row.expenseAccountName,
    currencyCode: typeof row.currencyCode === "string" && row.currencyCode.trim() ? row.currencyCode : null,
    amount: Number(row.amount) || 0,
    count: Number(row.count) || 0,
  }));
  const totals = summarizeCashExpenseCurrencyTotals(rows);
  res.json({
    from,
    to,
    ...totals,
    count: rows.reduce((sum: number, row: any) => sum + row.count, 0),
    rows,
  });
});

router.post("/receipt-upload", async (req: any, res) => {
  const scope = await requestScope(req);
  if (!scope) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (!hasRight(scope, "cash_expenses_create") && !hasRight(scope, "cash_expenses_edit")) {
    res.status(403).json({ error: "لا تملك صلاحية إرفاق إيصال لمصروف الصندوق" }); return;
  }
  const parsed = UploadCashExpenseReceiptBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { mimeType, base64 } = parsed.data;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    res.status(400).json({ error: "صورة الإيصال غير صالحة" }); return;
  }
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > RECEIPT_LIMIT_BYTES || !validImageBytes(bytes, mimeType)) {
    res.status(413).json({ error: "الإيصال يجب أن يكون صورة JPEG أو PNG أو WebP ولا يتجاوز 5 ميجابايت" }); return;
  }
  const key = `cash-expenses/${scope.companyId}/${scope.userId}/${randomUUID()}.${receiptExtension(mimeType)}`;
  try {
    const file = objectStorage.getPrivateObjectFile(key);
    const stream = file.createWriteStream({
      metadata: { contentType: mimeType, cacheControl: "private, no-store" },
    });
    stream.end(bytes);
    await once(stream, "finish");
    res.status(201).json({ objectPath: `/objects/${key}`, sizeBytes: bytes.length, mimeType });
  } catch (error: any) {
    (req as any).log?.error({ err: error }, "Cash expense receipt upload failed");
    res.status(500).json({ error: "تعذّر حفظ صورة الإيصال" });
  }
});

router.delete("/receipt-upload", async (req: any, res) => {
  const scope = await requestScope(req);
  if (!scope) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (!hasRight(scope, "cash_expenses_create") && !hasRight(scope, "cash_expenses_edit")) {
    res.status(403).json({ error: "لا تملك صلاحية حذف إيصال مؤقت" }); return;
  }
  const parsed = DeleteCashExpenseReceiptUploadBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const path = parsed.data.objectPath;
    await assertAllowedReceiptPath(path, scope);
    const [attached] = await db.select({ id: paymentVouchersTable.id }).from(paymentVouchersTable).where(and(
      eq(paymentVouchersTable.companyId, scope.companyId),
      eq(paymentVouchersTable.sourceType, "cash_expense"),
      eq(paymentVouchersTable.cashExpenseReceiptPath, path),
    )).limit(1);
    if (attached) { res.status(409).json({ error: "الإيصال مرتبط بمصروف محفوظ" }); return; }
    await objectStorage.getPrivateObjectFile(path.slice("/objects/".length)).delete({ ignoreNotFound: true });
    res.json({ deleted: true });
  } catch (error: any) {
    res.status(error?.status ?? 400).json({ error: error?.message ?? "تعذّر حذف صورة الإيصال المؤقتة" });
  }
});

router.get("/:id/receipt", async (req: any, res) => {
  const scope = await requestScope(req);
  if (!scope) { res.status(401).json({ error: "غير مصرح" }); return; }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف المصروف غير صالح" }); return; }
  const expense = await selectExpense(db, id, scope.companyId);
  if (!expense || !(await canReadExpense(scope, expense, true))) { res.status(404).json({ error: "المصروف غير موجود" }); return; }
  const path = await selectExpenseReceiptPath(db, id, scope.companyId);
  if (!path) { res.status(404).json({ error: "لا يوجد إيصال لهذا المصروف" }); return; }
  try {
    const file = await objectStorage.getObjectEntityFile(path);
    const result = await objectStorage.downloadObject(file);
    if (result.status !== 200 || !result.body) { res.status(404).json({ error: "ملف الإيصال غير موجود" }); return; }
    res.status(200);
    result.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("Cache-Control", "private, no-store");
    Readable.fromWeb(result.body as any).pipe(res);
  } catch (error: any) {
    if (error instanceof ObjectNotFoundError) { res.status(404).json({ error: "ملف الإيصال غير موجود" }); return; }
    (req as any).log?.error({ err: error }, "Cash expense receipt read failed");
    res.status(500).json({ error: "تعذّر قراءة صورة الإيصال" });
  }
});

router.get("/:id", async (req: any, res) => {
  const scope = await requestScope(req);
  if (!scope) { res.status(401).json({ error: "غير مصرح" }); return; }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف المصروف غير صالح" }); return; }
  const row = await selectExpense(db, id, scope.companyId);
  if (!row || !(await canReadExpense(scope, row, true))) { res.status(404).json({ error: "المصروف غير موجود" }); return; }
  res.json(toCashExpense(row, scope.userId));
});

router.patch("/:id", async (req: any, res) => {
  const scope = await requestScope(req);
  if (!scope) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (!hasRight(scope, "cash_expenses_edit")) { res.status(403).json({ error: "لا تملك صلاحية تعديل المصروفات" }); return; }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف المصروف غير صالح" }); return; }
  const parsed = UpdateCashExpenseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const input = parsed.data;
  const updateDate = input.date === undefined ? undefined : toDateString(input.date);
  if (input.date !== undefined && !updateDate) { res.status(400).json({ error: "التاريخ غير صالح" }); return; }
  if (input.amount !== undefined && !validAmount(input.amount)) { res.status(400).json({ error: "المبلغ يجب أن يكون موجباً وبحد أقصى منزلتين عشريتين" }); return; }
  if (input.description !== undefined && !input.description.trim()) { res.status(400).json({ error: "البيان مطلوب" }); return; }

  try {
    let previousReceiptPath: string | null = null;
    await db.transaction(async (tx) => {
      const [voucher] = await tx.select().from(paymentVouchersTable).where(and(
        eq(paymentVouchersTable.id, id),
        eq(paymentVouchersTable.companyId, scope.companyId),
        eq(paymentVouchersTable.sourceType, "cash_expense"),
      )).for("update");
      if (!voucher) throw Object.assign(new Error("المصروف غير موجود"), { status: 404 });
      if (voucher.status !== "draft") throw Object.assign(new Error("لا يمكن تعديل إلا المصروفات المسودة"), { status: 409 });
      const freshScope = await loadScope(scope.userId, scope.companyId, tx);
      if (!freshScope || !hasRight(freshScope, "cash_expenses_edit") || !freshScope.cashBoxIds.has(voucher.cashBoxId!)) {
        throw Object.assign(new Error("المصروف خارج نطاق الفروع والخزن المسموح بها"), { status: 403 });
      }
      const targetBoxId = input.cashBoxId ?? voucher.cashBoxId!;
      const [box] = await tx.select({
        id: cashBoxesTable.id,
        branchId: cashBoxesTable.branchId,
        currencyId: cashBoxesTable.currencyId,
        branchCompanyId: branchesTable.companyId,
        cashExpenseManagerUserId: cashBoxesTable.cashExpenseManagerUserId,
      }).from(cashBoxesTable)
        .leftJoin(branchesTable, eq(branchesTable.id, cashBoxesTable.branchId))
        .where(and(
          eq(cashBoxesTable.id, targetBoxId),
          eq(cashBoxesTable.companyId, scope.companyId),
          eq(cashBoxesTable.isActive, true),
        )).for("update");
      if (!box || !cashExpenseBoxAllowed(box, freshScope)) throw Object.assign(new Error("الخزنة غير متاحة لفروعك أو للمستخدم الحالي"), { status: 403 });
      const targetAccountId = input.expenseAccountId ?? voucher.accountId;
      const [account] = await tx.select({ id: accountsTable.id }).from(accountsTable).where(and(
        eq(accountsTable.id, targetAccountId!),
        eq(accountsTable.companyId, scope.companyId),
        eq(accountsTable.accountType, "expense"),
        eq(accountsTable.isPosting, true),
        eq(accountsTable.isActive, true),
      )).limit(1);
      if (!account) throw Object.assign(new Error("اختر حساب مصروف نشطاً وقابلاً للترحيل من الشركة"), { status: 400 });

      let receiptPath = voucher.cashExpenseReceiptPath ?? null;
      if (Object.prototype.hasOwnProperty.call(input, "receiptPath")) {
        receiptPath = input.receiptPath ?? null;
        if (receiptPath && receiptPath !== voucher.cashExpenseReceiptPath) await assertAllowedReceiptPath(receiptPath, freshScope);
      }
      if (receiptPath !== voucher.cashExpenseReceiptPath) previousReceiptPath = voucher.cashExpenseReceiptPath ?? null;
      await tx.update(paymentVouchersTable).set({
        date: updateDate ?? voucher.date,
        branchId: box.branchId ?? null,
        cashBoxId: box.id,
        currencyId: box.currencyId ?? null,
        accountId: account.id,
        amount: (input.amount ?? Number(voucher.amount)).toFixed(2),
        description: input.description?.trim() ?? voucher.description,
        cashExpenseReceiptPath: receiptPath,
      }).where(and(
        eq(paymentVouchersTable.id, id),
        eq(paymentVouchersTable.companyId, scope.companyId),
        eq(paymentVouchersTable.status, "draft"),
      ));
      await tx.update(paymentVoucherLinesTable).set({
        accountId: account.id,
        amount: (input.amount ?? Number(voucher.amount)).toFixed(2),
        description: input.description?.trim() ?? voucher.description,
        branchId: box.branchId ?? null,
      }).where(eq(paymentVoucherLinesTable.voucherId, id));
    });
    await removeReceiptIfUnreferenced(previousReceiptPath, scope.companyId);
    const row = await selectExpense(db, id, scope.companyId);
    if (!row) { res.status(404).json({ error: "المصروف غير موجود" }); return; }
    res.json(toCashExpense(row, scope.userId));
  } catch (error: any) {
    res.status(error?.status ?? 400).json({ error: error?.message ?? "تعذّر تعديل المصروف" });
  }
});

router.post("/:id/post", async (req: any, res) => {
  const scope = await requestScope(req);
  if (!scope) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (!hasRight(scope, "cash_expenses_post")) { res.status(403).json({ error: "لا تملك صلاحية ترحيل المصروف" }); return; }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف المصروف غير صالح" }); return; }
  try {
    await db.transaction(async (tx) => {
      const [voucher] = await tx.select().from(paymentVouchersTable).where(and(
        eq(paymentVouchersTable.id, id),
        eq(paymentVouchersTable.companyId, scope.companyId),
        eq(paymentVouchersTable.sourceType, "cash_expense"),
      )).for("update");
      if (!voucher) throw Object.assign(new Error("المصروف غير موجود"), { status: 404 });
      const freshScope = await loadScope(scope.userId, scope.companyId, tx);
      if (!freshScope || !hasRight(freshScope, "cash_expenses_post") || !freshScope.cashBoxIds.has(voucher.cashBoxId!)) {
        throw Object.assign(new Error("المصروف خارج نطاق الفروع والخزن المسموح بها"), { status: 403 });
      }
      if (voucher.status === "posted") return;
      if (voucher.status !== "draft") throw Object.assign(new Error("لا يمكن ترحيل إلا المصروفات المسودة"), { status: 409 });
      const lines = await tx.select().from(paymentVoucherLinesTable).where(eq(paymentVoucherLinesTable.voucherId, id));
      if (lines.length !== 1 || lines[0].opType !== "direct" || lines[0].purchaseInvoiceId != null ||
          lines[0].contractingKind != null || !lines[0].accountId) {
        throw Object.assign(new Error("بيانات المصروف لا تطابق مسار الترحيل الآمن"), { status: 409 });
      }
      const journalEntryId = await buildPaymentJournal(scope.companyId, voucher, req, tx);
      await tx.update(paymentVouchersTable).set({ status: "posted", journalEntryId })
        .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.companyId, scope.companyId), eq(paymentVouchersTable.status, "draft")));
    });
    const row = await selectExpense(db, id, scope.companyId);
    if (!row) { res.status(404).json({ error: "المصروف غير موجود" }); return; }
    res.json(toCashExpense(row, scope.userId));
  } catch (error: any) {
    (req as any).log?.error({ err: error }, "Cash expense posting failed");
    res.status(error?.status ?? 400).json({ error: error?.message ?? "تعذّر ترحيل المصروف" });
  }
});

router.post("/:id/cancel", async (req: any, res) => {
  const scope = await requestScope(req);
  if (!scope) { res.status(401).json({ error: "غير مصرح" }); return; }
  if (!hasRight(scope, "cash_expenses_cancel")) { res.status(403).json({ error: "لا تملك صلاحية إلغاء المصروف" }); return; }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف المصروف غير صالح" }); return; }
  try {
    await db.transaction(async (tx) => {
      const [voucher] = await tx.select().from(paymentVouchersTable).where(and(
        eq(paymentVouchersTable.id, id),
        eq(paymentVouchersTable.companyId, scope.companyId),
        eq(paymentVouchersTable.sourceType, "cash_expense"),
      )).for("update");
      if (!voucher) throw Object.assign(new Error("المصروف غير موجود"), { status: 404 });
      if (voucher.status === "cancelled") return;
      const freshScope = await loadScope(scope.userId, scope.companyId, tx);
      if (!freshScope || !hasRight(freshScope, "cash_expenses_cancel") || !freshScope.cashBoxIds.has(voucher.cashBoxId!)) {
        throw Object.assign(new Error("المصروف خارج نطاق الفروع والخزن المسموح بها"), { status: 403 });
      }
      if (voucher.status === "posted") {
        const lines = await tx.select().from(paymentVoucherLinesTable).where(eq(paymentVoucherLinesTable.voucherId, id));
        if (lines.length !== 1 || lines[0].opType !== "direct" || lines[0].purchaseInvoiceId != null ||
            lines[0].contractingKind != null) {
          throw Object.assign(new Error("لا يمكن إلغاء هذا المصروف عبر مسار الترحيل الأصلي"), { status: 409 });
        }
        const settlements = await tx.select({ id: settlementLinksTable.id }).from(settlementLinksTable).where(and(
          eq(settlementLinksTable.companyId, scope.companyId),
          eq(settlementLinksTable.sourceType, "payment_voucher"),
          eq(settlementLinksTable.sourceId, id),
        )).limit(1);
        if (settlements.length) throw Object.assign(new Error("لا يمكن إلغاء المصروف بعد ربطه بتسوية"), { status: 409 });
        if (!voucher.journalEntryId) throw Object.assign(new Error("المصروف المرحّل لا يحتوي على قيد مرتبط"), { status: 409 });
        const linkedEntry = await getLinkedSourceJournalEntry(tx, scope.companyId, voucher.journalEntryId, "payment");
        const retainJournal = !!voucher.isSequenceProtected || !!linkedEntry?.isSequenceProtected;
        if (retainJournal) {
          await draftLinkedSourceJournalEntry(tx, scope.companyId, voucher.journalEntryId, "payment");
        } else {
          await tx.delete(journalEntriesTable).where(and(
            eq(journalEntriesTable.id, voucher.journalEntryId),
            eq(journalEntriesTable.companyId, scope.companyId),
          ));
        }
        await tx.update(paymentVouchersTable).set({
          status: "cancelled",
          cashExpenseCancelledByUserId: scope.userId,
          cashExpenseCancelledAt: new Date(),
          ...(retainJournal ? {} : { journalEntryId: null }),
        }).where(eq(paymentVouchersTable.id, id));
        return;
      }
      if (voucher.status !== "draft") throw Object.assign(new Error("حالة المصروف لا تسمح بالإلغاء"), { status: 409 });
      await tx.update(paymentVouchersTable).set({
        status: "cancelled",
        cashExpenseCancelledByUserId: scope.userId,
        cashExpenseCancelledAt: new Date(),
      }).where(eq(paymentVouchersTable.id, id));
    });
    const row = await selectExpense(db, id, scope.companyId);
    if (!row) { res.status(404).json({ error: "المصروف غير موجود" }); return; }
    res.json(toCashExpense(row, scope.userId));
  } catch (error: any) {
    (req as any).log?.error({ err: error }, "Cash expense cancellation failed");
    res.status(error?.status ?? 409).json({ error: error?.message ?? "تعذّر إلغاء المصروف" });
  }
});

export default router;
