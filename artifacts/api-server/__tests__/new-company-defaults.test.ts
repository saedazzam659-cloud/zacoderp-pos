import assert from "node:assert/strict";
import test from "node:test";
import { SEQUENCE_TX_TYPES, companiesTable, sequencesTable, sequenceLogsTable, sequenceCountersTable, type db } from "@workspace/db";
import { newCompanySequenceGroups, seedNewCompanyDefaults } from "../src/lib/newCompanyDefaults.js";
import { readFileSync } from "node:fs";

test("every supported numbering type is bound exactly once on a fresh company", () => {
  const groups = newCompanySequenceGroups();
  assert.deepEqual([...groups.flat()].sort(), [...SEQUENCE_TX_TYPES].sort());
  assert.equal(new Set(groups.flat()).size, SEQUENCE_TX_TYPES.length);
  assert.equal(groups.every((group) => group.length > 0), true);
});

test("variants sharing a document-number namespace also share a fresh counter", () => {
  const groups = newCompanySequenceGroups();
  const groupFor = (type: string) => groups.find((group) => group.includes(type));
  for (const base of [
    "sales_invoice", "purchase_invoice", "sales_return", "purchase_return",
    "receipt_voucher", "payment_voucher",
  ]) {
    for (const type of SEQUENCE_TX_TYPES.filter((key) => key.startsWith(`${base}_`))) {
      assert.equal(groupFor(type), groupFor(base), `${type} must share ${base}'s number space`);
    }
  }
  for (const type of SEQUENCE_TX_TYPES.filter((key) => key.endsWith("_je") || [
    "adjustment_entry", "fa_depreciation", "fa_acquisition", "fa_disposal",
    "hr_payroll", "hr_loan", "hr_eos", "hr_custody",
  ].includes(key))) {
    assert.equal(groupFor(type), groupFor("journal_entry"), `${type} must share JE's number space`);
  }
  assert.notEqual(groupFor("sales_invoice"), groupFor("sales_return"));
});

