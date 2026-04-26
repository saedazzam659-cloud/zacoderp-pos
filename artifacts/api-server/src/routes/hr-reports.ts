import { Router } from "express";
import { db } from "@workspace/db";
import {
  employeesTable,
  employeeContractsTable,
  employeeAttendanceTable,
  employeeLoansTable,
  employeeLeavesTable,
  payrollRunsTable,
  payrollLinesTable,
} from "@workspace/db";
import { and, eq, gte, lte, desc, asc, sql, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

function num(v: any): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function daysBetween(a?: string | Date | null, b?: string | Date | null): number | null {
  if (!a || !b) return null;
  const da = new Date(a).getTime();
  const db2 = new Date(b).getTime();
  if (!Number.isFinite(da) || !Number.isFinite(db2)) return null;
  return Math.ceil((db2 - da) / (1000 * 60 * 60 * 24));
}

// ────────────────────────────────────────────────────────────────────
// 1) Employees report — list + summary stats
// GET /api/hr/reports/employees?status=active|inactive|all&department=...
// ────────────────────────────────────────────────────────────────────
router.get("/employees", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const status = String(req.query.status || "all");
    const department = String(req.query.department || "").trim();

    const where = [eq(employeesTable.companyId, cid)];
    if (status !== "all") where.push(eq(employeesTable.status, status));
    if (department) where.push(eq(employeesTable.department, department));

    const rows = await db.select().from(employeesTable)
      .where(and(...where))
      .orderBy(asc(employeesTable.code));

    const summary = {
      total: rows.length,
      active: rows.filter(r => r.status === "active").length,
      inactive: rows.filter(r => r.status !== "active").length,
      saudis: rows.filter(r => (r.nationality || "").includes("سعود")).length,
      nonSaudis: rows.filter(r => !(r.nationality || "").includes("سعود")).length,
      totalBasicSalary: rows.reduce((s, r) => s + num(r.basicSalary), 0),
      totalAllowances: rows.reduce((s, r) =>
        s + num(r.housingAllow) + num(r.transportAllow) + num(r.otherAllow), 0),
      totalGross: rows.reduce((s, r) =>
        s + num(r.basicSalary) + num(r.housingAllow) + num(r.transportAllow) + num(r.otherAllow), 0),
      departments: Array.from(new Set(rows.map(r => r.department).filter(Boolean))) as string[],
    };

    res.json({ summary, rows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ في تقرير الموظفين" });
  }
});

// ────────────────────────────────────────────────────────────────────
// 2) Payroll report — aggregate over a period (year/months)
// GET /api/hr/reports/payroll?year=2025&monthFrom=1&monthTo=12&employeeId=
// ────────────────────────────────────────────────────────────────────
router.get("/payroll", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    const monthFrom = req.query.monthFrom ? Number(req.query.monthFrom) : 1;
    const monthTo = req.query.monthTo ? Number(req.query.monthTo) : 12;
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;

    const runs = await db.select().from(payrollRunsTable)
      .where(and(
        eq(payrollRunsTable.companyId, cid),
        eq(payrollRunsTable.year, year),
        gte(payrollRunsTable.month, monthFrom),
        lte(payrollRunsTable.month, monthTo),
      ))
      .orderBy(asc(payrollRunsTable.month));

    const runIds = runs.map(r => r.id);
    let lines: any[] = [];
    if (runIds.length > 0) {
      const wh = [inArray(payrollLinesTable.payrollRunId, runIds)];
      if (employeeId) wh.push(eq(payrollLinesTable.employeeId, employeeId));
      lines = await db.select({
        id: payrollLinesTable.id,
        runId: payrollLinesTable.payrollRunId,
        employeeId: payrollLinesTable.employeeId,
        basicSalary: payrollLinesTable.basicSalary,
        housingAllow: payrollLinesTable.housingAllow,
        transportAllow: payrollLinesTable.transportAllow,
        otherAllow: payrollLinesTable.otherAllow,
        overtimeAmount: payrollLinesTable.overtimeAmount,
        bonusAmount: payrollLinesTable.bonusAmount,
        grossSalary: payrollLinesTable.grossSalary,
        gosiEmployee: payrollLinesTable.gosiEmployee,
        loanDeduction: payrollLinesTable.loanDeduction,
        absenceDeduction: payrollLinesTable.absenceDeduction,
        otherDeduction: payrollLinesTable.otherDeduction,
        totalDeductions: payrollLinesTable.totalDeductions,
        netSalary: payrollLinesTable.netSalary,
        absentDays: payrollLinesTable.absentDays,
        empCode: employeesTable.code,
        empName: employeesTable.nameAr,
        empDept: employeesTable.department,
        empJob: employeesTable.jobTitle,
      })
        .from(payrollLinesTable)
        .leftJoin(employeesTable, eq(payrollLinesTable.employeeId, employeesTable.id))
        .where(and(...wh));
    }

    // group by employee for the period
    const byEmployee = new Map<number, any>();
    for (const l of lines) {
      const k = l.employeeId;
      if (!byEmployee.has(k)) {
        byEmployee.set(k, {
          employeeId: k, empCode: l.empCode, empName: l.empName,
          department: l.empDept, jobTitle: l.empJob,
          months: 0, gross: 0, deductions: 0, net: 0,
          gosi: 0, loans: 0, absence: 0, overtime: 0, bonus: 0,
        });
      }
      const e = byEmployee.get(k);
      e.months += 1;
      e.gross += num(l.grossSalary);
      e.deductions += num(l.totalDeductions);
      e.net += num(l.netSalary);
      e.gosi += num(l.gosiEmployee);
      e.loans += num(l.loanDeduction);
      e.absence += num(l.absenceDeduction);
      e.overtime += num(l.overtimeAmount);
      e.bonus += num(l.bonusAmount);
    }
    const employeeRows = Array.from(byEmployee.values()).sort((a, b) => b.net - a.net);

    const summary = {
      runsCount: runs.length,
      employeesCount: employeeRows.length,
      totalGross: employeeRows.reduce((s, e) => s + e.gross, 0),
      totalDeductions: employeeRows.reduce((s, e) => s + e.deductions, 0),
      totalNet: employeeRows.reduce((s, e) => s + e.net, 0),
      totalGosi: employeeRows.reduce((s, e) => s + e.gosi, 0),
      totalLoans: employeeRows.reduce((s, e) => s + e.loans, 0),
      totalOvertime: employeeRows.reduce((s, e) => s + e.overtime, 0),
      totalBonus: employeeRows.reduce((s, e) => s + e.bonus, 0),
      averageNet: employeeRows.length
        ? employeeRows.reduce((s, e) => s + e.net, 0) / employeeRows.length
        : 0,
      runs: runs.map(r => ({
        id: r.id, code: r.code, year: r.year, month: r.month,
        status: r.status, totalGross: num(r.totalGross), totalNet: num(r.totalNet),
        employeesCount: r.employeesCount,
      })),
    };

    res.json({ summary, employees: employeeRows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ في تقرير الرواتب" });
  }
});

// ────────────────────────────────────────────────────────────────────
// 3) Attendance report — aggregate over a date range, per employee
// GET /api/hr/reports/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD&employeeId=
// ────────────────────────────────────────────────────────────────────
router.get("/attendance", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const from = String(req.query.from || "");
    const to   = String(req.query.to || "");
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;

    if (!from || !to) {
      res.status(400).json({ error: "حقل (من) و (إلى) مطلوبان" });
      return;
    }

    const where = [
      eq(employeeAttendanceTable.companyId, cid),
      gte(employeeAttendanceTable.date, from),
      lte(employeeAttendanceTable.date, to),
    ];
    if (employeeId) where.push(eq(employeeAttendanceTable.employeeId, employeeId));

    const rows = await db.select({
      id: employeeAttendanceTable.id,
      employeeId: employeeAttendanceTable.employeeId,
      date: employeeAttendanceTable.date,
      checkIn: employeeAttendanceTable.checkIn,
      checkOut: employeeAttendanceTable.checkOut,
      workedHours: employeeAttendanceTable.workedHours,
      overtimeHours: employeeAttendanceTable.overtimeHours,
      lateMinutes: employeeAttendanceTable.lateMinutes,
      status: employeeAttendanceTable.status,
      empCode: employeesTable.code,
      empName: employeesTable.nameAr,
      empDept: employeesTable.department,
    })
      .from(employeeAttendanceTable)
      .leftJoin(employeesTable, eq(employeeAttendanceTable.employeeId, employeesTable.id))
      .where(and(...where))
      .orderBy(asc(employeeAttendanceTable.date));

    const byEmployee = new Map<number, any>();
    for (const r of rows) {
      const k = r.employeeId;
      if (!byEmployee.has(k)) {
        byEmployee.set(k, {
          employeeId: k, empCode: r.empCode, empName: r.empName, department: r.empDept,
          present: 0, absent: 0, leave: 0, holiday: 0, late: 0,
          workedHours: 0, overtimeHours: 0, lateMinutes: 0, totalDays: 0,
        });
      }
      const e = byEmployee.get(k);
      e.totalDays += 1;
      const st = String(r.status || "").toLowerCase();
      if (st === "present") e.present += 1;
      else if (st === "absent") e.absent += 1;
      else if (st === "leave") e.leave += 1;
      else if (st === "holiday") e.holiday += 1;
      else if (st === "late") { e.present += 1; e.late += 1; }
      else e.present += 1;
      e.workedHours += num(r.workedHours);
      e.overtimeHours += num(r.overtimeHours);
      e.lateMinutes += num(r.lateMinutes);
    }
    const employeeRows = Array.from(byEmployee.values()).sort((a, b) => b.absent - a.absent);

    const summary = {
      totalRecords: rows.length,
      employeesCount: employeeRows.length,
      totalPresent: employeeRows.reduce((s, e) => s + e.present, 0),
      totalAbsent: employeeRows.reduce((s, e) => s + e.absent, 0),
      totalLeave: employeeRows.reduce((s, e) => s + e.leave, 0),
      totalHoliday: employeeRows.reduce((s, e) => s + e.holiday, 0),
      totalLate: employeeRows.reduce((s, e) => s + e.late, 0),
      totalWorkedHours: employeeRows.reduce((s, e) => s + e.workedHours, 0),
      totalOvertimeHours: employeeRows.reduce((s, e) => s + e.overtimeHours, 0),
      avgAttendanceRate: employeeRows.length
        ? (employeeRows.reduce((s, e) => s + (e.totalDays ? e.present / e.totalDays : 0), 0) / employeeRows.length) * 100
        : 0,
    };

    res.json({ summary, employees: employeeRows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ في تقرير الحضور" });
  }
});

// ────────────────────────────────────────────────────────────────────
// 4) Contracts report — list + status breakdown + expiring soon
// GET /api/hr/reports/contracts?status=active|expired|all&expiringDays=60
// ────────────────────────────────────────────────────────────────────
router.get("/contracts", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const status = String(req.query.status || "all");
    const expiringDays = req.query.expiringDays ? Number(req.query.expiringDays) : null;

    const where = [eq(employeeContractsTable.companyId, cid)];
    if (status !== "all") where.push(eq(employeeContractsTable.status, status));

    const rows = await db.select({
      id: employeeContractsTable.id,
      employeeId: employeeContractsTable.employeeId,
      contractNumber: employeeContractsTable.contractNumber,
      contractType: employeeContractsTable.contractType,
      startDate: employeeContractsTable.startDate,
      endDate: employeeContractsTable.endDate,
      basicSalary: employeeContractsTable.basicSalary,
      housingAllow: employeeContractsTable.housingAllow,
      transportAllow: employeeContractsTable.transportAllow,
      otherAllow: employeeContractsTable.otherAllow,
      status: employeeContractsTable.status,
      empCode: employeesTable.code,
      empName: employeesTable.nameAr,
      empDept: employeesTable.department,
      empJob: employeesTable.jobTitle,
    })
      .from(employeeContractsTable)
      .leftJoin(employeesTable, eq(employeeContractsTable.employeeId, employeesTable.id))
      .where(and(...where))
      .orderBy(desc(employeeContractsTable.startDate));

    const today = new Date().toISOString().slice(0, 10);
    const enriched = rows.map(r => {
      const remaining = r.endDate ? daysBetween(today, r.endDate) : null;
      return {
        ...r,
        gross: num(r.basicSalary) + num(r.housingAllow) + num(r.transportAllow) + num(r.otherAllow),
        remainingDays: remaining,
        isExpired: r.endDate ? (remaining !== null && remaining < 0) : false,
        isExpiringSoon: r.endDate && remaining !== null && remaining >= 0 &&
          (expiringDays ? remaining <= expiringDays : remaining <= 60),
      };
    });

    const summary = {
      total: enriched.length,
      active: enriched.filter(r => r.status === "active").length,
      expired: enriched.filter(r => r.isExpired).length,
      expiringSoon: enriched.filter(r => r.isExpiringSoon).length,
      fixed: enriched.filter(r => r.contractType === "fixed").length,
      indefinite: enriched.filter(r => r.contractType === "indefinite").length,
      totalGross: enriched.filter(r => r.status === "active").reduce((s, r) => s + r.gross, 0),
    };

    res.json({ summary, rows: enriched });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ في تقرير العقود" });
  }
});

