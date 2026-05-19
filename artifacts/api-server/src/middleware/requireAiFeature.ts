// AI feature gate.
//
// Wraps an AI route so that, before the expensive LLM call:
//   1. We resolve the calling company (req.user.companyId, or
//      x-acting-company-id for SuperAdmins).
//   2. We check ai_feature_settings for the company-specific override;
//      fall back to the system-default row (company_id IS NULL); fall
//      back to "enabled with no quota" if neither exists.
//   3. If the feature is disabled → 403 (and we log a blocked entry).
//   4. If today's usage already hit dailyLimit → 429 (and we log a
//      blocked entry). Same for monthlyLimit.
//
// On success the handler is invoked; the handler MUST then call
// logAiUsage(...) once it knows the outcome, so the counter advances
// and the admin dashboard reflects reality.
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  AI_FEATURE_CATALOG,
  type AiFeatureKey,
} from "@workspace/db";

interface ResolvedSetting {
  isEnabled:    boolean;
  dailyLimit:   number | null;
  monthlyLimit: number | null;
  source:       "company" | "system" | "catalog";
}

async function resolveSetting(
  companyId: number | null,
  featureKey: AiFeatureKey | string,
): Promise<ResolvedSetting> {
  if (companyId != null) {
    const r: any = await db.execute(sql`
      SELECT is_enabled, daily_limit, monthly_limit
        FROM ai_feature_settings
       WHERE company_id = ${companyId} AND feature_key = ${featureKey}
       LIMIT 1
    `);
    const row = r.rows?.[0];
    if (row) {
      return {
        isEnabled:    !!row.is_enabled,
        dailyLimit:   row.daily_limit == null ? null : Number(row.daily_limit),
        monthlyLimit: row.monthly_limit == null ? null : Number(row.monthly_limit),
        source:       "company",
      };
    }
  }

  const sys: any = await db.execute(sql`
    SELECT is_enabled, daily_limit, monthly_limit
      FROM ai_feature_settings
     WHERE company_id IS NULL AND feature_key = ${featureKey}
     LIMIT 1
  `);
  const sysRow = sys.rows?.[0];
  if (sysRow) {
    return {
      isEnabled:    !!sysRow.is_enabled,
      dailyLimit:   sysRow.daily_limit == null ? null : Number(sysRow.daily_limit),
      monthlyLimit: sysRow.monthly_limit == null ? null : Number(sysRow.monthly_limit),
      source:       "system",
    };
  }

  // Catalog default — feature is unknown to the DB but listed in code.
  const cat = AI_FEATURE_CATALOG.find(f => f.key === featureKey);
  return {
    isEnabled:    true,
    dailyLimit:   cat?.defaultDaily ?? null,
    monthlyLimit: null,
    source:       "catalog",
  };
}

async function countUsage(
  companyId: number | null,
  featureKey: string,
  windowStart: Date,
): Promise<number> {
  const r: any = await db.execute(sql`
    SELECT COUNT(*) AS n
      FROM ai_usage_log
     WHERE feature_key = ${featureKey}
       AND status = 'allowed'
       AND created_at >= ${windowStart.toISOString()}
       AND ${companyId == null ? sql`company_id IS NULL` : sql`company_id = ${companyId}`}
  `);
  return Number(r.rows?.[0]?.n ?? 0);
}

async function logBlocked(
  req: Request,
  featureKey: string,
  status: string,
  companyId: number | null,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO ai_usage_log (company_id, user_id, feature_key, status, provider)
      VALUES (${companyId}, ${(req as any).authUser?.id ?? null}, ${featureKey}, ${status}, 'none')
    `);
  } catch (e) {
    (req as any).log?.warn?.({ err: e, featureKey }, "ai_usage_log insert failed");
  }
}

export function requireAiFeature(featureKey: AiFeatureKey | string) {
  return async function aiFeatureGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const u = (req as any).authUser;
    if (!u) { res.status(401).json({ error: "auth required" }); return; }

    // SuperAdmin impersonation header wins; otherwise the user's own company.
    let companyId: number | null = null;
    if (u.role === "superadmin") {
      const acting = String(req.header("x-acting-company-id") || "").trim();
      companyId = acting ? Number(acting) || null : null;
    } else {
      companyId = u.companyId ?? null;
    }
    // SuperAdmins with no acting company → skip the gate entirely
    // (testing/diagnostics shouldn't trip per-tenant quotas).
    if (u.role === "superadmin" && companyId == null) {
      (req as any).aiFeature = { companyId: null, featureKey, bypass: true };
      next();
      return;
    }

    const setting = await resolveSetting(companyId, featureKey);

    if (!setting.isEnabled) {
      await logBlocked(req, featureKey, "blocked_disabled", companyId);
      res.status(403).json({
        error:     "ai_feature_disabled",
        featureKey,
        message:   "تم إيقاف هذه الميزة من قبل المشرف العام.",
      });
      return;
    }

    if (setting.dailyLimit != null) {
      const start = new Date(); start.setUTCHours(0, 0, 0, 0);
      const used = await countUsage(companyId, featureKey, start);
      if (used >= setting.dailyLimit) {
        await logBlocked(req, featureKey, "blocked_daily_limit", companyId);
        res.status(429).json({
          error:     "ai_daily_limit_reached",
          featureKey,
          dailyLimit: setting.dailyLimit,
          used,
          message:   `تم بلوغ الحد اليومي (${setting.dailyLimit} طلب) لهذه الميزة. حاول غداً أو راجع المشرف.`,
        });
        return;
      }
    }

    if (setting.monthlyLimit != null) {
      const m = new Date(); m.setUTCDate(1); m.setUTCHours(0, 0, 0, 0);
      const used = await countUsage(companyId, featureKey, m);
      if (used >= setting.monthlyLimit) {
        await logBlocked(req, featureKey, "blocked_monthly_limit", companyId);
        res.status(429).json({
          error:        "ai_monthly_limit_reached",
          featureKey,
          monthlyLimit: setting.monthlyLimit,
          used,
          message:      `تم بلوغ الحد الشهري (${setting.monthlyLimit} طلب) لهذه الميزة.`,
        });
        return;
      }
    }

    (req as any).aiFeature = { companyId, featureKey, bypass: false };
    next();
  };
}

/** Call once from inside the route handler after the AI call finishes. */
export async function logAiUsage(
  req: Request,
  outcome: {
    status:     "allowed" | "error";
    provider?:  string | null;
    tokensIn?:  number | null;
    tokensOut?: number | null;
    durationMs?: number | null;
    meta?:      Record<string, unknown>;
  },
): Promise<void> {
  const f = (req as any).aiFeature as { companyId: number | null; featureKey: string; bypass?: boolean } | undefined;
  if (!f || f.bypass) return;
  try {
    await db.execute(sql`
      INSERT INTO ai_usage_log
        (company_id, user_id, feature_key, status, provider, tokens_in, tokens_out, duration_ms, meta)
      VALUES (
        ${f.companyId},
        ${(req as any).authUser?.id ?? null},
        ${f.featureKey},
        ${outcome.status},
        ${outcome.provider ?? null},
        ${outcome.tokensIn ?? null},
        ${outcome.tokensOut ?? null},
        ${outcome.durationMs ?? null},
        ${outcome.meta ? sql`${JSON.stringify(outcome.meta)}::jsonb` : sql`NULL`}
      )
    `);
  } catch (e) {
    (req as any).log?.warn?.({ err: e, featureKey: f.featureKey }, "ai_usage_log insert failed");
  }
}
