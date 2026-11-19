import assert from "node:assert/strict";
import test from "node:test";
import {
  describeFileReadError,
  LocalPdfFileRangeTransport,
  openLocalPdf,
  PDF_FILE_RANGE_CHUNK_SIZE,
} from "../src/lib/localPdfFile.ts";

function makeTextPdf(paddingBytes = 0): string {
  const content = "BT /F1 12 Tf 72 200 Td (HELLO RANGE) Tj ET\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += object;
  }

  // Keep the PDF valid while making its xref table distant from its objects.
  if (paddingBytes > 0) pdf += `\n%${"x".repeat(paddingBytes)}\n`;
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

test("local PDF range transport reads only the requested byte slice", async () => {
  const transport = new LocalPdfFileRangeTransport(
    new Blob([new Uint8Array([10, 20, 30, 40, 50, 60])]),
    "range-test.pdf",
  );
  const result = new Promise<{ begin: number; bytes: Uint8Array }>((resolve) => {
    transport.addRangeListener((begin, bytes) => resolve({ begin, bytes }));
  });

  transport.requestDataRange(2, 5);
  const received = await result;
  assert.equal(received.begin, 2);
  assert.deepEqual([...received.bytes], [30, 40, 50]);
  assert.equal(transport.bytesRead, 3);
  assert.equal(PDF_FILE_RANGE_CHUNK_SIZE, 256 * 1024);
});

test("opens a large local PDF in bounded byte ranges and extracts its text", async () => {
  const pdf = makeTextPdf(2 * 1024 * 1024);
  const file = new Blob([pdf], { type: "application/pdf" });
  const { document, transport } = await openLocalPdf(file, "large-range-test.pdf");

  try {
    assert.equal(document.numPages, 1);
    const page = await document.getPage(1);
    const text = await page.getTextContent();
    assert.match(text.items.map((item) => item.str).join(" "), /HELLO RANGE/);
    assert.equal(transport.bytesRead, file.size);
    assert.ok(
      transport.largestRangeRequested < PDF_FILE_RANGE_CHUNK_SIZE * 2,
      `largest range was ${transport.largestRangeRequested} bytes`,
    );
  } finally {
    await document.destroy();
  }
});

test("shows readable details from plain PDF.js error objects", () => {
  assert.equal(
    describeFileReadError({ name: "UnknownErrorException", message: "Worker initialization failed" }),
    "UnknownErrorException: Worker initialization failed",
  );
});
