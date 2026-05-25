// Standalone Credit / Debit Notes (إشعارات دائنة ومدينة) routes
// ───────────────────────────────────────────────────────────────
// Pure-accounting notes that adjust a customer/supplier balance with NO
// link to a specific invoice and NO stock movement. ZATCA-style credit/
// debit notes (which must reference an invoice) continue to live under
// /api/sales-returns + /api/purchase-returns. See `replit.md` →
// "Standalone Credit/Debit Notes".
//
// Module gating: `customer_notes` for partyType=customer, `supplier_notes`
// for partyType=supplier. Both are checked per-request based on the body
// (POST/PUT) or the existing row (GET/PATCH/DELETE/POST :id/post).
//
// JE direction matrix (amount = subtotal before VAT; total = amount+VAT):
//   customer + credit  →  DR contra(amount) + DR vat(vatAmt) / CR partyAR(total)
//   customer + debit   →  DR partyAR(total) / CR contra(amount) + CR vat(vatAmt)
//   supplier + credit  →  DR partyAP(total) / CR contra(amount) + CR vat(vatAmt)
//   supplier + debit   →  DR contra(amount) + DR vat(vatAmt) / CR partyAP(total)

import { Router } from "express";
import { db } from "@workspace/db";
import {
  accountNotesTable,
  customersTable, suppliersTable,
  accountsTable,
  journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requireModulePermission } from "../middleware/permissions.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import { resolvePostingStatus } from "../lib/postingStatus.js";

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

function moduleKeyFor(partyType: "customer" | "supplier"): "customer_notes" | "supplier_notes" {
  return partyType === "customer" ? "customer_notes" : "supplier_notes";
}

// Lightweight per-request gate: SuperAdmins always pass. Otherwise checks
// the user's menu_permissions JSONB against the right module key.
async function checkModule(req: any, res: any, partyType: "customer" | "supplier"): Promise<boolean> {
  const u = (req as any).authUser;
  if (!u) { res.status(401).json({ error: "غير مصرح" }); return false; }
  if (u.role === "superadmin") return true;
  // Delegate to the standard middleware by simulating the call: we just
  // run the same logic inline via a no-op next() wrapper.
  const middleware = requireModulePermission(moduleKeyFor(partyType));
  return await new Promise<boolean>((resolve) => {
    middleware(req as any, res as any, ((err?: unknown) => {
      if (err) { resolve(false); return; }
      resolve(true);
    }) as any);
  });
}

// ═════════════════════════════════════════════════════════════════
// LIST
// ═════════════════════════════════════════════════════════════════
// Query params: partyType, noteType, partyId, status — all optional.
router.get("/", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const u = (req as any).authUser;
  const filters: any[] = [eq(accountNotesTable.companyId, cid)];
  if (req.query.partyType === "customer" || req.query.partyType === "supplier") {
    filters.push(eq(accountNotesTable.partyType, req.query.partyType as any));
  }
  if (req.query.noteType === "credit" || req.query.noteType === "debit") {
    filters.push(eq(accountNotesTable.noteType, req.query.noteType as any));
  }
  if (req.query.partyId)  filters.push(eq(accountNotesTable.partyId, Number(req.query.partyId)));
  if (req.query.status === "draft" || req.query.status === "posted" || req.query.status === "cancelled") {
    filters.push(eq(accountNotesTable.status, req.query.status as any));
  }
  let rows = await db.select().from(accountNotesTable)
    .where(and(...filters))
    .orderBy(desc(accountNotesTable.id));
  // Filter by module access if non-SA — drop rows from disallowed party type.
  if (u?.role !== "superadmin") {
    const mp = u?.menuPermissions ?? {};
    const allowedCustomer = mp.customer_notes !== false;
    const allowedSupplier = mp.supplier_notes !== false;
    rows = rows.filter(r => (r.partyType === "customer" ? allowedCustomer : allowedSupplier));
  }
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const [row] = await db.select().from(accountNotesTable)
    .where(and(eq(accountNotesTable.id, id), eq(accountNotesTable.companyId, cid)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!(await checkModule(req, res, row.partyType as any))) return;
  res.json(row);
});

