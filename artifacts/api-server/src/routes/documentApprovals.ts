import { Router } from "express";
import {
  db, approvalLogTable, systemSettingsTable, usersTable,
  salesInvoicesTable, salesQuotationsTable, salesOrdersTable,
  salesReturnsTable,
  purchaseInvoicesTable, purchaseOrdersTable,
  purchaseReturnsTable,
  goodsDeliveriesTable, goodsReceiptsTable,
} from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { branchScopeSpread, extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

export const APPROVAL_TYPES = [
  "sales_quotation", "sales_order", "goods_delivery", "sales_invoice",
  "sales_return", "purchase_order", "goods_receipt", "purchase_invoice", "purchase_return",
] as const;
export type ApprovalDocumentType = typeof APPROVAL_TYPES[number];
export const DRAFT_SAVE_TYPES = ["sales_invoice", "sales_return", "purchase_invoice", "purchase_return"] as const;
export type DraftSaveDocumentType = typeof DRAFT_SAVE_TYPES[number];

export function sanitizeDraftSaveDocumentTypes(value: unknown): DraftSaveDocumentType[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is DraftSaveDocumentType =>
    typeof item === "string" && (DRAFT_SAVE_TYPES as readonly string[]).includes(item),
  ))];
}

export async function enforceDraftSaveMode(req: any, res: any, cid: number, type: DraftSaveDocumentType): Promise<boolean> {
  const userId = Number(req.authUser?.id);
  if (!Number.isInteger(userId) || userId <= 0) return true;
  const [user] = await db.select({
    canApprove: usersTable.canApprove,
    permissions: usersTable.permissions,
  }).from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.companyId, cid))).limit(1);
  const permissions = (user?.permissions ?? {}) as Record<string, any>;
  const draftTypes = sanitizeDraftSaveDocumentTypes(permissions.__draftSaveDocumentTypes);
  const approvalTypes = permissions.__approvalDocumentTypes;
  const canApproveType = !!user?.canApprove && Array.isArray(approvalTypes) && approvalTypes.includes(type);
  const draftOnly = draftTypes.includes(type) && !canApproveType;
  if (req.body?.saveAsDraft === true && !draftTypes.includes(type)) {
    res.status(403).json({ error: "لا تملك صلاحية حفظ هذا النوع كمسودة", code: "DRAFT_SAVE_NOT_ENABLED" });
    return false;
  }
  if (draftOnly && req.body?.saveAsDraft !== true) {
    res.status(403).json({ error: "هذا المستخدم مخول بحفظ المسودات فقط لهذا النوع من المستندات", code: "DRAFT_ONLY_USER" });
    return false;
  }
  return true;
}

const DRAFT_PREFIX: Record<DraftSaveDocumentType, string> = {
  sales_invoice: "D-SI-",
  sales_return: "D-SR-",
  purchase_invoice: "D-PI-",
  purchase_return: "D-PR-",
};

