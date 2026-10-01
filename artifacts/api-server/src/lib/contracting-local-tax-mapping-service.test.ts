import assert from "node:assert/strict";
import test from "node:test";
import { validateOwnerBillTaxMappingInput } from "./contracting-local-tax-mapping-service.js";

test("owner-bill provider mappings require all three explicit codes", () => {
  assert.deepEqual(
    validateOwnerBillTaxMappingInput({
      providerItemCode: "  ITEM-42 ",
      providerUnitCode: " U-01 ",
      providerTaxCategoryCode: " VAT-STD ",
    }),
    {
      providerItemCode: "ITEM-42",
      providerUnitCode: "U-01",
      providerTaxCategoryCode: "VAT-STD",
    },
  );
});

test("owner-bill provider mappings reject missing, blank, oversized, and extra fields", () => {
  assert.throws(
    () => validateOwnerBillTaxMappingInput({
      providerItemCode: "ITEM-42",
      providerUnitCode: "U-01",
      providerTaxCategoryCode: " ",
    }),
    /أدخل رموز الصنف والوحدة والفئة الضريبية/,
  );
  assert.throws(
    () => validateOwnerBillTaxMappingInput({
      providerItemCode: "x".repeat(129),
      providerUnitCode: "U-01",
      providerTaxCategoryCode: "VAT-STD",
    }),
    /أدخل رموز الصنف والوحدة والفئة الضريبية/,
  );
  assert.throws(
    () => validateOwnerBillTaxMappingInput({
      providerItemCode: "ITEM-42",
      providerUnitCode: "U-01",
      providerTaxCategoryCode: "VAT-STD",
      countryCode: "EG",
    }),
    /حقول غير مسموح بها/,
  );
});