test("only the newly created company is changed; issued or already-used counters cannot be wiped", async () => {
  const companies = new Map([
    [1, { id: 1, menuLayout: "sidebar", hideQuickAddBar: false }],
    [2, { id: 2, menuLayout: "sidebar", hideQuickAddBar: false }],
  ]);
  const sequences = [
    { id: 10, companyId: 1, startNumber: 1, currentNumber: 99, code: "OLD" },
    { id: 20, companyId: 2, startNumber: 1, currentNumber: 1, code: "TEMPLATE" },
  ];
  const logs = new Set<number>();
  const counters = new Set<number>();
  let nextId = 21;
  const tx = {
    select: (_fields: unknown) => ({
      from: (table: unknown) => ({
        where: (condition: { queryChunks: unknown[] }) => {
          const ids = condition.queryChunks.flatMap((chunk) => {
            const value = (chunk as { value?: unknown }).value;
            if (typeof value === "number") return [value];
            if (Array.isArray(chunk)) return chunk.flatMap((item) => typeof item?.value === "number" ? [item.value] : []);
            return [];
          });
          const rows = table === companiesTable
            ? [...companies.values()].filter((c) => c.id === ids[0])
            : table === sequencesTable
              ? sequences.filter((s) => s.companyId === ids[0])
              : table === sequenceLogsTable
                ? sequences.filter((s) => logs.has(s.id) && ids.includes(s.id))
                : table === sequenceCountersTable
                  ? sequences.filter((s) => counters.has(s.id) && ids.includes(s.id))
                  : [];
          return { limit: async () => rows.slice(0, 1), for: async () => rows, then: (resolve: (r: unknown[]) => void) => resolve(rows) };
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (changes: Record<string, unknown>) => ({
        where: async (condition: { queryChunks: unknown[] }) => {
          assert.equal(table, companiesTable);
          const id = condition.queryChunks.map((chunk) => (chunk as { value?: unknown }).value).find((value): value is number => typeof value === "number")!;
          Object.assign(companies.get(id)!, changes);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (condition: { queryChunks: unknown[] }) => {
        assert.equal(table, sequencesTable);
        const id = condition.queryChunks.map((chunk) => (chunk as { value?: unknown }).value).find((value): value is number => typeof value === "number")!;
        for (let i = sequences.length - 1; i >= 0; i--) if (sequences[i].companyId === id) sequences.splice(i, 1);
      },
    }),
    insert: (table: unknown) => ({
      values: async (rows: Array<Record<string, unknown>>) => {
        assert.equal(table, sequencesTable);
        for (const row of rows) sequences.push({ ...row, id: nextId++ } as typeof sequences[number]);
      },
    }),
  };
  const database = { transaction: async (fn: (tx: typeof tx) => Promise<void>) => fn(tx) } as unknown as Pick<typeof db, "transaction">;
  await seedNewCompanyDefaults(2, database);
  assert.equal(companies.get(1)?.menuLayout, "sidebar");
  assert.equal(companies.get(1)?.hideQuickAddBar, false);
  assert.deepEqual(sequences.find((s) => s.id === 10), { id: 10, companyId: 1, startNumber: 1, currentNumber: 99, code: "OLD" });
  assert.equal(companies.get(2)?.menuLayout, "topnav");
  assert.equal(companies.get(2)?.hideQuickAddBar, true);
  assert.equal(sequences.filter((s) => s.companyId === 2).length, newCompanySequenceGroups().length);
  assert.equal(sequences.filter((s) => s.companyId === 2).every((s) => s.currentNumber === 1 && s.startNumber === 1), true);
  assert.equal(sequences.filter((s) => s.companyId === 2).every((s) => /[\u0600-\u06ff]/u.test(String((s as any).nameAr))), true);

  const before = JSON.stringify({ companies: [...companies], sequences });
  sequences.find((s) => s.companyId === 2)!.currentNumber = 2;
  const afterIssuance = JSON.stringify({ companies: [...companies], sequences });
  await assert.rejects(seedNewCompanyDefaults(2, database), /Cannot reset issued/);
  assert.equal(JSON.stringify({ companies: [...companies], sequences }), afterIssuance);
  sequences.find((s) => s.companyId === 2)!.currentNumber = 1;
  logs.add(sequences.find((s) => s.companyId === 2)!.id);
  await assert.rejects(seedNewCompanyDefaults(2, database), /Cannot reset sequences with usage/);
  logs.clear();
  counters.add(sequences.find((s) => s.companyId === 2)!.id);
  await assert.rejects(seedNewCompanyDefaults(2, database), /Cannot reset sequences with usage/);
  assert.equal(JSON.stringify({ companies: [...companies], sequences }), before);
});

test("bootstrap is restricted to fresh creation routes, never clone or import", () => {
  const root = new URL("../src/", import.meta.url);
  const createSections = [
    ["routes/auth.ts", 'router.post("/register"', 'router.post("/trainee-register"'],
    ["routes/companies.ts", 'router.post("/"', 'router.get("/:id"'],
    ["routes/reseller.ts", 'router.post("/clients"', 'router.post("/clients/:id/renew"'],
  ];
  for (const [file, begin, end] of createSections) {
    const text = readFileSync(new URL(file, root), "utf8");
    const start = text.indexOf(begin);
    const finish = text.indexOf(end, start + begin.length);
    assert.ok(start >= 0 && finish > start, `${file} fresh-create route boundaries`);
    assert.match(text.slice(start, finish), /seedNewCompanyDefaults\(company\.id\)/);
    assert.equal((text.match(/seedNewCompanyDefaults\(company\.id\)/g) ?? []).length, 1,
      `${file} must never invoke fresh defaults from updates or retries`);
  }
  for (const file of ["lib/cloneCompany.ts", "lib/companyTemplate.ts", "routes/company-import.ts"]) {
    try { assert.doesNotMatch(readFileSync(new URL(file, root), "utf8"), /seedNewCompanyDefaults/); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
});