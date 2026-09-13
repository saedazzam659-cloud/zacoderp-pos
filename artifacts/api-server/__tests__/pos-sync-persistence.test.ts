import assert from "node:assert/strict";
import test from "node:test";
import { persistPosSyncInvoice } from "../src/lib/posSyncPersistence.js";

function fakeExecutor(opts: { failLines?: boolean } = {}) {
  let headerWrites = 0;
  let lineWrites = 0;
  let lineCompanyId: number | null = null;
  let rolledBack = false;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => {
        if (table === "header") {
          headerWrites += 1;
          return { returning: async () => [{ id: 91 }] };
        }
        lineWrites += 1;
        lineCompanyId = values[0]?.companyId ?? null;
        if (opts.failLines) throw new Error("line write failed");
        return undefined;
      },
    }),
  };
  // The persistence helper only relies on insert/select shape. Identity
  // values stand in for the two Drizzle table objects in this unit test.
  let insertCount = 0;
  const originalInsert = tx.insert;
  tx.insert = ((table: unknown) => {
    insertCount += 1;
    return originalInsert(insertCount === 1 ? "header" : "lines");
  }) as typeof tx.insert;
  return {
    executor: {
      transaction: async (callback: (tx: typeof tx) => Promise<unknown>) => {
        try {
          return await callback(tx);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    },
    stats: () => ({ headerWrites, lineWrites, lineCompanyId, rolledBack }),
  };
}

const payload = {
  invoiceDate: "2026-01-01",
  lines: [{ itemId: 12, itemName: "صنف", qty: 1, unitPrice: 10, lineTotal: 10 }],
};

test("POS header and lines roll back together when line persistence fails", async () => {
  const fake = fakeExecutor({ failLines: true });
  await assert.rejects(
    () => persistPosSyncInvoice(fake.executor, 7, "client-1", payload, async () => [12]),
    /line write failed/,
  );
  assert.deepEqual(fake.stats(), {
    headerWrites: 1,
    lineWrites: 1,
    lineCompanyId: 7,
    rolledBack: true,
  });
});

test("POS line persistence includes the tenant company ID", async () => {
  const fake = fakeExecutor();
  const result = await persistPosSyncInvoice(fake.executor, 9, "client-2", payload, async () => [12]);
  assert.deepEqual(result, { id: 91 });
  assert.equal(fake.stats().lineCompanyId, 9);
  assert.equal(fake.stats().rolledBack, false);
});