// ────────────────────────────────────────────────────────────────────
// 5) Documents expiry — Iqama + Passport for active employees
// GET /api/hr/reports/documents-expiry?days=90
// ────────────────────────────────────────────────────────────────────
router.get("/documents-expiry", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const days = req.query.days ? Number(req.query.days) : 90;

    const employees = await db.select().from(employeesTable)
      .where(and(
        eq(employeesTable.companyId, cid),
        eq(employeesTable.status, "active"),
      ));

    const today = new Date().toISOString().slice(0, 10);
    const docs: any[] = [];
    for (const e of employees) {
      if (e.iqamaExpiry) {
        const remaining = daysBetween(today, e.iqamaExpiry);
        docs.push({
          employeeId: e.id, empCode: e.code, empName: e.nameAr,
          department: e.department, nationality: e.nationality,
          docType: "iqama", docTypeAr: "إقامة",
          docNumber: e.idNumber, expiryDate: e.iqamaExpiry,
          remainingDays: remaining,
          isExpired: remaining !== null && remaining < 0,
          isExpiringSoon: remaining !== null && remaining >= 0 && remaining <= days,
        });
      }
      if (e.passportExpiry) {
        const remaining = daysBetween(today, e.passportExpiry);
        docs.push({
          employeeId: e.id, empCode: e.code, empName: e.nameAr,
          department: e.department, nationality: e.nationality,
          docType: "passport", docTypeAr: "جواز سفر",
          docNumber: e.passportNumber, expiryDate: e.passportExpiry,
          remainingDays: remaining,
          isExpired: remaining !== null && remaining < 0,
          isExpiringSoon: remaining !== null && remaining >= 0 && remaining <= days,
        });
      }
    }

    docs.sort((a, b) => {
      const ra = a.remainingDays ?? Infinity;
      const rb = b.remainingDays ?? Infinity;
      return ra - rb;
    });

    const summary = {
      total: docs.length,
      expired: docs.filter(d => d.isExpired).length,
      expiringSoon: docs.filter(d => d.isExpiringSoon).length,
      iqamaExpired: docs.filter(d => d.docType === "iqama" && d.isExpired).length,
      iqamaExpiring: docs.filter(d => d.docType === "iqama" && d.isExpiringSoon).length,
      passportExpired: docs.filter(d => d.docType === "passport" && d.isExpired).length,
      passportExpiring: docs.filter(d => d.docType === "passport" && d.isExpiringSoon).length,
    };

    res.json({ summary, rows: docs });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ في تقرير الوثائق" });
  }
});

