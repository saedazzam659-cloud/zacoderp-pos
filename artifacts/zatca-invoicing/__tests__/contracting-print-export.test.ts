import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const contractingSource = readFileSync(
  new URL("../src/lib/contractingPrintExport.ts", import.meta.url),
  "utf8",
);
const salesSource = readFileSync(
  new URL("../src/pages/sales/SalesPrintModal.tsx", import.meta.url),
  "utf8",
);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function productionContractingOutput(snapshot: Record<string, unknown>) {
  // Transform production modules through Vite (without listening on a port),
  // which supplies `import.meta.env` and the app's alias resolution. This
  // exercises the real model-14 adapter and the real XLSX-row source.
  const server = await createServer({
    configFile: false,
    root: appRoot,
    plugins: [react()],
    resolve: { alias: { "@": path.join(appRoot, "src") } },
    server: { middlewareMode: true },
    // SSR-load exactly the production modules under test; do not launch the
    // dependency optimizer/scanner (it is unrelated to this pure render).
    optimizeDeps: { noDiscovery: true },
    appType: "custom",
  });
  try {
    const production = await server.ssrLoadModule("/src/lib/contractingPrintExport.ts");
    return {
      rows: production.buildContractingBillExportRows(snapshot),
      html: production.buildContractingModel14Html(snapshot),
    };
  } finally {
    await server.close();
  }
}

test("contracting model-14 adapter uses the actual shared frame and contracting labels", () => {
  assert.match(contractingSource, /import \{ template14 \} from "@\/pages\/sales\/SalesPrintModal";/);
  assert.match(contractingSource, /return template14\(\{/);
  assert.match(contractingSource, /مستخلص تقدم أعمال صادر للمالك/);
  assert.match(salesSource, /export function template14\(d: PrintData\)/);
  assert.match(salesSource, /const contracting = \(d as any\)._contracting/);
  assert.match(salesSource, /class="page-frame"/);
  assert.match(salesSource, /class="running-header"/);
  assert.match(salesSource, /class="running-footer"/);
  assert.match(salesSource, /class="doc-title-pill"/);
  assert.match(salesSource, /\$\{contracting\?\.footerLabel \?\? "ZATCA e-Invoice"\}/);
  assert.match(salesSource, /<span>الإضافات المالية<\/span>/);
});

test("contracting exports retain BOQ order and map the owner party into every bill row", () => {
  assert.match(contractingSource, /const party = text\(partyName\(snapshot\)\)/);
  assert.match(contractingSource, /\.\.\.lines\.map\(line => \(\{ \.\.\.reportRow\(snapshot\.bill, snapshot\.detail, line\), party \}\)\)/);
  assert.match(contractingSource, /project: text\(\[bill\.projectCode, bill\.projectName\]\.filter\(Boolean\)\.join\(" — "\)\)/);
  assert.match(contractingSource, /additions: summary\?\.additionsTotal \?\? bill\.additions/);
});

test("bill export actions hydrate authenticated company branding at click time", () => {
  const actionsSource = readFileSync(
    new URL("../src/components/ContractingExportActions.tsx", import.meta.url),
    "utf8",
  );
  assert.match(actionsSource, /company: snapshot\.company \?\? companyInfo\(user\)/);
});

test("production model-14 and XLSX rows separate retention from ordinary deductions", async () => {
  const snapshot = {
    bill: {
      id: 90, billNumber: "PB-90", billDate: "2026-03-10", direction: "outgoing",
      status: "approved", vatPercent: 15, grossAmount: 1000, netAmount: 1035,
      retentionAmount: 100, projectCode: "P-90", projectName: "مشروع اختبار",
    },
    project: { code: "P-90", nameAr: "مشروع اختبار" },
    ownerContract: { clientName: "مالك الاختبار" },
    company: { nameAr: "شركة الاختبار", vatNumber: "310000000000003" },
    detail: {
      lines: [],
      additions: [],
      deductions: [],
      penalties: [],
      summary: {
        currentWorks: 1000,
        cumulativeWorks: 1000,
        retentionAmount: 100,
        deductionsTotal: 125,
        generalDeductionsTotal: 25,
        vatAmount: 135,
        netAmount: 1035,
        adjustedNetAmount: 1035,
      },
    },
  } as any;

  const { rows, html } = await productionContractingOutput(snapshot);
  const [exportRow] = rows;
  assert.equal(exportRow.retentions, 100);
  assert.equal(exportRow.deductions, 25);

  assert.match(html, /<span>المحتجز<\/span><span class="mono">100\.00 ر\.س<\/span>/);
  assert.match(html, /<span>الاستقطاعات<\/span><span class="mono">25\.00 ر\.س<\/span>/);
  assert.doesNotMatch(html, /<span>الاستقطاعات<\/span><span class="mono">125\.00 ر\.س<\/span>/);
});

test("contracting PDF action reaches the real byte-producing generator", () => {
  assert.match(contractingSource, /downloadHtmlAsPdf\(buildContractingModel14Html\(prepared\), filename, \{ orientation: "portrait" \}\)/);
  assert.match(readFileSync(new URL("../src/lib/export.ts", import.meta.url), "utf8"), /saveBlob\(pdf\.output\("blob"\), `\$\{filename\}\.pdf`\)/);
});