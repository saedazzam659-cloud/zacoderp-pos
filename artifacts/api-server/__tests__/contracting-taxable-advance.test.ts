import { test } from "node:test";
import assert from "node:assert/strict";
import { taxableAdvanceReceiptSlice, taxableAdvanceRecoverySlice } from "../src/lib/contracting-taxable-advance.js";
import { contractingQuotedNet } from "../src/lib/contracting-accounting-math.js";

test("a 5% inclusive advance freezes invoice net and allocates its original tax independent of later bill mode", () => {
  const base = BigInt(Math.round(Number(contractingQuotedNet("105000.00", "5.00", true)) * 100));
  const vat = 10500000n - base;
  assert.equal(base, 10000000n);
  assert.equal(vat, 500000n);
  const first = taxableAdvanceReceiptSlice({
    invoiceBase: base, invoiceVat: vat, previousBase: 0n, previousVat: 0n, gross: 5250000n,
  });
  assert.deepEqual(first, { base: 5000000n, vat: 250000n });
  assert.equal(taxableAdvanceRecoverySlice({
    sourceBase: first.base, sourceVat: first.vat, previousBase: 0n, previousVat: 0n,
    base: 5000000n,
  }), 250000n);
});

test("an inclusive 100000 advance at 15% extracts 86956.52 base and 13043.48 original VAT", () => {
  const base = BigInt(Math.round(Number(contractingQuotedNet("100000.00", "15.00", true)) * 100));
  const vat = 10000000n - base;
  assert.deepEqual([base, vat], [8695652n, 1304348n]);
  const slice = taxableAdvanceReceiptSlice({
    invoiceBase: base, invoiceVat: vat, previousBase: 0n, previousVat: 0n, gross: 10000000n,
  });
  assert.deepEqual(slice, { base, vat });
});

test("two partial gross receipts consume exactly the frozen 386 base and VAT",()=>{
  const first=taxableAdvanceReceiptSlice({
    invoiceBase:10000000n,invoiceVat:1500000n,previousBase:0n,previousVat:0n,gross:5750000n,
  });
  const second=taxableAdvanceReceiptSlice({
    invoiceBase:10000000n,invoiceVat:1500000n,
    previousBase:first.base,previousVat:first.vat,gross:5750000n,
  });
  assert.deepEqual(first,{base:5000000n,vat:750000n});
  assert.equal(first.base+second.base,10000000n);
  assert.equal(first.vat+second.vat,1500000n);
  const uneven=taxableAdvanceReceiptSlice({
    invoiceBase:10000n,invoiceVat:1500n,previousBase:0n,previousVat:0n,gross:5000n,
  });
  const remainder=taxableAdvanceReceiptSlice({
    invoiceBase:10000n,invoiceVat:1500n,
    previousBase:uneven.base,previousVat:uneven.vat,gross:6500n,
  });
  assert.equal(uneven.base+remainder.base,10000n);
  assert.equal(uneven.vat+remainder.vat,1500n);
  assert.throws(()=>taxableAdvanceReceiptSlice({
    invoiceBase:10000n,invoiceVat:1500n,previousBase:0n,previousVat:0n,gross:4n,
  }),/تقريب/);
  assert.throws(()=>taxableAdvanceReceiptSlice({
    invoiceBase:10000000n,invoiceVat:1500000n,
    previousBase:10000000n,previousVat:1500000n,gross:1n,
  }),/يتجاوز/);
});

test("partial recovery finishes with exact source VAT and rejects incompatible cents",()=>{
  const first=taxableAdvanceRecoverySlice({
    sourceBase:5000000n,sourceVat:750000n,previousBase:0n,previousVat:0n,base:1250000n,
  });
  const final=taxableAdvanceRecoverySlice({
    sourceBase:5000000n,sourceVat:750000n,previousBase:1250000n,
    previousVat:first,base:3750000n,
  });
  assert.equal(first,187500n);
  assert.equal(final,562500n);
  assert.equal(first+final,750000n);
  assert.throws(()=>taxableAdvanceRecoverySlice({
    sourceBase:3n,sourceVat:0n,previousBase:0n,previousVat:0n,base:4n,
  }),/يتجاوز/);
});