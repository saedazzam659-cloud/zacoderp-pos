// Occupational Safety & Health (OSH) module — /api/safety/*
//
// Phase 1 (ISO 45001:2018 core): Risk Assessment register (5×5 matrix +
// hierarchy of controls + residual risk), Incident/Accident management
// (near-miss → fatality, 5-Whys root cause, links to work center / order /
// employee), CAPA actions, and an OSH KPI dashboard (TRIR / LTIFR / severity
// rate / days-since-last-LTI). Multi-tenant, branch-scoped. No journal
// entries — OSH is operational, not financial.
import { Router } from "express";
import { db } from "@workspace/db";
import {
  safetyRiskAssessmentsTable,
  safetyRiskControlsTable,
  safetyIncidentsTable,
  safetyIncidentActionsTable,
  workCentersTable,
  productionOrdersTable,
  usersTable,
  employeesTable,
  SAFETY_HAZARD_CATEGORIES,
  SAFETY_RISK_STATUSES,
  SAFETY_CONTROL_TYPES,
  SAFETY_CONTROL_STATUSES,
  SAFETY_INCIDENT_TYPES,
  SAFETY_SEVERITY_CLASSES,
  SAFETY_INCIDENT_STATUSES,
  SAFETY_ACTION_TYPES,
  SAFETY_ACTION_STATUSES,
} from "@workspace/db";
import type { SafetyRiskLevel } from "@workspace/db";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  extractAuth,
  resolveCompanyId,
  branchScopeFilter,
  intersectBranchRequest,
} from "../middleware/auth.js";
import {
  pathRbac,
} from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
// Per-screen RBAC gate + audit. Each route group maps to its own granular
// permission key (all three roll up to the single `safety` company-module
// toggle via COMPANY_MODULE_GATE). pathRbac matches req.path (relative to the
// /safety mount) by longest-prefix order and combines the company gate, the
// per-user action gate (mutations only), and the audit logger. Mirrors the
// per-screen PermRoute module gates on the frontend.
router.use(pathRbac([
  ["/kpis",             "safety_dashboard"],
  ["/risk-assessments", "safety_risk"],
  ["/controls",         "safety_risk"],
  ["/incidents",        "safety_incidents"],
  ["/actions",          "safety_incidents"],
]));

// ─── helpers ─────────────────────────────────────────────────────────────
function guard(req: any, res: any): number | null {
  if (!req.authUser) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
  const cid = resolveCompanyId(req, req.authUser.companyId ?? undefined);
  if (!cid) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
  return cid;
}

function rowInScope(req: any, branchId: number | null | undefined): boolean {
  if (branchId == null) return true;
  return intersectBranchRequest(req, branchId) !== "deny";
}

function num(v: unknown, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// Clamp a 5×5-matrix axis to 1..5.
function clamp15(v: unknown): number {
  const n = Math.round(num(v, 1));
  return Math.min(5, Math.max(1, n));
}

// Standard 5×5 risk banding (score = likelihood × severity, 1..25).
function levelFromScore(score: number): SafetyRiskLevel {
  if (score >= 16) return "critical";
  if (score >= 10) return "high";
  if (score >= 5) return "medium";
  return "low";
}

function oneOf<T extends readonly string[]>(
  list: T,
  v: unknown,
  def: T[number],
): T[number] {
  return typeof v === "string" && (list as readonly string[]).includes(v)
    ? (v as T[number])
    : def;
}

// severity_class → OSHA-recordable default (medical_treatment+ is recordable).
function recordableFor(severityClass: string): boolean {
  return ["medical_treatment", "lost_time", "fatality"].includes(severityClass);
}

// Per-company sequential document code (RA-0001 / INC-0001). Counts existing
// rows; acceptable for Phase 1 (gaps are harmless, codes are display-only).
async function nextCode(
  table: typeof safetyRiskAssessmentsTable | typeof safetyIncidentsTable,
  cid: number,
  prefix: string,
): Promise<string> {
  const [r] = await db
    .select({ c: sql<number>`count(*)` })
    .from(table)
    .where(eq(table.companyId, cid));
  const next = Number(r?.c ?? 0) + 1;
  return `${prefix}-${String(next).padStart(4, "0")}`;
}

const idParam = (req: any) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Same-tenant ownership guard for foreign-key references supplied in a request
// body (work center / production order / employee / responsible-or-owner user).
// Prevents a caller from smuggling another company's row id into an OSH record.
// Skips null/zero ids (clearing a ref is allowed); returns the first failing
// reference's Arabic error message, or null when every supplied ref is valid.
async function firstInvalidRef(
  cid: number,
  refs: { table: any; id: number | null | undefined; error: string }[],
): Promise<string | null> {
  for (const { table, id, error } of refs) {
    if (id == null || id === 0) continue;
    const [r] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.companyId, cid)))
      .limit(1);
    if (!r) return error;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// KPI DASHBOARD  (register literal route BEFORE any "/:id")
