import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calcInvoiceLine,
  effectiveLineDiscount,
  syncLineDiscount,
} from './invoiceLineCalc';

const line = {
  qty: 2,
  unitPrice: 100,
  vatRate: 15,
  discount: 10,
  discountAmount: 20,
};

test('percentage and amount are synchronized views of one discount', () => {
  assert.deepEqual(syncLineDiscount({ ...line, discount: 0, discountAmount: 0 }, 'discount', 10), {
    discount: 10,
    discountAmount: 20,
  });
  assert.deepEqual(syncLineDiscount({ ...line, discount: 0, discountAmount: 0 }, 'discountAmount', 50), {
    discount: 25,
    discountAmount: 50,
  });
  assert.equal(effectiveLineDiscount(line), 20);
});

test('after-discount exclusive VAT taxes the discounted amount', () => {
  const result = calcInvoiceLine(line, false, 'after_discount');
  assert.equal(result.subtotal, 180);
  assert.equal(result.vat, 27);
  assert.ok(Math.abs(result.total - 207) < 1e-9);
});

test('after-discount inclusive VAT extracts VAT after discount', () => {
  const result = calcInvoiceLine(line, true, 'after_discount');
  assert.ok(Math.abs(result.subtotal - 156.52173913043478) < 1e-9);
  assert.ok(Math.abs(result.vat - 23.47826086956522) < 1e-9);
  assert.equal(result.total, 180);
});

test('before-discount mode keeps VAT on the full price', () => {
  assert.deepEqual(calcInvoiceLine(line, false, 'before_discount'), {
    subtotal: 180,
    vat: 30,
    total: 210,
  });
});

test('free quantity is intentionally absent from revenue and VAT inputs', () => {
  const withUnrelatedFreeQty = calcInvoiceLine({ ...line, freeQty: 99 } as typeof line, false);
  assert.deepEqual(withUnrelatedFreeQty, calcInvoiceLine(line, false));
});