import test from "node:test";
import assert from "node:assert/strict";
import { ownDocumentFilter, isOwnDocumentOnly } from "../src/lib/documentVisibility.js";
import { salesInvoicesTable, receiptVouchersTable, paymentVouchersTable } from "@workspace/db";

const ownerColumn = salesInvoicesTable.createdById;

test("own-document visibility is opt-in and filters enabled users", () => {
  const disabled = { authUser: { id: 7, role: "user", permissions: {} } };
  const enabled = {
    authUser: {
      id: 7,
      role: "user",
      permissions: { __dataVisibility: { salesInvoicesOwn: true } },
    },
  };

  assert.equal(isOwnDocumentOnly(disabled, "salesInvoicesOwn"), false);
  assert.deepEqual(ownDocumentFilter(disabled, "salesInvoicesOwn", ownerColumn), []);
  assert.equal(isOwnDocumentOnly(enabled, "salesInvoicesOwn"), true);
  assert.equal(ownDocumentFilter(enabled, "salesInvoicesOwn", ownerColumn).length, 1);
});

test("admins retain company-wide access even if an own-only flag is stored", () => {
  for (const role of ["admin", "superadmin"]) {
    const req = {
      authUser: {
        id: 7,
        role,
        permissions: { __dataVisibility: { salesInvoicesOwn: true } },
      },
    };
    assert.equal(isOwnDocumentOnly(req, "salesInvoicesOwn"), false);
    assert.deepEqual(ownDocumentFilter(req, "salesInvoicesOwn", ownerColumn), []);
  }
});

test("enabled own-only scope fails closed when the authenticated user id is missing", () => {
  const req = {
    authUser: {
      role: "user",
      permissions: { __dataVisibility: { salesInvoicesOwn: true } },
    },
  };
  assert.equal(ownDocumentFilter(req, "salesInvoicesOwn", ownerColumn).length, 1);
});

test("receipt and payment voucher ownership scopes are independent and opt-in", () => {
  const receiptOnly = {
    authUser: {
      id: 9,
      role: "user",
      permissions: { __dataVisibility: { receiptVouchersOwn: true } },
    },
  };
  assert.equal(isOwnDocumentOnly(receiptOnly, "receiptVouchersOwn"), true);
  assert.equal(isOwnDocumentOnly(receiptOnly, "paymentVouchersOwn"), false);
  assert.equal(ownDocumentFilter(receiptOnly, "receiptVouchersOwn", receiptVouchersTable.createdById).length, 1);
  assert.deepEqual(ownDocumentFilter(receiptOnly, "paymentVouchersOwn", paymentVouchersTable.createdById), []);
});
