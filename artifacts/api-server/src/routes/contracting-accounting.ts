import { Router } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  bankAccountsTable,
  cashBoxesTable,
  contractingOwnerContractsTable,
  contractingProjectsTable,
  contractingSubContractsTable,
} from "@workspace/db";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { requirePostRight, requireUnpostRight } from "../lib/postingRights.js";
import { requireContractingCapability } from "../lib/contracting-security.js";
import {
  applyAdvance,
  approveBill,
  assertBranchAccess,
  assertProjectBranchAccess,
  billMutationGuard,
  createSettlement,
  inventoryOptions,
  issueOrReturnMaterial,
  listAccountingAudit,
  listMaterialMovements,
  listSettlements,
  materialLots,
  unapproveBill,
  createPostedCorrection,
  reverseBillSettlement,
} from "../lib/contracting-accounting-service.js";
import { ensureContractingAccountingTables } from "../lib/contracting-accounting-storage.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next): void => {
  if (!req.authUser) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }
  next();
});
router.use(requirePermission("contracting", "view"));
router.use(async (_req, _res, next) => {
  try {
    await ensureContractingAccountingTables();
    next();
  } catch (error) {
    next(error);
  }
});

async function companyId(req: any, res: any): Promise<number | null> {
  const cid = await resolveCompanyId(req, undefined);
  if (!cid) {
    res.status(400).json({ error: "لا توجد شركة فعالة" });
    return null;
  }
  return cid;
}

function userId(req: any): number | null {
  return req.authUser?.id ?? null;
}

function fail(res: any, error: any) {
  const status = Number(error?.status) || 400;
  res.status(status).json({ error: error?.message ?? "تعذر تنفيذ العملية المحاسبية" });
}

router.get("/projects/:projectId/accounting/options", async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    const projectId = Number(req.params.projectId);
    const [project] = await db.select({ branchId: contractingProjectsTable.branchId })
      .from(contractingProjectsTable).where(and(
        eq(contractingProjectsTable.id, projectId),
        eq(contractingProjectsTable.companyId, cid),
      ));
    if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
    assertProjectBranchAccess(req, project.branchId);
    const options = await inventoryOptions(cid, projectId);
    const cashBoxes = await db.select({
      id: cashBoxesTable.id, code: cashBoxesTable.code,
      nameAr: cashBoxesTable.nameAr, branchId: cashBoxesTable.branchId,
    }).from(cashBoxesTable).where(and(
      eq(cashBoxesTable.companyId, cid),
      eq(cashBoxesTable.isActive, true),
    ));
    const banks = await db.select({
      id: bankAccountsTable.id, code: bankAccountsTable.code,
      nameAr: bankAccountsTable.nameAr, branchId: bankAccountsTable.branchId,
    }).from(bankAccountsTable).where(and(
      eq(bankAccountsTable.companyId, cid),
      eq(bankAccountsTable.isActive, true),
    ));
    const [ownerContracts, subcontractorContracts] = await Promise.all([
      db.select({
        id: contractingOwnerContractsTable.id,
        contractNumber: contractingOwnerContractsTable.contractNumber,
        clientName: contractingOwnerContractsTable.clientName,
      }).from(contractingOwnerContractsTable).where(and(
        eq(contractingOwnerContractsTable.companyId, cid),
        eq(contractingOwnerContractsTable.projectId, projectId),
      )),
      db.select({
        id: contractingSubContractsTable.id,
        contractNumber: contractingSubContractsTable.contractNumber,
      }).from(contractingSubContractsTable).where(and(
        eq(contractingSubContractsTable.companyId, cid),
        eq(contractingSubContractsTable.projectId, projectId),
      )),
    ]);
    return res.json({ ...options, cashBoxes, banks, ownerContracts, subcontractorContracts });
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/projects/:projectId/settlements", async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    const projectId = Number(req.params.projectId);
    const [project] = await db.select({ branchId: contractingProjectsTable.branchId })
      .from(contractingProjectsTable).where(and(
        eq(contractingProjectsTable.id, projectId),
        eq(contractingProjectsTable.companyId, cid),
      ));
    if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
     assertProjectBranchAccess(req, project.branchId);
    const [settlements, audit] = await Promise.all([
      listSettlements(cid, projectId),
      listAccountingAudit(cid, projectId),
    ]);
    return res.json({ settlements, audit });
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/projects/:projectId/material-movements", async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    const projectId = Number(req.params.projectId);
    const [project] = await db.select({ branchId: contractingProjectsTable.branchId })
      .from(contractingProjectsTable).where(and(
        eq(contractingProjectsTable.id, projectId),
        eq(contractingProjectsTable.companyId, cid),
      ));
    if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
     assertProjectBranchAccess(req, project.branchId);
    return res.json(await listMaterialMovements(cid, projectId));
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/projects/:projectId/material-lots", async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    const projectId = Number(req.params.projectId);
    const itemId = Number(req.query.itemId);
    const warehouseId = Number(req.query.warehouseId);
    const [project] = await db.select({ branchId: contractingProjectsTable.branchId })
      .from(contractingProjectsTable).where(and(
        eq(contractingProjectsTable.id, projectId),
        eq(contractingProjectsTable.companyId, cid),
      ));
    if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
    assertProjectBranchAccess(req, project.branchId);
    if (!Number.isInteger(itemId) || !Number.isInteger(warehouseId)) {
      return res.status(400).json({ error: "الصنف والمخزن مطلوبان لعرض التشغيلات" });
    }
    return res.json(await materialLots(
      cid,
      projectId,
      itemId,
      warehouseId,
      String(req.query.movementDate ?? new Date().toISOString().slice(0, 10)),
    ));
  } catch (error) {
    return fail(res, error);
  }
});

