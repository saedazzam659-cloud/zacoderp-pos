import assert from "node:assert/strict";
import test from "node:test";
import { purchaseInvoicesTable, salesInvoicesTable } from "@workspace/db";
import { tombstoneAndDeleteDraftInvoice } from "../src/lib/invoiceDeletionTombstone.js";

function fakeTransactionalDb(options: { failDelete?: boolean } = {}) {
  const state: { tombstone: any; deleted: boolean; rolledBack: boolean } = {
    tombstone: null,
    deleted: false,
    rolledBack: false,
  };
  const tx = {
    insert: () => ({
      values: async (values: any) => {
        state.tombstone = values;
      },
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          if (options.failDelete) throw new Error("delete failed");
          state.deleted = true;
          return [{ id: 41 }];
        },
      }),
    }),
  };
  return {
    state,
    executor: {
      transaction: async (callback: (tx: typeof tx) => Promise<void>) => {
        try {
          return await callback(tx);
        } catch (error) {
          state.tombstone = null;
          state.deleted = false;
          state.rolledBack = true;
          throw error;
        }
      },
    },
  };
}

const draft = {
  id: 41,
  companyId: 7,
  docNumber: "SI-2026-0007",
  status: "draft",
  zatcaStatus: "pending",
  zatcaUuid: null,
  xmlContent: null,
  invoiceHash: null,
};

test("draft deletion creates tenant-scoped reclaim evidence before deleting", async () => {
  const fake = fakeTransactionalDb();
  await fake.executor.transaction((tx) => tombstoneAndDeleteDraftInvoice(
    tx,
    salesInvoicesTable,
    "sales_invoices",
    draft,
    {
      companyId: 7,
      recordId: 41,
      deletedBy: 3,
      deletedByUsername: "operator",
      reason: "test delete",
    },
  ));
  assert.equal(fake.state.deleted, true);
  assert.equal(fake.state.tombstone.tableName, "sales_invoices");
  assert.equal(fake.state.tombstone.companyId, 7);
  assert.equal(fake.state.tombstone.recordId, 41);
  assert.equal(fake.state.tombstone.payload.docNumber, "SI-2026-0007");
  assert.equal(fake.state.tombstone.payload.status, "draft");
});

test("failed invoice deletion rolls back its tombstone", async () => {
  const fake = fakeTransactionalDb({ failDelete: true });
  await assert.rejects(
    () => fake.executor.transaction((tx) => tombstoneAndDeleteDraftInvoice(
      tx,
      salesInvoicesTable,
      "sales_invoices",
      draft,
      {
        companyId: 7,
        recordId: 41,
        deletedBy: null,
        deletedByUsername: null,
        reason: "test delete",
      },
    )),
    /delete failed/,
  );
  assert.equal(fake.state.rolledBack, true);
  assert.equal(fake.state.tombstone, null);
  assert.equal(fake.state.deleted, false);
});

test("purchase draft deletion records the independent purchase table", async () => {
  const fake = fakeTransactionalDb();
  await fake.executor.transaction((tx) => tombstoneAndDeleteDraftInvoice(
    tx,
    purchaseInvoicesTable,
    "purchase_invoices",
    { ...draft, docNumber: "PI-2026-0007" },
    {
      companyId: 7,
      recordId: 41,
      deletedBy: 3,
      deletedByUsername: "operator",
      reason: "test purchase delete",
    },
  ));
  assert.equal(fake.state.tombstone.tableName, "purchase_invoices");
  assert.equal(fake.state.tombstone.payload.docNumber, "PI-2026-0007");
  assert.equal(fake.state.tombstone.payload.status, "draft");
});

test("only a clean draft can produce a reclaim tombstone", async () => {
  const fake = fakeTransactionalDb();
  await assert.rejects(
    () => fake.executor.transaction((tx) => tombstoneAndDeleteDraftInvoice(
      tx,
      salesInvoicesTable,
      "sales_invoices",
      { ...draft, status: "posted" },
      { companyId: 7, recordId: 41, deletedBy: null, deletedByUsername: null, reason: "test" },
    )),
    /فقط الفاتورة المسودة/,
  );
  await assert.rejects(
    () => fake.executor.transaction((tx) => tombstoneAndDeleteDraftInvoice(
      tx,
      salesInvoicesTable,
      "sales_invoices",
      { ...draft, zatcaUuid: "submitted-uuid" },
      { companyId: 7, recordId: 41, deletedBy: null, deletedByUsername: null, reason: "test" },
    )),
    /ZATCA/,
  );
  assert.equal(fake.state.tombstone, null);
});