// ═════════════════════════════════════════════════════════════════
// CREATE (always starts as draft; user calls /post separately)
// ═════════════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const b = req.body ?? {};

  if (b.partyType !== "customer" && b.partyType !== "supplier") {
    res.status(400).json({ error: "نوع الطرف غير صالح" }); return;
  }
  if (b.noteType !== "credit" && b.noteType !== "debit") {
    res.status(400).json({ error: "نوع الإشعار غير صالح" }); return;
  }
  if (!(await checkModule(req, res, b.partyType))) return;
  if (!b.partyId || !b.noteDate || !b.partyAccountId || !b.contraAccountId) {
    res.status(400).json({ error: "بيانات ناقصة (الطرف/التاريخ/الحسابات)" }); return;
  }
  const amount = Number(b.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر" }); return;
  }
  const vatEnabled = b.vatEnabled === true;
  const vatRate    = vatEnabled ? Number(b.vatRate ?? 15) : 0;
  const vatAmount  = vatEnabled ? +(amount * vatRate / 100).toFixed(4) : 0;
  const total      = +(amount + vatAmount).toFixed(4);
  if (vatEnabled && !b.vatAccountId) {
    res.status(400).json({ error: "حدّد حساب ضريبة القيمة المضافة" }); return;
  }

  // Verify party belongs to the same tenant.
  const partyTable = b.partyType === "customer" ? customersTable : suppliersTable;
  const [party] = await db.select({ id: partyTable.id, accountId: partyTable.accountId })
    .from(partyTable)
    .where(and(eq(partyTable.id, Number(b.partyId)), eq(partyTable.companyId, cid)));
  if (!party) { res.status(400).json({ error: "الطرف غير موجود" }); return; }

  // Verify GL accounts belong to the same tenant.
  const accountIds = [Number(b.partyAccountId), Number(b.contraAccountId)];
  if (vatEnabled) accountIds.push(Number(b.vatAccountId));
  const accs = await db.select({ id: accountsTable.id }).from(accountsTable)
    .where(and(eq(accountsTable.companyId, cid), sql`${accountsTable.id} IN (${sql.join(accountIds.map(i => sql`${i}`), sql`, `)})`));
  if (accs.length !== new Set(accountIds).size) {
    res.status(400).json({ error: "حسابات محاسبية غير صالحة" }); return;
  }

  let num: string;
  try {
    const seqKey = `account_note_${b.partyType}_${b.noteType}`;
    const fromSeq = await nextSequenceNumber(cid, seqKey, {
      userId: (req as any).authUser?.id ?? null,
      refTable: "account_notes", branchId: b.branchId ?? null,
      docDate: b.noteDate,
    });
    const prefix = b.partyType === "customer"
      ? (b.noteType === "credit" ? "CCN-" : "CDN-")
      : (b.noteType === "credit" ? "SCN-" : "SDN-");
    num = fromSeq ?? (String(b.noteNumber ?? "").trim() || `${prefix}${Date.now()}`);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "تعذر توليد رقم الإشعار" });
    return;
  }

  const [row] = await db.insert(accountNotesTable).values({
    companyId: cid,
    branchId: b.branchId ?? null,
    noteNumber: num,
    noteDate: b.noteDate,
    partyType: b.partyType,
    noteType: b.noteType,
    partyId: Number(b.partyId),
    partyAccountId: Number(b.partyAccountId),
    contraAccountId: Number(b.contraAccountId),
    amount: amount.toFixed(4),
    vatEnabled,
    vatRate: vatRate.toFixed(2),
    vatAccountId: vatEnabled ? Number(b.vatAccountId) : null,
    vatAmount: vatAmount.toFixed(4),
    totalAmount: total.toFixed(4),
    description: b.description ?? null,
    notes: b.notes ?? null,
    status: "draft",
    createdBy: (req as any).authUser?.id ?? null,
  }).returning();

  res.status(201).json(row);
});

