import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const crmWhatsApp = readFileSync(
  new URL("../src/pages/crm/CrmWhatsApp.tsx", import.meta.url),
  "utf8",
);
const companyDetails = readFileSync(
  new URL("../src/pages/CompanyDetails.tsx", import.meta.url),
  "utf8",
);
const invoiceNew = readFileSync(
  new URL("../src/pages/InvoiceNew.tsx", import.meta.url),
  "utf8",
);
const invoiceDetails = readFileSync(
  new URL("../src/pages/InvoiceDetails.tsx", import.meta.url),
  "utf8",
);

test("WhatsApp contacts keep desktop rows and expose complete phone-card actions", () => {
  assert.ok(crmWhatsApp.includes('className="hidden overflow-x-auto lg:block"'));
  assert.ok(crmWhatsApp.includes('className="space-y-3 p-3 lg:hidden"'));
  assert.ok(crmWhatsApp.includes('data-testid="checkbox-select-all-mobile"'));

  for (const action of [
    "checkbox-contact-mobile-",
    "button-convert-contact-mobile-",
    "button-open-chat-mobile-",
    "button-edit-contact-mobile-",
    "button-delete-contact-mobile-",
  ]) {
    assert.ok(crmWhatsApp.includes(action), `phone contact cards need ${action}`);
  }
});

test("company users get phone-sized controls and a clearly labeled password reset", () => {
  assert.ok(companyDetails.includes('className="hidden divide-y lg:block"'));
  assert.ok(companyDetails.includes('className="divide-y lg:hidden"'));
  assert.ok(companyDetails.includes("card-company-user-mobile-"));
  assert.ok(companyDetails.includes("button-reset-password-mobile-"));
  assert.match(companyDetails, /min-h-11 flex-1 gap-2[\s\S]*?تغيير كلمة المرور/);
  assert.match(companyDetails, /setResetPassDialog\(u\); setNewPass\(""\)/);
  assert.ok(companyDetails.includes('data-testid="button-toggle-password-visibility"'));
  assert.ok(companyDetails.includes('aria-label={showPass ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}'));
});

test("company ZATCA setup is directly reachable but stays hidden for agent companies", () => {
  assert.ok(companyDetails.includes('data-testid="button-company-zatca-setup"'));
  assert.match(companyDetails, /onClick=\{\(\) => setTab\("zatca"\)\}/);
  assert.match(companyDetails, /\{!agentId && \([\s\S]*?button-company-zatca-setup/);
  assert.match(companyDetails, /!\s*agentId && <TabBtn active=\{tab === "zatca"\}/);
});

test("saving an invoice reaches details with the existing print dialog for drafts and issued invoices", () => {
  assert.match(invoiceNew, /setLocation\(`\/invoices\/\$\{invoice\.id\}`\);/);
  assert.match(invoiceDetails, /\(invoice\.status === "draft" \|\| invoice\.status === "issued"\)/);
  assert.ok(invoiceDetails.includes('data-testid="button-print-invoice"'));
  assert.ok(invoiceDetails.includes('className="min-h-11 w-full gap-1.5 sm:min-h-9 sm:w-auto"'));
  assert.match(invoiceDetails, /ensurePrinterReady\(toast, navigate\)[\s\S]*?setPrintOpen\(true\)/);
  assert.match(invoiceDetails, /<InvoicePrintDialog[\s\S]*?open=\{printOpen\}/);
});
