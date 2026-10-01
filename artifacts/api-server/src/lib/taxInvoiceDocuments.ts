import { randomUUID } from "node:crypto";
import { EtaDecimal, signEtaCadesBes } from "./eta-cades-bes.js";

export interface TaxInvoiceLineSnapshot {
  itemName: string;
  itemCode: string | null;
  unit: string | null;
  qty: string | number;
  unitPrice: string | number;
  discount: string | number | null;
  discountAmount: string | number | null;
  vatRate: string | number | null;
  /** Present only for explicitly mapped contracting owner-bill lines. */
  providerMapping?: {
    providerItemCode: string;
    providerUnitCode: string;
    providerTaxCategoryCode: string;
  };
}

export interface TaxInvoiceSnapshot {
  invoice: {
    id: number;
    docNumber: string | null;
    invoiceDate: string | Date;
    postedAt: string | Date | null;
    status: string;
    paymentType: string | null;
    currencyCode: string | null;
    exchangeRate: string | number | null;
    subtotal: string | number;
    vatAmount: string | number;
    discountAmount: string | number;
    totalAmount: string | number;
    priceIncludesVat: boolean | null;
  };
  company: {
    country: string;
    nameAr: string;
    nameEn: string | null;
    vatNumber: string;
    crNumber: string;
    city: string;
    district: string | null;
    street: string;
    buildingNumber: string;
    postalCode: string;
    additionalNumber: string | null;
    phone: string | null;
  };
  customer: {
    nameAr: string;
    nameEn: string | null;
    vatNumber: string | null;
    crNumber: string | null;
    country: string | null;
    city: string | null;
    district: string | null;
    street: string | null;
    buildingNumber: string | null;
    postalCode: string | null;
  } | null;
  lines: TaxInvoiceLineSnapshot[];
}

export interface EtaSigningCredentials {
  taxpayerId: string;
  taxpayerActivityCode: string;
  branchCode: string;
  signingCertificate: string;
  signingPrivateKey: string;
  signingPrivateKeyPassphrase?: string;
}

function numeric(value: string | number | null | undefined, label: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid number`);
  return parsed;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function decimal(value: number, digits = 2): EtaDecimal {
  if (!Number.isFinite(value)) throw new Error("Invoice contains an invalid decimal value");
  return new EtaDecimal(round(value, digits).toFixed(digits));
}

function text(value: string | null | undefined, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required before sending this invoice`);
  return normalized;
}

