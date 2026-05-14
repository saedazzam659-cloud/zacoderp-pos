import { Router } from "express";
import { db } from "@workspace/db";
import {
  journalEntriesTable, journalEntryLinesTable, branchesTable, usersTable,
  salesInvoicesTable, salesReturnsTable, customerSettlementsTable,
  purchaseInvoicesTable, purchaseReturnsTable, supplierSettlementsTable,
  receiptVouchersTable, paymentVouchersTable,
  stockTransfersTable, stockAdjustmentsTable,
  payrollRunsTable, employeeLoansTable,
} from "@workspace/db";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, intersectBranchRequest } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { ensureLeafAccounts } from "../lib/leafAccount.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { assertWritableForDate, assertWritableForPeriodId } from "../lib/periodGuard.js";
import { createdAuditFor, postedAuditFor, fullAuditFor } from "../lib/journalAudit.js";
import { describeDevice } from "../lib/deviceFingerprint.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("journal_entries"));
router.use(moduleAudit("journal_entries"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

/**
 * Resolves and authorizes a branchId for a journal-entry write. Mirrors the
 * payroll-runs flow:
 *   - Caller-supplied branchId is intersected against the user's allowed scope
 *     (a restricted user picking a forbidden branch is rejected with 403).
 *   - If the caller did not pick one and the user is restricted to a single
 *     branch, that branch is used implicitly so reports filtered by branch
 *     do not silently drop the entry.
 *   - The chosen branch must belong to this company (returns 400 otherwise).
 * On error the response is sent and `null` is returned (sentinel "DENY").
 */
async function resolveBranchForWrite(
  req: any, res: any, cid: number, raw: unknown,
): Promise<number | null | "DENY"> {
  const requested = (raw == null || raw === "") ? null : Number(raw);
  // Accept only positive integers — guards against NaN, decimals, negatives,
  // and Infinity all in one check.
  if (requested != null && (!Number.isInteger(requested) || requested <= 0)) {
    res.status(400).json({ error: "معرّف الفرع غير صحيح" }); return "DENY";
  }
  const intersected = intersectBranchRequest(req, requested);
  if (intersected === "deny") {
    res.status(403).json({ error: "غير مصرح بالوصول إلى هذا الفرع" }); return "DENY";
  }
  const allowed = (req as any).authUser?.branchIds as number[] | undefined;
  const viewAll = (req as any).authUser?.viewAllBranches === true
    || ["admin", "superadmin"].includes((req as any).authUser?.role);
  let resolved: number | null = null;
  if (typeof intersected === "number") {
    resolved = intersected;
  } else if (!viewAll && allowed?.length === 1) {
    resolved = allowed[0];
  }
  if (resolved != null) {
    const [br] = await db.select({ id: branchesTable.id }).from(branchesTable)
      .where(and(eq(branchesTable.id, resolved), eq(branchesTable.companyId, cid)));
    if (!br) { res.status(400).json({ error: "الفرع غير موجود في هذه الشركة" }); return "DENY"; }
  }
  return resolved;
}
function getCompanyId(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// ─── LIST ─────────────────────────────────────────────────────────────────────
// Source-doc table descriptors used by the LIST endpoint to enrich each
// journal-entry row with the `sourceId` of the document that produced it.
// The match key is whichever column on the source table holds the value the
// poster wrote into `journal_entries.doc_number` (see hr-journals.ts,
// receipt-vouchers.ts, sales.ts, purchasing.ts, inventory.ts).
const SOURCE_TABLES: Record<string, { table: any; col: any }> = {
  sales_invoice:        { table: salesInvoicesTable,        col: salesInvoicesTable.docNumber },
  sales_return:         { table: salesReturnsTable,         col: salesReturnsTable.docNumber },
  customer_settlement:  { table: customerSettlementsTable,  col: customerSettlementsTable.docNumber },
  purchase_invoice:     { table: purchaseInvoicesTable,     col: purchaseInvoicesTable.docNumber },
  purchase_return:      { table: purchaseReturnsTable,      col: purchaseReturnsTable.docNumber },
  supplier_settlement:  { table: supplierSettlementsTable,  col: supplierSettlementsTable.docNumber },
  receipt:              { table: receiptVouchersTable,      col: receiptVouchersTable.code },
  receipt_voucher:      { table: receiptVouchersTable,      col: receiptVouchersTable.code },
  payment:              { table: paymentVouchersTable,      col: paymentVouchersTable.code },
  payment_voucher:      { table: paymentVouchersTable,      col: paymentVouchersTable.code },
  stock_transfer:       { table: stockTransfersTable,       col: stockTransfersTable.transferNumber },
  stock_adjustment:     { table: stockAdjustmentsTable,     col: stockAdjustmentsTable.adjustmentNumber },
  payroll_run:          { table: payrollRunsTable,          col: payrollRunsTable.code },
};

router.get("/", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const rows = cid
      ? await db.select().from(journalEntriesTable)
          .where(eq(journalEntriesTable.companyId, cid))
          .orderBy(desc(journalEntriesTable.createdAt))
      : await db.select().from(journalEntriesTable)
          .orderBy(desc(journalEntriesTable.createdAt));

    if (rows.length === 0) { res.json([]); return; }

    // 1) Aggregate debit/credit per entry in a single SQL pass instead of N+1.
    const ids = rows.map(r => r.id);
    const sums = await db.select({
      entryId:     journalEntryLinesTable.entryId,
      totalDebit:  sql<string>`COALESCE(SUM(${journalEntryLinesTable.debit}),  0)`.as("total_debit"),
      totalCredit: sql<string>`COALESCE(SUM(${journalEntryLinesTable.credit}), 0)`.as("total_credit"),
    })
      .from(journalEntryLinesTable)
      .where(inArray(journalEntryLinesTable.entryId, ids))
      .groupBy(journalEntryLinesTable.entryId);
    const sumByEntry = new Map(sums.map(s => [s.entryId, s]));

    // 2) Resolve sourceId for each row by batching lookups per
    //    (entryType, companyId). Always pinning by companyId — even in
    //    superadmin all-companies mode where `cid` is undefined — guarantees
    //    a docNumber collision across tenants can never resolve to the
    //    wrong tenant's source row. `employee_loan` is a special case: the
    //    poster encodes the source id into the docNumber as "LOAN-{id}"
    //    (see hr-journals.ts), so we parse rather than query. Unknown or
    //    manually-created entry types simply get no sourceId — the
    //    frontend then renders the docNumber as plain text.
    const sourceIdByEntry = new Map<number, number>();
    const byTypeCompany = new Map<string, { docNum: string; entryId: number }[]>();
    for (const r of rows) {
      const et = r.entryType ?? "";
      const dn = r.docNumber ?? "";
      if (!dn) continue;
      if (et === "employee_loan") {
        const m = /^LOAN-(\d+)$/.exec(dn);
        if (m) sourceIdByEntry.set(r.id, Number(m[1]));
        continue;
      }
      if (!SOURCE_TABLES[et]) continue;
      const key = `${et}|${r.companyId}`;
      if (!byTypeCompany.has(key)) byTypeCompany.set(key, []);
      byTypeCompany.get(key)!.push({ docNum: dn, entryId: r.id });
    }
    for (const [key, items] of byTypeCompany) {
      const sep = key.indexOf("|");
      const et = key.slice(0, sep);
      const groupCid = Number(key.slice(sep + 1));
      const { table, col } = SOURCE_TABLES[et];
      const docNums = Array.from(new Set(items.map(i => i.docNum)));
      // Always company-scoped — every source table follows the same
      // `company_id` convention so the same WHERE shape works for all.
      const found = await db.select({ id: (table as any).id, key: col }).from(table)
        .where(and(eq((table as any).companyId, groupCid), inArray(col, docNums)));
      const byKey = new Map(found.map((f: any) => [f.key, f.id]));
      for (const it of items) {
        const sid = byKey.get(it.docNum);
        if (sid != null) sourceIdByEntry.set(it.entryId, sid as number);
      }
    }

    // Resolve usernames for the createdBy / postedBy ids in one pass so the
    // grid can render "أنشأه" / "رحّله" columns without an extra round trip.
    const userIds = Array.from(new Set(
      rows.flatMap(r => [r.createdBy, r.postedBy]).filter((x): x is number => typeof x === "number")
    ));
    const userMap = new Map<number, string>();
    if (userIds.length > 0) {
      const us = await db.select({ id: usersTable.id, username: usersTable.username })
        .from(usersTable).where(inArray(usersTable.id, userIds));
      for (const u of us) userMap.set(u.id, u.username);
    }

    res.json(rows.map(r => {
      const s = sumByEntry.get(r.id);
      return {
        ...r,
        totalDebit:    s?.totalDebit  ?? "0",
        totalCredit:   s?.totalCredit ?? "0",
        sourceId:      sourceIdByEntry.get(r.id) ?? null,
        createdByName: r.createdBy != null ? (userMap.get(r.createdBy) ?? null) : null,
        postedByName:  r.postedBy  != null ? (userMap.get(r.postedBy)  ?? null) : null,
      };
    }));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET ONE (with lines) ─────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const id  = Number(req.params.id);
    const [entry] = cid
      ? await db.select().from(journalEntriesTable)
          .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)))
      : await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, id));
    if (!entry) { res.status(404).json({ error: "القيد غير موجود" }); return; }

    const lines = await db.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, id))
      .orderBy(journalEntryLinesTable.sortOrder);

    res.json({ ...entry, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// (Reservation endpoint REMOVED in favour of explicit-save. The form now
// only consumes a sequence number when the user actually clicks Save —
// closing the form without saving leaves no row and no number gap by
// design, since nothing was ever inserted.)

// ─── CREATE ───────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, entryDate, currency, exchangeRate, description, entryType, branchId, lines } = req.body;

    if (!entryDate) { res.status(400).json({ error: "التاريخ مطلوب" }); return; }

    if (Array.isArray(lines) && lines.length > 0) {
      try {
        await ensureLeafAccounts(cid, lines.map((l: any) => l?.accountId));
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "حساب رئيسي غير مسموح" });
        return;
      }
    }

    // Authorize + validate the requested branch BEFORE we burn a sequence
    // number, so a 403/400 doesn't waste a journal-entry sequence value.
    const resolvedBranchId = await resolveBranchForWrite(req, res, cid, branchId);
    if (resolvedBranchId === "DENY") return;

    // Period guard runs BEFORE sequence allocation: writing into a closed
    // period is a 423 reject, and burning a sequence number on a request we
    // already know will fail would leave a permanent gap in the document
    // numbering. Resolve the fiscal period here so we (a) reject early and
    // (b) reuse the resolved period when inserting the entry below.
    const writability = await assertWritableForDate(cid, entryDate);
    if (!writability.ok) {
      res.status(423).json({ error: writability.reason });
      return;
    }

    // Central sequence engine is authoritative when an active sequence
    // exists for "journal_entry"; otherwise fall back to client-supplied
    // value or null (legacy behavior). Server allocation is atomic so
    // concurrent submits can never persist the same number.
    let resolvedDocNumber: string | null;
    try {
      const fromSeq = await nextSequenceNumber(cid, "journal_entry", {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "journal_entries",
        branchId: resolvedBranchId,
      });
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم القيد" });
      return;
    }

    // Atomic dual-status decision: only flip to "posted" when the entry is
    // both balanced AND has at least 2 valid lines (each with an accountId
    // and a non-zero debit OR credit). Anything else lands as "draft" so
    // the user can finish typing later — but the sequence number is only
    // ever consumed once, on this single Save click.
    const validLines = Array.isArray(lines)
      ? lines.filter((l: any) => l && l.accountId)
      : [];
    const totalDebit  = validLines.reduce(
      (s: number, l: any) => s + (parseFloat(String(l.debit  ?? "0")) || 0), 0,
    );
    const totalCredit = validLines.reduce(
      (s: number, l: any) => s + (parseFloat(String(l.credit ?? "0")) || 0), 0,
    );
    const hasMovement = totalDebit > 0 || totalCredit > 0;
    const isBalanced  = Math.abs(totalDebit - totalCredit) < 0.001 && hasMovement;
    const canPost     = isBalanced && validLines.length >= 2;

    // Wrap the INSERT + (optional) QYD fallback assignment in a single
    // transaction guarded by a per-company advisory lock. Without the lock,
    // two concurrent saves can both read the same MAX(QYD-XXXX) before
    // either has updated, then both write the SAME doc_number — producing
    // duplicates (e.g. two rows both labeled QYD-0722). The advisory lock
    // serializes assignment per company while leaving other tenants
    // unaffected. Lock is held until COMMIT/ROLLBACK.
    const entry = await db.transaction(async (tx) => {
      if (!resolvedDocNumber) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${cid}, 1001)`);
      }
      const [e] = await tx.insert(journalEntriesTable).values({
        companyId:    cid,
        docNumber:    resolvedDocNumber,
        entryDate,
        currency:     currency || "SAR",
        exchangeRate: exchangeRate ?? "1",
        description:  description || null,
        entryType:    entryType || "general",
        branchId:     resolvedBranchId,
        periodId:     writability.period?.id ?? null,
        status:       canPost ? "posted" : "draft",
        // Audit trail — when the entry lands as "posted" on the same save,
        // we stamp BOTH the created* and posted* fields so the audit dialog
        // can attribute creation and posting to the same user/IP/UA.
        ...(canPost ? fullAuditFor(req) : createdAuditFor(req)),
      }).returning();

      // Legacy QYD fallback: when no central sequence is configured AND the
      // client didn't supply a docNumber, compose a stable QYD-XXXX label.
      // Compute next number PER COMPANY = MAX(numeric part of QYD-XXXX) + 1.
      // Using global entry.id would interleave ids across tenants and create
      // artificial gaps in each company's view of its own numbering.
      if (!resolvedDocNumber) {
        const result = await tx.execute<{ next: number }>(sql`
          SELECT COALESCE(MAX(
            CASE
              WHEN doc_number ~ '^QYD-[0-9]+$'
              THEN (regexp_replace(doc_number, '^QYD-', ''))::int
              ELSE 0
            END
          ), 0) + 1 AS next
          FROM journal_entries
          WHERE company_id = ${cid}
            AND id <> ${e.id}
        `);
        const next = Number((result as any).rows?.[0]?.next ?? 1);
        resolvedDocNumber = `QYD-${String(next).padStart(4, "0")}`;
        await tx.update(journalEntriesTable)
          .set({ docNumber: resolvedDocNumber })
          .where(eq(journalEntriesTable.id, e.id));
        e.docNumber = resolvedDocNumber;
      }
      return e;
    });

    if (Array.isArray(lines) && lines.length > 0) {
      await db.insert(journalEntryLinesTable).values(
        lines.map((l: any, i: number) => ({
          entryId:     entry.id,
          accountId:   l.accountId ? Number(l.accountId) : null,
          costCenter:  l.costCenter || null,
          debit:       l.debit  ?? "0",
          credit:      l.credit ?? "0",
          description: l.description || null,
          sortOrder:   i,
        }))
      );
    }

    const linesOut = await db.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, entry.id))
      .orderBy(journalEntryLinesTable.sortOrder);

    res.status(201).json({ ...entry, lines: linesOut });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────
// Entry types that are auto-generated by source documents; these JEs must NOT
// be modified or deleted directly — use the source document's unpost action.
const LOCKED_ENTRY_TYPES = [
  "purchase_invoice", "purchase_return",
  "sales_invoice", "sales_return",
  // Voucher routes today emit the legacy bare strings "receipt" /
  // "payment" (see receipt-vouchers.ts / payment-vouchers.ts). The
  // canonical names are kept here for forward compatibility once
  // those routes are normalized.
  "receipt_voucher", "payment_voucher", "receipt", "payment",
  "stock_transfer", "stock_adjustment",
  "supplier_settlement", "customer_settlement",
  "payroll_run", "employee_loan", "eos_payment",
];

async function ensureNotLocked(id: number, cid: number): Promise<{ ok: boolean; entryType?: string | null }> {
  const [existing] = await db.select().from(journalEntriesTable)
    .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
  if (!existing) return { ok: true };
  if (existing.entryType && LOCKED_ENTRY_TYPES.includes(existing.entryType)) {
    return { ok: false, entryType: existing.entryType };
  }
  return { ok: true };
}

router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    const lockCheck = await ensureNotLocked(id, cid);
    if (!lockCheck.ok) {
      res.status(403).json({ error: "هذا القيد تم إنشاؤه تلقائياً من مستند مصدر (فاتورة/سند) ولا يمكن تعديله مباشرة. لتعديله قم بفك ترحيل المستند الأصلي." });
      return;
    }

    // docNumber is intentionally not destructured — immutable on edit.
    const { entryDate, currency, exchangeRate, description, entryType, branchId, lines } = req.body;

    // Validate accounts BEFORE mutating the entry header so a bad
    // account doesn't leave the journal half-updated.
    if (Array.isArray(lines) && lines.length > 0) {
      try {
        await ensureLeafAccounts(cid, lines.map((l: any) => l?.accountId));
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "حساب رئيسي غير مسموح" });
        return;
      }
    }

    // Authorize + validate the requested branch (same rules as on create:
    // branch must be inside the user's allowed scope and belong to this
    // company). NULL is preserved for users who explicitly clear it.
    const resolvedBranchId = await resolveBranchForWrite(req, res, cid, branchId);
    if (resolvedBranchId === "DENY") return;

    // Period guard — verify both the existing entry's period AND the new
    // target date's period are open. This protects against editing into or
    // out of a closed period.
    const [pre] = await db.select({ periodId: journalEntriesTable.periodId })
      .from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (pre) {
      const oldGuard = await assertWritableForPeriodId(cid, pre.periodId);
      if (!oldGuard.ok) { res.status(423).json({ error: oldGuard.reason }); return; }
    }
    const newDate = entryDate || undefined;
    let resolvedPeriodId: number | null | undefined = undefined;
    if (newDate) {
      const newGuard = await assertWritableForDate(cid, newDate);
      if (!newGuard.ok) { res.status(423).json({ error: newGuard.reason }); return; }
      resolvedPeriodId = newGuard.period?.id ?? null;
    }

    // docNumber is intentionally omitted — once assigned, it is immutable.
    const [entry] = await db.update(journalEntriesTable).set({
      entryDate:    entryDate || undefined,
      currency:     currency || "SAR",
      exchangeRate: exchangeRate ?? "1",
      description:  description || null,
      entryType:    entryType || "general",
      branchId:     resolvedBranchId,
      ...(resolvedPeriodId !== undefined ? { periodId: resolvedPeriodId } : {}),
      updatedAt:    new Date(),
    }).where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid))).returning();

    if (!entry) { res.status(404).json({ error: "القيد غير موجود" }); return; }

    if (Array.isArray(lines)) {
      await db.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, id));
      if (lines.length > 0) {
        await db.insert(journalEntryLinesTable).values(
          lines.map((l: any, i: number) => ({
            entryId:     id,
            accountId:   l.accountId ? Number(l.accountId) : null,
            costCenter:  l.costCenter || null,
            debit:       l.debit  ?? "0",
            credit:      l.credit ?? "0",
            description: l.description || null,
            sortOrder:   i,
          }))
        );
      }
    }

    const linesOut = await db.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, id))
      .orderBy(journalEntryLinesTable.sortOrder);

    res.json({ ...entry, lines: linesOut });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /:id/post — flip status from draft → posted ───────────────────────
// Used by the unified Posting Center. We require the entry to be balanced
// (sum debit === sum credit) and not auto-locked. Auto-generated JEs are
// already posted by their source document, so manually flipping their status
// is rejected.
router.post("/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    const lockCheck = await ensureNotLocked(id, cid);
    if (!lockCheck.ok) {
      res.status(403).json({ error: "هذا القيد تم إنشاؤه تلقائياً من مستند مصدر — غير قابل للترحيل اليدوي" });
      return;
    }

    const [existing] = await db.select().from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "القيد غير موجود" }); return; }
    if (existing.status === "posted") { res.json({ ok: true, alreadyPosted: true }); return; }

    // Period guard — refuse to flip status when the entry's period is closed
    const postGuard = await assertWritableForPeriodId(cid, existing.periodId);
    if (!postGuard.ok) { res.status(423).json({ error: postGuard.reason }); return; }

    // Balance check — sum debit must equal sum credit. We pull the lines
    // raw (numeric → string) and parseFloat so the comparison is float-safe
    // up to two decimal places (Saudi accounting precision). We also
    // require at least 2 valid posting lines (each with an accountId AND a
    // non-zero debit OR credit) so the posted path mirrors the create-time
    // dual-status decision (a one-line entry can never be balanced).
    const lines = await db.select({
      accountId: journalEntryLinesTable.accountId,
      debit:     journalEntryLinesTable.debit,
      credit:    journalEntryLinesTable.credit,
    }).from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, id));
    const validLines = lines.filter(l => {
      const d = parseFloat(l.debit  || "0") || 0;
      const c = parseFloat(l.credit || "0") || 0;
      return l.accountId != null && (d > 0 || c > 0);
    });
    if (validLines.length < 2) {
      res.status(400).json({ error: "يجب أن يحتوي القيد على سطرين فعّالين على الأقل قبل الترحيل" });
      return;
    }
    const totalDebit  = lines.reduce((s, l) => s + parseFloat(l.debit  || "0"), 0);
    const totalCredit = lines.reduce((s, l) => s + parseFloat(l.credit || "0"), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      res.status(400).json({ error: `القيد غير متوازن — مدين: ${totalDebit.toFixed(2)} / دائن: ${totalCredit.toFixed(2)}` });
      return;
    }
    if (totalDebit === 0 && totalCredit === 0) {
      res.status(400).json({ error: "لا يمكن ترحيل قيد بقيمة صفرية" });
      return;
    }

    await db.update(journalEntriesTable)
      .set({ status: "posted", updatedAt: new Date(), ...postedAuditFor(req) })
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /:id/unpost — flip status from posted → draft ─────────────────────
router.post("/:id/unpost", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    const lockCheck = await ensureNotLocked(id, cid);
    if (!lockCheck.ok) {
      res.status(403).json({ error: "هذا القيد تم إنشاؤه تلقائياً من مستند مصدر — لفك ترحيله قم بفك ترحيل المستند الأصلي" });
      return;
    }

    const [existing] = await db.select().from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "القيد غير موجود" }); return; }
    if (existing.status !== "posted") { res.json({ ok: true, alreadyUnposted: true }); return; }

    // Period guard — refuse to unpost from a closed period
    const unpGuard = await assertWritableForPeriodId(cid, existing.periodId);
    if (!unpGuard.ok) { res.status(423).json({ error: unpGuard.reason }); return; }

    await db.update(journalEntriesTable)
      .set({ status: "draft", updatedAt: new Date() })
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// (Discard-empty endpoint REMOVED alongside the reservation endpoint —
// no row is created until the user explicitly saves, so there is nothing
// to discard on cancel/exit.)

// ─── DELETE ───────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    const lockCheck = await ensureNotLocked(id, cid);
    if (!lockCheck.ok) {
      res.status(403).json({ error: "هذا القيد تم إنشاؤه تلقائياً من مستند مصدر (فاتورة/سند) ولا يمكن حذفه مباشرة. لحذفه قم بفك ترحيل المستند الأصلي." });
      return;
    }

    // Period guard — refuse to delete entries inside a closed period
    const [pre] = await db.select({ periodId: journalEntriesTable.periodId })
      .from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (pre) {
      const delGuard = await assertWritableForPeriodId(cid, pre.periodId);
      if (!delGuard.ok) { res.status(423).json({ error: delGuard.reason }); return; }
    }

    await db.delete(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /:id/audit — manager-only forensic audit dialog ──────────────────
// Returns the captured create + post audit fields, the resolved usernames,
// a friendly device label (browser + OS) parsed from the user-agent, and
// the country resolved on demand from the stored IP via the same free
// Geo-IP service the visitor-country middleware uses. Restricted to
// admin/superadmin so regular users can't snoop on each other's IPs.
router.get("/:id/audit", async (req, res) => {
  try {
    const role = req.authUser?.role;
    if (role !== "admin" && role !== "superadmin") {
      res.status(403).json({ error: "صلاحية المدير مطلوبة لعرض سجل التدقيق" });
      return;
    }
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    const [e] = await db.select({
      id:               journalEntriesTable.id,
      createdAt:        journalEntriesTable.createdAt,
      createdBy:        journalEntriesTable.createdBy,
      createdIp:        journalEntriesTable.createdIp,
      createdUserAgent: journalEntriesTable.createdUserAgent,
      postedAt:         journalEntriesTable.postedAt,
      postedBy:         journalEntriesTable.postedBy,
      postedIp:         journalEntriesTable.postedIp,
      postedUserAgent:  journalEntriesTable.postedUserAgent,
      status:           journalEntriesTable.status,
    }).from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (!e) { res.status(404).json({ error: "القيد غير موجود" }); return; }

    // Resolve usernames in one pass.
    const userIds = [e.createdBy, e.postedBy].filter((x): x is number => typeof x === "number");
    const userMap = new Map<number, string>();
    if (userIds.length > 0) {
      const us = await db.select({ id: usersTable.id, username: usersTable.username })
        .from(usersTable).where(inArray(usersTable.id, userIds));
      for (const u of us) userMap.set(u.id, u.username);
    }

    // Tiny inline geo-IP — the visitorCountry middleware keeps its own
    // cache but doesn't expose a lookup-by-ip helper, so we issue the
    // same upstream call here. Failures degrade silently to null so
    // the dialog still renders the rest of the audit info.
    async function lookupCountry(ip: string | null): Promise<string | null> {
      if (!ip) return null;
      // Skip private/loopback ranges — they have no public country.
      if (/^(10\.|192\.168\.|127\.|169\.254\.|::1$|fe80:|fc|fd)/i.test(ip)) return null;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(`https://api.country.is/${encodeURIComponent(ip)}`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) return null;
        const j: any = await r.json();
        return String(j?.country || "").toUpperCase() || null;
      } catch { return null; }
    }

    const [createdCountry, postedCountry] = await Promise.all([
      lookupCountry(e.createdIp),
      // Don't double-lookup when create+post share the same IP.
      e.postedIp && e.postedIp === e.createdIp
        ? Promise.resolve(null)
        : lookupCountry(e.postedIp),
    ]);

    function deviceLabel(ua: string | null): string | null {
      if (!ua) return null;
      const fakeReq = { headers: { "user-agent": ua } } as any;
      const d = describeDevice(fakeReq);
      return [d.browser, d.os].filter(Boolean).join(" • ") || null;
    }

    res.json({
      id: e.id,
      status: e.status,
      created: {
        userId:    e.createdBy,
        username:  e.createdBy != null ? (userMap.get(e.createdBy) ?? null) : null,
        at:        e.createdAt,
        ip:        e.createdIp,
        userAgent: e.createdUserAgent,
        device:    deviceLabel(e.createdUserAgent),
        country:   createdCountry,
      },
      posted: e.postedAt ? {
        userId:    e.postedBy,
        username:  e.postedBy != null ? (userMap.get(e.postedBy) ?? null) : null,
        at:        e.postedAt,
        ip:        e.postedIp,
        userAgent: e.postedUserAgent,
        device:    deviceLabel(e.postedUserAgent),
        country:   e.postedIp && e.postedIp === e.createdIp ? createdCountry : postedCountry,
      } : null,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
