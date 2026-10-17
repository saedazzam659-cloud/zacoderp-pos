import { Router } from "express";
import { requirePostRight, requireUnpostRight } from "../lib/postingRights.js";
import { db } from "@workspace/db";
import { cashTransfersTable, cashBoxesTable, bankAccountsTable, receiptVouchersTable, paymentVouchersTable } from "@workspace/db";
import { eq, desc, and, sql, or, isNull, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, getAllowedBranchIds } from "../middleware/auth.js";
import { nextSequenceOrFallback } from "../lib/sequences.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { documentMutationLock } from "../lib/document-mutation-lock.js";
import { createJournalEntry } from "./sales.js";
import { mobilePermAllowed } from "../lib/mobilePerms.js";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";

const router = Router();
const objectStorage = new ObjectStorageService();
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
router.use(extractAuth);
router.use(requireModulePermission("cash_boxes"));
router.use(moduleAudit("cash_boxes"));

function mobilePermission(req: any, key: string): boolean {
  return req.authUser?.sessionChannel !== "mobile" || mobilePermAllowed(req.authUser, key);
}

function transferSide(type: string, from: any, to: any) {
  const valid = type === "cash_to_cash" ? !!from.cash && !!to.cash
    : type === "cash_to_bank" ? !!from.cash && !!to.bank
    : type === "bank_to_cash" ? !!from.bank && !!to.cash
    : type === "bank_to_bank" ? !!from.bank && !!to.bank : false;
  return valid;
}

async function canAccessTransferBranch(req: any, transfer: { companyId: number; fromCashBoxId: number | null }): Promise<boolean> {
  if (req.authUser?.sessionChannel !== "mobile") return true;
  const allowed = getAllowedBranchIds(req);
  if (allowed === null) return true;
  if (!transfer.fromCashBoxId) return false;
  const [box] = await db.select({ branchId: cashBoxesTable.branchId }).from(cashBoxesTable)
    .where(and(eq(cashBoxesTable.id, transfer.fromCashBoxId), eq(cashBoxesTable.companyId, transfer.companyId))).limit(1);
  return !!box && (box.branchId == null || allowed.includes(box.branchId));
}

