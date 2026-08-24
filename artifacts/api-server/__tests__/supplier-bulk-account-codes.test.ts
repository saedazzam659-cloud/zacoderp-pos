import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSupplierBulkAccountCodes,
  SupplierBulkAccountPlanError,
} from "../src/lib/supplierBulkAccounts.js";

test("supplier bulk account codes use the confirmed fixed-width format", () => {
  const codes = buildSupplierBulkAccountCodes("21012", 2, 100);

  assert.equal(codes[0], "21012001");
  assert.equal(codes[1], "21012002");
  assert.equal(codes[9], "21012010");
  assert.equal(codes[99], "21012100");
});

test("supplier bulk account codes reject a selection that exceeds the chosen width", () => {
  assert.throws(
    () => buildSupplierBulkAccountCodes("21012", 0, 10),
    (error: unknown) =>
      error instanceof SupplierBulkAccountPlanError
      && /زِد عدد الأصفار/.test(error.message),
  );
});

test("supplier bulk account codes require a numeric parent code", () => {
  assert.throws(
    () => buildSupplierBulkAccountCodes("AP-21", 2, 1),
    (error: unknown) =>
      error instanceof SupplierBulkAccountPlanError
      && /رقمياً/.test(error.message),
  );
});