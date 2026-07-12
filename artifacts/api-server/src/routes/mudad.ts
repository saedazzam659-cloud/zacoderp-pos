import { Router } from "express";
import { db } from "@workspace/db";
import {
  employeesTable,
  payrollRunsTable,
  payrollLinesTable,
  mudadSalaryBatchesTable,
  mudadSalaryBatchLinesTable,
} from "@workspace/db";
import { and, eq, asc, desc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";

// ─────────────────────────────────────────────────────────────────────────────
// Saudi منصة مدد (Mudad) salary sending — SIMPLE (Option 1).
//
// Mudad has no public API, so we generate a WPS-compatible export FILE that the
// employer uploads to منصة مدد. This router evaluates a payroll run against the
// Mudad eligibility rules, records who is included / excluded (with an Arabic
// reason code), persists a batch snapshot, and exposes stats. The export file
// itself is built on the client from the persisted included lines (so a live
// Mudad API can be wired later WITHOUT changing this contract).
// ─────────────────────────────────────────────────────────────────────────────

const router = Router();
router.use(extractAuth);
// Server-side RBAC: reads require hr_payroll "view", creating a salary batch
// requires "create". Company admins/superadmin pass; the company-module gate
// (hr_payroll → hr_module) is also enforced inside requirePermission.
const canView = requirePermission("hr_payroll", "view");
const canCreate = requirePermission("hr_payroll", "create");

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

const num = (v: any) => (v == null || v === "" ? 0 : Number(v) || 0);
const todayIso = () => new Date().toISOString().slice(0, 10);

// Is the employee a Saudi national? Prefer the explicit saudiType flag, fall
// back to a nationality-string heuristic (same pattern used across the HR code).
function isSaudi(emp: any): boolean {
  if (emp.saudiType === "saudi") return true;
  if (emp.saudiType === "non_saudi") return false;
  return /(سعود|saudi)/i.test(String(emp.nationality || ""));
}

// Reason codes → resolved to Arabic in the UI/report (kept as codes in the DB so
// the language layer stays in the frontend). Order matters: the FIRST failing
// rule is the one reported. `mode` is 'sponsored_only' (default) or 'all'.
export const MUDAD_EXCLUSION_REASONS: Record<string, string> = {
  not_sponsored:      "غير مكفول من المنشأة (عمالة غير خاضعة للكفالة)",
  irregular:          "عمالة غير منتظمة (لا تُرسل رواتبهم عبر مدد افتراضياً)",
  resigned:           "الموظف منتهي الخدمة / مستقيل",
  suspended:          "الموظف موقوف عن العمل",
  inactive:           "حالة الموظف غير نشطة",
  iqama_expired:      "الإقامة منتهية الصلاحية",
  work_permit_expired:"رخصة العمل منتهية الصلاحية",
  no_id:              "لا يوجد رقم هوية / إقامة مسجّل",
  no_iban:            "لا يوجد رقم آيبان (IBAN) مسجّل",
  bank_not_approved:  "الحساب البنكي غير معتمد لدى مدد",
};

// Evaluate a single employee. Returns { included, reason } where reason is a code
// from MUDAD_EXCLUSION_REASONS when excluded, or null when included.
function evaluateEmployee(emp: any, mode: string): { included: boolean; reason: string | null } {
  const today = todayIso();

  // Employment status gates (apply in every mode)
  if (emp.status === "terminated") return { included: false, reason: "resigned" };
  if (emp.status === "suspended")  return { included: false, reason: "suspended" };
  if (emp.status !== "active" && emp.status !== "vacation")
    return { included: false, reason: "inactive" };

  // Sponsorship / employment-type gates — ONLY in 'sponsored_only' mode
  if (mode === "sponsored_only") {
    if (emp.onSponsorship === false) return { included: false, reason: "not_sponsored" };
    if (emp.employmentType === "irregular") return { included: false, reason: "irregular" };
  }

  // Residency / work-permit validity (non-Saudi only)
  if (!isSaudi(emp)) {
    if (emp.iqamaExpiry && String(emp.iqamaExpiry) < today)
      return { included: false, reason: "iqama_expired" };
    if (emp.workPermitExpiry && String(emp.workPermitExpiry) < today)
      return { included: false, reason: "work_permit_expired" };
  }

  // Payment data completeness
  if (!emp.idNumber || !String(emp.idNumber).trim())
    return { included: false, reason: "no_id" };
  if (!emp.bankAccountIban || !String(emp.bankAccountIban).trim())
    return { included: false, reason: "no_iban" };
  if (emp.bankApproved === false)
    return { included: false, reason: "bank_not_approved" };

  return { included: true, reason: null };
}

// Build the evaluated line set for a payroll run: joins each payroll line to its
// employee, computes eligibility, and returns rows ready for preview / persist.
async function buildEvaluatedLines(cid: number, run: any, mode: string) {
  const rows = await db.select({
    employeeId:   payrollLinesTable.employeeId,
    netSalary:    payrollLinesTable.netSalary,
    empCode:      employeesTable.code,
    empNameAr:    employeesTable.nameAr,
    idType:       employeesTable.idType,
    idNumber:     employeesTable.idNumber,
    iqamaExpiry:  employeesTable.iqamaExpiry,
    nationality:  employeesTable.nationality,
    status:       employeesTable.status,
    iban:         employeesTable.bankAccountIban,
    bankName:     employeesTable.bankName,
    saudiType:        employeesTable.saudiType,
    employmentType:   employeesTable.employmentType,
    onSponsorship:    employeesTable.onSponsorship,
    workPermitExpiry: employeesTable.workPermitExpiry,
    bankApproved:     employeesTable.bankApproved,
  }).from(payrollLinesTable)
    // payroll_lines has no company_id; tenant isolation is enforced by (a) the
    // caller having already validated `run` belongs to `cid`, and (b) this
    // INNER JOIN requiring the employee to belong to the same company — a
    // cross-tenant/orphaned line is dropped rather than leaking bank details.
    .innerJoin(employeesTable, and(
      eq(employeesTable.id, payrollLinesTable.employeeId),
      eq(employeesTable.companyId, cid),
    ))
    .where(eq(payrollLinesTable.payrollRunId, run.id))
    .orderBy(asc(employeesTable.code));

  return rows.map((r) => {
    const { included, reason } = evaluateEmployee(
      { ...r, bankAccountIban: r.iban }, mode,
    );
    return {
      employeeId:   r.employeeId,
      employeeCode: r.empCode ?? "",
      employeeName: r.empNameAr ?? "",
      idNumber:     r.idNumber ?? "",
      iban:         r.iban ?? "",
      bankName:     r.bankName ?? "",
      netSalary:    num(r.netSalary),
      included,
      excludedReason: reason,
    };
  });
}

// ─── GET /preview?payrollRunId=&mode= ────────────────────────────────────────
// Non-destructive: evaluates the run and returns included/excluded lines + a
// summary, without persisting anything. Used to drive the send screen.
router.get("/preview", canView, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const runId = Number(req.query.payrollRunId);
    const mode = req.query.mode === "all" ? "all" : "sponsored_only";
    if (!Number.isInteger(runId) || runId <= 0) {
      res.status(400).json({ error: "مسير الرواتب غير صالح" }); return;
    }
    const [run] = await db.select().from(payrollRunsTable)
      .where(and(eq(payrollRunsTable.id, runId), eq(payrollRunsTable.companyId, cid)));
    if (!run) { res.status(404).json({ error: "مسير الرواتب غير موجود" }); return; }

    const lines = await buildEvaluatedLines(cid, run, mode);
    const included = lines.filter((l) => l.included);
    const excluded = lines.filter((l) => !l.included);
    const totalNet = +included.reduce((s, l) => s + l.netSalary, 0).toFixed(2);

    res.json({
      run: { id: run.id, code: run.code, year: run.year, month: run.month, status: run.status },
      mode,
      summary: {
        total: lines.length,
        includedCount: included.length,
        excludedCount: excluded.length,
        totalNet,
      },
      lines,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /batches ───────────────────────────────────────────────────────────
// Persists a batch snapshot for a payroll run + evaluated lines. Returns the
// batch and its included lines so the client can generate the WPS file.
// Body: { payrollRunId, mode?, establishmentNumber?, notes? }
router.post("/batches", canCreate, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const runId = Number(req.body?.payrollRunId);
    const mode = req.body?.mode === "all" ? "all" : "sponsored_only";
    if (!Number.isInteger(runId) || runId <= 0) {
      res.status(400).json({ error: "مسير الرواتب غير صالح" }); return;
    }
    const [run] = await db.select().from(payrollRunsTable)
      .where(and(eq(payrollRunsTable.id, runId), eq(payrollRunsTable.companyId, cid)));
    if (!run) { res.status(404).json({ error: "مسير الرواتب غير موجود" }); return; }

    const lines = await buildEvaluatedLines(cid, run, mode);
    if (lines.length === 0) {
      res.status(400).json({ error: "لا يوجد بنود رواتب في هذا المسير" }); return;
    }
    const included = lines.filter((l) => l.included);
    if (included.length === 0) {
      res.status(400).json({ error: "لا يوجد موظفون مؤهلون للإرسال عبر مدد بعد تطبيق قواعد الاستبعاد" }); return;
    }
    const totalNet = +included.reduce((s, l) => s + l.netSalary, 0).toFixed(2);

    // Generate a per-company unique batch code (guarded by the unique index).
    const [{ cnt }] = await db.select({ cnt: sql<number>`count(*)::int` })
      .from(mudadSalaryBatchesTable)
      .where(and(
        eq(mudadSalaryBatchesTable.companyId, cid),
        eq(mudadSalaryBatchesTable.year, run.year),
        eq(mudadSalaryBatchesTable.month, run.month),
      ));
    const mm = String(run.month).padStart(2, "0");
    const code = `MUDAD-${run.year}${mm}-${String((cnt ?? 0) + 1).padStart(3, "0")}`;

    const result = await db.transaction(async (tx) => {
      const [batch] = await tx.insert(mudadSalaryBatchesTable).values({
        companyId:           cid,
        branchId:            run.branchId ?? null,
        payrollRunId:        run.id,
        code,
        year:                run.year,
        month:               run.month,
        sendMode:            mode,
        establishmentNumber: req.body?.establishmentNumber?.trim() || null,
        totalEmployees:      lines.length,
        includedCount:       included.length,
        excludedCount:       lines.length - included.length,
        totalNet:            String(totalNet),
        fileFormat:          "wps_csv",
        status:              "generated",
        createdBy:           req.authUser?.id ?? null,
        createdByName:       req.authUser?.username ?? null,
        notes:               req.body?.notes?.trim() || null,
      }).returning();

      await tx.insert(mudadSalaryBatchLinesTable).values(
        lines.map((l) => ({
          batchId:        batch.id,
          companyId:      cid,
          employeeId:     l.employeeId,
          employeeCode:   l.employeeCode,
          employeeName:   l.employeeName,
          idNumber:       l.idNumber,
          iban:           l.iban,
          bankName:       l.bankName,
          netSalary:      String(l.netSalary),
          included:       l.included,
          excludedReason: l.excludedReason,
          status:         l.included ? "pending" : "excluded",
        })),
      );
      return batch;
    });

    res.status(201).json({ batch: result, includedLines: included });
  } catch (e: any) {
    if (String(e?.message || "").includes("uq_mudad_batch_company_code")) {
      res.status(409).json({ error: "رقم الدفعة مكرر، حاول مرة أخرى" }); return;
    }
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /batches ────────────────────────────────────────────────────────────
router.get("/batches", canView, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const rows = await db.select().from(mudadSalaryBatchesTable)
      .where(eq(mudadSalaryBatchesTable.companyId, cid))
      .orderBy(desc(mudadSalaryBatchesTable.createdAt));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /batches/:id ────────────────────────────────────────────────────────
// Returns the batch + all its lines (included AND excluded) so the client can
// re-download the WPS file and render the excluded-employees report.
router.get("/batches/:id", canView, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
    const [batch] = await db.select().from(mudadSalaryBatchesTable)
      .where(and(eq(mudadSalaryBatchesTable.id, id), eq(mudadSalaryBatchesTable.companyId, cid)));
    if (!batch) { res.status(404).json({ error: "الدفعة غير موجودة" }); return; }
    const lines = await db.select().from(mudadSalaryBatchLinesTable)
      .where(and(
        eq(mudadSalaryBatchLinesTable.batchId, id),
        eq(mudadSalaryBatchLinesTable.companyId, cid),
      ))
      .orderBy(asc(mudadSalaryBatchLinesTable.employeeCode));
    res.json({ ...batch, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /stats ──────────────────────────────────────────────────────────────
// Dashboard: employee eligibility snapshot + batch history totals.
router.get("/stats", canView, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;

    const emps = await db.select({
      status:           employeesTable.status,
      idNumber:         employeesTable.idNumber,
      nationality:      employeesTable.nationality,
      iqamaExpiry:      employeesTable.iqamaExpiry,
      bankAccountIban:  employeesTable.bankAccountIban,
      saudiType:        employeesTable.saudiType,
      employmentType:   employeesTable.employmentType,
      onSponsorship:    employeesTable.onSponsorship,
      workPermitExpiry: employeesTable.workPermitExpiry,
      bankApproved:     employeesTable.bankApproved,
    }).from(employeesTable).where(eq(employeesTable.companyId, cid));

    const activeEmps = emps.filter((e) => e.status === "active" || e.status === "vacation");
    let sponsored = 0, irregular = 0, eligible = 0, ineligible = 0;
    const reasonBreakdown: Record<string, number> = {};
    for (const e of activeEmps) {
      if (e.onSponsorship !== false) sponsored++;
      if (e.employmentType === "irregular") irregular++;
      const { included, reason } = evaluateEmployee(e, "sponsored_only");
      if (included) eligible++;
      else { ineligible++; if (reason) reasonBreakdown[reason] = (reasonBreakdown[reason] ?? 0) + 1; }
    }

    const batches = await db.select().from(mudadSalaryBatchesTable)
      .where(eq(mudadSalaryBatchesTable.companyId, cid));
    const batchTotals = {
      count: batches.length,
      totalNet: +batches.reduce((s, b) => s + num(b.totalNet), 0).toFixed(2),
      totalIncluded: batches.reduce((s, b) => s + (b.includedCount ?? 0), 0),
      totalExcluded: batches.reduce((s, b) => s + (b.excludedCount ?? 0), 0),
    };

    res.json({
      employees: {
        total: emps.length,
        active: activeEmps.length,
        sponsored,
        irregular,
        eligible,
        ineligible,
        reasonBreakdown,
      },
      batches: batchTotals,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
