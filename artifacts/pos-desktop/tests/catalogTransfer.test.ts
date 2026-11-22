import assert from "node:assert/strict";
import test from "node:test";
import { isIndependentSkuVariant, parseBrandLinksJson, parseSalesUnitsJson, serializeBrandLinks, serializeSalesUnits } from "../src/lib/catalogTransfer.ts";
import type { ItemBrandView } from "../src/lib/brands.ts";
import type { ItemUnit } from "../src/lib/items.ts";

test("brand and sale-unit JSON round-trips without local IDs", () => {
  const brand: ItemBrandView = {
    id: "local-link",
    brandId: 9,
    brandCode: "BR-0009",
    brandNameAr: "بيلا سيتي",
    brandNameEn: "Bella City",
    barcode: "123456",
    partNumber: "PN20",
    supplierCode: "S-1",
    purchaseUnit: "قطعة",
    purchaseCost: 8,
    lastPurchaseCost: 8,
    avgCost: 8,
    salePrice1: 12,
    salePrice2: null,
    salePrice3: null,
    minSalePrice: 10,
    profitMargin: 25,
    discountType: "none",
    discountValue: null,
    countryOfOrigin: "EG",
    warrantyPeriod: null,
    status: "active",
    notes: null,
  };
  const unit: ItemUnit = { id: "local-unit", name: "علبة", factor: 6, price: 60, barcode: "BOX-6" };
  const brandJson = serializeBrandLinks([brand]);
  const unitJson = serializeSalesUnits([unit]);

  assert.equal(JSON.parse(brandJson)[0].brandId, undefined);
  assert.equal(JSON.parse(unitJson)[0].id, undefined);
  assert.equal(parseBrandLinksJson(brandJson)[0].brandCode, "BR-0009");
  assert.deepEqual(parseSalesUnitsJson(unitJson), [{ name: "علبة", factor: 6, price: 60, barcode: "BOX-6" }]);
});

test("invalid or duplicate transfer entries fail closed", () => {
  assert.throws(() => parseBrandLinksJson("{bad json"));
  assert.throws(() => parseBrandLinksJson(JSON.stringify([
    { brandCode: "A", brandNameAr: "Brand A" },
    { brandCode: "A", brandNameAr: "Brand A duplicate" },
  ])));
  assert.throws(() => parseSalesUnitsJson(JSON.stringify([
    { name: "Box", factor: 2, price: 10, barcode: "DUP" },
    { name: "Case", factor: 6, price: 20, barcode: "DUP" },
  ])));
});

test("variant items require both a family and a size plus a stable identifier", () => {
  assert.equal(isIndependentSkuVariant({ variantGroupName: "PN20", variantLabel: "20 mm", code: "P-20" }), true);
  assert.equal(isIndependentSkuVariant({ variantGroupName: "PN20", variantLabel: "20 mm" }), false);
  assert.equal(isIndependentSkuVariant({ variantGroupName: "PN20", code: "P-20" }), false);
  assert.equal(isIndependentSkuVariant({ code: "P-20", isCatalogTransfer: true }), true);
});