// ────────────────────────────────────────────────────────────────────
// 6) Loans report — all loans with progress
// GET /api/hr/reports/loans?status=active|closed|all
// ────────────────────────────────────────────────────────────────────
router.get("/loans", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const status = String(req.query.status || "all");

    const where = [eq(employeeLoansTable.companyId, cid)];
    if (status !== "all") where.push(eq(employeeLoansTable.status, status));

    const rows = await db.select({
      id: employeeLoansTable.id,
      employeeId: employeeLoansTable.employeeId,
      loanDate: employeeLoansTable.loanDate,
      loanType: employeeLoansTable.loanType,
      amount: employeeLoansTable.amount,
      installments: employeeLoansTable.installments,
      installmentAmt: employeeLoansTable.installmentAmt,
      paidAmount: employeeLoansTable.paidAmount,
      status: employeeLoansTable.status,
      empCode: employeesTable.code,
      empName: employeesTable.nameAr,
      empDept: employeesTable.department,
    })
      .from(employeeLoansTable)
      .leftJoin(employeesTable, eq(employeeLoansTable.employeeId, employeesTable.id))
      .where(and(...where))
      .orderBy(desc(employeeLoansTable.loanDate));

    const enriched = rows.map(r => {
      const amount = num(r.amount);
      const paid = num(r.paidAmount);
      const remaining = Math.max(0, amount - paid);
      const monthsRemaining = num(r.installmentAmt) > 0 ? Math.ceil(remaining / num(r.installmentAmt)) : 0;
      return {
        ...r,
        amountNum: amount,
        paidNum: paid,
        remaining,
        progressPct: amount > 0 ? (paid / amount) * 100 : 0,
        monthsRemaining,
      };
    });

    const summary = {
      total: enriched.length,
      active: enriched.filter(r => r.status === "active").length,
      closed: enriched.filter(r => r.status === "closed").length,
      totalAmount: enriched.reduce((s, r) => s + r.amountNum, 0),
      totalPaid: enriched.reduce((s, r) => s + r.paidNum, 0),
      totalRemaining: enriched.reduce((s, r) => s + r.remaining, 0),
      activeRemaining: enriched.filter(r => r.status === "active").reduce((s, r) => s + r.remaining, 0),
    };

    res.json({ summary, rows: enriched });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ في تقرير القروض" });
  }
});

