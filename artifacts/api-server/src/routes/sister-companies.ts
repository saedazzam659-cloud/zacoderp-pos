// Sister Companies routes
// ────────────────────────
// All endpoints for the "Sister Companies" module (موديل الشركات الشقيقة).
// Affiliates under the same legal owner/VAT/CR — stock moves between them
// are NOT ZATCA invoices. Module is locked by default; the route mount in
// `routes/index.ts` is wrapped in `requireModulePermission("sister_companies")`
// so disabled tenants cannot reach any of these endpoints (UI hidden + API
// 403). See `replit.md` → "Sister Companies" for the JE pattern.

import { Router } from "express";
import { db } from "@workspace/db";
import {
  sisterCompaniesTable, sisterTransfersTable, sisterTransferItemsTable,
  sisterReturnsTable, sisterReturnItemsTable, sisterSettlementsTable,
  stockBalanceTable, stockLedgerTable,
  journalEntriesTable, journalEntryLinesTable,
  cashBoxesTable, bankAccountsTable,
  warehousesTable, accountsTable,
} from "@workspace/db";
import { eq, and, desc, sql, inArray, gte, lte, lt } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requireModulePermission, moduleAudit } from "../middleware/permissions.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import { resolvePostingStatus } from "../lib/postingStatus.js";

const router = Router();
router.use(extractAuth);
// Single permission key gates the entire surface (CRUD + transfers +
// returns + settlements + statement). Locked by default per
// menuPermissionCatalog; SuperAdmin enables per tenant.
router.use(requireModulePermission("sister_companies"));
router.use(moduleAudit("sister_companies"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// ───────── Local stock helpers (mirror of inventory.ts) ─────────
// Inlined to avoid coupling sister-companies routes to inventory.ts module
// internals; identical semantics (weighted avg on in-flow, avg unchanged
// on out-flow).
async function getBalance(cid: number, itemId: number, warehouseId: number): Promise<number> {
  const [bal] = await db.select().from(stockBalanceTable)
    .where(and(eq(stockBalanceTable.companyId, cid), eq(stockBalanceTable.itemId, itemId), eq(stockBalanceTable.warehouseId, warehouseId)));
  return Number(bal?.qty ?? 0);
}
async function upsertBalance(cid: number, itemId: number, warehouseId: number, deltaQty: number, costPrice: number) {
  const [existing] = await db.select().from(stockBalanceTable)
    .where(and(eq(stockBalanceTable.companyId, cid), eq(stockBalanceTable.itemId, itemId), eq(stockBalanceTable.warehouseId, warehouseId)));
  if (!existing) {
    await db.insert(stockBalanceTable).values({ companyId: cid, itemId, warehouseId, qty: String(deltaQty), avgCost: String(costPrice) });
  } else {
    const oldQty  = Number(existing.qty);
    const oldCost = Number(existing.avgCost);
    let newQty: number, newAvg: number;
    if (deltaQty > 0) {
      newQty = oldQty + deltaQty;
      newAvg = newQty === 0 ? costPrice : (oldQty * oldCost + deltaQty * costPrice) / newQty;
    } else {
      newQty = oldQty + deltaQty;
      newAvg = oldCost;
    }
    await db.update(stockBalanceTable).set({ qty: String(newQty), avgCost: String(newAvg), updatedAt: new Date() }).where(eq(stockBalanceTable.id, existing.id));
  }
}

// ═════════════════════════════════════════════════════════════════
// SISTER COMPANIES — CRUD
// ═════════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const rows = await db.select().from(sisterCompaniesTable)
    .where(eq(sisterCompaniesTable.companyId, cid))
    .orderBy(desc(sisterCompaniesTable.id));
  res.json(rows);
});

router.post("/", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const b = req.body ?? {};
  if (!b.nameAr || !String(b.nameAr).trim()) { res.status(400).json({ error: "الاسم بالعربية مطلوب" }); return; }
  const [row] = await db.insert(sisterCompaniesTable).values({
    companyId: cid,
    nameAr: String(b.nameAr).trim(),
    nameEn: b.nameEn ?? null,
    vatNumber: b.vatNumber ?? null,
    crNumber:  b.crNumber  ?? null,
    phone: b.phone ?? null,
    email: b.email ?? null,
    address: b.address ?? null,
    accountId: b.accountId ?? null,
    defaultCogsAccountId:      b.defaultCogsAccountId      ?? null,
    defaultRevenueAccountId:   b.defaultRevenueAccountId   ?? null,
    defaultInventoryAccountId: b.defaultInventoryAccountId ?? null,
    notes: b.notes ?? null,
    isActive: b.isActive ?? true,
  }).returning();
  res.status(201).json(row);
});

// ═════════════════════════════════════════════════════════════════
// SISTER TRANSFERS
// ═════════════════════════════════════════════════════════════════
router.get("/transfers", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const sid = req.query.sisterCompanyId ? Number(req.query.sisterCompanyId) : null;
  const where = sid
    ? and(eq(sisterTransfersTable.companyId, cid), eq(sisterTransfersTable.sisterCompanyId, sid))
    : eq(sisterTransfersTable.companyId, cid);
  const rows = await db.select().from(sisterTransfersTable)
    .where(where).orderBy(desc(sisterTransfersTable.id));
  res.json(rows);
});

