import { Router } from "express";
import { db } from "@workspace/db";
import { bankAccountsTable, branchesTable, receiptVouchersTable, paymentVouchersTable } from "@workspace/db";
import { eq, and, sql, or, isNull, inArray, arrayOverlaps } from "drizzle-orm";
import { extractAuth, resolveCompanyId, getAllowedBranchIds } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { ensureBankAccountLedger } from "../lib/entityAccounts.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("bank_accounts"));
router.use(moduleAudit("bank_accounts"));

/**
 * Branch-scope filter for bank accounts. A bank account may now be linked to
 * multiple branches via `branchIds` (int[]). The legacy single `branchId` is
 * kept and mirrored to `branchIds[0]` for back-compat with cash-analytics.
 *
 * Visibility rule for a restricted user:
 *   - rows with `branchIds IS NULL` AND `branchId IS NULL`  → shared / HQ → visible
 *   - rows where any of `branchIds` overlaps the user's allowed list → visible
 *   - legacy rows (branchIds IS NULL) where `branchId` is in allowed → visible
 */
function branchOrNullScope(req: any): any {
  const allowed = getAllowedBranchIds(req);
  if (allowed === null) return undefined;
  if (allowed.length === 0) return sql`false`;
  return or(
    and(isNull(bankAccountsTable.branchIds), isNull(bankAccountsTable.branchId)),
    arrayOverlaps(bankAccountsTable.branchIds, allowed),
    and(isNull(bankAccountsTable.branchIds), inArray(bankAccountsTable.branchId, allowed)),
  );
}

/**
 * Multi-branch scope for bank accounts. Honours an explicit `?branchIds=1,2`
 * query param (intersected with the user's allowed list) and falls back to
 * the legacy `branchOrNullScope` when no explicit list is supplied.
 */
function multiBranchOrNullScope(req: any, requestedRaw: unknown): any {
  const requested: number[] = [];
  const push = (v: unknown) => {
    if (v === undefined || v === null) return;
    const s = String(v).trim();
    if (s === "" || s.toLowerCase() === "all") return;
    for (const part of s.split(",")) {
      const n = Number(part.trim());
      if (Number.isFinite(n) && n > 0) requested.push(n);
    }
  };
  if (Array.isArray(requestedRaw)) requestedRaw.forEach(push);
  else push(requestedRaw);

  if (requested.length === 0) return branchOrNullScope(req);

  const allowed = getAllowedBranchIds(req);
  const intersected = allowed === null
    ? Array.from(new Set(requested))
    : Array.from(new Set(requested.filter(id => allowed.includes(id))));
  if (intersected.length === 0) return sql`false`;
  return or(
    and(isNull(bankAccountsTable.branchIds), isNull(bankAccountsTable.branchId)),
    arrayOverlaps(bankAccountsTable.branchIds, intersected),
    and(isNull(bankAccountsTable.branchIds), inArray(bankAccountsTable.branchId, intersected)),
  );
}

// Validate that every id in `ids` belongs to the same company. Returns a
// list of invalid ids (empty when all good).
async function invalidBranchIds(cid: number, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: branchesTable.id })
    .from(branchesTable)
    .where(and(eq(branchesTable.companyId, cid), inArray(branchesTable.id, ids)));
  const ok = new Set(rows.map(r => r.id));
  return ids.filter(i => !ok.has(i));
}

// Normalise branchIds payload from the client into a clean int[] (or null).
function normaliseBranchIds(raw: any): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out.length ? out : null;
}

router.get("/", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  const branchCond = multiBranchOrNullScope(req, req.query.branchIds ?? req.query.branchId);
  const conds: any[] = [];
  if (cid) conds.push(eq(bankAccountsTable.companyId, cid));
  if (branchCond) conds.push(branchCond);
  const rows = conds.length
    ? await db.select().from(bankAccountsTable).where(and(...conds))
    : await db.select().from(bankAccountsTable);
  res.json(rows);
});

