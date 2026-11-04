import test from "node:test";
import assert from "node:assert/strict";
import { buildRestaurantInvoicePricing } from "../../pos/src/lib/restaurant-pricing.ts";
import type { ROrderItem } from "../../pos/src/lib/api.ts";
import { normalizeInvoiceLineVatRate } from "../src/lib/invoice-vat-rate.ts";
import { calculateRestaurantOrderTotals } from "../src/lib/restaurant-order-pricing.ts";

function line(overrides: Partial<ROrderItem>): ROrderItem {
  return {
    id: 1,
    orderId: 8,
    menuItemId: 1,
    nameSnapshot: "وجبة",
    qty: "1",
    price: "100.00",
    status: "served",
    ...overrides,
  } as ROrderItem;
}

test("keeps VAT-inclusive prices unchanged and extracts net and VAT", () => {
  const result = buildRestaurantInvoicePricing([
    line({
      erpItemId: 41,
      erpItemType: "service",
      erpVatRate: "15.00",
      vatIncluded: true,
      price: "115.00",
    }),
  ], null);

  assert.deepEqual(
    { subtotal: result.subtotal, vatAmount: result.vatAmount, totalAmount: result.totalAmount },
    { subtotal: 100, vatAmount: 15, totalAmount: 115 },
  );
  assert.equal(result.lines[0].unitPrice, 115);
  assert.equal(result.lines[0].lineTotal, 115);
});

test("adds VAT to exclusive menu prices using the linked item's rate", () => {
  const result = buildRestaurantInvoicePricing([
    line({
      erpItemId: 42,
      erpItemType: "stock",
      erpVatRate: "15.00",
      vatIncluded: false,
      price: "100.00",
    }),
  ], 7);

  assert.deepEqual(
    { subtotal: result.subtotal, vatAmount: result.vatAmount, totalAmount: result.totalAmount },
    { subtotal: 100, vatAmount: 15, totalAmount: 115 },
  );
  assert.equal(result.lines[0].unitPrice, 115);
  assert.equal(result.lines[0].warehouseId, 7);
});

test("preserves a zero VAT rate and doesn't require a warehouse for services", () => {
  const result = buildRestaurantInvoicePricing([
    line({
      erpItemId: 43,
      erpItemType: "service",
      erpVatRate: "0",
      vatIncluded: false,
      price: "12.50",
    }),
  ], null);

  assert.deepEqual(
    { subtotal: result.subtotal, vatAmount: result.vatAmount, totalAmount: result.totalAmount },
    { subtotal: 12.5, vatAmount: 0, totalAmount: 12.5 },
  );
  assert.equal(result.lines[0].vatRate, 0);
  assert.equal(result.lines[0].warehouseId, undefined);
  assert.equal(normalizeInvoiceLineVatRate(result.lines[0].vatRate), "0");
});

test("groups equal ERP item prices across inclusive and exclusive menu settings", () => {
  const orderItems = [
    line({
      id: 1,
      erpItemId: 44,
      erpItemType: "stock",
      erpVatRate: "15",
      vatIncluded: true,
      price: "115.00",
    }),
    line({
      id: 2,
      menuItemId: 2,
      erpItemId: 44,
      erpItemType: "stock",
      erpVatRate: "15",
      vatIncluded: false,
      price: "100.00",
    }),
    line({
      id: 3,
      menuItemId: 3,
      erpItemId: 45,
      erpItemType: "service",
      erpVatRate: "0",
      vatIncluded: true,
      price: "50.00",
    }),
  ];
  const result = buildRestaurantInvoicePricing(orderItems, 7);
  const orderTotals = calculateRestaurantOrderTotals(orderItems.map(item => ({
    menuItemId: item.menuItemId,
    erpItemId: item.erpItemId,
    qty: item.qty,
    price: item.price,
    vatIncluded: item.vatIncluded,
    vatRate: item.erpVatRate,
  })));

  assert.equal(result.lines.length, 2);
  assert.equal(result.lines.find(item => item.itemId === 44)?.qty, 2);
  assert.deepEqual(
    { subtotal: result.subtotal, vatAmount: result.vatAmount, totalAmount: result.totalAmount },
    { subtotal: 250, vatAmount: 30, totalAmount: 280 },
  );
  assert.equal(result.lines.reduce((sum, item) => sum + item.lineTotal, 0), result.totalAmount);
  assert.deepEqual(
    { subtotal: Number(orderTotals.subtotal), vatAmount: Number(orderTotals.vatAmount), totalAmount: Number(orderTotals.total) },
    { subtotal: result.subtotal, vatAmount: result.vatAmount, totalAmount: result.totalAmount },
  );
});
