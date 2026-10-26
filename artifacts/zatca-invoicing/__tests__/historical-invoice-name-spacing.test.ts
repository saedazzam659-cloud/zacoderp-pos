import assert from "node:assert/strict";
import test from "node:test";
import { repairNameSpacingFromMaster } from "../src/lib/historicalInvoiceNameSpacing.ts";

test("restores missing spaces only when the OCR text exactly matches a code-linked master", () => {
  const result = repairNameSpacingFromMaster(
    "مؤسسةالبريكي للتجارة",
    "1105060293",
    [{ id: 1, code: "1105060293", nameAr: "مؤسسة البريكي للتجارة" }],
    ["code"],
  );
  assert.deepEqual(result, { name: "مؤسسة البريكي للتجارة", repaired: true });
});

test("leaves OCR differences untouched rather than guessing a name", () => {
  const result = repairNameSpacingFromMaster(
    "مؤسسةالبريكي للتجارۃ",
    "1105060293",
    [{ id: 1, code: "1105060293", nameAr: "مؤسسة البريكي للتجارة" }],
    ["code"],
  );
  assert.deepEqual(result, { name: "مؤسسةالبريكي للتجارۃ", repaired: false });
});

test("does not use ambiguous codes or replace an already spaced source name", () => {
  const rows = [
    { id: 1, code: "232", nameAr: "صنف تجريبي" },
    { id: 2, code: "232", nameAr: "صنف تجريبي آخر" },
  ];
  assert.deepEqual(
    repairNameSpacingFromMaster("صنف تجريبي", "232", rows, ["code"]),
    { name: "صنف تجريبي", repaired: false },
  );
  assert.deepEqual(
    repairNameSpacingFromMaster("صنف تجريبي", "232", [rows[0]], ["code"]),
    { name: "صنف تجريبي", repaired: false },
  );
});
