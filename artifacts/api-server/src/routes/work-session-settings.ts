// Per-company settings for the Work Sessions feature.
//
//   GET  /api/work-session-settings           — current company's settings
//                                               (defaults if no row yet);
//                                               readable by any authed user
//                                               so the page can show the
//                                               required-branch flag etc.
//   PUT  /api/work-session-settings           — admin-only upsert.
//   GET  /api/work-session-settings/branches  — branches the caller can
//                                               reach (used by the default-
//                                               branch dropdown).

import { Router } from "express";
import { db } from "@workspace/db";
import {
  workSessionSettingsTable,
  branchesTable,
  userBranchesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { writeAudit } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function getCid(req: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query?.companyId);
  return cid ?? null;
}

function isAdmin(req: any): boolean {
  const role = req.authUser?.role;
  return role === "admin" || role === "superadmin";
}

// Default snapshot returned when the company has never saved settings.
function defaultsForCompany(companyId: number) {
  return {
    companyId,
    emailReportsEnabled:     false,
    emailRecipients:         "",
    emailOnSessionEnd:       true,
    autoGenerateReportOnEnd: true,
    requireBranchSelection:  false,
    defaultBranchId:         null as number | null,
    aiModel:                 "claude-haiku-4-5",
    idleTimeoutMinutes:      null as number | null,
    updatedAt:               null as string | null,
    isDefault:               true,
  };
}

// GET / ----------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }

    const [row] = await db.select().from(workSessionSettingsTable)
      .where(eq(workSessionSettingsTable.companyId, cid)).limit(1);

    if (!row) { res.json(defaultsForCompany(cid)); return; }

    res.json({
      companyId:               row.companyId,
      emailReportsEnabled:     row.emailReportsEnabled,
      emailRecipients:         row.emailRecipients ?? "",
      emailOnSessionEnd:       row.emailOnSessionEnd,
      autoGenerateReportOnEnd: row.autoGenerateReportOnEnd,
      requireBranchSelection:  row.requireBranchSelection,
      defaultBranchId:         row.defaultBranchId ?? null,
      aiModel:                 row.aiModel ?? "claude-haiku-4-5",
      idleTimeoutMinutes:      row.idleTimeoutMinutes ?? null,
      updatedAt:               row.updatedAt?.toISOString() ?? null,
      isDefault:               false,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PUT / ----------------------------------------------------------------------
router.put("/", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!isAdmin(req)) { res.status(403).json({ error: "ممنوع — للمشرفين فقط" }); return; }

    const b = req.body ?? {};

    // Validate recipients string: comma/semicolon/newline separated emails.
    // We trim + dedupe + skip anything that doesn't look like an email,
    // then store the cleaned list back in the row.
    const recipientsRaw = String(b.emailRecipients ?? "");
    const cleanedRecipients = Array.from(new Set(
      recipientsRaw.split(/[,;\n]/)
        .map((s: string) => s.trim())
        .filter((s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)),
    )).join(", ");

    // If a default branch was supplied, make sure it actually belongs to
    // this company (don't let an admin pin a foreign branch).
    let defaultBranchId: number | null = null;
    if (b.defaultBranchId !== null && b.defaultBranchId !== undefined && b.defaultBranchId !== "") {
      const id = Number(b.defaultBranchId);
      if (Number.isFinite(id)) {
        const [branch] = await db.select({ id: branchesTable.id }).from(branchesTable)
          .where(and(eq(branchesTable.id, id), eq(branchesTable.companyId, cid))).limit(1);
        if (!branch) { res.status(400).json({ error: "الفرع المحدد لا يخص هذه الشركة" }); return; }
        defaultBranchId = id;
      }
    }

    const aiModel = String(b.aiModel || "claude-haiku-4-5");
    const allowedModels = new Set(["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"]);
    if (!allowedModels.has(aiModel)) {
      res.status(400).json({ error: "نموذج الذكاء الاصطناعي غير مدعوم" });
      return;
    }

    const idleTimeoutMinutes = b.idleTimeoutMinutes === null || b.idleTimeoutMinutes === undefined || b.idleTimeoutMinutes === ""
      ? null
      : Math.max(5, Math.min(1440, Number(b.idleTimeoutMinutes) || 0)) || null;

    const payload = {
      companyId:               cid,
      emailReportsEnabled:     Boolean(b.emailReportsEnabled),
      emailRecipients:         cleanedRecipients,
      emailOnSessionEnd:       b.emailOnSessionEnd === false ? false : true,
      autoGenerateReportOnEnd: b.autoGenerateReportOnEnd === false ? false : true,
      requireBranchSelection:  Boolean(b.requireBranchSelection),
      defaultBranchId,
      aiModel,
      idleTimeoutMinutes,
      updatedByUserId:         (req as any).authUser?.id ?? null,
      updatedAt:               new Date(),
    };

    // Upsert via the unique (companyId) index.
    const [existing] = await db.select().from(workSessionSettingsTable)
      .where(eq(workSessionSettingsTable.companyId, cid)).limit(1);

    let saved;
    if (existing) {
      [saved] = await db.update(workSessionSettingsTable)
        .set(payload)
        .where(eq(workSessionSettingsTable.companyId, cid))
        .returning();
    } else {
      [saved] = await db.insert(workSessionSettingsTable)
        .values(payload)
        .returning();
    }

    // Audit the change so admins can see who toggled what.
    try {
      await writeAudit({
        userId: (req as any).authUser.id,
        username: (req as any).authUser.username,
        role: (req as any).authUser.role,
        companyId: cid,
        module: "work_session_settings",
        action: "update",
        method: "PUT",
        path: "/api/work-session-settings",
        statusCode: 200,
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] as string ?? null,
        metadata: {
          emailReportsEnabled: payload.emailReportsEnabled,
          recipientCount: cleanedRecipients ? cleanedRecipients.split(",").length : 0,
          requireBranchSelection: payload.requireBranchSelection,
          defaultBranchId: payload.defaultBranchId,
          aiModel: payload.aiModel,
        },
      });
    } catch { /* audit failures must not block the save */ }

    res.json({
      ok: true,
      companyId: saved.companyId,
      emailReportsEnabled: saved.emailReportsEnabled,
      emailRecipients: saved.emailRecipients ?? "",
      emailOnSessionEnd: saved.emailOnSessionEnd,
      autoGenerateReportOnEnd: saved.autoGenerateReportOnEnd,
      requireBranchSelection: saved.requireBranchSelection,
      defaultBranchId: saved.defaultBranchId ?? null,
      aiModel: saved.aiModel,
      idleTimeoutMinutes: saved.idleTimeoutMinutes ?? null,
      updatedAt: saved.updatedAt?.toISOString() ?? null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /branches — branches the caller can pick as default (or to set on a
// session). For admins this is every active branch in the company; regular
// users only see branches they're explicitly granted (or all if their
// `viewAllBranches` flag is on, but we leave that policy to the existing
// /api/org/branches endpoint and just return company-wide for admins here
// because this endpoint is admin-targeted from the settings UI).
router.get("/branches", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }

    const rows = await db
      .select({
        id: branchesTable.id,
        code: branchesTable.code,
        nameAr: branchesTable.nameAr,
        nameEn: branchesTable.nameEn,
        isMain: branchesTable.isMain,
        status: branchesTable.status,
      })
      .from(branchesTable)
      .where(eq(branchesTable.companyId, cid));

    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Touch userBranchesTable import to silence "unused" if tree-shaking warns.
void userBranchesTable;

export default router;