router.get("/transfers/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [head] = await db.select().from(sisterTransfersTable)
    .where(and(eq(sisterTransfersTable.id, id), eq(sisterTransfersTable.companyId, cid)));
  if (!head) { res.status(404).json({ error: "غير موجود" }); return; }
  const items = await db.select().from(sisterTransferItemsTable)
    .where(eq(sisterTransferItemsTable.transferId, id));
  res.json({ ...head, items });
});

function pickTransferAccounts(transfer: any, sister: any) {
  return {
    ar:        transfer.arAccountId        ?? sister.accountId                 ?? null,
    cogs:      transfer.cogsAccountId      ?? sister.defaultCogsAccountId      ?? null,
    revenue:   transfer.revenueAccountId   ?? sister.defaultRevenueAccountId   ?? null,
    inventory: transfer.inventoryAccountId ?? sister.defaultInventoryAccountId ?? null,
  };
}

router.post("/transfers", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const b = req.body ?? {};
  if (!b.sisterCompanyId || !b.fromWarehouseId || !b.transferDate || !Array.isArray(b.items) || !b.items.length) {
    res.status(400).json({ error: "بيانات ناقصة" }); return;
  }
  // Tenant guard
  const [sister] = await db.select().from(sisterCompaniesTable)
    .where(and(eq(sisterCompaniesTable.id, Number(b.sisterCompanyId)), eq(sisterCompaniesTable.companyId, cid)));
  if (!sister) { res.status(400).json({ error: "الشركة الشقيقة غير صالحة" }); return; }
  const [wh] = await db.select().from(warehousesTable)
    .where(and(eq(warehousesTable.id, Number(b.fromWarehouseId)), eq(warehousesTable.companyId, cid)));
  if (!wh) { res.status(400).json({ error: "المخزن غير صالح" }); return; }

  let num: string;
  try {
    const fromSeq = await nextSequenceNumber(cid, "sister_transfer", {
      userId: (req as any).authUser?.id ?? null,
      refTable: "sister_transfers", branchId: null,
    });
    num = fromSeq ?? (b.transferNumber?.trim?.() || `SCT-${Date.now()}`);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "تعذر توليد رقم التحويل" });
    return;
  }

  const totals = b.items.reduce(
    (acc: any, it: any) => {
      acc.cost   += Number(it.qty) * Number(it.costPrice || 0);
      acc.supply += Number(it.qty) * Number(it.supplyPrice || 0);
      return acc;
    },
    { cost: 0, supply: 0 },
  );

  const [tr] = await db.insert(sisterTransfersTable).values({
    companyId: cid,
    transferNumber: num,
    transferDate: b.transferDate,
    sisterCompanyId: Number(b.sisterCompanyId),
    fromWarehouseId: Number(b.fromWarehouseId),
    arAccountId:        b.arAccountId        ?? null,
    cogsAccountId:      b.cogsAccountId      ?? null,
    revenueAccountId:   b.revenueAccountId   ?? null,
    inventoryAccountId: b.inventoryAccountId ?? null,
    totalCost:   totals.cost.toFixed(4),
    totalSupply: totals.supply.toFixed(4),
    status: "draft",
    notes: b.notes ?? null,
  }).returning();

  await db.insert(sisterTransferItemsTable).values(b.items.map((it: any) => ({
    transferId: tr.id,
    itemId: Number(it.itemId),
    unitId: it.unitId ? Number(it.unitId) : null,
    qty: String(it.qty),
    costPrice:   String(it.costPrice   ?? 0),
    supplyPrice: String(it.supplyPrice ?? 0),
  })));

  res.status(201).json(tr);
});

