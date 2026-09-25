import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateBoqCertification,
  pendingValueForBoqLines,
  quotedBoqNetValue,
  quotedBoqComponentsNet,
} from "../src/lib/contracting-boq-certification.js";
import { authoritativeCumulativeBillAmounts } from "../src/lib/contracting-accounting-math.js";

test("inclusive BOQ extends the quote before VAT extraction and cumulative certification reconciles to the cent", () => {
  assert.equal(quotedBoqNetValue(1000, 100, 15, true), "86956.52");
  assert.equal(quotedBoqNetValue(1000, 100, 5, true), "95238.10");
  const mixed = [
    { unitPrice: "100.00", vatPercent: "15.00", priceIncludesVat: true },
    { unitPrice: "20.00", vatPercent: "5.00", priceIncludesVat: true },
  ];
  assert.equal(quotedBoqComponentsNet(1000, mixed), "106004.14");
  assert.equal(quotedBoqComponentsNet(1000, [mixed[0], { unitPrice: "-10.00", vatPercent: "5.00", priceIncludesVat: true }]), "77432.71");
  const mixedFirst = calculateBoqCertification({
    unitPrice: "106.01", currentQty: 333, quotedPriceComponents: mixed,
  });
  const mixedLast = calculateBoqCertification({
    unitPrice: "106.01", currentQty: 667, quotedPriceComponents: mixed,
    priorLines: [{ id: 201, currentQty: 333, executionValue: mixedFirst.executionValue,
      currentValue: mixedFirst.currentValue, quotedPriceComponentsSnapshot: mixed }],
  });
  assert.equal(Math.round((Number(mixedFirst.currentValue) + Number(mixedLast.currentValue)) * 100), 10600414);
  assert.equal(quotedBoqNetValue("1.2345", 100, 15, true), "107.35");
  const fractionalFirst = calculateBoqCertification({
    unitPrice: "86.96", quotedUnitPrice: "100.00", quotedVatPercent: "15.00",
    quotedPriceIncludesVat: true, currentQty: "0.3333",
  });
  const fractionalLast = calculateBoqCertification({
    unitPrice: "86.96", quotedUnitPrice: "100.00", quotedVatPercent: "15.00",
    quotedPriceIncludesVat: true, currentQty: "0.9012",
    priorLines: [{ id: 301, currentQty: "0.3333", executionValue: fractionalFirst.executionValue,
      currentValue: fractionalFirst.currentValue, quotedUnitPriceSnapshot: "100.00",
      quotedVatPercentSnapshot: "15.00", quotedPriceIncludesVatSnapshot: true }],
  });
  assert.equal(Math.round((Number(fractionalFirst.currentValue) + Number(fractionalLast.currentValue)) * 100), 10735);
  assert.equal(quotedBoqNetValue(1000, 100, 15, false), "100000.00");
  const quote = { unitPrice: "86.96", quotedUnitPrice: "100.00",
    quotedVatPercent: "15.00", quotedPriceIncludesVat: true, contractQuantity: 1000 };
  const first = calculateBoqCertification({
    ...quote, currentQty: 333, certificationPercent: 80,
    certificationReason: "اعتماد مرحلي",
  });
  assert.equal(first.executionValue, "28956.52");
  const prior = { id: 101, currentQty: 333, executionValue: first.executionValue,
    currentExecutionCertifiedValue: first.currentExecutionCertifiedValue,
    currentValue: first.currentValue, quotedUnitPriceSnapshot: "100.00",
    quotedVatPercentSnapshot: "15.00", quotedPriceIncludesVatSnapshot: true };
  const second = calculateBoqCertification({
    ...quote, currentQty: 667, certificationPercent: 100,
    priorPendingCertifiedValue: first.pendingValue,
    certificationReason: "اعتماد الأعمال المعلقة", priorLines: [prior],
  });
  assert.equal(second.executionValue, "58000.00");
  assert.equal(Number(first.currentValue) + Number(second.currentValue), 86956.52);
  const firstBill = authoritativeCumulativeBillAmounts({
    direction: "outgoing", grossAmount: first.currentValue,
    adjustedContractValue: "86956.52", retentionPercent: "5", retentionCapPercent: "4",
    vatPercent: "15", priorGrossAmount: "0", priorRetentionAmount: "0",
  });
  const finalBill = authoritativeCumulativeBillAmounts({
    direction: "outgoing", grossAmount: "86956.52",
    adjustedContractValue: "86956.52", retentionPercent: "5", retentionCapPercent: "4",
    vatPercent: "15", priorGrossAmount: firstBill.grossAmount,
    priorRetentionAmount: firstBill.retentionAmount,
  });
  assert.equal(Math.round(Number(firstBill.vatAmount) * 100) + Math.round(Number(finalBill.vatAmount) * 100), 1304348);
  assert.equal(Math.round(Number(firstBill.retentionAmount) * 100) + Math.round(Number(finalBill.retentionAmount) * 100), 347826);
});

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