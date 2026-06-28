import { Router } from "express";
import { db } from "@workspace/db";
import {
  goodsDeliveriesTable, goodsDeliveryLinesTable,
  salesInvoicesTable, salesInvoiceLinesTable,
  customersTable, accountsTable, warehousesTable,
  journalEntriesTable, journalEntryLinesTable,
  stockBalanceTable, stockLedgerTable,
  itemsTable, branchesTable, cashBoxesTable, bankAccountsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
import { resolveTaxRate } from "../lib/companyTaxes.js";
import { pathRbac, requireAdminRole } from "../middleware/permissions.js";
import { loadMappings } from "../lib/accountingMappings.js";
import { fullAuditFor } from "../lib/journalAudit.js";
import { nextSequenceNumber, nextSequenceForPayment } from "../lib/sequences.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { resolvePostingStatus } from "../lib/postingStatus.js";

const router = Router();
router.use(extractAuth);
router.use(pathRbac([
  ["/", "warehouses"],
]));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// ─── Delivery Clearing account auto-provision ────────────────────────────
// For legacy tenants whose COA was bulk-imported BEFORE the 1110 / 11101
// codes were added to defaultChartOfAccounts.ts, materialize the two
// accounts on the fly so the GDN flow never fails with "account missing"
// on a tenant who simply never re-imported. Also wires the mapping row.
async function getDeliveryClearingAccountId(cid: number): Promise<number | null> {
  // 1. Prefer the per-tenant accounting mapping (operator-overridable).
  const map = await loadMappings(cid, "goods_delivery");
  const mapped = map("goods_delivery", "delivery_clearing");
  if (mapped) return mapped;

  // 2. Try by COA code 11101 (posting child). The accounts table has no
  // unique index on (company_id, code), so under concurrent first-time
  // requests two rows could race in. We mitigate by always re-reading
  // post-insert and ALWAYS returning the lowest-id row, so every caller
  // converges on the same account id.
  const findPosting = async () => {
    const rows = await db.select().from(accountsTable).where(and(
      eq(accountsTable.companyId, cid),
      eq(accountsTable.code, "11101"),
    )).orderBy(asc(accountsTable.id));
    return rows[0];
  };
  const findParent = async () => {
    const rows = await db.select().from(accountsTable).where(and(
      eq(accountsTable.companyId, cid),
      eq(accountsTable.code, "1110"),
    )).orderBy(asc(accountsTable.id));
    return rows[0];
  };

  let posting = await findPosting();
  if (posting) return posting.id;

  // 3. Auto-provision: ensure parent 1110 exists, then the posting child.
  let parent = await findParent();
  if (!parent) {
    const [grandparent] = await db.select().from(accountsTable).where(and(
      eq(accountsTable.companyId, cid),
      eq(accountsTable.code, "11"),
    ));
    try {
      [parent] = await db.insert(accountsTable).values({
        companyId: cid,
        parentId: grandparent?.id ?? null,
        code: "1110",
        nameAr: "وسيط تسليم البضاعة",
        nameEn: "Goods Delivery Clearing",
        accountType: "asset",
        reportDirection: "balance_sheet",
        level: 3,
        isPosting: false,
        isActive: true,
      }).returning();
    } catch {
      parent = await findParent();
    }
    if (!parent) return null;
  }
  try {
    [posting] = await db.insert(accountsTable).values({
      companyId: cid,
      parentId: parent.id,
      code: "11101",
      nameAr: "وسيط التسليم",
      nameEn: "Delivery Clearing",
      accountType: "asset",
      reportDirection: "balance_sheet",
      level: 4,
      isPosting: true,
      isActive: true,
    }).returning();
  } catch {
    posting = await findPosting();
  }
  return (await findPosting())?.id ?? posting?.id ?? null;
}

// ─── Tenant ownership validation ────────────────────────────────────────
async function findStrayIds(table: any, cid: number, ids: number[]): Promise<number[]> {
  const uniq = Array.from(new Set(ids.filter((x): x is number => typeof x === "number" && Number.isFinite(x))));
  if (!uniq.length) return [];
  const rows = await db.select({ id: table.id }).from(table)
    .where(and(inArray(table.id, uniq), eq(table.companyId, cid)));
  const found = new Set(rows.map((r: any) => r.id));
  return uniq.filter(id => !found.has(id));
}

async function validateGdnTenantRefs(cid: number, payload: {
  branchId?: number | null; customerId?: number | null;
  cashBoxId?: number | null; bankAccountId?: number | null;
  itemIds?: number[]; warehouseIds?: number[];
}): Promise<string | null> {
  if (payload.branchId) {
    const stray = await findStrayIds(branchesTable, cid, [payload.branchId]);
    if (stray.length) return "الفرع المحدد لا ينتمي لهذه الشركة";
  }
  if (payload.customerId) {
    const stray = await findStrayIds(customersTable, cid, [payload.customerId]);
    if (stray.length) return "العميل المحدد لا ينتمي لهذه الشركة";
  }
  if (payload.cashBoxId) {
    const stray = await findStrayIds(cashBoxesTable, cid, [payload.cashBoxId]);
    if (stray.length) return "الخزنة المحددة لا تنتمي لهذه الشركة";
  }
  if (payload.bankAccountId) {
    const stray = await findStrayIds(bankAccountsTable, cid, [payload.bankAccountId]);
    if (stray.length) return "الحساب البنكي المحدد لا ينتمي لهذه الشركة";
  }
  if (payload.itemIds?.length) {
    const stray = await findStrayIds(itemsTable, cid, payload.itemIds);
    if (stray.length) return `بعض الأصناف لا تنتمي لهذه الشركة (id: ${stray.join(", ")})`;
  }
  if (payload.warehouseIds?.length) {
    const stray = await findStrayIds(warehousesTable, cid, payload.warehouseIds);
    if (stray.length) return `بعض المخازن لا تنتمي لهذه الشركة (id: ${stray.join(", ")})`;
  }
  return null;
}

async function loadWarehouseInfo(cid: number, ids: number[]): Promise<Record<number, { accountId: number | null; allowNegative: boolean; nameAr: string | null }>> {
  const out: Record<number, any> = {};
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  for (const wid of uniq) {
    const [w] = await db.select().from(warehousesTable)
      .where(and(eq(warehousesTable.id, wid), eq(warehousesTable.companyId, cid)));
    let acctId: number | null = w?.accountId ?? null;
    if (acctId) {
      const [a] = await db.select({ id: accountsTable.id }).from(accountsTable)
        .where(and(eq(accountsTable.id, acctId), eq(accountsTable.companyId, cid)));
      if (!a) acctId = null;
    }
    out[wid] = { accountId: acctId, allowNegative: !!w?.allowNegative, nameAr: w?.nameAr ?? null };
  }
  return out;
}

async function findFallbackInventoryAccountId(cid: number): Promise<number | null> {
  const rows = await db.select({ id: accountsTable.id }).from(accountsTable)
    .where(and(
      eq(accountsTable.companyId, cid),
      eq(accountsTable.isPosting, true),
      eq(accountsTable.isActive, true),
      sql`(${accountsTable.code} LIKE '1105%' OR ${accountsTable.code} LIKE '114%' OR ${accountsTable.nameAr} LIKE '%مخزون%')`,
    ))
    .orderBy(asc(accountsTable.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

type JLine = { accountId: number | null; debit?: number; credit?: number; description?: string | null };

// ═══════════════════════════════════════════════
// LIST / GET
// ═══════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(goodsDeliveriesTable)
      .where(and(
        eq(goodsDeliveriesTable.companyId, cid),
        ...branchScopeSpread(req, goodsDeliveriesTable.branchId, req.query.branchId),
      ))
      .orderBy(desc(goodsDeliveriesTable.deliveryDate), desc(goodsDeliveriesTable.id));
    // Resolve usernames for createdById / postedById in one pass.
    const { usersTable } = await import("@workspace/db");
    const { inArray } = await import("drizzle-orm");
    const uids = Array.from(new Set(
      rows.flatMap(r => [r.createdById, r.postedById])
        .filter((x): x is number => typeof x === "number")
    ));
    const uMap = new Map<number, string>();
    if (uids.length > 0) {
      const us = await db.select({ id: usersTable.id, username: usersTable.username })
        .from(usersTable).where(inArray(usersTable.id, uids));
      for (const u of us) uMap.set(u.id, u.username);
    }
    res.json(rows.map(r => ({
      ...r,
      createdByName: r.createdById != null ? (uMap.get(r.createdById) ?? null) : null,
      postedByName:  r.postedById  != null ? (uMap.get(r.postedById)  ?? null) : null,
    })));
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [gd] = await db.select().from(goodsDeliveriesTable)
      .where(and(eq(goodsDeliveriesTable.id, id), eq(goodsDeliveriesTable.companyId, cid)));
    if (!gd) { res.status(404).json({ error: "إذن التسليم غير موجود" }); return; }
    const lines = await db.select().from(goodsDeliveryLinesTable)
      .where(eq(goodsDeliveryLinesTable.deliveryId, id))
      .orderBy(asc(goodsDeliveryLinesTable.id));
    res.json({ ...gd, lines });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// CREATE / UPDATE / DELETE (draft only)
// ═══════════════════════════════════════════════
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const {
      docNumber, customerOrderNumber, deliveryDate, customerId, branchId,
      currencyCode, exchangeRate, subtotal, vatAmount, discountAmount,
      totalAmount, priceIncludesVat, notes, lines, taxId,
    } = req.body;
    if (!deliveryDate) { res.status(400).json({ error: "تاريخ التسليم مطلوب" }); return; }

    const tenantErr = await validateGdnTenantRefs(cid, {
      branchId:   branchId   ? Number(branchId)   : null,
      customerId: customerId ? Number(customerId) : null,
      itemIds:      (lines ?? []).map((l: any) => l.itemId      ? Number(l.itemId)      : null).filter((x: any): x is number => !!x),
      warehouseIds: (lines ?? []).map((l: any) => l.warehouseId ? Number(l.warehouseId) : null).filter((x: any): x is number => !!x),
    });
    if (tenantErr) { res.status(400).json({ error: tenantErr }); return; }

    // Sequence engine authoritative: consume it first (atomic) and ignore the
    // peeked client docNumber — otherwise every delivery reuses the same
    // previewed number. Manual number honoured only when no sequence configured.
    let resolvedDocNumber: string | null = null;
    try {
      const fromSeq = await nextSequenceNumber(cid, "goods_delivery", {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "goods_deliveries",
        branchId: branchId ? Number(branchId) : null,
        docDate:  deliveryDate,
      });
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      // A null return ("no sequence configured") is handled above via the
      // `??` fallback; reaching here means a REAL engine error (e.g. capacity
      // exhausted) — surface it instead of silently bypassing the engine and
      // minting an unguarded number. Mirrors the purchase-invoice path.
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم السند" });
      return;
    }

    const [gd] = await db.insert(goodsDeliveriesTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: resolvedDocNumber,
      customerOrderNumber: customerOrderNumber || null,
      deliveryDate,
      customerId: customerId ? Number(customerId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal:       String(subtotal       || "0"),
      vatAmount:      String(vatAmount      || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount:    String(totalAmount    || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      status: "draft",
      notes: notes || null,
      taxId: taxId ? Number(taxId) : null,
      createdById: (req as any).authUser?.id ?? null,
    }).returning();

    if (lines?.length) {
      const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
      await db.insert(goodsDeliveryLinesTable).values(
        lines.map((l: any) => ({
          deliveryId: gd.id, companyId: cid,
          itemId: l.itemId ? Number(l.itemId) : null,
          itemName: l.itemName, itemCode: l.itemCode || null,
          unit: l.unit || null,
          unitId: l.unitId ? Number(l.unitId) : null,
          conversionFactor: String(l.conversionFactor || "1"),
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
          qty: String(l.qty || "1"),
          unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
          vatRate: String(l.vatRate || resolvedRate),
          lineTotal: String(l.lineTotal || "0"),
          notes: l.notes || null,
        }))
      );
    }
    res.status(201).json(gd);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [existing] = await db.select().from(goodsDeliveriesTable)
      .where(and(eq(goodsDeliveriesTable.id, id), eq(goodsDeliveriesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "إذن التسليم غير موجود" }); return; }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "لا يمكن تعديل إذن تسليم بعد الترحيل" });
      return;
    }
    const {
      customerOrderNumber, deliveryDate, customerId, branchId,
      currencyCode, exchangeRate, subtotal, vatAmount, discountAmount,
      totalAmount, priceIncludesVat, notes, lines, taxId,
    } = req.body;

    const tenantErr = await validateGdnTenantRefs(cid, {
      branchId:   branchId   ? Number(branchId)   : null,
      customerId: customerId ? Number(customerId) : null,
      itemIds:      (lines ?? []).map((l: any) => l.itemId      ? Number(l.itemId)      : null).filter((x: any): x is number => !!x),
      warehouseIds: (lines ?? []).map((l: any) => l.warehouseId ? Number(l.warehouseId) : null).filter((x: any): x is number => !!x),
    });
    if (tenantErr) { res.status(400).json({ error: tenantErr }); return; }

    const [gd] = await db.update(goodsDeliveriesTable).set({
      branchId: branchId ? Number(branchId) : null,
      customerOrderNumber: customerOrderNumber || null,
      deliveryDate,
      customerId: customerId ? Number(customerId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal:       String(subtotal       || "0"),
      vatAmount:      String(vatAmount      || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount:    String(totalAmount    || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      notes: notes || null,
      updatedAt: new Date(),
      taxId: taxId ? Number(taxId) : null,
    }).where(and(eq(goodsDeliveriesTable.id, id), eq(goodsDeliveriesTable.companyId, cid))).returning();

    if (lines !== undefined) {
      await db.delete(goodsDeliveryLinesTable).where(eq(goodsDeliveryLinesTable.deliveryId, id));
      if (lines.length) {
        const resolvedRate = await resolveTaxRate(cid, taxId ? Number(taxId) : null);
        await db.insert(goodsDeliveryLinesTable).values(
          lines.map((l: any) => ({
            deliveryId: id, companyId: cid,
            itemId: l.itemId ? Number(l.itemId) : null,
            itemName: l.itemName, itemCode: l.itemCode || null,
            unit: l.unit || null,
            unitId: l.unitId ? Number(l.unitId) : null,
            conversionFactor: String(l.conversionFactor || "1"),
            warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
            qty: String(l.qty || "1"),
            unitPrice: String(l.unitPrice || "0"),
            discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
            vatRate: String(l.vatRate || resolvedRate),
            lineTotal: String(l.lineTotal || "0"),
            notes: l.notes || null,
          }))
        );
      }
    }
    res.json(gd);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [gd] = await db.select().from(goodsDeliveriesTable)
      .where(and(eq(goodsDeliveriesTable.id, id), eq(goodsDeliveriesTable.companyId, cid)));
    if (!gd) { res.status(404).json({ error: "إذن التسليم غير موجود" }); return; }
    if (gd.status !== "draft") {
      res.status(400).json({ error: "لا يمكن حذف إذن تسليم مرحَّل. قم بفك الترحيل أولاً." });
      return;
    }
    await db.delete(goodsDeliveriesTable).where(and(
      eq(goodsDeliveriesTable.id, id), eq(goodsDeliveriesTable.companyId, cid),
    ));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// POST (ترحيل) — DECREASE stock + create JE
// Dr Delivery Clearing / Cr Inventory (per warehouse)
// ═══════════════════════════════════════════════
router.patch("/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [gd] = await db.select().from(goodsDeliveriesTable)
      .where(and(eq(goodsDeliveriesTable.id, id), eq(goodsDeliveriesTable.companyId, cid)));
    if (!gd) { res.status(404).json({ error: "إذن التسليم غير موجود" }); return; }
    if (gd.status !== "draft") { res.status(400).json({ error: "إذن التسليم مرحَّل مسبقاً" }); return; }

    const lines = await db.select().from(goodsDeliveryLinesTable)
      .where(eq(goodsDeliveryLinesTable.deliveryId, id));
    if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف في إذن التسليم" }); return; }

    // ── PHASE 1: Pre-validate everything BEFORE any mutation ───────────────
    const noWh = lines.filter(l => l.itemId && !l.warehouseId);
    if (noWh.length) {
      res.status(400).json({ error: `لا يمكن الترحيل: الأصناف التالية بدون مخزن محدد — ${noWh.map(l => l.itemName).join("، ")}` });
      return;
    }
    const noItem = lines.filter(l => !l.itemId);
    if (noItem.length) {
      res.status(400).json({ error: `لا يمكن الترحيل: الأصناف التالية غير مرتبطة بصنف من المخزون — ${noItem.map(l => l.itemName).join("، ")}` });
      return;
    }

    const whInfo = await loadWarehouseInfo(cid, lines.map(l => l.warehouseId).filter(Boolean) as number[]);

    // Cost basis is the WAREHOUSE's avgCost at posting time, NOT the line
    // unitPrice (which is the SALE price, not the cost). The credit to
    // Inventory and the debit to Delivery Clearing both equal qty × avgCost.
    type LineComputed = { itemId: number; warehouseId: number; qtyBase: number; costUnit: number; costTotal: number; notes: string | null };
    const computed: LineComputed[] = [];
    const costByWh: Record<number, number> = {};
    const insufficient: string[] = [];
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const factor   = Number(line.conversionFactor || "1") || 1;
      const qtyBase  = Number(line.qty) * factor;

      const [bal] = await db.select().from(stockBalanceTable).where(and(
        eq(stockBalanceTable.companyId, cid),
        eq(stockBalanceTable.itemId, line.itemId),
        eq(stockBalanceTable.warehouseId, line.warehouseId),
      ));
      const onHand = Number(bal?.qty ?? 0);
      const costUnit = Number(bal?.avgCost ?? 0);
      const allowNeg = !!whInfo[line.warehouseId]?.allowNegative;
      if (!allowNeg && qtyBase > onHand) {
        insufficient.push(`${line.itemName} (المتاح ${onHand}، المطلوب ${qtyBase})`);
      }
      const costTotal = qtyBase * costUnit;
      costByWh[line.warehouseId] = (costByWh[line.warehouseId] ?? 0) + costTotal;
      computed.push({
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        qtyBase,
        costUnit,
        costTotal,
        notes: line.notes ?? null,
      });
    }
    if (insufficient.length) {
      res.status(400).json({ error: `لا يمكن الترحيل — رصيد غير كافٍ: ${insufficient.join("، ")}` });
      return;
    }

    const clearingAccId = await getDeliveryClearingAccountId(cid);
    if (!clearingAccId) {
      res.status(400).json({ error: "حساب وسيط التسليم (1110/11101) غير موجود — يرجى استيراد دليل الحسابات الافتراضي أولاً" });
      return;
    }

    let fallbackInvAcc: number | null = null;
    const whAccount: Record<number, number> = {};
    const missingWh: string[] = [];
    for (const [widStr, amt] of Object.entries(costByWh)) {
      if (amt <= 0) continue;
      const wid = Number(widStr);
      let acc = whInfo[wid]?.accountId ?? null;
      if (!acc) {
        if (fallbackInvAcc === null) fallbackInvAcc = await findFallbackInventoryAccountId(cid);
        acc = fallbackInvAcc;
      }
      if (!acc) { missingWh.push(whInfo[wid]?.nameAr ?? String(wid)); continue; }
      whAccount[wid] = acc;
    }
    if (missingWh.length) {
      res.status(400).json({ error: `يجب تحديد حساب المخزون للمخازن التالية قبل الترحيل: ${missingWh.join("، ")}` });
      return;
    }

    const totalCost = Object.values(costByWh).reduce((s, v) => s + v, 0);
    const description = `قيد إذن تسليم رقم ${gd.docNumber || gd.id}`;
    const jeLines: JLine[] = [
      { accountId: clearingAccId, debit: totalCost, description: "وسيط تسليم البضاعة" },
      ...Object.entries(costByWh)
        .filter(([, amt]) => amt > 0)
        .map(([widStr, amt]) => {
          const wid = Number(widStr);
          return {
            accountId: whAccount[wid]!,
            credit: amt,
            description: `تسليم بضاعة — ${whInfo[wid]?.nameAr ?? "مخزن"}`,
          };
        }),
    ];
    const cleanJeLines = jeLines.filter(l => l.accountId && ((l.debit ?? 0) > 0 || (l.credit ?? 0) > 0));
    if (cleanJeLines.length < 2) {
      // Zero-cost edge case (e.g. all items have avgCost=0): skip the JE
      // but still allow stock posting. We mirror this gracefully by
      // posting without an entry rather than blocking the user.
    }
    const tDr = cleanJeLines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const tCr = cleanJeLines.reduce((s, l) => s + (l.credit ?? 0), 0);
    if (cleanJeLines.length >= 2 && Math.abs(tDr - tCr) > 0.01) {
      res.status(400).json({ error: `القيد غير متوازن: مدين ${tDr.toFixed(2)} ≠ دائن ${tCr.toFixed(2)}` });
      return;
    }

    // ── PHASE 2: Apply all mutations atomically in a single DB transaction ──
    const updated = await db.transaction(async (tx) => {
      const claimed = await tx.update(goodsDeliveriesTable)
        .set({
          status: "posted",
          postedById: (req as any).authUser?.id ?? null,
          postedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(goodsDeliveriesTable.id, id),
          eq(goodsDeliveriesTable.companyId, cid),
          eq(goodsDeliveriesTable.status, "draft"),
        ))
        .returning({ id: goodsDeliveriesTable.id });
      if (!claimed.length) {
        throw new Error("إذن التسليم تم ترحيله بواسطة عملية أخرى");
      }

      // 2a. Move stock (balance + ledger). Quantities go DOWN.
      for (const c of computed) {
        const [existing] = await tx.select().from(stockBalanceTable).where(and(
          eq(stockBalanceTable.companyId, cid),
          eq(stockBalanceTable.itemId, c.itemId),
          eq(stockBalanceTable.warehouseId, c.warehouseId),
        ));
        let newBal: number;
        if (!existing) {
          // No balance row: only possible when allowNegative was true.
          newBal = -c.qtyBase;
          await tx.insert(stockBalanceTable).values({
            companyId: cid, itemId: c.itemId, warehouseId: c.warehouseId,
            qty: String(newBal),
            avgCost: String(c.costUnit),
          });
        } else {
          newBal = Number(existing.qty) - c.qtyBase;
          // avgCost unchanged on issue (weighted avg only moves on receipt).
          await tx.update(stockBalanceTable)
            .set({ qty: String(newBal), updatedAt: new Date() })
            .where(eq(stockBalanceTable.id, existing.id));
        }
        await tx.insert(stockLedgerTable).values({
          companyId:   cid,
          itemId:      c.itemId,
          warehouseId: c.warehouseId,
          txDate:      gd.deliveryDate,
          txType:      "goods_delivery",
          qty:         String(-c.qtyBase),
          costPrice:   String(c.costUnit.toFixed(4)),
          totalCost:   String(c.costTotal.toFixed(2)),
          balanceQty:  String(newBal),
          refId:       id,
          refType:     "goods_delivery",
          notes:       c.notes ?? undefined,
        });
      }

      // 2b. Insert journal entry + lines inside the same tx (only if cost > 0).
      let entryId: number | null = null;
      if (cleanJeLines.length >= 2 && totalCost > 0) {
        // Period guard: block GD posting into a closed fiscal period.
        const writability = await assertWritableForDate(cid, gd.deliveryDate);
        if (!writability.ok) {
          const err: any = new Error(writability.reason);
          err.status = 423;
          throw err;
        }
        const gdStatus = await resolvePostingStatus(cid, "goodsDelivery");
        // JE draws its own continuous "journal_entry" number; the GD number
        // stays in the description + source link. Falls back to the GD number.
        const jeDocNumber = (await nextSequenceNumber(cid, "journal_entry", {
          userId: (req as any).authUser?.id ?? null, refTable: "journal_entries",
          branchId: gd.branchId ?? null, docDate: gd.deliveryDate as any,
        })) ?? (gd.docNumber ?? null);
        const [entry] = await tx.insert(journalEntriesTable).values({
          companyId:    cid,
          branchId:     gd.branchId ?? null,
          docNumber:    jeDocNumber,
          entryDate:    gd.deliveryDate,
          currency:     "SAR",
          exchangeRate: gd.exchangeRate ?? "1",
          description,
          entryType:    "goods_delivery",
          status:       gdStatus,
          periodId:     writability.period?.id ?? null,
          ...fullAuditFor(req, gdStatus),
        }).returning();
        entryId = entry.id;
        await tx.insert(journalEntryLinesTable).values(
          cleanJeLines.map((l, i) => ({
            entryId:     entry.id,
            accountId:   l.accountId!,
            debit:       String((l.debit  ?? 0).toFixed(2)),
            credit:      String((l.credit ?? 0).toFixed(2)),
            description: l.description ?? description,
            sortOrder:   i,
          }))
        );
      }

      const [row] = await tx.update(goodsDeliveriesTable)
        .set({
          status: "posted",
          journalEntryId: entryId,
          deliveryClearingAccountId: clearingAccId,
          updatedAt: new Date(),
        })
        .where(eq(goodsDeliveriesTable.id, id))
        .returning();
      return row;
    });

    res.json(updated);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "goods-deliveries: post failed");
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
// UNPOST (فك الترحيل) — only when not yet invoiced
// ═══════════════════════════════════════════════
router.patch("/:id/unpost", requireAdminRole, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [gd] = await db.select().from(goodsDeliveriesTable)
      .where(and(eq(goodsDeliveriesTable.id, id), eq(goodsDeliveriesTable.companyId, cid)));
    if (!gd) { res.status(404).json({ error: "إذن التسليم غير موجود" }); return; }
    if (gd.status !== "posted") {
      res.status(400).json({ error: gd.status === "invoiced" ? "لا يمكن فك ترحيل إذن تسليم مرتبط بفاتورة. احذف الفاتورة أولاً." : "إذن التسليم ليس مرحَّلاً" });
      return;
    }
    if (gd.linkedInvoiceId) {
      res.status(400).json({ error: "لا يمكن فك ترحيل إذن تسليم مرتبط بفاتورة. احذف الفاتورة أولاً." });
      return;
    }

    const updated = await db.transaction(async (tx) => {
      const claimed = await tx.update(goodsDeliveriesTable)
        .set({ status: "draft", journalEntryId: null, postedById: null, postedAt: null, updatedAt: new Date() })
        .where(and(
          eq(goodsDeliveriesTable.id, id),
          eq(goodsDeliveriesTable.companyId, cid),
          eq(goodsDeliveriesTable.status, "posted"),
          sql`${goodsDeliveriesTable.linkedInvoiceId} IS NULL`,
        ))
        .returning();
      if (!claimed.length) {
        throw new Error("تم تغيير حالة إذن التسليم بواسطة عملية أخرى");
      }

      // Reverse stock ledger: ledger qty was negative, so adding it back
      // gives qty = oldQty + (-negQty) = oldQty + positiveQty (restock).
      const ledger = await tx.select().from(stockLedgerTable)
        .where(and(
          eq(stockLedgerTable.companyId, cid),
          eq(stockLedgerTable.refType, "goods_delivery"),
          eq(stockLedgerTable.refId, id),
        ));
      for (const row of ledger) {
        const qty = Number(row.qty); // negative
        const [bal] = await tx.select().from(stockBalanceTable)
          .where(and(
            eq(stockBalanceTable.companyId, cid),
            eq(stockBalanceTable.itemId, row.itemId),
            eq(stockBalanceTable.warehouseId, row.warehouseId),
          ));
        if (bal) {
          // Subtracting a negative ledger qty is the inverse of the post.
          await tx.update(stockBalanceTable)
            .set({ qty: String(Number(bal.qty) - qty), updatedAt: new Date() })
            .where(eq(stockBalanceTable.id, bal.id));
        }
      }
      await tx.delete(stockLedgerTable)
        .where(and(
          eq(stockLedgerTable.companyId, cid),
          eq(stockLedgerTable.refType, "goods_delivery"),
          eq(stockLedgerTable.refId, id),
        ));

      if (gd.journalEntryId) {
        await tx.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, gd.journalEntryId));
        await tx.delete(journalEntriesTable).where(and(
          eq(journalEntriesTable.id, gd.journalEntryId),
          eq(journalEntriesTable.companyId, cid),
        ));
      }

      return claimed[0];
    });

    res.json(updated);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "goods-deliveries: unpost failed");
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
// CONVERT TO SALES INVOICE (إنشاء فاتورة)
// Clones GDN lines into a new draft sales_invoice with sourceGdnId.
// ═══════════════════════════════════════════════
router.post("/:id/convert-to-invoice", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [gd] = await db.select().from(goodsDeliveriesTable)
      .where(and(eq(goodsDeliveriesTable.id, id), eq(goodsDeliveriesTable.companyId, cid)));
    if (!gd) { res.status(404).json({ error: "إذن التسليم غير موجود" }); return; }
    if (gd.status !== "posted") {
      res.status(400).json({ error: "يجب ترحيل إذن التسليم أولاً قبل تحويله إلى فاتورة" });
      return;
    }
    if (gd.linkedInvoiceId) {
      res.status(400).json({ error: "تم بالفعل إنشاء فاتورة مرتبطة بإذن التسليم هذا" });
      return;
    }

    const { paymentType, customerId, cashBoxId, bankAccountId } = (req.body || {}) as any;
    const pType = paymentType || "credit";
    const finalCustomerId = customerId ? Number(customerId) : (gd.customerId ?? null);
    if (pType === "credit" && !finalCustomerId) {
      res.status(400).json({ error: "يجب تحديد العميل للفاتورة الآجلة" });
      return;
    }
    if (pType === "cash" && !cashBoxId) {
      res.status(400).json({ error: "يجب اختيار الخزنة عند الدفع نقداً" }); return;
    }
    if (pType === "bank" && !bankAccountId) {
      res.status(400).json({ error: "يجب اختيار الحساب البنكي عند الدفع بنكياً" }); return;
    }

    const tenantErr = await validateGdnTenantRefs(cid, {
      customerId:    finalCustomerId,
      cashBoxId:     pType === "cash" && cashBoxId     ? Number(cashBoxId)     : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
    });
    if (tenantErr) { res.status(400).json({ error: tenantErr }); return; }

    const lines = await db.select().from(goodsDeliveryLinesTable)
      .where(eq(goodsDeliveryLinesTable.deliveryId, id));

    // Foreign-customer numbering: a non-SA buyer draws from the separate
    // "sales_invoice_foreign" series (when configured). paymentType is passed as
    // null here so this conversion path keeps base numbering (no payment split,
    // preserving prior behaviour) and only adds the foreign-first resolution.
    let buyerIsForeign = false;
    if (finalCustomerId) {
      const [cc] = await db.select({ country: customersTable.country })
        .from(customersTable)
        .where(and(eq(customersTable.id, finalCustomerId), eq(customersTable.companyId, cid)));
      buyerIsForeign = !!cc && String(cc.country ?? "SA").toUpperCase() !== "SA";
    }
    let resolvedDocNumber: string | null = null;
    try {
      resolvedDocNumber = await nextSequenceForPayment(cid, "sales_invoice", null, {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "sales_invoices",
        branchId: gd.branchId ?? null,
      }, buyerIsForeign);
    } catch { resolvedDocNumber = null; }

    const inv = await db.transaction(async (tx) => {
      const claimed = await tx.update(goodsDeliveriesTable)
        .set({ status: "invoiced", updatedAt: new Date() })
        .where(and(
          eq(goodsDeliveriesTable.id, id),
          eq(goodsDeliveriesTable.companyId, cid),
          eq(goodsDeliveriesTable.status, "posted"),
          sql`${goodsDeliveriesTable.linkedInvoiceId} IS NULL`,
        ))
        .returning({ id: goodsDeliveriesTable.id });
      if (!claimed.length) {
        throw new Error("تم تحويل إذن التسليم بواسطة عملية أخرى");
      }

      const [created] = await tx.insert(salesInvoicesTable).values({
        companyId: cid,
        branchId: gd.branchId,
        docNumber: resolvedDocNumber,
        invoiceDate: gd.deliveryDate,
        customerId: finalCustomerId,
        paymentType: pType,
        cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
        bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
        currencyCode: gd.currencyCode,
        exchangeRate: gd.exchangeRate,
        subtotal: gd.subtotal,
        vatAmount: gd.vatAmount,
        discountAmount: gd.discountAmount,
        totalAmount: gd.totalAmount,
        priceIncludesVat: gd.priceIncludesVat,
        status: "draft",
        sourceGdnId: id,
        notes: `فاتورة من إذن تسليم رقم ${gd.docNumber || gd.id}`,
        createdById: (req as any).authUser?.id ?? null,
        taxId: (gd as any).taxId ?? null,
      } as any).returning();

      if (lines.length) {
        await tx.insert(salesInvoiceLinesTable).values(
          lines.map((l) => ({
            invoiceId: created.id, companyId: cid,
            itemId: l.itemId,
            itemName: l.itemName, itemCode: l.itemCode,
            unit: l.unit,
            unitId: l.unitId,
            conversionFactor: String(l.conversionFactor || "1"),
            qty: String(l.qty),
            unitPrice: String(l.unitPrice),
            discount: String(l.discount || "0"),
            vatRate: String(l.vatRate || "15"),
            lineTotal: String(l.lineTotal || "0"),
            warehouseId: l.warehouseId,
            notes: l.notes,
          }))
        );
      }

      await tx.update(goodsDeliveriesTable)
        .set({ linkedInvoiceId: created.id })
        .where(eq(goodsDeliveriesTable.id, id));

      return created;
    });

    res.status(201).json(inv);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "goods-deliveries: convert-to-invoice failed");
    res.status(500).json({ error: e.message });
  }
});

export default router;
// Used by sales.ts to look up the clearing account for invoices linked
// to a GDN (sourceGdnId) without duplicating the lookup/auto-provision logic.
export { getDeliveryClearingAccountId };