// ════════════════════════════════════════════════════════════════════════
router.get("/kpis", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const branchCond = branchScopeFilter(req, safetyIncidentsTable.branchId);
    const incWhere = branchCond
      ? and(eq(safetyIncidentsTable.companyId, cid), branchCond)
      : eq(safetyIncidentsTable.companyId, cid);

    // manHours lets the caller drive the rate-based ISO/OSHA metrics. Without
    // it we return null for those (explicit "unknown", never a fabricated 0).
    const manHours = req.query.manHours ? num(req.query.manHours) : null;

    const incidents = await db
      .select()
      .from(safetyIncidentsTable)
      .where(incWhere);

    const total = incidents.length;
    const nearMiss = incidents.filter(
      (i) => i.incidentType === "near_miss",
    ).length;
    const recordable = incidents.filter((i) => i.isRecordable).length;
    const lostTime = incidents.filter(
      (i) => i.severityClass === "lost_time" || i.severityClass === "fatality",
    ).length;
    const fatalities = incidents.filter(
      (i) => i.severityClass === "fatality",
    ).length;
    const totalLostDays = incidents.reduce(
      (s, i) => s + (i.lostDays ?? 0),
      0,
    );
    const openIncidents = incidents.filter((i) => i.status !== "closed").length;

    // Days since the last lost-time injury / fatality.
    const ltiDates = incidents
      .filter(
        (i) =>
          i.severityClass === "lost_time" || i.severityClass === "fatality",
      )
      .map((i) => new Date(i.occurredAt).getTime())
      .filter((t) => Number.isFinite(t));
    const daysSinceLastLti =
      ltiDates.length > 0
        ? Math.floor(
            (Date.now() - Math.max(...ltiDates)) / (1000 * 60 * 60 * 24),
        )
        : null;

    // ISO 45001 / OSHA rate metrics. TRIR base 200,000 (100 FTE-years),
    // LTIFR base 1,000,000, severity rate = lost days per 1,000,000 hours.
    const trir =
      manHours && manHours > 0 ? (recordable * 200000) / manHours : null;
    const ltifr =
      manHours && manHours > 0 ? (lostTime * 1000000) / manHours : null;
    const severityRate =
      manHours && manHours > 0 ? (totalLostDays * 1000000) / manHours : null;

    // Risk register snapshot.
    const raBranchCond = branchScopeFilter(req, safetyRiskAssessmentsTable.branchId);
    const raRows = await db
      .select({
        riskLevel: safetyRiskAssessmentsTable.riskLevel,
        residualLevel: safetyRiskAssessmentsTable.residualLevel,
        status: safetyRiskAssessmentsTable.status,
      })
      .from(safetyRiskAssessmentsTable)
      .where(
        raBranchCond
          ? and(eq(safetyRiskAssessmentsTable.companyId, cid), raBranchCond)
          : eq(safetyRiskAssessmentsTable.companyId, cid),
      );
    const riskByLevel: Record<string, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    for (const r of raRows) {
      const lvl = r.residualLevel || r.riskLevel || "low";
      if (lvl in riskByLevel) riskByLevel[lvl] += 1;
    }
    const openRisks = raRows.filter((r) => r.status !== "closed").length;

    // CAPA snapshot. Actions inherit branch scope from their parent incident
    // (no own branch_id), so join to the incident and reuse the incident
    // branch filter computed above.
    const capaRows = await db
      .select({
        status: safetyIncidentActionsTable.status,
        dueDate: safetyIncidentActionsTable.dueDate,
      })
      .from(safetyIncidentActionsTable)
      .innerJoin(
        safetyIncidentsTable,
        and(
          eq(safetyIncidentsTable.id, safetyIncidentActionsTable.incidentId),
          eq(safetyIncidentsTable.companyId, cid),
        ),
      )
      .where(
        branchCond
          ? and(eq(safetyIncidentActionsTable.companyId, cid), branchCond)
          : eq(safetyIncidentActionsTable.companyId, cid),
      );
    const todayStr = new Date().toISOString().slice(0, 10);
    const capaOpen = capaRows.filter((a) => a.status !== "done").length;
    const capaOverdue = capaRows.filter(
      (a) => a.status !== "done" && a.dueDate && a.dueDate < todayStr,
    ).length;

    res.json({
      manHours,
      incidents: {
        total,
        nearMiss,
        recordable,
        lostTime,
        fatalities,
        open: openIncidents,
        totalLostDays,
      },
      daysSinceLastLti,
      rates: { trir, ltifr, severityRate },
      risks: { byLevel: riskByLevel, open: openRisks, total: raRows.length },
      capa: { open: capaOpen, overdue: capaOverdue, total: capaRows.length },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// RISK ASSESSMENTS
// ════════════════════════════════════════════════════════════════════════
router.get("/risk-assessments", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const branchCond = branchScopeFilter(req, safetyRiskAssessmentsTable.branchId);
    const conds: any[] = [eq(safetyRiskAssessmentsTable.companyId, cid)];
    if (branchCond) conds.push(branchCond);
    if (typeof req.query.status === "string" && req.query.status)
      conds.push(eq(safetyRiskAssessmentsTable.status, req.query.status as any));
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      const q = `%${req.query.q.trim()}%`;
      conds.push(
        or(
          ilike(safetyRiskAssessmentsTable.title, q),
          ilike(safetyRiskAssessmentsTable.code, q),
          ilike(safetyRiskAssessmentsTable.processArea, q),
        ),
      );
    }
    const rows = await db
      .select({
        ra: safetyRiskAssessmentsTable,
        workCenterName: workCentersTable.nameAr,
        responsibleName: usersTable.username,
      })
      .from(safetyRiskAssessmentsTable)
      .leftJoin(
        workCentersTable,
        eq(workCentersTable.id, safetyRiskAssessmentsTable.workCenterId),
      )
      .leftJoin(
        usersTable,
        eq(usersTable.id, safetyRiskAssessmentsTable.responsibleUserId),
      )
      .where(and(...conds))
      .orderBy(desc(safetyRiskAssessmentsTable.createdAt));
    res.json(
      rows.map((r) => ({
        ...r.ra,
        workCenterName: r.workCenterName,
        responsibleName: r.responsibleName,
      })),
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/risk-assessments/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [ra] = await db
      .select()
      .from(safetyRiskAssessmentsTable)
      .where(
        and(
          eq(safetyRiskAssessmentsTable.id, id),
          eq(safetyRiskAssessmentsTable.companyId, cid),
        ),
      );
    if (!ra) {
      res.status(404).json({ error: "تقييم المخاطر غير موجود" });
      return;
    }
    if (!rowInScope(req, ra.branchId)) {
      res.status(403).json({ error: "لا يمكنك الوصول لهذا الفرع" });
      return;
    }
    const controls = await db
      .select()
      .from(safetyRiskControlsTable)
      .where(
        and(
          eq(safetyRiskControlsTable.assessmentId, id),
          eq(safetyRiskControlsTable.companyId, cid),
        ),
      )
      .orderBy(asc(safetyRiskControlsTable.id));
    res.json({ ...ra, controls });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/risk-assessments", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    if (!b.title || typeof b.title !== "string") {
      res.status(400).json({ error: "عنوان تقييم المخاطر مطلوب" });
      return;
    }
    const bid = intersectBranchRequest(req, b.branchId ?? null);
    if (bid === "deny") {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    const likelihood = clamp15(b.likelihood);
    const severity = clamp15(b.severity);
    const riskScore = likelihood * severity;
    const hasResidual =
      b.residualLikelihood != null && b.residualSeverity != null;
    const rl = hasResidual ? clamp15(b.residualLikelihood) : null;
    const rs = hasResidual ? clamp15(b.residualSeverity) : null;
    const residualScore = rl != null && rs != null ? rl * rs : null;

    const refErr = await firstInvalidRef(cid, [
      { table: workCentersTable, id: b.workCenterId ? num(b.workCenterId) : null, error: "مركز العمل غير موجود في الشركة" },
      { table: usersTable, id: b.responsibleUserId ? num(b.responsibleUserId) : null, error: "المستخدم المسؤول غير موجود في الشركة" },
    ]);
    if (refErr) {
      res.status(400).json({ error: refErr });
      return;
    }

    const code =
      typeof b.code === "string" && b.code.trim()
        ? b.code.trim()
        : await nextCode(safetyRiskAssessmentsTable, cid, "RA");

    const [row] = await db
      .insert(safetyRiskAssessmentsTable)
      .values({
        companyId: cid,
        branchId: typeof bid === "number" ? bid : null,
        code,
        title: b.title.trim(),
        processArea: b.processArea?.trim() || null,
        workCenterId: b.workCenterId ? num(b.workCenterId) : null,
        hazardDescription: b.hazardDescription?.trim() || null,
        hazardCategory: oneOf(SAFETY_HAZARD_CATEGORIES, b.hazardCategory, "other"),
        likelihood,
        severity,
        riskScore,
        riskLevel: levelFromScore(riskScore),
        existingControls: b.existingControls?.trim() || null,
        residualLikelihood: rl,
        residualSeverity: rs,
        residualScore,
        residualLevel: residualScore != null ? levelFromScore(residualScore) : null,
        responsibleUserId: b.responsibleUserId ? num(b.responsibleUserId) : null,
        assessmentDate: b.assessmentDate || null,
        reviewDate: b.reviewDate || null,
        status: oneOf(SAFETY_RISK_STATUSES, b.status, "open"),
        notes: b.notes?.trim() || null,
        createdBy: req.authUser?.id ?? null,
      })
      .returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/risk-assessments/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [existing] = await db
      .select()
      .from(safetyRiskAssessmentsTable)
      .where(
        and(
          eq(safetyRiskAssessmentsTable.id, id),
          eq(safetyRiskAssessmentsTable.companyId, cid),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "تقييم المخاطر غير موجود" });
      return;
    }
    if (!rowInScope(req, existing.branchId)) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    const b = req.body ?? {};
    const refErr = await firstInvalidRef(cid, [
      { table: workCentersTable, id: b.workCenterId ? num(b.workCenterId) : null, error: "مركز العمل غير موجود في الشركة" },
      { table: usersTable, id: b.responsibleUserId ? num(b.responsibleUserId) : null, error: "المستخدم المسؤول غير موجود في الشركة" },
    ]);
    if (refErr) {
      res.status(400).json({ error: refErr });
      return;
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof b.title === "string") updates.title = b.title.trim();
    if (b.processArea !== undefined) updates.processArea = b.processArea?.trim() || null;
    if (b.workCenterId !== undefined)
      updates.workCenterId = b.workCenterId ? num(b.workCenterId) : null;
    if (b.hazardDescription !== undefined)
      updates.hazardDescription = b.hazardDescription?.trim() || null;
    if (b.hazardCategory !== undefined)
      updates.hazardCategory = oneOf(SAFETY_HAZARD_CATEGORIES, b.hazardCategory, "other");
    if (b.existingControls !== undefined)
      updates.existingControls = b.existingControls?.trim() || null;
    if (b.responsibleUserId !== undefined)
      updates.responsibleUserId = b.responsibleUserId ? num(b.responsibleUserId) : null;
    if (b.assessmentDate !== undefined) updates.assessmentDate = b.assessmentDate || null;
    if (b.reviewDate !== undefined) updates.reviewDate = b.reviewDate || null;
    if (b.status !== undefined)
      updates.status = oneOf(SAFETY_RISK_STATUSES, b.status, existing.status);
    if (b.notes !== undefined) updates.notes = b.notes?.trim() || null;

    // Re-derive inherent score whenever either axis is supplied.
    if (b.likelihood !== undefined || b.severity !== undefined) {
      const likelihood = clamp15(b.likelihood ?? existing.likelihood);
      const severity = clamp15(b.severity ?? existing.severity);
      const score = likelihood * severity;
      updates.likelihood = likelihood;
      updates.severity = severity;
      updates.riskScore = score;
      updates.riskLevel = levelFromScore(score);
    }
    // Re-derive residual score whenever either residual axis is supplied.
    if (b.residualLikelihood !== undefined || b.residualSeverity !== undefined) {
      const haveL = (b.residualLikelihood ?? existing.residualLikelihood) != null;
      const haveS = (b.residualSeverity ?? existing.residualSeverity) != null;
      if (haveL && haveS) {
        const rl = clamp15(b.residualLikelihood ?? existing.residualLikelihood);
        const rs = clamp15(b.residualSeverity ?? existing.residualSeverity);
        const rscore = rl * rs;
        updates.residualLikelihood = rl;
        updates.residualSeverity = rs;
        updates.residualScore = rscore;
        updates.residualLevel = levelFromScore(rscore);
      } else {
        updates.residualLikelihood = b.residualLikelihood ?? existing.residualLikelihood ?? null;
        updates.residualSeverity = b.residualSeverity ?? existing.residualSeverity ?? null;
        updates.residualScore = null;
        updates.residualLevel = null;
      }
    }
    const [row] = await db
      .update(safetyRiskAssessmentsTable)
      .set(updates)
      .where(
        and(
          eq(safetyRiskAssessmentsTable.id, id),
          eq(safetyRiskAssessmentsTable.companyId, cid),
        ),
      )
      .returning();
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/risk-assessments/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [existing] = await db
      .select({ branchId: safetyRiskAssessmentsTable.branchId })
      .from(safetyRiskAssessmentsTable)
      .where(
        and(
          eq(safetyRiskAssessmentsTable.id, id),
          eq(safetyRiskAssessmentsTable.companyId, cid),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "تقييم المخاطر غير موجود" });
      return;
    }
    if (!rowInScope(req, existing.branchId)) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    await db
      .delete(safetyRiskAssessmentsTable)
      .where(
        and(
          eq(safetyRiskAssessmentsTable.id, id),
          eq(safetyRiskAssessmentsTable.companyId, cid),
        ),
      );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── controls (children of a risk assessment) ────────────────────────────
async function assertRaScope(req: any, cid: number, assessmentId: number) {
  const [ra] = await db
    .select({ id: safetyRiskAssessmentsTable.id, branchId: safetyRiskAssessmentsTable.branchId })
    .from(safetyRiskAssessmentsTable)
    .where(
      and(
        eq(safetyRiskAssessmentsTable.id, assessmentId),
        eq(safetyRiskAssessmentsTable.companyId, cid),
      ),
    );
  if (!ra) return { ok: false as const, status: 404, error: "تقييم المخاطر غير موجود" };
  if (!rowInScope(req, ra.branchId))
    return { ok: false as const, status: 403, error: "لا يمكنك العمل على هذا الفرع" };
  return { ok: true as const };
}

router.post("/risk-assessments/:id/controls", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const scope = await assertRaScope(req, cid, id);
    if (!scope.ok) {
      res.status(scope.status).json({ error: scope.error });
      return;
    }
    const b = req.body ?? {};
    if (!b.description || typeof b.description !== "string") {
      res.status(400).json({ error: "وصف الضابط مطلوب" });
      return;
    }
    const refErr = await firstInvalidRef(cid, [
      { table: usersTable, id: b.ownerUserId ? num(b.ownerUserId) : null, error: "المستخدم المسؤول غير موجود في الشركة" },
    ]);
    if (refErr) {
      res.status(400).json({ error: refErr });
      return;
    }
    const [row] = await db
      .insert(safetyRiskControlsTable)
      .values({
        companyId: cid,
        assessmentId: id,
        controlType: oneOf(SAFETY_CONTROL_TYPES, b.controlType, "administrative"),
        description: b.description.trim(),
        status: oneOf(SAFETY_CONTROL_STATUSES, b.status, "planned"),
        ownerUserId: b.ownerUserId ? num(b.ownerUserId) : null,
        dueDate: b.dueDate || null,
      })
      .returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/controls/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [existing] = await db
      .select()
      .from(safetyRiskControlsTable)
      .where(
        and(
          eq(safetyRiskControlsTable.id, id),
          eq(safetyRiskControlsTable.companyId, cid),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "الضابط غير موجود" });
      return;
    }
    const scope = await assertRaScope(req, cid, existing.assessmentId);
    if (!scope.ok) {
      res.status(scope.status).json({ error: scope.error });
      return;
    }
    const b = req.body ?? {};
    const refErr = await firstInvalidRef(cid, [
      { table: usersTable, id: b.ownerUserId ? num(b.ownerUserId) : null, error: "المستخدم المسؤول غير موجود في الشركة" },
    ]);
    if (refErr) {
      res.status(400).json({ error: refErr });
      return;
    }
    const updates: Record<string, unknown> = {};
    if (b.controlType !== undefined)
      updates.controlType = oneOf(SAFETY_CONTROL_TYPES, b.controlType, existing.controlType);
    if (typeof b.description === "string") updates.description = b.description.trim();
    if (b.status !== undefined)
      updates.status = oneOf(SAFETY_CONTROL_STATUSES, b.status, existing.status);
    if (b.ownerUserId !== undefined)
      updates.ownerUserId = b.ownerUserId ? num(b.ownerUserId) : null;
    if (b.dueDate !== undefined) updates.dueDate = b.dueDate || null;
    const [row] = await db
      .update(safetyRiskControlsTable)
      .set(updates)
      .where(
        and(
          eq(safetyRiskControlsTable.id, id),
          eq(safetyRiskControlsTable.companyId, cid),
        ),
      )
      .returning();
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/controls/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [existing] = await db
      .select({ assessmentId: safetyRiskControlsTable.assessmentId })
      .from(safetyRiskControlsTable)
      .where(
        and(
          eq(safetyRiskControlsTable.id, id),
          eq(safetyRiskControlsTable.companyId, cid),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "الضابط غير موجود" });
      return;
    }
    const scope = await assertRaScope(req, cid, existing.assessmentId);
    if (!scope.ok) {
      res.status(scope.status).json({ error: scope.error });
      return;
    }
    await db
      .delete(safetyRiskControlsTable)
      .where(
        and(
          eq(safetyRiskControlsTable.id, id),
          eq(safetyRiskControlsTable.companyId, cid),
        ),
      );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// INCIDENTS
// ════════════════════════════════════════════════════════════════════════
router.get("/incidents", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const branchCond = branchScopeFilter(req, safetyIncidentsTable.branchId);
    const conds: any[] = [eq(safetyIncidentsTable.companyId, cid)];
    if (branchCond) conds.push(branchCond);
    if (typeof req.query.status === "string" && req.query.status)
      conds.push(eq(safetyIncidentsTable.status, req.query.status as any));
    if (typeof req.query.type === "string" && req.query.type)
      conds.push(eq(safetyIncidentsTable.incidentType, req.query.type as any));
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      const q = `%${req.query.q.trim()}%`;
      conds.push(
        or(
          ilike(safetyIncidentsTable.title, q),
          ilike(safetyIncidentsTable.incidentNumber, q),
          ilike(safetyIncidentsTable.location, q),
        ),
      );
    }
    const rows = await db
      .select({
        inc: safetyIncidentsTable,
        workCenterName: workCentersTable.nameAr,
        employeeName: employeesTable.nameAr,
      })
      .from(safetyIncidentsTable)
      .leftJoin(
        workCentersTable,
        eq(workCentersTable.id, safetyIncidentsTable.workCenterId),
      )
      .leftJoin(
        employeesTable,
        eq(employeesTable.id, safetyIncidentsTable.injuredEmployeeId),
      )
      .where(and(...conds))
      .orderBy(desc(safetyIncidentsTable.occurredAt));
    res.json(
      rows.map((r) => ({
        ...r.inc,
        workCenterName: r.workCenterName,
        employeeName: r.employeeName,
      })),
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/incidents/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [inc] = await db
      .select()
      .from(safetyIncidentsTable)
      .where(
        and(
          eq(safetyIncidentsTable.id, id),
          eq(safetyIncidentsTable.companyId, cid),
        ),
      );
    if (!inc) {
      res.status(404).json({ error: "الحادث غير موجود" });
      return;
    }
    if (!rowInScope(req, inc.branchId)) {
      res.status(403).json({ error: "لا يمكنك الوصول لهذا الفرع" });
      return;
    }
    const actions = await db
      .select()
      .from(safetyIncidentActionsTable)
      .where(
        and(
          eq(safetyIncidentActionsTable.incidentId, id),
          eq(safetyIncidentActionsTable.companyId, cid),
        ),
      )
      .orderBy(asc(safetyIncidentActionsTable.id));
    res.json({ ...inc, actions });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/incidents", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    if (!b.title || typeof b.title !== "string") {
      res.status(400).json({ error: "عنوان الحادث مطلوب" });
      return;
    }
    if (!b.occurredAt) {
      res.status(400).json({ error: "تاريخ ووقت الحادث مطلوب" });
      return;
    }
    const occurred = new Date(b.occurredAt);
    if (Number.isNaN(occurred.getTime())) {
      res.status(400).json({ error: "تاريخ الحادث غير صالح" });
      return;
    }
    const bid = intersectBranchRequest(req, b.branchId ?? null);
    if (bid === "deny") {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    const severityClass = oneOf(SAFETY_SEVERITY_CLASSES, b.severityClass, "no_treatment");
    const whys = Array.isArray(b.whys)
      ? b.whys.filter((w: unknown) => typeof w === "string").slice(0, 5)
      : [];
    const refErr = await firstInvalidRef(cid, [
      { table: workCentersTable, id: b.workCenterId ? num(b.workCenterId) : null, error: "مركز العمل غير موجود في الشركة" },
      { table: productionOrdersTable, id: b.productionOrderId ? num(b.productionOrderId) : null, error: "أمر الإنتاج غير موجود في الشركة" },
      { table: employeesTable, id: b.injuredEmployeeId ? num(b.injuredEmployeeId) : null, error: "الموظف المصاب غير موجود في الشركة" },
    ]);
    if (refErr) {
      res.status(400).json({ error: refErr });
      return;
    }

    const code =
      typeof b.incidentNumber === "string" && b.incidentNumber.trim()
        ? b.incidentNumber.trim()
        : await nextCode(safetyIncidentsTable, cid, "INC");

    const [row] = await db
      .insert(safetyIncidentsTable)
      .values({
        companyId: cid,
        branchId: typeof bid === "number" ? bid : null,
        incidentNumber: code,
        incidentType: oneOf(SAFETY_INCIDENT_TYPES, b.incidentType, "near_miss"),
        severityClass,
        title: b.title.trim(),
        description: b.description?.trim() || null,
        location: b.location?.trim() || null,
        workCenterId: b.workCenterId ? num(b.workCenterId) : null,
        productionOrderId: b.productionOrderId ? num(b.productionOrderId) : null,
        injuredEmployeeId: b.injuredEmployeeId ? num(b.injuredEmployeeId) : null,
        occurredAt: occurred,
        reportedByUserId: req.authUser?.id ?? null,
        immediateActions: b.immediateActions?.trim() || null,
        rootCause: b.rootCause?.trim() || null,
        whys,
        lostDays: Math.max(0, Math.round(num(b.lostDays))),
        isRecordable:
          typeof b.isRecordable === "boolean"
            ? b.isRecordable
            : recordableFor(severityClass),
        status: oneOf(SAFETY_INCIDENT_STATUSES, b.status, "open"),
        createdBy: req.authUser?.id ?? null,
      })
      .returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/incidents/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [existing] = await db
      .select()
      .from(safetyIncidentsTable)
      .where(
        and(
          eq(safetyIncidentsTable.id, id),
          eq(safetyIncidentsTable.companyId, cid),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "الحادث غير موجود" });
      return;
    }
    if (!rowInScope(req, existing.branchId)) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    const b = req.body ?? {};
    const refErr = await firstInvalidRef(cid, [
      { table: workCentersTable, id: b.workCenterId ? num(b.workCenterId) : null, error: "مركز العمل غير موجود في الشركة" },
      { table: productionOrdersTable, id: b.productionOrderId ? num(b.productionOrderId) : null, error: "أمر الإنتاج غير موجود في الشركة" },
      { table: employeesTable, id: b.injuredEmployeeId ? num(b.injuredEmployeeId) : null, error: "الموظف المصاب غير موجود في الشركة" },
    ]);
    if (refErr) {
      res.status(400).json({ error: refErr });
      return;
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof b.title === "string") updates.title = b.title.trim();
    if (b.incidentType !== undefined)
      updates.incidentType = oneOf(SAFETY_INCIDENT_TYPES, b.incidentType, existing.incidentType);
    if (b.description !== undefined) updates.description = b.description?.trim() || null;
    if (b.location !== undefined) updates.location = b.location?.trim() || null;
    if (b.workCenterId !== undefined)
      updates.workCenterId = b.workCenterId ? num(b.workCenterId) : null;
    if (b.productionOrderId !== undefined)
      updates.productionOrderId = b.productionOrderId ? num(b.productionOrderId) : null;
    if (b.injuredEmployeeId !== undefined)
      updates.injuredEmployeeId = b.injuredEmployeeId ? num(b.injuredEmployeeId) : null;
    if (b.occurredAt !== undefined) {
      const d = new Date(b.occurredAt);
      if (Number.isNaN(d.getTime())) {
        res.status(400).json({ error: "تاريخ الحادث غير صالح" });
        return;
      }
      updates.occurredAt = d;
    }
    if (b.immediateActions !== undefined)
      updates.immediateActions = b.immediateActions?.trim() || null;
    if (b.rootCause !== undefined) updates.rootCause = b.rootCause?.trim() || null;
    if (b.whys !== undefined)
      updates.whys = Array.isArray(b.whys)
        ? b.whys.filter((w: unknown) => typeof w === "string").slice(0, 5)
        : [];
    if (b.lostDays !== undefined) updates.lostDays = Math.max(0, Math.round(num(b.lostDays)));
    if (b.status !== undefined)
      updates.status = oneOf(SAFETY_INCIDENT_STATUSES, b.status, existing.status);
    if (b.severityClass !== undefined) {
      const sc = oneOf(SAFETY_SEVERITY_CLASSES, b.severityClass, existing.severityClass);
      updates.severityClass = sc;
      // Recompute recordable from the new class unless the caller overrides it.
      updates.isRecordable =
        typeof b.isRecordable === "boolean" ? b.isRecordable : recordableFor(sc);
    } else if (typeof b.isRecordable === "boolean") {
      updates.isRecordable = b.isRecordable;
    }
    const [row] = await db
      .update(safetyIncidentsTable)
      .set(updates)
      .where(
        and(
          eq(safetyIncidentsTable.id, id),
          eq(safetyIncidentsTable.companyId, cid),
        ),
      )
      .returning();
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/incidents/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [existing] = await db
      .select({ branchId: safetyIncidentsTable.branchId })
      .from(safetyIncidentsTable)
      .where(
        and(
          eq(safetyIncidentsTable.id, id),
          eq(safetyIncidentsTable.companyId, cid),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "الحادث غير موجود" });
      return;
    }
    if (!rowInScope(req, existing.branchId)) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    await db
      .delete(safetyIncidentsTable)
      .where(
        and(
          eq(safetyIncidentsTable.id, id),
          eq(safetyIncidentsTable.companyId, cid),
        ),
      );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CAPA actions (children of an incident) ──────────────────────────────
