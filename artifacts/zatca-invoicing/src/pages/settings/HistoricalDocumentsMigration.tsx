import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, CheckCircle2, FileDown, Loader2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { exportData, ensureFiscalYears, scanHistorical } from "@/lib/dataIoApi";

type Kind = "sales_invoice" | "purchase_invoice" | "sales_return" | "purchase_return";
type Master = Record<string, any[]>;
type Line = Record<string, any>;
type HistoricalDoc = {
  key: string;
  kind: Kind;
  sourceNumber: string;
  date: string;
  sourceInvoiceNumber: string;
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
};
const requiredHeaders = [
  "source_doc_number", "document_date", "party_code", "branch_code", "item_code",
  "warehouse_code", "qty", "unit_price", "line_total", "subtotal", "vat_amount",
  "discount_amount", "total_amount", "vat_rate", "payment_type", "currency_code",
  "exchange_rate", "price_includes_vat",
];

function norm(value: unknown) { return String(value ?? "").trim().toLocaleLowerCase(); }
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

function parseDocuments(rows: any[], kind: Kind): HistoricalDoc[] {
  const grouped = new Map<string, HistoricalDoc>();
  rows.forEach((row) => {
    const sourceNumber = String(row.source_doc_number ?? "").trim();
    const date = String(row.document_date ?? "").trim().slice(0, 10);
    const key = `${kind}|${sourceNumber}`;
    let doc = grouped.get(key);
    if (!doc) {
      doc = {
        key, kind, sourceNumber, date,
        sourceInvoiceNumber: String(row.source_invoice_number ?? "").trim(),
        paymentType: String(row.payment_type ?? "credit").trim().toLowerCase() || "credit",
        currencyCode: String(row.currency_code ?? "SAR").trim().toUpperCase() || "SAR",
        exchangeRate: requiredNum(row.exchange_rate),
        subtotal: requiredNum(row.subtotal),
        vatAmount: requiredNum(row.vat_amount),
        discountAmount: requiredNum(row.discount_amount),
        totalAmount: requiredNum(row.total_amount),
        totalExpensesLoaded: num(row.total_expenses_loaded ?? 0),
        priceIncludesVat: String(row.price_includes_vat ?? "false").trim().toLowerCase() === "true",
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
        ["branch_code", doc.branchCode, String(row.branch_code ?? "").trim()],
        ["payment_type", doc.paymentType, String(row.payment_type ?? "credit").trim().toLowerCase() || "credit"],
        ["currency_code", doc.currencyCode, String(row.currency_code ?? "SAR").trim().toUpperCase() || "SAR"],
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
      if (doc.priceIncludesVat !== (String(row.price_includes_vat ?? "false").trim().toLowerCase() === "true")) {
        doc.issues.push("قيمة price_includes_vat تختلف بين سطور المستند");
      }
    }
    if (!sourceNumber) doc.issues.push("رقم المستند المصدر مطلوب");
    if (!validIsoDate(date)) doc.issues.push("التاريخ غير صالح، استخدم YYYY-MM-DD");
    if (!String(row.payment_type ?? "").trim()) doc.issues.push("طريقة السداد مطلوبة");
    if (!String(row.currency_code ?? "").trim()) doc.issues.push("رمز العملة مطلوب");
    if (!["true", "false"].includes(String(row.price_includes_vat ?? "").trim().toLowerCase())) {
      doc.issues.push("حدد price_includes_vat بقيمة true أو false");
    }
    if (!doc.partyCode) doc.issues.push("كود العميل/المورد مطلوب");
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
    const vatRate = requiredNum(row.vat_rate);
    if (![qty, unitPrice, lineTotal, discount, vatRate].every(Number.isFinite) || qty <= 0 || unitPrice < 0 || lineTotal < 0 || discount < 0 || discount > 100 || vatRate < 0) {
      doc.issues.push("بيانات كمية/سعر/خصم/ضريبة غير صالحة");
    }
    doc.lines.push({
      itemCode: String(row.item_code ?? "").trim(),
      warehouseCode: String(row.warehouse_code ?? "").trim(),
      qty, unitPrice, lineTotal, discount, vatRate,
      discountAmount: num(row.line_discount_amount ?? 0),
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

async function requestJson(url: string, token: string | null, method = "GET", body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `فشل الطلب (${response.status})`);
  return data;
}

export function HistoricalDocumentsMigration({ cid, token, toast }: {
  cid: number;
  token: string | null;
  toast: (args: any) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<Kind>("sales_invoice");
  const [fileName, setFileName] = useState("");
  const [docs, setDocs] = useState<HistoricalDoc[]>([]);
  const [masters, setMasters] = useState<Master | null>(null);
  const [masterError, setMasterError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [periodScan, setPeriodScan] = useState<any>(null);
  const [periodRanges, setPeriodRanges] = useState<Record<number, { startDate: string; endDate: string }>>({});
  const [results, setResults] = useState<Array<{ sourceNumber: string; status: string; detail: string }>>([]);
  const [sourceInvoiceIds, setSourceInvoiceIds] = useState<Record<string, number>>({});

  const issueCount = useMemo(() => docs.reduce((sum, doc) => sum + doc.issues.length, 0), [docs]);
  const validDocs = useMemo(() => docs.filter((doc) => doc.issues.length === 0), [docs]);

  async function loadMasters() {
    if (masters) return masters;
    setLoading(true);
    try {
      const blob = await exportData(token, {
        companyId: cid,
        types: ["items", "customers", "suppliers", "branches", "warehouses", "cashBoxes", "bankAccounts"],
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

  async function onFile(file: File) {
    setFileName(file.name);
    setResults([]);
    setPeriodScan(null);
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("الملف لا يحتوي على ورقة بيانات");
      const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "", raw: true });
      if (!rows.length) throw new Error("الملف فارغ");
      const headerMap = new Map(Object.keys(rows[0]).map((header) => [norm(header).replaceAll(" ", "_"), header]));
      const missing = requiredHeaders.filter((header) => !headerMap.has(header));
      if (missing.length) throw new Error(`أعمدة مطلوبة غير موجودة: ${missing.join(", ")}`);
      const normalizedRows = rows.map((row) => Object.fromEntries([...headerMap].map(([canonical, original]) => [
        canonical,
        canonical === "document_date" ? normalizeDate(row[original]) : row[original],
      ])));
      const parsed = parseDocuments(normalizedRows, kind);
      setDocs(parsed);
      await loadMasters();
      toast({ title: `تمت قراءة ${parsed.length} مستندًا`, description: "ستظهر أخطاء المطابقة قبل أي حفظ." });
    } catch (error: any) {
      setDocs([]);
      toast({ title: error?.message ?? "تعذرت قراءة الملف", variant: "destructive" });
    }
  }

  function downloadTemplate() {
    const headers = [
      "source_doc_number", "document_date", "party_code", "branch_code", "item_code", "item_name",
      "warehouse_code", "qty", "free_qty", "unit_price", "discount_percent", "line_discount_amount",
      "vat_rate", "line_total", "subtotal", "vat_amount", "discount_amount", "total_amount",
      "payment_type", "currency_code", "exchange_rate", "cash_box_code", "bank_account_code",
      "source_invoice_number", "line_notes", "price_includes_vat", "total_expenses_loaded",
    ];
    const example = ["OLD-001", "2024-01-15", "CUST-001", "BR-01", "ITEM-001", "صنف تجريبي", "WH-01", 2, 0, 100, 0, 0, 15, 230, 200, 30, 0, 230, "credit", "SAR", 1, "", "", "", "", "false", 0];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, example]), "Historical documents");
    XLSX.writeFile(workbook, "historical-documents-template.xlsx");
  }

  function validateAgainstMasters(doc: HistoricalDoc, sourceIds: Record<string, number>) {
    const issues = [...doc.issues];
    const indexes = {
      items: indexByCode(masters?.items),
      parties: indexByCode(doc.kind.startsWith("sales") ? masters?.customers : masters?.suppliers),
      branches: indexByCode(masters?.branches),
      warehouses: indexByCode(masters?.warehouses),
      cashBoxes: indexByCode(masters?.cashBoxes),
      bankAccounts: indexByCode(masters?.bankAccounts),
    };
    const party = resolveCode(indexes.parties, doc.partyCode, doc.kind.startsWith("sales") ? "العميل" : "المورد", issues);
    const branch = resolveCode(indexes.branches, doc.branchCode, "الفرع", issues);
    const lines = doc.lines.map((line) => {
      const item = resolveCode(indexes.items, line.itemCode, "الصنف", issues);
      const warehouse = line.warehouseCode ? resolveCode(indexes.warehouses, line.warehouseCode, "المخزن", issues) : null;
      const itemType = String(item?.itemType ?? item?.type ?? "stock").toLowerCase();
      if (item && !warehouse && itemType !== "service" && itemType !== "prepaid_expense") {
        issues.push(`المخزن مطلوب للصنف ${line.itemCode}`);
      }
      return {
        ...line,
        itemId: item?.id ?? null,
        itemName: line.itemName || item?.nameAr || item?.name || line.itemCode,
        itemCode: item?.code ?? line.itemCode,
        unitId: item?.unitId ?? null,
        unit: item?.unitName ?? item?.unit ?? null,
        warehouseId: warehouse?.id ?? null,
      };
    });
    const cashBox = doc.paymentType === "cash" ? resolveCode(indexes.cashBoxes, doc.cashBoxCode, "الخزنة", issues) : null;
    const bank = doc.paymentType === "bank" ? resolveCode(indexes.bankAccounts, doc.bankAccountCode, "الحساب البنكي", issues) : null;
    if (!["credit", "cash", "bank"].includes(doc.paymentType)) issues.push("طريقة السداد يجب أن تكون credit أو cash أو bank");
    if (doc.kind.endsWith("_return") && !doc.sourceInvoiceNumber) issues.push("رقم الفاتورة المصدر مطلوب للمرتجع");
    const sourceInvoiceId = doc.sourceInvoiceNumber ? sourceIds[`${doc.kind.startsWith("sales") ? "sales" : "purchase"}:${doc.sourceInvoiceNumber}`] : undefined;
    if (doc.kind.endsWith("_return") && doc.sourceInvoiceNumber && !sourceInvoiceId) {
      issues.push("الفاتورة المصدر غير موجودة في دفعة الاستيراد الحالية؛ استورد الفواتير أولاً في الجلسة نفسها.");
    }
    return { issues, party, branch, lines, cashBox, bank, sourceInvoiceId };
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
    if (!masters || !periodScan || periodScan.periodsMissing?.length || periodScan.closedPeriodConflicts?.length || periodScan.yearsToCreate?.length) return;
    const anticipatedSources = { ...sourceInvoiceIds };
    for (const doc of docs) {
      if (doc.kind.endsWith("_invoice")) {
        anticipatedSources[`${doc.kind.startsWith("sales") ? "sales" : "purchase"}:${doc.sourceNumber}`] = -1;
      }
    }
    const refs = docs.map((doc) => ({ doc, ...validateAgainstMasters(doc, anticipatedSources) }));
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
      const ordered = [...refs].sort((a, b) =>
        Number(a.doc.kind.endsWith("_return")) - Number(b.doc.kind.endsWith("_return"))
        || a.doc.date.localeCompare(b.doc.date)
      );
      for (const entry of ordered) {
        const { doc, party, branch, lines, cashBox, bank } = entry;
        const currentSourceId = doc.sourceInvoiceNumber
          ? nextSourceIds[`${doc.kind.startsWith("sales") ? "sales" : "purchase"}:${doc.sourceInvoiceNumber}`]
          : undefined;
        if (doc.kind.endsWith("_return") && !currentSourceId) {
          nextResults.push({ sourceNumber: doc.sourceNumber, status: "تعذر الترحيل", detail: "الفاتورة المصدر لم تُرحّل بنجاح في هذه الدفعة." });
          setResults([...nextResults]);
          continue;
        }
        const createPath = doc.kind === "sales_invoice" ? "/api/sales/sales-invoices"
          : doc.kind === "purchase_invoice" ? "/api/purchasing/purchase-invoices"
          : doc.kind === "sales_return" ? "/api/sales/sales-returns"
          : "/api/purchasing/purchase-returns";
        const postPath = doc.kind === "sales_invoice" ? (id: number) => `/api/sales/sales-invoices/${id}/post`
          : doc.kind === "purchase_invoice" ? (id: number) => `/api/purchasing/purchase-invoices/${id}/post`
          : doc.kind === "sales_return" ? (id: number) => `/api/sales/sales-returns/${id}/post`
          : (id: number) => `/api/purchasing/purchase-returns/${id}/post`;
        const mappedLines = lines.map((line: any) => ({
          itemId: line.itemId, itemName: line.itemName, itemCode: line.itemCode,
          unitId: line.unitId, unit: line.unit, warehouseId: line.warehouseId, qty: line.qty, freeQty: line.freeQty,
          unitPrice: line.unitPrice, discount: line.discount,
          discountAmount: line.discountAmount, vatRate: line.vatRate,
          lineTotal: line.lineTotal, notes: line.notes,
        }));
        const payload: any = {
          companyId: cid, clientRequestId: await stableKey(cid, doc.kind, doc.sourceNumber, doc.date),
          branchId: branch.id, paymentType: doc.paymentType,
          cashBoxId: cashBox?.id ?? null, bankAccountId: bank?.id ?? null,
          currencyCode: doc.currencyCode, exchangeRate: doc.exchangeRate,
          subtotal: doc.subtotal.toFixed(2), vatAmount: doc.vatAmount.toFixed(2),
          discountAmount: doc.discountAmount.toFixed(2), totalAmount: doc.totalAmount.toFixed(2),
          totalExpensesLoaded: doc.totalExpensesLoaded.toFixed(2),
          priceIncludesVat: doc.priceIncludesVat, notes: `استيراد تاريخي — رقم المصدر: ${doc.sourceNumber}`,
          lines: mappedLines,
        };
        if (doc.kind === "sales_invoice") {
          Object.assign(payload, { invoiceDate: doc.date, customerId: party.id });
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
          if (created.status !== "posted") await requestJson(postPath(id), token, "PATCH", {});
          if (doc.kind.endsWith("_invoice")) nextSourceIds[`${doc.kind.startsWith("sales") ? "sales" : "purchase"}:${doc.sourceNumber}`] = id;
          nextResults.push({ sourceNumber: doc.sourceNumber, status: "تم الترحيل", detail: created.idempotentReplay ? "استُعيد المستند السابق ثم اكتمل الترحيل" : `${kindLabels[doc.kind]} — ${created.docNumber ?? id}` });
        } catch (error: any) {
          nextResults.push({ sourceNumber: doc.sourceNumber, status: "تعذر الترحيل", detail: error?.message ?? "خطأ غير معروف" });
        }
        setSourceInvoiceIds({ ...nextSourceIds });
        setResults([...nextResults]);
      }
      toast({ title: "انتهى ترحيل المستندات", description: `${nextResults.filter((item) => item.status === "تم الترحيل").length} ناجح من ${nextResults.length}` });
    } finally {
      setBusy(false);
    }
  }

  const periodsReady = !!periodScan
    && !(periodScan.yearsToCreate?.length)
    && !(periodScan.periodsMissing?.length)
    && !(periodScan.orphans?.length)
    && !(periodScan.closedPeriodConflicts?.length);

  return (
    <Card>
      <CardContent className="space-y-4 p-4" dir="rtl">
        <div>
          <h3 className="font-bold">استيراد المستندات التاريخية</h3>
          <p className="text-xs text-muted-foreground">يُنشأ كل مستند كمسودة ثم يُرحّل عبر واجهة النظام المعتادة. لا تُعاد بيانات التأسيس. استورد فواتير الشراء قبل المبيعات عند الحاجة للمخزون؛ والمرتجعات تتطلب استيراد فواتيرها المصدر أولاً في الجلسة نفسها.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={kind} onValueChange={(value) => { setKind(value as Kind); setDocs([]); setPeriodScan(null); setResults([]); }}>
            <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(kindLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" onClick={downloadTemplate}><FileDown className="ml-1 h-4 w-4" />تنزيل نموذج موحد</Button>
          <input ref={fileRef} className="hidden" type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void onFile(file); }} />
          <Button onClick={() => fileRef.current?.click()} disabled={loading || busy}><Upload className="ml-1 h-4 w-4" />{loading ? "تحميل المطابقات…" : "رفع ملف"}</Button>
          {fileName && <span className="text-xs text-muted-foreground">{fileName}</span>}
        </div>
        {masterError && <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{masterError}</div>}
        {!!docs.length && (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">{docs.length} مستند</Badge>
              <Badge variant={issueCount ? "destructive" : "outline"}>{issueCount} خطأ إدخال</Badge>
              <Badge variant="outline">{validDocs.length} صالح مبدئيًا</Badge>
            </div>
            <div className="max-h-56 overflow-auto rounded border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted"><tr className="text-right"><th className="p-2">رقم المصدر</th><th className="p-2">التاريخ</th><th className="p-2">النوع</th><th className="p-2">السطور</th><th className="p-2">الحالة</th></tr></thead>
                <tbody>{docs.map((doc) => <tr key={doc.key} className="border-t">
                  <td className="p-2">{doc.sourceNumber}</td><td className="p-2" dir="ltr">{doc.date}</td><td className="p-2">{kindLabels[doc.kind]}</td><td className="p-2">{doc.lines.length}</td>
                  <td className="p-2">{doc.issues.length ? <span className="text-red-700">{doc.issues[0]}</span> : <span className="text-emerald-700">جاهز للفحص</span>}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={scanPeriods} disabled={busy || issueCount > 0 || !masters}>
                {busy ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-1 h-4 w-4" />}فحص الفترات المالية
              </Button>
              <Button onClick={importDocuments} disabled={busy || !periodsReady || issueCount > 0 || !masters}>
                {busy ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Upload className="ml-1 h-4 w-4" />}إنشاء وترحيل المستندات
              </Button>
            </div>
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
