import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateBoqCertification,
  pendingValueForBoqLines,
} from "../src/lib/contracting-boq-certification.js";

test("separates physical execution from partial certification and FIFO release", () => {
  const first = calculateBoqCertification({
    currentQty: 50,
    unitPrice: 1000,
    contractQuantity: 100,
    certificationPercent: 80,
    certificationReason: "حجز اعتماد جزئي",
  });
  assert.equal(first.executionValue, "50000.00");
  assert.equal(first.currentExecutionCertifiedValue, "40000.00");
  assert.equal(first.currentValue, "40000.00");
  assert.equal(first.pendingValue, "10000.00");

  const release = calculateBoqCertification({
    currentQty: 0,
    unitPrice: 1000,
    contractQuantity: 100,
    priorPendingCertifiedValue: 10000,
    certificationReason: "إطلاق الاعتماد المحتجز",
    priorLines: [{
      id: 101,
      currentQty: 50,
      executionValue: first.executionValue,
      currentExecutionCertifiedValue: first.currentExecutionCertifiedValue,
      currentValue: first.currentValue,
      pendingCertificationAllocations: [],
    }],
  });
  assert.equal(release.executionValue, "0.00");
  assert.equal(release.currentValue, "10000.00");
  assert.deepEqual(release.pendingCertificationAllocations, [{
    sourceLineId: 101,
    amount: "10000.00",
  }]);
  assert.equal(release.previousPendingValue, "10000.00");
  assert.equal(release.pendingValue, "0.00");
});

test("allocates releases FIFO and rejects over-release", () => {
  const prior = [
    {
      id: 1,
      currentQty: 10,
      executionValue: "100.00",
      currentExecutionCertifiedValue: "50.00",
      currentValue: "50.00",
      pendingCertificationAllocations: [],
    },
    {
      id: 2,
      currentQty: 20,
      executionValue: "200.00",
      currentExecutionCertifiedValue: "100.00",
      currentValue: "100.00",
      pendingCertificationAllocations: [],
    },
  ];
  const release = calculateBoqCertification({
    currentQty: 0,
    unitPrice: 10,
    priorPendingCertifiedValue: 75,
    certificationReason: "اعتماد لاحق",
    priorLines: prior,
  });
  assert.deepEqual(release.pendingCertificationAllocations, [
    { sourceLineId: 1, amount: "50.00" },
    { sourceLineId: 2, amount: "25.00" },
  ]);
  assert.equal(pendingValueForBoqLines(prior), 150);
  assert.throws(() => calculateBoqCertification({
    currentQty: 0,
    unitPrice: 10,
    priorPendingCertifiedValue: 151,
    certificationReason: "اعتماد لاحق",
    priorLines: prior,
  }), /تتجاوز الرصيد المحتجز/);
});

test("rejects invalid percentages, missing reasons, and quantity overruns", () => {
  assert.throws(() => calculateBoqCertification({
    currentQty: 1,
    unitPrice: 10,
    certificationPercent: 101,
  }), /بين 0 و100/);
  assert.throws(() => calculateBoqCertification({
    currentQty: 1,
    unitPrice: 10,
    certificationPercent: 50,
  }), /سبب الاعتماد مطلوب/);
  assert.throws(() => calculateBoqCertification({
    currentQty: 11,
    unitPrice: 10,
    contractQuantity: 10,
  }), /تتجاوز كمية BOQ/);
  assert.doesNotThrow(() => calculateBoqCertification({
    currentQty: 0,
    unitPrice: 10,
    certificationPercent: 0,
  }));
});

test("legacy nullable extension fields remain fully certified", () => {
  const result = calculateBoqCertification({
    currentQty: 10,
    unitPrice: 100,
    priorLines: [{
      id: 1,
      currentQty: 10,
      currentValue: "1000.00",
      executionValue: null,
      currentExecutionCertifiedValue: null,
      pendingCertificationAllocations: null,
    }],
  });
  assert.equal(result.previousPendingValue, "0.00");
  assert.equal(result.pendingValue, "0.00");
  assert.equal(result.currentValue, "1000.00");
});