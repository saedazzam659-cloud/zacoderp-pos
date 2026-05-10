import { Router } from "express";
import { db } from "@workspace/db";
import {
  goodsReceiptsTable, goodsReceiptLinesTable,
  purchaseInvoicesTable, purchaseInvoiceLinesTable,
  suppliersTable, accountsTable, warehousesTable,
  journalEntriesTable, journalEntryLinesTable,
  stockBalanceTable, stockLedgerTable,
  itemsTable, branchesTable, cashBoxesTable, bankAccountsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
import { pathRbac, requireAdminRole } from "../middleware/permissions.js";
import { loadMappings } from "../lib/accountingMappings.js";
import { nextSequenceNumber } from "../lib/sequences.js";
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

// ─── Receiving Clearing account auto-provision ───────────────────────────
// For legacy tenants whose COA was bulk-imported BEFORE the 1109 / 11091
// codes were added to defaultChartOfAccounts.ts, materialize the two
// accounts on the fly so the GRN flow never fails with "account missing"
// on a tenant who simply never re-imported. Also wires the mapping row.
async function getReceivingClearingAccountId(cid: number): Promise<number | null> {
  // 1. Prefer the per-tenant accounting mapping (operator-overridable).
  const map = await loadMappings(cid, "goods_receipt");
  const mapped = map("goods_receipt", "receiving_clearing");
  if (mapped) return mapped;

  // 2. Try by COA code 11091 (posting child). The accounts table has no
  // unique index on (company_id, code), so under concurrent first-time
  // requests two rows could race in. We mitigate by always re-reading
  // post-insert and ALWAYS returning the lowest-id row, so every caller
  // converges on the same account id.
  const findPosting = async () => {
    const rows = await db.select().from(accountsTable).where(and(
      eq(accountsTable.companyId, cid),
      eq(accountsTable.code, "11091"),
    )).orderBy(asc(accountsTable.id));
    return rows[0];
  };
  const findParent = async () => {
    const rows = await db.select().from(accountsTable).where(and(
      eq(accountsTable.companyId, cid),
      eq(accountsTable.code, "1109"),
    )).orderBy(asc(accountsTable.id));
    return rows[0];
  };

  let posting = await findPosting();
  if (posting) return posting.id;

  // 3. Auto-provision: ensure parent 1109 exists, then the posting child.
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
        code: "1109",
        nameAr: "وسيط استلام البضاعة",
        nameEn: "Goods Receiving Clearing",
        accountType: "asset",
        reportDirection: "balance_sheet",
        level: 3,
        isPosting: false,
        isActive: true,
      }).returning();
    } catch {
      // Race: another request just inserted it; re-read.
      parent = await findParent();
    }
    if (!parent) return null;
  }
  try {
    [posting] = await db.insert(accountsTable).values({
      companyId: cid,
      parentId: parent.id,
      code: "11091",
      nameAr: "وسيط الاستلام",
      nameEn: "Receiving Clearing",
      accountType: "asset",
      reportDirection: "balance_sheet",
      level: 4,
      isPosting: true,
      isActive: true,
    }).returning();
  } catch {
    posting = await findPosting();
  }
  // Always converge on the lowest-id row so concurrent first-time creators
  // don't end up booking against different account ids.
  return (await findPosting())?.id ?? posting?.id ?? null;
}

// ─── Tenant ownership validation ────────────────────────────────────────
// Verifies every id in `ids` exists AND belongs to `cid`. Returns the
// ids that DON'T (so callers can build a friendly error or 400 out).
async function findStrayIds(table: any, cid: number, ids: number[]): Promise<number[]> {
  const uniq = Array.from(new Set(ids.filter((x): x is number => typeof x === "number" && Number.isFinite(x))));
  if (!uniq.length) return [];
  const rows = await db.select({ id: table.id }).from(table)
    .where(and(inArray(table.id, uniq), eq(table.companyId, cid)));
  const found = new Set(rows.map((r: any) => r.id));
  return uniq.filter(id => !found.has(id));
}