export async function nextDraftDocumentNumber(
  cid: number,
  type: DraftSaveDocumentType,
  executor: any = db,
): Promise<string> {
  const key = `draft_document_sequence:${cid}:${type}`;
  const [row] = await executor.insert(systemSettingsTable).values({
    key, value: "1", updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: systemSettingsTable.key,
    set: {
      value: sql`CASE WHEN ${systemSettingsTable.value} ~ '^[0-9]+$' THEN (${systemSettingsTable.value}::bigint + 1)::text ELSE '1' END`,
      updatedAt: new Date(),
    },
  }).returning({ value: systemSettingsTable.value });
  const number = Number(row?.value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("تعذر إنشاء رقم المسودة");
  return `${DRAFT_PREFIX[type]}${String(number).padStart(5, "0")}`;
}

const documentTables: Record<ApprovalDocumentType, any> = {
  sales_quotation: salesQuotationsTable,
  sales_order: salesOrdersTable,
  goods_delivery: goodsDeliveriesTable,
  sales_invoice: salesInvoicesTable,
  sales_return: salesReturnsTable,
  purchase_order: purchaseOrdersTable,
  goods_receipt: goodsReceiptsTable,
  purchase_invoice: purchaseInvoicesTable,
  purchase_return: purchaseReturnsTable,
};

const settingsKey = (companyId: number) => `document_approval_stages:${companyId}`;
const isApprovalType = (v: string): v is ApprovalDocumentType =>
  (APPROVAL_TYPES as readonly string[]).includes(v);

function companyId(req: any, res: any): number | null {
  if (!req.authUser) {
    res.status(401).json({ error: "يجب تسجيل الدخول" });
    return null;
  }
  const queryCompanyId = Number(req.query?.companyId);
  const candidate = Number.isInteger(queryCompanyId) && queryCompanyId > 0
    ? queryCompanyId
    : req.authUser?.companyId;
  const id = resolveCompanyId(req, candidate);
  if (!id) res.status(400).json({ error: "الشركة غير محددة" });
  return id ?? null;
}

async function getStageSettings(cid: number): Promise<Record<ApprovalDocumentType, number>> {
  const [row] = await db.select().from(systemSettingsTable)
    .where(eq(systemSettingsTable.key, settingsKey(cid))).limit(1);
  let parsed: Record<string, unknown> = {};
  try { parsed = row ? JSON.parse(row.value) : {}; } catch { parsed = {}; }
  return Object.fromEntries(APPROVAL_TYPES.map((type) => {
    const value = Number(parsed[type]);
    return [type, Number.isInteger(value) && value >= 1 && value <= 9 ? value : 0];
  })) as Record<ApprovalDocumentType, number>;
}

export function approvalGate(
  type: ApprovalDocumentType,
  shouldGate: (req: any) => boolean = () => true,
) {
  return async (req: any, res: any, next: any) => {
    if (!shouldGate(req)) return next();
    const cid = resolveCompanyId(req, req.authUser?.companyId);
    const id = Number(req.params.id);
    if (!cid || !Number.isInteger(id) || id <= 0) return next();
    if ((DRAFT_SAVE_TYPES as readonly string[]).includes(type)) {
      const [user] = await db.select({ canApprove: usersTable.canApprove, permissions: usersTable.permissions })
        .from(usersTable).where(and(eq(usersTable.id, Number(req.authUser?.id)), eq(usersTable.companyId, cid))).limit(1);
      const permissions = (user?.permissions ?? {}) as Record<string, any>;
      const draftTypes = sanitizeDraftSaveDocumentTypes(permissions.__draftSaveDocumentTypes);
      const approvalTypes = permissions.__approvalDocumentTypes;
      const canApproveType = !!user?.canApprove && Array.isArray(approvalTypes) && approvalTypes.includes(type);
      if (draftTypes.includes(type as DraftSaveDocumentType) && !canApproveType) {
        return res.status(403).json({ error: "هذا المستخدم مخول بحفظ المسودات فقط لهذا النوع من المستندات", code: "DRAFT_ONLY_USER" });
      }
    }
    const table = documentTables[type];
    const [document] = await db.select({ id: table.id }).from(table).where(and(
      eq(table.id, id),
      eq(table.companyId, cid),
      ...branchScopeSpread(req, table.branchId, undefined),
    )).limit(1);
    if (!document) return next();
    const required = (await getStageSettings(cid))[type];
    if (required === 0) return next();
    const approvals = await db.select({ id: approvalLogTable.id, toStatus: approvalLogTable.toStatus }).from(approvalLogTable)
      .where(and(
        eq(approvalLogTable.companyId, cid),
        eq(approvalLogTable.documentType, type),
        eq(approvalLogTable.documentId, id),
        eq(approvalLogTable.action, "approve"),
      )).orderBy(asc(approvalLogTable.id));
    if (approvals.at(-1)?.toStatus === "approved" && approvals.length >= required) return next();
    return res.status(409).json({
      error: "لا يمكن تنفيذ العملية قبل اكتمال مراحل التأكيد",
      code: "DOCUMENT_APPROVAL_REQUIRED",
      requiredStages: required,
      completedStages: approvals.length,
    });
  };
}

router.get("/settings", async (req, res) => {
  const cid = companyId(req, res); if (!cid) return;
  res.json({ stages: await getStageSettings(cid) });
});

router.put("/settings", async (req: any, res) => {
  const cid = companyId(req, res); if (!cid) return;
  if (!["admin", "superadmin"].includes(req.authUser?.role)) {
    res.status(403).json({ error: "صلاحية مدير الشركة مطلوبة" }); return;
  }
  const input = req.body?.stages;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    res.status(400).json({ error: "إعداد المراحل غير صالح" }); return;
  }
  const stages = Object.fromEntries(APPROVAL_TYPES.map(type => {
    const n = Number(input[type] ?? 0);
    return [type, Number.isInteger(n) && n >= 0 && n <= 9 ? n : NaN];
  }));
  if (Object.values(stages).some(Number.isNaN)) {
    res.status(400).json({ error: "عدد المراحل يجب أن يكون بين صفر وتسعة" }); return;
  }
  await db.insert(systemSettingsTable).values({
    key: settingsKey(cid), value: JSON.stringify(stages), updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: systemSettingsTable.key,
    set: { value: JSON.stringify(stages), updatedAt: new Date() },
  });
  res.json({ stages });
});

async function documentAndApprovals(req: any, cid: number, type: ApprovalDocumentType, id: number) {
  const table = documentTables[type];
  const [document] = await db.select().from(table)
    .where(and(eq(table.id, id), eq(table.companyId, cid), ...branchScopeSpread(req, table.branchId, undefined))).limit(1);
  if (!document) return null;
  const approvals = await db.select().from(approvalLogTable).where(and(
    eq(approvalLogTable.companyId, cid),
    eq(approvalLogTable.documentType, type),
    eq(approvalLogTable.documentId, id),
    eq(approvalLogTable.action, "approve"),
  )).orderBy(asc(approvalLogTable.level), asc(approvalLogTable.id));
  return { document, approvals };
}

