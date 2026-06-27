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
} from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import {
  buildCustodyDisbursementJournal,
  buildCustodySettlementJournal,
  buildCustodyReturnJournal,
} from "../lib/hr-journals.js";

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
    const amt = Number(b.amount);
    if (!(amt > 0)) { res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر" }); return; }
    const [emp] = await db.select({ branchId: employeesTable.branchId }).from(employeesTable)
      .where(and(eq(employeesTable.id, Number(b.employeeId)), eq(employeesTable.companyId, cid)));
    if (!emp) { res.status(400).json({ error: "الموظف غير موجود" }); return; }
    if (b.branchId) await assertBranchInCompany(db, cid, Number(b.branchId));
    if (b.custodyAccountId) await assertAccountInCompany(db, cid, Number(b.custodyAccountId));
    const [row] = await db.insert(employeeCustodiesTable).values({
      companyId: cid,
      branchId: b.branchId ? Number(b.branchId) : (emp.branchId ?? null),
      employeeId: Number(b.employeeId),
      custodyDate: b.custodyDate,
      amount: String(amt),
      settledAmount: "0",
      returnedAmount: "0",
      purpose: N(b.purpose),
      notes: N(b.notes),
      status: "active",
      custodyAccountId: b.custodyAccountId ? Number(b.custodyAccountId) : null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
      if (b.custodyDate) upd.custodyDate = b.custodyDate;
      if (b.amount != null && b.amount !== "") {
        const amt = Number(b.amount);
        if (!(amt > 0)) { res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر" }); return; }
        upd.amount = String(amt);
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
      const amt = Number(b.amount);
      if (!(amt > 0)) throw new Error("مبلغ التسوية مطلوب");
      if (!b.expenseAccountId) throw new Error("يجب اختيار حساب المصروف");
      await assertAccountInCompany(tx, cid, Number(b.expenseAccountId));
      if (!b.settleDate) throw new Error("تاريخ التسوية مطلوب");
      const remaining = remainingOf(cust);
      if (amt > remaining + 0.005) throw new Error(`المبلغ أكبر من المتبقي (${remaining.toFixed(2)} ر.س)`);

      const [stl] = await tx.insert(employeeCustodySettlementsTable).values({
        companyId: cid,
        custodyId: id,
        settleDate: b.settleDate,
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
  } catch (e: any) { res.status(e?.status || 400).json({ error: e.message }); }
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
      const returnDate = String(b.returnDate || new Date().toISOString().slice(0, 10));

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
  } catch (e: any) { res.status(e?.status || 400).json({ error: e.message }); }
});

export default router;