router.put("/transfers/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const b = req.body ?? {};
  const [existing] = await db.select().from(sisterTransfersTable)
    .where(and(eq(sisterTransfersTable.id, id), eq(sisterTransfersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status !== "draft") { res.status(400).json({ error: "لا يمكن التعديل بعد الترحيل" }); return; }

  // Re-validate tenant ownership for any mutable FK that changed.
  if (b.sisterCompanyId && Number(b.sisterCompanyId) !== existing.sisterCompanyId) {
    const [s] = await db.select({ id: sisterCompaniesTable.id }).from(sisterCompaniesTable)
      .where(and(eq(sisterCompaniesTable.id, Number(b.sisterCompanyId)), eq(sisterCompaniesTable.companyId, cid)));
    if (!s) { res.status(400).json({ error: "الشركة الشقيقة غير صالحة" }); return; }
  }
  if (b.fromWarehouseId && Number(b.fromWarehouseId) !== existing.fromWarehouseId) {
    const [w] = await db.select({ id: warehousesTable.id }).from(warehousesTable)
      .where(and(eq(warehousesTable.id, Number(b.fromWarehouseId)), eq(warehousesTable.companyId, cid)));
    if (!w) { res.status(400).json({ error: "المخزن غير صالح" }); return; }
  }

  const items = Array.isArray(b.items) ? b.items : null;
  const totals = items
    ? items.reduce((acc: any, it: any) => {
        acc.cost   += Number(it.qty) * Number(it.costPrice || 0);
        acc.supply += Number(it.qty) * Number(it.supplyPrice || 0);
        return acc;
      }, { cost: 0, supply: 0 })
    : { cost: Number(existing.totalCost), supply: Number(existing.totalSupply) };

  await db.update(sisterTransfersTable).set({
    transferDate: b.transferDate ?? existing.transferDate,
    sisterCompanyId: b.sisterCompanyId ?? existing.sisterCompanyId,
    fromWarehouseId: b.fromWarehouseId ?? existing.fromWarehouseId,
    arAccountId:        b.arAccountId        ?? existing.arAccountId,
    cogsAccountId:      b.cogsAccountId      ?? existing.cogsAccountId,
    revenueAccountId:   b.revenueAccountId   ?? existing.revenueAccountId,
    inventoryAccountId: b.inventoryAccountId ?? existing.inventoryAccountId,
    totalCost:   totals.cost.toFixed(4),
    totalSupply: totals.supply.toFixed(4),
    notes: b.notes ?? existing.notes,
    updatedAt: new Date(),
  }).where(eq(sisterTransfersTable.id, id));

  if (items) {
    await db.delete(sisterTransferItemsTable).where(eq(sisterTransferItemsTable.transferId, id));
    if (items.length) {
      await db.insert(sisterTransferItemsTable).values(items.map((it: any) => ({
        transferId: id,
        itemId: Number(it.itemId),
        unitId: it.unitId ? Number(it.unitId) : null,
        qty: String(it.qty),
        costPrice:   String(it.costPrice   ?? 0),
        supplyPrice: String(it.supplyPrice ?? 0),
      })));
    }
  }
  res.json({ ok: true });
});

// POST /transfers/:id/post — confirm: stock out + JE creation
router.post("/transfers/:id/post", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  // Atomic claim
  const claim = await db.update(sisterTransfersTable)
    .set({ updatedAt: new Date() })
    .where(and(eq(sisterTransfersTable.id, id), eq(sisterTransfersTable.companyId, cid), eq(sisterTransfersTable.status, "draft")))
    .returning();
  if (!claim.length) { res.status(400).json({ error: "الحركة غير موجودة أو مُرحَّلة مسبقاً" }); return; }
  const tr = claim[0];
  const lines = await db.select().from(sisterTransferItemsTable).where(eq(sisterTransferItemsTable.transferId, id));
  if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف" }); return; }

  const [sister] = await db.select().from(sisterCompaniesTable)
    .where(and(eq(sisterCompaniesTable.id, tr.sisterCompanyId), eq(sisterCompaniesTable.companyId, cid)));
  if (!sister) { res.status(400).json({ error: "الشركة الشقيقة غير موجودة" }); return; }

  const accs = pickTransferAccounts(tr, sister);
  if (!accs.ar || !accs.cogs || !accs.revenue || !accs.inventory) {
    res.status(400).json({ error: "الحسابات المحاسبية الأربعة مطلوبة (ذمم/تكلفة/إيراد/مخزون) — اضبط الافتراضيات على بطاقة الشركة الشقيقة أو حدّدها يدوياً" });
    return;
  }
  const writability = await assertWritableForDate(cid, tr.transferDate as any);
  if (!writability.ok) { res.status(423).json({ error: writability.reason }); return; }

  let totalCost = 0;
  let totalSupply = 0;
  for (const line of lines) {
    const q = Number(line.qty); const c = Number(line.costPrice); const s = Number(line.supplyPrice);
    totalCost   += q * c;
    totalSupply += q * s;
    await upsertBalance(cid, line.itemId, tr.fromWarehouseId, -q, c);
    const newBal = await getBalance(cid, line.itemId, tr.fromWarehouseId);
    await db.insert(stockLedgerTable).values({
      companyId: cid, itemId: line.itemId, warehouseId: tr.fromWarehouseId,
      txDate: tr.transferDate as any, txType: "transfer_out" as any,
      qty: String(-q), costPrice: line.costPrice, totalCost: String(-q * c),
      balanceQty: String(newBal), refId: id, refType: "sister_transfer",
    });
  }

  const desc = `تحويل لشركة شقيقة ${tr.transferNumber} - ${sister.nameAr}`;
  const jeStatus = await resolvePostingStatus(cid, "stockMovement");
  const [entry] = await db.insert(journalEntriesTable).values({
    companyId: cid, docNumber: tr.transferNumber, entryDate: tr.transferDate as any,
    currency: "SAR", exchangeRate: "1",
    description: desc, entryType: "sister_transfer",
    status: jeStatus, periodId: writability.period?.id ?? null,
    ...fullAuditFor(req, jeStatus),
  }).returning();
  await db.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: accs.cogs!,      debit: totalCost.toFixed(2),   credit: "0.00", description: `تكلفة البضاعة - ${tr.transferNumber}`, sortOrder: 0 },
    { entryId: entry.id, accountId: accs.ar!,        debit: totalSupply.toFixed(2), credit: "0.00", description: `ذمم ${sister.nameAr}`, sortOrder: 1 },
    { entryId: entry.id, accountId: accs.inventory!, debit: "0.00", credit: totalCost.toFixed(2),   description: `تخفيض المخزون - ${tr.transferNumber}`, sortOrder: 2 },
    { entryId: entry.id, accountId: accs.revenue!,   debit: "0.00", credit: totalSupply.toFixed(2), description: `إيراد توريد داخلي - ${tr.transferNumber}`, sortOrder: 3 },
  ]);

  await db.update(sisterTransfersTable).set({
    status: "posted", journalEntryId: entry.id,
    totalCost: totalCost.toFixed(4), totalSupply: totalSupply.toFixed(4),
    updatedAt: new Date(),
  }).where(eq(sisterTransfersTable.id, id));
  res.json({ ok: true, journalEntryId: entry.id });
});

