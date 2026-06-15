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
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
import { requireModulePermission } from "../middleware/permissions.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import { loadMappings } from "../lib/accountingMappings.js";
import { contractingProjectsTable } from "@workspace/db";

/**
 * Resolve & validate a `projectId` belongs to the current company.
 * Returns `null` when the caller omitted or cleared the field; throws-via-
 * response (and returns a sentinel `undefined` cast) when ownership fails so
 * the calling handler aborts after sending 400. We deliberately mirror the
 * party/account ownership pattern in this file.
 */
async function resolveProjectId(
  raw: any,
  cid: number,
  res: import("express").Response,
): Promise<number | null> {
  if (raw === null || raw === undefined || raw === "" ) return null;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    res.status(400).json({ error: "معرّف المشروع غير صالح" });
    throw new Error("invalid projectId");
  }
  const [p] = await db.select({ id: contractingProjectsTable.id })
    .from(contractingProjectsTable)
    .where(and(eq(contractingProjectsTable.id, pid), eq(contractingProjectsTable.companyId, cid)));
  if (!p) {
    res.status(400).json({ error: "المشروع غير موجود في هذه الشركة" });
    throw new Error("project not in company");
  }
  return pid;
}

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
  // Branch scope (same semantics as JEs/sales): specific ?branchId → branch_id = X OR NULL;
  // restricted users auto-capped to assigned branches; admin w/o filter sees all.
  filters.push(...branchScopeSpread(req, accountNotesTable.branchId, req.query.branchId));
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

