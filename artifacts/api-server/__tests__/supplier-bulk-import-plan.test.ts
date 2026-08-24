import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseSupplierBulkCreateBranchId,
  planSupplierBulkImportRows,
  type SupplierBulkImportExisting,
} from "../src/lib/supplierBulkImport.js";

function existingSupplier(
  patch: Partial<SupplierBulkImportExisting> & Pick<SupplierBulkImportExisting, "id" | "nameAr">,
): SupplierBulkImportExisting {
  return {
    id: patch.id,
    code: null,
    nameAr: patch.nameAr,
    nameEn: null,
    vatNumber: null,
    crNumber: null,
    email: null,
    phone: null,
    city: null,
    district: null,
    street: null,
    buildingNumber: null,
    postalCode: null,
    country: "SA",
    currencyCode: "SAR",
    creditLimit: "0.00",
    accountId: null,
    accessible: true,
    currentAccount: null,
    ...patch,
  };
}

test("supplier Excel plan creates, updates, and blocks a linked supplier by default", () => {
  const existing = [
    existingSupplier({ id: 10, code: "SUP-10", nameAr: "مورد قائم" }),
    existingSupplier({
      id: 20,
      code: "SUP-20",
      nameAr: "مورد مرتبط",
      accountId: 901,
      currentAccount: { id: 901, code: "21011001", nameAr: "مورد مرتبط", parentId: 211 },
    }),
  ];

  const plan = planSupplierBulkImportRows({
    rawRows: [
      { code: "SUP-NEW", nameAr: "مورد جديد" },
      { code: "SUP-10", nameAr: "مورد قائم محدث", phone: "0500000000" },
      { code: "SUP-20", nameAr: "مورد مرتبط" },
    ],
    existingSuppliers: existing,
    parentAccountId: 212,
    parentAccountCode: "21012",
    leadingZeros: 2,
    allowReassign: false,
  });

  assert.deepEqual(plan.rows.map(row => row.status), ["create", "update", "blocked"]);
  assert.deepEqual(plan.rows.map(row => row.accountCode), ["21012001", "21012002", "21012003"]);
  assert.equal(plan.rows[1]?.matchedBy, "code");
  assert.equal(plan.rows[1]?.patch.phone, "0500000000");
  assert.equal(plan.canCommit, false);
});

test("supplier Excel plan explicitly allows reassignment under a different parent", () => {
  const existing = [
    existingSupplier({
      id: 20,
      code: "SUP-20",
      nameAr: "مورد مرتبط",
      accountId: 901,
      currentAccount: { id: 901, code: "21011001", nameAr: "مورد مرتبط", parentId: 211 },
    }),
  ];

  const plan = planSupplierBulkImportRows({
    rawRows: [{ id: 20, code: "SUP-20", nameAr: "مورد مرتبط" }],
    existingSuppliers: existing,
    parentAccountId: 212,
    parentAccountCode: "21012",
    leadingZeros: 2,
    allowReassign: true,
  });

  assert.equal(plan.canCommit, true);
  assert.equal(plan.rows[0]?.status, "reassign");
  assert.equal(plan.rows[0]?.previousAccountId, 901);
});

test("supplier Excel plan rejects rows whose identifiers point at different suppliers", () => {
  const existing = [
    existingSupplier({ id: 10, code: "SUP-A", vatNumber: "3101", nameAr: "المورد أ" }),
    existingSupplier({ id: 20, code: "SUP-B", vatNumber: "3102", nameAr: "المورد ب" }),
  ];

  const plan = planSupplierBulkImportRows({
    rawRows: [{ code: "SUP-A", vatNumber: "3102", nameAr: "صف متعارض" }],
    existingSuppliers: existing,
    parentAccountId: 212,
    parentAccountCode: "21012",
    leadingZeros: 2,
    allowReassign: false,
  });

  assert.equal(plan.canCommit, false);
  assert.equal(plan.rows[0]?.status, "error");
  assert.match(plan.rows[0]?.error ?? "", /موردين مختلفين/);
});

test("supplier Excel plan flags out-of-scope matches for route-level denial", () => {
  const plan = planSupplierBulkImportRows({
    rawRows: [{ code: "PRIVATE-SUP", nameAr: "اسم من الملف" }],
    existingSuppliers: [
      existingSupplier({
        id: 99,
        code: "PRIVATE-SUP",
        nameAr: "مورد فرع آخر",
        accessible: false,
        accountId: 700,
        currentAccount: { id: 700, code: "21017001", nameAr: "مورد فرع آخر", parentId: 170 },
      }),
    ],
    parentAccountId: 212,
    parentAccountCode: "21012",
    leadingZeros: 2,
    allowReassign: true,
  });

  assert.equal(plan.canCommit, false);
  assert.equal(plan.rows[0]?.scopeBlocked, true);
  assert.equal(plan.rows[0]?.status, "error");
});

test("out-of-scope matches override mixed-identifier and ambiguity diagnostics", () => {
  const hidden = existingSupplier({
    id: 99,
    code: "HIDDEN",
    vatNumber: "HIDDEN-VAT",
    nameAr: "مورد مخفي",
    accessible: false,
  });
  const visible = existingSupplier({
    id: 10,
    code: "VISIBLE",
    vatNumber: "VISIBLE-VAT",
    nameAr: "مورد ظاهر",
  });
  const plan = planSupplierBulkImportRows({
    rawRows: [
      { code: "VISIBLE", vatNumber: "HIDDEN-VAT", nameAr: "صف مختلط" },
      { id: 123456, code: "HIDDEN", nameAr: "معرّف غير صحيح" },
    ],
    existingSuppliers: [visible, hidden],
    parentAccountId: 212,
    parentAccountCode: "21012",
    leadingZeros: 2,
    allowReassign: true,
  });

  assert.deepEqual(plan.rows.map(row => row.scopeBlocked), [true, true]);
  assert.ok(plan.rows.every(row => row.supplierId === null));
  assert.ok(plan.rows.every(row => row.currentAccount === null));
});

test("restricted supplier imports must target an allowed branch", () => {
  assert.equal(chooseSupplierBulkCreateBranchId(null), null);
  assert.equal(chooseSupplierBulkCreateBranchId([7]), 7);
  assert.equal(chooseSupplierBulkCreateBranchId([7, 8], 8), 8);
  assert.throws(
    () => chooseSupplierBulkCreateBranchId([], undefined),
    (error: any) => error?.status === 403,
  );
  assert.throws(
    () => chooseSupplierBulkCreateBranchId([7, 8], undefined),
    (error: any) => error?.status === 400,
  );
  assert.throws(
    () => chooseSupplierBulkCreateBranchId([7, 8], 9),
    (error: any) => error?.status === 403,
  );
});