router.delete("/transfers/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [existing] = await db.select().from(sisterTransfersTable)
    .where(and(eq(sisterTransfersTable.id, id), eq(sisterTransfersTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن حذف تحويل مُرحَّل — استخدم المرتجع" }); return; }
  await db.delete(sisterTransfersTable).where(eq(sisterTransfersTable.id, id));
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════
// SISTER RETURNS
// ═════════════════════════════════════════════════════════════════
router.get("/returns", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const rows = await db.select().from(sisterReturnsTable)
    .where(eq(sisterReturnsTable.companyId, cid))
    .orderBy(desc(sisterReturnsTable.id));
  res.json(rows);
});

router.get("/returns/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [head] = await db.select().from(sisterReturnsTable)
    .where(and(eq(sisterReturnsTable.id, id), eq(sisterReturnsTable.companyId, cid)));
  if (!head) { res.status(404).json({ error: "غير موجود" }); return; }
  const items = await db.select().from(sisterReturnItemsTable)
    .where(eq(sisterReturnItemsTable.returnId, id));
  res.json({ ...head, items });
});

router.post("/returns", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const b = req.body ?? {};
  if (!b.transferId || !b.toWarehouseId || !b.returnDate || !Array.isArray(b.items) || !b.items.length) {
    res.status(400).json({ error: "بيانات ناقصة" }); return;
  }
  const [orig] = await db.select().from(sisterTransfersTable)
    .where(and(eq(sisterTransfersTable.id, Number(b.transferId)), eq(sisterTransfersTable.companyId, cid)));
  if (!orig || orig.status !== "posted") { res.status(400).json({ error: "التحويل الأصلي غير صالح" }); return; }
  // Tenant guard for return-destination warehouse.
  const [retWh] = await db.select({ id: warehousesTable.id }).from(warehousesTable)
    .where(and(eq(warehousesTable.id, Number(b.toWarehouseId)), eq(warehousesTable.companyId, cid)));
  if (!retWh) { res.status(400).json({ error: "مخزن الاسترجاع غير صالح" }); return; }

  // Validate each return line refs a transfer item from the same transfer
  // and does not exceed remaining-qty.
  const origLines = await db.select().from(sisterTransferItemsTable)
    .where(eq(sisterTransferItemsTable.transferId, orig.id));
  const origMap = new Map(origLines.map(l => [l.id, l]));
  for (const it of b.items) {
    const tl = origMap.get(Number(it.transferItemId));
    if (!tl) { res.status(400).json({ error: "بند مرتجع غير مرتبط بالتحويل الأصلي" }); return; }
    const remaining = Number(tl.qty) - Number(tl.returnedQty);
    if (Number(it.qty) <= 0 || Number(it.qty) > remaining + 1e-6) {
      res.status(400).json({ error: `الكمية المرتجعة تتجاوز المتاح للصنف (${remaining})` });
      return;
    }
  }

  let num: string;
  try {
    const fromSeq = await nextSequenceNumber(cid, "sister_return", {
      userId: (req as any).authUser?.id ?? null,
      refTable: "sister_returns", branchId: null,
    });
    num = fromSeq ?? (b.returnNumber?.trim?.() || `SCR-${Date.now()}`);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "تعذر توليد رقم المرتجع" });
    return;
  }

  const totals = b.items.reduce((acc: any, it: any) => {
    const tl = origMap.get(Number(it.transferItemId))!;
    acc.cost   += Number(it.qty) * Number(tl.costPrice);
    acc.supply += Number(it.qty) * Number(tl.supplyPrice);
    return acc;
  }, { cost: 0, supply: 0 });

  const [ret] = await db.insert(sisterReturnsTable).values({
    companyId: cid,
    returnNumber: num,
    returnDate: b.returnDate,
    transferId: orig.id,
    sisterCompanyId: orig.sisterCompanyId,
    toWarehouseId: Number(b.toWarehouseId),
    totalCost: totals.cost.toFixed(4),
    totalSupply: totals.supply.toFixed(4),
    status: "draft",
    notes: b.notes ?? null,
  }).returning();

  await db.insert(sisterReturnItemsTable).values(b.items.map((it: any) => {
    const tl = origMap.get(Number(it.transferItemId))!;
    return {
      returnId: ret.id,
      transferItemId: tl.id,
      itemId: tl.itemId,
      unitId: tl.unitId,
      qty: String(it.qty),
      costPrice:   tl.costPrice,
      supplyPrice: tl.supplyPrice,
    };
  }));

  res.status(201).json(ret);
});

