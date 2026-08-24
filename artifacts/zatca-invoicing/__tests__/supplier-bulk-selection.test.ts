import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSupplierBulkPreview,
  selectedSuppliersInGridOrder,
  suppliersInStableGridOrder,
} from "../src/lib/supplierBulkSelection.ts";

test("bulk preview keeps every selected supplier after search hides some rows", () => {
  const source = [
    { id: 30, nameAr: "المورد الثالث" },
    { id: 10, nameAr: "المورد الأول" },
    { id: 20, nameAr: "المورد الثاني" },
  ];
  const ordered = suppliersInStableGridOrder(source);
  const selectedIds = new Set<number>([30, 10]);

  const visibleAfterSearch = ordered.filter((supplier) => supplier.id === 30);
  assert.deepEqual(visibleAfterSearch.map((supplier) => supplier.id), [30]);

  const selected = selectedSuppliersInGridOrder(ordered, selectedIds);
  assert.deepEqual(selected.map((supplier) => supplier.id), [10, 30]);

  const preview = buildSupplierBulkPreview(selected, "21012", 2);
  assert.deepEqual(
    preview.map((row) => ({ supplierId: row.supplier.id, accountCode: row.accountCode })),
    [
      { supplierId: 10, accountCode: "21012001" },
      { supplierId: 30, accountCode: "21012002" },
    ],
  );

  const postPayloadSupplierIds = preview.map((row) => row.supplier.id);
  assert.deepEqual(postPayloadSupplierIds, [10, 30]);
  assert.equal(postPayloadSupplierIds.length, selectedIds.size);

  const refreshedGridWhileDialogIsOpen = ordered.filter((supplier) => supplier.id !== 10);
  const refreshedSelection = selectedSuppliersInGridOrder(refreshedGridWhileDialogIsOpen, selectedIds);
  assert.deepEqual(refreshedSelection.map((supplier) => supplier.id), [30]);
  assert.deepEqual(
    buildSupplierBulkPreview(selected, "21012", 2).map((row) => row.supplier.id),
    [10, 30],
  );
  assert.deepEqual(source.map((supplier) => supplier.id), [30, 10, 20]);
});