// One-shot tenant validator for GRN create/update/convert payloads.
// Returns null on success, or an error message string on the first violation.
async function validateGrnTenantRefs(cid: number, payload: {
  branchId?: number | null; supplierId?: number | null;
  cashBoxId?: number | null; bankAccountId?: number | null;
  itemIds?: number[]; warehouseIds?: number[];
}): Promise<string | null> {
  if (payload.branchId) {
    const stray = await findStrayIds(branchesTable, cid, [payload.branchId]);
    if (stray.length) return "الفرع المحدد لا ينتمي لهذه الشركة";
  }
  if (payload.supplierId) {
    const stray = await findStrayIds(suppliersTable, cid, [payload.supplierId]);
    if (stray.length) return "المورد المحدد لا ينتمي لهذه الشركة";
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
    // Validate: warehouse.account_id may point at a stale/cross-tenant id.
    if (acctId) {
      const [a] = await db.select({ id: accountsTable.id }).from(accountsTable)
        .where(and(eq(accountsTable.id, acctId), eq(accountsTable.companyId, cid)));
      if (!a) acctId = null;
    }
    out[wid] = { accountId: acctId, allowNegative: !!w?.allowNegative, nameAr: w?.nameAr ?? null };
  }
  return out;
}

// Fallback when a warehouse has no `account_id` set (or it's stale): pick
// any posting account inside the company's inventory subtree. We accept
// either the canonical "1105" code from defaultChartOfAccounts.ts (المخزون)
// OR a "114x" code (legacy seeders that bucket inventory by warehouse) OR
// any posting account whose Arabic name contains "مخزون".
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
    const rows = await db.select().from(goodsReceiptsTable)
      .where(and(
        eq(goodsReceiptsTable.companyId, cid),
        ...branchScopeSpread(req, goodsReceiptsTable.branchId, req.query.branchId),
      ))
      .orderBy(desc(goodsReceiptsTable.receiptDate), desc(goodsReceiptsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [gr] = await db.select().from(goodsReceiptsTable)
      .where(and(eq(goodsReceiptsTable.id, id), eq(goodsReceiptsTable.companyId, cid)));
    if (!gr) { res.status(404).json({ error: "إذن الاستلام غير موجود" }); return; }
    const lines = await db.select().from(goodsReceiptLinesTable)
      .where(eq(goodsReceiptLinesTable.receiptId, id))
      .orderBy(asc(goodsReceiptLinesTable.id));
    res.json({ ...gr, lines });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// CREATE / UPDATE / DELETE (draft only)
// ═══════════════════════════════════════════════
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const {
      docNumber, supplierInvoiceNumber, receiptDate, supplierId, branchId,
      currencyCode, exchangeRate, subtotal, vatAmount, discountAmount,
      totalAmount, priceIncludesVat, notes, lines,
    } = req.body;
    if (!receiptDate) { res.status(400).json({ error: "تاريخ الاستلام مطلوب" }); return; }

    const tenantErr = await validateGrnTenantRefs(cid, {
      branchId:   branchId   ? Number(branchId)   : null,
      supplierId: supplierId ? Number(supplierId) : null,
      itemIds:      (lines ?? []).map((l: any) => l.itemId      ? Number(l.itemId)      : null).filter((x: any): x is number => !!x),
      warehouseIds: (lines ?? []).map((l: any) => l.warehouseId ? Number(l.warehouseId) : null).filter((x: any): x is number => !!x),
    });
    if (tenantErr) { res.status(400).json({ error: tenantErr }); return; }

    let resolvedDocNumber: string | null = (docNumber && String(docNumber).trim()) || null;
    if (!resolvedDocNumber) {
      try {
        resolvedDocNumber = await nextSequenceNumber(cid, "goods_receipt", {
          userId:   (req as any).authUser?.id ?? null,
          refTable: "goods_receipts",
          branchId: branchId ? Number(branchId) : null,
        });
      } catch {
        // No sequence configured for goods_receipt — fall back to GRN-<id>
        // via the post-insert default in the UI; keep null here so the UI
        // can render the placeholder.
        resolvedDocNumber = null;
      }
    }

    const [gr] = await db.insert(goodsReceiptsTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: resolvedDocNumber,
      supplierInvoiceNumber: supplierInvoiceNumber || null,
      receiptDate,
      supplierId: supplierId ? Number(supplierId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal:       String(subtotal       || "0"),
      vatAmount:      String(vatAmount      || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount:    String(totalAmount    || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      status: "draft",
      notes: notes || null,
    }).returning();

    if (lines?.length) {
      await db.insert(goodsReceiptLinesTable).values(
        lines.map((l: any) => ({
          receiptId: gr.id, companyId: cid,
          itemId: l.itemId ? Number(l.itemId) : null,
          itemName: l.itemName, itemCode: l.itemCode || null,
          unit: l.unit || null,
          unitId: l.unitId ? Number(l.unitId) : null,
          conversionFactor: String(l.conversionFactor || "1"),
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
          qty: String(l.qty || "1"),
          unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
          vatRate: String(l.vatRate || "15"),
          lineTotal: String(l.lineTotal || "0"),
          notes: l.notes || null,
        }))
      );
    }
    res.status(201).json(gr);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [existing] = await db.select().from(goodsReceiptsTable)
      .where(and(eq(goodsReceiptsTable.id, id), eq(goodsReceiptsTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "إذن الاستلام غير موجود" }); return; }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "لا يمكن تعديل إذن استلام بعد الترحيل" });
      return;
    }
    const {
      supplierInvoiceNumber, receiptDate, supplierId, branchId,
      currencyCode, exchangeRate, subtotal, vatAmount, discountAmount,
      totalAmount, priceIncludesVat, notes, lines,
    } = req.body;

    const tenantErr = await validateGrnTenantRefs(cid, {
      branchId:   branchId   ? Number(branchId)   : null,
      supplierId: supplierId ? Number(supplierId) : null,
      itemIds:      (lines ?? []).map((l: any) => l.itemId      ? Number(l.itemId)      : null).filter((x: any): x is number => !!x),
      warehouseIds: (lines ?? []).map((l: any) => l.warehouseId ? Number(l.warehouseId) : null).filter((x: any): x is number => !!x),
    });
    if (tenantErr) { res.status(400).json({ error: tenantErr }); return; }

    const [gr] = await db.update(goodsReceiptsTable).set({
      branchId: branchId ? Number(branchId) : null,
      supplierInvoiceNumber: supplierInvoiceNumber || null,
      receiptDate,
      supplierId: supplierId ? Number(supplierId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal:       String(subtotal       || "0"),
      vatAmount:      String(vatAmount      || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount:    String(totalAmount    || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      notes: notes || null,
      updatedAt: new Date(),
    }).where(and(eq(goodsReceiptsTable.id, id), eq(goodsReceiptsTable.companyId, cid))).returning();

    if (lines !== undefined) {
      await db.delete(goodsReceiptLinesTable).where(eq(goodsReceiptLinesTable.receiptId, id));
      if (lines.length) {
        await db.insert(goodsReceiptLinesTable).values(
          lines.map((l: any) => ({
            receiptId: id, companyId: cid,
            itemId: l.itemId ? Number(l.itemId) : null,
            itemName: l.itemName, itemCode: l.itemCode || null,
            unit: l.unit || null,
            unitId: l.unitId ? Number(l.unitId) : null,
            conversionFactor: String(l.conversionFactor || "1"),
            warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
            qty: String(l.qty || "1"),
            unitPrice: String(l.unitPrice || "0"),
            discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
            vatRate: String(l.vatRate || "15"),
            lineTotal: String(l.lineTotal || "0"),
            notes: l.notes || null,
          }))
        );
      }
    }
    res.json(gr);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [gr] = await db.select().from(goodsReceiptsTable)
      .where(and(eq(goodsReceiptsTable.id, id), eq(goodsReceiptsTable.companyId, cid)));
    if (!gr) { res.status(404).json({ error: "إذن الاستلام غير موجود" }); return; }
    if (gr.status !== "draft") {
      res.status(400).json({ error: "لا يمكن حذف إذن استلام مرحَّل. قم بفك الترحيل أولاً." });
      return;
    }
    await db.delete(goodsReceiptsTable).where(and(
      eq(goodsReceiptsTable.id, id), eq(goodsReceiptsTable.companyId, cid),
    ));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// POST (ترحيل) — increase stock + create JE
// Dr Inventory (per warehouse) / Cr Receiving Clearing
// ═══════════════════════════════════════════════
router.patch("/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [gr] = await db.select().from(goodsReceiptsTable)
      .where(and(eq(goodsReceiptsTable.id, id), eq(goodsReceiptsTable.companyId, cid)));
    if (!gr) { res.status(404).json({ error: "إذن الاستلام غير موجود" }); return; }
    if (gr.status !== "draft") { res.status(400).json({ error: "إذن الاستلام مرحَّل مسبقاً" }); return; }

    const lines = await db.select().from(goodsReceiptLinesTable)
      .where(eq(goodsReceiptLinesTable.receiptId, id));
    if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف في إذن الاستلام" }); return; }

    // ── PHASE 1: Pre-validate everything BEFORE any mutation ───────────────
    // (Atomicity guard: don't move stock until we know JE will succeed.)
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

    // Goods cost per warehouse (excluding VAT). Receiving Clearing is
    // credited for the same total (no VAT, no discount loading at GRN
    // stage — those land on the linked purchase invoice).
    type LineComputed = { itemId: number; warehouseId: number; qtyBase: number; costUnit: number; goodsNet: number; notes: string | null };
    const computed: LineComputed[] = [];
    const goodsByWh: Record<number, number> = {};
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const factor   = Number(line.conversionFactor || "1") || 1;
      const qtyBase  = Number(line.qty) * factor;
      const unitPrice = Number(line.unitPrice);
      const discPct = Number(line.discount || 0) / 100;
      const lineGross = Number(line.qty) * unitPrice * (1 - discPct);
      // If the operator entered prices INCLUDING VAT, strip the VAT out
      // so Inventory is debited at the net cost only — VAT input lives
      // on the purchase invoice JE, not the GRN.
      const vatRate = Number(line.vatRate || 0) / 100;
      const goodsNet = gr.priceIncludesVat && vatRate > -1 ? lineGross / (1 + vatRate) : lineGross;
      const costUnit = qtyBase > 0 ? goodsNet / qtyBase : unitPrice / factor;

      goodsByWh[line.warehouseId] = (goodsByWh[line.warehouseId] ?? 0) + goodsNet;
      computed.push({
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        qtyBase,
        costUnit,
        goodsNet,
        notes: line.notes ?? null,
      });
    }

    // Resolve clearing account (may auto-provision; idempotent + race-safe).
    const clearingAccId = await getReceivingClearingAccountId(cid);
    if (!clearingAccId) {
      res.status(400).json({ error: "حساب وسيط الاستلام (1109/11091) غير موجود — يرجى استيراد دليل الحسابات الافتراضي أولاً" });
      return;
    }

    // Resolve a debit (inventory) account per warehouse: prefer the one
    // configured on the warehouse, else fall back to the company's default
    // inventory account so legacy/unmapped warehouses don't block posting.
    let fallbackInvAcc: number | null = null;
    const whAccount: Record<number, number> = {};
    const missingWh: string[] = [];
    for (const [widStr, amt] of Object.entries(goodsByWh)) {
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
      res.status(400).json({ error: `يجب تحديد حساب المخزون للمخازن التالية قبل الترحيل (ولا يوجد حساب مخزون افتراضي في دليل الحسابات): ${missingWh.join("، ")}` });
      return;
    }

    // Pre-compute the JE so any "unbalanced" or "missing accountId" failure
    // surfaces BEFORE we touch stock.
    const totalGoods = Object.values(goodsByWh).reduce((s, v) => s + v, 0);
    const description = `قيد إذن استلام رقم ${gr.docNumber || gr.id}`;
    const jeLines: JLine[] = [
      ...Object.entries(goodsByWh)
        .filter(([, amt]) => amt > 0)
        .map(([widStr, amt]) => {
          const wid = Number(widStr);
          return {
            accountId: whAccount[wid]!,
            debit: amt,
            description: `استلام بضاعة — ${whInfo[wid]?.nameAr ?? "مخزن"}`,
          };
        }),
      { accountId: clearingAccId, credit: totalGoods, description: "وسيط استلام البضاعة" },
    ];
    const cleanJeLines = jeLines.filter(l => l.accountId && ((l.debit ?? 0) > 0 || (l.credit ?? 0) > 0));
    if (cleanJeLines.length < 2) {
      res.status(400).json({ error: "لا يمكن إنشاء قيد محاسبي بطرف واحد فقط" });
      return;
    }
    const tDr = cleanJeLines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const tCr = cleanJeLines.reduce((s, l) => s + (l.credit ?? 0), 0);
    if (Math.abs(tDr - tCr) > 0.01) {
      res.status(400).json({ error: `القيد غير متوازن: مدين ${tDr.toFixed(2)} ≠ دائن ${tCr.toFixed(2)}` });
      return;
    }

    // ── PHASE 2: Apply all mutations atomically in a single DB transaction ──
    const updated = await db.transaction(async (tx) => {
      // 2.0 Race-safe claim: only one concurrent /post can flip draft→posted.
      // If another request already posted, returning array is empty → throw,
      // which rolls back the whole tx (no stock or JE writes).
      const claimed = await tx.update(goodsReceiptsTable)
        .set({ status: "posted", updatedAt: new Date() })
        .where(and(
          eq(goodsReceiptsTable.id, id),
          eq(goodsReceiptsTable.companyId, cid),
          eq(goodsReceiptsTable.status, "draft"),
        ))
        .returning({ id: goodsReceiptsTable.id });
      if (!claimed.length) {
        throw new Error("إذن الاستلام تم ترحيله بواسطة عملية أخرى");
      }

      // 2a. Move stock (balance + ledger).
      for (const c of computed) {
        const [existing] = await tx.select().from(stockBalanceTable).where(and(
          eq(stockBalanceTable.companyId, cid),
          eq(stockBalanceTable.itemId, c.itemId),
          eq(stockBalanceTable.warehouseId, c.warehouseId),
        ));
        let newBal: number;
        if (!existing) {
          newBal = c.qtyBase;
          await tx.insert(stockBalanceTable).values({
            companyId: cid, itemId: c.itemId, warehouseId: c.warehouseId,
            qty: String(newBal),
            avgCost: String(c.costUnit),
          });
        } else {
          const oldQty  = Number(existing.qty);
          const oldCost = Number(existing.avgCost);
          newBal = oldQty + c.qtyBase;
          const newAvg = newBal === 0 ? c.costUnit : (oldQty * oldCost + c.qtyBase * c.costUnit) / newBal;
          await tx.update(stockBalanceTable)
            .set({ qty: String(newBal), avgCost: String(newAvg), updatedAt: new Date() })
            .where(eq(stockBalanceTable.id, existing.id));
        }
        await tx.insert(stockLedgerTable).values({
          companyId:   cid,
          itemId:      c.itemId,
          warehouseId: c.warehouseId,
          txDate:      gr.receiptDate,
          txType:      "goods_receipt",
          qty:         String(c.qtyBase),
          costPrice:   String(c.costUnit.toFixed(4)),
          totalCost:   String(c.goodsNet.toFixed(2)),
          balanceQty:  String(newBal),
          refId:       id,
          refType:     "goods_receipt",
          notes:       c.notes ?? undefined,
        });
      }

      // 2b. Insert journal entry + lines inside the same tx.
      // Period guard: block GRN posting into a closed fiscal period.
      const writability = await assertWritableForDate(cid, gr.receiptDate);
      if (!writability.ok) {
        const err: any = new Error(writability.reason);
        err.status = 423;
        throw err;
      }
      const [entry] = await tx.insert(journalEntriesTable).values({
        companyId:    cid,
        branchId:     gr.branchId ?? null,
        docNumber:    gr.docNumber ?? null,
        entryDate:    gr.receiptDate,
        currency:     "SAR",
        exchangeRate: gr.exchangeRate ?? "1",
        description,
        entryType:    "goods_receipt",
        status:       await resolvePostingStatus(cid, "goodsReceipt"),
        periodId:     writability.period?.id ?? null,
      }).returning();
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

      // 2c. Mark GRN as posted and link the JE.
      const [row] = await tx.update(goodsReceiptsTable)
        .set({
          status: "posted",
          journalEntryId: entry.id,
          receivingClearingAccountId: clearingAccId,
          updatedAt: new Date(),
        })
        .where(eq(goodsReceiptsTable.id, id))
        .returning();
      return row;
    });

    res.json(updated);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "goods-receipts: post failed");
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

    const [gr] = await db.select().from(goodsReceiptsTable)
      .where(and(eq(goodsReceiptsTable.id, id), eq(goodsReceiptsTable.companyId, cid)));
    if (!gr) { res.status(404).json({ error: "إذن الاستلام غير موجود" }); return; }
    if (gr.status !== "posted") {
      res.status(400).json({ error: gr.status === "invoiced" ? "لا يمكن فك ترحيل إذن استلام مرتبط بفاتورة. احذف الفاتورة أولاً." : "إذن الاستلام ليس مرحَّلاً" });
      return;
    }
    if (gr.linkedInvoiceId) {
      res.status(400).json({ error: "لا يمكن فك ترحيل إذن استلام مرتبط بفاتورة. احذف الفاتورة أولاً." });
      return;
    }

    // ── Atomic unpost: claim row first (race-safe), then reverse stock + JE ──
    const updated = await db.transaction(async (tx) => {
      // 1. Race-safe claim: only one concurrent /unpost can flip posted→draft
      // AND it must still be unlinked from any invoice.
      const claimed = await tx.update(goodsReceiptsTable)
        .set({ status: "draft", journalEntryId: null, updatedAt: new Date() })
        .where(and(
          eq(goodsReceiptsTable.id, id),
          eq(goodsReceiptsTable.companyId, cid),
          eq(goodsReceiptsTable.status, "posted"),
          sql`${goodsReceiptsTable.linkedInvoiceId} IS NULL`,
        ))
        .returning();
      if (!claimed.length) {
        throw new Error("تم تغيير حالة إذن الاستلام بواسطة عملية أخرى");
      }

      // 2. Reverse stock ledger (subtract balances).
      const ledger = await tx.select().from(stockLedgerTable)
        .where(and(
          eq(stockLedgerTable.companyId, cid),
          eq(stockLedgerTable.refType, "goods_receipt"),
          eq(stockLedgerTable.refId, id),
        ));
      for (const row of ledger) {
        const qty = Number(row.qty);
        const [bal] = await tx.select().from(stockBalanceTable)
          .where(and(
            eq(stockBalanceTable.companyId, cid),
            eq(stockBalanceTable.itemId, row.itemId),
            eq(stockBalanceTable.warehouseId, row.warehouseId),
          ));
        if (bal) {
          await tx.update(stockBalanceTable)
            .set({ qty: String(Number(bal.qty) - qty), updatedAt: new Date() })
            .where(eq(stockBalanceTable.id, bal.id));
        }
      }
      await tx.delete(stockLedgerTable)
        .where(and(
          eq(stockLedgerTable.companyId, cid),
          eq(stockLedgerTable.refType, "goods_receipt"),
          eq(stockLedgerTable.refId, id),
        ));

      // 3. Reverse JE.
      if (gr.journalEntryId) {
        await tx.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, gr.journalEntryId));
        await tx.delete(journalEntriesTable).where(and(
          eq(journalEntriesTable.id, gr.journalEntryId),
          eq(journalEntriesTable.companyId, cid),
        ));
      }

      return claimed[0];
    });

    res.json(updated);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "goods-receipts: unpost failed");
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
// CONVERT TO PURCHASE INVOICE (إنشاء فاتورة)
// Clones GRN lines into a new draft purchase_invoice with sourceGrnId.
// ═══════════════════════════════════════════════
router.post("/:id/convert-to-invoice", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [gr] = await db.select().from(goodsReceiptsTable)
      .where(and(eq(goodsReceiptsTable.id, id), eq(goodsReceiptsTable.companyId, cid)));
    if (!gr) { res.status(404).json({ error: "إذن الاستلام غير موجود" }); return; }
    if (gr.status !== "posted") {
      res.status(400).json({ error: "يجب ترحيل إذن الاستلام أولاً قبل تحويله إلى فاتورة" });
      return;
    }
    if (gr.linkedInvoiceId) {
      res.status(400).json({ error: "تم بالفعل إنشاء فاتورة مرتبطة بإذن الاستلام هذا" });
      return;
    }

    const { paymentType, supplierId, cashBoxId, bankAccountId } = (req.body || {}) as any;
    const pType = paymentType || "credit";
    const finalSupplierId = supplierId ? Number(supplierId) : (gr.supplierId ?? null);
    if (pType === "credit" && !finalSupplierId) {
      res.status(400).json({ error: "يجب تحديد المورد للفاتورة الآجلة" });
      return;
    }
    if (pType === "cash" && !cashBoxId) {
      res.status(400).json({ error: "يجب اختيار الخزنة عند الدفع نقداً" }); return;
    }
    if (pType === "bank" && !bankAccountId) {
      res.status(400).json({ error: "يجب اختيار الحساب البنكي عند الدفع بنكياً" }); return;
    }

    // Tenant ownership: supplier/cashbox/bank IDs from body must belong to cid.
    const tenantErr = await validateGrnTenantRefs(cid, {
      supplierId:    finalSupplierId,
      cashBoxId:     pType === "cash" && cashBoxId     ? Number(cashBoxId)     : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
    });
    if (tenantErr) { res.status(400).json({ error: tenantErr }); return; }

    const lines = await db.select().from(goodsReceiptLinesTable)
      .where(eq(goodsReceiptLinesTable.receiptId, id));

    let resolvedDocNumber: string | null = null;
    try {
      resolvedDocNumber = await nextSequenceNumber(cid, "purchase_invoice", {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "purchase_invoices",
        branchId: gr.branchId ?? null,
      });
    } catch { resolvedDocNumber = null; }

    // ── Atomic conversion: claim row first (race-safe), then create invoice ──
    // Without the claim, two concurrent /convert calls could both create
    // a draft PI and overwrite linked_invoice_id, leaving an orphan.
    const inv = await db.transaction(async (tx) => {
      const claimed = await tx.update(goodsReceiptsTable)
        .set({ status: "invoiced", updatedAt: new Date() })
        .where(and(
          eq(goodsReceiptsTable.id, id),
          eq(goodsReceiptsTable.companyId, cid),
          eq(goodsReceiptsTable.status, "posted"),
          sql`${goodsReceiptsTable.linkedInvoiceId} IS NULL`,
        ))
        .returning({ id: goodsReceiptsTable.id });
      if (!claimed.length) {
        throw new Error("تم تحويل إذن الاستلام بواسطة عملية أخرى");
      }

      const [created] = await tx.insert(purchaseInvoicesTable).values({
        companyId: cid,
        branchId: gr.branchId,
        docNumber: resolvedDocNumber,
        supplierInvoiceNumber: gr.supplierInvoiceNumber,
        invoiceDate: gr.receiptDate,
        supplierId: finalSupplierId,
        paymentType: pType,
        cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
        bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
        currencyCode: gr.currencyCode,
        exchangeRate: gr.exchangeRate,
        subtotal: gr.subtotal,
        vatAmount: gr.vatAmount,
        discountAmount: gr.discountAmount,
        totalAmount: gr.totalAmount,
        priceIncludesVat: gr.priceIncludesVat,
        status: "draft",
        sourceGrnId: id,
        notes: `فاتورة من إذن استلام رقم ${gr.docNumber || gr.id}`,
      } as any).returning();

      if (lines.length) {
        await tx.insert(purchaseInvoiceLinesTable).values(
          lines.map((l) => ({
            invoiceId: created.id, companyId: cid,
            itemId: l.itemId,
            itemName: l.itemName, itemCode: l.itemCode,
            unit: l.unit,
            unitId: l.unitId,
            conversionFactor: String(l.conversionFactor || "1"),
            qty: String(l.qty),
            weight: "0",
            unitPrice: String(l.unitPrice),
            discount: String(l.discount || "0"),
            vatRate: String(l.vatRate || "15"),
            lineTotal: String(l.lineTotal || "0"),
            expenseShare: "0",
            finalCost: "0",
            warehouseId: l.warehouseId,
            notes: l.notes,
          }))
        );
      }

      // Set linkedInvoiceId now that we have the new invoice id.
      await tx.update(goodsReceiptsTable)
        .set({ linkedInvoiceId: created.id })
        .where(eq(goodsReceiptsTable.id, id));

      return created;
    });

    res.status(201).json(inv);
  } catch (e: any) {
    req.log?.error?.({ err: e }, "goods-receipts: convert-to-invoice failed");
    res.status(500).json({ error: e.message });
  }
});

export default router;
// Used by purchasing.ts to look up the clearing account for invoices linked
// to a GRN (sourceGrnId) without duplicating the lookup/auto-provision logic.
export { getReceivingClearingAccountId };
