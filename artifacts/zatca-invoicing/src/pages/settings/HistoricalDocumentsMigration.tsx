import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, CheckCircle2, FileDown, Loader2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { exportData, ensureFiscalYears, scanHistorical } from "@/lib/dataIoApi";
import { processInvoiceBatchQueue } from "@/lib/invoiceBatchQueue";
import {
  convertLinkedSalesInvoiceCsv,
  convertLinkedPurchaseOrderCsv,
  decodeInvoiceCsv,
  isInvoiceHeaderCsv,
  isInvoiceItemsCsv,
  isPurchaseOrderHeaderCsv,
} from "@/lib/historicalInvoiceCsvAdapter";

type Kind = "sales_invoice" | "purchase_invoice" | "sales_return" | "purchase_return" | "purchase_order";
type HistoricalImportMode = "financial_inventory" | "financial_only" | "inventory_only" | "archive_only";
type Master = Record<string, any[]>;
type Line = Record<string, any>;
type HistoricalDoc = {
  key: string;
  sourceFileName?: string;
  kind: Kind;
  sourceNumber: string;
  date: string;
  sourceDateTime?: string;
  sourceInvoiceNumber: string;
  partyName: string;
  branchOverrideCode?: string;
  paymentType: string;
  currencyCode: string;
  exchangeRate: number;
  subtotal: number;
  vatAmount: number;
  discountAmount: number;
  totalAmount: number;
  totalExpensesLoaded: number;
  priceIncludesVat: boolean;
  partyCode: string;
  branchCode: string;
  cashBoxCode: string;
  bankAccountCode: string;
  lines: Line[];
  issues: string[];
};

const kindLabels: Record<Kind, string> = {
  sales_invoice: "فاتورة مبيعات",
  purchase_invoice: "فاتورة مشتريات",
  sales_return: "مرتجع مبيعات",
  purchase_return: "مرتجع مشتريات",
  purchase_order: "أمر شراء",
};
const importModeLabels: Record<HistoricalImportMode, string> = {
  financial_inventory: "مالي ومخزني",
  financial_only: "مالي فقط",
  inventory_only: "مخزني فقط",
  archive_only: "أرشفة فقط",
};
const requiredHeaders = [
  "source_doc_number", "document_date", "party_code", "branch_code", "item_code",
  "warehouse_code", "qty", "unit_price", "line_total", "subtotal", "vat_amount",
  "discount_amount", "total_amount", "vat_rate", "payment_type", "currency_code",
  "exchange_rate", "price_includes_vat",
];
const reviewColumns = [
  ["source_doc_number", "رقم المصدر"], ["document_date", "التاريخ"],
  ["party_code", "كود العميل/المورد"], ["party_name", "اسم العميل/المورد"],
  ["branch_code", "كود الفرع"], ["item_code", "كود الصنف"], ["item_name", "اسم الصنف"],
  ["unit_code", "كود الوحدة"], ["unit_name", "اسم الوحدة"], ["warehouse_code", "كود المخزن"],
  ["qty", "الكمية"], ["free_qty", "مجاني"], ["unit_price", "سعر الوحدة"],
  ["discount_percent", "خصم %"], ["line_discount_amount", "خصم السطر"],
  ["vat_rate", "الضريبة %"], ["line_total", "إجمالي السطر"],
  ["subtotal", "الإجمالي قبل الضريبة"], ["vat_amount", "قيمة الضريبة"],
  ["discount_amount", "خصم المستند"], ["total_amount", "الإجمالي"],
  ["payment_type", "السداد"], ["currency_code", "العملة"], ["exchange_rate", "سعر الصرف"],
  ["cash_box_code", "كود الخزنة"], ["bank_account_code", "كود البنك"],
  ["source_invoice_number", "الفاتورة الأصلية"], ["price_includes_vat", "السعر شامل الضريبة؟"],
  ["total_expenses_loaded", "مصاريف محملة"], ["line_notes", "ملاحظات السطر"],
] as const;

function norm(value: unknown) { return String(value ?? "").trim().toLocaleLowerCase(); }
function normalizePaymentType(value: unknown) {
  const raw = norm(value);
  const aliases: Record<string, string> = {
    credit: "credit", "آجل": "credit", "اجل": "credit", "على الحساب": "credit",
    cash: "cash", "نقدي": "cash", "نقدًا": "cash", "نقدا": "cash",
    bank: "bank", "بنكي": "bank", "بنك": "bank", "تحويل بنكي": "bank",
  };
  return aliases[raw] ?? raw;
}
function normalizeBoolean(value: unknown): boolean | null {
  const raw = norm(value);
  if (["true", "1", "yes", "نعم"].includes(raw)) return true;
  if (["false", "0", "no", "لا"].includes(raw)) return false;
  return null;
}
function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  if (raw.includes(",") && !/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) return NaN;
  const parsed = Number(raw.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}
function requiredNum(value: unknown): number {
  return value == null || String(value).trim() === "" ? NaN : num(value);
}
function validIsoDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
function indexByCode(rows: any[] = []) {
  const map = new Map<string, any[]>();
  for (const row of rows) {
    for (const key of [row.code, row.itemCode, row.branchCode, row.warehouseCode, row.vatNumber]) {
      const code = norm(key);
      if (!code) continue;
      const current = map.get(code) ?? [];
      current.push(row);
      map.set(code, current);
    }
  }
  return map;
}
function resolveCode(index: Map<string, any[]>, code: string, label: string, issues: string[]) {
  const matches = index.get(norm(code)) ?? [];
  const identities = new Map<any, any>();
  for (const row of matches) {
    const numericId = Number(row.id);
    identities.set(Number.isInteger(numericId) && numericId > 0 ? numericId : row, row);
  }
  const unique = [...identities.values()];
  if (unique.length !== 1) {
    issues.push(unique.length ? `${label}: الرمز "${code}" يطابق أكثر من سجل` : `${label}: الرمز "${code}" غير موجود`);
    return null;
  }
  return unique[0];
}
function resolveCodeOrName(rows: any[], index: Map<string, any[]>, code: string, name: string, label: string, issues: string[]) {
  const matches = index.get(norm(code)) ?? [];
  const uniqueCodeMatches = [...new Map(matches.map((row) => [row.id ?? row, row])).values()];
  if (uniqueCodeMatches.length === 1) return uniqueCodeMatches[0];
  if (uniqueCodeMatches.length > 1) {
    issues.push(`${label}: الرمز "${code}" يطابق أكثر من سجل`);
    return null;
  }
  const wantedName = norm(name);
  const nameMatches = wantedName
    ? rows.filter((row) => [row.nameAr, row.nameEn, row.name, row.partyName].some((value) => norm(value) === wantedName))
    : [];
  const uniqueNameMatches = [...new Map(nameMatches.map((row) => [row.id ?? row, row])).values()];
  if (uniqueNameMatches.length === 1) return uniqueNameMatches[0];
  if (uniqueNameMatches.length > 1) {
    issues.push(`${label}: الاسم "${name}" يطابق أكثر من سجل؛ أدخل الكود لتحديده.`);
  } else if (code || name) {
    issues.push(`${label}: لا يوجد تطابق للكود أو الاسم "${code || name}"`);
  } else {
    issues.push(`${label}: الكود أو الاسم مطلوب`);
  }
  return null;
}
async function stableKey(companyId: number, kind: Kind, sourceNumber: string, date: string) {
  const input = new TextEncoder().encode(`${companyId}|${kind}|${sourceNumber}|${date}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `hist-${hex}`;
}

function normalizeDate(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parts = XLSX.SSF.parse_date_code(value);
    if (parts) return `${String(parts.y).padStart(4, "0")}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
  }
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return raw;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function extractInvoiceRowsFromFile(
  file: File,
  kind: Kind,
  token: string | null,
  invoiceFormat: "generic" | "ragmcloud_v1",
) {
  if (file.size > 13_000_000) throw new Error("حجم الملف يتجاوز 13 ميجابايت؛ قسّمه أو استخدم نسخة أصغر.");
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const tabular = ["xlsx", "xls", "xlsm", "ods", "csv"].includes(extension);
  if (kind === "purchase_order" && !tabular) {
    throw new Error("استيراد أوامر الشراء متاح من ملفات CSV/Excel المنظمة؛ لا تستخدم OCR للفواتير في هذا المسار.");
  }
  const supported = [...(tabular ? ["xlsx", "xls", "xlsm", "ods", "csv"] : []), "pdf", "docx", "jpg", "jpeg", "png", "webp"];
  if (!supported.includes(extension)) {
    throw new Error(`صيغة .${extension || "?"} غير مدعومة. ارفع PDF أو Excel/CSV أو Word أو صورة.`);
  }

  let extractedText = "";
  if (tabular) {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
    const dataSheetName = workbook.SheetNames.find((name) => name === "بيانات الفواتير");
    const sheet = dataSheetName ? workbook.Sheets[dataSheetName] : workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error("الملف لا يحتوي على ورقة بيانات");
    const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "", raw: true });
    if (!rows.length) throw new Error("الملف فارغ");
    const headerMap = new Map(Object.keys(rows[0]).map((header) => [norm(header).replaceAll(" ", "_"), header]));
    if (requiredHeaders.every((header) => headerMap.has(header))) {
      const normalizedRows = rows.map((row) => Object.fromEntries([...headerMap].map(([canonical, original]) => [
        canonical,
        canonical === "document_date" ? normalizeDate(row[original]) : row[original],
      ])));
      return parseDocuments(normalizedRows, kind);
    }
    extractedText = workbook.SheetNames.map((name) => {
      const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
        header: 1, defval: "", raw: false, blankrows: false,
      });
      return `Sheet: ${name}\n${JSON.stringify(matrix)}`;
    }).join("\n\n");
  } else if (extension === "docx") {
    const mammoth: any = await import("mammoth");
    const result = await (mammoth.default ?? mammoth).extractRawText({ arrayBuffer: await file.arrayBuffer() });
    extractedText = String(result.value ?? "");
  }

  const body: Record<string, unknown> = { filename: file.name, kind, invoiceFormat };
  if (extractedText) {
    body.extractedText = extractedText;
  } else {
    const fallbackMime: Record<string, string> = {
      pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    };
    body.mime = file.type || fallbackMime[extension];
    body.documentBase64 = arrayBufferToBase64(await file.arrayBuffer());
  }
  const result = await requestJson("/api/ocr/extract-invoices", token, "POST", body);
  if (!Array.isArray(result?.rows) || !result.rows.length) {
    throw new Error("لم يعثر الملف على سطور فواتير قابلة للتحويل.");
  }
  return parseDocuments(result.rows, kind, true);
}

