import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  calculateIndustrialSourceNet,
  calculateIndustrialPostedBaseAmount,
  industrialCostWithSourceFacts,
  normalizeIndustrialCostTag,
  readIndustrialCostSourceFacts,
} from "../src/lib/industrialPurchaseCosts.ts";

test("industrial purchase sources calculate original VAT-exclusive line cost", () => {
  assert.equal(calculateIndustrialSourceNet({
    qty: "2", unitPrice: "115", discount: "10", vatRate: "15",
  }, true), 180);
  assert.equal(calculateIndustrialSourceNet({
    qty: "2", unitPrice: "100", discount: "10", vatRate: "15",
  }, false), 180);
});

test("posted snapshot includes fixed/percent/header discounts, landed allocation, and FX", () => {
  // The 110 line basis already reflects its fixed + percentage line discounts.
  // The document posting basis (300) is the JE's VAT-exclusive total after its
  // header discount and loaded cost; allocate it across the 330 total bases,
  // then freeze in company base currency at FX 2.
  assert.equal(calculateIndustrialPostedBaseAmount({
    linePostingBasis: 110,
    totalPostingBasis: 330,
    documentPostingBasis: 300,
    exchangeRate: 2,
  }), 200);
});

test("industrial return source reference is normalized and invalid tags reject", () => {
  assert.deepEqual(normalizeIndustrialCostTag({
    costType: "electricity",
    factoryId: "4",
    costCenter: "MFG-01",
    period: "2026-09",
    allocationDriver: "machine_hours",
    sourcePurchaseLineId: "91",
  }), {
    costType: "electricity",
    factoryId: 4,
    costCenter: "MFG-01",
    period: "2026-09",
    allocationDriver: "machine_hours",
    sourcePurchaseLineId: 91,
  });
  assert.throws(() => normalizeIndustrialCostTag({
    costType: "electricity", factoryId: 4, costCenter: "MFG-01",
    period: "2026-13", allocationDriver: "machine_hours",
  }), /YYYY-MM/);
});

test("posted source facts are immutable base-currency account snapshots", () => {
  const tagged = industrialCostWithSourceFacts(normalizeIndustrialCostTag({
    costType: "maintenance", factoryId: 4, costCenter: "MFG-01",
    period: "2026-09", allocationDriver: "machine_hours",
  })!, {
    netBaseAmount: 125.5, sourceAccountId: 901, quantity: 2,
    sourceCurrency: "USD", exchangeRate: 3.75,
  });
  assert.deepEqual(readIndustrialCostSourceFacts(tagged), {
    netBaseAmount: 125.5, sourceAccountId: 901, quantity: 2,
    sourceCurrency: "USD", exchangeRate: 3.75,
  });
});

test("provider emits linked return original line IDs and guards all posting transitions", async () => {
  const [provider, purchasing] = await Promise.all([
    readFile(new URL("../src/lib/industrialPurchaseCosts.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/purchasing.ts", import.meta.url), "utf8"),
  ]);
  assert.match(provider, /sourcePurchaseLineId: sourceType === "purchase_return" \? tag\.sourcePurchaseLineId! : line\.id/);
  assert.match(provider, /sourceType === "purchase_return" && \(!doc\.invoiceId \|\| !tag\.sourcePurchaseLineId\)/);
  assert.match(provider, /readIndustrialCostSourceFacts\(line\.industrialCost\)/);
  assert.match(provider, /amount: sign \* facts\.netBaseAmount/);
  assert.match(purchasing, /assertIndustrialCostPeriodsWritable\(cid, lines\)/);
  assert.match(purchasing, /industrialCostWithSourceFacts\(tag, \{/);
  assert.match(purchasing, /كمية أو قيمة المرتجع الصناعي تتجاوز مصدر الفاتورة/);
  assert.match(purchasing, /assertIndustrialReturnSourceLinks\(db, cid, ret\.invoiceId, lines\)/);
  assert.match(purchasing, /assertIndustrialCostPeriodsWritable\(cid, industrialLines\)/);
});