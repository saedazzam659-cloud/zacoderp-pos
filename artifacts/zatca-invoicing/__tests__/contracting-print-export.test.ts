import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as XLSX from "xlsx";
import { safeSpreadsheetText } from "../src/lib/export.ts";

const contractingSource = readFileSync(
  new URL("../src/lib/contractingPrintExport.ts", import.meta.url),
  "utf8",
);
const salesSource = readFileSync(
  new URL("../src/pages/sales/SalesPrintModal.tsx", import.meta.url),
  "utf8",
);

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
});

test("contracting export rows preserve typed money cells and protect formula text", () => {
  const rows = [{
    recordType: "ملخص مستخلص",
    billNumber: "PB-11",
    currentWorks: 100,
    netAmount: 115,
    project: "P-7 — مشروع حقيقي",
  }];
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "المستخلص");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  assert.equal(bytes.subarray(0, 2).toString("ascii"), "PK");
  const currentWorksCell = sheet[XLSX.utils.encode_cell({ c: 2, r: 1 })];
  assert.equal(typeof currentWorksCell?.v, "number");
  assert.equal(safeSpreadsheetText("=HYPERLINK(\"https://example.test\")"), "'=HYPERLINK(\"https://example.test\")");
});

test("contracting PDF action reaches the real byte-producing generator", () => {
  assert.match(contractingSource, /downloadHtmlAsPdf\(buildContractingModel14Html\(prepared\), filename, \{ orientation: "portrait" \}\)/);
  assert.match(readFileSync(new URL("../src/lib/export.ts", import.meta.url), "utf8"), /saveBlob\(pdf\.output\("blob"\), `\$\{filename\}\.pdf`\)/);
});