function issuedAt(invoice: TaxInvoiceSnapshot["invoice"]): string {
  const value = invoice.postedAt ?? invoice.invoiceDate;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invoice issue date is invalid");
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const UNIT_ALIASES: Record<string, string> = {
  ea: "EA",
  each: "EA",
  piece: "EA",
  pieces: "EA",
  pcs: "EA",
  pce: "EA",
  "قطعة": "EA",
  "وحدة": "EA",
  kg: "KGM",
  kilogram: "KGM",
  kilograms: "KGM",
  "كجم": "KGM",
  "كيلو": "KGM",
  g: "GRM",
  gram: "GRM",
  grams: "GRM",
  "جرام": "GRM",
  l: "LTR",
  liter: "LTR",
  litre: "LTR",
  "لتر": "LTR",
  m: "MTR",
  meter: "MTR",
  metre: "MTR",
  "متر": "MTR",
  box: "BX",
  carton: "CT",
  bx: "BX",
  ct: "CT",
  kgm: "KGM",
  grm: "GRM",
  ltr: "LTR",
  mtr: "MTR",
};

function etaUnit(value: string | null): string {
  const source = text(value, "وحدة القياس");
  const mapped = UNIT_ALIASES[source.toLowerCase()];
  if (!mapped) throw new Error(`وحدة القياس «${source}» غير مدعومة؛ استخدم رمز ETA/UBL معروفاً للصنف.`);
  return mapped;
}

function taxRate(value: string | number | null, label: string): number {
  const rate = numeric(value, label);
  if (rate < 0 || rate > 999) throw new Error(`${label} is outside the supported range`);
  if (rate === 0) {
    throw new Error("يجب تحديد سبب الإعفاء/عدم الخضوع لكل بند قبل إرساله؛ نسبة 0% وحدها لا تحدد رمز ETA.");
  }
  return rate;
}

interface CalculatedLine {
  source: TaxInvoiceLineSnapshot;
  qty: number;
  rate: number;
  unitPriceExcl: number;
  salesTotal: number;
  netBeforeHeaderDiscount: number;
}

function calculateLines(snapshot: TaxInvoiceSnapshot, currency: "EGP" | "JOD") {
  if (snapshot.lines.length === 0) throw new Error("الفاتورة لا تحتوي على بنود قابلة للإرسال.");
  const exchangeRate = numeric(snapshot.invoice.exchangeRate, "سعر الصرف") || 1;
  if (currency === "JOD" && String(snapshot.invoice.currencyCode).toUpperCase() !== "JOD") {
    throw new Error("إرسال الأردن يتطلب أن تكون عملة الفاتورة JOD.");
  }
  if (currency === "EGP" && String(snapshot.invoice.currencyCode).toUpperCase() !== "EGP" && exchangeRate <= 0) {
    throw new Error("سعر تحويل العملة إلى الجنيه المصري غير صالح.");
  }
  const fx = currency === "JOD" ? 1 : exchangeRate;
  const includesVat = Boolean(snapshot.invoice.priceIncludesVat);

  const calculated: CalculatedLine[] = snapshot.lines.map((line, index) => {
    const qty = numeric(line.qty, `كمية البند ${index + 1}`);
    const price = numeric(line.unitPrice, `سعر البند ${index + 1}`);
    const rate = taxRate(line.vatRate, `ضريبة البند ${index + 1}`);
    const discountPct = numeric(line.discount, `خصم البند ${index + 1}`);
    const discountFixed = numeric(line.discountAmount, `خصم البند ${index + 1}`);
    if (qty <= 0 || price < 0 || discountPct < 0 || discountPct > 100 || discountFixed < 0) {
      throw new Error(`بيانات البند ${index + 1} غير صالحة للإرسال.`);
    }
    const taxFactor = 1 + rate / 100;
    const unitPriceExcl = includesVat ? price / taxFactor : price;
    const gross = qty * unitPriceExcl;
    const lineDiscount = includesVat
      ? (gross * discountPct / 100) + (discountFixed / taxFactor)
      : (gross * discountPct / 100) + discountFixed;
    const netBeforeHeaderDiscount = Math.max(0, gross - lineDiscount);
    return {
      source: line,
      qty,
      rate,
      unitPriceExcl,
      salesTotal: gross * fx,
      netBeforeHeaderDiscount: netBeforeHeaderDiscount * fx,
    };
  });

  const invoiceTotal = numeric(snapshot.invoice.totalAmount, "إجمالي الفاتورة") * fx;
  const invoiceTax = numeric(snapshot.invoice.vatAmount, "ضريبة الفاتورة") * fx;
  const targetNet = invoiceTotal - invoiceTax;
  const targetTax = invoiceTax;
  const sumNet = calculated.reduce((sum, line) => sum + line.netBeforeHeaderDiscount, 0);
  if (targetNet < 0 || targetTax < 0 || sumNet <= 0) {
    throw new Error("إجماليات الفاتورة لا تسمح ببناء مستند ضريبي صالح.");
  }
  const factor = targetNet / sumNet;
  let netRunning = 0;
  let taxRunning = 0;
  const lines = calculated.map((line, index) => {
    const last = index === calculated.length - 1;
    const net = last ? round(targetNet - netRunning) : round(line.netBeforeHeaderDiscount * factor);
    let tax = round(net * line.rate / 100);
    if (last) tax = round(targetTax - taxRunning);
    if (tax < 0) throw new Error("ضريبة الفاتورة لا تتطابق مع نسب ضريبة البنود.");
    netRunning = round(netRunning + net);
    taxRunning = round(taxRunning + tax);
    return { ...line, net, tax };
  });

  if (Math.abs(taxRunning - targetTax) > 0.02 || Math.abs(netRunning + taxRunning - invoiceTotal) > 0.02) {
    throw new Error("إجماليات البنود لا تتطابق مع إجمالي الفاتورة؛ راجع الخصومات والضريبة قبل الإرسال.");
  }
  return { lines, totalSales: round(calculated.reduce((s, l) => s + l.salesTotal, 0)), net: netRunning, tax: taxRunning, total: round(netRunning + taxRunning), fx };
}

function countryAddress(country: string, city: string, district: string | null, street: string | null, building: string | null, postal: string | null) {
  return {
    country,
    governate: city,
    regionCity: city,
    street: text(street, "الشارع"),
    buildingNumber: text(building, "رقم المبنى"),
    ...(postal?.trim() ? { postalCode: postal.trim() } : {}),
    ...(district?.trim() ? { additionalInformation: district.trim() } : {}),
  };
}

export function buildEtaSignedInvoice(
  snapshot: TaxInvoiceSnapshot,
  credentials: EtaSigningCredentials,
): Record<string, unknown> {
  if (snapshot.invoice.status !== "posted") throw new Error("يجب ترحيل الفاتورة قبل إرسالها إلى ETA.");
  if (snapshot.company.country.toUpperCase() !== "EG") throw new Error("فاتورة الشركة ليست مصرية.");
  const totals = calculateLines(snapshot, "EGP");
  const issuerName = text(snapshot.company.nameEn || snapshot.company.nameAr, "اسم الشركة");
  const customer = snapshot.customer;
  if (!customer) throw new Error("اختر عميلاً مسجلاً على الفاتورة قبل إرسالها إلى ETA.");
  const receiverName = text(customer.nameEn || customer.nameAr, "اسم العميل");
  const receiverId = customer.vatNumber?.trim() || customer.crNumber?.trim();
  const receiverCountry = (customer.country || "EG").trim().toUpperCase();
  const receiverCity = text(customer.city, "مدينة العميل");
  const issuerAddress = {
    branchID: text(credentials.branchCode, "كود فرع ETA"),
    ...countryAddress(
      "EG",
      text(snapshot.company.city, "مدينة الشركة"),
      snapshot.company.district,
      snapshot.company.street,
      snapshot.company.buildingNumber,
      snapshot.company.postalCode,
    ),
  };
  const receiverAddress = countryAddress(
    receiverCountry,
    receiverCity,
    customer.district,
    customer.street,
    customer.buildingNumber,
    customer.postalCode,
  );
  const taxSubtype = (rate: number) => Math.abs(rate - 14) < 0.001 ? "V009" : "V010";
  const document = {
    issuer: {
      address: issuerAddress,
      type: "B",
      id: text(credentials.taxpayerId, "رقم تسجيل ETA"),
      name: issuerName,
    },
    receiver: {
      address: receiverAddress,
      type: receiverId ? "B" : "P",
      ...(receiverId ? { id: receiverId } : {}),
      name: receiverName,
    },
    documentType: "I",
    documentTypeVersion: "1.0",
    dateTimeIssued: issuedAt(snapshot.invoice),
    taxpayerActivityCode: text(credentials.taxpayerActivityCode, "كود النشاط المسجل لدى ETA"),
    internalID: snapshot.invoice.docNumber?.trim() || `SI-${snapshot.invoice.id}`,
    payment: {
      terms: snapshot.invoice.paymentType?.trim() || "غير محدد",
    },
    invoiceLines: totals.lines.map((line) => {
      const mapping = line.source.providerMapping;
      const itemCode = text(mapping?.providerItemCode ?? line.source.itemCode, "كود ETA للصنف");
      return {
        description: text(line.source.itemName, "وصف البند"),
        itemType: /^\d{8,14}$/.test(itemCode) ? "GS1" : "EGS",
        itemCode,
        unitType: mapping
          ? text(mapping.providerUnitCode, "وحدة ETA المرتبطة ببند BOQ")
          : etaUnit(line.source.unit),
        quantity: decimal(line.qty, 4),
        internalCode: itemCode,
        salesTotal: decimal(line.salesTotal),
        total: decimal(line.net + line.tax),
        netTotal: decimal(line.net),
        discount: {
          amount: decimal(Math.max(0, line.salesTotal - line.net)),
        },
        unitValue: {
          currencySold: (snapshot.invoice.currencyCode || "EGP").toUpperCase(),
          amountEGP: decimal(line.unitPriceExcl * totals.fx, 5),
          amountSold: decimal(line.unitPriceExcl, 5),
          currencyExchangeRate: decimal(totals.fx, 5),
        },
        taxableItems: [{
          taxType: "T1",
          amount: decimal(line.tax),
          subType: mapping
            ? text(mapping.providerTaxCategoryCode, "الفئة الضريبية المرتبطة ببند BOQ")
            : taxSubtype(line.rate),
          rate: decimal(line.rate),
        }],
      };
    }),
    totalDiscountAmount: decimal(Math.max(0, totals.totalSales - totals.net)),
    totalSalesAmount: decimal(totals.totalSales),
    netAmount: decimal(totals.net),
    taxTotals: [{ taxType: "T1", amount: decimal(totals.tax) }],
    totalAmount: decimal(totals.total),
  };
  const signed = signEtaCadesBes(
    document,
    credentials.signingCertificate,
    credentials.signingPrivateKey,
    credentials.signingPrivateKeyPassphrase,
  );
  return {
    ...document,
    signatures: [{ signatureType: "I", value: signed.signature }],
  };
}

function xml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
}