router.get("/:type/:id", async (req, res) => {
  const cid = companyId(req, res); if (!cid) return;
  if (!isApprovalType(req.params.type)) { res.status(400).json({ error: "نوع مستند غير صالح" }); return; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرف المستند غير صالح" }); return; }
  const type = req.params.type as ApprovalDocumentType;
  const result = await documentAndApprovals(req, cid, type, id);
  if (!result) { res.status(404).json({ error: "المستند غير موجود" }); return; }
  const required = (await getStageSettings(cid))[type];
  const latestStatus = result.approvals.at(-1)?.toStatus;
  const pendingNextLevel = Number(latestStatus?.match(/^pending_l(\d+)$/)?.[1] ?? 0);
  const effectiveStages = Math.max(required, pendingNextLevel);
  const complete = required === 0 || (latestStatus === "approved" && result.approvals.length >= required);
  const [currentUser] = await db.select({
    canApprove: usersTable.canApprove,
    permissions: usersTable.permissions,
  }).from(usersTable).where(and(
    eq(usersTable.id, Number(req.authUser?.id)),
    eq(usersTable.companyId, cid),
  )).limit(1);
  const userTypes = (currentUser?.permissions as any)?.__approvalDocumentTypes;
  const canApprove = !!currentUser?.canApprove && Array.isArray(userTypes) && userTypes.includes(type);
  const eligible = ["draft", "sent"].includes(String(result.document.status));
  res.json({ requiredStages: effectiveStages, approvals: result.approvals, complete, canApprove, eligible });
});

router.post("/:type/:id/approve", async (req: any, res) => {
  const cid = companyId(req, res); if (!cid) return;
  if (!isApprovalType(req.params.type)) { res.status(400).json({ error: "نوع مستند غير صالح" }); return; }
  const type = req.params.type as ApprovalDocumentType;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرف المستند غير صالح" }); return; }
  const required = (await getStageSettings(cid))[type];
  if (required === 0) { res.status(409).json({ error: "التأكيد غير مفعّل لهذا النوع من المستندات" }); return; }
  const [user] = await db.select().from(usersTable).where(and(
    eq(usersTable.id, req.authUser?.id), eq(usersTable.companyId, cid),
  )).limit(1);
  const grantedTypes = (user?.permissions as any)?.__approvalDocumentTypes;
  if (!user?.canApprove || !Array.isArray(grantedTypes) || !grantedTypes.includes(type)) {
    res.status(403).json({ error: "لا تملك صلاحية تأكيد هذا النوع من المستندات" }); return;
  }
  const outcome = await db.transaction(async (tx) => {
    const table = documentTables[type];
    const [document] = await tx.select().from(table)
      .where(and(eq(table.id, id), eq(table.companyId, cid), ...branchScopeSpread(req, table.branchId, undefined))).for("update");
    if (!document) return { error: "المستند غير موجود", status: 404 as const };
    if (!["draft", "sent"].includes(String(document.status))) {
      return { error: "لا يمكن تأكيد مستند خرج من حالة المسودة", status: 409 as const };
    }
    const approvals = await tx.select().from(approvalLogTable).where(and(
      eq(approvalLogTable.companyId, cid),
      eq(approvalLogTable.documentType, type),
      eq(approvalLogTable.documentId, id),
      eq(approvalLogTable.action, "approve"),
    )).orderBy(asc(approvalLogTable.level), asc(approvalLogTable.id));
    if (approvals.at(-1)?.toStatus === "approved" && approvals.length >= required) {
      return { error: "اكتملت مراحل التأكيد بالفعل", status: 409 as const };
    }
    const level = approvals.length + 1;
    if (Number(user.approvalLevel) < level) {
      return { error: "مستوى التأكيد غير كافٍ لهذه المرحلة", status: 403 as const };
    }
    if (approvals.some(a => a.userId === user.id)) {
      return { error: "يجب أن ينفذ كل مرحلة مستخدم مختلف", status: 409 as const };
    }
    const amount = Number(document.totalAmount ?? 0);
    const cap = Number(user.maxApprovalAmount ?? 0);
    if (cap > 0 && amount > cap) {
      return { error: "قيمة المستند تتجاوز حد صلاحية التأكيد", status: 403 as const };
    }
    const complete = level >= required && !user.requireSecondApproval;
    await tx.insert(approvalLogTable).values({
      companyId: cid, documentType: type, documentId: id,
      userId: user.id, action: "approve", level, amount: amount.toFixed(2),
      fromStatus: level === 1 ? "pending" : `pending_l${level}`,
      toStatus: complete ? "approved" : `pending_l${level + 1}`,
      comment: typeof req.body?.comment === "string" ? req.body.comment.slice(0, 1000) : null,
    });
    return { approved: true, level, complete };
  });
  if ("error" in outcome) { res.status(outcome.status ?? 500).json({ error: outcome.error }); return; }
  res.json(outcome);
});

export default router;