router.get("/balances", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }

  const branchCond = branchOrNullScope(req);
  const banks = await db.select({ id: bankAccountsTable.id })
    .from(bankAccountsTable)
    .where(branchCond
      ? and(eq(bankAccountsTable.companyId, cid), branchCond)
      : eq(bankAccountsTable.companyId, cid));

  const [recv, paid] = await Promise.all([
    db.select({
      bankAccountId: receiptVouchersTable.bankAccountId,
      total: sql<string>`coalesce(sum(${receiptVouchersTable.amount}),0)`,
    }).from(receiptVouchersTable)
      .where(and(eq(receiptVouchersTable.companyId, cid), eq(receiptVouchersTable.status, "posted")))
      .groupBy(receiptVouchersTable.bankAccountId),

    db.select({
      bankAccountId: paymentVouchersTable.bankAccountId,
      total: sql<string>`coalesce(sum(${paymentVouchersTable.amount}),0)`,
    }).from(paymentVouchersTable)
      .where(and(eq(paymentVouchersTable.companyId, cid), eq(paymentVouchersTable.status, "posted")))
      .groupBy(paymentVouchersTable.bankAccountId),
  ]);

  const recvMap = Object.fromEntries(recv.map(r => [r.bankAccountId!, parseFloat(r.total)]));
  const paidMap = Object.fromEntries(paid.map(r => [r.bankAccountId!, parseFloat(r.total)]));

  res.json(banks.map(b => ({
    bankAccountId: b.id,
    balance: (recvMap[b.id] ?? 0) - (paidMap[b.id] ?? 0),
  })));
});

