// Employee Custody / Imprest (العُهد) — SAP-style lifecycle:
//   create → disburse (DR custody / CR cash|bank)
//          → settle expenses (DR expense / CR custody, one JE per line)
//          → return remaining (DR cash|bank / CR custody)
// Custody is NOT deducted from salary. remaining = amount - settled - returned.
import { Router } from "express";
import { db } from "@workspace/db";
import {
  employeeCustodiesTable,
  employeeCustodySettlementsTable,
  employeesTable,
  accountsTable,
  branchesTable,
  journalEntriesTable,
  journalEntryLinesTable,
  assetCustodiesTable,
  fixedAssetsTable,
} from "@workspace/db";
import { and, eq, desc, inArray, gte, lte } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import {
  buildCustodyDisbursementJournal,
  buildCustodySettlementJournal,
  buildCustodyReturnJournal,
} from "../lib/hr-journals.js";
import { dateOrNull, requireDate, requirePositiveMoney, respondHrError } from "../lib/hrValidate.js";

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

const N = (v: any) => (v == null || v === "" ? null : v);
const num = (v: any): number => Number(v ?? 0) || 0;
const remainingOf = (c: { amount: any; settledAmount: any; returnedAmount: any }): number =>
  +(num(c.amount) - num(c.settledAmount) - num(c.returnedAmount)).toFixed(2);

// ─── Tenant-boundary validators (reject cross-company foreign IDs) ─────────────
async function assertEmployeeInCompany(dx: any, cid: number, employeeId: number) {
  const [e] = await dx.select({ id: employeesTable.id }).from(employeesTable)
    .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid)));
  if (!e) throw Object.assign(new Error("الموظف غير موجود"), { status: 400 });
}
async function assertAccountInCompany(dx: any, cid: number, accountId: number) {
  const [a] = await dx.select({ id: accountsTable.id }).from(accountsTable)
    .where(and(eq(accountsTable.id, accountId), eq(accountsTable.companyId, cid)));
  if (!a) throw Object.assign(new Error("الحساب المحاسبي غير موجود"), { status: 400 });
}
async function assertBranchInCompany(dx: any, cid: number, branchId: number) {
  const [br] = await dx.select({ id: branchesTable.id }).from(branchesTable)
    .where(and(eq(branchesTable.id, branchId), eq(branchesTable.companyId, cid)));
  if (!br) throw Object.assign(new Error("الفرع غير موجود"), { status: 400 });
}

// ═══ ASSET CUSTODY (عهدة عينية) — administrative only, NO journal entry ═════
// Tracks delivery of a REGISTERED fixed asset to an employee. Delivering /
// returning syncs fixed_assets.custodian_employee_id. Routes are defined
// BEFORE the imprest /:id routes so the "asset" segment never hits them.
async function assertAssetInCompany(dx: any, cid: number, assetId: number) {
  const [a] = await dx.select({
    id: fixedAssetsTable.id,
    custodianEmployeeId: fixedAssetsTable.custodianEmployeeId,
  }).from(fixedAssetsTable)
    .where(and(eq(fixedAssetsTable.id, assetId), eq(fixedAssetsTable.companyId, cid)));
  if (!a) throw Object.assign(new Error("الأصل غير موجود"), { status: 400 });
  return a;
}