function parseDocuments(
  rows: any[],
  kind: Kind,
  preserveMissingValues = false,
  allowMissingPayment = false,
): HistoricalDoc[] {
  const grouped = new Map<string, HistoricalDoc>();
  rows.forEach((row) => {
    const sourceNumber = String(row.source_doc_number ?? "").trim();
    const date = String(row.document_date ?? "").trim().slice(0, 10);
    const key = `${kind}|${sourceNumber}`;
    let doc = grouped.get(key);
    if (!doc) {
      doc = {
        key, kind, sourceNumber, date,
        sourceDateTime: String(row.source_datetime ?? "").trim() || undefined,
        sourceInvoiceNumber: String(row.source_invoice_number ?? "").trim(),
        partyName: String(row.party_name ?? "").trim(),
        paymentType: preserveMissingValues
          ? normalizePaymentType(row.payment_type ?? "")
          : normalizePaymentType(row.payment_type ?? "credit") || "credit",
        currencyCode: preserveMissingValues
          ? String(row.currency_code ?? "").trim().toUpperCase()
          : String(row.currency_code ?? "SAR").trim().toUpperCase() || "SAR",
        exchangeRate: requiredNum(row.exchange_rate),
        subtotal: requiredNum(row.subtotal),
        vatAmount: requiredNum(row.vat_amount),
        discountAmount: requiredNum(row.discount_amount),
        totalAmount: requiredNum(row.total_amount),
        totalExpensesLoaded: num(row.total_expenses_loaded ?? 0),
        priceIncludesVat: normalizeBoolean(row.price_includes_vat ?? "false") === true,
        partyCode: String(row.party_code ?? "").trim(),
        branchCode: String(row.branch_code ?? "").trim(),
        cashBoxCode: String(row.cash_box_code ?? "").trim(),
        bankAccountCode: String(row.bank_account_code ?? "").trim(),
        lines: [],
        issues: [],
      };
      grouped.set(key, doc);
    } else if (doc.date !== date) {
      doc.issues.push(`رقم المستند ${sourceNumber} له أكثر من تاريخ في الملف`);
    }
    if (doc.lines.length > 0) {
      const repeatedFields: Array<[string, string, string]> = [
        ["party_code", doc.partyCode, String(row.party_code ?? "").trim()],
        ["party_name", doc.partyName, String(row.party_name ?? "").trim()],
        ["branch_code", doc.branchCode, String(row.branch_code ?? "").trim()],
        ["payment_type", doc.paymentType, preserveMissingValues
          ? normalizePaymentType(row.payment_type ?? "")
          : normalizePaymentType(row.payment_type ?? "credit") || "credit"],
        ["currency_code", doc.currencyCode, preserveMissingValues
          ? String(row.currency_code ?? "").trim().toUpperCase()
          : String(row.currency_code ?? "SAR").trim().toUpperCase() || "SAR"],
        ["source_invoice_number", doc.sourceInvoiceNumber, String(row.source_invoice_number ?? "").trim()],
        ["cash_box_code", doc.cashBoxCode, String(row.cash_box_code ?? "").trim()],
        ["bank_account_code", doc.bankAccountCode, String(row.bank_account_code ?? "").trim()],
      ];
      for (const [field, first, next] of repeatedFields) {
        if (first !== next) doc.issues.push(`قيمة ${field} تختلف بين سطور المستند`);
      }
      if (Math.abs(doc.exchangeRate - num(row.exchange_rate ?? 1)) > 0.000001) {
        doc.issues.push("قيمة exchange_rate تختلف بين سطور المستند");
      }
      if (doc.priceIncludesVat !== (normalizeBoolean(row.price_includes_vat) === true)) {
        doc.issues.push("قيمة price_includes_vat تختلف بين سطور المستند");
      }
    }
    if (!sourceNumber) doc.issues.push("رقم المستند المصدر مطلوب");
    if (!validIsoDate(date)) doc.issues.push("التاريخ غير صالح، استخدم YYYY-MM-DD");
    if (kind !== "purchase_order" && !allowMissingPayment && !String(row.payment_type ?? "").trim()) {
      doc.issues.push("طريقة السداد مطلوبة");
    }
    if (!String(row.currency_code ?? "").trim()) doc.issues.push("رمز العملة مطلوب");
    if (normalizeBoolean(row.price_includes_vat) === null) {
      doc.issues.push("حدد price_includes_vat بنعم أو لا");
    }
    if (!doc.partyCode && !doc.partyName) doc.issues.push("بيانات العميل/المورد غير مقروءة");
    if (!doc.branchCode) doc.issues.push("كود الفرع مطلوب");
    for (const keyName of ["exchangeRate", "subtotal", "vatAmount", "discountAmount", "totalAmount", "totalExpensesLoaded"] as const) {
      if (!Number.isFinite(doc[keyName])) doc.issues.push(`قيمة ${keyName} غير رقمية`);
    }
    if (doc.exchangeRate <= 0) doc.issues.push("سعر الصرف يجب أن يكون أكبر من صفر");
    if (doc.discountAmount < 0 || doc.totalExpensesLoaded < 0) doc.issues.push("الخصم والمصاريف المحمّلة لا يمكن أن تكون سالبة");
    const qty = requiredNum(row.qty);
    const unitPrice = requiredNum(row.unit_price);
    const lineTotal = requiredNum(row.line_total);
    const discount = num(row.discount_percent ?? 0);
    const lineDiscountAmount = num(row.line_discount_amount ?? 0);
    const vatRate = requiredNum(row.vat_rate);
    if (![qty, unitPrice, lineTotal, discount, lineDiscountAmount, vatRate].every(Number.isFinite)
      || qty <= 0 || unitPrice < 0 || lineTotal < 0 || discount < 0 || discount > 100 || lineDiscountAmount < 0 || vatRate < 0) {
      doc.issues.push("بيانات كمية/سعر/خصم/ضريبة غير صالحة");
    }
    doc.lines.push({
      itemCode: String(row.item_code ?? "").trim(),
      unitCode: String(row.unit_code ?? "").trim(),
      unitName: String(row.unit_name ?? "").trim(),
      warehouseCode: String(row.warehouse_code ?? "").trim(),
      qty, unitPrice, lineTotal, discount, vatRate,
      discountAmount: lineDiscountAmount,
      freeQty: num(row.free_qty ?? 0),
      itemName: String(row.item_name ?? "").trim(),
      notes: String(row.line_notes ?? "").trim() || null,
    });
    for (const [field, current, next] of [
      ["subtotal", doc.subtotal, requiredNum(row.subtotal)],
      ["vat_amount", doc.vatAmount, requiredNum(row.vat_amount)],
      ["discount_amount", doc.discountAmount, requiredNum(row.discount_amount)],
      ["total_amount", doc.totalAmount, requiredNum(row.total_amount)],
      ["total_expenses_loaded", doc.totalExpensesLoaded, num(row.total_expenses_loaded ?? 0)],
    ] as const) {
      if (Number.isFinite(current) && Number.isFinite(next) && Math.abs(current - next) > 0.01) {
        doc.issues.push(`قيمة ${field} تختلف بين سطور المستند`);
      }
    }
  });
  return [...grouped.values()];
}

const editableLineFields = new Set(["qty", "unit_price", "discount_percent", "line_discount_amount", "vat_rate", "line_total"]);
const editableTextLineFields = new Set(["item_code", "item_name"]);

function invalidLineField(line: Line): string | null {
  const checks: Array<[string, unknown, (value: number) => boolean]> = [
    ["qty", line.qty, (value) => value > 0],
    ["unit_price", line.unitPrice, (value) => value >= 0],
    ["discount_percent", line.discount, (value) => value >= 0 && value <= 100],
    ["line_discount_amount", line.discountAmount, (value) => value >= 0],
    ["vat_rate", line.vatRate, (value) => value >= 0],
    ["line_total", line.lineTotal, (value) => value >= 0],
  ];
  for (const [field, raw, valid] of checks) {
    const value = requiredNum(raw);
    if (!Number.isFinite(value) || !valid(value)) return field;
  }
  return null;
}

function historicalDocRows(doc: HistoricalDoc) {
  const booleanUnknown = doc.issues.includes("حدد price_includes_vat بنعم أو لا");
  return doc.lines.map((line: any) => ({
    source_doc_number: doc.sourceNumber,
    document_date: doc.date,
    source_datetime: doc.sourceDateTime ?? "",
    source_invoice_number: doc.sourceInvoiceNumber,
    party_code: doc.partyCode,
    party_name: doc.partyName,
    branch_code: doc.branchCode,
    item_code: line.itemCode,
    item_name: line.itemName,
    unit_code: line.unitCode,
    unit_name: line.unitName,
    warehouse_code: line.warehouseCode,
    qty: Number.isFinite(line.qty) ? line.qty : "",
    free_qty: line.freeQty,
    unit_price: Number.isFinite(line.unitPrice) ? line.unitPrice : "",
    discount_percent: Number.isFinite(line.discount) ? line.discount : "",
    line_discount_amount: line.discountAmount,
    vat_rate: Number.isFinite(line.vatRate) ? line.vatRate : "",
    line_total: Number.isFinite(line.lineTotal) ? line.lineTotal : "",
    subtotal: Number.isFinite(doc.subtotal) ? doc.subtotal : "",
    vat_amount: Number.isFinite(doc.vatAmount) ? doc.vatAmount : "",
    discount_amount: Number.isFinite(doc.discountAmount) ? doc.discountAmount : "",
    total_amount: Number.isFinite(doc.totalAmount) ? doc.totalAmount : "",
    payment_type: doc.paymentType,
    currency_code: doc.currencyCode,
    exchange_rate: Number.isFinite(doc.exchangeRate) ? doc.exchangeRate : "",
    cash_box_code: doc.cashBoxCode,
    bank_account_code: doc.bankAccountCode,
    price_includes_vat: booleanUnknown ? "" : String(doc.priceIncludesVat),
    total_expenses_loaded: Number.isFinite(doc.totalExpensesLoaded) ? doc.totalExpensesLoaded : "",
    line_notes: line.notes ?? "",
  }));
}

function reparseEditedDoc(doc: HistoricalDoc, rows: any[]) {
  const parsed = parseDocuments(rows, doc.kind, true)[0];
  if (!parsed) return doc;
  return {
    ...parsed,
    key: doc.key,
    sourceFileName: doc.sourceFileName,
    sourceDateTime: parsed.sourceDateTime ?? doc.sourceDateTime,
    branchOverrideCode: doc.branchOverrideCode,
    issues: [...parsed.issues, ...doc.issues.filter((issue) => issue.startsWith("تكرار محتمل"))],
    lines: parsed.lines.map((line: any, index: number) => ({
      ...line,
      warehouseOverrideCode: doc.lines[index]?.warehouseOverrideCode,
      unitOverrideCode: doc.lines[index]?.unitOverrideCode,
    })),
  };
}

function markDuplicateDocuments(documents: HistoricalDoc[]) {
  const groups = new Map<string, number[]>();
  documents.forEach((doc, index) => {
    if (!norm(doc.sourceNumber)) return;
    const duplicateKey = [
      doc.kind,
      norm(doc.sourceNumber),
      norm(doc.sourceDateTime || doc.date),
      norm(doc.partyCode || doc.partyName),
    ].join("|");
    const indexes = groups.get(duplicateKey) ?? [];
    indexes.push(index);
    groups.set(duplicateKey, indexes);
  });
  const duplicatesByIndex = new Map<number, number[]>();
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) duplicatesByIndex.set(index, indexes);
  }
  return documents.map((doc, index) => {
    const duplicates = duplicatesByIndex.get(index);
    const issues = doc.issues.filter((issue) => !issue.startsWith("تكرار محتمل لنفس رقم المستند"));
    if (duplicates) {
      const otherFiles = duplicates
        .filter((otherIndex) => otherIndex !== index)
        .map((otherIndex) => documents[otherIndex].sourceFileName ?? "ملف آخر");
      issues.push(`تكرار محتمل لنفس رقم المستند والجهة والتاريخ/الوقت: ${otherFiles.join("، ")}`);
    }
    return { ...doc, issues };
  });
}

