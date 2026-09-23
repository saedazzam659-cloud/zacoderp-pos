import { Router } from "express";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import {
  createContractingCostAllocation,
  ensureContractingCostAllocationTables,
  listContractingCostAllocations,
  listContractingCostSources,
  reverseContractingCostAllocation,
} from "../lib/contracting-cost-allocation-service.js";

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
router.use(async (_req, _res, next) => {
  try {
    await ensureContractingCostAllocationTables();
    next();
  } catch (error) {
    next(error);
  }
});

async function tenant(req: any, res: any) {
  const companyId = await resolveCompanyId(req, undefined);
  if (!companyId) res.status(400).json({ error: "لا توجد شركة فعالة" });
  return companyId || null;
}

function sendError(res: any, caught: any) {
  res.status(Number(caught?.status) || 400).json({
    error: caught?.message ?? "تعذر تنفيذ توزيع التكلفة",
    ...(caught?.code ? { code: caught.code } : {}),
  });
}

router.get("/projects/:projectId/cost-allocations", async (req, res) => {
  const companyId = await tenant(req, res);
  if (!companyId) return;
  try {
    res.json(await listContractingCostAllocations(companyId, req.params.projectId, req.authUser!));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/projects/:projectId/cost-sources", async (req, res) => {
  const companyId = await tenant(req, res);
  if (!companyId) return;
  try {
    res.json(await listContractingCostSources(
      companyId, req.params.projectId, req.query.sourceType, req.authUser!,
    ));
  } catch (error) {
    sendError(res, error);
  }
});

router.post(
  "/projects/:projectId/cost-allocations",
  requirePermission("contracting", "edit"),
  async (req, res) => {
    const companyId = await tenant(req, res);
    if (!companyId) return;
    try {
      res.status(201).json(await createContractingCostAllocation(
        companyId, req.params.projectId, req.body, req.authUser!,
      ));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  "/cost-allocations/:id/reverse",
  requirePermission("contracting", "edit"),
  async (req, res) => {
    const companyId = await tenant(req, res);
    if (!companyId) return;
    try {
      res.status(201).json(await reverseContractingCostAllocation(
        companyId, req.params.id, req.body?.idempotencyKey, req.authUser!,
      ));
    } catch (error) {
      sendError(res, error);
    }
  },
);

export default router;