// LIST asset custodies (with employee + asset info) — also the report source.
router.get("/asset", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { employeeId, assetId, status, from, to } = req.query as any;
    const conds: any[] = [eq(assetCustodiesTable.companyId, cid)];
    if (employeeId) conds.push(eq(assetCustodiesTable.employeeId, Number(employeeId)));
    if (assetId) conds.push(eq(assetCustodiesTable.assetId, Number(assetId)));
    if (status) conds.push(eq(assetCustodiesTable.status, String(status)));
    if (from) conds.push(gte(assetCustodiesTable.deliveryDate, String(from)));
    if (to) conds.push(lte(assetCustodiesTable.deliveryDate, String(to)));
    const rows = await db.select({
      id: assetCustodiesTable.id,
      employeeId: assetCustodiesTable.employeeId,
      assetId: assetCustodiesTable.assetId,
      deliveryDate: assetCustodiesTable.deliveryDate,
      expectedReturnDate: assetCustodiesTable.expectedReturnDate,
      actualReturnDate: assetCustodiesTable.actualReturnDate,
      status: assetCustodiesTable.status,
      notes: assetCustodiesTable.notes,
      empCode: employeesTable.code,
      empNameAr: employeesTable.nameAr,
      empNameEn: employeesTable.nameEn,
      assetCode: fixedAssetsTable.code,
      assetNameAr: fixedAssetsTable.nameAr,
      assetNameEn: fixedAssetsTable.nameEn,
      assetValue: fixedAssetsTable.purchaseValue,
      assetBookValue: fixedAssetsTable.bookValue,
      assetLocation: fixedAssetsTable.location,
    }).from(assetCustodiesTable)
      .leftJoin(employeesTable, eq(employeesTable.id, assetCustodiesTable.employeeId))
      .leftJoin(fixedAssetsTable, eq(fixedAssetsTable.id, assetCustodiesTable.assetId))
      .where(and(...conds))
      .orderBy(desc(assetCustodiesTable.id));
    res.json(rows);
  } catch (e: any) { respondHrError(req, res, e); }
});

// CREATE — deliver an asset to an employee.
router.post("/asset", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body || {};
    const assetId = Number(b.assetId);
    if (!assetId) { res.status(400).json({ error: "الأصل مطلوب" }); return; }
    const deliveryDate = requireDate(b.deliveryDate, "تاريخ التسليم");
    const row = await db.transaction(async (tx) => {
      const asset = await assertAssetInCompany(tx, cid, assetId);
      // Employee: explicit pick wins; otherwise fall back to the asset's
      // currently-linked responsible employee.
      const employeeId = Number(b.employeeId) || Number(asset.custodianEmployeeId) || 0;
      if (!employeeId) { throw Object.assign(new Error("الموظف مطلوب"), { status: 400 }); }
      await assertEmployeeInCompany(tx, cid, employeeId);
      const [live] = await tx.select({ id: assetCustodiesTable.id }).from(assetCustodiesTable)
        .where(and(eq(assetCustodiesTable.assetId, assetId), eq(assetCustodiesTable.status, "delivered")));
      if (live) throw Object.assign(new Error("الأصل مسلَّم بالفعل في عهدة قائمة — أرجِعه أولًا"), { status: 409 });
      const [created] = await tx.insert(assetCustodiesTable).values({
        companyId: cid,
        employeeId,
        assetId,
        deliveryDate,
        expectedReturnDate: dateOrNull(b.expectedReturnDate, "تاريخ الإرجاع المتوقع"),
        notes: N(b.notes),
        status: "delivered",
      }).returning();
      // Sync the asset card's responsible employee.
      await tx.update(fixedAssetsTable)
        .set({ custodianEmployeeId: employeeId })
        .where(and(eq(fixedAssetsTable.id, assetId), eq(fixedAssetsTable.companyId, cid)));
      return created;
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === "23505") { res.status(409).json({ error: "الأصل مسلَّم بالفعل في عهدة قائمة" }); return; }
    respondHrError(req, res, e);
  }
});

