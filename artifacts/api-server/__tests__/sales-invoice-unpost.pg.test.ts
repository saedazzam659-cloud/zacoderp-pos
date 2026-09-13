import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { before, test } from "node:test";

import { and, eq } from "drizzle-orm";
import {
  companiesTable,
  db,
  itemsTable,
  salesInvoiceLinesTable,
  salesInvoicesTable,
  salesLineProductionCostAttributionsTable,
  stockBalanceTable,
  stockLedgerTable,
  unitsTable,
  warehousesTable,
} from "@workspace/db";

import {
  reverseSalesInvoiceStockForUnpost,
  writeSalesLineProductionAttributions,
} from "../src/routes/sales.ts";
import { ensureSchemaUpToDate } from "../src/lib/ensureSchema.ts";

const TEST_TAG = `tt_sales_unpost_${randomBytes(8).toString("hex")}`;
const DATE = "2030-01-15";

class RollbackFixture extends Error {}

before(async () => {
  // Reconcile the existing development schema before the isolated test
  // transaction. It never targets production.
  await ensureSchemaUpToDate();
});

test("owned disposable PG sale → unpost → repost retains immutable source-ledger provenance", async () => {
  // The complete fixture and assertions share one database transaction and
  // deliberately roll back. This exercises PostgreSQL's real RESTRICT FK
  // without leaving tenant, stock, or immutable-audit test data behind.
  await assert.rejects(
    db.transaction(async (tx) => {
      const [company] = await tx.insert(companiesTable).values({
        nameAr: `${TEST_TAG} شركة اختبار معزولة`,
        nameEn: `${TEST_TAG} owned disposable tenant`,
        vatNumber: "300000000000003",
        crNumber: "1010000001",
        city: "Riyadh",
        street: "Test Street",
        buildingNumber: "1",
        postalCode: "12345",
        country: "SA",
        invoiceType: "both",
        status: "active",
        isInternalDemoWorkspace: false,
      }).returning({ id: companiesTable.id });
      const companyId = company.id;

      const [unit] = await tx.insert(unitsTable).values({
        companyId, code: `${TEST_TAG}-UNIT`, nameAr: "وحدة", nameEn: "Unit",
      }).returning({ id: unitsTable.id });
      const [warehouse] = await tx.insert(warehousesTable).values({
        companyId, code: `${TEST_TAG}-WH`, nameAr: "مخزن اختبار", nameEn: "Test warehouse",
      }).returning({ id: warehousesTable.id });
      const [item] = await tx.insert(itemsTable).values({
        companyId,
        unitId: unit.id,
        code: `${TEST_TAG}-ITEM`,
        nameAr: "صنف اختبار",
        costPrice: "5",
      }).returning({ id: itemsTable.id });
      const [balance] = await tx.insert(stockBalanceTable).values({
        companyId, itemId: item.id, warehouseId: warehouse.id, qty: "4", avgCost: "5",
      }).returning({ id: stockBalanceTable.id });
      const [invoice] = await tx.insert(salesInvoicesTable).values({
        companyId, docNumber: `${TEST_TAG}-SALE`, invoiceDate: DATE, status: "posted",
        subtotal: "10", totalAmount: "10",
      }).returning({ id: salesInvoicesTable.id });
      const [line] = await tx.insert(salesInvoiceLinesTable).values({
        companyId, invoiceId: invoice.id, itemId: item.id, warehouseId: warehouse.id,
        itemName: "صنف اختبار", qty: "1", unitPrice: "10", lineTotal: "10",
      }).returning({ id: salesInvoiceLinesTable.id });
      const [postedMovement] = await tx.insert(stockLedgerTable).values({
        companyId, itemId: item.id, warehouseId: warehouse.id,
        txDate: DATE, txType: "sale", qty: "-1", costPrice: "5", totalCost: "-5",
        balanceQty: "4", refType: "sales_invoice", refId: invoice.id, sourceLineId: line.id,
      }).returning({ id: stockLedgerTable.id });
      // This is the same attribution writer called by the real sales-post
      // path; do not manufacture a snapshot row in this regression test.
      await writeSalesLineProductionAttributions(tx, companyId, "sales_invoice", invoice.id, [
        { id: line.id, itemId: item.id },
      ]);
      // This receipt happened after the sale. The unpost must preserve it and
      // must not write a compensating row back on the original sale date.
      await tx.update(stockBalanceTable).set({ qty: "6" }).where(eq(stockBalanceTable.id, balance.id));
      await tx.insert(stockLedgerTable).values({
        companyId, itemId: item.id, warehouseId: warehouse.id,
        txDate: "2030-01-16", txType: "purchase", qty: "2", costPrice: "5", totalCost: "10",
        balanceQty: "6", refType: "test_later_purchase", refId: invoice.id,
      });

      await reverseSalesInvoiceStockForUnpost({
        executor: tx,
        companyId,
        invoiceId: invoice.id,
        reversalDate: "2030-01-16",
        docNumber: `${TEST_TAG}-SALE`,
      });

      const [restoredBalance] = await tx.select({ qty: stockBalanceTable.qty })
        .from(stockBalanceTable)
        .where(eq(stockBalanceTable.id, balance.id));
      assert.equal(restoredBalance.qty, "7.0000", "unpost restores only its issue without losing a newer receipt");
      const movementsAfterUnpost = await tx.select({
        id: stockLedgerTable.id,
        refType: stockLedgerTable.refType,
        txType: stockLedgerTable.txType,
        txDate: stockLedgerTable.txDate,
        qty: stockLedgerTable.qty,
      }).from(stockLedgerTable).where(and(
        eq(stockLedgerTable.companyId, companyId),
        eq(stockLedgerTable.refId, invoice.id),
      )).orderBy(stockLedgerTable.id);
      assert.deepEqual(
        movementsAfterUnpost
          .filter((row) => row.refType !== "test_later_purchase")
          .map((row) => [row.refType, row.txType, row.qty, row.txDate]),
        [
          ["sales_invoice_unposted", "sale", "-1.0000", DATE],
          ["sales_invoice_unpost", "adjustment", "1.0000", "2030-01-16"],
        ],
      );
      const [preservedAttribution] = await tx.select({
        movementLedgerId: salesLineProductionCostAttributionsTable.movementLedgerId,
      }).from(salesLineProductionCostAttributionsTable).where(and(
        eq(salesLineProductionCostAttributionsTable.companyId, companyId),
        eq(salesLineProductionCostAttributionsTable.documentId, invoice.id),
      ));
      assert.equal(preservedAttribution.movementLedgerId, postedMovement.id);

      // Simulate the persistence output of a fresh repost. The original
      // movement is no longer active, so the new posted issue gets its own
      // identity rather than reusing/deleting the immutable original.
      await tx.update(stockBalanceTable).set({ qty: "6" }).where(eq(stockBalanceTable.id, balance.id));
      const [repostedMovement] = await tx.insert(stockLedgerTable).values({
        companyId, itemId: item.id, warehouseId: warehouse.id,
        txDate: DATE, txType: "sale", qty: "-1", costPrice: "5", totalCost: "-5",
        balanceQty: "4", refType: "sales_invoice", refId: invoice.id, sourceLineId: line.id,
      }).returning({ id: stockLedgerTable.id });
      await writeSalesLineProductionAttributions(tx, companyId, "sales_invoice", invoice.id, [
        { id: line.id, itemId: item.id },
      ]);
      const currentIssues = await tx.select({ id: stockLedgerTable.id })
        .from(stockLedgerTable)
        .where(and(
          eq(stockLedgerTable.companyId, companyId),
          eq(stockLedgerTable.refType, "sales_invoice"),
          eq(stockLedgerTable.refId, invoice.id),
        ));
      assert.deepEqual(currentIssues.map((row) => row.id), [repostedMovement.id]);
      const allAttributions = await tx.select({
        movementLedgerId: salesLineProductionCostAttributionsTable.movementLedgerId,
        snapshotKey: salesLineProductionCostAttributionsTable.snapshotKey,
      }).from(salesLineProductionCostAttributionsTable).where(and(
        eq(salesLineProductionCostAttributionsTable.companyId, companyId),
        eq(salesLineProductionCostAttributionsTable.documentType, "sales_invoice"),
        eq(salesLineProductionCostAttributionsTable.documentId, invoice.id),
      )).orderBy(salesLineProductionCostAttributionsTable.movementLedgerId);
      assert.equal(allAttributions.length, 2, "each post has one immutable snapshot");
      assert.equal(new Set(allAttributions.map((row) => row.snapshotKey)).size, 2, "repost snapshot keys are unique");
      assert.deepEqual(
        allAttributions.map((row) => row.movementLedgerId),
        [postedMovement.id, repostedMovement.id],
        "the current repost gets a fresh live attribution while the old one remains retained",
      );
      const liveAttributions = await tx.select({
        movementLedgerId: salesLineProductionCostAttributionsTable.movementLedgerId,
      }).from(salesLineProductionCostAttributionsTable)
        .innerJoin(stockLedgerTable, and(
          eq(stockLedgerTable.id, salesLineProductionCostAttributionsTable.movementLedgerId),
          eq(stockLedgerTable.refType, "sales_invoice"),
          eq(stockLedgerTable.refId, invoice.id),
        ))
        .where(and(
          eq(salesLineProductionCostAttributionsTable.companyId, companyId),
          eq(salesLineProductionCostAttributionsTable.documentType, "sales_invoice"),
          eq(salesLineProductionCostAttributionsTable.documentId, invoice.id),
        ));
      assert.deepEqual(
        liveAttributions.map((row) => row.movementLedgerId),
        [repostedMovement.id],
        "downstream live-attribution joins exclude the retained unposted issue",
      );

      throw new RollbackFixture();
    }),
    RollbackFixture,
  );

  const leaked = await db.select({ id: companiesTable.id })
    .from(companiesTable)
    .where(eq(companiesTable.nameEn, `${TEST_TAG} owned disposable tenant`));
  assert.equal(leaked.length, 0, "the owned disposable fixture must be rolled back");
});