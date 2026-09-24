import { test } from "node:test";
import assert from "node:assert/strict";
import { currenciesTable, taxesTable } from "@workspace/db";
import { registrationCountry, seedRegistrationCountryDefaults } from "../src/lib/registrationCountry.js";

test("registration profiles reject unsupported codes and unsafe currency overrides", () => {
  assert.throws(() => registrationCountry("XX"), /غير مدعومة/);
  assert.throws(() => registrationCountry("EG", "arbitrary"), /غير مدعومة/);
  assert.deepEqual(
    [registrationCountry("EG").currency.code, registrationCountry("EG").rate,
      registrationCountry("SA").currency.code, registrationCountry("SA").rate],
    ["EGP", "14", "SAR", "15"],
  );
  assert.equal(registrationCountry("EG", "USD").currency.code, "USD");
});

test("only the selected new company's currency and tax are seeded; existing defaults survive", async () => {
  const currencies = [{ id: 1, companyId: 7, code: "SAR", isDefault: true }];
  const taxes = [{ id: 2, companyId: 7, code: "CUSTOM", rate: "9", isDefault: true }];
  const sqlNumbers = (input: unknown, visited = new WeakSet<object>()): number[] => {
    if (typeof input === "number") return [input];
    if (!input || typeof input !== "object" || visited.has(input)) return [];
    visited.add(input);
    if (Array.isArray(input)) return input.flatMap(value => sqlNumbers(value, visited));
    const item = input as { value?: unknown; queryChunks?: unknown };
    return [...sqlNumbers(item.value, visited), ...sqlNumbers(item.queryChunks, visited)];
  };
  const fakeDb = {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: { queryChunks: unknown[] }) => ({
          limit: async () => {
            const companyId = sqlNumbers(condition.queryChunks)[0];
            return (table === currenciesTable ? currencies : taxes)
              .filter(row => row.companyId === companyId && row.isDefault).slice(0, 1);
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        if (table === currenciesTable) currencies.push({ id: 3, companyId: Number(row.companyId), code: String(row.code), isDefault: true });
        else if (table === taxesTable) taxes.push({ id: 4, companyId: Number(row.companyId), code: String(row.code), rate: String(row.rate), isDefault: true });
      },
    }),
  };
  const database = fakeDb as unknown as Parameters<typeof seedRegistrationCountryDefaults>[2];
  await seedRegistrationCountryDefaults(8, registrationCountry("EG"), database);
  assert.deepEqual(currencies.map(c => [c.companyId, c.code]), [[7, "SAR"], [8, "EGP"]]);
  assert.deepEqual(taxes.map(t => [t.companyId, t.code, t.rate]), [[7, "CUSTOM", "9"], [8, "VAT14", "14"]]);
  await seedRegistrationCountryDefaults(7, registrationCountry("EG"), database);
  assert.equal(currencies.length, 2);
  assert.equal(taxes.length, 2);
});