// ═════════════════════════════════════════════════════════════════
// UPDATE (draft only)
// ═════════════════════════════════════════════════════════════════
router.put("/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const [existing] = await db.select().from(accountNotesTable)
    .where(and(eq(accountNotesTable.id, id), eq(accountNotesTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!(await checkModule(req, res, existing.partyType as any))) return;
  if (existing.status !== "draft") { res.status(400).json({ error: "لا يمكن تعديل إشعار مُرحَّل" }); return; }

  const b = req.body ?? {};
  const amount = Number(b.amount ?? existing.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر" }); return;
  }
  const vatEnabled = b.vatEnabled === true;
  const vatRate    = vatEnabled ? Number(b.vatRate ?? existing.vatRate ?? 15) : 0;
  const vatAmount  = vatEnabled ? +(amount * vatRate / 100).toFixed(4) : 0;
  const total      = +(amount + vatAmount).toFixed(4);
  if (vatEnabled && !b.vatAccountId) {
    res.status(400).json({ error: "حدّد حساب ضريبة القيمة المضافة" }); return;
  }

  await db.update(accountNotesTable).set({
    noteDate:         b.noteDate         ?? existing.noteDate,
    partyId:          b.partyId          ? Number(b.partyId)          : existing.partyId,
    partyAccountId:   b.partyAccountId   ? Number(b.partyAccountId)   : existing.partyAccountId,
    contraAccountId:  b.contraAccountId  ? Number(b.contraAccountId)  : existing.contraAccountId,
    amount:           amount.toFixed(4),
    vatEnabled,
    vatRate:          vatRate.toFixed(2),
    vatAccountId:     vatEnabled ? Number(b.vatAccountId) : null,
    vatAmount:        vatAmount.toFixed(4),
    totalAmount:      total.toFixed(4),
    description:      b.description ?? existing.description,
    notes:            b.notes       ?? existing.notes,
    branchId:         b.branchId    ?? existing.branchId,
    updatedAt:        new Date(),
  }).where(eq(accountNotesTable.id, id));

  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════
// POST  (claim → JE → mark posted)
// ═════════════════════════════════════════════════════════════════
router.post("/:id/post", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرف غير صالح" }); return; }

  // Atomic claim: only one caller can flip draft → in-flight.
  const claim = await db.update(accountNotesTable)
    .set({ updatedAt: new Date() })
    .where(and(
      eq(accountNotesTable.id, id),
      eq(accountNotesTable.companyId, cid),
      eq(accountNotesTable.status, "draft"),
    ))
    .returning();
  if (!claim.length) { res.status(400).json({ error: "الإشعار غير موجود أو مُرحَّل مسبقاً" }); return; }
  const n = claim[0];
  if (!(await checkModule(req, res, n.partyType as any))) return;

  const writability = await assertWritableForDate(cid, n.noteDate as any);
  if (!writability.ok) { res.status(423).json({ error: writability.reason }); return; }

  // Resolve party name for the JE description.
  const partyTable = n.partyType === "customer" ? customersTable : suppliersTable;
  const [party] = await db.select({ nameAr: partyTable.nameAr })
    .from(partyTable)
    .where(and(eq(partyTable.id, n.partyId), eq(partyTable.companyId, cid)));

  const amount   = Number(n.amount);
  const vatAmt   = Number(n.vatAmount);
  const total    = Number(n.totalAmount);
  const isCredit = n.noteType === "credit";
  const isCustomer = n.partyType === "customer";

  // Direction matrix (see header comment).
  //   customer+credit / supplier+debit  →  DR contra+vat / CR party
  //   customer+debit  / supplier+credit →  DR party / CR contra+vat
  const partyOnRight = (isCustomer && isCredit) || (!isCustomer && !isCredit);

  const noteLabel = isCredit ? "إشعار دائن" : "إشعار مدين";
  const partyLabel = isCustomer ? "عميل" : "مورد";
  const desc = `${noteLabel} ${partyLabel} ${n.noteNumber} - ${party?.nameAr ?? `#${n.partyId}`}`;

  const lines: any[] = [];
  if (partyOnRight) {
    // DR contra(amount) + DR vat(vatAmt) / CR party(total)
    lines.push({ accountId: n.contraAccountId, debit: amount.toFixed(2), credit: "0.00", description: desc, sortOrder: 0 });
    if (n.vatEnabled && vatAmt > 0) {
      lines.push({ accountId: n.vatAccountId!, debit: vatAmt.toFixed(2), credit: "0.00", description: `ضريبة القيمة المضافة - ${n.noteNumber}`, sortOrder: 1 });
    }
    lines.push({ accountId: n.partyAccountId, debit: "0.00", credit: total.toFixed(2), description: desc, sortOrder: 2 });
  } else {
    // DR party(total) / CR contra(amount) + CR vat(vatAmt)
    lines.push({ accountId: n.partyAccountId, debit: total.toFixed(2), credit: "0.00", description: desc, sortOrder: 0 });
    lines.push({ accountId: n.contraAccountId, debit: "0.00", credit: amount.toFixed(2), description: desc, sortOrder: 1 });
    if (n.vatEnabled && vatAmt > 0) {
      lines.push({ accountId: n.vatAccountId!, debit: "0.00", credit: vatAmt.toFixed(2), description: `ضريبة القيمة المضافة - ${n.noteNumber}`, sortOrder: 2 });
    }
  }

  const jeStatus = await resolvePostingStatus(cid, "financial");
  const [entry] = await db.insert(journalEntriesTable).values({
    companyId: cid,
    docNumber: n.noteNumber,
    entryDate: n.noteDate as any,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: `account_note_${n.partyType}_${n.noteType}` as any,
    status: jeStatus,
    periodId: writability.period?.id ?? null,
    ...fullAuditFor(req, jeStatus),
  }).returning();

  await db.insert(journalEntryLinesTable).values(
    lines.map(l => ({ entryId: entry.id, ...l }))
  );

  await db.update(accountNotesTable).set({
    status: "posted",
    journalEntryId: entry.id,
    updatedAt: new Date(),
  }).where(eq(accountNotesTable.id, id));

  res.json({ ok: true, journalEntryId: entry.id, journalEntryStatus: jeStatus });
});

// ═════════════════════════════════════════════════════════════════
// UNPOST  (reverse: delete JE → flip back to draft)
// ═════════════════════════════════════════════════════════════════
router.post("/:id/unpost", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const [n] = await db.select().from(accountNotesTable)
    .where(and(eq(accountNotesTable.id, id), eq(accountNotesTable.companyId, cid)));
  if (!n) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!(await checkModule(req, res, n.partyType as any))) return;
  if (n.status !== "posted") { res.status(400).json({ error: "الإشعار ليس مُرحَّلاً" }); return; }
  const writability = await assertWritableForDate(cid, n.noteDate as any);
  if (!writability.ok) { res.status(423).json({ error: writability.reason }); return; }
  if (n.journalEntryId) {
    await db.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, n.journalEntryId));
    await db.delete(journalEntriesTable).where(eq(journalEntriesTable.id, n.journalEntryId));
  }
  await db.update(accountNotesTable).set({
    status: "draft", journalEntryId: null, updatedAt: new Date(),
  }).where(eq(accountNotesTable.id, id));
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════
// DELETE (draft only)
// ═════════════════════════════════════════════════════════════════
router.delete("/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرف غير صالح" }); return; }
  const [n] = await db.select().from(accountNotesTable)
    .where(and(eq(accountNotesTable.id, id), eq(accountNotesTable.companyId, cid)));
  if (!n) { res.status(404).json({ error: "غير موجود" }); return; }
  if (!(await checkModule(req, res, n.partyType as any))) return;
  if (n.status === "posted") { res.status(400).json({ error: "لا يمكن حذف إشعار مُرحَّل — أوقف الترحيل أولاً" }); return; }
  await db.delete(accountNotesTable).where(eq(accountNotesTable.id, id));
  res.json({ ok: true });
});

export default router;
