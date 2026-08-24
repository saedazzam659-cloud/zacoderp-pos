import test from "node:test";
import assert from "node:assert/strict";
import { employeeCustodyStatementDescription } from "../src/lib/accountStatementDescriptions.js";

test("general account statement identifies custody disbursement employee and purpose", () => {
  assert.equal(
    employeeCustodyStatementDescription({
      entryType: "employee_custody",
      employeeNameAr: "أحمد محمد",
      purpose: "شراء مواد ضيافة",
    }),
    "صرف عهدة — الموظف: أحمد محمد — الغرض: شراء مواد ضيافة",
  );
});

test("custody statement description falls back to English employee name", () => {
  assert.equal(
    employeeCustodyStatementDescription({
      entryType: "employee_custody_return",
      employeeNameAr: " ",
      employeeNameEn: "Ahmed Mohamed",
      purpose: "Site expenses",
    }),
    "إرجاع عهدة — الموظف: Ahmed Mohamed — الغرض: Site expenses",
  );
});

test("non-custody entries keep their existing description path", () => {
  assert.equal(
    employeeCustodyStatementDescription({
      entryType: "payment",
      employeeNameAr: "أحمد محمد",
      purpose: "شراء مواد ضيافة",
    }),
    null,
  );
});