// ────────────────────────────────────────────────────────────────────
// 7) End-of-Service report — terminated employees + EOS estimate
// GET /api/hr/reports/eos?from=YYYY-MM-DD&to=YYYY-MM-DD
// (also includes all-time list of terminated employees if no dates)
// ────────────────────────────────────────────────────────────────────
router.get("/eos", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");

    const where = [
      eq(employeesTable.companyId, cid),
      eq(employeesTable.status, "inactive"),
    ];
    if (from) where.push(gte(employeesTable.endDate, from));
    if (to) where.push(lte(employeesTable.endDate, to));

    const rows = await db.select().from(employeesTable)
      .where(and(...where))
      .orderBy(desc(employeesTable.endDate));

    const enriched = rows.map(e => {
      const yearsServed = (e.hireDate && e.endDate)
        ? (daysBetween(e.hireDate, e.endDate) ?? 0) / 365
        : null;
      const monthlyGross = num(e.basicSalary) + num(e.housingAllow) +
        num(e.transportAllow) + num(e.otherAllow);
      let eosEstimate = 0;
      if (yearsServed && yearsServed > 0) {
        const halfMonthYears = Math.min(5, yearsServed);
        const fullMonthYears = Math.max(0, yearsServed - 5);
        eosEstimate = (halfMonthYears * (monthlyGross / 2)) + (fullMonthYears * monthlyGross);
      }
      return {
        ...e,
        yearsServed,
        monthlyGross,
        eosEstimate,
      };
    });

    const summary = {
      total: enriched.length,
      totalEosEstimate: enriched.reduce((s, e) => s + e.eosEstimate, 0),
      averageYears: enriched.length
        ? enriched.reduce((s, e) => s + (e.yearsServed || 0), 0) / enriched.length
        : 0,
    };

    res.json({ summary, rows: enriched });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ في تقرير نهاية الخدمة" });
  }
});

