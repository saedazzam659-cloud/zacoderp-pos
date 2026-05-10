import { Router } from "express";
import { db } from "@workspace/db";
import {
  journalEntriesTable, journalEntryLinesTable, branchesTable,
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

    res.json(rows.map(r => {
      const s = sumByEntry.get(r.id);
      return {
        ...r,
        totalDebit:  s?.totalDebit  ?? "0",
        totalCredit: s?.totalCredit ?? "0",
        sourceId:    sourceIdByEntry.get(r.id) ?? null,
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

// ─── RESERVE ─────────────────────────────────────────────────────────────────
// Atomically allocates a docNumber (and a primary-key id) for a new journal
// entry, returning a *draft* row the client can later finalize via PUT
// + /:id/post. This guarantees the user sees the SAME number they'll save
// even when multiple users open "new entry" simultaneously:
//   • If a central sequence is configured for "journal_entry", we consume
//     one number from it (atomic) — concurrent calls always get distinct
//     values. Cancelling the draft leaves a numbering gap (acceptable
//     per Saudi accounting practice for internal entries).
//   • If NOT configured, we insert the draft first so Postgres allocates
//     a unique serial id, then back-fill `docNumber = QYD-{id}` so other
//     parts of the UI display a consistent label.
// The draft is essentially empty (no lines) and `status='draft'`, so it
// has zero impact on financial reports per the "Posted-Only" rule.
router.post("/reserve", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { entryDate, branchId, currency, exchangeRate, entryType } = req.body ?? {};

    const today = entryDate || new Date().toISOString().slice(0, 10);

    const resolvedBranchId = await resolveBranchForWrite(req, res, cid, branchId);
    if (resolvedBranchId === "DENY") return;

    // Period guard — refuse to reserve in a closed period to mirror
    // the create-time behaviour. Reservation must produce a row that
    // is writable on save.
    const writability = await assertWritableForDate(cid, today);
    if (!writability.ok) { res.status(423).json({ error: writability.reason }); return; }

    let resolvedDocNumber: string | null;
    try {
      const fromSeq = await nextSequenceNumber(cid, "journal_entry", {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "journal_entries",
        branchId: resolvedBranchId,
      });
      resolvedDocNumber = fromSeq ?? null;
    } catch (seqErr: any) {
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم القيد" });
      return;
    }

    const [entry] = await db.insert(journalEntriesTable).values({
      companyId:    cid,
      docNumber:    resolvedDocNumber,
      entryDate:    today,
      currency:     currency || "SAR",
      exchangeRate: exchangeRate ?? "1",
      description:  null,
      entryType:    entryType || "general",
      branchId:     resolvedBranchId,
      periodId:     writability.period?.id ?? null,
      status:       "draft",
    }).returning();

    // No central sequence → compose a stable QYD-XXXX label from the
    // freshly-allocated id and persist it so list views, navigation and
    // print-outs all reference the same string.
    if (!resolvedDocNumber) {
      resolvedDocNumber = `QYD-${String(entry.id).padStart(4, "0")}`;
      await db.update(journalEntriesTable)
        .set({ docNumber: resolvedDocNumber })
        .where(eq(journalEntriesTable.id, entry.id));
    } else {
      // Central-sequence path: backfill `sequence_logs.ref_id` for the
      // row we JUST issued so the discard-empty endpoint can release the
      // correct log unambiguously (multiple branches can share the same
      // generated_number, so matching by number alone is unsafe).
      await db.execute(sql`
        UPDATE sequence_logs
        SET ref_id = ${String(entry.id)}
        WHERE id = (
          SELECT id FROM sequence_logs
          WHERE company_id = ${cid}
            AND transaction_type = 'journal_entry'
            AND generated_number = ${resolvedDocNumber}
            AND ref_id IS NULL
          ORDER BY id DESC
          LIMIT 1
        )
      `);
    }

    res.json({ id: entry.id, docNumber: resolvedDocNumber, reserved: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

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

    // Central sequence engine is authoritative when an active sequence
    // exists for "journal_entry"; otherwise fall back to client-supplied
    // value or null (legacy behavior). Server allocation is atomic so
    // concurrent submits can never persist the same number.
    // Authorize + validate the requested branch BEFORE we burn a sequence
    // number, so a 403/400 doesn't waste a journal-entry sequence value.
    const resolvedBranchId = await resolveBranchForWrite(req, res, cid, branchId);
    if (resolvedBranchId === "DENY") return;

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

    // Period guard: refuse to write into a closed/permanently_closed fiscal
    // period. Auto-resolves the period for the entry date so the row is
    // linked at insert time (no later backfill needed).
    const writability = await assertWritableForDate(cid, entryDate);
    if (!writability.ok) {
      res.status(423).json({ error: writability.reason });
      return;
    }

    const [entry] = await db.insert(journalEntriesTable).values({
      companyId:    cid,
      docNumber:    resolvedDocNumber,
      entryDate,
      currency:     currency || "SAR",
      exchangeRate: exchangeRate ?? "1",
      description:  description || null,
      entryType:    entryType || "general",
      branchId:     resolvedBranchId,
      periodId:     writability.period?.id ?? null,
      status:       "posted",
    }).returning();

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
    // up to two decimal places (Saudi accounting precision).
    const lines = await db.select({
      debit:  journalEntryLinesTable.debit,
      credit: journalEntryLinesTable.credit,
    }).from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, id));
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
      .set({ status: "posted", updatedAt: new Date() })
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

// ─── DISCARD EMPTY DRAFT ──────────────────────────────────────────────────────
// Called by the JE form on cancel/back/exit when the user opened a fresh
// reservation and never typed anything meaningful. The endpoint deletes the
// draft AND releases its sequence number so the next reservation reuses the
// SAME number — no gaps in the journal-entry numbering.
//
// Safety: the row MUST be:
//   • status = 'draft'
//   • description IS NULL or empty
//   • have ZERO non-empty lines (a "non-empty" line has an account_id AND a
//     non-zero debit OR credit)
// Anything else returns 409 so a real edit can never be wiped by mistake.
//
// Sequence release strategy:
//   1. If a sequence_logs row exists for (companyId, journal_entry, docNumber)
//      → look up the matching counter (sequenceId, branchId derived from the
//      entry's branch_id, or 0 sentinel). If the counter is exactly one ahead
//      of the issued number, decrement it and delete the log row.
//      We do NOT release if other numbers were issued AFTER this one — that
//      would risk reusing an in-use number.
//   2. Otherwise (legacy QYD-XXXX path with no central sequence) → reset the
//      Postgres serial on journal_entries.id to MAX(id), so the very next
//      INSERT lands on the freed id and produces the same QYD-XXXX label.
router.post("/:id/discard-empty", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);

    // Load the candidate row + its lines in one shot.
    const [existing] = await db.select().from(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    if (!existing) { res.json({ ok: true, alreadyGone: true }); return; }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "لا يمكن حذف قيد مرحَّل" });
      return;
    }
    if (existing.description && String(existing.description).trim().length > 0) {
      res.status(409).json({ error: "القيد يحتوي على بيانات — لا يمكن حذفه تلقائياً" });
      return;
    }

    const lineRows = await db.execute<{
      id: number; account_id: number | null; debit: string | null; credit: string | null;
    }>(sql`
      SELECT id, account_id, debit, credit
      FROM journal_entry_lines
      WHERE entry_id = ${id}
    `);
    const hasMeaningful = (lineRows.rows ?? []).some(l => {
      const d = Number(l.debit  ?? 0) || 0;
      const c = Number(l.credit ?? 0) || 0;
      return l.account_id != null && (d > 0 || c > 0);
    });
    if (hasMeaningful) {
      res.status(409).json({ error: "القيد يحتوي على سطور — لا يمكن حذفه تلقائياً" });
      return;
    }

    const docNumber = existing.docNumber;
    const branchKey = existing.branchId != null && Number(existing.branchId) > 0
      ? Number(existing.branchId) : 0;

    let releasedSequence = false;
    let resetSerial      = false;

    await db.transaction(async (tx) => {
      // 1. Drop the (empty) lines first to satisfy any FK.
      await tx.execute(sql`DELETE FROM journal_entry_lines WHERE entry_id = ${id}`);

      // 2. Try sequence-engine release path.
      // Look up the log row by the deterministic linkage we set at reserve
      // time (`ref_id = entry.id`). This avoids the "same generated_number
      // exists in multiple branches" ambiguity that would arise from
      // matching by generated_number alone.
      if (docNumber) {
        const logRows = await tx.execute<{
          id: number; sequence_id: number; generated_number: string;
        }>(sql`
          SELECT id, sequence_id, generated_number
          FROM sequence_logs
          WHERE company_id = ${cid}
            AND transaction_type = 'journal_entry'
            AND ref_id = ${String(id)}
            AND generated_number = ${docNumber}
          LIMIT 1
        `);
        const log = logRows.rows?.[0];
        if (log) {
          // Lock the counter row for this (sequence, branch) and verify it is
          // exactly one ahead of the issued number — i.e. nothing was issued
          // after this one. Only then is it safe to roll back.
          const counterRows = await tx.execute<{ id: number; current_number: number }>(sql`
            SELECT id, current_number
            FROM sequence_counters
            WHERE sequence_id = ${log.sequence_id} AND branch_id = ${branchKey}
            FOR UPDATE
          `);
          const counter = counterRows.rows?.[0];
          // Parse the trailing integer from the generated number.
          const m = String(log.generated_number).match(/(\d+)\s*$/);
          const issuedNum = m ? Number(m[1]) : NaN;
          if (counter && Number.isFinite(issuedNum) && counter.current_number === issuedNum + 1) {
            await tx.execute(sql`
              UPDATE sequence_counters
              SET current_number = ${issuedNum}, updated_at = NOW()
              WHERE id = ${counter.id}
            `);
            await tx.execute(sql`DELETE FROM sequence_logs WHERE id = ${log.id}`);
            releasedSequence = true;
          }
        }
      }

      // 3. Delete the entry row itself.
      await tx.execute(sql`
        DELETE FROM journal_entries
        WHERE id = ${id} AND company_id = ${cid}
      `);

      // 4. Legacy QYD-XXXX path: docNumber matches QYD-{padded id} AND no
      //    central sequence released the number. Re-anchor the postgres
      //    serial so the freed id is reused on the next INSERT.
      if (!releasedSequence && docNumber && /^QYD-\d+$/.test(docNumber)) {
        await tx.execute(sql`
          SELECT setval(
            pg_get_serial_sequence('journal_entries','id'),
            GREATEST(COALESCE((SELECT MAX(id) FROM journal_entries), 0), 1),
            true
          )
        `);
        resetSerial = true;
      }
    });

    res.json({ ok: true, releasedSequence, resetSerial });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

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

export default router;