// UPDATE — edit dates/notes (and employee while still delivered).
router.put("/asset/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const row = await db.transaction(async (tx) => {
      const [c] = await tx.select().from(assetCustodiesTable)
        .where(and(eq(assetCustodiesTable.id, id), eq(assetCustodiesTable.companyId, cid)));
      if (!c) throw Object.assign(new Error("غير موجود"), { status: 404 });
      const patch: any = { updatedAt: new Date() };
      if (b.deliveryDate !== undefined) patch.deliveryDate = requireDate(b.deliveryDate, "تاريخ التسليم");
      if (b.expectedReturnDate !== undefined) patch.expectedReturnDate = dateOrNull(b.expectedReturnDate, "تاريخ الإرجاع المتوقع");
      if (b.notes !== undefined) patch.notes = N(b.notes);
      if (b.employeeId !== undefined && Number(b.employeeId) !== c.employeeId) {
        if (c.status !== "delivered") throw Object.assign(new Error("لا يمكن تغيير الموظف بعد الإرجاع"), { status: 400 });
        const employeeId = Number(b.employeeId);
        await assertEmployeeInCompany(tx, cid, employeeId);
        patch.employeeId = employeeId;
        await tx.update(fixedAssetsTable)
          .set({ custodianEmployeeId: employeeId })
          .where(and(eq(fixedAssetsTable.id, c.assetId), eq(fixedAssetsTable.companyId, cid)));
      }
      const [updated] = await tx.update(assetCustodiesTable).set(patch)
        .where(and(eq(assetCustodiesTable.id, id), eq(assetCustodiesTable.companyId, cid)))
        .returning();
      return updated;
    });
    res.json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

// RETURN — mark returned + clear the asset link (if it still points at this employee).
router.post("/asset/:id/return", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const actualReturnDate = requireDate(b.actualReturnDate ?? new Date().toISOString().slice(0, 10), "تاريخ الإرجاع الفعلي");
    const row = await db.transaction(async (tx) => {
      const [c] = await tx.select().from(assetCustodiesTable)
        .where(and(eq(assetCustodiesTable.id, id), eq(assetCustodiesTable.companyId, cid)));
      if (!c) throw Object.assign(new Error("غير موجود"), { status: 404 });
      if (c.status !== "delivered") throw Object.assign(new Error("العهدة مُرجَعة بالفعل"), { status: 400 });
      const [updated] = await tx.update(assetCustodiesTable).set({
        status: "returned",
        actualReturnDate,
        notes: b.notes !== undefined ? N(b.notes) : c.notes,
        updatedAt: new Date(),
      }).where(and(eq(assetCustodiesTable.id, id), eq(assetCustodiesTable.companyId, cid)))
        .returning();
      // Clear the asset's responsible employee only if it still points here.
      await tx.update(fixedAssetsTable)
        .set({ custodianEmployeeId: null })
        .where(and(
          eq(fixedAssetsTable.id, c.assetId),
          eq(fixedAssetsTable.companyId, cid),
          eq(fixedAssetsTable.custodianEmployeeId, c.employeeId),
        ));
      return updated;
    });
    res.json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

// DELETE — remove the record; a live custody also unlinks the asset.
router.delete("/asset/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.transaction(async (tx) => {
      const [c] = await tx.select().from(assetCustodiesTable)
        .where(and(eq(assetCustodiesTable.id, id), eq(assetCustodiesTable.companyId, cid)));
      if (!c) throw Object.assign(new Error("غير موجود"), { status: 404 });
      if (c.status === "delivered") {
        await tx.update(fixedAssetsTable)
          .set({ custodianEmployeeId: null })
          .where(and(
            eq(fixedAssetsTable.id, c.assetId),
            eq(fixedAssetsTable.companyId, cid),
            eq(fixedAssetsTable.custodianEmployeeId, c.employeeId),
          ));
      }
      await tx.delete(assetCustodiesTable)
        .where(and(eq(assetCustodiesTable.id, id), eq(assetCustodiesTable.companyId, cid)));
    });
    res.json({ ok: true });
  } catch (e: any) { respondHrError(req, res, e); }
});