router.post("/returns/:id/post", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const claim = await db.update(sisterReturnsTable)
    .set({ updatedAt: new Date() })
    .where(and(eq(sisterReturnsTable.id, id), eq(sisterReturnsTable.companyId, cid), eq(sisterReturnsTable.status, "draft")))
    .returning();
  if (!claim.length) { res.status(400).json({ error: "الحركة غير موجودة أو مُرحَّلة مسبقاً" }); return; }
  const ret = claim[0];
  const lines = await db.select().from(sisterReturnItemsTable).where(eq(sisterReturnItemsTable.returnId, id));
  if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف" }); return; }
  const [orig] = await db.select().from(sisterTransfersTable)
    .where(and(eq(sisterTransfersTable.id, ret.transferId), eq(sisterTransfersTable.companyId, cid)));
  if (!orig) { res.status(400).json({ error: "التحويل الأصلي غير موجود" }); return; }
  const [sister] = await db.select().from(sisterCompaniesTable)
    .where(and(eq(sisterCompaniesTable.id, ret.sisterCompanyId), eq(sisterCompaniesTable.companyId, cid)));
  if (!sister) { res.status(400).json({ error: "الشركة الشقيقة غير موجودة" }); return; }
  const accs = pickTransferAccounts(orig, sister);
  if (!accs.ar || !accs.cogs || !accs.revenue || !accs.inventory) {
    res.status(400).json({ error: "الحسابات الأربعة الأصلية غير مكتملة" }); return;
  }
  const writability = await assertWritableForDate(cid, ret.returnDate as any);
  if (!writability.ok) { res.status(423).json({ error: writability.reason }); return; }

  let totalCost = 0;
  let totalSupply = 0;
  for (const line of lines) {
    const q = Number(line.qty); const c = Number(line.costPrice); const s = Number(line.supplyPrice);
    totalCost   += q * c;
    totalSupply += q * s;
    // Restore stock at the original cost
    await upsertBalance(cid, line.itemId, ret.toWarehouseId, +q, c);
    const newBal = await getBalance(cid, line.itemId, ret.toWarehouseId);
    await db.insert(stockLedgerTable).values({
      companyId: cid, itemId: line.itemId, warehouseId: ret.toWarehouseId,
      txDate: ret.returnDate as any, txType: "transfer_in" as any,
      qty: String(q), costPrice: line.costPrice, totalCost: String(q * c),
      balanceQty: String(newBal), refId: id, refType: "sister_return",
    });
    // Bump returnedQty on original line so future returns can't double-count.
    await db.update(sisterTransferItemsTable).set({
      returnedQty: sql`${sisterTransferItemsTable.returnedQty} + ${q}`,
    }).where(eq(sisterTransferItemsTable.id, line.transferItemId));
  }

  const desc = `مرتجع تحويل شركة شقيقة ${ret.returnNumber} - ${sister.nameAr}`;
  const jeStatus = await resolvePostingStatus(cid, "stockMovement");
  const [entry] = await db.insert(journalEntriesTable).values({
    companyId: cid, docNumber: ret.returnNumber, entryDate: ret.returnDate as any,
    currency: "SAR", exchangeRate: "1",
    description: desc, entryType: "sister_transfer_return",
    status: jeStatus, periodId: writability.period?.id ?? null,
    ...fullAuditFor(req, jeStatus),
  }).returning();
  await db.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: accs.inventory!, debit: totalCost.toFixed(2),   credit: "0.00", description: `استرجاع المخزون - ${ret.returnNumber}`, sortOrder: 0 },
    { entryId: entry.id, accountId: accs.revenue!,   debit: totalSupply.toFixed(2), credit: "0.00", description: `عكس إيراد توريد - ${ret.returnNumber}`, sortOrder: 1 },
    { entryId: entry.id, accountId: accs.cogs!,      debit: "0.00", credit: totalCost.toFixed(2),   description: `عكس تكلفة بضاعة - ${ret.returnNumber}`, sortOrder: 2 },
    { entryId: entry.id, accountId: accs.ar!,        debit: "0.00", credit: totalSupply.toFixed(2), description: `تخفيض ذمم ${sister.nameAr}`, sortOrder: 3 },
  ]);

  await db.update(sisterReturnsTable).set({
    status: "posted", journalEntryId: entry.id,
    totalCost: totalCost.toFixed(4), totalSupply: totalSupply.toFixed(4),
    updatedAt: new Date(),
  }).where(eq(sisterReturnsTable.id, id));
  res.json({ ok: true, journalEntryId: entry.id });
});