router.post(
  "/projects/:projectId/settlements",
  requireContractingCapability("pay", "post"),
  requirePostRight("ctgContractingSettlement"),
  async (req, res) => {
    const cid = await companyId(req, res);
    if (!cid) return;
    try {
      const body = req.body ?? {};
      const idempotencyKey = String(body.idempotencyKey ?? "").trim();
      if (!idempotencyKey) return res.status(400).json({ error: "مفتاح العملية مطلوب لمنع الترحيل المكرر" });
      if (idempotencyKey.length > 200) return res.status(400).json({ error: "مفتاح العملية طويل جداً" });
      const projectId = Number(req.params.projectId);
      const [project] = await db.select({ branchId: contractingProjectsTable.branchId })
        .from(contractingProjectsTable).where(and(
          eq(contractingProjectsTable.id, projectId),
          eq(contractingProjectsTable.companyId, cid),
        ));
      if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
      assertProjectBranchAccess(req, project.branchId);
      if (body.paymentType !== "cash" && body.paymentType !== "bank") {
        return res.status(400).json({ error: "نوع السداد يجب أن يكون cash أو bank" });
      }
      const result = await createSettlement({
        companyId: cid,
        projectId,
        billId: body.billId == null || body.billId === "" ? null : Number(body.billId),
        ownerContractId: body.ownerContractId == null || body.ownerContractId === "" ? null : Number(body.ownerContractId),
        subcontractorContractId: body.subcontractorContractId == null || body.subcontractorContractId === "" ? null : Number(body.subcontractorContractId),
        kind: String(body.kind ?? ""),
        amount: Number(body.amount),
        settlementDate: String(body.settlementDate ?? new Date().toISOString().slice(0, 10)),
        paymentType: body.paymentType,
        cashBoxId: body.cashBoxId == null || body.cashBoxId === "" ? null : Number(body.cashBoxId),
        bankAccountId: body.bankAccountId == null || body.bankAccountId === "" ? null : Number(body.bankAccountId),
        idempotencyKey,
        notes: body.notes == null ? null : String(body.notes),
        userId: userId(req),
        req,
      });
      return res.status(201).json(result);
    } catch (error) {
      return fail(res, error);
    }
  },
);

router.post(
  "/settlements/:id/apply",
  requireContractingCapability("pay", "post"),
  requirePostRight("ctgContractingSettlement"),
  async (req, res) => {
    const cid = await companyId(req, res);
    if (!cid) return;
    try {
      const body = req.body ?? {};
      const idempotencyKey = String(body.idempotencyKey ?? "").trim();
      if (!idempotencyKey) return res.status(400).json({ error: "مفتاح العملية مطلوب لمنع الترحيل المكرر" });
      if (idempotencyKey.length > 200) return res.status(400).json({ error: "مفتاح العملية طويل جداً" });
      const result = await applyAdvance({
        companyId: cid,
        settlementId: Number(req.params.id),
        billId: Number(body.billId),
        amount: Number(body.amount),
        idempotencyKey,
        userId: userId(req),
        req,
      });
      return res.status(201).json(result);
    } catch (error) {
      return fail(res, error);
    }
  },
);

router.post(
  "/settlements/:id/reverse",
  requireContractingCapability("cancel", "unpost"),
  requireUnpostRight("ctgContractingSettlement"),
  async (req, res) => {
    const cid = await companyId(req, res);
    if (!cid) return;
    try {
      const result = await reverseBillSettlement({
        companyId: cid,
        settlementId: Number(req.params.id),
        userId: userId(req),
        req,
      });
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (error) {
      return fail(res, error);
    }
  },
);

router.get("/projects/:projectId/accounting/inventory-options", async (req, res) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    const projectId = Number(req.params.projectId);
    const [project] = await db.select({ branchId: contractingProjectsTable.branchId })
      .from(contractingProjectsTable).where(and(
        eq(contractingProjectsTable.id, projectId),
        eq(contractingProjectsTable.companyId, cid),
      ));
    if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
    assertProjectBranchAccess(req, project.branchId);
    const result = await inventoryOptions(cid, projectId);
    return res.json(result);
  } catch (error) {
    return fail(res, error);
  }
});

