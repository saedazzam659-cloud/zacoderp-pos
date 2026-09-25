import { Router } from "express";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { getContractingProjectReports } from "../lib/contracting-project-reports-service.js";
import { consolidatedOperationTypes } from "../lib/project-financial-sources.js";

const router = Router();

router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }
  next();
});
router.use(requirePermission("contracting", "view"));

router.get("/projects/:projectId/reports", async (req, res) => {
  const companyId = await resolveCompanyId(req, undefined);
  if (!companyId) {
    res.status(400).json({ error: "لا توجد شركة فعالة" });
    return;
  }
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    res.status(400).json({ error: "المشروع غير صالح" });
    return;
  }
  try {
    const rawIncludeDescendants = req.query.includeDescendants;
    if (rawIncludeDescendants != null
      && rawIncludeDescendants !== "true"
      && rawIncludeDescendants !== "false") {
      res.status(400).json({ error: "includeDescendants يجب أن تكون true أو false" });
      return;
    }
    const readDate = (key: "dateFrom" | "dateTo") => {
      const value = req.query[key];
      if (value == null || value === "") return undefined;
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
        || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw Object.assign(new Error(`${key} يجب أن يكون تاريخاً صالحاً بصيغة YYYY-MM-DD`), { status: 400 });
      }
      return value;
    };
    const dateFrom = readDate("dateFrom");
    const dateTo = readDate("dateTo");
    if (dateFrom && dateTo && dateFrom > dateTo) {
      res.status(400).json({ error: "تاريخ البداية يجب ألا يتجاوز تاريخ النهاية" });
      return;
    }
    const operationType = req.query.operationType;
    if (operationType != null && !consolidatedOperationTypes.includes(operationType as any)) {
      res.status(400).json({ error: "نوع العملية غير صالح" });
      return;
    }
    res.json(await getContractingProjectReports(companyId, projectId, req.authUser, {
      includeDescendants: rawIncludeDescendants === "true",
      dateFrom, dateTo, operationType: operationType as any,
    }));
  } catch (caught: any) {
    const status = Number(caught?.status) || 500;
    res.status(status).json({ error: caught?.message ?? "تعذر تحميل تقارير المشروع" });
  }
});

export default router;