import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CASH_EXPENSE_MOBILE_PERMISSION_KEYS,
  mobilePermAllowed,
} from "../src/lib/mobilePerms.js";
import {
  cashExpenseBoxAllowed,
  cashExpenseRecordVisible,
  summarizeCashExpenseCurrencyTotals,
} from "../src/lib/cashExpenseAccessPolicy.js";
import { canReadPrivateObjectPath } from "../src/lib/objectStorage.js";

test("cash-expense permissions are explicit opt-ins, including for admins", () => {
  for (const role of ["admin", "superadmin", "user"]) {
    const legacyUser = { role, mobilePermissions: null };
    for (const key of CASH_EXPENSE_MOBILE_PERMISSION_KEYS) {
      assert.equal(mobilePermAllowed(legacyUser, key), false, `${role} must not inherit ${key}`);
    }
    assert.equal(mobilePermAllowed({
      role,
      mobilePermissions: { cash_expenses_create: true },
    }, "cash_expenses_create"), true);
  }
  assert.equal(mobilePermAllowed({ role: "admin", mobilePermissions: null }, "vouchers_view"), true);
});

test("cashbox scope requires an assigned manager or an allowed company branch", () => {
  const scope = {
    userId: 9,
    companyId: 3,
    branchIds: new Set([20]),
    allBranchBoxes: false,
  };
  assert.equal(cashExpenseBoxAllowed({
    branchId: null, branchCompanyId: null, cashExpenseManagerUserId: 9,
  }, scope), true);
  assert.equal(cashExpenseBoxAllowed({
    branchId: null, branchCompanyId: null, cashExpenseManagerUserId: null,
  }, scope), false);
  assert.equal(cashExpenseBoxAllowed({
    branchId: 20, branchCompanyId: 3, cashExpenseManagerUserId: null,
  }, scope), true);
  assert.equal(cashExpenseBoxAllowed({
    branchId: 21, branchCompanyId: 3, cashExpenseManagerUserId: null,
  }, scope), false);
  assert.equal(cashExpenseBoxAllowed({
    branchId: 20, branchCompanyId: 4, cashExpenseManagerUserId: null,
  }, { ...scope, allBranchBoxes: true }), false);
});

test("record visibility and generic object proxy preserve cash-expense isolation", () => {
  assert.equal(cashExpenseRecordVisible(9, 9, true, false), true);
  assert.equal(cashExpenseRecordVisible(10, 9, true, false), false);
  assert.equal(cashExpenseRecordVisible(10, 9, false, true), true);
  assert.equal(cashExpenseRecordVisible(10, 9, false, false), false);

  assert.equal(canReadPrivateObjectPath("cash-expenses/3/9/receipt.png", { role: "admin", companyId: 3 }), false);
  assert.equal(canReadPrivateObjectPath("/cash-expenses/3/9/receipt.png", { role: "superadmin", companyId: 3 }), false);
  assert.equal(canReadPrivateObjectPath("uploads/ordinary.png", { role: "user", companyId: 3 }), true);
});

test("report totals are omitted for mixed or unknown currencies", () => {
  assert.deepEqual(summarizeCashExpenseCurrencyTotals([]), {
    totalAmount: 0,
    currencyCode: null,
  });
  assert.deepEqual(summarizeCashExpenseCurrencyTotals([
    { amount: 12.5, currencyCode: "SAR" },
    { amount: 7.5, currencyCode: "SAR" },
  ]), { totalAmount: 20, currencyCode: "SAR" });
  assert.deepEqual(summarizeCashExpenseCurrencyTotals([
    { amount: 12, currencyCode: "SAR" },
    { amount: 7, currencyCode: "EGP" },
  ]), { totalAmount: null, currencyCode: null });
  assert.deepEqual(summarizeCashExpenseCurrencyTotals([
    { amount: 12, currencyCode: "SAR" },
    { amount: 7, currencyCode: null },
  ]), { totalAmount: null, currencyCode: null });
});