router.post(
  "/projects/:projectId/material-movements",
  requireContractingCapability("post", "post"),
  requirePostRight("stockMovement"),
  async (req, res) => {
    const cid = await companyId(req, res);
    if (!cid) return;
    try {
      const body = req.body ?? {};
      if (body.direction !== "issue" && body.direction !== "return") {
        return res.status(400).json({ error: "اتجاه الحركة يجب أن يكون issue أو return" });
      }
      const projectId = Number(req.params.projectId);
      const [project] = await db.select({ branchId: contractingProjectsTable.branchId })
        .from(contractingProjectsTable).where(and(
          eq(contractingProjectsTable.id, projectId),
          eq(contractingProjectsTable.companyId, cid),
        ));
      if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
      assertProjectBranchAccess(req, project.branchId);
      const direction = body.direction;
      const idempotencyKey = String(body.idempotencyKey ?? "").trim();
      if (!idempotencyKey) return res.status(400).json({ error: "مفتاح العملية مطلوب لمنع الترحيل المكرر" });
      if (idempotencyKey.length > 200) return res.status(400).json({ error: "مفتاح العملية طويل جداً" });
      const result = await issueOrReturnMaterial({
        companyId: cid,
        projectId,
        resourceId: body.resourceId == null || body.resourceId === "" ? null : Number(body.resourceId),
        itemId: Number(body.itemId),
        unitId: Number(body.unitId),
        warehouseId: Number(body.warehouseId),
         qty: String(body.qty ?? ""),
        direction,
        movementDate: String(body.movementDate ?? new Date().toISOString().slice(0, 10)),
        sourceMovementId: body.sourceMovementId == null || body.sourceMovementId === "" ? null : Number(body.sourceMovementId),
         batchNumber: body.batchNumber === "__unbatched__"
           ? null
           : body.batchNumber == null || body.batchNumber === ""
             ? undefined
             : String(body.batchNumber),
         expiryDate: body.expiryDate === null
           ? null
           : body.expiryDate === undefined || body.expiryDate === ""
             ? undefined
             : String(body.expiryDate),
        idempotencyKey,
        notes: body.notes == null ? null : String(body.notes),
        userId: userId(req),
        req,
      });
       return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (error) {
      return fail(res, error);
    }
  },
);

router.post(
  "/bills/:id/approve",
  requireContractingCapability("approve", "post"),
  async (req, res) => {
    const cid = await companyId(req, res);
    if (!cid) return;
    try {
      const result = await approveBill({
        companyId: cid,
        billId: Number(req.params.id),
        userId: userId(req),
        req,
      });
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (error) {
      return fail(res, error);
    }
  },
);

router.post(
  "/bills/:id/unapprove",
  requireContractingCapability("cancel", "unpost"),
  async (req, res) => {
    const cid = await companyId(req, res);
    if (!cid) return;
    try {
      const result = await unapproveBill({
        companyId: cid,
        billId: Number(req.params.id),
        userId: userId(req),
        req,
      });
      return res.status(200).json(result);
    } catch (error) {
      return fail(res, error);
    }
  },
);

router.post(
  "/bills/:id/correction",
  requireContractingCapability("correct", "unpost"),
  async (req, res) => {
    const cid = await companyId(req, res);
    if (!cid) return;
    try {
      const result = await createPostedCorrection({
        companyId: cid,
        billId: Number(req.params.id),
        userId: userId(req),
        req,
      });
      return res.status(201).json(result);
    } catch (error) {
      return fail(res, error);
    }
  },
);

// These guards are intentionally mounted before the legacy CRUD router.  A
// legacy client can still edit draft/submitted bills, while an approved bill
// can only be changed through the atomic approve/unapprove workflow above.
router.put("/bills/:id", async (req, res, next) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  try {
    const requestedStatus = String(req.body?.status ?? "").toLowerCase();
    if (requestedStatus === "approved") {
      requireContractingCapability("approve", "post")(req, res, () => {
        (async () => {
          try {
            const result = await approveBill({
              companyId: cid,
              billId: Number(req.params.id),
              userId: userId(req),
              req,
            });
            res.status(result.idempotentReplay ? 200 : 201).json(result);
          } catch (error) {
            fail(res, error);
          }
        })();
      });
      return;
    }
    requirePermission("contracting", "edit")(req, res, async () => {
      try {
        await billMutationGuard(cid, Number(req.params.id), "edit");
        next();
      } catch (error) {
        fail(res, error);
      }
    });
  } catch (error) {
    fail(res, error);
  }
});

router.delete("/bills/:id", async (req, res, next) => {
  const cid = await companyId(req, res);
  if (!cid) return;
  requirePermission("contracting", "delete")(req, res, async () => {
    try {
      await billMutationGuard(cid, Number(req.params.id), "delete");
      next();
    } catch (error) {
      fail(res, error);
    }
  });
});

// A new bill must be created as draft/submitted, then approved through the
// atomic posting route. This stops the old CRUD endpoint from creating a
// status=approved row without a journal entry.
router.post("/projects/:projectId/bills", async (req, res, next): Promise<void> => {
  if (String(req.body?.status ?? "").toLowerCase() === "approved") {
    res.status(400).json({ error: "أنشئ المستخلص كمسودة ثم استخدم اعتماد المستخلص للترحيل الذري" });
    return;
  }
  requirePermission("contracting", "create")(req, res, () => next());
});

export default router;