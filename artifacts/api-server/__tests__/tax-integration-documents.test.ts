import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeEtaJson, serializeEtaJsonWire, verifyEtaCadesBes } from "../src/lib/eta-cades-bes.ts";
import { buildEtaSignedInvoice, buildJordanUblInvoiceXml, type TaxInvoiceSnapshot } from "../src/lib/taxInvoiceDocuments.ts";

const snapshot = (country: "EG" | "JO", currency: "EGP" | "JOD"): TaxInvoiceSnapshot => ({
  invoice: {
    id: 42,
    docNumber: "SI-42",
    invoiceDate: "2026-09-29",
    postedAt: "2026-09-29T09:30:00.000Z",
    status: "posted",
    paymentType: "cash",
    currencyCode: currency,
    exchangeRate: "1",
    subtotal: "100",
    vatAmount: country === "EG" ? "14" : "16",
    discountAmount: "0",
    totalAmount: country === "EG" ? "114" : "116",
    priceIncludesVat: false,
  },
  company: {
    country,
    nameAr: "شركة مثال",
    nameEn: "Example Co",
    vatNumber: country === "EG" ? "EG-TAX-123" : "JO-TAX-123",
    crNumber: "CR-123",
    city: "Amman",
    district: null,
    street: "Main Street",
    buildingNumber: "12",
    postalCode: "11181",
    additionalNumber: null,
    phone: null,
  },
  customer: {
    nameAr: "عميل",
    nameEn: "Customer",
    vatNumber: null,
    crNumber: null,
    country,
    city: "Amman",
    district: null,
    street: "Second Street",
    buildingNumber: "7",
    postalCode: "11181",
  },
  lines: [{
    itemName: "Tea & coffee",
    itemCode: "EGS-12345",
    unit: "قطعة",
    qty: "1",
    unitPrice: "100",
    discount: "0",
    discountAmount: "0",
    vatRate: country === "EG" ? "14" : "16",
  }],
});

test("Egypt ETA mapping signs a posted invoice and emits valid wire JSON using mock keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "tax-invoice-eg-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-passout", "pass:local-passphrase",
      "-keyout", keyPath, "-out", certPath, "-days", "1",
      "-subj", "/CN=ETA local invoice test",
    ], { stdio: "ignore" });
    const privateKey = readFileSync(keyPath, "utf8");
    const certificate = readFileSync(certPath, "utf8");
    const document = buildEtaSignedInvoice(snapshot("EG", "EGP"), {
      taxpayerId: "123456789",
      taxpayerActivityCode: "4620",
      branchCode: "0",
      signingCertificate: certificate,
      signingPrivateKey: privateKey,
      signingPrivateKeyPassphrase: "local-passphrase",
    });
    const signatures = document.signatures as Array<{ signatureType: string; value: string }>;
    assert.equal(signatures.length, 1);
    assert.equal(signatures[0].signatureType, "I");
    const unsigned = { ...document };
    delete unsigned.signatures;
    assert.equal(verifyEtaCadesBes(serializeEtaJson(unsigned), signatures[0].value, certificate), true);
    const wire = JSON.parse(serializeEtaJsonWire(document));
    assert.equal(wire.invoiceLines[0].unitType, "EA");
    assert.equal(wire.invoiceLines[0].netTotal, 100);
    assert.equal(wire.totalAmount, 114);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Jordan mapping builds escaped UBL 2.1 XML without contacting the provider", () => {
  const xml = buildJordanUblInvoiceXml(snapshot("JO", "JOD"), "5e6f11c0-a4a2-44d7-9770-5889150d3a53");
  assert.match(xml, /<cbc:UBLVersionID>2\.1<\/cbc:UBLVersionID>/);
  assert.match(xml, /<cbc:UUID>5e6f11c0-a4a2-44d7-9770-5889150d3a53<\/cbc:UUID>/);
  assert.match(xml, /Tea &amp; coffee/);
  assert.match(xml, /<cbc:DocumentCurrencyCode>JOD<\/cbc:DocumentCurrencyCode>/);
  assert.match(xml, /<cbc:TaxInclusiveAmount currencyID="JOD">116\.000<\/cbc:TaxInclusiveAmount>/);
});

test("country mappings reject unposted invoices, unsupported exempt rates, and non-JOD Jordan invoices", () => {
  const draft = snapshot("EG", "EGP");
  draft.invoice.status = "draft";
  assert.throws(() => buildEtaSignedInvoice(draft, {
    taxpayerId: "123456789",
    taxpayerActivityCode: "4620",
    branchCode: "0",
    signingCertificate: "unused",
    signingPrivateKey: "unused",
  }), /ترحيل الفاتورة/);

  const exempt = snapshot("EG", "EGP");
  exempt.lines[0].vatRate = "0";
  assert.throws(() => buildEtaSignedInvoice(exempt, {
    taxpayerId: "123456789",
    taxpayerActivityCode: "4620",
    branchCode: "0",
    signingCertificate: "unused",
    signingPrivateKey: "unused",
  }), /نسبة 0%/);

  assert.throws(() => buildJordanUblInvoiceXml(snapshot("JO", "EGP")), /عملة الفاتورة JOD/);
});