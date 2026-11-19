import assert from "node:assert/strict";
import test from "node:test";
import { extractPdfCatalogFromGrid, extractPdfCatalogPage, gridHasBellaCity, hasUnparsedCatalogCodes, pdfCatalogItemsToGrid } from "../src/lib/pdfCatalogImport.ts";

const run = (str: string, x: number, y: number, width = str.length * 5) => ({ str, x, y, width });

test("extracts both side-by-side price tables and repeats each product title with its size", () => {
  const result = extractPdfCatalogPage([
    run("BELLA", 250, 820, 35), run("CITY", 288, 820, 25),
    run("متر مواسير PN 16", 45, 760, 130),
    run("متر مواسير PN 20", 450, 760, 130),
    // Two tables share a PDF text line, each with code, size and price headings.
    run("الكود", 190, 700, 30), run("المقاس", 130, 700, 35), run("السعر", 70, 700, 30),
    run("الكود", 595, 700, 30), run("المقاس", 535, 700, 35), run("السعر", 475, 700, 30),
    run("200016032", 185, 680, 50), run("32", 135, 680, 15), run("75.70", 68, 680, 30),
    run("200020020", 590, 680, 50), run("20", 540, 680, 15), run("30.95", 473, 680, 30),
  ]);

  assert.equal(result.detectedBrand, true);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items, [
    { nameAr: "متر مواسير PN 16 - مقاس 32", code: "200016032", salePrice: "75.70", size: "32", unit: "متر" },
    { nameAr: "متر مواسير PN 20 - مقاس 20", code: "200020020", salePrice: "30.95", size: "20", unit: "متر" },
  ]);

  assert.deepEqual(pdfCatalogItemsToGrid(result.items), [
    ["اسم الصنف", "الكود", "سعر البيع", "وحدة القياس"],
    ["متر مواسير PN 16 - مقاس 32", "200016032", "75.70", "متر"],
    ["متر مواسير PN 20 - مقاس 20", "200020020", "30.95", "متر"],
  ]);
});

test("keeps a continued product heading when the next page omits its title", () => {
  const firstPage = extractPdfCatalogPage([
    run("متر مواسير PN 16", 45, 760, 130),
    run("الكود", 190, 700, 30), run("المقاس", 130, 700, 35), run("السعر", 70, 700, 30),
  ]);
  const nextPage = extractPdfCatalogPage([
    run("الكود", 190, 700, 30), run("المقاس", 130, 700, 35), run("السعر", 70, 700, 30),
    run("200016050", 185, 680, 50), run("50", 135, 680, 15), run("172.25", 68, 680, 30),
  ], firstPage.productTitle);

  assert.deepEqual(nextPage.items.map((item) => [item.nameAr, item.code, item.salePrice, item.unit]), [
    ["متر مواسير PN 16 - مقاس 50", "200016050", "172.25", "متر"],
  ]);
});

test("does not output rows when table headings are incomplete", () => {
  const result = extractPdfCatalogPage([
    run("الكود", 190, 700, 30), run("المقاس", 130, 700, 35),
    run("200016032", 185, 680, 50), run("32", 135, 680, 15),
  ]);
  assert.equal(result.items.length, 0);
});

test("normalizes OCR grids with two adjacent tables", () => {
  const result = extractPdfCatalogFromGrid([
    ["متر مواسير PN 16", "", "", "", "", "", "متر مواسير PN 20"],
    ["", "السعر", "المقاس", "الكود", "", "السعر", "المقاس", "الكود"],
    ["", "75.70", "32", "200016032", "", "30.95", "20", "200020020"],
  ]);
  assert.deepEqual(result.items.map((item) => [item.nameAr, item.code, item.salePrice, item.unit]), [
    ["متر مواسير PN 16 - مقاس 32", "200016032", "75.70", "متر"],
    ["متر مواسير PN 20 - مقاس 20", "200020020", "30.95", "متر"],
  ]);
});

test("flags code-like rows that could not be extracted", () => {
  assert.equal(hasUnparsedCatalogCodes(["200016032", "BELLA CITY"], []), true);
  assert.equal(
    hasUnparsedCatalogCodes(["200016032"], [{ nameAr: "متر مواسير PN 16 - مقاس 32", code: "200016032", salePrice: "75.70", size: "32", unit: "متر" }]),
    false,
  );
});

test("detects the brand when OCR splits the words into separate cells", () => {
  assert.equal(gridHasBellaCity([["BELLA", "CITY"]]), true);
});