router.get("/", async (req, res) => {
  const auth: any = (req as any).authUser;
  const mobile = auth?.sessionChannel === "mobile";
  const canAll = mobilePermission(req, "cash_transfers_view_all");
  const canOwn = mobilePermission(req, "cash_transfers_view_own");
  if (mobile && !canAll && !canOwn) {
    res.status(403).json({ error: "لا تملك صلاحية عرض التحويلات" }); return;
  }
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  const where = cid ? [eq(cashTransfersTable.companyId, cid)] : [];
  if (mobile) {
    where.push(eq(cashTransfersTable.companyId, Number(auth.companyId)));
    const allowedBranches = getAllowedBranchIds(req);
    const boxScope = allowedBranches === null ? undefined
      : allowedBranches.length ? or(isNull(cashBoxesTable.branchId), inArray(cashBoxesTable.branchId, allowedBranches)) : sql`false`;
    const boxes = await db.select({ id: cashBoxesTable.id }).from(cashBoxesTable)
      .where(and(eq(cashBoxesTable.companyId, Number(auth.companyId)), ...(boxScope ? [boxScope] : [])));
    if (!boxes.length) { res.json([]); return; }
    where.push(inArray(cashTransfersTable.fromCashBoxId, boxes.map((box) => box.id)));
    if (!canAll) {
      const review = mobilePermission(req, "cash_transfers_approve") || mobilePermission(req, "cash_transfers_reject");
      const personal = canOwn ? eq(cashTransfersTable.createdByUserId, Number(auth.id)) : sql`false`;
      where.push(review ? (or(personal, eq(cashTransfersTable.approvalStatus, "pending")) ?? sql`false`) : personal);
    }
  }
  const rows = where.length
    ? await db.select().from(cashTransfersTable).where(and(...where)).orderBy(desc(cashTransfersTable.createdAt)).limit(200)
    : await db.select().from(cashTransfersTable).orderBy(desc(cashTransfersTable.createdAt)).limit(200);
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  const cid = resolveCompanyId(req);
  if (!cid) { res.status(400).json({ error: "الشركة غير محددة" }); return; }
  const [row] = await db.select().from(cashTransfersTable)
    .where(and(eq(cashTransfersTable.id, parseInt(req.params.id)), eq(cashTransfersTable.companyId, cid)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!(await canAccessTransferBranch(req, row))) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.post("/", async (req, res) => {
  if (!mobilePermission(req, "cash_transfers_create")) { res.status(403).json({ error: "لا تملك صلاحية إنشاء التحويلات" }); return; }
  const d = req.body;
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const mobile = (req as any).authUser?.sessionChannel === "mobile";
  const amount = Number(d.amount);
  let source: any = null;
  let targetId = 0;
  if (mobile) {
    const sourceId = Number(d.fromCashBoxId);
    targetId = Number(d.transferType === "cash_to_cash" ? d.toCashBoxId : d.toBankId);
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || !Number.isSafeInteger(targetId) || targetId <= 0 ||
        !Number.isFinite(amount) || amount <= 0 || !["cash_to_cash", "cash_to_bank"].includes(d.transferType) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date ?? ""))) {
      res.status(400).json({ error: "بيانات الإيداع غير صالحة" }); return;
    }
    [source] = await db.select().from(cashBoxesTable).where(and(eq(cashBoxesTable.id, sourceId), eq(cashBoxesTable.companyId, cid), eq(cashBoxesTable.isActive, true))).limit(1);
    const target = d.transferType === "cash_to_cash"
      ? (await db.select().from(cashBoxesTable).where(and(eq(cashBoxesTable.id, targetId), eq(cashBoxesTable.companyId, cid), eq(cashBoxesTable.isActive, true))).limit(1))[0]
      : (await db.select().from(bankAccountsTable).where(and(eq(bankAccountsTable.id, targetId), eq(bankAccountsTable.companyId, cid), eq(bankAccountsTable.isActive, true))).limit(1))[0];
    if (!source || !target || source.currencyId !== target.currencyId ||
        (d.transferType === "cash_to_cash" && source.id === target.id)) {
      res.status(400).json({ error: "الصندوق أو الوجهة غير صالحة أو عملتهما مختلفة" }); return;
    }
    const allowedBranches = getAllowedBranchIds(req);
    if (allowedBranches !== null && source.branchId != null && !allowedBranches.includes(source.branchId)) {
      res.status(403).json({ error: "الصندوق خارج نطاق فروعك" }); return;
    }
    const targetBranches: number[] = d.transferType === "cash_to_bank"
      ? ((target as any).branchIds ?? (target.branchId == null ? [] : [target.branchId]))
      : (target.branchId == null ? [] : [target.branchId]);
    if (allowedBranches !== null && targetBranches.length && !targetBranches.some((branchId) => allowedBranches.includes(branchId))) {
      res.status(403).json({ error: "وجهة الإيداع خارج نطاق فروعك" }); return;
    }
  }
  const userId = Number((req as any).authUser?.id);
  if (d.receiptPath && d.receiptPath !== `/objects/cash-transfers/${cid}/${userId}/${String(d.receiptPath).split("/").pop()}`) {
    res.status(400).json({ error: "مسار الإيصال غير صالح" }); return;
  }

  const code = d.code || await nextSequenceOrFallback(
    cid,
    "cash_transfer",
    { userId: (req as any).authUser?.id ?? null, refTable: "cash_transfers" },
    async () => {
      const existing = await db.select({ id: cashTransfersTable.id })
        .from(cashTransfersTable).where(eq(cashTransfersTable.companyId, cid));
      return `TR-${String(existing.length + 1).padStart(4, "0")}`;
    },
  );

  const [row] = await db.insert(cashTransfersTable).values({
    companyId:     cid,
    code,
    date:          d.date          || new Date().toISOString().slice(0, 10),
    transferType:  d.transferType || "cash_to_bank",
    fromCashBoxId: mobile ? Number(d.fromCashBoxId) : d.fromCashBoxId ? parseInt(d.fromCashBoxId) : null,
    fromBankId:    mobile ? null : d.fromBankId ? parseInt(d.fromBankId) : null,
    toCashBoxId:   mobile ? (d.transferType === "cash_to_cash" ? targetId : null) : d.toCashBoxId ? parseInt(d.toCashBoxId) : null,
    toBankId:      mobile ? (d.transferType === "cash_to_bank" ? targetId : null) : d.toBankId ? parseInt(d.toBankId) : null,
    amount:        mobile ? amount.toFixed(2) : d.amount,
    currencyId:    mobile ? source.currencyId : d.currencyId ? parseInt(d.currencyId) : null,
    exchangeRate:  d.exchangeRate  || "1",
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
    referenceNumber: d.referenceNumber ?? null,
    receiptPath: d.receiptPath ?? null,
    createdByUserId: (req as any).authUser?.id ?? null,
    branchId: mobile ? source.branchId : d.branchId ? parseInt(d.branchId) : null,
    status:        "draft",
  }).returning();
  res.status(201).json(row);
});

