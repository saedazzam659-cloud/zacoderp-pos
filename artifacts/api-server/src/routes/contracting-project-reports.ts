import { Router } from "express";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { getContractingProjectReports } from "../lib/contracting-project-reports-service.js";

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
    res.json(await getContractingProjectReports(companyId, projectId, req.authUser, {
      includeDescendants: rawIncludeDescendants === "true",
    }));
  } catch (caught: any) {
    const status = Number(caught?.status) || 500;
    res.status(status).json({ error: caught?.message ?? "تعذر تحميل تقارير المشروع" });
  }
});

export default router;