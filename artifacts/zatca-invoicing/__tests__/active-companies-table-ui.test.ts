import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const activeCompanies = readFileSync(
  new URL("../src/pages/admin/ActiveCompaniesTab.tsx", import.meta.url),
  "utf8",
);

test("connected companies render as desktop table rows with mobile cards and preserved actions", () => {
  assert.match(activeCompanies, /className="grid grid-cols-1 gap-3 md:hidden"/);
  assert.match(activeCompanies, /className="hidden overflow-x-auto rounded-xl border[\s\S]*?md:block"/);
  assert.match(activeCompanies, /<table className="w-full min-w-\[1180px\] text-sm">/);
  assert.match(activeCompanies, /<CompanyTableRow/);
  assert.match(activeCompanies, /<th className="px-3 py-2 font-medium">الشركة<\/th>/);
  assert.match(activeCompanies, /<th className="px-3 py-2 font-medium">الجلسات النشطة<\/th>/);
  assert.match(activeCompanies, /data-testid=\{`inspect-active-company-table-\$\{company\.companyId\}`\}/);
  assert.match(activeCompanies, /data-testid=\{`end-active-company-table-\$\{company\.companyId\}`\}/);
  assert.match(activeCompanies, /data-testid="active-company-session-detail"/);
});