router.post("/receipt-upload", async (req: any, res) => {
  if (!mobilePermission(req, "cash_transfers_create")) { res.status(403).json({ error: "لا تملك صلاحية إرفاق إيصال" }); return; }
  const { mimeType, base64 } = req.body ?? {};
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType) ||
      typeof base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    res.status(400).json({ error: "صورة الإيصال غير صالحة" }); return;
  }
  const bytes = Buffer.from(base64, "base64");
  const valid = mimeType === "image/jpeg" ? bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mimeType === "image/png" ? bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid || bytes.length > MAX_RECEIPT_BYTES) { res.status(413).json({ error: "الإيصال صورة JPEG أو PNG أو WebP بحد أقصى 5 ميجابايت" }); return; }
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "webp";
  const key = `cash-transfers/${req.authUser.companyId}/${req.authUser.id}/${randomUUID()}.${ext}`;
  try {
    const stream = objectStorage.getPrivateObjectFile(key).createWriteStream({ metadata: { contentType: mimeType, cacheControl: "private, no-store" } });
    stream.end(bytes);
    await once(stream, "finish");
    res.status(201).json({ objectPath: `/objects/${key}` });
  } catch (error) {
    req.log?.error({ err: error }, "Cash transfer receipt upload failed");
    res.status(500).json({ error: "تعذّر حفظ صورة الإيصال" });
  }
});

router.post("/:id/submit", async (req: any, res) => {
  if (!mobilePermission(req, "cash_transfers_submit")) { res.status(403).json({ error: "لا تملك صلاحية إرسال الإيداع للاعتماد" }); return; }
  const id = Number(req.params.id);
  const [row] = await db.select().from(cashTransfersTable).where(and(eq(cashTransfersTable.id, id), eq(cashTransfersTable.companyId, req.authUser.companyId))).limit(1);
  if (!row || row.createdByUserId !== req.authUser.id || !(await canAccessTransferBranch(req, row))) { res.status(404).json({ error: "الإيداع غير موجود" }); return; }
  if (row.status !== "draft" || row.approvalStatus === "pending") { res.status(409).json({ error: "لا يمكن إرسال هذه المسودة" }); return; }
  const [updated] = await db.update(cashTransfersTable).set({ approvalStatus: "pending", rejectionReason: null })
    .where(and(eq(cashTransfersTable.id, id), eq(cashTransfersTable.companyId, req.authUser.companyId), eq(cashTransfersTable.status, "draft"))).returning();
  res.json(updated);
});

