import { test } from "node:test";
import assert from "node:assert/strict";
import { taxableAdvanceReceiptSlice, taxableAdvanceRecoverySlice } from "../src/lib/contracting-taxable-advance.js";

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