// ═════════════════════════════════════════════════════════════════
// DEFAULTS — auto-fill the contra + VAT accounts based on the note type
// ═════════════════════════════════════════════════════════════════
// Resolves from the company's accounting-mappings (the SAME source the
// sales/purchase invoices use, so a note posts to the SAME revenue / VAT
// accounts → consistent reports). VAT side follows the international
// output-vs-input convention:
//   customer → sales_invoice    : contra = revenue,  vat = vat_output (ضريبة المخرجات)
//   supplier → purchase_invoice : contra = discount(credit)/inventory(debit),
//                                 vat = vat_input (ضريبة المدخلات)
// We also return each account's `accountType` so the UI can skip auto-filling
// the contra when its type falls outside that route's allowed picker types
// (the AccountCombobox only renders accounts within `filterTypes`, so a
// type-mismatched value would otherwise display blank). Returns nulls for
// unmapped companies → the UI falls back to manual selection.
// NOTE: registered BEFORE `/:id` so the literal "defaults" segment is not
// swallowed by the `:id` param (Express 5 / path-to-regexp 8 quirk).
router.get("/defaults", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const partyType = req.query.partyType;
  const noteType  = req.query.noteType;
  if (partyType !== "customer" && partyType !== "supplier") {
    res.status(400).json({ error: "نوع الطرف غير صالح" }); return;
  }
  const docType = partyType === "customer" ? "sales_invoice" : "purchase_invoice";
  const map = await loadMappings(cid, docType);

  let contraAccountId: number | null;
  let vatAccountId: number | null;
  if (partyType === "customer") {
    contraAccountId = map(docType, "revenue");
    vatAccountId    = map(docType, "vat_output");
  } else {
    // Supplier-side contra is a P&L purchase account: credit notes reduce
    // purchases (مردودات/خصم مشتريات → "discount" role), debit notes add cost.
    contraAccountId = noteType === "credit" ? map(docType, "discount") : map(docType, "inventory");
    vatAccountId    = map(docType, "vat_input");
  }

  // Resolve the account types in one round-trip for the UI gating above.
  const ids = [contraAccountId, vatAccountId].filter((x): x is number => !!x);
  const typeOf = new Map<number, string>();
  if (ids.length) {
    const accs = await db.select({ id: accountsTable.id, accountType: accountsTable.accountType })
      .from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), inArray(accountsTable.id, ids)));
    for (const a of accs) typeOf.set(a.id, a.accountType as any);
  }

  res.json({
    contraAccountId:   contraAccountId ?? null,
    contraAccountType: contraAccountId ? (typeOf.get(contraAccountId) ?? null) : null,
    vatAccountId:      vatAccountId ?? null,
    vatAccountType:    vatAccountId ? (typeOf.get(vatAccountId) ?? null) : null,
  });
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
    operationNumber: b.operationNumber?.toString().trim() || null,
    referenceNumber: b.referenceNumber?.toString().trim() || null,
    referenceDate:   b.referenceDate || null,
    costCenter:      b.costCenter?.toString().trim() || null,
    projectId:       await resolveProjectId(b.projectId, cid, res),
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

  // Resolve effective values, then re-validate tenant ownership for ANY
  // party/GL ids that changed. Without this, a caller could overwrite the
  // row with ids that belong to another tenant and post against them.
  const newPartyId         = b.partyId         ? Number(b.partyId)         : existing.partyId;
  const newPartyAccountId  = b.partyAccountId  ? Number(b.partyAccountId)  : existing.partyAccountId;
  const newContraAccountId = b.contraAccountId ? Number(b.contraAccountId) : existing.contraAccountId;
  const newVatAccountId    = vatEnabled ? Number(b.vatAccountId) : null;

  const partyTable = existing.partyType === "customer" ? customersTable : suppliersTable;
  const [partyOk] = await db.select({ id: partyTable.id })
    .from(partyTable)
    .where(and(eq(partyTable.id, newPartyId), eq(partyTable.companyId, cid)));
  if (!partyOk) { res.status(400).json({ error: "الطرف غير موجود" }); return; }

  const accountIds = [newPartyAccountId, newContraAccountId];
  if (newVatAccountId) accountIds.push(newVatAccountId);
  const accs = await db.select({ id: accountsTable.id }).from(accountsTable)
    .where(and(
      eq(accountsTable.companyId, cid),
      sql`${accountsTable.id} IN (${sql.join(accountIds.map(i => sql`${i}`), sql`, `)})`,
    ));
  if (accs.length !== new Set(accountIds).size) {
    res.status(400).json({ error: "حسابات محاسبية غير صالحة" }); return;
  }

  await db.update(accountNotesTable).set({
    noteDate:         b.noteDate         ?? existing.noteDate,
    partyId:          newPartyId,
    partyAccountId:   newPartyAccountId,
    contraAccountId:  newContraAccountId,
    amount:           amount.toFixed(4),
    vatEnabled,
    vatRate:          vatRate.toFixed(2),
    vatAccountId:     vatEnabled ? Number(b.vatAccountId) : null,
    vatAmount:        vatAmount.toFixed(4),
    totalAmount:      total.toFixed(4),
    description:      b.description ?? existing.description,
    notes:            b.notes       ?? existing.notes,
    operationNumber:  b.operationNumber !== undefined ? (b.operationNumber?.toString().trim() || null) : existing.operationNumber,
    referenceNumber:  b.referenceNumber !== undefined ? (b.referenceNumber?.toString().trim() || null) : existing.referenceNumber,
    referenceDate:    b.referenceDate   !== undefined ? (b.referenceDate || null) : existing.referenceDate,
    costCenter:       b.costCenter      !== undefined ? (b.costCenter?.toString().trim() || null) : existing.costCenter,
    projectId:        b.projectId       !== undefined ? await resolveProjectId(b.projectId, cid, res) : existing.projectId,
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

  // Pre-checks (need the row before opening the JE transaction).
  const [pre] = await db.select({ partyType: accountNotesTable.partyType, noteDate: accountNotesTable.noteDate, status: accountNotesTable.status })
    .from(accountNotesTable)
    .where(and(eq(accountNotesTable.id, id), eq(accountNotesTable.companyId, cid)));
  if (!pre) { res.status(404).json({ error: "غير موجود" }); return; }
  if (pre.status !== "draft") { res.status(400).json({ error: "الإشعار غير موجود أو مُرحَّل مسبقاً" }); return; }
  if (!(await checkModule(req, res, pre.partyType as any))) return;
  const writability = await assertWritableForDate(cid, pre.noteDate as any);
  if (!writability.ok) { res.status(423).json({ error: writability.reason }); return; }

  // Truly atomic claim + JE in a single transaction. The claim flips
  // status draft → posted in the same UPDATE that asserts WHERE status='draft',
  // so two concurrent callers cannot both pass: PG row-locks the row, the
  // second caller re-evaluates the WHERE clause on the new tuple version
  // (status='posted') and the UPDATE matches 0 rows. If anything below
  // throws, the whole tx rolls back and the note returns to 'draft'.
  let result: { entryId: number; jeStatus: any };
  try {
    result = await db.transaction(async (tx) => {
      const claim = await tx.update(accountNotesTable)
        .set({ status: "posted", updatedAt: new Date() })
        .where(and(
          eq(accountNotesTable.id, id),
          eq(accountNotesTable.companyId, cid),
          eq(accountNotesTable.status, "draft"),
        ))
        .returning();
      if (!claim.length) throw new Error("ALREADY_CLAIMED");
      const n = claim[0];

      const partyTable = n.partyType === "customer" ? customersTable : suppliersTable;
      const [party] = await tx.select({ nameAr: partyTable.nameAr })
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

      // Propagate the header cost-centre code (when set) to every JE line
      // so cost-centre filtered reports pick the note up. JE-line column is
      // text-typed by convention — see schema/journalEntries.ts.
      const cc = n.costCenter || null;
      const lines: any[] = [];
      if (partyOnRight) {
        lines.push({ accountId: n.contraAccountId, debit: amount.toFixed(2), credit: "0.00", description: desc, sortOrder: 0, costCenter: cc });
        if (n.vatEnabled && vatAmt > 0) {
          lines.push({ accountId: n.vatAccountId!, debit: vatAmt.toFixed(2), credit: "0.00", description: `ضريبة القيمة المضافة - ${n.noteNumber}`, sortOrder: 1, costCenter: cc });
        }
        lines.push({ accountId: n.partyAccountId, debit: "0.00", credit: total.toFixed(2), description: desc, sortOrder: 2, costCenter: cc });
      } else {
        lines.push({ accountId: n.partyAccountId, debit: total.toFixed(2), credit: "0.00", description: desc, sortOrder: 0, costCenter: cc });
        lines.push({ accountId: n.contraAccountId, debit: "0.00", credit: amount.toFixed(2), description: desc, sortOrder: 1, costCenter: cc });
        if (n.vatEnabled && vatAmt > 0) {
          lines.push({ accountId: n.vatAccountId!, debit: "0.00", credit: vatAmt.toFixed(2), description: `ضريبة القيمة المضافة - ${n.noteNumber}`, sortOrder: 2, costCenter: cc });
        }
      }

      const jeStatus = await resolvePostingStatus(cid, "financial");
      const [entry] = await tx.insert(journalEntriesTable).values({
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

      await tx.insert(journalEntryLinesTable).values(
        lines.map(l => ({ entryId: entry.id, ...l }))
      );

      await tx.update(accountNotesTable).set({
        journalEntryId: entry.id,
        updatedAt: new Date(),
      }).where(eq(accountNotesTable.id, id));

      return { entryId: entry.id, jeStatus };
    });
  } catch (e: any) {
    if (e?.message === "ALREADY_CLAIMED") {
      res.status(409).json({ error: "الإشعار غير موجود أو مُرحَّل مسبقاً" }); return;
    }
    throw e;
  }

  res.json({ ok: true, journalEntryId: result.entryId, journalEntryStatus: result.jeStatus });
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
