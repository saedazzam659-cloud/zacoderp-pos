import assert from "node:assert/strict";
import test from "node:test";
import { companyTemplateExcludedAccountIds } from "../src/lib/companyTemplate.js";

type AccountFixture = {
  id: number;
  parentId: number | null;
  code: string;
  nameAr: string;
  isPosting: boolean;
};

const row = (
  id: number,
  code: string,
  nameAr: string,
  parentId: number | null,
  isPosting = true,
): AccountFixture => ({ id, code, nameAr, parentId, isPosting });

test("new-company templates keep HR control accounts but exclude personal descendants", () => {
  const accounts = [
    row(1, "1108", "ذمم مدينة أخرى", null, false),
    row(2, "11081", "سلف وعهد الموظفين", 1),
    row(3, "1108101", "سلفة محمد أحمد", 2),
    row(4, "11082", "عهد الموظفين", 1),
    row(5, "1108201", "عهدة محمود علي", 4),
    row(6, "110820101", "تفصيل عهدة محمود علي", 5),
    row(7, "1109", "تأمينات لدى الغير", null),
  ];

  const excluded = companyTemplateExcludedAccountIds(accounts, []);

  assert.equal(excluded.has(2), false, "canonical loan control account must remain");
  assert.equal(excluded.has(4), false, "canonical custody control account must remain");
  assert.equal(excluded.has(7), false, "unrelated canonical account must remain");
  assert.equal(excluded.has(3), true);
  assert.equal(excluded.has(5), true);
  assert.equal(excluded.has(6), true, "descendants of a personal ledger must also be excluded");
});

test("entity-linked party containers exclude deleted or orphaned sibling ledgers", () => {
  const accounts = [
    row(10, "1103", "العملاء", null, false),
    row(11, "1103001", "عميل مرتبط", 10),
    row(12, "1103002", "عميل حذفت بطاقته", 10),
    row(13, "3101", "رأس المال", null),
    row(14, "310101", "جاري الشريك أحمد", 13),
    row(15, "310102", "مساهم خالد", 13),
  ];

  const excluded = companyTemplateExcludedAccountIds(accounts, [11]);

  assert.equal(excluded.has(10), false, "party container itself must remain");
  assert.equal(excluded.has(11), true);
  assert.equal(excluded.has(12), true, "orphaned sibling under a party container must be excluded");
  assert.equal(excluded.has(14), true);
  assert.equal(excluded.has(15), true);
});

test("protected HR roots survive bad links and unrelated flat siblings stay intact", () => {
  const accounts = [
    row(20, "1108", "ذمم مدينة أخرى", null, false),
    row(21, "11081", "سلف وعهد الموظفين", 20),
    row(22, "11082", "عهد الموظفين", 20),
    row(23, "11083", "حساب نظامي آخر", 20),
    row(24, "99901", "حساب مرتبط بكيان", 20),
  ];

  const excluded = companyTemplateExcludedAccountIds(accounts, [21, 22, 24]);

  assert.equal(excluded.has(21), false);
  assert.equal(excluded.has(22), false);
  assert.equal(excluded.has(23), false, "unrelated sibling must not be inferred as a party ledger");
  assert.equal(excluded.has(24), true);
});