router.post("/:id/reject", documentMutationLock("cash_transfer", async (req: any, res) => {
  if (!mobilePermission(req, "cash_transfers_reject")) { res.status(403).json({ error: "لا تملك صلاحية رفض الإيداع" }); return; }
  const id = Number(req.params.id);
  const reason = String(req.body?.reason ?? "").trim();
  if (reason.length < 3) { res.status(400).json({ error: "سبب الرفض مطلوب" }); return; }
  const [row] = await db.select().from(cashTransfersTable).where(and(eq(cashTransfersTable.id, id), eq(cashTransfersTable.companyId, req.authUser.companyId))).limit(1);
  if (!row || row.approvalStatus !== "pending" || row.createdByUserId === req.authUser.id || !(await canAccessTransferBranch(req, row))) { res.status(404).json({ error: "طلب الاعتماد غير متاح" }); return; }
  const [updated] = await db.update(cashTransfersTable).set({ approvalStatus: "rejected", rejectedByUserId: req.authUser.id, rejectionReason: reason })
    .where(and(eq(cashTransfersTable.id, id), eq(cashTransfersTable.companyId, req.authUser.companyId), eq(cashTransfersTable.approvalStatus, "pending"))).returning();
  res.json(updated);
}));

router.get("/:id/receipt", async (req: any, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(cashTransfersTable)
    .where(and(eq(cashTransfersTable.id, id), eq(cashTransfersTable.companyId, req.authUser?.companyId))).limit(1);
  const canView = mobilePermission(req, "cash_transfers_view_all") ||
    (mobilePermission(req, "cash_transfers_view_own") && row?.createdByUserId === req.authUser?.id);
  if (!row || !row.receiptPath || !canView || !(await canAccessTransferBranch(req, row))) { res.status(404).json({ error: "الإيصال غير موجود" }); return; }
  try {
    const file = await objectStorage.getObjectEntityFile(row.receiptPath);
    const result = await objectStorage.downloadObject(file);
    if (result.status !== 200 || !result.body) { res.status(404).json({ error: "ملف الإيصال غير موجود" }); return; }
    result.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("Cache-Control", "private, no-store");
    Readable.fromWeb(result.body as any).pipe(res);
  } catch { res.status(404).json({ error: "ملف الإيصال غير موجود" }); }
});

