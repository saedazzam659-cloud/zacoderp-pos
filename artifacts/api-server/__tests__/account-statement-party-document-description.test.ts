import test from "node:test";
import assert from "node:assert/strict";
import { partyDocumentStatementDescription } from "../src/lib/accountStatementDescriptions.js";

const describe = (
  sourceKind: "purchase_invoice" | "sales_invoice" | "purchase_return" | "sales_return",
  paymentType: "cash" | "bank" | "credit",
  debit: number,
  credit: number,
  isLinkedPartyAccount = true,
) => partyDocumentStatementDescription({
  entryType: sourceKind,
  sourceKind,
  paymentType,
  debit,
  credit,
  isLinkedPartyAccount,
  existingSourceDescription: "الوصف النهائي الحالي",
});

for (const [paymentType, method] of [["cash", "نقدي"], ["bank", "بنكي"]] as const) {
  test(`purchase invoice ${paymentType} labels only its AP settlement leg`, () => {
    assert.equal(describe("purchase_invoice", paymentType, 100, 0), `سداد فاتورة مشتريات - ${method}`);
    assert.equal(describe("purchase_invoice", paymentType, 0, 100), "الوصف النهائي الحالي");
  });

  test(`sales invoice ${paymentType} labels only its AR settlement leg`, () => {
    assert.equal(describe("sales_invoice", paymentType, 0, 100), `تحصيل فاتورة مبيعات - ${method}`);
    assert.equal(describe("sales_invoice", paymentType, 100, 0), "الوصف النهائي الحالي");
  });

  test(`purchase return ${paymentType} labels only its AP refund leg`, () => {
    assert.equal(describe("purchase_return", paymentType, 0, 100), `استرداد مرتجع مشتريات - ${method}`);
    assert.equal(describe("purchase_return", paymentType, 100, 0), "الوصف النهائي الحالي");
  });

  test(`sales return ${paymentType} labels only its AR refund leg`, () => {
    assert.equal(describe("sales_return", paymentType, 100, 0), `رد قيمة مرتجع مبيعات - ${method}`);
    assert.equal(describe("sales_return", paymentType, 0, 100), "الوصف النهائي الحالي");
  });
}

test("non-party and credit document lines preserve the exact existing description", () => {
  assert.equal(describe("purchase_invoice", "cash", 100, 0, false), "الوصف النهائي الحالي");
  assert.equal(describe("sales_return", "credit", 100, 0), "الوصف النهائي الحالي");
});

test("entry/source mismatch preserves the exact existing description", () => {
  assert.equal(
    partyDocumentStatementDescription({
      entryType: "manual",
      sourceKind: "sales_invoice",
      paymentType: "cash",
      debit: 0,
      credit: 100,
      isLinkedPartyAccount: true,
      existingSourceDescription: "  لا تغيّر المسافات  ",
    }),
    "  لا تغيّر المسافات  ",
  );
});
