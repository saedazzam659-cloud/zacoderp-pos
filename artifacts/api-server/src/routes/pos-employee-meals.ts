import { Router } from "express";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  accountsTable, db, employeesTable, posEmployeeMealsTable,
  posEmployeeMealSettingsTable, usersTable,
} from "@workspace/db";
import { extractAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { createJournalEntry } from "./sales.js";

const router = Router();
const MEAL_TYPES = new Set(["إفطار", "غداء", "عشاء", "وجبة إضافية"]);
router.use(extractAuth);
router.use((req: any, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});
router.use((req: any, res, next) => {
  const companyId = Number(req.authUser.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(403).json({ error: "اختر شركة أولاً" }); return; }
  next();
});

router.use((req: any, res, next) => {
  const action = req.method === "GET" ? "view" : req.method === "POST" ? "create" : "edit";
  requirePermission("pos_cashier", action)(req, res, next);
});

router.get("/settings", async (req: any, res) => {
  const companyId = Number(req.authUser.companyId);
  const [settings] = await db.select().from(posEmployeeMealSettingsTable)
    .where(eq(posEmployeeMealSettingsTable.companyId, companyId)).limit(1);
  res.json(settings ?? null);
});

router.put("/settings", async (req: any, res) => {
  const user = req.authUser;
  if (!["admin", "superadmin"].includes(user.role)) { res.status(403).json({ error: "إعداد الوجبات متاح لمدير الشركة فقط" }); return; }
  const companyId = Number(user.companyId);
  const dailyLimit = Number(req.body?.dailyLimit);
  const unitCost = Number(req.body?.unitCost);
  const expenseAccountId = Number(req.body?.expenseAccountId);
  const clearingAccountId = Number(req.body?.clearingAccountId);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 20 ||
      !Number.isFinite(unitCost) || unitCost <= 0 || Math.round(unitCost * 100) !== unitCost * 100 ||
      !Number.isInteger(expenseAccountId) || !Number.isInteger(clearingAccountId) ||
      expenseAccountId === clearingAccountId) {
    res.status(400).json({ error: "أدخل حداً يومياً وتكلفة وحسابي مصروف وتسوية صالحين" }); return;
  }
  const rows = await db.select().from(accountsTable).where(and(
    eq(accountsTable.companyId, companyId),
    sql`${accountsTable.id} IN (${expenseAccountId}, ${clearingAccountId})`,
    eq(accountsTable.isActive, true), eq(accountsTable.isPosting, true),
  ));
  const expense = rows.find((row) => row.id === expenseAccountId);
  const clearing = rows.find((row) => row.id === clearingAccountId);
  if (!expense || expense.accountType !== "expense" || !clearing) {
    res.status(400).json({ error: "حساب المصروف يجب أن يكون حساب مصروف نشطاً، وحساب التسوية نشطاً وقابلاً للترحيل" }); return;
  }
  const values = { companyId, dailyLimit, unitCost: unitCost.toFixed(2), expenseAccountId, clearingAccountId, updatedByUserId: user.id, updatedAt: new Date() };
  const [saved] = await db.insert(posEmployeeMealSettingsTable).values(values)
    .onConflictDoUpdate({ target: posEmployeeMealSettingsTable.companyId, set: values }).returning();
  res.json(saved);
});

router.get("/employees", async (req: any, res) => {
  const companyId = Number(req.authUser.companyId);
  const rows = await db.select({ id: employeesTable.id, code: employeesTable.code, nameAr: employeesTable.nameAr, department: employeesTable.department, jobTitle: employeesTable.jobTitle })
    .from(employeesTable).where(and(eq(employeesTable.companyId, companyId), eq(employeesTable.status, "active")))
    .orderBy(employeesTable.nameAr).limit(2000);
  res.json(rows);
});

