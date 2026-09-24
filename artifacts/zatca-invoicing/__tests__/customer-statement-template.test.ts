import assert from "node:assert/strict";
import test from "node:test";
import { exportStatementToPDF, type ExportStatementPdfOpts } from "../src/lib/export";
import * as statementTemplate from "../../mobile/lib/statementHtml";
import * as statementLedger from "../../mobile/lib/statementLedger";
const renderStatementHtml = statementTemplate.renderStatementHtml ?? (statementTemplate as any).default.renderStatementHtml;
const { statementBalances, statementExclusion } = statementLedger.statementBalances ? statementLedger : (statementLedger as any).default;

test("running balances follow row order even when invoice and receipt share ID/date", () => {
  const rows = [
    { id: 1, type: "invoice", date: "2026-01-10", debit: 100, credit: 0 },
    { id: 1, type: "receipt", date: "2026-01-10", debit: 0, credit: 35 },
  ];
  assert.deepEqual(statementBalances(10, rows), [110, 75]);
});

test("excluded customers show the server's notice instead of a zero statement", () => {
  const response = {
    opening: 0, lines: [], excluded: true, reason: "display_only", message: "لا تُعرض الأرصدة لهذا العميل",
  };
  assert.equal(statementExclusion(response), "لا تُعرض الأرصدة لهذا العميل");
  assert.match(statementExclusion({ excluded: true, reason: "display_only" })!, /للعرض فقط/);
  assert.equal(statementExclusion({ excluded: false }), null);
});

// The supplier branch still runs the untouched original HTML template.
// Comparing against it catches accidental changes to the extracted customer
// markup/CSS while checking that web and native consume identical HTML.
const normalize = (html: string) => html
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\s+/g, " ")
  .replace(/>\s+</g, "><")
  .trim();

test("native and web render the original statement header, lines and footer", async () => {
  const opts: ExportStatementPdfOpts = {
    mode: "customer", company: {
      nameAr: "شركة العربية", logo: "data:image/png;base64,AA",
      crNumber: "100", vatNumber: "300", city: "الرياض",
    },
    account: { code: "120", partyNameAr: "عميل <script>", partyNameEn: "Customer", level: 2 },
    from: "2026-01-01", to: "2026-01-31", opening: -10,
    lines: [{
      id: 1, date: "2026-01-10", type: "فاتورة",
      docType: "فاتورة مبيعات", description: "شرح <b>عربي",
      debit: 30, credit: 0, balance: 20,
    }],
    totals: { debit: 30, credit: 0 }, closing: 20,
    filename: "كشف العميل", userName: "الموظف", autoPrint: false,
  };
  const url = URL as typeof URL & { createObjectURL: (blob: Blob) => string; revokeObjectURL: (url: string) => void };
  const originalCreate = url.createObjectURL;
  const originalRevoke = url.revokeObjectURL;
  const originalWindow = (globalThis as any).window;
  let captured: Blob | undefined;
  url.createObjectURL = (blob: Blob) => { captured = blob; return "blob:test"; };
  url.revokeObjectURL = () => {};
  (globalThis as any).window = { open: () => null };
  const webHtml = async (options: ExportStatementPdfOpts): Promise<string> => {
    captured = undefined;
    exportStatementToPDF(options);
    assert.ok(captured, "web print creates an HTML blob");
    return captured.text();
  };
  try {
    const native = renderStatementHtml(opts);
    assert.equal(await webHtml(opts), native, "web adapter and mobile use the same pure renderer");
    assert.match(native, /عميل &lt;script&gt;/);
    assert.match(native, /شرح &lt;b&gt;عربي/);
    assert.match(native, /2026-01-01/);
    assert.match(native, /2026-01-31/);
    assert.match(native, /class="mono num">10\.00/);
    assert.match(native, /class="mono num debit">30\.00/);
    assert.match(native, /class="mono num strong">20\.00/);
    assert.match(native, /اسم المستخدم: الموظف/);
    assert.match(native, /table\.page-frame > thead \{ display: table-header-group; \}/);

    // Supplier/general still use the original browser template, so their
    // output provides an independent reference for unchanged shared markup.
    for (const lines of [opts.lines, []]) {
      const supplier = { ...opts, mode: "supplier" as const, lines };
      assert.equal(normalize(renderStatementHtml(supplier)), normalize(await webHtml(supplier)));
    }
    const hidden = {
      ...opts, mode: "general" as const,
      visibleCols: { docType: false, description: false, date: false },
    };
    assert.equal(normalize(renderStatementHtml(hidden)), normalize(await webHtml(hidden)));
  } finally {
    url.createObjectURL = originalCreate;
    url.revokeObjectURL = originalRevoke;
    (globalThis as any).window = originalWindow;
  }
});