async function assertIncidentScope(req: any, cid: number, incidentId: number) {
  const [inc] = await db
    .select({ id: safetyIncidentsTable.id, branchId: safetyIncidentsTable.branchId })
    .from(safetyIncidentsTable)
    .where(
      and(
        eq(safetyIncidentsTable.id, incidentId),
        eq(safetyIncidentsTable.companyId, cid),
      ),
    );
  if (!inc) return { ok: false as const, status: 404, error: "الحادث غير موجود" };
  if (!rowInScope(req, inc.branchId))
    return { ok: false as const, status: 403, error: "لا يمكنك العمل على هذا الفرع" };
  return { ok: true as const };
}

router.post("/incidents/:id/actions", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [inc] = await db
      .select({ id: safetyIncidentsTable.id, branchId: safetyIncidentsTable.branchId })
      .from(safetyIncidentsTable)
      .where(
        and(
          eq(safetyIncidentsTable.id, id),
          eq(safetyIncidentsTable.companyId, cid),
        ),
      );
    if (!inc) {
      res.status(404).json({ error: "الحادث غير موجود" });
      return;
    }
    if (!rowInScope(req, inc.branchId)) {
      res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      return;
    }
    const b = req.body ?? {};
    if (!b.description || typeof b.description !== "string") {
      res.status(400).json({ error: "وصف الإجراء مطلوب" });
      return;
    }
    const refErr = await firstInvalidRef(cid, [
      { table: usersTable, id: b.ownerUserId ? num(b.ownerUserId) : null, error: "المستخدم المسؤول غير موجود في الشركة" },
    ]);
    if (refErr) {
      res.status(400).json({ error: refErr });
      return;
    }
    const [row] = await db
      .insert(safetyIncidentActionsTable)
      .values({
        companyId: cid,
        incidentId: id,
        actionType: oneOf(SAFETY_ACTION_TYPES, b.actionType, "corrective"),
        description: b.description.trim(),
        ownerUserId: b.ownerUserId ? num(b.ownerUserId) : null,
        dueDate: b.dueDate || null,
        status: oneOf(SAFETY_ACTION_STATUSES, b.status, "open"),
      })
      .returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/actions/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [existing] = await db
      .select()
      .from(safetyIncidentActionsTable)
      .where(
        and(
          eq(safetyIncidentActionsTable.id, id),
          eq(safetyIncidentActionsTable.companyId, cid),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "الإجراء غير موجود" });
      return;
    }
    const scope = await assertIncidentScope(req, cid, existing.incidentId);
    if (!scope.ok) {
      res.status(scope.status).json({ error: scope.error });
      return;
    }
    const b = req.body ?? {};
    const refErr = await firstInvalidRef(cid, [
      { table: usersTable, id: b.ownerUserId ? num(b.ownerUserId) : null, error: "المستخدم المسؤول غير موجود في الشركة" },
    ]);
    if (refErr) {
      res.status(400).json({ error: refErr });
      return;
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (b.actionType !== undefined)
      updates.actionType = oneOf(SAFETY_ACTION_TYPES, b.actionType, existing.actionType);
    if (typeof b.description === "string") updates.description = b.description.trim();
    if (b.ownerUserId !== undefined)
      updates.ownerUserId = b.ownerUserId ? num(b.ownerUserId) : null;
    if (b.dueDate !== undefined) updates.dueDate = b.dueDate || null;
    if (b.status !== undefined) {
      const st = oneOf(SAFETY_ACTION_STATUSES, b.status, existing.status);
      updates.status = st;
      updates.completedAt = st === "done" ? (existing.completedAt ?? new Date()) : null;
    }
    const [row] = await db
      .update(safetyIncidentActionsTable)
      .set(updates)
      .where(
        and(
          eq(safetyIncidentActionsTable.id, id),
          eq(safetyIncidentActionsTable.companyId, cid),
        ),
      )
      .returning();
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/actions/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [existing] = await db
      .select({ incidentId: safetyIncidentActionsTable.incidentId })
      .from(safetyIncidentActionsTable)
      .where(
        and(
          eq(safetyIncidentActionsTable.id, id),
          eq(safetyIncidentActionsTable.companyId, cid),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "الإجراء غير موجود" });
      return;
    }
    const scope = await assertIncidentScope(req, cid, existing.incidentId);
    if (!scope.ok) {
      res.status(scope.status).json({ error: scope.error });
      return;
    }
    await db
      .delete(safetyIncidentActionsTable)
      .where(
        and(
          eq(safetyIncidentActionsTable.id, id),
          eq(safetyIncidentActionsTable.companyId, cid),
        ),
      );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
