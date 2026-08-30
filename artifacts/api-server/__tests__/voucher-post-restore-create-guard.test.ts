import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const receiptRoute = readFileSync(
  new URL("../src/routes/receipt-vouchers.ts", import.meta.url),
  "utf8",
);
const paymentRoute = readFileSync(
  new URL("../src/routes/payment-vouchers.ts", import.meta.url),
  "utf8",
);

test("receipt create guard covers single and multi-line vouchers", () => {
  assert.match(receiptRoute, /normalizeReceiptLines\(d\.lines\)/);
  assert.match(receiptRoute, /allocateReceiptCode/);
  assert.match(receiptRoute, /codeExists\(seq\)/);
  assert.match(receiptRoute, /safeAccountId/);
  assert.match(receiptRoute, /pg_get_serial_sequence\('receipt_vouchers', 'id'\)/);
  assert.match(receiptRoute, /receipt voucher create failed/);
});

test("payment create guard covers single and multi-line vouchers", () => {
  assert.match(paymentRoute, /normalizePaymentLines\(d\.lines\)/);
  assert.match(paymentRoute, /allocatePaymentCode/);
  assert.match(paymentRoute, /codeExists\(seq\)/);
  assert.match(paymentRoute, /safeAccountId/);
  assert.match(paymentRoute, /pg_get_serial_sequence\('payment_vouchers', 'id'\)/);
  assert.match(paymentRoute, /payment voucher create failed/);
});

test("database write errors never expose Drizzle SQL text", () => {
  const helper = readFileSync(
    new URL("../src/lib/postRestoreWriteGuard.ts", import.meta.url),
    "utf8",
  );
  assert.match(helper, /postgresErrorField\(error\?\.cause, "message"\)/);
  assert.match(helper, /Failed query:/);
});