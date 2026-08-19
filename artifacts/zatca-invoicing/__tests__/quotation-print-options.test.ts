import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuotationCustomerAddress,
  getQuotationPrintOptions,
  resolveQuotationCurrencyName,
} from "../src/lib/quotationPrintOptions.ts";

test("legacy companies use the agreed quotation print defaults", () => {
  assert.deepEqual(getQuotationPrintOptions({}), {
    showQr: false,
    showCurrencyName: true,
    showCustomerAddress: true,
  });
});

test("quotation print settings can independently override every default", () => {
  assert.deepEqual(getQuotationPrintOptions({
    printQuotationShowQr: true,
    printQuotationShowCurrencyName: false,
    printQuotationShowCustomerAddress: false,
  }), {
    showQr: true,
    showCurrencyName: false,
    showCustomerAddress: false,
  });
});

test("currency name follows the quotation print language", () => {
  const currency = {
    code: "USD",
    nameAr: "دولار أمريكي",
    nameEn: "US Dollar",
  };

  assert.equal(resolveQuotationCurrencyName({}, currency, "ar"), "دولار أمريكي");
  assert.equal(resolveQuotationCurrencyName({}, currency, "en"), "US Dollar");
  assert.equal(resolveQuotationCurrencyName(
    { printQuotationShowCurrencyName: false },
    currency,
    "ar",
  ), "");
});

test("customer address includes the recorded national-address components", () => {
  const customer = {
    buildingNumber: "1234",
    street: "King Road",
    district: "Al Olaya",
    city: "Riyadh",
    postalCode: "11564",
    nationalAddressShort: "ABCD1234",
  };

  assert.equal(
    buildQuotationCustomerAddress(customer, {}, "ar"),
    "مبنى 1234، King Road، Al Olaya، Riyadh، الرمز 11564، ABCD1234",
  );
  assert.equal(
    buildQuotationCustomerAddress(customer, {}, "en"),
    "Building 1234, King Road, Al Olaya, Riyadh, Postal 11564, ABCD1234",
  );
});