import { Router } from "express";
import { db } from "@workspace/db";
import {
  trialBalancesTable, trialBalanceDetailsTable,
  trialBalanceAdjustmentsTable, trialBalanceLogsTable,
  accountsTable, journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("accounting_maintenance"));
router.use(moduleAudit("accounting_maintenance"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCompanyId(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}
function n(v: any): string {
  const x = Number(v);
  return Number.isFinite(x) ? x.toFixed(2) : "0.00";
}
async function logAction(trialBalanceId: number, userId: number | null, action: string, details: any) {
  try {
    await db.insert(trialBalanceLogsTable).values({
      trialBalanceId, userId: userId ?? null, action, details,
    });
  } catch { /* swallow logging errors */ }
}
async function recomputeTotals(trialBalanceId: number) {
  const [sum] = await db.select({
    debit:  sql<string>`COALESCE(SUM(${trialBalanceDetailsTable.debit}),  0)`.as("d"),
    credit: sql<string>`COALESCE(SUM(${trialBalanceDetailsTable.credit}), 0)`.as("c"),
  }).from(trialBalanceDetailsTable)
    .where(eq(trialBalanceDetailsTable.trialBalanceId, trialBalanceId));
  await db.update(trialBalancesTable).set({
    totalDebit:  sum?.debit  ?? "0",
    totalCredit: sum?.credit ?? "0",
    updatedAt:   new Date(),
  }).where(eq(trialBalancesTable.id, trialBalanceId));
}

// ─── LIST ─────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const where = cid ? eq(trialBalancesTable.companyId, cid) : undefined;
    const rows = await db.select().from(trialBalancesTable)
      .where(where as any)
      .orderBy(desc(trialBalancesTable.createdAt));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── CREATE HEADER ────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { fiscalYear, fiscalYearId, periodStart, periodEnd, balanceType, notes } = req.body;
    if (!fiscalYear || !periodStart || !periodEnd) {
      res.status(400).json({ error: "السنة المالية وتاريخ البدء والانتهاء مطلوبة" }); return;
    }
    const [row] = await db.insert(trialBalancesTable).values({
      companyId: cid,
      fiscalYearId: fiscalYearId ? Number(fiscalYearId) : null,
      fiscalYear: String(fiscalYear),
      periodStart, periodEnd,
      balanceType: balanceType || "before_review",
      status: "draft",
      notes: notes || null,
      createdBy: (req as any).authUser?.id ?? null,
    }).returning();
    await logAction(row.id, (req as any).authUser?.id ?? null, "create", { fiscalYear, periodStart, periodEnd, balanceType });
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET ONE (detail + lines + adjustments + logs) ────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const id  = Number(req.params.id);
    const [header] = cid
      ? await db.select().from(trialBalancesTable)
          .where(and(eq(trialBalancesTable.id, id), eq(trialBalancesTable.companyId, cid)))
      : await db.select().from(trialBalancesTable).where(eq(trialBalancesTable.id, id));
    if (!header) { res.status(404).json({ error: "ميزان المراجعة غير موجود" }); return; }

    const details = await db.select().from(trialBalanceDetailsTable)
      .where(eq(trialBalanceDetailsTable.trialBalanceId, id))
      .orderBy(trialBalanceDetailsTable.sortOrder, trialBalanceDetailsTable.accountCode);
    const adjustments = await db.select().from(trialBalanceAdjustmentsTable)
      .where(eq(trialBalanceAdjustmentsTable.trialBalanceId, id))
      .orderBy(desc(trialBalanceAdjustmentsTable.createdAt));
    const logs = await db.select().from(trialBalanceLogsTable)
      .where(eq(trialBalanceLogsTable.trialBalanceId, id))
      .orderBy(desc(trialBalanceLogsTable.createdAt));
    res.json({ ...header, details, adjustments, logs });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── UPDATE HEADER ────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [existing] = await db.select().from(trialBalancesTable)
      .where(and(eq(trialBalancesTable.id, id), eq(trialBalancesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "ميزان المراجعة غير موجود" }); return; }
    if (existing.status === "approved") {
      res.status(403).json({ error: "لا يمكن تعديل ميزان مراجعة معتمد" }); return;
    }
    const { fiscalYear, periodStart, periodEnd, balanceType, notes } = req.body;
    const [row] = await db.update(trialBalancesTable).set({
      fiscalYear: fiscalYear ?? existing.fiscalYear,
      periodStart: periodStart ?? existing.periodStart,
      periodEnd: periodEnd ?? existing.periodEnd,
      balanceType: balanceType ?? existing.balanceType,
      notes: notes ?? existing.notes,
      updatedAt: new Date(),
    }).where(eq(trialBalancesTable.id, id)).returning();
    await logAction(id, (req as any).authUser?.id ?? null, "update_header", req.body);
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE ───────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [existing] = await db.select().from(trialBalancesTable)
      .where(and(eq(trialBalancesTable.id, id), eq(trialBalancesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "ميزان المراجعة غير موجود" }); return; }
    if (existing.status === "approved") {
      res.status(403).json({ error: "لا يمكن حذف ميزان مراجعة معتمد" }); return;
    }
    await db.delete(trialBalancesTable).where(eq(trialBalancesTable.id, id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── IMPORT LINES ─────────────────────────────────────────────────────────────
// Body: { lines: [{ accountCode, accountName?, debit, credit }], replace?: boolean }
router.post("/:id/import", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [existing] = await db.select().from(trialBalancesTable)
      .where(and(eq(trialBalancesTable.id, id), eq(trialBalancesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "ميزان المراجعة غير موجود" }); return; }
    if (existing.status === "approved") {
      res.status(403).json({ error: "لا يمكن استيراد بنود إلى ميزان معتمد" }); return;
    }
    const { lines, replace } = req.body as { lines: any[]; replace?: boolean };
    if (!Array.isArray(lines) || lines.length === 0) {
      res.status(400).json({ error: "لا توجد بنود للاستيراد" }); return;
    }

    // load chart of accounts to link by code
    const chart = await db.select({
      id: accountsTable.id, code: accountsTable.code, nameAr: accountsTable.nameAr,
    }).from(accountsTable).where(eq(accountsTable.companyId, cid));
    const byCode = new Map(chart.map(a => [String(a.code).trim(), a]));

    if (replace) {
      await db.delete(trialBalanceDetailsTable)
        .where(eq(trialBalanceDetailsTable.trialBalanceId, id));
    }

    const rowsToInsert = lines.map((l: any, idx: number) => {
      const code = String(l.accountCode ?? "").trim();
      const acct = byCode.get(code);
      const debit  = n(l.debit);
      const credit = n(l.credit);
      return {
        trialBalanceId: id,
        accountId: acct?.id ?? null,
        accountCode: code,
        accountName: String(l.accountName ?? acct?.nameAr ?? "").trim() || code,
        debit, credit,
        originalDebit: debit, originalCredit: credit,
        isUnlinked: acct ? 0 : 1,
        sortOrder: idx,
      };
    }).filter(r => r.accountCode);

    if (rowsToInsert.length > 0) {
      await db.insert(trialBalanceDetailsTable).values(rowsToInsert);
    }
    await recomputeTotals(id);
    await logAction(id, (req as any).authUser?.id ?? null, "import", {
      count: rowsToInsert.length, replace: !!replace,
      unlinked: rowsToInsert.filter(r => r.isUnlinked).length,
    });
    const details = await db.select().from(trialBalanceDetailsTable)
      .where(eq(trialBalanceDetailsTable.trialBalanceId, id))
      .orderBy(trialBalanceDetailsTable.sortOrder);
    res.json({ ok: true, count: rowsToInsert.length, details });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ADD LINE ─────────────────────────────────────────────────────────────────
router.post("/:id/details", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [header] = await db.select().from(trialBalancesTable)
      .where(and(eq(trialBalancesTable.id, id), eq(trialBalancesTable.companyId, cid)));
    if (!header) { res.status(404).json({ error: "ميزان المراجعة غير موجود" }); return; }
    if (header.status === "approved") {
      res.status(403).json({ error: "لا يمكن تعديل ميزان معتمد" }); return;
    }
    const { accountId, accountCode, accountName, debit, credit, changeReason } = req.body;
    let acct: any = null;
    if (accountId) {
      [acct] = await db.select().from(accountsTable)
        .where(and(eq(accountsTable.id, Number(accountId)), eq(accountsTable.companyId, cid)));
    }
    const code = String(accountCode ?? acct?.code ?? "").trim();
    if (!code) { res.status(400).json({ error: "كود الحساب مطلوب" }); return; }
    const d = n(debit), c = n(credit);
    const [row] = await db.insert(trialBalanceDetailsTable).values({
      trialBalanceId: id,
      accountId: acct?.id ?? null,
      accountCode: code,
      accountName: String(accountName ?? acct?.nameAr ?? "").trim() || code,
      debit: d, credit: c,
      originalDebit: d, originalCredit: c,
      changeReason: changeReason ?? null,
      isUnlinked: acct ? 0 : 1,
      sortOrder: 9999,
    }).returning();
    await recomputeTotals(id);
    await logAction(id, (req as any).authUser?.id ?? null, "add_line", { accountCode: code, debit: d, credit: c });
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── EDIT LINE ────────────────────────────────────────────────────────────────
router.put("/:id/details/:lineId", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const lid = Number(req.params.lineId);
    const [header] = await db.select().from(trialBalancesTable)
      .where(and(eq(trialBalancesTable.id, id), eq(trialBalancesTable.companyId, cid)));
    if (!header) { res.status(404).json({ error: "ميزان المراجعة غير موجود" }); return; }
    if (header.status === "approved") {
      res.status(403).json({ error: "لا يمكن تعديل ميزان معتمد" }); return;
    }
    const [existing] = await db.select().from(trialBalanceDetailsTable)
      .where(and(eq(trialBalanceDetailsTable.id, lid), eq(trialBalanceDetailsTable.trialBalanceId, id)));
    if (!existing) { res.status(404).json({ error: "السطر غير موجود" }); return; }
    const { debit, credit, changeReason, accountId, accountCode, accountName } = req.body;
    const newDebit  = debit  != null ? n(debit)  : existing.debit;
    const newCredit = credit != null ? n(credit) : existing.credit;
    // Tenant-isolation guard: if accountId is being changed, it MUST belong to this company
    let nextAccountId = existing.accountId;
    if (accountId != null) {
      const [acct] = await db.select().from(accountsTable)
        .where(and(eq(accountsTable.id, Number(accountId)), eq(accountsTable.companyId, cid)));
      if (!acct) { res.status(403).json({ error: "الحساب لا ينتمي لهذه الشركة" }); return; }
      nextAccountId = acct.id;
    }
    const [row] = await db.update(trialBalanceDetailsTable).set({
      debit: newDebit, credit: newCredit,
      changeReason: changeReason ?? existing.changeReason,
      accountId:    nextAccountId,
      accountCode:  accountCode ?? existing.accountCode,
      accountName:  accountName ?? existing.accountName,
      isUnlinked:   accountId != null ? 0 : existing.isUnlinked,
    }).where(eq(trialBalanceDetailsTable.id, lid)).returning();
    await recomputeTotals(id);
    await logAction(id, (req as any).authUser?.id ?? null, "edit_line", {
      lineId: lid, accountCode: existing.accountCode,
      from: { debit: existing.debit, credit: existing.credit },
      to:   { debit: newDebit, credit: newCredit },
      reason: changeReason,
    });
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE LINE ──────────────────────────────────────────────────────────────
router.delete("/:id/details/:lineId", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const lid = Number(req.params.lineId);
    const [header] = await db.select().from(trialBalancesTable)
      .where(and(eq(trialBalancesTable.id, id), eq(trialBalancesTable.companyId, cid)));
    if (!header) { res.status(404).json({ error: "ميزان المراجعة غير موجود" }); return; }
    if (header.status === "approved") {
      res.status(403).json({ error: "لا يمكن تعديل ميزان معتمد" }); return;
    }
    const [existing] = await db.select().from(trialBalanceDetailsTable)
      .where(and(eq(trialBalanceDetailsTable.id, lid), eq(trialBalanceDetailsTable.trialBalanceId, id)));
    if (!existing) { res.status(404).json({ error: "السطر غير موجود" }); return; }
    await db.delete(trialBalanceDetailsTable).where(eq(trialBalanceDetailsTable.id, lid));
    await recomputeTotals(id);
    await logAction(id, (req as any).authUser?.id ?? null, "delete_line", {
      lineId: lid, accountCode: existing.accountCode,
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── COMPARE ──────────────────────────────────────────────────────────────────
router.get("/:id/compare/:otherId", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const id  = Number(req.params.id);
    const oid = Number(req.params.otherId);
    const [a] = cid
      ? await db.select().from(trialBalancesTable)
          .where(and(eq(trialBalancesTable.id, id),  eq(trialBalancesTable.companyId, cid)))
      : await db.select().from(trialBalancesTable).where(eq(trialBalancesTable.id, id));
    const [b] = cid
      ? await db.select().from(trialBalancesTable)
          .where(and(eq(trialBalancesTable.id, oid), eq(trialBalancesTable.companyId, cid)))
      : await db.select().from(trialBalancesTable).where(eq(trialBalancesTable.id, oid));
    if (!a || !b) { res.status(404).json({ error: "أحد ميزاني المراجعة غير موجود" }); return; }
    const aLines = await db.select().from(trialBalanceDetailsTable)
      .where(eq(trialBalanceDetailsTable.trialBalanceId, id));
    const bLines = await db.select().from(trialBalanceDetailsTable)
      .where(eq(trialBalanceDetailsTable.trialBalanceId, oid));
    const aMap = new Map(aLines.map(l => [l.accountCode, l]));
    const bMap = new Map(bLines.map(l => [l.accountCode, l]));
    const codes = Array.from(new Set([...aMap.keys(), ...bMap.keys()])).sort();
    const rows = codes.map(code => {
      const x = aMap.get(code);
      const y = bMap.get(code);
      const xD = Number(x?.debit  ?? 0), xC = Number(x?.credit  ?? 0);
      const yD = Number(y?.debit  ?? 0), yC = Number(y?.credit  ?? 0);
      return {
        accountCode: code,
        accountName: x?.accountName ?? y?.accountName ?? "",
        baseDebit:    xD.toFixed(2), baseCredit:    xC.toFixed(2),
        otherDebit:   yD.toFixed(2), otherCredit:   yC.toFixed(2),
        diffDebit:   (yD - xD).toFixed(2),
        diffCredit:  (yC - xC).toFixed(2),
        changed:     yD !== xD || yC !== xC,
      };
    });
    res.json({
      base: a, other: b,
      lines: rows,
      summary: {
        changedCount: rows.filter(r => r.changed).length,
        totalCount:   rows.length,
      },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ADD ADJUSTMENT (creates a journal entry + link) ──────────────────────────
router.post("/:id/adjustments", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [header] = await db.select().from(trialBalancesTable)
      .where(and(eq(trialBalancesTable.id, id), eq(trialBalancesTable.companyId, cid)));
    if (!header) { res.status(404).json({ error: "ميزان المراجعة غير موجود" }); return; }
    if (header.status === "approved") {
      res.status(403).json({ error: "لا يمكن إضافة تسويات على ميزان معتمد" }); return;
    }
    const { description, category, lines, entryDate } = req.body as {
      description: string; category?: string; entryDate?: string;
      lines: { accountId: number; debit?: number|string; credit?: number|string; description?: string }[];
    };
    if (!description || !Array.isArray(lines) || lines.length < 2) {
      res.status(400).json({ error: "الوصف وعلى الأقل سطرين مطلوبين" }); return;
    }
    const totalD = lines.reduce((s, l) => s + Number(l.debit  ?? 0), 0);
    const totalC = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    if (Math.abs(totalD - totalC) > 0.001) {
      res.status(400).json({ error: `قيد التسوية غير متوازن (مدين ${totalD.toFixed(2)} ≠ دائن ${totalC.toFixed(2)})` });
      return;
    }
    // Tenant-isolation guard — verify EVERY accountId belongs to this company BEFORE any insert
    const reqIds = Array.from(new Set(lines.map(l => Number(l.accountId)).filter(x => Number.isFinite(x) && x > 0)));
    if (reqIds.length === 0) { res.status(400).json({ error: "يجب اختيار حساب لكل سطر" }); return; }
    const ownedAccts = await db.select().from(accountsTable)
      .where(and(inArray(accountsTable.id, reqIds), eq(accountsTable.companyId, cid)));
    if (ownedAccts.length !== reqIds.length) {
      res.status(403).json({ error: "أحد الحسابات لا ينتمي لهذه الشركة" }); return;
    }
    const acctById = new Map(ownedAccts.map(a => [a.id, a]));

    const result = await db.transaction(async (tx) => {
      const [je] = await tx.insert(journalEntriesTable).values({
        companyId: cid,
        docNumber: null,
        entryDate: entryDate || header.periodEnd,
        currency: "SAR",
        exchangeRate: "1",
        description: `تسوية ميزان مراجعة #${id} - ${description}`,
        entryType: "trial_balance_adjustment",
        status: "posted",
      }).returning();
      await tx.insert(journalEntryLinesTable).values(
        lines.map((l: any, i: number) => ({
          entryId: je.id,
          accountId: Number(l.accountId),
          debit:  n(l.debit), credit: n(l.credit),
          description: l.description ?? null,
          sortOrder: i,
        }))
      );
      const [adj] = await tx.insert(trialBalanceAdjustmentsTable).values({
        trialBalanceId: id,
        journalEntryId: je.id,
        description,
        category: category || "manual",
        amount: totalD.toFixed(2),
        createdBy: (req as any).authUser?.id ?? null,
      }).returning();

      for (const l of lines) {
        const aid = Number(l.accountId);
        const acct = acctById.get(aid)!;
        const [existing] = await tx.select().from(trialBalanceDetailsTable)
          .where(and(
            eq(trialBalanceDetailsTable.trialBalanceId, id),
            eq(trialBalanceDetailsTable.accountId, aid),
          ));
        const dDelta = Number(l.debit  ?? 0);
        const cDelta = Number(l.credit ?? 0);
        if (existing) {
          await tx.update(trialBalanceDetailsTable).set({
            debit:  (Number(existing.debit)  + dDelta).toFixed(2),
            credit: (Number(existing.credit) + cDelta).toFixed(2),
          }).where(eq(trialBalanceDetailsTable.id, existing.id));
        } else {
          await tx.insert(trialBalanceDetailsTable).values({
            trialBalanceId: id,
            accountId: aid,
            accountCode: acct.code,
            accountName: acct.nameAr,
            debit: dDelta.toFixed(2), credit: cDelta.toFixed(2),
            originalDebit: "0", originalCredit: "0",
            changeReason: `إضافة من تسوية: ${description}`,
            isUnlinked: 0,
            sortOrder: 9999,
          });
        }
      }
      return { je, adj };
    });

    await recomputeTotals(id);
    await logAction(id, (req as any).authUser?.id ?? null, "add_adjustment", {
      adjustmentId: result.adj.id, journalEntryId: result.je.id, description, amount: totalD,
    });
    res.status(201).json({ adjustment: result.adj, journalEntryId: result.je.id });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── APPROVE ──────────────────────────────────────────────────────────────────
router.post("/:id/approve", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [header] = await db.select().from(trialBalancesTable)
      .where(and(eq(trialBalancesTable.id, id), eq(trialBalancesTable.companyId, cid)));
    if (!header) { res.status(404).json({ error: "ميزان المراجعة غير موجود" }); return; }
    if (header.status === "approved") {
      res.status(400).json({ error: "ميزان المراجعة معتمد بالفعل" }); return;
    }
    const td = Number(header.totalDebit);
    const tc = Number(header.totalCredit);
    if (Math.abs(td - tc) > 0.01) {
      res.status(400).json({ error: `الميزان غير متوازن — المدين ${td.toFixed(2)} ≠ الدائن ${tc.toFixed(2)}` });
      return;
    }
    const userId = (req as any).authUser?.id ?? null;
    const [row] = await db.update(trialBalancesTable).set({
      status: "approved",
      approvedBy: userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(trialBalancesTable.id, id)).returning();
    await logAction(id, userId, "approve", { totalDebit: td, totalCredit: tc });
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── CONVERT TO CLOSING ───────────────────────────────────────────────────────
router.post("/:id/convert-to-closing", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id  = Number(req.params.id);
    const [header] = await db.select().from(trialBalancesTable)
      .where(and(eq(trialBalancesTable.id, id), eq(trialBalancesTable.companyId, cid)));
    if (!header) { res.status(404).json({ error: "ميزان المراجعة غير موجود" }); return; }
    if (header.status !== "approved") {
      res.status(400).json({ error: "يجب اعتماد ميزان المراجعة أولاً قبل تحويله إلى ختامي" }); return;
    }
    const lines = await db.select().from(trialBalanceDetailsTable)
      .where(eq(trialBalanceDetailsTable.trialBalanceId, id));
    const userId = (req as any).authUser?.id ?? null;
    const [closing] = await db.insert(trialBalancesTable).values({
      companyId: cid,
      fiscalYearId: header.fiscalYearId,
      fiscalYear:   header.fiscalYear,
      periodStart:  header.periodStart,
      periodEnd:    header.periodEnd,
      balanceType:  "closing",
      status:       "draft",
      notes:        `محوّل من ميزان مراجعة #${id}`,
      totalDebit:   header.totalDebit,
      totalCredit:  header.totalCredit,
      sourceTrialBalanceId: id,
      createdBy:    userId,
    }).returning();
    if (lines.length > 0) {
      await db.insert(trialBalanceDetailsTable).values(
        lines.map(l => ({
          trialBalanceId: closing.id,
          accountId:      l.accountId,
          accountCode:    l.accountCode,
          accountName:    l.accountName,
          debit:          l.debit,
          credit:         l.credit,
          originalDebit:  l.debit,
          originalCredit: l.credit,
          isUnlinked:     l.isUnlinked,
          sortOrder:      l.sortOrder,
        }))
      );
    }
    await logAction(id, userId, "convert_to_closing", { newId: closing.id });
    await logAction(closing.id, userId, "create_from_closing", { sourceId: id });
    res.status(201).json(closing);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── REPORTS ──────────────────────────────────────────────────────────────────
router.get("/:id/report", async (req, res) => {
  try {
    const cid = getCompanyId(req);
    const id  = Number(req.params.id);
    const type = String(req.query.type ?? "detailed");
    const [header] = cid
      ? await db.select().from(trialBalancesTable)
          .where(and(eq(trialBalancesTable.id, id), eq(trialBalancesTable.companyId, cid)))
      : await db.select().from(trialBalancesTable).where(eq(trialBalancesTable.id, id));
    if (!header) { res.status(404).json({ error: "ميزان المراجعة غير موجود" }); return; }
    const details = await db.select().from(trialBalanceDetailsTable)
      .where(eq(trialBalanceDetailsTable.trialBalanceId, id))
      .orderBy(trialBalanceDetailsTable.sortOrder, trialBalanceDetailsTable.accountCode);

    if (type === "detailed") {
      res.json({ header, lines: details });
      return;
    }
    if (type === "summary") {
      // Group by account-type via chart lookup
      const accountIds = details.map(d => d.accountId).filter((x): x is number => !!x);
      let acctTypes = new Map<number, string>();
      if (accountIds.length > 0) {
        const accts = await db.select({
          id: accountsTable.id, accountType: accountsTable.accountType,
        }).from(accountsTable).where(inArray(accountsTable.id, accountIds));
        acctTypes = new Map(accts.map(a => [a.id, a.accountType ?? "other"]));
      }
      const groups: Record<string, { debit: number; credit: number; count: number }> = {};
      for (const d of details) {
        const t = (d.accountId && acctTypes.get(d.accountId)) || "other";
        if (!groups[t]) groups[t] = { debit: 0, credit: 0, count: 0 };
        groups[t].debit  += Number(d.debit);
        groups[t].credit += Number(d.credit);
        groups[t].count  += 1;
      }
      res.json({
        header,
        groups: Object.entries(groups).map(([type, v]) => ({
          accountType: type,
          totalDebit:  v.debit.toFixed(2),
          totalCredit: v.credit.toFixed(2),
          count:       v.count,
        })),
      });
      return;
    }
    if (type === "before-after") {
      res.json({
        header,
        lines: details.map(d => ({
          accountCode: d.accountCode, accountName: d.accountName,
          beforeDebit:  d.originalDebit, beforeCredit: d.originalCredit,
          afterDebit:   d.debit,        afterCredit:  d.credit,
          diffDebit:   (Number(d.debit)  - Number(d.originalDebit)).toFixed(2),
          diffCredit:  (Number(d.credit) - Number(d.originalCredit)).toFixed(2),
          changeReason: d.changeReason,
        })),
      });
      return;
    }
    if (type === "adjustments") {
      const adj = await db.select().from(trialBalanceAdjustmentsTable)
        .where(eq(trialBalanceAdjustmentsTable.trialBalanceId, id))
        .orderBy(desc(trialBalanceAdjustmentsTable.createdAt));
      res.json({ header, adjustments: adj });
      return;
    }
    res.status(400).json({ error: "نوع تقرير غير مدعوم" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
