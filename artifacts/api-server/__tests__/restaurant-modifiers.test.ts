import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateRestaurantOrderTotals } from "../src/lib/restaurant-order-pricing.ts";
import { validateRestaurantModifierSelection } from "../src/lib/restaurant-modifier-selection.ts";
import { buildRestaurantInvoicePricing } from "../../pos/src/lib/restaurant-pricing.ts";

const requiredGroup = {
  id: "sizes",
  nameAr: "الحجم",
  minSelect: 1,
  maxSelect: 1,
  options: [{ id: "large" }, { id: "small" }],
};

test("rejects missing required, duplicate, over-limit, and unknown modifier choices", () => {
  assert.throws(() => validateRestaurantModifierSelection([requiredGroup], []), /الاختيارات/);
  assert.throws(() => validateRestaurantModifierSelection([requiredGroup], [
    { groupId: "sizes", optionIds: ["large", "small"] },
  ]), /الاختيارات/);
  assert.throws(() => validateRestaurantModifierSelection([requiredGroup], [
    { groupId: "sizes", optionIds: ["large", "large"] },
  ]), /مكرر/);
  assert.throws(() => validateRestaurantModifierSelection([requiredGroup], [
    { groupId: "unknown", optionIds: ["large"] },
  ]), /غير معروفة/);
});

test("allows an empty optional group and resolves valid selected options", () => {
  const optional = { ...requiredGroup, required: false, minSelect: 0, maxSelect: 2 };
  assert.deepEqual(validateRestaurantModifierSelection([optional], []), []);
  assert.equal(validateRestaurantModifierSelection([requiredGroup], [
    { groupId: "sizes", optionIds: ["large"] },
  ])[0].option.id, "large");
});

test("keeps add-on surcharge while applying fractional inventory usage and its VAT", () => {
  const orderLine = {
    erpItemId: 1,
    erpItemType: "stock" as const,
    erpVatRate: "15",
    vatIncluded: true,
    nameSnapshot: "وجبة",
    qty: "2",
    price: "10",
    modifiers: [{
      itemId: 22,
      itemType: "stock" as const,
      option: "جبن",
      price: 1,
      consumptionQtyPerSelection: 0.25,
      vatRate: "5",
      vatIncluded: true,
    }],
  };
  const totals = calculateRestaurantOrderTotals([{
    erpItemId: orderLine.erpItemId,
    qty: orderLine.qty,
    price: orderLine.price,
    vatIncluded: true,
    vatRate: "15",
    modifiers: orderLine.modifiers,
  }]);
  const invoice = buildRestaurantInvoicePricing([orderLine], 7);
  const addonLine = invoice.lines.find(line => line.itemId === 22);
  assert.ok(addonLine);
  assert.equal(addonLine.qty, 0.5);
  assert.equal(addonLine.unitPrice, 4);
  assert.equal(addonLine.lineTotal, 2);
  assert.equal(invoice.totalAmount, 22);
  assert.equal(totals.total, "22.00");
});

test("legacy modifier snapshots default to one consumed unit per selection", () => {
  const invoice = buildRestaurantInvoicePricing([{
    erpItemId: 1,
    erpItemType: "stock",
    erpVatRate: "15",
    vatIncluded: true,
    nameSnapshot: "وجبة",
    qty: "2",
    price: "10",
    modifiers: [{
      itemId: 22, itemType: "stock", option: "جبن", price: 1, vatRate: "15", vatIncluded: true,
    }],
  }], 7);
  assert.equal(invoice.lines.find(line => line.itemId === 22)?.qty, 2);
});