// ────────────────────────────────────────────────────────────────────
// 8) Employee total cost — per employee including GOSI employer ~11.75%
// GET /api/hr/reports/employee-cost?gosiEmployerPct=11.75
// ────────────────────────────────────────────────────────────────────
router.get("/employee-cost", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const gosiPct = req.query.gosiEmployerPct
      ? Number(req.query.gosiEmployerPct)
      : 11.75;

    const employees = await db.select().from(employeesTable)
      .where(and(
        eq(employeesTable.companyId, cid),
        eq(employeesTable.status, "active"),
      ))
      .orderBy(asc(employeesTable.code));

    const rows = employees.map(e => {
      const basic = num(e.basicSalary);
      const housing = num(e.housingAllow);
      const transport = num(e.transportAllow);
      const other = num(e.otherAllow);
      const gross = basic + housing + transport + other;
      // GOSI employer share commonly applies on (basic + housing) capped — simplified estimate
      const gosiBase = basic + housing;
      const gosiEmployer = (gosiBase * gosiPct) / 100;
      const monthlyCost = gross + gosiEmployer;
      const annualCost = monthlyCost * 12;
      return {
        id: e.id, code: e.code, nameAr: e.nameAr, nameEn: e.nameEn,
        department: e.department, jobTitle: e.jobTitle, nationality: e.nationality,
        basic, housing, transport, other, gross,
        gosiEmployer, monthlyCost, annualCost,
      };
    });

    const summary = {
      total: rows.length,
      totalGross: rows.reduce((s, r) => s + r.gross, 0),
      totalGosi: rows.reduce((s, r) => s + r.gosiEmployer, 0),
      totalMonthlyCost: rows.reduce((s, r) => s + r.monthlyCost, 0),
      totalAnnualCost: rows.reduce((s, r) => s + r.annualCost, 0),
      averageMonthlyCost: rows.length
        ? rows.reduce((s, r) => s + r.monthlyCost, 0) / rows.length
        : 0,
      gosiEmployerPct: gosiPct,
    };

    res.json({ summary, rows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ في تقرير التكلفة" });
  }
});