router.get("/", async (req: any, res) => {
  const companyId = Number(req.authUser.companyId);
  const from = String(req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const to = String(req.query.to || new Date().toISOString().slice(0, 10));
  const rows = await db.select({
    meal: posEmployeeMealsTable,
    employee: { id: employeesTable.id, code: employeesTable.code, nameAr: employeesTable.nameAr },
    creator: { id: usersTable.id, nameAr: usersTable.nameAr, username: usersTable.username },
  }).from(posEmployeeMealsTable)
    .innerJoin(employeesTable, eq(posEmployeeMealsTable.employeeId, employeesTable.id))
    .leftJoin(usersTable, eq(posEmployeeMealsTable.createdByUserId, usersTable.id))
    .where(and(eq(posEmployeeMealsTable.companyId, companyId), gte(posEmployeeMealsTable.mealDate, from), lte(posEmployeeMealsTable.mealDate, to)))
    .orderBy(desc(posEmployeeMealsTable.mealDate), desc(posEmployeeMealsTable.createdAt)).limit(1000);
  res.json(rows.map((row) => ({ ...row.meal, employee: row.employee, creator: row.creator })));
});

router.post("/", async (req: any, res) => {
  const user = req.authUser;
  const companyId = Number(user.companyId);
  const employeeId = Number(req.body?.employeeId);
  const mealDate = String(req.body?.date || "");
  const mealType = String(req.body?.mealType || "").trim().slice(0, 40);
  const count = Number(req.body?.count);
  const parsedDate = new Date(`${mealDate}T00:00:00.000Z`);
  if (!Number.isInteger(employeeId) || !/^\d{4}-\d{2}-\d{2}$/.test(mealDate) || !MEAL_TYPES.has(mealType) ||
      !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== mealDate ||
      !Number.isInteger(count) || count < 1 || count > 20) {
    res.status(400).json({ error: "بيانات صرف الوجبة غير صالحة" }); return;
  }
  try {
    const created = await db.transaction(async (tx) => {
      const [settings] = await tx.select().from(posEmployeeMealSettingsTable)
        .where(eq(posEmployeeMealSettingsTable.companyId, companyId)).limit(1);
      if (!settings) throw Object.assign(new Error("يجب إعداد حد الوجبات والتكلفة والحسابات أولاً"), { status: 400 });
      const [employee] = await tx.select({ id: employeesTable.id, nameAr: employeesTable.nameAr })
        .from(employeesTable).where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, companyId), eq(employeesTable.status, "active")))
        .for("update").limit(1);
      if (!employee) throw Object.assign(new Error("الموظف غير موجود أو غير نشط"), { status: 404 });
      const [daily] = await tx.select({ count: sql<number>`COALESCE(SUM(${posEmployeeMealsTable.count}), 0)::int` })
        .from(posEmployeeMealsTable).where(and(eq(posEmployeeMealsTable.companyId, companyId), eq(posEmployeeMealsTable.employeeId, employeeId), eq(posEmployeeMealsTable.mealDate, mealDate)));
      if (Number(daily?.count || 0) + count > settings.dailyLimit) {
        throw Object.assign(new Error(`تجاوز الحد اليومي (${settings.dailyLimit} وجبة)`), { status: 409 });
      }
      const totalCost = Number(settings.unitCost) * count;
      const [meal] = await tx.insert(posEmployeeMealsTable).values({
        companyId, employeeId, mealDate, mealType, count,
        unitCost: settings.unitCost, totalCost: totalCost.toFixed(2),
        expenseAccountId: settings.expenseAccountId, clearingAccountId: settings.clearingAccountId,
        createdByUserId: user.id,
      }).returning();
      const journalEntryId = await createJournalEntry({
        companyId, date: mealDate, branchId: user.branchId ?? null,
        description: `وجبات موظف ${employee.nameAr} — ${mealType} — ${count}`,
        entryType: "pos_employee_meal", sourceType: "pos_employee_meal", sourceId: meal.id,
        postingDocType: "draft",
        audit: { req }, executor: tx,
        lines: [
          { accountId: settings.expenseAccountId, debit: totalCost, credit: 0, description: `مصروف وجبات ${employee.nameAr} - ${mealType}` },
          { accountId: settings.clearingAccountId, debit: 0, credit: totalCost, description: `تسوية وجبات ${employee.nameAr} - ${mealType}` },
        ],
      });
      const [saved] = await tx.update(posEmployeeMealsTable).set({ journalEntryId })
        .where(eq(posEmployeeMealsTable.id, meal.id)).returning();
      return saved;
    });
    res.status(201).json(created);
  } catch (error: any) {
    if (error?.code === "23505") { res.status(409).json({ error: "سُجلت هذه الوجبة للموظف في اليوم نفسه من قبل" }); return; }
    res.status(error?.status ?? 500).json({ error: error?.message || "تعذّر تسجيل الوجبة" });
  }
});

export default router;
