import { Router } from "express";
import { db, documentExpensesTable } from "@workspace/db";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { expenseDocuments, expenseDocument, expenseOptions, expenseSnapshot, readExpenseRows, validateExpenseRows } from "../lib/documentExpenses.js";
const router = Router();
router.use(extractAuth);
router.use("/:documentType/:documentId", (req, res, next) => {
  const config = expenseDocuments[String(req.params.documentType)];
  if (!config) { res.status(400).json({ error: "نوع المستند غير صالح" }); return; }
  return requirePermission(config.module, req.method === "GET" ? "view" : "edit")(req, res, next);
});
router.get("/:documentType/:documentId", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const type = String(req.params.documentType), id = Number(req.params.documentId);
    const doc = await expenseDocument(db, req, cid, type, id);
    res.json(await expenseSnapshot(db, cid, type, doc));
  } catch (e: any) { res.status(e.status ?? 400).json({ error: e.message }); }
});
router.put("/:documentType/:documentId", async (req, res) => {
  try {
    const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const type = String(req.params.documentType), id = Number(req.params.documentId);
    const result = await db.transaction(async tx => {
      const doc = await expenseDocument(tx, req, cid, type, id, true);
      if (doc.status !== "draft") throw Object.assign(new Error("المصاريف قابلة للتعديل في المسودة فقط"), { status: 409 });
      const state = await readExpenseRows(tx, cid, type, id);
      if (!Number.isSafeInteger(req.body.version) || req.body.version !== state.version)
        throw Object.assign(new Error("تم تعديل المصاريف؛ أعد تحميل المستند"), { status: 409 });
      const rows = validateExpenseRows(req.body.rows, await expenseOptions(tx, cid, type, doc));
      await tx.insert(documentExpensesTable).values({ companyId: cid, documentType: type, documentId: id, version: state.version + 1, rows })
        .onConflictDoUpdate({ target: [documentExpensesTable.companyId, documentExpensesTable.documentType, documentExpensesTable.documentId], set: { version: state.version + 1, rows } });
      return expenseSnapshot(tx, cid, type, doc);
    });
    res.json(result);
  } catch (e: any) { res.status(e.status ?? 400).json({ error: e.message }); }
});
export default router;