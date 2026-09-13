import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertInvoiceHasRealItemLine,
  InvoiceLineValidationError,
  isInvoiceLineMeaningful,
} from "../src/lib/invoiceLineValidation.js";

function executorWithItems(ids: number[]) {
  return {
    select: () => ({
      from: () => ({
        where: async () => ids.map(id => ({ id })),
      }),
    }),
  };
}

test("filler rows do not count, while a tenant-owned service item does", async () => {
  assert.equal(isInvoiceLineMeaningful({ qty: "1", unitPrice: "0" }), false);
  const itemIds = await assertInvoiceHasRealItemLine(
    7,
    [{ qty: "1", unitPrice: "0" }, { itemId: 12, itemName: "استشارة", itemType: "service" }],
    executorWithItems([12]),
    "فاتورة الاختبار",
  );
  assert.deepEqual(itemIds, [12]);
});

test("description-only rows are rejected rather than counted as invoice items", async () => {
  await assert.rejects(
    () => assertInvoiceHasRealItemLine(
      7,
      [{ itemName: "وصف بلا صنف", qty: "1", unitPrice: "10" }],
      executorWithItems([]),
      "فاتورة الاختبار",
    ),
    (error: unknown) =>
      error instanceof InvoiceLineValidationError && error.code === "REAL_ITEM_REQUIRED",
  );
});

test("item IDs are tenant-scoped", async () => {
  await assert.rejects(
    () => assertInvoiceHasRealItemLine(
      7,
      [{ itemId: 99, itemName: "صنف من شركة أخرى" }],
      executorWithItems([]),
      "فاتورة الاختبار",
    ),
    (error: unknown) =>
      error instanceof InvoiceLineValidationError && error.code === "ITEM_NOT_FOUND",
  );
});

test("sales and purchasing save routes guard both create and edit, including drafts", () => {
  const sales = readFileSync(new URL("../src/routes/sales.ts", import.meta.url), "utf8");
  const purchasing = readFileSync(new URL("../src/routes/purchasing.ts", import.meta.url), "utf8");
  for (const source of [sales, purchasing]) {
    assert.match(source, /assertInvoiceHasRealItemLine\(cid, lines/);
    assert.match(source, /router\.post\(["'].*invoices/);
    assert.match(source, /router\.put\(["'].*invoices\/:id/);
    assert.match(source, /status:\s*["']draft["']/);
  }
});