function jodAmount(value: number): string {
  return round(value, 3).toFixed(3);
}

/**
 * Creates a UBL 2.1 Invoice envelope as required by the ISTD linking manual.
 * Jordan currently documents one production invoice endpoint but no official
 * public sandbox. Keep the profile conservative and subject to provider
 * acceptance testing before being used for statutory production invoices.
 */
export function buildJordanUblInvoiceXml(snapshot: TaxInvoiceSnapshot, uuid: string = randomUUID()): string {
  if (snapshot.invoice.status !== "posted") throw new Error("يجب ترحيل الفاتورة قبل إرسالها إلى نظام الأردن.");
  if (snapshot.company.country.toUpperCase() !== "JO") throw new Error("فاتورة الشركة ليست أردنية.");
  const totals = calculateLines(snapshot, "JOD");
  const explicitlyMapped = totals.lines.every(line => line.source.providerMapping != null);
  if (!explicitlyMapped && totals.lines.some(line => Math.abs(line.rate - 16) > 0.001)) {
    throw new Error("إرسال الأردن يتطلب حالياً ضريبة مبيعات 16% لكل البنود؛ لا ترسل بنداً معفياً أو بنسبة أخرى.");
  }
  const companyName = text(snapshot.company.nameEn || snapshot.company.nameAr, "اسم الشركة");
  const customer = snapshot.customer;
  if (!customer) throw new Error("اختر عميلاً على الفاتورة قبل إرسالها إلى JoFotara.");
  const customerName = text(customer.nameEn || customer.nameAr, "اسم العميل");
  const date = new Date(snapshot.invoice.invoiceDate);
  if (Number.isNaN(date.getTime())) throw new Error("تاريخ الفاتورة غير صالح.");
  const issueDate = date.toISOString().slice(0, 10);
  const issueTime = issuedAt(snapshot.invoice).slice(11, 19) + "Z";
  const currency = "JOD";
  const docNumber = snapshot.invoice.docNumber?.trim() || `SI-${snapshot.invoice.id}`;
  const paymentCode = snapshot.invoice.paymentType === "cash" ? "10"
    : snapshot.invoice.paymentType === "card" ? "48" : "30";
  const lines = totals.lines.map((line, index) => {
    const mapping = line.source.providerMapping;
    const code = mapping
      ? text(mapping.providerUnitCode, "وحدة JoFotara المرتبطة ببند BOQ")
      : etaUnit(line.source.unit);
    const category = mapping
      ? text(mapping.providerTaxCategoryCode, "الفئة الضريبية المرتبطة ببند BOQ")
      : "S";
    const discount = Math.max(0, line.salesTotal - line.net);
    const itemIdentifier = mapping
      ? `<cac:SellersItemIdentification><cbc:ID>${xml(mapping.providerItemCode)}</cbc:ID></cac:SellersItemIdentification>`
      : "";
    return `<cac:InvoiceLine><cbc:ID>${index + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="${xml(code)}">${line.qty}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="${currency}">${jodAmount(line.net)}</cbc:LineExtensionAmount>${discount > 0 ? `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason><cbc:Amount currencyID="${currency}">${jodAmount(discount)}</cbc:Amount></cac:AllowanceCharge>` : ""}<cac:TaxTotal><cbc:TaxAmount currencyID="${currency}">${jodAmount(line.tax)}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="${currency}">${jodAmount(line.net)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${currency}">${jodAmount(line.tax)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${xml(category)}</cbc:ID><cbc:Percent>${line.rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal><cac:Item><cbc:Name>${xml(line.source.itemName)}</cbc:Name>${itemIdentifier}<cac:ClassifiedTaxCategory><cbc:ID>${xml(category)}</cbc:ID><cbc:Percent>${line.rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="${currency}">${jodAmount(line.unitPriceExcl)}</cbc:PriceAmount><cbc:BaseQuantity unitCode="${xml(code)}">1</cbc:BaseQuantity></cac:Price></cac:InvoiceLine>`;
  }).join("");
  const taxGroups = new Map<string, { category: string; rate: number; taxable: number; tax: number }>();
  for (const line of totals.lines) {
    const category = line.source.providerMapping?.providerTaxCategoryCode ?? "S";
    const key = `${category}\u0000${line.rate}`;
    const group = taxGroups.get(key) ?? { category, rate: line.rate, taxable: 0, tax: 0 };
    group.taxable = round(group.taxable + line.net);
    group.tax = round(group.tax + line.tax);
    taxGroups.set(key, group);
  }
  const taxSubtotals = [...taxGroups.values()].map(group =>
    `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="${currency}">${jodAmount(group.taxable)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${currency}">${jodAmount(group.tax)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${xml(group.category)}</cbc:ID><cbc:Percent>${group.rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`,
  ).join("");
  const customerTax = customer.vatNumber?.trim() || customer.crNumber?.trim();
  const sellerCountry = "JO";
  const buyerCountry = (customer.country || "JO").toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:ID>${xml(docNumber)}</cbc:ID><cbc:UUID>${xml(uuid)}</cbc:UUID><cbc:IssueDate>${issueDate}</cbc:IssueDate><cbc:IssueTime>${issueTime}</cbc:IssueTime><cbc:InvoiceTypeCode>388</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode><cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="TN">${xml(text(snapshot.company.vatNumber, "الرقم الضريبي للشركة"))}</cbc:ID></cac:PartyIdentification><cac:PostalAddress><cbc:CityName>${xml(text(snapshot.company.city, "مدينة الشركة"))}</cbc:CityName><cbc:StreetName>${xml(text(snapshot.company.street, "شارع الشركة"))}</cbc:StreetName><cbc:BuildingNumber>${xml(text(snapshot.company.buildingNumber, "رقم مبنى الشركة"))}</cbc:BuildingNumber><cac:Country><cbc:IdentificationCode>${sellerCountry}</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>${xml(snapshot.company.vatNumber)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${xml(companyName)}</cbc:RegistrationName><cbc:CompanyID>${xml(snapshot.company.crNumber || snapshot.company.vatNumber)}</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty><cac:AccountingCustomerParty><cac:Party>${customerTax ? `<cac:PartyIdentification><cbc:ID schemeID="TN">${xml(customerTax)}</cbc:ID></cac:PartyIdentification>` : ""}<cac:PostalAddress><cbc:CityName>${xml(customer.city || snapshot.company.city)}</cbc:CityName>${customer.street ? `<cbc:StreetName>${xml(customer.street)}</cbc:StreetName>` : ""}${customer.buildingNumber ? `<cbc:BuildingNumber>${xml(customer.buildingNumber)}</cbc:BuildingNumber>` : ""}<cac:Country><cbc:IdentificationCode>${xml(buyerCountry)}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>${customerTax ? `<cac:PartyTaxScheme><cbc:CompanyID>${xml(customerTax)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ""}<cac:PartyLegalEntity><cbc:RegistrationName>${xml(customerName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty><cac:PaymentMeans><cbc:PaymentMeansCode>${paymentCode}</cbc:PaymentMeansCode></cac:PaymentMeans><cac:TaxTotal><cbc:TaxAmount currencyID="${currency}">${jodAmount(totals.tax)}</cbc:TaxAmount>${taxSubtotals}</cac:TaxTotal><cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="${currency}">${jodAmount(totals.net)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="${currency}">${jodAmount(totals.net)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="${currency}">${jodAmount(totals.total)}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="${currency}">${jodAmount(totals.total)}</cbc:PayableAmount></cac:LegalMonetaryTotal>${lines}</Invoice>`;
}

export function newJordanDocumentUuid(): string {
  return randomUUID();
}