router.delete("/returns/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [existing] = await db.select().from(sisterReturnsTable)
    .where(and(eq(sisterReturnsTable.id, id), eq(sisterReturnsTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن حذف مرتجع مُرحَّل" }); return; }
  await db.delete(sisterReturnsTable).where(eq(sisterReturnsTable.id, id));
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════
// SISTER SETTLEMENTS
// ═════════════════════════════════════════════════════════════════
router.get("/settlements", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const rows = await db.select().from(sisterSettlementsTable)
    .where(eq(sisterSettlementsTable.companyId, cid))
    .orderBy(desc(sisterSettlementsTable.id));
  res.json(rows);
});

router.get("/settlements/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const [row] = await db.select().from(sisterSettlementsTable)
    .where(and(eq(sisterSettlementsTable.id, Number(req.params.id)), eq(sisterSettlementsTable.companyId, cid)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.post("/settlements", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const b = req.body ?? {};
  if (!b.sisterCompanyId || !b.date || !b.direction || !b.paymentType || !b.amount) {
    res.status(400).json({ error: "بيانات ناقصة" }); return;
  }
  if (b.paymentType === "cash" && !b.cashBoxId) { res.status(400).json({ error: "اختر الخزينة" }); return; }
  if (b.paymentType === "bank" && !b.bankAccountId) { res.status(400).json({ error: "اختر الحساب البنكي" }); return; }
  if (Number(b.amount) <= 0) { res.status(400).json({ error: "المبلغ يجب أن يكون موجباً" }); return; }
  const [sister] = await db.select().from(sisterCompaniesTable)
    .where(and(eq(sisterCompaniesTable.id, Number(b.sisterCompanyId)), eq(sisterCompaniesTable.companyId, cid)));
  if (!sister) { res.status(400).json({ error: "الشركة الشقيقة غير صالحة" }); return; }

  let num: string;
  try {
    const fromSeq = await nextSequenceNumber(cid, "sister_settlement", {
      userId: (req as any).authUser?.id ?? null,
      refTable: "sister_settlements", branchId: null,
    });
    num = fromSeq ?? (b.code?.trim?.() || `SCS-${Date.now()}`);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "تعذر توليد رقم السند" }); return;
  }

  const [row] = await db.insert(sisterSettlementsTable).values({
    companyId: cid, code: num, date: b.date,
    sisterCompanyId: Number(b.sisterCompanyId),
    direction: b.direction,
    paymentType: b.paymentType,
    cashBoxId:     b.paymentType === "cash" ? Number(b.cashBoxId)     : null,
    bankAccountId: b.paymentType === "bank" ? Number(b.bankAccountId) : null,
    amount: String(b.amount),
    description: b.description ?? null,
    status: "draft",
  }).returning();
  res.status(201).json(row);
});

router.post("/settlements/:id/post", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const claim = await db.update(sisterSettlementsTable)
    .set({ updatedAt: new Date() })
    .where(and(eq(sisterSettlementsTable.id, id), eq(sisterSettlementsTable.companyId, cid), eq(sisterSettlementsTable.status, "draft")))
    .returning();
  if (!claim.length) { res.status(400).json({ error: "السند غير موجود أو مُرحَّل مسبقاً" }); return; }
  const v = claim[0];
  const [sister] = await db.select().from(sisterCompaniesTable)
    .where(and(eq(sisterCompaniesTable.id, v.sisterCompanyId), eq(sisterCompaniesTable.companyId, cid)));
  if (!sister?.accountId) {
    res.status(400).json({ error: "حساب الذمم للشركة الشقيقة غير مُعرّف" }); return;
  }

  let cashAccId: number | null = null;
  let cashLabel = "";
  if (v.paymentType === "bank") {
    const [bk] = await db.select().from(bankAccountsTable)
      .where(and(eq(bankAccountsTable.id, v.bankAccountId!), eq(bankAccountsTable.companyId, cid)));
    if (!bk?.accountId) { res.status(400).json({ error: "الحساب البنكي غير مرتبط بحساب محاسبي" }); return; }
    cashAccId = bk.accountId; cashLabel = `بنك ${bk.nameAr ?? ""}`.trim();
  } else {
    const [cb] = await db.select().from(cashBoxesTable)
      .where(and(eq(cashBoxesTable.id, v.cashBoxId!), eq(cashBoxesTable.companyId, cid)));
    if (!cb?.accountId) { res.status(400).json({ error: "الخزينة غير مرتبطة بحساب محاسبي" }); return; }
    cashAccId = cb.accountId; cashLabel = `صندوق ${cb.nameAr ?? ""}`.trim();
  }

  const writability = await assertWritableForDate(cid, v.date as any);
  if (!writability.ok) { res.status(423).json({ error: writability.reason }); return; }
  const amt = Number(v.amount).toFixed(2);
  const isReceive = v.direction === "receive";
  const desc = `${isReceive ? "تحصيل من" : "سداد إلى"} ${sister.nameAr} - ${v.code}`;
  const jeStatus = await resolvePostingStatus(cid, "receipt");
  const [entry] = await db.insert(journalEntriesTable).values({
    companyId: cid, docNumber: v.code, entryDate: v.date as any,
    currency: "SAR", exchangeRate: "1",
    description: desc, entryType: "sister_settlement",
    status: jeStatus, periodId: writability.period?.id ?? null,
    ...fullAuditFor(req, jeStatus),
  }).returning();
  await db.insert(journalEntryLinesTable).values(
    isReceive
      ? [
          { entryId: entry.id, accountId: cashAccId!,       debit: amt, credit: "0.00", description: cashLabel || desc, sortOrder: 0 },
          { entryId: entry.id, accountId: sister.accountId!, debit: "0.00", credit: amt, description: `ذمم ${sister.nameAr}`, sortOrder: 1 },
        ]
      : [
          { entryId: entry.id, accountId: sister.accountId!, debit: amt, credit: "0.00", description: `ذمم ${sister.nameAr}`, sortOrder: 0 },
          { entryId: entry.id, accountId: cashAccId!,       debit: "0.00", credit: amt, description: cashLabel || desc, sortOrder: 1 },
        ]
  );
  await db.update(sisterSettlementsTable).set({
    status: "posted", journalEntryId: entry.id, updatedAt: new Date(),
  }).where(eq(sisterSettlementsTable.id, id));
  res.json({ ok: true, journalEntryId: entry.id });
});

router.delete("/settlements/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [existing] = await db.select().from(sisterSettlementsTable)
    .where(and(eq(sisterSettlementsTable.id, id), eq(sisterSettlementsTable.companyId, cid)));
  if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
  if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن حذف سند مُرحَّل" }); return; }
  await db.delete(sisterSettlementsTable).where(eq(sisterSettlementsTable.id, id));
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════
// SISTER COMPANY STATEMENT — chronological ledger of all activity
// ═════════════════════════════════════════════════════════════════
router.get("/:id/statement", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const sid = Number(req.params.id);
  const from = (req.query.from as string) || null;
  const to   = (req.query.to   as string) || null;

  const trWhere = [eq(sisterTransfersTable.companyId, cid), eq(sisterTransfersTable.sisterCompanyId, sid), eq(sisterTransfersTable.status, "posted")];
  if (from) trWhere.push(gte(sisterTransfersTable.transferDate, from));
  if (to)   trWhere.push(lte(sisterTransfersTable.transferDate, to));
  const transfers = await db.select().from(sisterTransfersTable).where(and(...trWhere));

  const reWhere = [eq(sisterReturnsTable.companyId, cid), eq(sisterReturnsTable.sisterCompanyId, sid), eq(sisterReturnsTable.status, "posted")];
  if (from) reWhere.push(gte(sisterReturnsTable.returnDate, from));
  if (to)   reWhere.push(lte(sisterReturnsTable.returnDate, to));
  const returns_ = await db.select().from(sisterReturnsTable).where(and(...reWhere));

  const seWhere = [eq(sisterSettlementsTable.companyId, cid), eq(sisterSettlementsTable.sisterCompanyId, sid), eq(sisterSettlementsTable.status, "posted")];
  if (from) seWhere.push(gte(sisterSettlementsTable.date, from));
  if (to)   seWhere.push(lte(sisterSettlementsTable.date, to));
  const settlements = await db.select().from(sisterSettlementsTable).where(and(...seWhere));

  // Opening balance = sum of activity BEFORE `from`
  let opening = 0;
  if (from) {
    const prevTr = await db.select({ amt: sisterTransfersTable.totalSupply }).from(sisterTransfersTable)
      .where(and(eq(sisterTransfersTable.companyId, cid), eq(sisterTransfersTable.sisterCompanyId, sid), eq(sisterTransfersTable.status, "posted"), lt(sisterTransfersTable.transferDate, from)));
    const prevRe = await db.select({ amt: sisterReturnsTable.totalSupply }).from(sisterReturnsTable)
      .where(and(eq(sisterReturnsTable.companyId, cid), eq(sisterReturnsTable.sisterCompanyId, sid), eq(sisterReturnsTable.status, "posted"), lt(sisterReturnsTable.returnDate, from)));
    const prevSe = await db.select({ amt: sisterSettlementsTable.amount, dir: sisterSettlementsTable.direction }).from(sisterSettlementsTable)
      .where(and(eq(sisterSettlementsTable.companyId, cid), eq(sisterSettlementsTable.sisterCompanyId, sid), eq(sisterSettlementsTable.status, "posted"), lt(sisterSettlementsTable.date, from)));
    for (const t of prevTr) opening += Number(t.amt);
    for (const r of prevRe) opening -= Number(r.amt);
    for (const s of prevSe) opening += s.dir === "pay" ? Number(s.amt) : -Number(s.amt);
  }

  // Resolve JE doc-numbers for every posted source doc so the statement
  // can show "رقم القيد" and deep-link to /accounting/journals/:id — same
  // shape as the customer/supplier statement.
  const jeIds = [
    ...transfers.map(t => t.journalEntryId),
    ...returns_.map(r => r.journalEntryId),
    ...settlements.map(s => s.journalEntryId),
  ].filter((x): x is number => x != null);
  const jeMap = new Map<number, string | null>();
  if (jeIds.length > 0) {
    const jes = await db.select({ id: journalEntriesTable.id, docNumber: journalEntriesTable.docNumber })
      .from(journalEntriesTable)
      .where(inArray(journalEntriesTable.id, jeIds));
    for (const j of jes) jeMap.set(j.id, j.docNumber);
  }

  type Row = {
    /** Source-doc id (transfer / return / settlement) — used for keys. */
    id: number;
    /** Short type code (transfer / return / settlement) — used by the
     *  client to pick a deep-link route for the docNumber cell. */
    kind: "transfer" | "return" | "settlement";
    date: string;
    docNumber: string;
    type: string;
    /** Linked posted JE id + number for the رقم القيد cell. */
    journalEntryId: number | null;
    journalEntryNumber: string | null;
    debit: number;
    credit: number;
    description: string;
  };
  const rows: Row[] = [];
  for (const t of transfers) rows.push({
    id: t.id, kind: "transfer", date: String(t.transferDate),
    docNumber: t.transferNumber, type: "تحويل",
    journalEntryId: t.journalEntryId, journalEntryNumber: t.journalEntryId != null ? jeMap.get(t.journalEntryId) ?? null : null,
    debit: Number(t.totalSupply), credit: 0, description: t.notes ?? "",
  });
  for (const r of returns_) rows.push({
    id: r.id, kind: "return", date: String(r.returnDate),
    docNumber: r.returnNumber, type: "مرتجع",
    journalEntryId: r.journalEntryId, journalEntryNumber: r.journalEntryId != null ? jeMap.get(r.journalEntryId) ?? null : null,
    debit: 0, credit: Number(r.totalSupply), description: r.notes ?? "",
  });
  for (const s of settlements) rows.push({
    id: s.id, kind: "settlement", date: String(s.date),
    docNumber: s.code, type: s.direction === "receive" ? "تحصيل" : "سداد",
    journalEntryId: s.journalEntryId, journalEntryNumber: s.journalEntryId != null ? jeMap.get(s.journalEntryId) ?? null : null,
    debit:  s.direction === "pay"     ? Number(s.amount) : 0,
    credit: s.direction === "receive" ? Number(s.amount) : 0,
    description: s.description ?? "",
  });
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.docNumber.localeCompare(b.docNumber));

  let running = opening;
  const withBalance = rows.map(r => { running += r.debit - r.credit; return { ...r, balance: running }; });
  res.json({ opening, rows: withBalance, closing: running });
});

// ═════════════════════════════════════════════════════════════════
// SISTER COMPANY single-resource routes (registered LAST so the literal
// `/transfers`, `/returns`, `/settlements` segments above are matched
// first — Express 5 / path-to-regexp 8 no longer supports inline regex
// constraints like `/:id(\d+)` so we rely on registration order instead.)
// ═════════════════════════════════════════════════════════════════
router.get("/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const [row] = await db.select().from(sisterCompaniesTable)
    .where(and(eq(sisterCompaniesTable.id, Number(req.params.id)), eq(sisterCompaniesTable.companyId, cid)));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.put("/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const b = req.body ?? {};
  const [updated] = await db.update(sisterCompaniesTable).set({
    nameAr: b.nameAr,
    nameEn: b.nameEn ?? null,
    vatNumber: b.vatNumber ?? null,
    crNumber: b.crNumber ?? null,
    phone: b.phone ?? null,
    email: b.email ?? null,
    address: b.address ?? null,
    accountId: b.accountId ?? null,
    defaultCogsAccountId:      b.defaultCogsAccountId      ?? null,
    defaultRevenueAccountId:   b.defaultRevenueAccountId   ?? null,
    defaultInventoryAccountId: b.defaultInventoryAccountId ?? null,
    notes: b.notes ?? null,
    isActive: b.isActive ?? true,
    updatedAt: new Date(),
  }).where(and(eq(sisterCompaniesTable.id, id), eq(sisterCompaniesTable.companyId, cid))).returning();
  if (!updated) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const id = Number(req.params.id);
  const [tr] = await db.select({ id: sisterTransfersTable.id }).from(sisterTransfersTable)
    .where(and(eq(sisterTransfersTable.companyId, cid), eq(sisterTransfersTable.sisterCompanyId, id))).limit(1);
  if (tr) { res.status(409).json({ error: "لا يمكن الحذف — توجد حركات مرتبطة" }); return; }
  await db.delete(sisterCompaniesTable).where(and(eq(sisterCompaniesTable.id, id), eq(sisterCompaniesTable.companyId, cid)));
  res.json({ ok: true });
});

router.get("/:id/balance", async (req, res) => {
  const cid = guard(req, res); if (!cid) return;
  const sid = Number(req.params.id);
  const transfers = await db.select({ amt: sisterTransfersTable.totalSupply })
    .from(sisterTransfersTable)
    .where(and(eq(sisterTransfersTable.companyId, cid), eq(sisterTransfersTable.sisterCompanyId, sid), eq(sisterTransfersTable.status, "posted")));
  const returns_ = await db.select({ amt: sisterReturnsTable.totalSupply })
    .from(sisterReturnsTable)
    .where(and(eq(sisterReturnsTable.companyId, cid), eq(sisterReturnsTable.sisterCompanyId, sid), eq(sisterReturnsTable.status, "posted")));
  const settlements = await db.select({
    amt: sisterSettlementsTable.amount, dir: sisterSettlementsTable.direction,
  }).from(sisterSettlementsTable)
    .where(and(eq(sisterSettlementsTable.companyId, cid), eq(sisterSettlementsTable.sisterCompanyId, sid), eq(sisterSettlementsTable.status, "posted")));
  let bal = 0;
  for (const t of transfers) bal += Number(t.amt);
  for (const r of returns_)  bal -= Number(r.amt);
  for (const s of settlements) bal += s.dir === "pay" ? Number(s.amt) : -Number(s.amt);
  res.json({ balance: bal });
});

export default router;
