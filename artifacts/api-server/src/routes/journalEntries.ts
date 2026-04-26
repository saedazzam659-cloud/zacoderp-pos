import { Router } from "express";
import { db } from "@workspace/db";
import { journalEntriesTable, journalEntryLinesTable, branchesTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId, intersectBranchRequest } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { ensureLeafAccounts } from "../lib/leafAccount.js";
import { nextSequenceNumber } from "../lib/sequences.js";

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
router.get("/", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const rows = cid
      ? await db.select().from(journalEntriesTable)
          .where(eq(journalEntriesTable.companyId, cid))
          .orderBy(desc(journalEntriesTable.createdAt))
      : await db.select().from(journalEntriesTable)
          .orderBy(desc(journalEntriesTable.createdAt));
    res.json(rows);
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

    const [entry] = await db.insert(journalEntriesTable).values({
      companyId:    cid,
      docNumber:    resolvedDocNumber,
      entryDate,
      currency:     currency || "SAR",
      exchangeRate: exchangeRate ?? "1",
      description:  description || null,
      entryType:    entryType || "general",
      branchId:     resolvedBranchId,
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

    // docNumber is intentionally omitted — once assigned, it is immutable.
    const [entry] = await db.update(journalEntriesTable).set({
      entryDate:    entryDate || undefined,
      currency:     currency || "SAR",
      exchangeRate: exchangeRate ?? "1",
      description:  description || null,
      entryType:    entryType || "general",
      branchId:     resolvedBranchId,
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

    await db.delete(journalEntriesTable)
      .where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