async function requestJson(url: string, token: string | null, method = "GET", body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: any = new Error(data.message ?? data.error ?? `فشل الطلب (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function HistoricalDocumentsMigration({ cid, token, toast }: {
  cid: number;
  token: string | null;
  toast: (args: any) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<Kind>("sales_invoice");
  const [postingMode, setPostingMode] = useState<HistoricalImportMode>("financial_inventory");
  const [importBranchCode, setImportBranchCode] = useState("");
  const [importWarehouseCode, setImportWarehouseCode] = useState("");
  const [importUnitCode, setImportUnitCode] = useState("");
  const [applyBatchDefaults, setApplyBatchDefaults] = useState(true);
  const [lineEditDrafts, setLineEditDrafts] = useState<Record<string, string>>({});
  const [documentEditDrafts, setDocumentEditDrafts] = useState<Record<string, string>>({});
  const lineInputRefs = useRef(new Map<string, HTMLInputElement>());
  const documentFieldRefs = useRef(new Map<string, HTMLElement>());
  const [swapFrom, setSwapFrom] = useState("qty");
  const [swapTo, setSwapTo] = useState("unit_price");
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [invoiceFormat, setInvoiceFormat] = useState<"generic" | "ragmcloud_v1">("generic");
  const [readProgress, setReadProgress] = useState<{ completed: number; total: number } | null>(null);
  const [failedFiles, setFailedFiles] = useState<Array<{ name: string; error: string }>>([]);
  const [docs, setDocs] = useState<HistoricalDoc[]>([]);
  const [documentsPage, setDocumentsPage] = useState(1);
  const [masters, setMasters] = useState<Master | null>(null);
  const [fiscalYears, setFiscalYears] = useState<any[]>([]);
  const [referenceFiscalYearId, setReferenceFiscalYearId] = useState("");
  const [fiscalYearsError, setFiscalYearsError] = useState("");
  const [masterError, setMasterError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [periodScan, setPeriodScan] = useState<any>(null);
  const [periodRanges, setPeriodRanges] = useState<Record<number, { startDate: string; endDate: string }>>({});
  const [results, setResults] = useState<Array<{ sourceNumber: string; status: string; detail: string }>>([]);
  const [sourceInvoiceIds, setSourceInvoiceIds] = useState<Record<string, number>>({});
  const [sourceWarnings, setSourceWarnings] = useState<string[]>([]);
  const [saveAsDraftOnly, setSaveAsDraftOnly] = useState(false);

  useEffect(() => {
    let active = true;
    setFiscalYears([]);
    setReferenceFiscalYearId("");
    if (!token || !cid) return () => { active = false; };
    void (async () => {
      const years = await requestJson(`/api/fiscal/years?companyId=${cid}`, token) as any[];
      const details = await Promise.all(years.map((year) =>
        requestJson(`/api/fiscal/years/${year.id}?companyId=${cid}`, token) as Promise<any>,
      ));
      if (active) {
        setFiscalYears(details.map((detail) => ({ ...detail.year, periods: detail.periods ?? [] })));
        setFiscalYearsError("");
      }
    })().catch((error: any) => {
      if (active) setFiscalYearsError(error?.message ?? "تعذر تحميل الفترات المالية");
    });
    return () => { active = false; };
  }, [token, cid]);

  const referenceFiscalYear = fiscalYears.find((year) => String(year.id) === referenceFiscalYearId);
  const outsideReferenceCount = referenceFiscalYear
    ? docs.filter((doc) => doc.date && (doc.date < referenceFiscalYear.startDate || doc.date > referenceFiscalYear.endDate)).length
    : 0;

  const issueCount = useMemo(() => docs.reduce((sum, doc) => sum + doc.issues.filter(
    (issue) => !(((applyBatchDefaults && importBranchCode) || doc.branchOverrideCode) && issue === "كود الفرع مطلوب")
      && !((postingMode === "archive_only" || saveAsDraftOnly) && issue === "طريقة السداد مطلوبة"),
  ).length, 0), [docs, importBranchCode, applyBatchDefaults, postingMode, saveAsDraftOnly]);
  const validDocs = useMemo(() => docs.filter((doc) => doc.issues.every(
    (issue) => (((applyBatchDefaults && importBranchCode) || doc.branchOverrideCode) && issue === "كود الفرع مطلوب")
      || ((postingMode === "archive_only" || saveAsDraftOnly) && issue === "طريقة السداد مطلوبة"),
  )), [docs, importBranchCode, applyBatchDefaults, postingMode, saveAsDraftOnly]);

  async function loadMasters() {
    if (masters) return masters;
    setLoading(true);
    try {
      const blob = await exportData(token, {
        companyId: cid,
         types: ["items", "customers", "suppliers", "branches", "warehouses", "units", "cashBoxes", "bankAccounts"],
        format: "json",
      });
      const payload = JSON.parse(await blob.text());
      if (payload?.meta?.truncated && Object.keys(payload.meta.truncated).length) {
        throw new Error("قائمة البيانات التأسيسية كبيرة ومبتورة؛ أوقفنا المطابقة كي لا نعتمد رمزًا غير ظاهر.");
      }
      setMasters(payload.data ?? {});
      setMasterError("");
      return payload.data ?? {};
    } catch (error: any) {
      setMasterError(error?.message ?? "تعذر تحميل البيانات التأسيسية");
      throw error;
    } finally {
      setLoading(false);
    }
  }

  async function onFiles(files: File[]) {
    if (!files.length) return;
    setFileNames(files.map((file) => file.name));
    setDocs([]);
    setDocumentsPage(1);
    setLineEditDrafts({});
    setResults([]);
    setSourceWarnings([]);
    setSaveAsDraftOnly(false);
    setFailedFiles([]);
    setReadProgress({ completed: 0, total: files.length });
    setPeriodScan(null);
    setBusy(true);
    const parsed: HistoricalDoc[] = [];
    try {
      const parsedByFile = new Map<number, HistoricalDoc[]>();
      const csvFiles = await Promise.all(files.map(async (file, index) => {
        if (!file.name.toLowerCase().endsWith(".csv")) return null;
        return { index, file, text: decodeInvoiceCsv(await file.arrayBuffer()) };
      }));
      const salesHeaderFile = csvFiles.find((entry) => entry && isInvoiceHeaderCsv(entry.text));
      const purchaseHeaderFile = csvFiles.find((entry) => entry && isPurchaseOrderHeaderCsv(entry.text));
      const invoiceItemsFile = csvFiles.find((entry) => entry && isInvoiceItemsCsv(entry.text));
      const pairedFiles = new Set<number>();
      if (salesHeaderFile && purchaseHeaderFile) {
        throw new Error("الدفعة تحتوي أكثر من ملف رؤوس معروف؛ ارفع ملفَي نوع مستند واحد في كل مرة.");
      }
      const sourceHeaderFile = salesHeaderFile ?? purchaseHeaderFile;
      if (sourceHeaderFile && invoiceItemsFile) {
        const sourceKind = salesHeaderFile ? "sales_invoice" : "purchase_order";
        if (kind !== sourceKind) {
          throw new Error(sourceKind === "sales_invoice"
            ? "الملفان يحتويان فواتير مبيعات؛ اختر «فاتورة مبيعات» قبل رفعهما."
            : "الملفان يحتويان أوامر شراء؛ اختر «أمر شراء» قبل رفعهما.");
        }
        const converted = sourceKind === "sales_invoice"
          ? convertLinkedSalesInvoiceCsv(sourceHeaderFile.text, invoiceItemsFile.text)
          : convertLinkedPurchaseOrderCsv(sourceHeaderFile.text, invoiceItemsFile.text);
        parsedByFile.set(sourceHeaderFile.index, parseDocuments(converted.rows, kind, true, converted.warnings.length > 0).map((doc) => ({
          ...doc,
          key: `${doc.key}|source-pair`,
          sourceFileName: `${sourceHeaderFile.file.name} + ${invoiceItemsFile.file.name}`,
        })));
        pairedFiles.add(sourceHeaderFile.index);
        pairedFiles.add(invoiceItemsFile.index);
        setSourceWarnings(converted.warnings);
        if (converted.warnings.length && sourceKind !== "purchase_order") {
          setSaveAsDraftOnly(true);
        }
      } else if (sourceHeaderFile || invoiceItemsFile) {
        throw new Error("هذا التصدير يتكون من ملفين مترابطين. ارفع ملف الرؤوس وملف الأصناف معًا.");
      }
      const pendingFiles = files
        .map((file, index) => ({ file, index }))
        .filter(({ index }) => !pairedFiles.has(index));
      // Keep the queue bounded to avoid sending hundreds of large PDFs to the
      // browser/API/AI provider at once; failed files do not discard successes.
      const initialCompleted = files.length - pendingFiles.length;
      setReadProgress({ completed: initialCompleted, total: files.length });
      const batch = await processInvoiceBatchQueue(
        pendingFiles.map((entry) => ({ entry, index: entry.index })),
        ({ file }, index) => extractInvoiceRowsFromFile(file, kind, token, invoiceFormat)
          .then((documents) => documents.map((doc) => ({
            ...doc,
            key: `${doc.key}|file:${index}`,
            sourceFileName: file.name,
          }))),
        {
          concurrency: 2,
          onProgress: (completed) => setReadProgress({
            completed: initialCompleted + completed,
            total: files.length,
          }),
        },
      );
      batch.successes.forEach((documents, index) => parsedByFile.set(index, documents));
      const failures = batch.failures.map(({ entry, error }) => ({ name: entry.file.name, error }));
      files.forEach((_, index) => parsed.push(...(parsedByFile.get(index) ?? [])));
      setFailedFiles(failures);

      setDocs(markDuplicateDocuments(parsed));
      if (parsed.length) await loadMasters();
      toast({
        title: `تمت قراءة ${parsed.length} مستندًا من ${files.length} ملف`,
        description: failures.length
          ? `نجح التحويل مع ${failures.length} ملفًا لم يكتمل؛ راجع قائمة الملفات المتعثرة.`
          : "ستظهر أخطاء المطابقة والتكرار قبل أي حفظ.",
      });
    } catch (error: any) {
      setDocs(parsed.length ? parsed : []);
      toast({ title: error?.message ?? "تعذرت قراءة الملف", variant: "destructive" });
    } finally {
      setBusy(false);
      setReadProgress(null);
    }
  }

  function downloadNormalizedFile() {
    const rows = docs.flatMap((doc) => historicalDocRows(doc).map((row: Record<string, any>, lineIndex) => {
      const line = doc.lines[lineIndex];
      const effectiveUnitCode = (applyBatchDefaults && importUnitCode) || line.unitOverrideCode || line.unitCode;
      const effectiveUnit = (masters?.units ?? []).find((unit: any) => norm(unit.code) === norm(effectiveUnitCode));
      return {
        ...row,
        branch_code: (applyBatchDefaults && importBranchCode) || doc.branchOverrideCode || doc.branchCode,
        warehouse_code: (applyBatchDefaults && importWarehouseCode) || line.warehouseOverrideCode || line.warehouseCode,
        unit_code: effectiveUnitCode,
        unit_name: effectiveUnit?.nameAr ?? effectiveUnit?.name ?? line.unitName ?? "",
      };
    }));
    if (!rows.length) return;
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(rows, { header: reviewColumns.map(([field]) => field) });
    XLSX.utils.book_append_sheet(workbook, sheet, "بيانات الفواتير");
    XLSX.writeFile(workbook, "الفواتير-بعد-التحويل-للنموذج-الموحد.xlsx");
  }

  function swapReviewColumns() {
    if (!swapFrom || !swapTo || swapFrom === swapTo) return;
    setDocs((current) => current.map((doc) => reparseEditedDoc(doc, historicalDocRows(doc).map((row) => {
      const next: Record<string, any> = { ...row };
      [next[swapFrom], next[swapTo]] = [next[swapTo], next[swapFrom]];
      return next;
    }))));
    setPeriodScan(null);
    setResults([]);
    toast({ title: "تم تبديل القيم بين العمودين", description: "راجع الصفوف والأخطاء قبل فحص الفترات." });
  }

  function setDocumentBranchOverride(docKey: string, value: string) {
    setDocs((current) => current.map((doc) => doc.key === docKey
      ? { ...doc, branchOverrideCode: value === "__source__" ? "" : value }
      : doc));
    setPeriodScan(null);
    setResults([]);
  }

  function lineEditKey(docKey: string, lineIndex: number, field: string) {
    return `${docKey}|${lineIndex}|${field}`;
  }

  function setLineEditDraft(docKey: string, lineIndex: number, field: string, value: string) {
    setLineEditDrafts((current) => ({ ...current, [lineEditKey(docKey, lineIndex, field)]: value }));
  }

  function documentFieldKey(docKey: string, field: string) {
    return `${docKey}|document|${field}`;
  }

  function commitDocumentEdit(docKey: string, field: "party_code" | "party_name" | "payment_type" | "document_date", rawValue: string) {
    const value = rawValue.trim();
    setDocs((current) => markDuplicateDocuments(current.map((doc) => {
      if (doc.key !== docKey) return doc;
      const rows = historicalDocRows(doc) as Array<Record<string, any>>;
      if (!rows.length) return doc;
      rows.forEach((row) => {
        if (field === "document_date") {
          const timeSuffix = doc.sourceDateTime?.slice(10) ?? "";
          row.document_date = value;
          row.source_datetime = value + timeSuffix;
        } else {
          row[field] = value;
        }
      });
      return reparseEditedDoc(doc, rows);
    })));
    setDocumentEditDrafts((current) => {
      const next = { ...current };
      delete next[documentFieldKey(docKey, field)];
      return next;
    });
    setPeriodScan(null);
    setResults([]);
  }

  function removeDocument(docKey: string) {
    setDocs((current) => markDuplicateDocuments(current.filter((doc) => doc.key !== docKey)));
    setPeriodScan(null);
    setResults([]);
  }

  function commitLineEdit(docKey: string, lineIndex: number, field: string) {
    const key = lineEditKey(docKey, lineIndex, field);
    const draft = lineEditDrafts[key];
    if (draft === undefined) return;
    const value = editableTextLineFields.has(field)
      ? draft.trim()
      : draft.trim() === "" && field === "discount_percent" ? "0" : draft;
    setDocs((current) => current.map((doc) => {
      if (doc.key !== docKey) return doc;
      const rows = historicalDocRows(doc) as Array<Record<string, any>>;
      if (!rows[lineIndex]) return doc;
      rows[lineIndex][field] = value;
      return reparseEditedDoc(doc, rows);
    }));
    if (editableTextLineFields.has(field) || draft.trim() === "" || Number.isFinite(requiredNum(value))) {
      setLineEditDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
    setPeriodScan(null);
    setResults([]);
  }

  function focusFirstInvalidLine(doc: HistoricalDoc) {
    const issue = doc.issues.find((entry) => !(
      ((applyBatchDefaults && importBranchCode) || doc.branchOverrideCode) && entry === "كود الفرع مطلوب"
    )) ?? "";
    const itemIssue = issue.includes("الصنف:");
    const partyIssue = issue.startsWith("العميل:") || issue.startsWith("المورد:");
    const paymentIssue = issue.includes("طريقة السداد");
    const mentionedValue = issue.match(/"([^"]+)"/)?.[1];
    const matchedIssueLine = mentionedValue
      ? doc.lines.findIndex((line) => [line.itemCode, line.itemName, line.unitCode, line.unitName].some(
        (value) => norm(value) === norm(mentionedValue),
      ))
      : -1;
    const lineIndex = doc.lines.findIndex((line) => invalidLineField(line));
    const targetLineIndex = itemIssue && matchedIssueLine >= 0
      ? matchedIssueLine
      : partyIssue || paymentIssue ? -1
        : lineIndex >= 0 ? lineIndex : matchedIssueLine >= 0 ? matchedIssueLine : doc.lines.length ? 0 : -1;
    const targetField = itemIssue ? "item_code" : lineIndex >= 0 ? invalidLineField(doc.lines[lineIndex]) : null;
    const documentField = partyIssue ? "party_code" : paymentIssue ? "payment_type" : null;
    if (itemIssue) {
      toast({
        title: "كود الصنف غير مطابق",
        description: "استبدل كود المصدر بكود صنف مسجل في هذه الشركة، أو صحح اسم الصنف في السطر المحدد.",
        variant: "destructive",
      });
    } else if (partyIssue) {
      toast({
        title: doc.kind.startsWith("sales") ? "بيانات العميل غير مطابقة" : "بيانات المورد غير مطابقة",
        description: `أدخل كود ${doc.kind.startsWith("sales") ? "عميل" : "مورد"} موجودًا في هذه الشركة أو الاسم المطابق لسجله؛ يمكنك تعديل الكود والاسم من صف المستند.`,
        variant: "destructive",
      });
    } else if (paymentIssue) {
      toast({
        title: "طريقة السداد مطلوبة",
        description: "اختر آجل أو نقدي أو بنكي من خانة طريقة السداد في صف المستند.",
        variant: "destructive",
      });
    } else if (lineIndex >= 0) {
      toast({
        title: "راجع قيمة السطر",
        description: "تم تحديد الحقل الرقمي غير الصالح؛ أدخل قيمة صحيحة ثم انتقل إلى الخطأ التالي.",
      });
    } else {
      toast({
        title: "راجع بيانات المستند",
        description: issue || "تم الانتقال إلى السطر المرتبط بالمستند.",
      });
    }
    requestAnimationFrame(() => {
      if (documentField) {
        const control = documentFieldRefs.current.get(documentFieldKey(doc.key, documentField));
        control?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        control?.focus({ preventScroll: true });
        if (paymentIssue && control instanceof HTMLButtonElement) control.click();
        return;
      }
      if (targetLineIndex >= 0 && targetField) {
        const input = lineInputRefs.current.get(lineEditKey(doc.key, targetLineIndex, targetField));
        if (input) {
          input.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
          input.focus();
          input.select();
          return;
        }
      }

      const fallbackLineIndex = targetLineIndex;
      const target = fallbackLineIndex >= 0
        ? [...document.querySelectorAll<HTMLElement>("[data-import-line]")]
          .find((element) => element.dataset.importLine === `${doc.key}-${fallbackLineIndex}`)
        : [...document.querySelectorAll<HTMLElement>("[data-import-document]")]
          .find((element) => element.dataset.importDocument === doc.key);
      target?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      target?.focus({ preventScroll: true });
    });
  }

  function setLineOverride(docKey: string, lineIndex: number, field: "warehouseOverrideCode" | "unitOverrideCode", value: string) {
    setDocs((current) => current.map((doc) => doc.key === docKey
      ? {
          ...doc,
          lines: doc.lines.map((line: any, index) => index === lineIndex
            ? { ...line, [field]: value === "__source__" ? "" : value }
            : line),
        }
      : doc));
    setPeriodScan(null);
    setResults([]);
  }

  function downloadTemplate() {
    const headers = [
      "source_doc_number", "document_date", "party_code", "branch_code", "item_code", "item_name",
      "unit_code", "unit_name", "warehouse_code", "qty", "free_qty", "unit_price", "discount_percent", "line_discount_amount",
      "vat_rate", "line_total", "subtotal", "vat_amount", "discount_amount", "total_amount",
      "payment_type", "currency_code", "exchange_rate", "cash_box_code", "bank_account_code",
      "source_invoice_number", "line_notes", "price_includes_vat", "total_expenses_loaded",
    ];
    const partyCode = kind.startsWith("sales") ? "CUS-EXAMPLE" : "SUP-EXAMPLE";
    const sourceNumber = kind === "sales_invoice" ? "OLD-S-001"
      : kind === "purchase_invoice" ? "OLD-P-001"
      : kind === "sales_return" ? "OLD-SR-001" : "OLD-PR-001";
    const sourceInvoiceNumber = kind === "sales_return" ? "OLD-S-001"
      : kind === "purchase_return" ? "OLD-P-001" : "";
    const example = [
      sourceNumber, "2026-01-15", partyCode, "BR-EXAMPLE", "ITEM-EXAMPLE",
      "مثال — استبدل بكود الصنف الموجود", "", "", "WH-EXAMPLE", 2, 0, 100, 0, 0,
      15, 230, 200, 30, 0, 230, "آجل", "SAR", 1, "", "",
      sourceInvoiceNumber, "مثال عربي — احذف هذا السطر أو استبدله", "لا", 0,
    ];
    const guideRows: any[][] = [
      ["دليل تعبئة نموذج المستندات التاريخية"],
      ["نوع المستند المختار في صفحة الاستيراد", kindLabels[kind]],
      ["1", "املأ ورقة «بيانات الفواتير» فقط؛ ورقة «مثال عربي» للشرح ولا تُستورد."],
      ["2", "كل صف يمثل صنفًا واحدًا. كرر بيانات رأس الفاتورة في كل صف من صفوف الفاتورة نفسها."],
      ["3", "لا تغير اسم ورقة «بيانات الفواتير» ولا أسماء الأعمدة الإنجليزية فيها؛ هي مفاتيح القراءة."],
      ["4", "استخدم أكواد العميل/المورد والفرع والصنف والمخزن المسجلة بالفعل في الشركة؛ لا تكتب أسماء بديلة."],
      ["5", "source_doc_number هو رقم المستند في النظام القديم، وليس رقم التسلسل الجديد. يحفظ كمرجع مستقل يمكن البحث به، والنظام يولد رقمه الرسمي من مسلسل نوع المستند والفترة."],
      ["6", "يحدد document_date الفترة المالية. يجب أن تكون الفترة التي تغطي التاريخ مفتوحة، مع مسلسل سنوي مستقل ومجهز لهذا النوع والفرع."],
      ["7", "في المرتجع، اكتب رقم الفاتورة الأصلية القديمة في source_invoice_number واستورد الفاتورة الأصلية ضمن الدفعة قبل المرتجع."],
      ["8", "payment_type يقبل: آجل أو نقدي أو بنكي. عند النقدي املأ cash_box_code، وعند البنكي املأ bank_account_code."],
      ["9", "price_includes_vat يقبل نعم أو لا. اكتب التاريخ بصيغة YYYY-MM-DD، مثل 2026-01-15."],
      ["10", "الإجماليات subtotal وvat_amount وdiscount_amount وtotal_amount تخص الفاتورة كاملة، لذا كرر القيم نفسها في كل صف."],
      [""],
      ["العمود", "المعنى", "مطلوب؟", "مثال"],
      ["source_doc_number", "رقم الفاتورة/المرتجع القديم؛ لفاتورة المبيعات يحفظ في حقل مستقل قابل للبحث، ولا يحل محل رقم التسلسل.", "نعم", sourceNumber],
      ["document_date", "تاريخ المستند الذي يحدد السنة والفترة المالية.", "نعم", "2026-01-15"],
      ["party_code", kind.startsWith("sales") ? "كود العميل الموجود في النظام." : "كود المورد الموجود في النظام.", "نعم", partyCode],
      ["branch_code", "كود الفرع المسجل في الشركة.", "نعم", "BR-EXAMPLE"],
      ["item_code", "كود الصنف الموجود في النظام.", "نعم", "ITEM-EXAMPLE"],
      ["item_name", "اسم توضيحي فقط؛ إذا تركته فارغًا يستخدم النظام اسم الصنف المسجل.", "اختياري", "صنف تجريبي"],
      ["warehouse_code", "كود المخزن الذي تخصه حركة الصنف؛ مطلوب للأصناف المخزنية.", "حسب الصنف", "WH-EXAMPLE"],
      ["unit_code", "كود وحدة موجودة ومرتبطة بالصنف؛ اتركه فارغًا لاستخدام وحدة الصنف الأساسية.", "اختياري", "UNIT-01"],
      ["unit_name", "اسم وحدة القياس في المستند المصدر؛ يستخدم للبحث عن تطابق فريد عند غياب كود الوحدة.", "اختياري", "قطعة"],
      ["qty / free_qty", "الكمية المباعة أو المشتراة والكمية المجانية.", "الكمية مطلوبة", "2 / 0"],
      ["unit_price", "سعر الوحدة قبل الضريبة.", "نعم", "100"],
      ["discount_percent / line_discount_amount", "خصم السطر كنسبة ومبلغ.", "اختياري", "0 / 0"],
      ["vat_rate / line_total", "نسبة الضريبة وإجمالي السطر بعد الخصم والضريبة.", "نعم", "15 / 230"],
      ["subtotal / vat_amount / discount_amount / total_amount", "إجماليات المستند قبل الضريبة، الضريبة، الخصم، ثم الإجمالي النهائي.", "نعم — كررها بكل صف", "200 / 30 / 0 / 230"],
      ["payment_type", "طريقة السداد: آجل أو نقدي أو بنكي.", "نعم", "آجل"],
      ["currency_code / exchange_rate", "رمز العملة وسعر الصرف إلى عملة الشركة.", "نعم", "SAR / 1"],
      ["cash_box_code / bank_account_code", "كود الخزنة للنقدي أو كود الحساب البنكي للبنكي.", "حسب طريقة السداد", "CASH-01 / BANK-01"],
      ["source_invoice_number", "رقم الفاتورة الأصلية القديمة — للمرتجعات فقط.", "للمرتجع", sourceInvoiceNumber || "OLD-S-001"],
      ["line_notes", "ملاحظات تخص سطر الصنف.", "اختياري", "مثال"],
      ["price_includes_vat", "هل السعر يتضمن الضريبة؟", "نعم", "نعم أو لا"],
      ["total_expenses_loaded", "مصاريف إضافية محمّلة على فاتورة المشتريات.", "اختياري", "0"],
      [""],
      ["ملاحظة", "أكواد CUS-EXAMPLE وSUP-EXAMPLE وBR-EXAMPLE وITEM-EXAMPLE وWH-EXAMPLE أمثلة فقط؛ استبدلها بأكوادك الفعلية."],
    ];
    const workbook = XLSX.utils.book_new();
    const guide = XLSX.utils.aoa_to_sheet(guideRows);
    guide["!cols"] = [{ wch: 34 }, { wch: 88 }, { wch: 20 }, { wch: 28 }];
    const data = XLSX.utils.aoa_to_sheet([headers]);
    data["!cols"] = headers.map((header) => ({ wch: Math.max(16, header.length + 3) }));
    const sample = XLSX.utils.aoa_to_sheet([headers, example]);
    sample["!cols"] = headers.map((header) => ({ wch: Math.max(16, header.length + 3) }));
    XLSX.utils.book_append_sheet(workbook, guide, "تعليمات عربية");
    XLSX.utils.book_append_sheet(workbook, data, "بيانات الفواتير");
    XLSX.utils.book_append_sheet(workbook, sample, "مثال عربي");
    XLSX.writeFile(workbook, `نموذج-${kind}-فواتير-تاريخية.xlsx`);
  }

  function validateAgainstMasters(doc: HistoricalDoc, sourceIds: Record<string, number>, allowMissingPayment = false) {
    const batchBranchCode = applyBatchDefaults ? importBranchCode : "";
    const issues = doc.issues.filter((issue) => !((batchBranchCode || doc.branchOverrideCode) && issue === "كود الفرع مطلوب"));
    const indexes = {
      items: indexByCode(masters?.items),
      units: indexByCode(masters?.units),
      parties: indexByCode(doc.kind.startsWith("sales") ? masters?.customers : masters?.suppliers),
      branches: indexByCode(masters?.branches),
      warehouses: indexByCode(masters?.warehouses),
      cashBoxes: indexByCode(masters?.cashBoxes),
      bankAccounts: indexByCode(masters?.bankAccounts),
    };
    const partyRows = doc.kind.startsWith("sales") ? masters?.customers ?? [] : masters?.suppliers ?? [];
    const party = resolveCodeOrName(
      partyRows,
      indexes.parties,
      doc.partyCode,
      doc.partyName,
      doc.kind.startsWith("sales") ? "العميل" : "المورد",
      issues,
    );
    const branch = resolveCode(indexes.branches, batchBranchCode || doc.branchOverrideCode || doc.branchCode, "الفرع", issues);
    const lines = doc.lines.map((line) => {
      const item = resolveCodeOrName(masters?.items ?? [], indexes.items, line.itemCode, line.itemName, "الصنف", issues);
      const warehouseCode = (applyBatchDefaults && importWarehouseCode) || line.warehouseOverrideCode || line.warehouseCode;
      const warehouse = warehouseCode ? resolveCode(indexes.warehouses, warehouseCode, "المخزن", issues) : null;
      const requestedUnitCode = (applyBatchDefaults && importUnitCode) || line.unitOverrideCode || line.unitCode;
      const unit = requestedUnitCode || line.unitName
        ? resolveCodeOrName(masters?.units ?? [], indexes.units, requestedUnitCode ?? "", line.unitName ?? "", "وحدة القياس", issues)
        : null;
      const itemType = String(item?.itemType ?? item?.type ?? "stock").toLowerCase();
      if (doc.kind !== "purchase_order" && item && !warehouse && itemType !== "service" && itemType !== "prepaid_expense") {
        issues.push(`اختر مخزن الإدخال للصنف ${line.itemCode}`);
      }
      return {
        ...line,
        itemId: item?.id ?? null,
        itemName: line.itemName || item?.nameAr || item?.name || line.itemCode,
        itemCode: item?.code ?? line.itemCode,
        unitCode: unit?.code ?? requestedUnitCode ?? "",
        unitId: unit?.id ?? item?.unitId ?? null,
        unit: unit?.nameAr ?? unit?.name ?? line.unitName ?? item?.unitName ?? item?.unit ?? null,
        warehouseId: warehouse?.id ?? null,
      };
    });
    const cashBox = doc.paymentType === "cash" ? resolveCode(indexes.cashBoxes, doc.cashBoxCode, "الخزنة", issues) : null;
    const bank = doc.paymentType === "bank" ? resolveCode(indexes.bankAccounts, doc.bankAccountCode, "الحساب البنكي", issues) : null;
    if (doc.kind !== "purchase_order" && !allowMissingPayment && !["credit", "cash", "bank"].includes(doc.paymentType)) {
      issues.push("طريقة السداد يجب أن تكون: آجل أو نقدي أو بنكي");
    }
    if (doc.kind.endsWith("_return") && !doc.sourceInvoiceNumber) issues.push("رقم الفاتورة المصدر مطلوب للمرتجع");
    const sourceInvoiceId = doc.sourceInvoiceNumber ? sourceIds[`${doc.kind.startsWith("sales") ? "sales" : "purchase"}:${doc.sourceInvoiceNumber}`] : undefined;
    if (doc.kind.endsWith("_return") && doc.sourceInvoiceNumber && !sourceInvoiceId) {
      issues.push("الفاتورة المصدر غير موجودة في دفعة الاستيراد الحالية؛ استورد الفواتير أولاً في الجلسة نفسها.");
    }
    return { issues, party, branch, lines, cashBox, bank, sourceInvoiceId };
  }

  async function preflightAnnualSequences(refs: Array<{ doc: HistoricalDoc; branch: any }>) {
    const [sequenceRows, years] = await Promise.all([
      requestJson(`/api/sequences?companyId=${cid}`, token) as Promise<any[]>,
      requestJson(`/api/fiscal/years?companyId=${cid}`, token) as Promise<any[]>,
    ]);
    const yearDetails = await Promise.all(years.map((year) =>
      requestJson(`/api/fiscal/years/${year.id}?companyId=${cid}`, token) as Promise<any>,
    ));
    const periods = yearDetails.flatMap((detail) => detail.periods ?? []);
    const periodsById = new Map(periods.map((period: any) => [Number(period.id), period]));
    const groups = new Map<string, { doc: HistoricalDoc; branch: any; docs: HistoricalDoc[] }>();
    for (const { doc, branch } of refs) {
      const effectivePaymentType = doc.paymentType || (saveAsDraftOnly ? "credit" : "");
      const key = JSON.stringify([doc.kind, doc.date, Number(branch.id), effectivePaymentType]);
      const group = groups.get(key);
      if (group) group.docs.push(doc);
      else groups.set(key, { doc, branch, docs: [doc] });
    }

    const problems: Array<{ sourceNumber: string; status: string; detail: string }> = [];
    const checks = [...groups.values()];
    for (let offset = 0; offset < checks.length; offset += 12) {
      const batch = checks.slice(offset, offset + 12);
      const previews = await Promise.all(batch.map(async (group) => {
        const { doc, branch } = group;
        const period = periods.find((candidate: any) =>
          String(candidate.startDate) <= doc.date && String(candidate.endDate) >= doc.date,
        );
        if (!period) return { group, period: null, preview: null };
        const query = new URLSearchParams({
          companyId: String(cid),
          date: doc.date,
          branchId: String(branch.id),
          paymentType: doc.paymentType || (saveAsDraftOnly ? "credit" : ""),
        });
        const preview = await requestJson(
          `/api/sequences/peek/${encodeURIComponent(doc.kind)}?${query.toString()}`,
          token,
        ) as any;
        return { group, period, preview };
      }));

      for (const { group, period, preview } of previews) {
        let problem = "";
        if (!period) {
          problem = "لا توجد فترة مالية مفتوحة تغطي تاريخ المستند؛ أضف السنة والفترات يدويًا ثم أعد الفحص.";
        } else if (!preview?.hasSequence || !preview.sequenceCode || !preview.number) {
          problem = "لا يوجد مسلسل صالح ومتاح لهذا النوع والتاريخ والفرع.";
        } else {
          const selected = sequenceRows.find((row: any) => String(row.code) === String(preview.sequenceCode));
          const scopedIds = Array.isArray(selected?.fiscalPeriodIds)
            ? selected.fiscalPeriodIds.map(Number)
            : [];
          if (!selected || !selected.isActive) {
            problem = "تعذر التحقق من المسلسل الذي اختاره النظام.";
          } else if (!scopedIds.includes(Number(period.id))) {
            problem = `المسلسل ${preview.sequenceCode} ليس مخصصًا للفترة المالية لهذا المستند؛ لن نستخدم مسلسلًا عامًا كبديل.`;
          } else {
            const scopedYearIds = new Set(scopedIds
              .map((id: number) => periodsById.get(id)?.fiscalYearId)
              .filter((id: unknown) => id != null)
              .map(Number));
            if (scopedYearIds.size !== 1 || !scopedYearIds.has(Number(period.fiscalYearId))) {
              problem = `المسلسل ${preview.sequenceCode} مربوط بأكثر من سنة مالية؛ أنشئ مسلسلًا مستقلًا لهذه السنة.`;
            } else if (Number(selected.startNumber) !== 1 || Number(selected.padLength) !== 5 || selected.monthlyReset) {
              problem = `إعداد المسلسل ${preview.sequenceCode} لا يطابق بداية 00001 بدون تصفير شهري.`;
            }
          }
        }
        if (problem) {
          for (const doc of group.docs) {
            problems.push({ sourceNumber: doc.sourceNumber, status: "أُوقف قبل الإنشاء", detail: problem });
          }
        }
      }
    }
    return problems;
  }

  async function scanPeriods() {
    if (!docs.length) return;
    setBusy(true);
    try {
      const scan = await scanHistorical(token, {
        companyId: cid,
        rows: docs.map((doc, index) => ({
          __rowIndex: index,
          docNumber: `${doc.kind}:${doc.sourceNumber}`,
          entryDate: doc.date,
          debit: 1,
          credit: 1,
        })),
      });
      setPeriodScan(scan);
      setPeriodRanges(Object.fromEntries((scan.yearsToCreate ?? []).map((year: number) => {
        const item = scan.years.find((entry: any) => entry.year === year);
        return [year, { startDate: item?.startDate ?? `${year}-01-01`, endDate: item?.endDate ?? `${year}-12-31` }];
      })));
    } catch (error: any) {
      toast({ title: error?.message ?? "تعذر فحص الفترات", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function approvePeriods() {
    if (!periodScan || !periodScan.yearsToCreate?.length) return;
    setBusy(true);
    try {
      await ensureFiscalYears(token, {
        companyId: cid,
        years: periodScan.yearsToCreate,
        ranges: periodScan.yearsToCreate.map((year: number) => ({ year, ...periodRanges[year] })),
      });
      await scanPeriods();
      toast({ title: "تم تحديث الفترات المالية" });
    } catch (error: any) {
      toast({ title: error?.message ?? "تعذر إنشاء الفترات", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function importDocuments() {
    if (!masters) return;
    if (kind !== "purchase_order" && (
      !periodScan || periodScan.periodsMissing?.length || periodScan.closedPeriodConflicts?.length || periodScan.yearsToCreate?.length
    )) return;
    const anticipatedSources = { ...sourceInvoiceIds };
    for (const doc of docs) {
      if (doc.kind.endsWith("_invoice")) {
        anticipatedSources[`${doc.kind.startsWith("sales") ? "sales" : "purchase"}:${doc.sourceNumber}`] = -1;
      }
    }
    const refs = docs.map((doc) => ({
      doc,
      ...validateAgainstMasters(doc, anticipatedSources, postingMode === "archive_only" || saveAsDraftOnly),
    }));
    const duplicateDocs = docs.filter((doc) => doc.issues.some((issue) => issue.startsWith("تكرار محتمل لنفس رقم المستند")));
    if (duplicateDocs.length) {
      toast({
        title: `يوجد ${duplicateDocs.length} مستند مكرر محتمل`,
        description: "احذف النسخ الزائدة أو صحح التاريخ/الوقت ثم أعد الفحص قبل الحفظ.",
        variant: "destructive",
      });
      return;
    }
    const blocked = refs.filter((entry) => entry.issues.length > 0);
    if (blocked.length) {
      setDocs((current) => current.map((doc) => {
        const matched = refs.find((entry) => entry.doc.key === doc.key);
        return matched ? { ...doc, issues: matched.issues } : doc;
      }));
      toast({ title: `توجد أخطاء في ${blocked.length} مستند`, description: "عالج المطابقات ثم أعد الفحص.", variant: "destructive" });
      return;
    }
    setBusy(true);
    const nextResults: Array<{ sourceNumber: string; status: string; detail: string }> = [];
    const nextSourceIds = { ...sourceInvoiceIds };
    try {
      let sequenceProblems: Array<{ sourceNumber: string; status: string; detail: string }>;
      try {
        // Draft-only imports receive a draft number from the server and do not
        // consume the official annual sequence, so sequence preflight must not
        // block saving them.
        sequenceProblems = kind === "purchase_order" || postingMode === "archive_only" || saveAsDraftOnly
          ? []
          : await preflightAnnualSequences(refs);
      } catch (error: any) {
        toast({
          title: "تعذر فحص المسلسلات السنوية",
          description: error?.message ?? "أوقفنا الاستيراد قبل إنشاء أي مستند.",
          variant: "destructive",
        });
        return;
      }
      if (sequenceProblems.length) {
        setResults(sequenceProblems);
        toast({
          title: `أُوقف الاستيراد قبل إنشاء أي مستند (${sequenceProblems.length})`,
          description: "صحح إعدادات المسلسلات السنوية ثم أعد المحاولة.",
          variant: "destructive",
        });
        return;
      }
      const ordered = [...refs].sort((a, b) =>
        Number(a.doc.kind.endsWith("_return")) - Number(b.doc.kind.endsWith("_return"))
        || a.doc.date.localeCompare(b.doc.date)
      );
      let existingOrderReferences = new Set<string>();
      if (kind === "purchase_order") {
        try {
          const existingOrders = await requestJson(`/api/purchasing/purchase-orders?companyId=${cid}`, token) as any[];
          existingOrderReferences = new Set(
            existingOrders.map((order) => norm(order.supplierInvoiceNumber)).filter(Boolean),
          );
        } catch (error: any) {
          toast({
            title: "تعذر فحص أوامر الشراء الموجودة",
            description: error?.message ?? "أوقفنا الاستيراد لمنع إنشاء أوامر مكررة.",
            variant: "destructive",
          });
          return;
        }
      }
      for (const entry of ordered) {
        const { doc, party, branch, lines, cashBox, bank } = entry;
        if (doc.kind === "purchase_order" && existingOrderReferences.has(norm(doc.sourceNumber))) {
          nextResults.push({
            sourceNumber: doc.sourceNumber,
            status: "موجود مسبقًا",
            detail: "يوجد أمر شراء بنفس رقم المرجع؛ تم تخطيه لمنع التكرار.",
          });
          setResults([...nextResults]);
          continue;
        }
        const currentSourceId = doc.sourceInvoiceNumber
          ? nextSourceIds[`${doc.kind.startsWith("sales") ? "sales" : "purchase"}:${doc.sourceInvoiceNumber}`]
          : undefined;
        if (doc.kind.endsWith("_return") && !currentSourceId) {
          nextResults.push({ sourceNumber: doc.sourceNumber, status: "تعذر الترحيل", detail: "الفاتورة المصدر لم تُرحّل بنجاح في هذه الدفعة." });
          setResults([...nextResults]);
          continue;
        }
        const createPath = doc.kind === "purchase_order" ? "/api/purchasing/purchase-orders"
          : doc.kind === "sales_invoice" ? "/api/sales/sales-invoices"
          : doc.kind === "purchase_invoice" ? "/api/purchasing/purchase-invoices"
          : doc.kind === "sales_return" ? "/api/sales/sales-returns"
          : "/api/purchasing/purchase-returns";
        const postPath = doc.kind === "purchase_order" ? null
          : doc.kind === "sales_invoice" ? (id: number) => `/api/sales/sales-invoices/${id}/post`
          : doc.kind === "purchase_invoice" ? (id: number) => `/api/purchasing/purchase-invoices/${id}/post`
          : doc.kind === "sales_return" ? (id: number) => `/api/sales/sales-returns/${id}/post`
          : (id: number) => `/api/purchasing/purchase-returns/${id}/post`;
        const mappedLines = lines.map((line: any) => ({
          itemId: line.itemId, itemName: line.itemName, itemCode: line.itemCode,
          unitId: line.unitId, unitCode: line.unitCode || undefined, unit: line.unit,
          warehouseId: line.warehouseId, qty: line.qty, freeQty: line.freeQty,
          unitPrice: line.unitPrice, discount: line.discount,
          discountAmount: line.discountAmount, vatRate: line.vatRate,
          lineTotal: line.lineTotal, notes: line.notes,
        }));
        const payload: any = doc.kind === "purchase_order" ? {
          companyId: cid,
          branchId: branch.id,
          supplierInvoiceNumber: doc.sourceNumber,
          orderDate: doc.date,
          supplierId: party.id,
          paymentType: "credit",
          currencyCode: doc.currencyCode,
          exchangeRate: String(doc.exchangeRate),
          subtotal: doc.subtotal.toFixed(2),
          vatAmount: doc.vatAmount.toFixed(2),
          discountAmount: doc.discountAmount.toFixed(2),
          totalAmount: doc.totalAmount.toFixed(2),
          priceIncludesVat: doc.priceIncludesVat,
          notes: `استيراد أمر شراء تاريخي — رقم المصدر: ${doc.sourceNumber}`,
          lines: mappedLines.map((line: any) => ({
            ...line,
            freeQty: line.freeQty ?? "0",
            discount: line.discount ?? 0,
            discountAmount: line.discountAmount ?? "0",
          })),
        } : {
          companyId: cid, clientRequestId: await stableKey(cid, doc.kind, doc.sourceNumber, doc.date),
          branchId: branch.id,
          paymentType: doc.paymentType || ((postingMode === "archive_only" || saveAsDraftOnly) ? "credit" : ""),
          cashBoxId: cashBox?.id ?? null, bankAccountId: bank?.id ?? null,
          currencyCode: doc.currencyCode, exchangeRate: doc.exchangeRate,
          subtotal: doc.subtotal.toFixed(2), vatAmount: doc.vatAmount.toFixed(2),
          discountAmount: doc.discountAmount.toFixed(2), totalAmount: doc.totalAmount.toFixed(2),
          totalExpensesLoaded: doc.totalExpensesLoaded.toFixed(2),
          priceIncludesVat: doc.priceIncludesVat, notes: `استيراد تاريخي — رقم المصدر: ${doc.sourceNumber}`,
          historicalImportMode: postingMode,
          ...((postingMode === "archive_only" || saveAsDraftOnly) ? { saveAsDraft: true } : {}),
          lines: mappedLines,
        };
        if (doc.kind === "purchase_order") {
          // Purchase-order creation is operational only; the existing API
          // creates a draft without posting finance or inventory.
        } else if (doc.kind === "sales_invoice") {
          Object.assign(payload, { invoiceDate: doc.date, customerId: party.id, legacyDocNumber: doc.sourceNumber });
        } else if (doc.kind === "purchase_invoice") {
          Object.assign(payload, { invoiceDate: doc.date, supplierInvoiceDate: doc.date, supplierInvoiceNumber: doc.sourceNumber, supplierId: party.id });
        } else if (doc.kind === "sales_return") {
          Object.assign(payload, { returnDate: doc.date, customerId: party.id, invoiceId: currentSourceId });
        } else {
          Object.assign(payload, { returnDate: doc.date, supplierInvoiceNumber: doc.sourceNumber, supplierId: party.id, invoiceId: currentSourceId });
        }
        try {
          const created = await requestJson(createPath, token, "POST", payload);
          const id = Number(created.id);
          if (!Number.isInteger(id) || id <= 0) throw new Error("لم يُرجع النظام رقم المستند");
          const savedMode = created.historicalImportMode ?? "financial_inventory";
          if (doc.kind !== "purchase_order" && savedMode !== postingMode) throw new Error("رقم المستند المصدر سبق استيراده بوضع مختلف؛ لن نغيّر طريقة ترحيله تلقائيًا.");
          if (doc.kind !== "purchase_order" && postingMode !== "archive_only" && !saveAsDraftOnly && created.status !== "posted") {
            if (!postPath) throw new Error("لا يوجد مسار ترحيل لهذا النوع من المستندات.");
            await requestJson(postPath(id), token, "PATCH", {});
          }
          if (doc.kind === "purchase_order") existingOrderReferences.add(norm(doc.sourceNumber));
          if (doc.kind.endsWith("_invoice")) nextSourceIds[`${doc.kind.startsWith("sales") ? "sales" : "purchase"}:${doc.sourceNumber}`] = id;
          const resultStatus = doc.kind === "purchase_order" ? "تم حفظ أمر الشراء"
            : postingMode === "archive_only" ? "تمت الأرشفة"
            : saveAsDraftOnly ? "تم الحفظ في النظام كمسودة" : "تم الترحيل";
          nextResults.push({
            sourceNumber: doc.sourceNumber,
            status: resultStatus,
            detail: doc.kind === "purchase_order"
              ? `مسودة أمر شراء — بلا قيد مالي أو حركة مخزون — ${created.docNumber ?? id}`
              : `${saveAsDraftOnly && postingMode !== "archive_only" ? "مسودة قابلة للتعديل — بلا ترحيل" : importModeLabels[postingMode]} — ${created.idempotentReplay ? "استُعيد المستند السابق" : kindLabels[doc.kind]} — ${created.docNumber ?? id}`,
          });
        } catch (error: any) {
          nextResults.push({ sourceNumber: doc.sourceNumber, status: "تعذر الترحيل", detail: error?.message ?? "خطأ غير معروف" });
        }
        setSourceInvoiceIds({ ...nextSourceIds });
        setResults([...nextResults]);
      }
      toast({
        title: "انتهى استيراد المستندات",
        description: `${nextResults.filter((item) => ["تم الترحيل", "تمت الأرشفة", "تم الحفظ في النظام كمسودة", "تم حفظ أمر الشراء"].includes(item.status)).length} ناجح من ${nextResults.length}`,
      });
    } finally {
      setBusy(false);
    }
  }

  const periodsReady = kind === "purchase_order" || (!!periodScan
    && (postingMode === "archive_only" || (
      !(periodScan.yearsToCreate?.length)
      && !(periodScan.periodsMissing?.length)
      && !(periodScan.orphans?.length)
      && !(periodScan.closedPeriodConflicts?.length)
    )));

  return (
    <Card>
      <CardContent className="space-y-4 p-4" dir="rtl">
        <div>
          <h3 className="font-bold">استيراد المستندات التاريخية</h3>
          <p className="text-xs text-muted-foreground">في أوضاع الترحيل يُنشأ كل مستند برقمه الرسمي من المسلسل المطابق لتاريخه. وضع الأرشفة يحفظه كمسودة بلا رقم رسمي. لا تُعاد بيانات التأسيس أو إعدادات الفترات والمسلسلات. استورد الفاتورة المصدر قبل المرتجع في الجلسة نفسها.</p>
          <p className="mt-2 rounded-md border border-sky-200 bg-sky-50 p-2 text-xs leading-6 text-sky-950">
            القالب يحتوي على شرح عربي، ورقة فارغة للرفع، ومثال مستقل. استخدم أكواد العملاء والموردين والأصناف المسجلة بالفعل، ورقم النظام القديم في source_doc_number؛ لا تستبدل به رقم التسلسل الذي ينشئه النظام.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
            <Select value={kind} onValueChange={(value) => {
              setKind(value as Kind);
              setDocs([]);
              setFileNames([]);
              setPeriodScan(null);
              setResults([]);
              setSourceWarnings([]);
              setSaveAsDraftOnly(false);
            }}>
            <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(kindLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={referenceFiscalYearId || "__none__"} onValueChange={(value) => {
            setReferenceFiscalYearId(value === "__none__" ? "" : value);
            setPeriodScan(null);
            setResults([]);
          }}>
            <SelectTrigger className="w-64"><SelectValue placeholder="الفترة المرجعية (اختياري)" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">بدون فترة مرجعية</SelectItem>
              {fiscalYears.map((year) => <SelectItem key={String(year.id)} value={String(year.id)}>
                {year.name || year.nameAr || year.year || year.startDate} ({year.startDate} — {year.endDate})
              </SelectItem>)}
            </SelectContent>
          </Select>
          {kind.endsWith("_invoice") && (
            <Select value={invoiceFormat} onValueChange={(value) => setInvoiceFormat(value as "generic" | "ragmcloud_v1")}>
              <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ragmcloud_v1">قالب الفاتورة المرفق — RAGM Cloud</SelectItem>
                <SelectItem value="generic">قالب عام / غير محدد</SelectItem>
              </SelectContent>
            </Select>
          )}
           <Button variant="outline" onClick={downloadTemplate}><FileDown className="ml-1 h-4 w-4" />تنزيل النموذج مع شرح وأمثلة</Button>
          <input ref={fileRef} className="hidden" type="file" accept=".xlsx,.xls,.xlsm,.ods,.csv,.pdf,.docx,.jpg,.jpeg,.png,.webp" multiple onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length) void onFiles(files);
          }} />
          <Button onClick={() => fileRef.current?.click()} disabled={loading || busy}><Upload className="ml-1 h-4 w-4" />{busy ? "قراءة الملفات وتحويلها…" : loading ? "تحميل المطابقات…" : "رفع دفعة فواتير (500 ملف أو أكثر)"}</Button>
          {fileNames.length > 0 && <span className="text-xs text-muted-foreground">تم اختيار {fileNames.length} ملفًا</span>}
        </div>
        {fiscalYearsError && <p className="text-xs text-red-700">{fiscalYearsError}</p>}
        {referenceFiscalYear && <p className="text-xs text-muted-foreground">
          الفترة المرجعية للمراجعة فقط: {referenceFiscalYear.name || referenceFiscalYear.year || referenceFiscalYear.startDate} ({referenceFiscalYear.startDate} — {referenceFiscalYear.endDate}). أي فاتورة خارج النطاق ستُعلّم، لكن تُحفظ حسب تاريخها إذا كانت فترتها المالية مفتوحة.
        </p>}
        {readProgress && (
          <div className="rounded border bg-muted/30 p-3 text-sm" role="status" aria-live="polite">
            جارٍ تحويل الملفات: {readProgress.completed} من {readProgress.total}. تتم المعالجة بملفين في الوقت نفسه، وتبقى الملفات الناجحة محفوظة للمراجعة حتى لو تعذرت قراءة ملف آخر.
          </div>
        )}
        {!!failedFiles.length && (
          <div className="max-h-56 overflow-auto rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
            <div className="mb-2 font-semibold">تعذرت قراءة {failedFiles.length} ملفًا — لم تُحذف نتائج الملفات الناجحة</div>
            {failedFiles.map((failure, index) => <div key={`${failure.name}-${index}`} className="border-t border-amber-200 py-1">
              <strong>{failure.name}:</strong> {failure.error}
            </div>)}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          اختر قالب الفاتورة لهذه الدفعة؛ كل شركة يمكنها استخدام القالب المناسب. يمكنك تحديد عدة ملفات دفعة واحدة من نافذة الاختيار (Ctrl/Shift). ملفات RAGM Cloud بصيغة CSV تتطلب ملفي Invoices.csv وInvoice_items.csv معًا؛ ملف الأصناف وحده لا يحتوي بيانات رأس الفاتورة اللازمة للحفظ. الصيغ المدعومة: Excel وCSV وPDF وWord وJPG وPNG وWebP (حتى 13 ميجابايت للملف). كل ملف PDF يستخدم طلب تحويل AI وقد يتوقف عند بلوغ حد الاستخدام اليومي أو الشهري؛ تبقى النتائج الناجحة للمراجعة، ولا يُحفظ شيء تلقائيًا.
        </p>
        {masterError && <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{masterError}</div>}
        {!!docs.length && (
          <>
            {!!sourceWarnings.length && <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs leading-6 text-amber-950">
              <div className="mb-1 font-semibold">تنبيه من بيانات المصدر</div>
              {sourceWarnings.slice(0, 8).map((warning) => <div key={warning}>{warning}</div>)}
               {sourceWarnings.length > 8 && <div>وتوجد تنبيهات أخرى لعدد {sourceWarnings.length - 8} مستند.</div>}
               {kind === "purchase_order" ? (
                 <div className="mt-1">الحفظ ينشئ أوامر شراء فقط؛ لا تُنشأ فواتير أو دفعات ولا تتغير الأرصدة أو كميات المخزون.</div>
               ) : (
                 <>
                   <div className="mt-1">ملفات الفواتير لا تحتوي قيود التحصيل؛ لم تُضف أي دفعات تلقائيًا.</div>
                   <div>ستُحفظ الفواتير كمسودات قابلة للتعديل دون ترحيل مالي أو مخزني حتى تُستكمل بيانات التحصيل.</div>
                 </>
               )}
            </div>}
            <label className="flex items-center gap-2 rounded border border-sky-200 bg-sky-50 p-3 text-xs">
              <input
                type="checkbox"
                checked={applyBatchDefaults}
                onChange={(event) => {
                  setApplyBatchDefaults(event.target.checked);
                  setPeriodScan(null);
                  setResults([]);
                }}
              />
              <span>تطبيق الفرع والمخزن ووحدة القياس المحددة على كل المستندات والسطور (يمكن إيقافه للتخصيص الفردي)</span>
            </label>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">{docs.length} مستند</Badge>
              <Badge variant={issueCount ? "destructive" : "outline"}>{issueCount} خطأ إدخال</Badge>
              <Badge variant="outline">{validDocs.length} صالح مبدئيًا</Badge>
            </div>
            {docs.length > 50 && (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span>عرض {Math.min((documentsPage - 1) * 50 + 1, docs.length)}–{Math.min(documentsPage * 50, docs.length)} من {docs.length} فاتورة</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={documentsPage <= 1} onClick={() => setDocumentsPage((page) => Math.max(1, page - 1))}>السابق</Button>
                  <Button size="sm" variant="outline" disabled={documentsPage >= Math.ceil(docs.length / 50)} onClick={() => setDocumentsPage((page) => Math.min(Math.ceil(docs.length / 50), page + 1))}>التالي</Button>
                </div>
              </div>
            )}
            {referenceFiscalYear && outsideReferenceCount > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                توجد {outsideReferenceCount} فاتورة خارج الفترة المرجعية المحددة. هذا تنبيه للمراجعة فقط؛ يمكنك تعديل التاريخ أو حذف الفاتورة، وإذا كان تاريخها يتبع فترة أخرى مفتوحة فستُحفظ في فترتها الصحيحة.
              </div>
            )}
            {masters && <div className="grid gap-3 rounded border bg-muted/20 p-3 md:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="font-medium">فرع الإدخال داخل النظام</span>
                <Select value={importBranchCode || "__document__"} onValueChange={(value) => {
                  setImportBranchCode(value === "__document__" ? "" : value);
                  setPeriodScan(null);
                  setResults([]);
                }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__document__">استخدم كود الفرع المستخرج من الملف</SelectItem>
                    {(masters.branches ?? []).map((branch: any) => <SelectItem key={String(branch.code)} value={String(branch.code)}>
                      {branch.code} — {branch.nameAr ?? branch.name ?? ""}
                    </SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium">مخزن الإدخال (اختياري، يطبّق على كل السطور)</span>
                <Select value={importWarehouseCode || "__document__"} onValueChange={(value) => {
                  setImportWarehouseCode(value === "__document__" ? "" : value);
                  setPeriodScan(null);
                  setResults([]);
                }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__document__">استخدم كود المخزن المستخرج من الملف</SelectItem>
                    {(masters.warehouses ?? []).map((warehouse: any) => <SelectItem key={String(warehouse.code)} value={String(warehouse.code)}>
                      {warehouse.code} — {warehouse.nameAr ?? warehouse.name ?? ""}
                    </SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium">وحدة القياس الافتراضية (اختياري، تطبّق على كل السطور)</span>
                <Select value={importUnitCode || "__item_unit__"} onValueChange={(value) => {
                  setImportUnitCode(value === "__item_unit__" ? "" : value);
                  setPeriodScan(null);
                  setResults([]);
                }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__item_unit__">استخدم وحدة الصنف/الملف</SelectItem>
                    {(masters.units ?? []).map((unit: any) => <SelectItem key={String(unit.code)} value={String(unit.code)}>
                      {unit.code} — {unit.nameAr ?? unit.name ?? ""}
                    </SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <p className="text-muted-foreground md:col-span-2">
                القيم هنا تظهر في كل سطر بالمعاينة عند تفعيل التطبيق الجماعي. اختيار وحدة موحدة يظل خاضعًا للتحقق من ارتباطها بكل صنف.
              </p>
            </div>}
            <div className="flex flex-wrap items-end gap-2 rounded border p-3">
              <div className="w-52 space-y-1 text-xs">
                <div className="font-medium">العمود الذي يحمل القيمة الخطأ</div>
                <Select value={swapFrom} onValueChange={setSwapFrom}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{reviewColumns.map(([field, label]) =>
                    <SelectItem key={field} value={field}>{label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="w-52 space-y-1 text-xs">
                <div className="font-medium">العمود الصحيح لتبديل القيم معه</div>
                <Select value={swapTo} onValueChange={setSwapTo}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{reviewColumns.map(([field, label]) =>
                    <SelectItem key={field} value={field}>{label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <Button variant="outline" disabled={busy || swapFrom === swapTo} onClick={swapReviewColumns}>تبديل القيم بين العمودين</Button>
              <p className="w-full text-xs text-muted-foreground">
                يطبّق التبديل على جميع الصفوف في الدفعة ويعيد فحصها؛ راجع الناتج قبل المتابعة.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">اضغط «تفاصيل» بجوار الخطأ لعرض اقتراح التصحيح والانتقال إلى الحقل المعني. يمكن تعديل بيانات العميل/المورد والسداد وكود الصنف أو اسمه من الجداول.</p>
            <div className="max-h-56 overflow-auto rounded border">
              <table className="min-w-[1500px] text-xs">
                <thead className="sticky top-0 bg-muted"><tr className="text-right"><th className="p-2">رقم المصدر</th><th className="p-2">التاريخ</th><th className="p-2">النوع</th><th className="p-2">السطور</th><th className="p-2">الحالة</th><th className="p-2">كود العميل/المورد</th><th className="p-2">اسم العميل/المورد</th><th className="p-2">طريقة السداد</th><th className="p-2">فرع هذا المستند</th><th className="p-2">إجراء</th></tr></thead>
                <tbody>{docs.slice((documentsPage - 1) * 50, documentsPage * 50).map((doc) => {
                  const visibleIssues = doc.issues.filter((issue) => !(((applyBatchDefaults && importBranchCode) || doc.branchOverrideCode) && issue === "كود الفرع مطلوب"));
                  const isOutsideReference = !!referenceFiscalYear && (doc.date < referenceFiscalYear.startDate || doc.date > referenceFiscalYear.endDate);
                  const isPossibleDuplicate = doc.issues.some((issue) => issue.startsWith("تكرار محتمل لنفس رقم المستند"));
                  const partyCodeKey = documentFieldKey(doc.key, "party_code");
                  const partyNameKey = documentFieldKey(doc.key, "party_name");
                  const paymentTypeKey = documentFieldKey(doc.key, "payment_type");
                  const dateKey = documentFieldKey(doc.key, "document_date");
                  return <tr
                    key={doc.key}
                    data-import-document={doc.key}
                    tabIndex={-1}
                    className={`border-t ${visibleIssues.length ? "cursor-pointer hover:bg-amber-50" : ""}`}
                    onDoubleClick={() => focusFirstInvalidLine(doc)}
                  >
                    <td className="p-2">{doc.sourceNumber}</td>
                    <td className="min-w-40 p-1" dir="ltr"><input
                      type="date"
                      aria-label={`تاريخ فاتورة المصدر ${doc.sourceNumber}`}
                      value={documentEditDrafts[dateKey] ?? doc.date}
                      onChange={(event) => setDocumentEditDrafts((current) => ({ ...current, [dateKey]: event.target.value }))}
                      onBlur={(event) => commitDocumentEdit(doc.key, "document_date", event.currentTarget.value)}
                      className={`w-full rounded border bg-background px-2 py-1 ${isOutsideReference ? "border-amber-500" : "border-input"}`}
                    />{isOutsideReference && <span className="block text-center text-[10px] text-amber-800">خارج الفترة المختارة</span>}</td>
                    <td className="p-2">{kindLabels[doc.kind]}</td><td className="p-2">{doc.lines.length}</td>
                    <td className="min-w-64 p-2">{visibleIssues.length ? <div className="flex items-center gap-1 text-red-700">
                      <button
                        type="button"
                        className="shrink-0 text-blue-700 underline underline-offset-2 hover:text-blue-900"
                        onClick={() => focusFirstInvalidLine(doc)}
                        aria-label={`تفاصيل الخطأ للمستند ${doc.sourceNumber}`}
                      >تفاصيل</button>
                      <span>{visibleIssues[0]}</span>
                    </div> : <span className="text-emerald-700">جاهز للفحص</span>}</td>
                    <td className="min-w-48 p-1">
                      <input
                        ref={(element) => {
                          if (element) documentFieldRefs.current.set(partyCodeKey, element);
                          else documentFieldRefs.current.delete(partyCodeKey);
                        }}
                        type="text"
                        aria-label={`كود ${doc.kind.startsWith("sales") ? "العميل" : "المورد"} للمصدر ${doc.sourceNumber}`}
                        value={documentEditDrafts[partyCodeKey] ?? doc.partyCode}
                        onChange={(event) => setDocumentEditDrafts((current) => ({ ...current, [partyCodeKey]: event.target.value }))}
                        onBlur={(event) => commitDocumentEdit(doc.key, "party_code", event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        placeholder="أدخل الكود المسجل"
                        className="w-full rounded border border-input bg-background px-2 py-1 text-right outline-none focus:ring-2 focus:ring-primary"
                      />
                    </td>
                    <td className="min-w-56 p-1">
                      <input
                        ref={(element) => {
                          if (element) documentFieldRefs.current.set(partyNameKey, element);
                          else documentFieldRefs.current.delete(partyNameKey);
                        }}
                        type="text"
                        aria-label={`اسم ${doc.kind.startsWith("sales") ? "العميل" : "المورد"} للمصدر ${doc.sourceNumber}`}
                        value={documentEditDrafts[partyNameKey] ?? doc.partyName}
                        onChange={(event) => setDocumentEditDrafts((current) => ({ ...current, [partyNameKey]: event.target.value }))}
                        onBlur={(event) => commitDocumentEdit(doc.key, "party_name", event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        placeholder="أدخل الاسم المطابق"
                        className="w-full rounded border border-input bg-background px-2 py-1 text-right outline-none focus:ring-2 focus:ring-primary"
                      />
                    </td>
                    <td className="min-w-40 p-1">
                      <Select
                        value={doc.paymentType || "__missing__"}
                        onValueChange={(value) => commitDocumentEdit(doc.key, "payment_type", value === "__missing__" ? "" : value)}
                      >
                        <SelectTrigger
                          ref={(element) => {
                            if (element) documentFieldRefs.current.set(paymentTypeKey, element);
                            else documentFieldRefs.current.delete(paymentTypeKey);
                          }}
                          className="h-8"
                          aria-label={`طريقة السداد للمصدر ${doc.sourceNumber}`}
                        ><SelectValue placeholder="اختر طريقة السداد" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__missing__">اختر طريقة السداد</SelectItem>
                          <SelectItem value="credit">آجل</SelectItem>
                          <SelectItem value="cash">نقدي</SelectItem>
                          <SelectItem value="bank">بنكي</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="min-w-56 p-2">
                      <Select
                        value={applyBatchDefaults && importBranchCode ? "__batch__" : doc.branchOverrideCode || "__source__"}
                        disabled={applyBatchDefaults && !!importBranchCode}
                        onValueChange={(value) => setDocumentBranchOverride(doc.key, value)}
                      >
                        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {applyBatchDefaults && importBranchCode && <SelectItem value="__batch__">فرع الدفعة ({importBranchCode})</SelectItem>}
                          <SelectItem value="__source__">{applyBatchDefaults && importBranchCode ? "استخدم فرع الدفعة" : doc.branchCode ? `استخدم فرع الملف (${doc.branchCode})` : "اختر فرعًا"}</SelectItem>
                          {(masters?.branches ?? []).map((branch: any) => <SelectItem key={String(branch.code)} value={String(branch.code)}>
                            {branch.code} — {branch.nameAr ?? branch.name ?? ""}
                          </SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-2"><Button type="button" variant="outline" size="sm" onClick={() => removeDocument(doc.key)}>
                      {isPossibleDuplicate ? "حذف النسخة المكررة" : "حذف من الدفعة"}
                    </Button></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold">مراجعة الصفوف على أعمدة نموذج النظام الموحد</div>
                <Button variant="outline" size="sm" onClick={downloadNormalizedFile}>
                  <FileDown className="ml-1 h-4 w-4" />تنزيل الملف بعد التحويل
                </Button>
              </div>
              <div className="max-h-72 overflow-auto rounded border">
                <table className="min-w-[2100px] text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr className="text-right">
                      {reviewColumns.map(([key, label]) => <th key={key} className="whitespace-nowrap p-2">{label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {docs.flatMap((doc) => doc.lines.map((line: any, lineIndex) => {
                      const badField = invalidLineField(line);
                      const effectiveUnitCode = (applyBatchDefaults && importUnitCode) || line.unitOverrideCode || line.unitCode;
                      const effectiveUnit = (masters?.units ?? []).find((unit: any) => norm(unit.code) === norm(effectiveUnitCode));
                      const editableValues: Record<string, unknown> = {
                        qty: line.qty, unit_price: line.unitPrice, discount_percent: line.discount,
                        line_discount_amount: line.discountAmount, vat_rate: line.vatRate, line_total: line.lineTotal,
                      };
                      return <tr
                        key={`${doc.key}-${lineIndex}`}
                        tabIndex={-1}
                        className={`border-t ${badField ? "bg-red-50" : ""}`}
                        data-import-line={`${doc.key}-${lineIndex}`}
                      >
                        {reviewColumns.map(([field]) => {
                          const values: Record<string, unknown> = {
                            source_doc_number: doc.sourceNumber, document_date: doc.date,
                            party_code: doc.partyCode, party_name: doc.partyName,
                            branch_code: (applyBatchDefaults && importBranchCode) || doc.branchOverrideCode || doc.branchCode,
                            item_code: line.itemCode, item_name: line.itemName,
                            unit_code: (applyBatchDefaults && importUnitCode) || line.unitOverrideCode || line.unitCode,
                            unit_name: effectiveUnit?.nameAr ?? effectiveUnit?.name ?? line.unitName ?? line.unit,
                            warehouse_code: (applyBatchDefaults && importWarehouseCode) || line.warehouseOverrideCode || line.warehouseCode,
                            qty: line.qty, free_qty: line.freeQty, unit_price: line.unitPrice,
                            discount_percent: line.discount, line_discount_amount: line.discountAmount,
                            vat_rate: line.vatRate, line_total: line.lineTotal,
                            subtotal: doc.subtotal, vat_amount: doc.vatAmount, discount_amount: doc.discountAmount,
                            total_amount: doc.totalAmount, payment_type: doc.paymentType,
                            currency_code: doc.currencyCode, exchange_rate: doc.exchangeRate,
                            cash_box_code: doc.cashBoxCode, bank_account_code: doc.bankAccountCode,
                            source_invoice_number: doc.sourceInvoiceNumber,
                            price_includes_vat: doc.priceIncludesVat ? "نعم" : "لا",
                            total_expenses_loaded: doc.totalExpensesLoaded, line_notes: line.notes,
                          };
                          if (editableTextLineFields.has(field)) {
                            const editKey = lineEditKey(doc.key, lineIndex, field);
                            const rawValue = values[field];
                            const value = lineEditDrafts[editKey] ?? String(rawValue ?? "");
                            return <td key={field} className="min-w-36 p-1">
                              <input
                                ref={(element) => {
                                  if (element) lineInputRefs.current.set(editKey, element);
                                  else lineInputRefs.current.delete(editKey);
                                }}
                                type="text"
                                aria-label={`${field === "item_code" ? "كود الصنف" : "اسم الصنف"} للمصدر ${doc.sourceNumber}، السطر ${lineIndex + 1}`}
                                value={value}
                                onChange={(event) => setLineEditDraft(doc.key, lineIndex, field, event.target.value)}
                                onBlur={() => commitLineEdit(doc.key, lineIndex, field)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") event.currentTarget.blur();
                                }}
                                className="w-full rounded border border-input bg-background px-2 py-1 text-right outline-none focus:ring-2 focus:ring-primary"
                              />
                            </td>;
                          }
                          if (editableLineFields.has(field)) {
                            const editKey = lineEditKey(doc.key, lineIndex, field);
                            const rawValue = editableValues[field];
                            const value = lineEditDrafts[editKey] ?? (Number.isFinite(rawValue) ? String(rawValue) : "");
                            return <td key={field} className="min-w-28 p-1">
                              <input
                                ref={(element) => {
                                  if (element) lineInputRefs.current.set(editKey, element);
                                  else lineInputRefs.current.delete(editKey);
                                }}
                                type="text"
                                inputMode="decimal"
                                aria-label={`${field} للمصدر ${doc.sourceNumber}، السطر ${lineIndex + 1}`}
                                value={value}
                                onChange={(event) => setLineEditDraft(doc.key, lineIndex, field, event.target.value)}
                                onBlur={() => commitLineEdit(doc.key, lineIndex, field)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") event.currentTarget.blur();
                                }}
                                className={`w-full rounded border bg-background px-2 py-1 text-right outline-none focus:ring-2 focus:ring-primary ${badField === field ? "border-red-500 ring-1 ring-red-300" : "border-input"}`}
                              />
                            </td>;
                          }
                          if (field === "warehouse_code") return <td key={field} className="min-w-48 p-1">
                            <Select
                              value={applyBatchDefaults && importWarehouseCode ? "__batch__" : line.warehouseOverrideCode || "__source__"}
                              disabled={applyBatchDefaults && !!importWarehouseCode}
                              onValueChange={(value) => setLineOverride(doc.key, lineIndex, "warehouseOverrideCode", value)}
                            >
                              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {applyBatchDefaults && importWarehouseCode && <SelectItem value="__batch__">مخزن الدفعة ({importWarehouseCode})</SelectItem>}
                                <SelectItem value="__source__">{line.warehouseCode || "اختر مخزنًا"}</SelectItem>
                                {(masters?.warehouses ?? []).map((warehouse: any) => <SelectItem key={String(warehouse.code)} value={String(warehouse.code)}>
                                  {warehouse.code} — {warehouse.nameAr ?? warehouse.name ?? ""}
                                </SelectItem>)}
                              </SelectContent>
                            </Select>
                          </td>;
                          if (field === "unit_code") return <td key={field} className="min-w-48 p-1">
                            <Select
                              value={applyBatchDefaults && importUnitCode ? "__batch__" : line.unitOverrideCode || "__source__"}
                              disabled={applyBatchDefaults && !!importUnitCode}
                              onValueChange={(value) => setLineOverride(doc.key, lineIndex, "unitOverrideCode", value)}
                            >
                              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {applyBatchDefaults && importUnitCode && <SelectItem value="__batch__">وحدة الدفعة ({importUnitCode})</SelectItem>}
                                <SelectItem value="__source__">{line.unitCode || line.unitName || "وحدة الصنف الأساسية"}</SelectItem>
                                {(masters?.units ?? []).map((unit: any) => <SelectItem key={String(unit.code)} value={String(unit.code)}>
                                  {unit.code} — {unit.nameAr ?? unit.name ?? ""}
                                </SelectItem>)}
                              </SelectContent>
                            </Select>
                          </td>;
                          const value = values[field];
                          return <td key={field} className="whitespace-nowrap p-2">{value == null || value === "" ? "—" : String(value)}</td>;
                        })}
                      </tr>;
                    }))}
                  </tbody>
                </table>
              </div>
            </div>
            {kind !== "purchase_order" ? <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs">
                <span className="font-medium">أثر الاعتماد</span>
                <Select value={postingMode} onValueChange={(value) => {
                  setPostingMode(value as HistoricalImportMode);
                  setResults([]);
                  setPeriodScan(null);
                }}>
                  <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(importModeLabels).map(([value, label]) =>
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  )}</SelectContent>
                </Select>
              </label>
              <div className={`rounded-md border p-2 text-xs leading-5 ${postingMode === "financial_only" || postingMode === "inventory_only" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-slate-200 bg-slate-50 text-slate-800"}`}>
                {postingMode === "financial_inventory" && (saveAsDraftOnly
                  ? "ستُحفظ كمسودات قابلة للتعديل فقط؛ لن تُرحّل القيود أو حركات المخزون قبل مراجعة بيانات السداد."
                  : "سيُرحّل القيد المالي وحركات المخزون حسب مسار النظام المعتاد.")}
                {postingMode === "financial_only" && (saveAsDraftOnly
                  ? "ستُحفظ كمسودات فقط؛ لن يُرحّل القيد المالي قبل مراجعة بيانات السداد."
                  : "سيُرحّل القيد المالي بتكلفة النظام دون تغيير الكميات. قد تختلف تقارير الحسابات والمخزون.")}
                {postingMode === "inventory_only" && (saveAsDraftOnly
                  ? "ستُحفظ كمسودات فقط؛ لن تُحدّث الكميات قبل مراجعة بيانات السداد."
                  : "سيُحدّث المخزون وتكلفته دون قيد محاسبي. قد تختلف تقارير الحسابات والمخزون.")}
                {postingMode === "archive_only" && "سيُحفظ المستند كمسودة مرجعية فقط، دون قيد محاسبي أو حركة مخزون أو رقم رسمي. يمكن تأجيل الترحيل حتى استكمال بيانات التحصيل."}
              </div>
            </div> : <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-xs leading-6 text-sky-950">
              مسار أوامر الشراء منفصل عن الفواتير: سيُنشئ أوامر شراء بحالة مسودة فقط، ولن يرحّل قيدًا ماليًا أو حركة مخزون. بيانات السداد في الملف لا تُسجّل كدفعات.
            </div>}
            <div className="flex flex-wrap gap-2">
              {kind !== "purchase_order" && <Button
                variant="outline"
                onClick={scanPeriods}
                disabled={busy || issueCount > 0 || !masters}
                title={issueCount > 0 ? "عالج أخطاء الإدخال أولًا" : undefined}
              >
                {busy ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-1 h-4 w-4" />}فحص الفترات المالية
              </Button>}
                <Button
                  onClick={importDocuments}
                  disabled={busy || !periodsReady || issueCount > 0 || !masters}
                  title={issueCount > 0 ? "عالج أخطاء الإدخال أولًا" : !periodsReady ? "افحص الفترات المالية أولًا" : undefined}
                >
                  {busy ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Upload className="ml-1 h-4 w-4" />}{kind === "purchase_order" ? "حفظ أوامر الشراء كمسودات" : saveAsDraftOnly ? "حفظ الفواتير كمسودات" : postingMode === "archive_only" ? "حفظ المستندات للأرشفة" : "إنشاء وترحيل المستندات"}
              </Button>
            </div>
            {issueCount > 0 && <div role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">
              الأزرار متوقفة لحماية البيانات. أصلح {issueCount} خطأ أولًا بالنقر مرتين على المستند المعني؛ بعد ذلك افحص الفترات المالية، ثم سيتاح الحفظ كمسودة.
            </div>}
            {!issueCount && kind !== "purchase_order" && !periodsReady && <div className="text-xs text-muted-foreground">
              أصلح أخطاء الإدخال إن وجدت، ثم اضغط «فحص الفترات المالية». يتاح الحفظ بعد اجتياز الفحص.
            </div>}
          </>
        )}
        {periodScan && (
          <div className="rounded border bg-muted/20 p-3 text-xs">
            <div>تواريخ المستندات: <span dir="ltr">{periodScan.firstDate ?? "—"} → {periodScan.lastDate ?? "—"}</span></div>
            <div>تواريخ بلا فترة: {periodScan.periodsMissing?.length ?? 0}؛ تعارضات مغلقة: {periodScan.closedPeriodConflicts?.length ?? 0}</div>
            {!!periodScan.orphans?.length && <div className="mt-2 text-red-700">
              {periodScan.orphans.slice(0, 8).map((item: any, index: number) => <div key={`orphan-${index}`}>{item.reason}</div>)}
            </div>}
            {!!periodScan.periodsMissing?.length && <div className="mt-2 text-amber-800">
              {periodScan.periodsMissing.slice(0, 8).map((item: any, index: number) => <div key={`missing-${index}`} dir="ltr">{item.date} — {item.docNumber}</div>)}
            </div>}
            {!!periodScan.closedPeriodConflicts?.length && <div className="mt-2 text-red-700">
              {periodScan.closedPeriodConflicts.slice(0, 8).map((item: any, index: number) => <div key={`closed-${index}`} dir="ltr">{item.date} — {item.docNumber}: {item.periodName} ({item.status})</div>)}
            </div>}
            {!!periodScan.periodsMissing?.length && <div className="mt-2 text-amber-800">
              {periodScan.periodsMissing.slice(0, 8).map((item: any, index: number) => <div key={`missing-${index}`} dir="ltr">{item.date} — {item.docNumber}</div>)}
            </div>}
            {!!periodScan.closedPeriodConflicts?.length && <div className="mt-2 text-red-700">
              {periodScan.closedPeriodConflicts.slice(0, 8).map((item: any, index: number) => <div key={`closed-${index}`} dir="ltr">{item.date} — {item.docNumber}: {item.periodName} ({item.status})</div>)}
            </div>}
            {periodScan.yearsToCreate?.length > 0 && <>
              <div className="my-2 font-medium">راجع نطاقات السنوات والفترات المقترحة قبل الموافقة</div>
              {periodScan.years.filter((year: any) => periodScan.yearsToCreate.includes(year.year)).map((year: any) => (
                <div key={year.year} className="flex flex-wrap items-center gap-2 py-1">
                  <strong>{year.year}</strong>
                  {year.exists ? <span dir="ltr">{year.startDate} → {year.endDate} (قائمة موجودة)</span> : <>
                    <input type="date" aria-label={`بداية السنة ${year.year}`} value={periodRanges[year.year]?.startDate ?? year.startDate} onChange={(event) => setPeriodRanges((current) => ({ ...current, [year.year]: { ...(current[year.year] ?? { startDate: year.startDate, endDate: year.endDate }), startDate: event.target.value } }))} />
                    <input type="date" aria-label={`نهاية السنة ${year.year}`} value={periodRanges[year.year]?.endDate ?? year.endDate} onChange={(event) => setPeriodRanges((current) => ({ ...current, [year.year]: { ...(current[year.year] ?? { startDate: year.startDate, endDate: year.endDate }), endDate: event.target.value } }))} />
                  </>}
                </div>
              ))}
              <Button variant="outline" className="mt-2" disabled={busy || !!periodScan.closedPeriodConflicts?.length} onClick={approvePeriods}>أوافق على إنشاء الفترات الشهرية</Button>
            </>}
            {periodScan.closedPeriodConflicts?.length > 0 && <div className="mt-2 text-red-700"><AlertTriangle className="ml-1 inline h-4 w-4" />يجب معالجة الفترات المغلقة قبل الاستيراد.</div>}
            {periodsReady && <div className="mt-2 text-emerald-700">كل التواريخ تقع في فترات مفتوحة.</div>}
          </div>
        )}
        {!!results.length && <div className="max-h-48 overflow-auto rounded border text-xs">
          {results.map((result, index) => <div key={`${result.sourceNumber}-${index}`} className="border-t p-2">
            <strong>{result.sourceNumber}</strong> — {result.status}: {result.detail}
          </div>)}
        </div>}
      </CardContent>
    </Card>
  );
}