router.get("/:id", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  const id  = parseInt(req.params.id);
  // Tenant + branch isolation on individual fetch.
  const conds: any[] = [eq(bankAccountsTable.id, id)];
  if (cid) conds.push(eq(bankAccountsTable.companyId, cid));
  const branchCond = branchOrNullScope(req);
  if (branchCond) conds.push(branchCond);
  const [row] = await db.select().from(bankAccountsTable).where(and(...conds));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

// helpers — turn "" / undefined into null so optional fields don't crash pg
const toInt = (v: any) => (v === "" || v === null || v === undefined ? null : parseInt(v));
const toStr = (v: any) => (v === "" || v === null || v === undefined ? null : String(v).trim() || null);

async function nextBankAccountCode(cid: number): Promise<string> {
  const rows = await db.select({ code: bankAccountsTable.code })
    .from(bankAccountsTable).where(eq(bankAccountsTable.companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = /^BA-(\d+)$/i.exec(r.code ?? "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `BA-${String(max + 1).padStart(4, "0")}`;
}

router.post("/", async (req, res) => {
  const d = req.body;
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid)   { res.status(400).json({ error: "companyId مطلوب" }); return; }
  if (!d.nameAr) { res.status(400).json({ error: "الاسم مطلوب" }); return; }

  // Multi-branch payload. Accepts `branchIds: number[]` (preferred). For
  // back-compat, a single `branchId` is folded in when `branchIds` is absent.
  const branchIds = normaliseBranchIds(d.branchIds)
    ?? (toInt(d.branchId) != null ? [toInt(d.branchId) as number] : null);
  if (branchIds) {
    const bad = await invalidBranchIds(cid, branchIds);
    if (bad.length) {
      res.status(400).json({ error: `فرع غير صالح: ${bad.join(", ")}` });
      return;
    }
  }

  const existing = await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.companyId, cid));
  const code = (d.code && String(d.code).trim()) ? String(d.code).trim() : await nextBankAccountCode(cid);
  if (existing.some(b => b.code?.trim().toLowerCase() === code.toLowerCase())) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لحساب بنكي آخر` });
    return;
  }
  if (d.iban && existing.some(b => b.iban?.trim() === String(d.iban).trim())) {
    res.status(409).json({ error: "رقم IBAN مستخدم لحساب آخر" });
    return;
  }
  if (d.accountId && existing.some(b => b.accountId === parseInt(d.accountId))) {
    res.status(409).json({ error: "هذا الحساب مرتبط بحساب بنكي آخر — اختر حساباً آخر" });
    return;
  }

  // Auto-create a sub-account under the bank parent (from the Account
  // Mapping screen) when the user didn't explicitly pick one.
  let accountId: number | null = toInt(d.accountId);
  if (!accountId) {
    try {
      const label = [String(d.nameAr).trim(), toStr(d.bankName)].filter(Boolean).join(" — ");
      accountId = await ensureBankAccountLedger(cid, label || String(d.nameAr).trim());
    } catch (err) {
      req.log?.warn({ err }, "ensureBankAccountLedger failed");
      accountId = null;
    }
  }

  const [row] = await db.insert(bankAccountsTable).values({
    companyId:     cid,
    branchId:      branchIds?.[0] ?? null,
    branchIds:     branchIds,
    code,
    nameAr:        String(d.nameAr).trim(),
    nameEn:        toStr(d.nameEn),
    bankName:      toStr(d.bankName),
    bankNameEn:    toStr(d.bankNameEn),
    accountNumber: toStr(d.accountNumber),
    iban:          toStr(d.iban),
    swiftCode:     toStr(d.swiftCode),
    currencyId:    toInt(d.currencyId),
    accountId,
    isActive:      d.isActive ?? true,
    notes:         toStr(d.notes),
  }).returning();
  res.status(201).json(row);
});

router.put("/:id", async (req, res) => {
  const d = req.body;
  const id = parseInt(req.params.id);
  const [current] = await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.id, id));
  if (!current) { res.status(404).json({ error: "غير موجود" }); return; }

  const branchIds = normaliseBranchIds(d.branchIds)
    ?? (toInt(d.branchId) != null ? [toInt(d.branchId) as number] : null);
  if (branchIds) {
    const bad = await invalidBranchIds(current.companyId, branchIds);
    if (bad.length) {
      res.status(400).json({ error: `فرع غير صالح: ${bad.join(", ")}` });
      return;
    }
  }

  const others = await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.companyId, current.companyId));
  if (d.code && others.some(b => b.id !== id && b.code?.trim().toLowerCase() === String(d.code).trim().toLowerCase())) {
    res.status(409).json({ error: `الكود "${d.code}" مستخدم بالفعل لحساب بنكي آخر` });
    return;
  }
  if (d.iban && others.some(b => b.id !== id && b.iban?.trim() === String(d.iban).trim())) {
    res.status(409).json({ error: "رقم IBAN مستخدم لحساب آخر" });
    return;
  }
  if (d.accountId && others.some(b => b.id !== id && b.accountId === parseInt(d.accountId))) {
    res.status(409).json({ error: "هذا الحساب مرتبط بحساب بنكي آخر — اختر حساباً آخر" });
    return;
  }

  const [row] = await db.update(bankAccountsTable).set({
    branchId:      branchIds?.[0] ?? null,
    branchIds:     branchIds,
    code:          (d.code && String(d.code).trim()) ? String(d.code).trim() : current.code,
    nameAr:        String(d.nameAr ?? current.nameAr).trim(),
    nameEn:        toStr(d.nameEn),
    bankName:      toStr(d.bankName),
    bankNameEn:    toStr(d.bankNameEn),
    accountNumber: toStr(d.accountNumber),
    iban:          toStr(d.iban),
    swiftCode:     toStr(d.swiftCode),
    currencyId:    toInt(d.currencyId),
    accountId:     toInt(d.accountId),
    isActive:      d.isActive ?? true,
    notes:         toStr(d.notes),
  }).where(eq(bankAccountsTable.id, parseInt(req.params.id))).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [{ recv }] = await db.select({
    recv: sql<number>`count(*)::int`,
  }).from(receiptVouchersTable).where(eq(receiptVouchersTable.bankAccountId, id));
  const [{ paid }] = await db.select({
    paid: sql<number>`count(*)::int`,
  }).from(paymentVouchersTable).where(eq(paymentVouchersTable.bankAccountId, id));
  if ((recv ?? 0) + (paid ?? 0) > 0) {
    res.status(409).json({
      error: `لا يمكن حذف الحساب البنكي لوجود ${recv} سند قبض و ${paid} سند صرف مرتبطة به — احذف السندات أو انقلها إلى حساب آخر أولاً.`,
    });
    return;
  }
  try {
    const result = await db.delete(bankAccountsTable).where(eq(bankAccountsTable.id, id)).returning({ id: bankAccountsTable.id });
    if (result.length === 0) { res.status(404).json({ error: "الحساب البنكي غير موجود" }); return; }
    res.status(204).send();
  } catch (e: any) {
    res.status(409).json({ error: "لا يمكن حذف الحساب البنكي لارتباطه بسجلات أخرى في النظام" });
  }
});

export default router;
