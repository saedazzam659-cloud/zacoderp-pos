import { Router, type Request, type Response } from "express";
import {
  agentInstancesTable,
  centralDb,
  db,
  runWithExternalDb,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { annualSequenceCarryForwardNextNumber } from "../lib/sequences.js";
import { getAgentDbContext } from "../lib/agentDb.js";
import { writeAudit } from "../middleware/permissions.js";

const router = Router();

type SequenceCandidate = {
  sequenceId: number;
  companyId: number;
  companyName: string;
  sequenceCode: string;
  startNumber: number;
  currentNumber: number;
  endNumber: number;
  monthlyReset: boolean;
  nextNumber: number;
};

type DatabaseScope = {
  type: "central" | "agent";
  agentId: number | null;
  name: string;
  dbUrlEnc?: string;
};

async function getDatabaseScopes(): Promise<{ scopes: DatabaseScope[]; unavailableAgents: Array<{ id: number; name: string }> }> {
  const agentRows = await centralDb.select({
    id: agentInstancesTable.id,
    name: agentInstancesTable.name,
    dbUrlEnc: agentInstancesTable.dbUrlEnc,
    dbStatus: agentInstancesTable.dbStatus,
  }).from(agentInstancesTable);

  const unavailableAgents = agentRows
    .filter((agent) =>
      (agent.dbStatus === "initialized" && !agent.dbUrlEnc)
      || (!!agent.dbUrlEnc && agent.dbStatus !== "initialized"),
    )
    .map((agent) => ({ id: agent.id, name: agent.name ?? `وكيل ${agent.id}` }));
  const scopes: DatabaseScope[] = [{
    type: "central",
    agentId: null,
    name: "قاعدة المركز",
  }];
  for (const agent of agentRows) {
    if (agent.dbStatus !== "initialized" || !agent.dbUrlEnc) continue;
    scopes.push({
      type: "agent",
      agentId: agent.id,
      name: agent.name ?? `وكيل ${agent.id}`,
      dbUrlEnc: agent.dbUrlEnc,
    });
  }
  return { scopes, unavailableAgents };
}

async function withDatabaseScope<T>(scope: DatabaseScope, fn: (database: any) => Promise<T>): Promise<T> {
  if (scope.type === "central") return fn(centralDb);
  const context = getAgentDbContext(scope.agentId!, scope.dbUrlEnc!);
  return runWithExternalDb(context, () => fn(db));
}

function routeError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

async function getCompanyDatabaseScope(req: Request): Promise<DatabaseScope> {
  const rawAgentId = String(req.query.agent ?? "").trim();
  if (!rawAgentId) {
    return { type: "central", agentId: null, name: "قاعدة المركز" };
  }
  if (!/^[1-9]\d*$/.test(rawAgentId) || !Number.isSafeInteger(Number(rawAgentId))) {
    throw routeError("معرّف الوكيل غير صحيح.", 400);
  }
  const agentId = Number(rawAgentId);
  const [agent] = await centralDb.select({
    id: agentInstancesTable.id,
    name: agentInstancesTable.name,
    dbUrlEnc: agentInstancesTable.dbUrlEnc,
    dbStatus: agentInstancesTable.dbStatus,
  }).from(agentInstancesTable).where(eq(agentInstancesTable.id, agentId)).limit(1);
  if (!agent) throw routeError("الوكيل غير موجود.", 404);
  if (agent.dbStatus !== "initialized" || !agent.dbUrlEnc) {
    throw routeError("قاعدة بيانات الوكيل غير جاهزة أو غير متاحة.", 503);
  }
  return {
    type: "agent",
    agentId: agent.id,
    name: agent.name ?? `وكيل ${agent.id}`,
    dbUrlEnc: agent.dbUrlEnc,
  };
}

async function getCompany(database: any, companyId: number) {
  const result = await database.execute(sql`
    SELECT id, COALESCE(NULLIF(name_ar, ''), NULLIF(name_en, ''), 'شركة بدون اسم') AS company_name
    FROM companies
    WHERE id = ${companyId} AND deleted_at IS NULL
    LIMIT 1
  `);
  return result.rows?.[0] ?? null;
}

async function getCandidates(database: any, lock = false, companyId?: number): Promise<SequenceCandidate[]> {
  const rows = await database.execute(sql`
    SELECT
      s.id AS sequence_id,
      s.company_id,
      COALESCE(NULLIF(c.name_ar, ''), NULLIF(c.name_en, ''), 'شركة بدون اسم') AS company_name,
      s.code AS sequence_code,
      s.start_number,
      s.current_number,
      s.end_number,
      s.monthly_reset
    FROM sequences s
    JOIN companies c ON c.id = s.company_id
    WHERE s.annual_reset = TRUE
      AND c.deleted_at IS NULL
      ${companyId == null ? sql`` : sql`AND s.company_id = ${companyId}`}
    ORDER BY c.id, s.id
    ${lock ? sql`FOR UPDATE OF s` : sql``}
  `);
  const candidates: SequenceCandidate[] = [];
  for (const row of rows.rows ?? []) {
    const sequenceId = Number(row.sequence_id);
    const companyId = Number(row.company_id);
    const startNumber = Number(row.start_number);
    const currentNumber = Number(row.current_number);
    const endNumber = Number(row.end_number);
    const monthlyReset = row.monthly_reset === true;
    const nextNumber = monthlyReset
      ? Math.max(startNumber, currentNumber)
      : await annualSequenceCarryForwardNextNumber(database, sequenceId, startNumber, currentNumber);
    if (![sequenceId, companyId, startNumber, currentNumber, endNumber, nextNumber].every(Number.isSafeInteger)) {
      throw new Error("تعذر التحقق من أرقام أحد المسلسلات؛ أوقفنا العملية دون تعديل.");
    }
    candidates.push({
      sequenceId,
      companyId,
      companyName: String(row.company_name ?? "شركة بدون اسم"),
      sequenceCode: String(row.sequence_code ?? ""),
      startNumber,
      currentNumber,
      endNumber,
      monthlyReset,
      nextNumber,
    });
  }
  return candidates;
}

async function countExplicitResetPolicies(database: any, companyId?: number): Promise<number> {
  const rows = await database.execute(sql`
    SELECT COUNT(*)::int AS total
    FROM system_settings
    WHERE key LIKE 'fiscal_year_sequence_policy:%'
      AND value = 'reset'
      ${companyId == null ? sql`` : sql`AND key LIKE ${`fiscal_year_sequence_policy:${companyId}:%`}`}
  `);
  return Number(rows.rows?.[0]?.total ?? 0);
}

function summarizeScope(scope: DatabaseScope, candidates: SequenceCandidate[], resetPoliciesPreserved: number) {
  const blocked = candidates.filter((candidate) => !candidate.monthlyReset && candidate.nextNumber > candidate.endNumber);
  return {
    type: scope.type,
    agentId: scope.agentId,
    name: scope.name,
    eligibleCount: candidates.length - blocked.length,
    blockedCount: blocked.length,
    resetPoliciesPreserved,
    blocked: blocked.slice(0, 50).map((candidate) => ({
      companyId: candidate.companyId,
      companyName: candidate.companyName,
      sequenceId: candidate.sequenceId,
      sequenceCode: candidate.sequenceCode,
      nextNumber: candidate.nextNumber,
      endNumber: candidate.endNumber,
    })),
  };
}

async function collectPreview(scope: DatabaseScope) {
  return withDatabaseScope(scope, async (database) => {
    const [candidates, resetPoliciesPreserved] = await Promise.all([
      getCandidates(database),
      countExplicitResetPolicies(database),
    ]);
    return summarizeScope(scope, candidates, resetPoliciesPreserved);
  });
}

async function collectCompanyPreview(scope: DatabaseScope, companyId: number) {
  return withDatabaseScope(scope, async (database) => {
    const company = await getCompany(database, companyId);
    if (!company) throw routeError("الشركة غير موجودة في قاعدة البيانات المحددة.", 404);
    const [candidates, resetPoliciesPreserved] = await Promise.all([
      getCandidates(database, false, companyId),
      countExplicitResetPolicies(database, companyId),
    ]);
    const blockedIds = new Set(
      candidates
        .filter((candidate) => !candidate.monthlyReset && candidate.nextNumber > candidate.endNumber)
        .map((candidate) => candidate.sequenceId),
    );
    return {
      canApply: true,
      companyId,
      companyName: String(company.company_name ?? "شركة بدون اسم"),
      location: { type: scope.type, agentId: scope.agentId, name: scope.name },
      eligibleCount: candidates.length - blockedIds.size,
      blockedCount: blockedIds.size,
      resetPoliciesPreserved,
      sequences: candidates.map((candidate) => ({
        sequenceId: candidate.sequenceId,
        code: candidate.sequenceCode,
        currentNumber: candidate.currentNumber,
        nextNumber: candidate.nextNumber,
        endNumber: candidate.endNumber,
        monthlyReset: candidate.monthlyReset,
        eligible: !blockedIds.has(candidate.sequenceId),
      })),
    };
  });
}

router.get("/companies/:id/preview", async (req: Request, res: Response): Promise<void> => {
  const rawCompanyId = String(req.params.id ?? "");
  const companyId = Number(rawCompanyId);
  if (!/^[1-9]\d*$/.test(rawCompanyId) || !Number.isSafeInteger(companyId)) {
    res.status(400).json({ error: "معرّف الشركة غير صحيح." });
    return;
  }
  try {
    const scope = await getCompanyDatabaseScope(req);
    res.json(await collectCompanyPreview(scope, companyId));
  } catch (error: any) {
    const status = Number(error?.status);
    if (status >= 500) req.log?.error({ errorName: error?.name, companyId }, "Company annual sequence preview failed");
    res.status(status || 503).json({ error: status ? String(error.message) : "تعذر فحص مسلسلات الشركة." });
  }
});

router.post("/companies/:id/disable", async (req: Request, res: Response): Promise<void> => {
  const admin = req.adminUser;
  if (!admin) {
    res.status(403).json({ error: "هذه العملية للمشرف العام فقط." });
    return;
  }
  const rawCompanyId = String(req.params.id ?? "");
  const companyId = Number(rawCompanyId);
  if (!/^[1-9]\d*$/.test(rawCompanyId) || !Number.isSafeInteger(companyId)) {
    res.status(400).json({ error: "معرّف الشركة غير صحيح." });
    return;
  }
  try {
    const scope = await getCompanyDatabaseScope(req);
    const result = await withDatabaseScope(scope, async (database) => {
      const outcome = await database.transaction(async (tx: any) => {
        const company = await getCompany(tx, companyId);
        if (!company) throw routeError("الشركة غير موجودة في قاعدة البيانات المحددة.", 404);
        const candidates = await getCandidates(tx, true, companyId);
        const blocked: Array<{ sequenceId: number; code: string; nextNumber: number; endNumber: number }> = [];
        let updatedCount = 0;
        for (const candidate of candidates) {
          if (!candidate.monthlyReset && candidate.nextNumber > candidate.endNumber) {
            blocked.push({
              sequenceId: candidate.sequenceId,
              code: candidate.sequenceCode,
              nextNumber: candidate.nextNumber,
              endNumber: candidate.endNumber,
            });
            continue;
          }
          const nextNumber = candidate.monthlyReset
            ? Math.max(candidate.startNumber, candidate.currentNumber)
            : candidate.nextNumber;
          await tx.execute(sql`
            UPDATE sequences
            SET annual_reset = FALSE,
                current_number = ${nextNumber},
                updated_at = NOW()
            WHERE id = ${candidate.sequenceId}
              AND company_id = ${companyId}
              AND annual_reset = TRUE
          `);
          updatedCount += 1;
        }
        return {
          companyName: String(company.company_name ?? "شركة بدون اسم"),
          updatedCount,
          blocked,
          resetPoliciesPreserved: await countExplicitResetPolicies(tx, companyId),
        };
      });
      await writeAudit({
        userId: admin.id,
        username: admin.username,
        role: "superadmin",
        companyId,
        module: "sequences",
        action: "disable_annual_reset_company",
        entityType: "sequence",
        metadata: {
          companyName: outcome.companyName,
          updatedSequenceCount: outcome.updatedCount,
          blockedSequenceIds: outcome.blocked.map((item: { sequenceId: number }) => item.sequenceId),
          resetPoliciesPreserved: outcome.resetPoliciesPreserved,
          scope: scope.type,
          agentId: scope.agentId,
        },
        statusCode: 200,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        evaluateInternalControl: false,
      });
      return outcome;
    });
    res.json({
      complete: true,
      companyId,
      ...result,
      blockedCount: result.blocked.length,
    });
  } catch (error: any) {
    const status = Number(error?.status);
    req.log?.error({ errorName: error?.name, companyId }, "Company annual sequence update failed");
    res.status(status || 503).json({ complete: false, error: status ? String(error.message) : "تعذر تعطيل إعادة البدء السنوي للشركة." });
  }
});

router.get("/preview", async (req: Request, res: Response): Promise<void> => {
  try {
    const { scopes, unavailableAgents } = await getDatabaseScopes();
    if (unavailableAgents.length) {
      res.status(503).json({
        error: "تعذر التأكد من كل قواعد الوكلاء؛ لم يُجر أي تعديل.",
        unavailableAgents,
      });
      return;
    }
    const locations = [];
    for (const scope of scopes) locations.push(await collectPreview(scope));
    res.json({
      canApply: true,
      locations,
      totalEligible: locations.reduce((sum, item) => sum + item.eligibleCount, 0),
      totalBlocked: locations.reduce((sum, item) => sum + item.blockedCount, 0),
      totalResetPoliciesPreserved: locations.reduce((sum, item) => sum + item.resetPoliciesPreserved, 0),
    });
  } catch (error: any) {
    req.log?.error({ errorName: error?.name }, "Annual sequence reset preview failed");
    res.status(503).json({ error: "تعذر فحص قواعد البيانات؛ لم يُجر أي تعديل." });
  }
});

router.post("/disable-all", async (req: Request, res: Response): Promise<void> => {
  const admin = req.adminUser;
  if (!admin) {
    res.status(403).json({ error: "هذه العملية للمشرف العام فقط." });
    return;
  }
  try {
    const { scopes, unavailableAgents } = await getDatabaseScopes();
    if (unavailableAgents.length) {
      res.status(503).json({
        complete: false,
        error: "تعذر التأكد من كل قواعد الوكلاء؛ لم يبدأ التعديل.",
        unavailableAgents,
      });
      return;
    }
    // Preflight every database before the first write so a known offline agent
    // cannot cause an avoidable partial update.
    const preflight = [];
    for (const scope of scopes) preflight.push(await collectPreview(scope));

    const locations = [];
    for (const scope of scopes) {
      try {
        const result = await withDatabaseScope(scope, async (database) => {
          const updatedByCompany = new Map<number, { name: string; count: number }>();
          const blocked: ReturnType<typeof summarizeScope>["blocked"] = [];
          let blockedCount = 0;
          await database.transaction(async (tx: any) => {
            const candidates = await getCandidates(tx, true);
            for (const candidate of candidates) {
              if (!candidate.monthlyReset && candidate.nextNumber > candidate.endNumber) {
                blockedCount += 1;
                if (blocked.length < 50) blocked.push({
                  companyId: candidate.companyId,
                  companyName: candidate.companyName,
                  sequenceId: candidate.sequenceId,
                  sequenceCode: candidate.sequenceCode,
                  nextNumber: candidate.nextNumber,
                  endNumber: candidate.endNumber,
                });
                continue;
              }
              const nextNumber = candidate.monthlyReset
                ? Math.max(candidate.startNumber, candidate.currentNumber)
                : candidate.nextNumber;
              await tx.execute(sql`
                UPDATE sequences
                SET annual_reset = FALSE,
                    current_number = ${nextNumber},
                    updated_at = NOW()
                WHERE id = ${candidate.sequenceId}
                  AND annual_reset = TRUE
              `);
              const company = updatedByCompany.get(candidate.companyId) ?? {
                name: candidate.companyName,
                count: 0,
              };
              company.count += 1;
              updatedByCompany.set(candidate.companyId, company);
            }
          });
          for (const [companyId, company] of updatedByCompany) {
            await writeAudit({
              userId: admin.id,
              username: admin.username,
              role: "superadmin",
              companyId,
              module: "sequences",
              action: "disable_annual_reset_bulk",
              entityType: "sequence",
              metadata: {
                companyName: company.name,
                updatedSequenceCount: company.count,
                scope: scope.type,
                agentId: scope.agentId,
              },
              statusCode: 200,
              ip: req.ip ?? null,
              userAgent: req.get("user-agent") ?? null,
              evaluateInternalControl: false,
            });
          }
          return {
            type: scope.type,
            agentId: scope.agentId,
            name: scope.name,
            updatedCount: [...updatedByCompany.values()].reduce((sum, company) => sum + company.count, 0),
            blockedCount,
            blocked,
            resetPoliciesPreserved: await countExplicitResetPolicies(database),
            error: null,
          };
        });
        locations.push(result);
      } catch (error: any) {
        req.log?.error({ scope: scope.type, agentId: scope.agentId, errorName: error?.name }, "Annual sequence reset scope failed");
        locations.push({
          type: scope.type,
          agentId: scope.agentId,
          name: scope.name,
          updatedCount: 0,
          blockedCount: 0,
          blocked: [],
          resetPoliciesPreserved: 0,
          error: "تعذر تعديل قاعدة البيانات هذه.",
        });
      }
    }
    const totalUpdated = locations.reduce((sum, item) => sum + item.updatedCount, 0);
    const totalBlocked = locations.reduce((sum, item) => sum + item.blockedCount, 0);
    const complete = locations.every((item) => item.error == null);
    res.status(complete ? 200 : 207).json({
      complete,
      totalUpdated,
      totalBlocked,
      totalResetPoliciesPreserved: locations.reduce((sum, item) => sum + item.resetPoliciesPreserved, 0),
      preflight,
      locations,
    });
  } catch (error: any) {
    req.log?.error({ errorName: error?.name }, "Annual sequence reset bulk update failed before completion");
    res.status(503).json({ complete: false, error: "تعذر إكمال التعديل الجماعي." });
  }
});

export default router;