router.put("/:id", async (req, res) => {
  if (!mobilePermission(req, "cash_transfers_edit")) { res.status(403).json({ error: "لا تملك صلاحية تعديل المسودات" }); return; }
  const d = req.body;
  const id = parseInt(req.params.id);
  const cid = resolveCompanyId(req);
  if (!cid) { res.status(400).json({ error: "الشركة غير محددة" }); return; }
  const [existing] = await db.select().from(cashTransfersTable)
    .where(and(eq(cashTransfersTable.id, id), eq(cashTransfersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if ((req as any).authUser?.sessionChannel === "mobile" &&
      (existing.createdByUserId !== (req as any).authUser?.id || existing.status !== "draft")) {
    res.status(403).json({ error: "يمكنك تعديل مسوداتك فقط" }); return;
  }
  if (!(await canAccessTransferBranch(req, existing))) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن تعديل تحويل مرحّل" }); return; }
  const mobile = (req as any).authUser?.sessionChannel === "mobile";
  let mobileSource: any = null;
  if (mobile) {
    const sourceId = Number(d.fromCashBoxId);
    const targetId = Number(d.transferType === "cash_to_cash" ? d.toCashBoxId : d.toBankId);
    const amount = Number(d.amount);
    if (!["cash_to_cash", "cash_to_bank"].includes(d.transferType) ||
        !Number.isSafeInteger(sourceId) || !Number.isSafeInteger(targetId) ||
        !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date ?? ""))) {
      res.status(400).json({ error: "بيانات الإيداع غير صالحة" }); return;
    }
    [mobileSource] = await db.select().from(cashBoxesTable)
      .where(and(eq(cashBoxesTable.id, sourceId), eq(cashBoxesTable.companyId, cid), eq(cashBoxesTable.isActive, true))).limit(1);
    const target = d.transferType === "cash_to_cash"
      ? (await db.select().from(cashBoxesTable).where(and(eq(cashBoxesTable.id, targetId), eq(cashBoxesTable.companyId, cid), eq(cashBoxesTable.isActive, true))).limit(1))[0]
      : (await db.select().from(bankAccountsTable).where(and(eq(bankAccountsTable.id, targetId), eq(bankAccountsTable.companyId, cid), eq(bankAccountsTable.isActive, true))).limit(1))[0];
    const allowed = getAllowedBranchIds(req);
    const targetBranches: number[] = d.transferType === "cash_to_bank"
      ? ((target as any)?.branchIds ?? (target?.branchId == null ? [] : [target.branchId]))
      : (target?.branchId == null ? [] : [target.branchId]);
    if (!mobileSource || !target || mobileSource.currencyId !== target.currencyId ||
        (d.transferType === "cash_to_cash" && mobileSource.id === target.id) ||
        (allowed !== null && mobileSource.branchId != null && !allowed.includes(mobileSource.branchId)) ||
        (allowed !== null && targetBranches.length > 0 && !targetBranches.some((branchId) => allowed.includes(branchId)))) {
      res.status(403).json({ error: "الصندوق أو الوجهة خارج النطاق المسموح أو غير صالحة" }); return;
    }
    const expectedPrefix = `/objects/cash-transfers/${cid}/${(req as any).authUser.id}/`;
    if (d.receiptPath && !String(d.receiptPath).startsWith(expectedPrefix)) {
      res.status(400).json({ error: "مسار الإيصال غير صالح" }); return;
    }
  }

  const [row] = await db.update(cashTransfersTable).set({
    date:          d.date,
    transferType:  d.transferType,
    fromCashBoxId: d.fromCashBoxId ? parseInt(d.fromCashBoxId) : null,
    fromBankId:    d.fromBankId    ? parseInt(d.fromBankId)    : null,
    toCashBoxId:   d.toCashBoxId   ? parseInt(d.toCashBoxId)   : null,
    toBankId:      d.toBankId      ? parseInt(d.toBankId)      : null,
    amount:        d.amount,
    currencyId:    mobile ? mobileSource.currencyId : d.currencyId ? parseInt(d.currencyId) : existing.currencyId,
    exchangeRate:  d.exchangeRate  || "1",
    description:   d.description   ?? null,
    notes:         d.notes         ?? null,
    referenceNumber: d.referenceNumber ?? null,
    receiptPath: d.receiptPath ?? null,
    branchId: mobile ? mobileSource.branchId : (d.branchId ? parseInt(d.branchId) : existing.branchId),
  }).where(and(eq(cashTransfersTable.id, id), eq(cashTransfersTable.companyId, cid))).returning();
  res.json(row);
});

router.post("/:id/post", requirePostRight("cashTransfer"), documentMutationLock("cash_transfer", async (req, res) => {
  if (!mobilePermission(req, "cash_transfers_approve")) { res.status(403).json({ error: "لا تملك صلاحية اعتماد الإيداع" }); return; }
  const id = parseInt(String(req.params.id), 10);
  const cid = resolveCompanyId(req);
  if (!cid) { res.status(400).json({ error: "الشركة غير محددة" }); return; }
  const [existing] = await db.select().from(cashTransfersTable)
    .where(and(eq(cashTransfersTable.id, id), eq(cashTransfersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!(await canAccessTransferBranch(req, existing))) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "مرحّل مسبقاً" }); return; }
  if (existing.status === "cancelled") { res.status(400).json({ error: "لا يمكن ترحيل تحويل ملغى" }); return; }
  if ((req as any).authUser?.sessionChannel === "mobile" &&
      (existing.approvalStatus !== "pending" || existing.createdByUserId === (req as any).authUser?.id)) {
    res.status(403).json({ error: "لا يمكن اعتماد طلبك أو طلب غير مرسل للاعتماد" }); return;
  }
  if (!existing.amount || parseFloat(existing.amount) <= 0) {
    res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر" }); return;
  }
  const row = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(cashTransfersTable)
      .where(and(eq(cashTransfersTable.id, id), eq(cashTransfersTable.companyId, existing.companyId)))
      .for("update");
    if (!locked || locked.status === "posted" || locked.journalEntryId) {
      throw Object.assign(new Error("تم ترحيل التحويل مسبقاً"), { status: 409 });
    }
    const from = locked.fromCashBoxId
      ? (await tx.select({ id: cashBoxesTable.id, accountId: cashBoxesTable.accountId, branchId: cashBoxesTable.branchId, currencyId: cashBoxesTable.currencyId }).from(cashBoxesTable)
          .where(and(eq(cashBoxesTable.id, locked.fromCashBoxId), eq(cashBoxesTable.companyId, locked.companyId), eq(cashBoxesTable.isActive, true))).limit(1))[0]
      : (locked.fromBankId ? (await tx.select({ id: bankAccountsTable.id, accountId: bankAccountsTable.accountId, branchId: bankAccountsTable.branchId, currencyId: bankAccountsTable.currencyId }).from(bankAccountsTable)
          .where(and(eq(bankAccountsTable.id, locked.fromBankId), eq(bankAccountsTable.companyId, locked.companyId), eq(bankAccountsTable.isActive, true))).limit(1))[0] : null);
    const to = locked.toCashBoxId
      ? (await tx.select({ id: cashBoxesTable.id, accountId: cashBoxesTable.accountId, branchId: cashBoxesTable.branchId, currencyId: cashBoxesTable.currencyId }).from(cashBoxesTable)
          .where(and(eq(cashBoxesTable.id, locked.toCashBoxId), eq(cashBoxesTable.companyId, locked.companyId), eq(cashBoxesTable.isActive, true))).limit(1))[0]
      : (locked.toBankId ? (await tx.select({ id: bankAccountsTable.id, accountId: bankAccountsTable.accountId, branchId: bankAccountsTable.branchId, currencyId: bankAccountsTable.currencyId }).from(bankAccountsTable)
          .where(and(eq(bankAccountsTable.id, locked.toBankId), eq(bankAccountsTable.companyId, locked.companyId), eq(bankAccountsTable.isActive, true))).limit(1))[0] : null);
    const fromCash = !!locked.fromCashBoxId;
    const toCash = !!locked.toCashBoxId;
    if (!from || !to || !transferSide(locked.transferType, { cash: fromCash, bank: !fromCash }, { cash: toCash, bank: !toCash })) {
      throw Object.assign(new Error("مصدر أو وجهة التحويل غير صالحة"), { status: 400 });
    }
    const isMobile = (req as any).authUser?.sessionChannel === "mobile";
    if ((isMobile && from.currencyId !== to.currencyId) || (fromCash && toCash && from.id === to.id)) {
      throw Object.assign(new Error("لا يمكن ترحيل تحويل بعملتين مختلفتين من الموبايل أو إلى الصندوق نفسه"), { status: 400 });
    }
    if ((req as any).authUser?.sessionChannel === "mobile" &&
        (locked.approvalStatus !== "pending" || locked.createdByUserId === (req as any).authUser?.id)) {
      throw Object.assign(new Error("لا يمكن اعتماد طلبك أو طلب غير مرسل للاعتماد"), { status: 403 });
    }
    if (!from.accountId || !to.accountId) throw Object.assign(new Error("يجب ربط الصندوق أو الحساب البنكي بحساب محاسبي"), { status: 400 });
    const exchangeRate = Number(locked.exchangeRate || 1);
    const postingAmount = Number(locked.amount) * exchangeRate;
    if (!Number.isFinite(postingAmount) || postingAmount <= 0) {
      throw Object.assign(new Error("سعر الصرف أو مبلغ التحويل غير صالح"), { status: 400 });
    }
    if (fromCash) {
      // Serialize competing withdrawals from the same cashbox before
      // recalculating its posted balance.
      await tx.execute(sql`SELECT id FROM cash_boxes WHERE id = ${from.id} FOR UPDATE`);
      const [received] = await tx.select({ total: sql<string>`coalesce(sum(${receiptVouchersTable.amount}),0)` }).from(receiptVouchersTable)
        .where(and(eq(receiptVouchersTable.companyId, locked.companyId), eq(receiptVouchersTable.cashBoxId, from.id), eq(receiptVouchersTable.status, "posted")));
      const [paid] = await tx.select({ total: sql<string>`coalesce(sum(${paymentVouchersTable.amount}),0)` }).from(paymentVouchersTable)
        .where(and(eq(paymentVouchersTable.companyId, locked.companyId), eq(paymentVouchersTable.cashBoxId, from.id), eq(paymentVouchersTable.status, "posted")));
      const [incoming] = await tx.select({ total: sql<string>`coalesce(sum(${cashTransfersTable.amount}),0)` }).from(cashTransfersTable)
        .where(and(eq(cashTransfersTable.companyId, locked.companyId), eq(cashTransfersTable.toCashBoxId, from.id), eq(cashTransfersTable.status, "posted")));
      const [outgoing] = await tx.select({ total: sql<string>`coalesce(sum(${cashTransfersTable.amount}),0)` }).from(cashTransfersTable)
        .where(and(eq(cashTransfersTable.companyId, locked.companyId), eq(cashTransfersTable.fromCashBoxId, from.id), eq(cashTransfersTable.status, "posted")));
      const balance = Number(received?.total ?? 0) - Number(paid?.total ?? 0) + Number(incoming?.total ?? 0) - Number(outgoing?.total ?? 0);
      if (Number(locked.amount) > balance) throw Object.assign(new Error(`الرصيد المتاح بالصندوق ${balance.toFixed(2)} أقل من مبلغ التحويل`), { status: 409 });
    }
    const journalEntryId = await createJournalEntry({
      companyId: locked.companyId,
      branchId: from.branchId ?? to.branchId ?? null,
      date: locked.date,
      description: locked.description || `تحويل نقدي ${locked.code}`,
      docNumber: locked.code,
      entryType: "cash_transfer",
      postingDocType: "cashTransfer",
      sourceType: "cash_transfer",
      sourceId: locked.id,
      audit: { req },
      executor: tx,
      lines: [
        { accountId: to.accountId, debit: postingAmount, description: locked.description },
        { accountId: from.accountId, credit: postingAmount, description: locked.description },
      ],
    });
    const [updated] = await tx.update(cashTransfersTable)
      .set({ status: "posted", approvalStatus: "approved", journalEntryId, approvedByUserId: (req as any).authUser?.id ?? null })
      .where(and(eq(cashTransfersTable.id, id), eq(cashTransfersTable.companyId, cid),
        eq(cashTransfersTable.status, "draft"),
        ...((req as any).authUser?.sessionChannel === "mobile" ? [eq(cashTransfersTable.approvalStatus, "pending")] : []))).returning();
    return updated;
  });
  res.json(row);
}));

router.delete("/:id", async (req, res) => {
  const cid = resolveCompanyId(req);
  if (!cid) { res.status(400).json({ error: "الشركة غير محددة" }); return; }
  const [existing] = await db.select().from(cashTransfersTable)
    .where(and(eq(cashTransfersTable.id, parseInt(req.params.id)), eq(cashTransfersTable.companyId, cid)));
  if ((req as any).authUser?.sessionChannel === "mobile" &&
      (!mobilePermission(req, "cash_transfers_edit") || existing?.createdByUserId !== (req as any).authUser?.id)) {
    res.status(403).json({ error: "لا تملك صلاحية حذف هذه المسودة" }); return;
  }
  if (existing?.status === "posted") { res.status(400).json({ error: "لا يمكن حذف تحويل مرحّل" }); return; }
  await db.delete(cashTransfersTable).where(and(eq(cashTransfersTable.id, parseInt(req.params.id)), eq(cashTransfersTable.companyId, cid)));
  res.status(204).send();
});

export default router;
