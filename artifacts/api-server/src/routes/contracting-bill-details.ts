import { Router, raw } from "express";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import {
  ensureContractingBillDetailsTables,
  listBillDetails,
  createBillLine,
  updateBillLine,
  deleteBillLine,
  createBillDeduction,
  updateBillDeduction,
  deleteBillDeduction,
  createBillPenalty,
  updateBillPenalty,
  deleteBillPenalty,
  createBillAttachment,
  requestBillAttachmentUpload,
  writeBillAttachmentDirect,
  downloadBillAttachment,
  deleteBillAttachment,
  transitionBillWorkflow,
  contractingBillsReport,
} from "../lib/contracting-bill-details-service.js";

const router = Router();
router.use((req, _res, next) => {
  const token = typeof req.query.token === "string" ? req.query.token : null;
  if (token && !req.headers.authorization) req.headers.authorization = `Bearer ${token}`;
  next();
});
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
    await ensureContractingBillDetailsTables();
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

/**
 * Older tenants only have the platform's create/edit/post actions. New detail
 * permissions can be granted as contracting.review/approve/pay/cancel (the
 * permission map is intentionally extensible). When a capability is absent,
 * retain compatibility with the existing fallback action; an explicit false
 * still denies the request.
 */
function requireBillCapability(capability: string, fallback: "create" | "edit" | "post" | "delete" = "edit") {
  return (req: any, res: any, next: any) => {
    if (req.authUser?.role === "admin" || req.authUser?.role === "superadmin") {
      next();
      return;
    }
    const permissions = req.authUser?.permissions?.contracting;
    if (permissions && permissions[capability] === false) {
      res.status(403).json({ error: "لا تملك صلاحية تنفيذ هذا الإجراء" });
      return;
    }
    if (permissions && permissions[capability] === true) {
      next();
      return;
    }
    requirePermission("contracting", fallback)(req, res, next);
  };
}

// Detail reads are intentionally separate from the legacy bill response so
// old clients keep receiving the exact existing automatic fields.
router.get("/bills/:id/details", async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.json(await listBillDetails(cid, Number(req.params.id), req.authUser));
  } catch (caught) {
    fail(res, caught);
  }
});

router.get("/reports/bills", async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    const rawProjectId = req.query.projectId;
    const projectId = rawProjectId == null || rawProjectId === "" ? undefined : Number(rawProjectId);
    res.json(await contractingBillsReport(cid, {
      projectId: projectId && Number.isInteger(projectId) ? projectId : undefined,
      direction: typeof req.query.direction === "string" ? req.query.direction : undefined,
    }, req.authUser));
  } catch (caught) {
    fail(res, caught);
  }
});

router.post("/bills/:id/attachments/upload-url", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.status(201).json(await requestBillAttachmentUpload(cid, Number(req.params.id), req));
  } catch (caught) {
    fail(res, caught);
  }
});

// External agents do not have the Replit signing sidecar. The target remains
// server-generated and bill/uploader-bound even for this local-only path.
router.put(
  "/bills/:id/attachments/upload-direct/:token",
  requireBillCapability("edit"),
  raw({ type: () => true, limit: "50mb" }),
  async (req, res) => {
    const cid = await companyId(req, res);
    if (!cid) return;
    try {
      res.status(201).json(await writeBillAttachmentDirect(
        cid, Number(req.params.id), String(req.params.token), req,
      ));
    } catch (caught) {
      fail(res, caught);
    }
  },
);

router.get("/bills/:id/attachments/:attachmentId/download", async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    const response = await downloadBillAttachment(
      cid,
      Number(req.params.id),
      Number(req.params.attachmentId),
      req.authUser,
    );
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      Readable.fromWeb(response.body as unknown as NodeReadableStream).pipe(res);
    } else {
      res.end();
    }
  } catch (caught) {
    fail(res, caught);
  }
});

router.post("/bills/:id/lines", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.status(201).json(await createBillLine(cid, Number(req.params.id), req));
  } catch (caught) {
    fail(res, caught);
  }
});

router.put("/bill-lines/:id", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.json(await updateBillLine(cid, Number(req.params.id), req));
  } catch (caught) {
    fail(res, caught);
  }
});

router.delete("/bill-lines/:id", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.json(await deleteBillLine(cid, Number(req.params.id), req.authUser));
  } catch (caught) {
    fail(res, caught);
  }
});

router.post("/bills/:id/deductions", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.status(201).json(await createBillDeduction(cid, Number(req.params.id), req));
  } catch (caught) {
    fail(res, caught);
  }
});

router.put("/bill-deductions/:id", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.json(await updateBillDeduction(cid, Number(req.params.id), req));
  } catch (caught) {
    fail(res, caught);
  }
});

router.delete("/bill-deductions/:id", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.json(await deleteBillDeduction(cid, Number(req.params.id), req.authUser));
  } catch (caught) {
    fail(res, caught);
  }
});

router.post("/bills/:id/penalties", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.status(201).json(await createBillPenalty(cid, Number(req.params.id), req));
  } catch (caught) {
    fail(res, caught);
  }
});

router.put("/bill-penalties/:id", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.json(await updateBillPenalty(cid, Number(req.params.id), req));
  } catch (caught) {
    fail(res, caught);
  }
});

router.delete("/bill-penalties/:id", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.json(await deleteBillPenalty(cid, Number(req.params.id), req.authUser));
  } catch (caught) {
    fail(res, caught);
  }
});

router.post("/bills/:id/attachments", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.status(201).json(await createBillAttachment(cid, Number(req.params.id), req));
  } catch (caught) {
    fail(res, caught);
  }
});

router.delete("/bill-attachments/:id", requireBillCapability("edit"), async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.json(await deleteBillAttachment(cid, Number(req.params.id), req.authUser));
  } catch (caught) {
    fail(res, caught);
  }
});

router.post("/bills/:id/workflow", (req, res, next) => {
  const action = String(req.body?.state ?? "");
  const capability = action === "under_review" ? "review"
    : action === "approved" ? "approve"
      : action === "partially_paid" || action === "paid" ? "pay"
        : action === "rejected" ? "cancel"
          : action === "draft" || action === "submitted" ? "edit" : "post";
  requireBillCapability(capability, capability === "edit" ? "edit" : "post")(req, res, next);
}, async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    res.status(201).json(await transitionBillWorkflow(cid, Number(req.params.id), req));
  } catch (caught) {
    fail(res, caught);
  }
});

export default router;