import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { CASH_TRANSFER_MOBILE_PERMISSION_KEYS, mobilePermAllowed } from "../src/lib/mobilePerms.js";
import {
  cashTransferAlreadyPosted,
  cashTransferAvailableBalance,
  cashTransferBranchAllowed,
  cashTransferHasSufficientBalance,
  cashTransferNeedsCurrencyRejection,
  cashTransferPostingAmount,
} from "../src/lib/cashTransferPolicy.js";

test("cash-transfer permissions are explicit opt-ins for every role", () => {
  for (const role of ["admin", "superadmin", "user"]) {
    for (const key of CASH_TRANSFER_MOBILE_PERMISSION_KEYS) {
      assert.equal(mobilePermAllowed({ role, mobilePermissions: null }, key), false);
    }
    assert.equal(mobilePermAllowed({
      role,
      mobilePermissions: { cash_transfers_create: true },
    }, "cash_transfers_create"), true);
  }
});

test("cashbox branch scope allows only assigned branches (or unscoped users)", () => {
  assert.equal(cashTransferBranchAllowed(17, [17, 19]), true);
  assert.equal(cashTransferBranchAllowed(18, [17, 19]), false);
  assert.equal(cashTransferBranchAllowed(null, [17, 19]), true);
  assert.equal(cashTransferBranchAllowed(18, null), true);
});

test("available balance includes posted transfers and blocks overspending", () => {
  const balance = cashTransferAvailableBalance(130, 35, 20, 15);
  assert.equal(balance, 100);
  assert.equal(cashTransferHasSufficientBalance(90, balance), true);
  assert.equal(cashTransferHasSufficientBalance(100, balance), true);
  assert.equal(cashTransferHasSufficientBalance(101, balance), false);
  assert.equal(cashTransferHasSufficientBalance(0, balance), false);
});

test("only mobile transfers reject mismatched currencies; web exchange rates convert to ledger value", () => {
  assert.equal(cashTransferNeedsCurrencyRejection(true, 1, 2), true);
  assert.equal(cashTransferNeedsCurrencyRejection(true, 1, 1), false);
  assert.equal(cashTransferNeedsCurrencyRejection(false, 1, 2), false);
  assert.equal(cashTransferPostingAmount(25, 3.75), 93.75);
  assert.equal(cashTransferPostingAmount(25, 1), 25);
  assert.equal(cashTransferPostingAmount(25, 0), null);
});

test("a posted transfer or one already linked to a journal entry is treated as a retry", () => {
  assert.equal(cashTransferAlreadyPosted("posted", null), true);
  assert.equal(cashTransferAlreadyPosted("draft", 41), true);
  assert.equal(cashTransferAlreadyPosted("draft", null), false);
});

test("posting locks the transfer and checks the idempotency guard before creating a journal entry", () => {
  const route = fs.readFileSync(new URL("../src/routes/cash-transfers.ts", import.meta.url), "utf8");
  const start = route.indexOf('router.post("/:id/post"');
  const end = route.indexOf('router.delete("/:id"', start);
  assert.ok(start >= 0 && end > start);
  const postRoute = route.slice(start, end);
  const lock = postRoute.indexOf('.for("update")');
  const guard = postRoute.indexOf("cashTransferAlreadyPosted(locked.status, locked.journalEntryId)");
  const create = postRoute.indexOf("await createJournalEntry(");
  assert.ok(lock >= 0, "posting must lock the transfer row");
  assert.ok(guard > lock, "idempotency must be checked after reading the locked row");
  assert.ok(create > guard, "journal entry must not be created before the retry guard");
});