// ────────────────────────────────────────────────────────────────────
// 9) Leaves report — leave usage per employee for a period
// GET /api/hr/reports/leaves?from=&to=
// ────────────────────────────────────────────────────────────────────
router.get("/leaves", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const from = String(req.query.from || "");
    const to   = String(req.query.to || "");

    const where = [eq(employeeLeavesTable.companyId, cid)];
    if (from) where.push(gte(employeeLeavesTable.startDate, from));
    if (to)   where.push(lte(employeeLeavesTable.startDate, to));

    const rows = await db.select({
      id: employeeLeavesTable.id,
      employeeId: employeeLeavesTable.employeeId,
      leaveType: employeeLeavesTable.leaveType,
      startDate: employeeLeavesTable.startDate,
      endDate: employeeLeavesTable.endDate,
      days: employeeLeavesTable.days,
      paid: employeeLeavesTable.paid,
      status: employeeLeavesTable.status,
      empCode: employeesTable.code,
      empName: employeesTable.nameAr,
      empDept: employeesTable.department,
    })
      .from(employeeLeavesTable)
      .leftJoin(employeesTable, eq(employeeLeavesTable.employeeId, employeesTable.id))
      .where(and(...where))
      .orderBy(desc(employeeLeavesTable.startDate));

    const summary = {
      total: rows.length,
      approved: rows.filter(r => r.status === "approved").length,
      pending: rows.filter(r => r.status === "pending").length,
      rejected: rows.filter(r => r.status === "rejected").length,
      totalDays: rows.reduce((s, r) => s + Number(r.days || 0), 0),
      paidDays: rows.filter(r => r.paid).reduce((s, r) => s + Number(r.days || 0), 0),
      unpaidDays: rows.filter(r => !r.paid).reduce((s, r) => s + Number(r.days || 0), 0),
    };

    res.json({ summary, rows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ في تقرير الإجازات" });
  }
});

export default router;
