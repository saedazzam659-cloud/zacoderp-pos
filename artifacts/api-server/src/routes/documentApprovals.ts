import { Router } from "express";
import {
  db, approvalLogTable, systemSettingsTable, usersTable,
  salesInvoicesTable, salesQuotationsTable, salesOrdersTable,
  purchaseInvoicesTable, purchaseOrdersTable,
  goodsDeliveriesTable, goodsReceiptsTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

export const APPROVAL_TYPES = [
  "sales_quotation", "sales_order", "goods_delivery", "sales_invoice",
  "purchase_order", "goods_receipt", "purchase_invoice",
] as const;
export type ApprovalDocumentType = typeof APPROVAL_TYPES[number];

const documentTables: Record<ApprovalDocumentType, any> = {
  sales_quotation: salesQuotationsTable,
  sales_order: salesOrdersTable,
  goods_delivery: goodsDeliveriesTable,
  sales_invoice: salesInvoicesTable,
  purchase_order: purchaseOrdersTable,
  goods_receipt: goodsReceiptsTable,
  purchase_invoice: purchaseInvoicesTable,
};

const settingsKey = (companyId: number) => `document_approval_stages:${companyId}`;
const isApprovalType = (v: string): v is ApprovalDocumentType =>
  (APPROVAL_TYPES as readonly string[]).includes(v);

function companyId(req: any, res: any): number | null {
  const id = resolveCompanyId(req, req.authUser?.companyId);
  if (!id) res.status(400).json({ error: "الشركة غير محددة" });
  return id;
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

async function documentAndApprovals(cid: number, type: ApprovalDocumentType, id: number) {
  const table = documentTables[type];
  const [document] = await db.select().from(table)
    .where(and(eq(table.id, id), eq(table.companyId, cid))).limit(1);
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
  const result = await documentAndApprovals(cid, req.params.type, id);
  if (!result) { res.status(404).json({ error: "المستند غير موجود" }); return; }
  const required = (await getStageSettings(cid))[req.params.type];
  res.json({ requiredStages: required, approvals: result.approvals, complete: result.approvals.length >= required });
});

router.post("/:type/:id/approve", async (req: any, res) => {
  const cid = companyId(req, res); if (!cid) return;
  if (!isApprovalType(req.params.type)) { res.status(400).json({ error: "نوع مستند غير صالح" }); return; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "معرف المستند غير صالح" }); return; }
  const required = (await getStageSettings(cid))[req.params.type];
  if (required === 0) { res.status(409).json({ error: "التأكيد غير مفعّل لهذا النوع من المستندات" }); return; }
  const [user] = await db.select().from(usersTable).where(and(
    eq(usersTable.id, req.authUser?.id), eq(usersTable.companyId, cid),
  )).limit(1);
  const grantedTypes = (user?.permissions as any)?.__approvalDocumentTypes;
  if (!user?.canApprove || !Array.isArray(grantedTypes) || !grantedTypes.includes(req.params.type)) {
    res.status(403).json({ error: "لا تملك صلاحية تأكيد هذا النوع من المستندات" }); return;
  }
  const result = await documentAndApprovals(cid, req.params.type, id);
  if (!result) { res.status(404).json({ error: "المستند غير موجود" }); return; }
  if (result.approvals.length >= required) { res.status(409).json({ error: "اكتملت مراحل التأكيد بالفعل" }); return; }
  if (Number(user.approvalLevel) < result.approvals.length + 1) {
    res.status(403).json({ error: "مستوى التأكيد غير كافٍ لهذه المرحلة" }); return;
  }
  const amount = Number(result.document.totalAmount ?? 0);
  const cap = Number(user.maxApprovalAmount ?? 0);
  if (cap > 0 && amount > cap) { res.status(403).json({ error: "قيمة المستند تتجاوز حد صلاحية التأكيد" }); return; }
  if (user.requireSecondApproval && result.approvals.some(a => a.userId === user.id)) {
    res.status(409).json({ error: "يلزم مستخدم آخر لإكمال مرحلة التأكيد التالية" }); return;
  }
  const level = result.approvals.length + 1;
  await db.insert(approvalLogTable).values({
    companyId: cid, documentType: req.params.type, documentId: id,
    userId: user.id, action: "approve", level, amount: amount.toFixed(2),
    fromStatus: level === 1 ? "pending" : `pending_l${level}`,
    toStatus: level === required ? "approved" : `pending_l${level + 1}`,
    comment: typeof req.body?.comment === "string" ? req.body.comment.slice(0, 1000) : null,
  });
  res.json({ approved: true, level, complete: level >= required });
});

export default router;