// ─── LIST ────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { employeeId, status } = req.query as any;
    const conds: any[] = [eq(employeeCustodiesTable.companyId, cid)];
    if (employeeId) conds.push(eq(employeeCustodiesTable.employeeId, Number(employeeId)));
    if (status) conds.push(eq(employeeCustodiesTable.status, String(status)));
    const rows = await db.select({
      id: employeeCustodiesTable.id,
      employeeId: employeeCustodiesTable.employeeId,
      branchId: employeeCustodiesTable.branchId,
      custodyDate: employeeCustodiesTable.custodyDate,
      amount: employeeCustodiesTable.amount,
      settledAmount: employeeCustodiesTable.settledAmount,
      returnedAmount: employeeCustodiesTable.returnedAmount,
      purpose: employeeCustodiesTable.purpose,
      notes: employeeCustodiesTable.notes,
      status: employeeCustodiesTable.status,
      custodyAccountId: employeeCustodiesTable.custodyAccountId,
      disbursementJournalId: employeeCustodiesTable.disbursementJournalId,
      empCode: employeesTable.code,
      empNameAr: employeesTable.nameAr,
      empNameEn: employeesTable.nameEn,
      empBankName: employeesTable.bankName,
      empBankIban: employeesTable.bankAccountIban,
    }).from(employeeCustodiesTable)
      .leftJoin(employeesTable, eq(employeesTable.id, employeeCustodiesTable.employeeId))
      .where(and(...conds))
      .orderBy(desc(employeeCustodiesTable.custodyDate), desc(employeeCustodiesTable.id));

    // Self-heal dangling disbursement links: if the disbursement JE was
    // deleted (e.g. an old wrong-sequence draft removed before the unpost
    // cascade existed), the custody still points at a dead JE id — which
    // hides the «صرف» button forever. Detect and clear those links here so
    // the screen repairs itself on next load.
    const jeIds = [...new Set(rows.map(r => r.disbursementJournalId).filter((v): v is number => v != null))];
    if (jeIds.length > 0) {
      const alive = await db.select({ id: journalEntriesTable.id }).from(journalEntriesTable)
        .where(and(eq(journalEntriesTable.companyId, cid), inArray(journalEntriesTable.id, jeIds)));
      const aliveSet = new Set(alive.map(a => a.id));
      const dangling = rows.filter(r => r.disbursementJournalId != null && !aliveSet.has(r.disbursementJournalId));
      if (dangling.length > 0) {
        await db.update(employeeCustodiesTable)
          .set({ disbursementJournalId: null, updatedAt: new Date() })
          .where(and(
            eq(employeeCustodiesTable.companyId, cid),
            inArray(employeeCustodiesTable.id, dangling.map(d => d.id)),
          ));
        for (const d of dangling) (d as any).disbursementJournalId = null;
      }
    }
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── CREATE (no JE until disbursed) ───────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body || {};
    if (!b.employeeId || !b.amount || !b.custodyDate) {
      res.status(400).json({ error: "الموظف والمبلغ والتاريخ مطلوبة" }); return;
    }
    const custodyDate = requireDate(b.custodyDate, "تاريخ العهدة");
    const amt = Number(requirePositiveMoney(b.amount, "مبلغ العهدة"));
    const [emp] = await db.select({ branchId: employeesTable.branchId }).from(employeesTable)
      .where(and(eq(employeesTable.id, Number(b.employeeId)), eq(employeesTable.companyId, cid)));
    if (!emp) { res.status(400).json({ error: "الموظف غير موجود" }); return; }
    if (b.branchId) await assertBranchInCompany(db, cid, Number(b.branchId));
    if (b.custodyAccountId) await assertAccountInCompany(db, cid, Number(b.custodyAccountId));
    const [row] = await db.insert(employeeCustodiesTable).values({
      companyId: cid,
      branchId: b.branchId ? Number(b.branchId) : (emp.branchId ?? null),
      employeeId: Number(b.employeeId),
      custodyDate,
      amount: String(amt),
      settledAmount: "0",
      returnedAmount: "0",
      purpose: N(b.purpose),
      notes: N(b.notes),
      status: "active",
      custodyAccountId: b.custodyAccountId ? Number(b.custodyAccountId) : null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

// ─── UPDATE (principal locked once disbursed) ─────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const [existing] = await db.select().from(employeeCustodiesTable)
      .where(and(eq(employeeCustodiesTable.id, id), eq(employeeCustodiesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "العهدة غير موجودة" }); return; }

    const upd: any = { purpose: N(b.purpose), notes: N(b.notes), updatedAt: new Date() };
    if (existing.disbursementJournalId) {
      // Disbursed: only descriptive fields are editable (changing employee /
      // amount / date / account would corrupt the posted disbursement JE).
    } else {
      if (b.employeeId) { await assertEmployeeInCompany(db, cid, Number(b.employeeId)); upd.employeeId = Number(b.employeeId); }
      if (b.custodyDate) upd.custodyDate = requireDate(b.custodyDate, "تاريخ العهدة");
      if (b.amount != null && b.amount !== "") {
        upd.amount = requirePositiveMoney(b.amount, "مبلغ العهدة");
      }
      if (b.branchId !== undefined) {
        if (b.branchId) await assertBranchInCompany(db, cid, Number(b.branchId));
        upd.branchId = b.branchId ? Number(b.branchId) : null;
      }
      if (b.custodyAccountId !== undefined) {
        if (b.custodyAccountId) await assertAccountInCompany(db, cid, Number(b.custodyAccountId));
        upd.custodyAccountId = b.custodyAccountId ? Number(b.custodyAccountId) : null;
      }
    }
    const [row] = await db.update(employeeCustodiesTable).set(upd)
      .where(and(eq(employeeCustodiesTable.id, id), eq(employeeCustodiesTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { respondHrError(req, res, e); }
});

// ─── DELETE (only undisbursed) ────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [existing] = await db.select().from(employeeCustodiesTable)
      .where(and(eq(employeeCustodiesTable.id, id), eq(employeeCustodiesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "العهدة غير موجودة" }); return; }
    if (existing.disbursementJournalId) {
      res.status(400).json({ error: "لا يمكن حذف عهدة مصروفة — احذف التسويات والقيد أولاً أو استخدم إرجاع الباقي" });
      return;
    }
    await db.delete(employeeCustodiesTable)
      .where(and(eq(employeeCustodiesTable.id, id), eq(employeeCustodiesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DISBURSE (DR custody / CR cash|bank) ─────────────────────────────────────
router.post("/:id/disburse", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const result = await db.transaction(async (tx) => {
      const [cust] = await tx.select().from(employeeCustodiesTable)
        .where(and(eq(employeeCustodiesTable.id, id), eq(employeeCustodiesTable.companyId, cid)))
        .for("update");
      if (!cust) throw Object.assign(new Error("العهدة غير موجودة"), { status: 404 });
      if (cust.disbursementJournalId) throw new Error("تم صرف هذه العهدة بالفعل");
      if (cust.status === "cancelled") throw new Error("العهدة ملغاة");
      const journalId = await buildCustodyDisbursementJournal(cid, id, {
        cashBoxId:     b.cashBoxId     ? Number(b.cashBoxId)     : null,
        bankAccountId: b.bankAccountId ? Number(b.bankAccountId) : null,
      }, tx);
      const [upd] = await tx.update(employeeCustodiesTable)
        .set({ disbursementJournalId: journalId, updatedAt: new Date() })
        .where(eq(employeeCustodiesTable.id, id)).returning();
      return { ...upd, journalId };
    });
    res.json(result);
  } catch (e: any) { res.status(e?.status || 400).json({ error: e.message }); }
});

// ─── SETTLEMENTS LIST ─────────────────────────────────────────────────────────
router.get("/:id/settlements", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const rows = await db.select({
      id: employeeCustodySettlementsTable.id,
      custodyId: employeeCustodySettlementsTable.custodyId,
      settleDate: employeeCustodySettlementsTable.settleDate,
      kind: employeeCustodySettlementsTable.kind,
      expenseAccountId: employeeCustodySettlementsTable.expenseAccountId,
      amount: employeeCustodySettlementsTable.amount,
      description: employeeCustodySettlementsTable.description,
      invoiceNumber: employeeCustodySettlementsTable.invoiceNumber,
      journalId: employeeCustodySettlementsTable.journalId,
      accountCode: accountsTable.code,
      accountNameAr: accountsTable.nameAr,
      accountNameEn: accountsTable.nameEn,
    }).from(employeeCustodySettlementsTable)
      .leftJoin(accountsTable, eq(accountsTable.id, employeeCustodySettlementsTable.expenseAccountId))
      .where(and(eq(employeeCustodySettlementsTable.custodyId, id), eq(employeeCustodySettlementsTable.companyId, cid)))
      .orderBy(desc(employeeCustodySettlementsTable.settleDate), desc(employeeCustodySettlementsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ADD EXPENSE SETTLEMENT (DR expense / CR custody) ─────────────────────────
router.post("/:id/settlements", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const result = await db.transaction(async (tx) => {
      const [cust] = await tx.select().from(employeeCustodiesTable)
        .where(and(eq(employeeCustodiesTable.id, id), eq(employeeCustodiesTable.companyId, cid)))
        .for("update");
      if (!cust) throw Object.assign(new Error("العهدة غير موجودة"), { status: 404 });
      if (!cust.disbursementJournalId) throw new Error("يجب صرف العهدة أولاً قبل التسوية");
      if (cust.status === "cancelled") throw new Error("العهدة ملغاة");
      const amt = Number(requirePositiveMoney(b.amount, "مبلغ التسوية"));
      if (!b.expenseAccountId) throw new Error("يجب اختيار حساب المصروف");
      await assertAccountInCompany(tx, cid, Number(b.expenseAccountId));
      if (!b.settleDate) throw new Error("تاريخ التسوية مطلوب");
      const settleDate = requireDate(b.settleDate, "تاريخ التسوية");
      const remaining = remainingOf(cust);
      if (amt > remaining + 0.005) throw new Error(`المبلغ أكبر من المتبقي (${remaining.toFixed(2)} ر.س)`);

      const [stl] = await tx.insert(employeeCustodySettlementsTable).values({
        companyId: cid,
        custodyId: id,
        settleDate,
        kind: "expense",
        expenseAccountId: Number(b.expenseAccountId),
        amount: String(amt),
        description: N(b.description),
        invoiceNumber: N(b.invoiceNumber),
      }).returning();
      const journalId = await buildCustodySettlementJournal(cid, stl.id, tx);
      await tx.update(employeeCustodySettlementsTable)
        .set({ journalId }).where(eq(employeeCustodySettlementsTable.id, stl.id));

      const newSettled = +(num(cust.settledAmount) + amt).toFixed(2);
      const newRemaining = +(num(cust.amount) - newSettled - num(cust.returnedAmount)).toFixed(2);
      await tx.update(employeeCustodiesTable).set({
        settledAmount: String(newSettled),
        status: newRemaining <= 0.005 ? "settled" : "active",
        updatedAt: new Date(),
      }).where(eq(employeeCustodiesTable.id, id));
      return { ...stl, journalId };
    });
    res.status(201).json(result);
  } catch (e: any) {
    if (e?.name === "HrValidationError") return respondHrError(req, res, e);
    res.status(e?.status || 400).json({ error: e.message });
  }
});

// ─── DELETE SETTLEMENT (reverses by removing its JE) ──────────────────────────
router.delete("/:id/settlements/:sid", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const sid = Number(req.params.sid);
    await db.transaction(async (tx) => {
      const [stl] = await tx.select().from(employeeCustodySettlementsTable)
        .where(and(eq(employeeCustodySettlementsTable.id, sid),
                   eq(employeeCustodySettlementsTable.custodyId, id),
                   eq(employeeCustodySettlementsTable.companyId, cid)));
      if (!stl) throw Object.assign(new Error("سطر التسوية غير موجود"), { status: 404 });
      const [cust] = await tx.select().from(employeeCustodiesTable)
        .where(and(eq(employeeCustodiesTable.id, id), eq(employeeCustodiesTable.companyId, cid)))
        .for("update");
      if (!cust) throw Object.assign(new Error("العهدة غير موجودة"), { status: 404 });

      // Remove the settlement row first, then erase its journal entry.
      await tx.delete(employeeCustodySettlementsTable)
        .where(eq(employeeCustodySettlementsTable.id, sid));
      if (stl.journalId) {
        await tx.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, stl.journalId));
        await tx.delete(journalEntriesTable)
          .where(and(eq(journalEntriesTable.id, stl.journalId), eq(journalEntriesTable.companyId, cid)));
      }

      const amt = num(stl.amount);
      const newSettled  = stl.kind === "expense" ? +(num(cust.settledAmount)  - amt).toFixed(2) : num(cust.settledAmount);
      const newReturned = stl.kind === "return"  ? +(num(cust.returnedAmount) - amt).toFixed(2) : num(cust.returnedAmount);
      const newRemaining = +(num(cust.amount) - newSettled - newReturned).toFixed(2);
      await tx.update(employeeCustodiesTable).set({
        settledAmount: String(Math.max(0, newSettled)),
        returnedAmount: String(Math.max(0, newReturned)),
        status: newRemaining <= 0.005 ? "settled" : "active",
        updatedAt: new Date(),
      }).where(eq(employeeCustodiesTable.id, id));
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status || 400).json({ error: e.message }); }
});

// ─── RETURN REMAINING (DR cash|bank / CR custody) ─────────────────────────────
router.post("/:id/return", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const result = await db.transaction(async (tx) => {
      const [cust] = await tx.select().from(employeeCustodiesTable)
        .where(and(eq(employeeCustodiesTable.id, id), eq(employeeCustodiesTable.companyId, cid)))
        .for("update");
      if (!cust) throw Object.assign(new Error("العهدة غير موجودة"), { status: 404 });
      if (!cust.disbursementJournalId) throw new Error("يجب صرف العهدة أولاً");
      if (cust.status === "cancelled") throw new Error("العهدة ملغاة");
      const remaining = remainingOf(cust);
      const amt = b.amount != null && b.amount !== "" ? Number(b.amount) : remaining;
      if (!(amt > 0)) throw new Error("لا يوجد مبلغ متبقٍ للإرجاع");
      if (amt > remaining + 0.005) throw new Error(`المبلغ أكبر من المتبقي (${remaining.toFixed(2)} ر.س)`);
      const returnDate = dateOrNull(b.returnDate, "تاريخ الإرجاع") || new Date().toISOString().slice(0, 10);

      const journalId = await buildCustodyReturnJournal(cid, id, amt, returnDate, {
        cashBoxId:     b.cashBoxId     ? Number(b.cashBoxId)     : null,
        bankAccountId: b.bankAccountId ? Number(b.bankAccountId) : null,
      }, tx);

      const [stl] = await tx.insert(employeeCustodySettlementsTable).values({
        companyId: cid,
        custodyId: id,
        settleDate: returnDate,
        kind: "return",
        expenseAccountId: null,
        amount: String(amt),
        description: N(b.description) ?? "إرجاع باقي العهدة",
        invoiceNumber: null,
        journalId,
      }).returning();

      const newReturned = +(num(cust.returnedAmount) + amt).toFixed(2);
      const newRemaining = +(num(cust.amount) - num(cust.settledAmount) - newReturned).toFixed(2);
      await tx.update(employeeCustodiesTable).set({
        returnedAmount: String(newReturned),
        status: newRemaining <= 0.005 ? "settled" : "active",
        updatedAt: new Date(),
      }).where(eq(employeeCustodiesTable.id, id));
      return { ...stl, journalId };
    });
    res.json(result);
  } catch (e: any) {
    if (e?.name === "HrValidationError") return respondHrError(req, res, e);
    res.status(e?.status || 400).json({ error: e.message });
  }
});

export default router;
