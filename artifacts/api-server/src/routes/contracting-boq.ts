import { Router } from "express";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import {
  ensureContractingBoqTables,
  listContractBoqLines,
  createContractBoqLine,
  updateContractBoqLine,
  deleteContractBoqLine,
} from "../lib/contracting-boq-service.js";
import { ensureContractingProjectIntegrity } from "../lib/contracting-integrity.js";

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
    await ensureContractingBoqTables();
    await ensureContractingProjectIntegrity();
    next();
  } catch (caught) {
    next(caught);
  }
});

async function companyId(req: any, res: any): Promise<number | null> {
  const id = await resolveCompanyId(req, undefined);
  if (!id) {
    res.status(400).json({ error: "لا توجد شركة فعالة" });
    return null;
  }
  return id;
}

function fail(res: any, caught: any) {
  const status = Number(caught?.status) || 400;
  res.status(status).json({ error: caught?.message ?? "تعذر تنفيذ العملية" });
}

// Keep the route names short for API clients; the second aliases make the
// intent obvious to integrations that use "contract-boq-lines".
async function getLines(req: any, res: any) {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.json(await listContractBoqLines(cid, Number(req.params.projectId), {
      direction: req.query.direction,
      ownerContractId: req.query.ownerContractId,
      subcontractorContractId: req.query.subcontractorContractId,
    }, req.authUser));
  } catch (caught) {
    fail(res, caught);
  }
}

async function createLine(req: any, res: any) {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.status(201).json(await createContractBoqLine(cid, Number(req.params.projectId), req));
  } catch (caught) {
    fail(res, caught);
  }
}

async function updateLine(req: any, res: any) {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.json(await updateContractBoqLine(cid, Number(req.params.id), req));
  } catch (caught) {
    fail(res, caught);
  }
}

async function deleteLine(req: any, res: any) {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.json(await deleteContractBoqLine(cid, Number(req.params.id), req.authUser));
  } catch (caught) {
    fail(res, caught);
  }
}

router.get("/projects/:projectId/boq-lines", getLines);
router.post("/projects/:projectId/boq-lines", requirePermission("contracting", "edit"), createLine);
router.put("/boq-lines/:id", requirePermission("contracting", "edit"), updateLine);
router.delete("/boq-lines/:id", requirePermission("contracting", "edit"), deleteLine);

router.get("/projects/:projectId/contract-boq-lines", getLines);
router.post("/projects/:projectId/contract-boq-lines", requirePermission("contracting", "edit"), createLine);
router.put("/contract-boq-lines/:id", requirePermission("contracting", "edit"), updateLine);
router.delete("/contract-boq-lines/:id", requirePermission("contracting", "edit"), deleteLine);

export default router;