// Visual WYSIWYG designer for print templates across the system.
// Free drag/resize/style of text, images, tables, fields, rectangles, and
// lines. Saved layouts are rendered by the matching document print modal.

import { useEffect, useMemo, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  normalizeDragSelection,
  selectionContainsCenter,
  selectionIntersects,
  type SelectionBounds,
} from "./printDesigner/selection";
import {
  Plus, Trash2, Save, Copy, FileText, Image as ImageIcon, Type, Square,
  Minus, Table as TableIcon, Tag, Star, Download, Printer, ZoomIn, ZoomOut,
  LayoutTemplate, X, CheckCircle2, Maximize2, PanelLeftOpen, PanelRightOpen,
  Box, MousePointer2, Undo2, Redo2, RotateCcw,
} from "lucide-react";
import { createQuotationBaseLayout, PRESETS_BY_DOC, type PresetDescriptor } from "./printDesigner/presets";
import {
  getDefaultSalesPrintTemplateId,
  getEnabledSalesPrintTemplates,
} from "@/lib/salesPrintTemplateCatalog";
import {
  applyPrintFieldVisibility,
  inferPrintColumnFromLabel,
  inferPrintFieldFromLabel,
} from "@/lib/printFieldVisibility";
import {
  composeQuotationBaseWithCustomLayout,
  renderQuotationCustomLayoutHtml,
} from "@/lib/quotationCustomPrint";
import { renderSalesBaseTemplatePreviewHtml } from "@/pages/sales/SalesPrintModal";

// ───────────────────────────── Types ─────────────────────────────

type DocumentType =
  | "sales_invoice" | "sales_quotation" | "purchase_invoice" | "sales_return" | "purchase_return"
  | "receipt_voucher" | "payment_voucher" | "bank_receipt" | "treasury_receipt"
  | "account_statement" | "journal_entry";

type ElementType = "text" | "image" | "rect" | "line" | "table" | "field" | "container";

interface TableColumn {
  key: string; label: string; width?: number; align?: "start" | "end" | "center";
}

interface Element {
  id: string;
  type: ElementType;
  x: number; y: number; width: number; height: number;
  rotation?: number;
  zIndex?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  textAlign?: "start" | "end" | "center" | "justify";
  color?: string;
  background?: string;
  borderColor?: string;
  borderWidth?: number;
  borderStyle?: string;
  padding?: number;
  opacity?: number;
  text?: string;
  src?: string;
  fieldKey?: string;
  tableSpec?: {
    columns: TableColumn[];
    headerBg?: string;
    headerColor?: string;
    rowBg?: string;
    altRowBg?: string;
    borderColor?: string;
    borderWidth?: number;
  };
}

interface Layout {
  elements: Element[];
  pageBackground?: string;
  margins?: { top: number; right: number; bottom: number; left: number };
  baseTemplateId?: number;
  baseTemplateVersion?: number;
  hiddenBaseFields?: string[];
}

interface PendingRegionSelection {
  bounds: SelectionBounds;
  hiddenBaseFields: string[];
  tableColumns: Record<string, string[]>;
  elementIds: string[];
}

interface Template {
  id: number;
  companyId: number;
  documentType: DocumentType;
  name: string;
  isDefault: boolean;
  paperSize: string;
  widthMm: number;
  heightMm: number;
  layoutJson: Layout;
  createdAt: string;
  updatedAt: string;
}

interface DesignSnapshot {
  selectedTemplateId: number | null;
  layout: Layout;
  templateName: string;
  paperSize: string;
  widthMm: number;
  heightMm: number;
  saved: boolean;
}

type SalesDesignerDocument = "sales_invoice" | "sales_quotation" | "sales_return";

function isSalesDesignerDocument(value: DocumentType): value is SalesDesignerDocument {
  return value === "sales_invoice" || value === "sales_quotation" || value === "sales_return";
}

const PRINT_FIELD_LABELS: Record<string, string> = {
  companyDetails: "بيانات الشركة",
  documentNumber: "رقم المستند",
  date: "التاريخ",
  createdAt: "تاريخ الإنشاء",
  printedAt: "وقت الطباعة",
  partyName: "اسم العميل أو المورد",
  partyVat: "الرقم الضريبي",
  partyAddress: "العنوان",
  branch: "الفرع",
  seller: "مندوب المبيعات",
  paymentMethod: "طريقة الدفع",
  currency: "العملة",
  exchangeRate: "سعر الصرف",
  notes: "ملاحظات",
  qr: "رمز QR",
  amountInWords: "المبلغ كتابةً",
  subtotal: "المجموع قبل الضريبة",
  discountTotal: "إجمالي الخصم",
  taxTotal: "إجمالي الضريبة",
  grandTotal: "الإجمالي النهائي",
  validUntil: "صالح حتى",
  deliveryDate: "تاريخ التسليم",
  terms: "الشروط والأحكام",
  status: "حالة المستند",
  invoiceNumber: "رقم الفاتورة المرتبطة",
  description: "الوصف",
  signatures: "التوقيعات",
  itemCode: "رمز الصنف",
  itemName: "اسم الصنف",
  quantity: "الكمية",
  freeQuantity: "الكمية المجانية",
  unit: "الوحدة",
  unitPrice: "سعر الوحدة",
  discountPercent: "نسبة الخصم",
  discountAmount: "قيمة الخصم",
  taxRate: "نسبة الضريبة",
  taxAmount: "قيمة الضريبة",
  lineTotal: "إجمالي السطر",
};

function designerColumnVisibilityKey(key: string): string | undefined {
  if (key === "name" || key === "itemName") return "itemName";
  if (key === "code" || key === "itemCode") return "itemCode";
  if (key === "qty" || key === "quantity") return "quantity";
  if (key === "freeQty" || key === "freeQuantity") return "freeQuantity";
  if (key === "unit") return "unit";
  if (key === "price" || key === "unitPrice") return "unitPrice";
  if (key === "discount") return "discountAmount";
  if (key === "discountPercent") return "discountPercent";
  if (key === "vat" || key === "tax") return "taxAmount";
  if (key === "taxRate") return "taxRate";
  if (key === "total" || key === "lineTotal") return "lineTotal";
  if (key === "description") return "description";
  if (key === "account") return "account";
  return undefined;
}

// ───────────────────────────── Catalog ───────────────────────────

const DOC_TYPES: { value: DocumentType; label: string }[] = [
  { value: "sales_invoice",     label: "فاتورة مبيعات" },
  { value: "sales_quotation",   label: "عرض سعر" },
  { value: "purchase_invoice",  label: "فاتورة مشتريات" },
  { value: "sales_return",      label: "مرتجع مبيعات" },
  { value: "purchase_return",   label: "مرتجع مشتريات" },
  { value: "receipt_voucher",   label: "سند قبض" },
  { value: "payment_voucher",   label: "سند صرف" },
  { value: "bank_receipt",      label: "إيصال بنك" },
  { value: "treasury_receipt",  label: "إيصال خزينة" },
  { value: "account_statement", label: "كشف حساب" },
  { value: "journal_entry",     label: "قيد محاسبي" },
];

// Field placeholders available per document type. Used by the
// "حقول البيانات" sidebar to insert smart-placeholder text elements that
// the renderer will later substitute at print time.
const FIELDS_BY_DOC: Record<DocumentType, { key: string; label: string }[]> = {
  sales_invoice: [
    { key: "company.name",      label: "اسم الشركة" },
    { key: "company.vat",       label: "الرقم الضريبي" },
    { key: "company.address",   label: "عنوان الشركة" },
    { key: "company.phone",     label: "هاتف الشركة" },
    { key: "invoice.number",    label: "رقم الفاتورة" },
    { key: "invoice.date",      label: "تاريخ الفاتورة" },
    { key: "customer.name",     label: "اسم العميل" },
    { key: "customer.vat",      label: "ضريبي العميل" },
    { key: "customer.address",  label: "عنوان العميل" },
    { key: "totals.subtotal",   label: "المجموع الفرعي" },
    { key: "totals.discount",   label: "الخصم" },
    { key: "totals.vat",        label: "الضريبة" },
    { key: "totals.grand",      label: "الإجمالي" },
    { key: "totals.grandWords", label: "الإجمالي كتابة" },
    { key: "qr.zatca",          label: "QR زاتكا" },
    { key: "notes",             label: "ملاحظات" },
  ],
  sales_quotation: [
    { key: "company.name",         label: "اسم الشركة" },
    { key: "company.vat",          label: "الرقم الضريبي" },
    { key: "company.address",      label: "عنوان الشركة" },
    { key: "company.phone",        label: "هاتف الشركة" },
    { key: "quotation.number",    label: "رقم عرض السعر" },
    { key: "quotation.date",      label: "تاريخ العرض" },
    { key: "quotation.validUntil", label: "صالح حتى" },
    { key: "customer.name",       label: "اسم العميل" },
    { key: "customer.vat",        label: "الرقم الضريبي للعميل" },
    { key: "customer.address",    label: "عنوان العميل" },
    { key: "totals.subtotal",     label: "المجموع قبل الخصم" },
    { key: "totals.discount",     label: "الخصم" },
    { key: "totals.vat",          label: "الضريبة" },
    { key: "totals.grand",        label: "الإجمالي" },
    { key: "totals.grandWords",   label: "الإجمالي كتابة" },
    { key: "items.count",         label: "عدد الأصناف" },
    { key: "qr.zatca",            label: "رمز QR" },
    { key: "notes",               label: "ملاحظات" },
  ],
  purchase_invoice: [
    { key: "company.name", label: "اسم الشركة" },
    { key: "invoice.number", label: "رقم الفاتورة" },
    { key: "invoice.date", label: "التاريخ" },
    { key: "supplier.name", label: "اسم المورد" },
    { key: "supplier.vat", label: "ضريبي المورد" },
    { key: "totals.subtotal", label: "المجموع الفرعي" },
    { key: "totals.vat", label: "الضريبة" },
    { key: "totals.grand", label: "الإجمالي" },
  ],
  sales_return: [
    { key: "return.number", label: "رقم المرتجع" },
    { key: "return.date", label: "التاريخ" },
    { key: "invoice.number", label: "رقم الفاتورة الأصلية" },
    { key: "customer.name", label: "اسم العميل" },
    { key: "totals.grand", label: "إجمالي المرتجع" },
  ],
  purchase_return: [
    { key: "return.number", label: "رقم المرتجع" },
    { key: "return.date", label: "التاريخ" },
    { key: "supplier.name", label: "اسم المورد" },
    { key: "totals.grand", label: "إجمالي المرتجع" },
  ],
  receipt_voucher: [
    { key: "voucher.number", label: "رقم السند" },
    { key: "voucher.date", label: "التاريخ" },
    { key: "voucher.amount", label: "المبلغ" },
    { key: "voucher.amountWords", label: "المبلغ كتابة" },
    { key: "voucher.payer", label: "المستلم منه" },
    { key: "voucher.description", label: "البيان" },
    { key: "voucher.method", label: "طريقة الدفع" },
  ],
  payment_voucher: [
    { key: "voucher.number", label: "رقم السند" },
    { key: "voucher.date", label: "التاريخ" },
    { key: "voucher.amount", label: "المبلغ" },
    { key: "voucher.amountWords", label: "المبلغ كتابة" },
    { key: "voucher.beneficiary", label: "المستفيد" },
    { key: "voucher.description", label: "البيان" },
  ],
  bank_receipt: [
    { key: "bank.name", label: "اسم البنك" },
    { key: "bank.account", label: "رقم الحساب" },
    { key: "voucher.amount", label: "المبلغ" },
    { key: "voucher.date", label: "التاريخ" },
  ],
  treasury_receipt: [
    { key: "treasury.name", label: "اسم الخزينة" },
    { key: "voucher.amount", label: "المبلغ" },
    { key: "voucher.date", label: "التاريخ" },
  ],
  account_statement: [
    { key: "account.name",   label: "اسم الحساب" },
    { key: "account.code",   label: "رقم الحساب" },
    { key: "period.from",    label: "من تاريخ" },
    { key: "period.to",      label: "إلى تاريخ" },
    { key: "totals.opening", label: "الرصيد الافتتاحي" },
    { key: "totals.debit",   label: "إجمالي المدين" },
    { key: "totals.credit",  label: "إجمالي الدائن" },
    { key: "totals.closing", label: "الرصيد الختامي" },
  ],
  journal_entry: [
    { key: "je.number",      label: "رقم القيد" },
    { key: "je.date",        label: "التاريخ" },
    { key: "je.description", label: "البيان" },
    { key: "je.totalDebit",  label: "إجمالي المدين" },
    { key: "je.totalCredit", label: "إجمالي الدائن" },
  ],
};

// Default table columns per doc type (used when adding a "table" element).
const DEFAULT_TABLE_COLS: Record<DocumentType, TableColumn[]> = {
  sales_invoice: [
    { key: "no",       label: "م",        width: 30,  align: "center" },
    { key: "name",     label: "الصنف",     width: 180, align: "start"  },
    { key: "qty",      label: "الكمية",   width: 60,  align: "center" },
    { key: "price",    label: "السعر",    width: 70,  align: "end"    },
    { key: "discount", label: "الخصم",    width: 60,  align: "end"    },
    { key: "vat",      label: "الضريبة",  width: 60,  align: "end"    },
    { key: "total",    label: "الإجمالي", width: 80,  align: "end"    },
  ],
  sales_quotation: [
    { key: "no",       label: "م",        width: 30,  align: "center" },
    { key: "name",     label: "الصنف",    width: 190, align: "start" },
    { key: "qty",      label: "الكمية",   width: 55,  align: "center" },
    { key: "price",    label: "السعر",    width: 70,  align: "end" },
    { key: "discount", label: "الخصم",    width: 55,  align: "end" },
    { key: "vat",      label: "الضريبة",  width: 55,  align: "end" },
    { key: "total",    label: "الإجمالي", width: 75,  align: "end" },
  ],
  purchase_invoice: [
    { key: "no",    label: "م",        width: 30,  align: "center" },
    { key: "name",  label: "الصنف",     width: 200, align: "start"  },
    { key: "qty",   label: "الكمية",   width: 70,  align: "center" },
    { key: "price", label: "السعر",    width: 80,  align: "end"    },
    { key: "total", label: "الإجمالي", width: 90,  align: "end"    },
  ],
  sales_return: [
    { key: "no", label: "م", width: 30, align: "center" },
    { key: "name", label: "الصنف", width: 200, align: "start" },
    { key: "qty", label: "الكمية", width: 70, align: "center" },
    { key: "total", label: "الإجمالي", width: 90, align: "end" },
  ],
  purchase_return: [
    { key: "no", label: "م", width: 30, align: "center" },
    { key: "name", label: "الصنف", width: 200, align: "start" },
    { key: "qty", label: "الكمية", width: 70, align: "center" },
    { key: "total", label: "الإجمالي", width: 90, align: "end" },
  ],
  receipt_voucher: [],
  payment_voucher: [],
  bank_receipt:    [],
  treasury_receipt:[],
  account_statement: [
    { key: "date",        label: "التاريخ",  width: 90,  align: "center" },
    { key: "ref",         label: "المرجع",   width: 80,  align: "center" },
    { key: "description", label: "البيان",   width: 220, align: "start"  },
    { key: "debit",       label: "مدين",     width: 80,  align: "end"    },
    { key: "credit",      label: "دائن",     width: 80,  align: "end"    },
    { key: "balance",     label: "الرصيد",  width: 90,  align: "end"    },
  ],
  journal_entry: [
    { key: "account",     label: "الحساب",   width: 220, align: "start"  },
    { key: "description", label: "البيان",   width: 220, align: "start"  },
    { key: "debit",       label: "مدين",     width: 90,  align: "end"    },
    { key: "credit",      label: "دائن",     width: 90,  align: "end"    },
  ],
};

// mm → px at screen scale (96dpi · 1mm ≈ 3.7795 px). The Rnd canvas works
// in screen pixels and we keep px in JSON for fidelity with the print
// renderer. Could be reworked to store mm-based units later.
const MM = 3.7795;

function uid() {
  return `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultElement(type: ElementType, docType: DocumentType, fieldKey?: string, fieldLabel?: string): Element {
  const base: Element = {
    id: uid(), type, x: 40, y: 40, width: 200, height: 40, rotation: 0, zIndex: 1,
    fontFamily: "Tahoma, Arial, sans-serif",
    fontSize: 14, fontWeight: "400", textAlign: "start",
    color: "#111827", padding: 4, opacity: 1,
  };
  if (type === "text")  return { ...base, text: "نص" };
  if (type === "field") return { ...base, fieldKey: fieldKey ?? "company.name", text: fieldLabel ?? "{حقل}" };
  if (type === "image") return { ...base, src: "", width: 140, height: 140, background: "#f3f4f6" };
  if (type === "rect")  return { ...base, background: "#e5e7eb", borderColor: "#9ca3af", borderWidth: 1, borderStyle: "solid", width: 200, height: 80 };
  if (type === "line")  return { ...base, background: "#111827", height: 2, width: 240 };
  if (type === "container") return {
    ...base, width: 360, height: 220, zIndex: 0,
    background: "transparent",
    borderColor: "#94a3b8", borderWidth: 1, borderStyle: "dashed",
    text: "صندوق",
  };
  if (type === "table") return {
    ...base, width: 520, height: 200, background: "#ffffff",
    tableSpec: {
      columns: DEFAULT_TABLE_COLS[docType] ?? DEFAULT_TABLE_COLS.sales_invoice,
      headerBg: "#1f2937", headerColor: "#ffffff", rowBg: "#ffffff",
      altRowBg: "#f9fafb", borderColor: "#e5e7eb", borderWidth: 1,
    },
  };
  return base;
}

function emptyLayout(): Layout {
  return { elements: [], pageBackground: "#ffffff", margins: { top: 10, right: 10, bottom: 10, left: 10 } };
}

const DESIGNER_SAMPLE_FIELDS: Record<string, string> = {
  "company.name": "شركة الأفق للتقنية",
  "company.vat": "300123456700003",
  "company.address": "الرياض، المملكة العربية السعودية",
  "company.phone": "011 234 5678",
  "invoice.number": "SI-2026-0042",
  "invoice.date": "10/11/2026",
  "quotation.number": "SQ-2026-0018",
  "quotation.date": "10/11/2026",
  "quotation.validUntil": "25/11/2026",
  "return.number": "SR-2026-0005",
  "return.date": "10/11/2026",
  "customer.name": "مؤسسة النور التجارية",
  "customer.vat": "310123456700003",
  "customer.address": "جدة، حي الروضة",
  "supplier.name": "شركة الإمداد",
  "supplier.vat": "310987654300003",
  "totals.subtotal": "1,000.00 ر.س",
  "totals.discount": "50.00 ر.س",
  "totals.vat": "142.50 ر.س",
  "totals.grand": "1,092.50 ر.س",
  "totals.grandWords": "ألف واثنان وتسعون ريالاً وخمسون هللة",
  "items.count": "3 أصناف",
  "notes": "يسري العرض حسب الشروط الموضحة، والأسعار بالريال السعودي.",
  "qr.zatca": "رمز QR",
};

function sampleFieldText(el: Element): string {
  const value = DESIGNER_SAMPLE_FIELDS[el.fieldKey ?? ""] ?? "قيمة تجريبية";
  const text = el.text ?? "";
  return /\{[^{}]*\}/.test(text) ? text.replace(/\{[^{}]*\}/g, value) : value;
}

function sampleTableCell(key: string, row: number): string {
  const values: Record<string, string[]> = {
    no: [String(row + 1)],
    name: ["خدمة استشارية", "دعم فني سنوي", "تدريب المستخدمين"],
    qty: ["2", "1", "3"],
    unit: ["ساعة", "اشتراك", "جلسة"],
    price: ["250.00", "600.00", "150.00"],
    discount: ["25.00", "0.00", "22.50"],
    vat: ["71.25", "90.00", "57.38"],
    total: ["546.25", "690.00", "544.88"],
    debit: ["1,000.00", "—", "1,000.00"],
    credit: ["—", "250.00", "—"],
    balance: ["1,000.00", "750.00", "750.00"],
    description: ["خدمة تجريبية", "بند إضافي", "—"],
  };
  return values[key]?.[row] ?? "—";
}

const DESIGNER_SAMPLE_QUOTATION_ROWS = [
  { no: "1", name: "خدمة استشارية", qty: "2", unit: "ساعة", price: "250.00", discount: "25.00", vat: "71.25", total: "546.25" },
  { no: "2", name: "دعم فني سنوي", qty: "1", unit: "اشتراك", price: "600.00", discount: "0.00", vat: "90.00", total: "690.00" },
  { no: "3", name: "تدريب المستخدمين", qty: "3", unit: "جلسة", price: "150.00", discount: "22.50", vat: "57.38", total: "544.88" },
];

// ───────────────────────────── Page ──────────────────────────────

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function PrintDesigner() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { token, user } = useAuth() as any;
  const company = user?.company ?? {};
  const quotationBaseTemplates = useMemo(
    () => getEnabledSalesPrintTemplates(company),
    [company.printEnabledTemplates],
  );
  const defaultSalesBaseId = getDefaultSalesPrintTemplateId(company, quotationBaseTemplates, "sales_invoice");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [documentType, setDocumentType] = useState<DocumentType>("sales_invoice");
  const [baseTemplateId, setBaseTemplateId] = useState<number>(defaultSalesBaseId);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [layout, setLayout] = useState<Layout>(emptyLayout);
  const previewBaseTemplateId = Number(layout.baseTemplateId) || baseTemplateId;
  const nativeSalesPreviewHtml = useMemo(
    () => isSalesDesignerDocument(documentType) && layout.baseTemplateVersion === 2
      ? renderSalesBaseTemplatePreviewHtml(previewBaseTemplateId, documentType)
      : "",
    [documentType, layout.baseTemplateVersion, previewBaseTemplateId],
  );
  const visibleNativeSalesPreviewHtml = useMemo(() => {
    const hiddenFields = layout.hiddenBaseFields ?? [];
    if (!nativeSalesPreviewHtml || hiddenFields.length === 0 || !isSalesDesignerDocument(documentType)) return nativeSalesPreviewHtml;
    return applyPrintFieldVisibility(nativeSalesPreviewHtml, documentType, {
      [documentType]: Object.fromEntries(hiddenFields.map(field => [field, false])),
    });
  }, [nativeSalesPreviewHtml, layout.hiddenBaseFields, documentType]);
  const [paperSize, setPaperSize] = useState<string>("A4");
  const [widthMm, setWidthMm]   = useState(210);
  const [heightMm, setHeightMm] = useState(297);
  const [templateName, setTemplateName] = useState("قالب جديد");
  const designOriginRef = useRef<DesignSnapshot>({
    selectedTemplateId: null,
    layout: emptyLayout(),
    templateName: "قالب جديد",
    paperSize: "A4",
    widthMm: 210,
    heightMm: 297,
    saved: false,
  });
  const [selectedElId, setSelectedElId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [regionDeleteMode, setRegionDeleteMode] = useState(false);
  const [pendingRegionSelection, setPendingRegionSelection] = useState<PendingRegionSelection | null>(null);
  const [zoom, setZoom] = useState(0.85);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const nativePreviewFrameRef = useRef<HTMLIFrameElement>(null);
  // Undo / redo history — every call to patchLayout pushes the BEFORE state
  // onto `past` and clears `future`. Direct setLayout calls (template load,
  // first mount) intentionally do NOT touch the stacks so Ctrl+Z cannot
  // accidentally rewind to a different template's layout.
  const [past, setPast]     = useState<Layout[]>([]);
  const [future, setFuture] = useState<Layout[]>([]);
  // Marquee (rubber-band) selection. Coordinates are in page-space (unzoomed
  // pixels relative to the page top-right corner). `additive` is set when the
  // user holds Shift/Ctrl so the marquee adds to the existing selection
  // instead of replacing it.
  const [marquee, setMarquee] = useState<
    { x1: number; y1: number; x2: number; y2: number; additive: boolean } | null
  >(null);
  const [showLeftPanel, setShowLeftPanel]   = useState(true);  // elements + fields palette
  const [showRightPanel, setShowRightPanel] = useState(true);  // inspector

  // Stretch the page to fill the horizontal viewport (much more attractive
  // for portrait A4 — the page fills the workspace edge-to-edge and the
  // user scrolls vertically). For very tall pages we still cap the zoom so
  // a 80mm thermal page doesn't balloon to absurd sizes.
  const fitToPage = () => {
    const vp = canvasViewportRef.current;
    if (!vp) return;
    const padX = 32; // ~16px breathing room on each side
    const availW = vp.clientWidth - padX;
    const availH = vp.clientHeight - 32;
    const pageW = widthMm  * MM;
    const pageH = heightMm * MM;
    // Width-fit by default. If the page is much shorter than wide (landscape
    // or thermal), fall back to fitting both axes so it isn't blown up.
    const zByWidth  = availW / pageW;
    const zByHeight = availH / pageH;
    const z = pageH > pageW ? zByWidth : Math.min(zByWidth, zByHeight);
    setZoom(Math.max(0.3, Math.min(1.6, z)));
  };

  // Auto-fit on first mount, when paper size changes, or when a side panel
  // is collapsed/expanded (the available viewport width just changed).
  useEffect(() => {
    // Wait one frame so the flex layout reflows before we measure.
    const id = requestAnimationFrame(() => fitToPage());
    return () => cancelAnimationFrame(id);
  }, [widthMm, heightMm, showLeftPanel, showRightPanel]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dirty, setDirty] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  // Doc types for which we've already auto-opened the gallery this session,
  // so the user isn't pestered every time they switch back.
  const autoOpenedRef = useRef<Set<string>>(new Set());
  const canvasRef = useRef<HTMLDivElement>(null);

  // Fetch templates for the current doc type ------------------------------
  const {
    data: templates = [],
    isLoading: templatesLoading,
    isError: templatesError,
  } = useQuery<Template[]>({
    queryKey: ["print-designer", "templates", company?.id, documentType],
    queryFn: async () => {
      const r = await fetch(`${API}/api/print-designer/templates?documentType=${documentType}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  // When templates list changes (or doc type changes), pick default or create-new state.
  useEffect(() => {
    if (templatesLoading || templatesError) return;
    if (templates.length === 0) {
      setSelectedTemplateId(null);
      if (isSalesDesignerDocument(documentType)) {
        const defaultBaseId = getDefaultSalesPrintTemplateId(company, quotationBaseTemplates, documentType);
        setBaseTemplateId(defaultBaseId);
        startFromSalesBase(defaultBaseId, false);
        return;
      }
      const presets = PRESETS_BY_DOC[documentType] ?? [];
      if (presets.length > 0 && !autoOpenedRef.current.has(documentType)) {
        autoOpenedRef.current.add(documentType);
        applyPreset(presets[0]);
        return;
      }
      setLayout(emptyLayout());
      setTemplateName("قالب جديد");
      setPaperSize("A4"); setWidthMm(210); setHeightMm(297);
      setDirty(false);
      return;
    }
    const preferred = templates.find(t => t.isDefault) ?? templates[0];
    setSelectedTemplateId(preferred.id);
  }, [templates.length, documentType, templatesLoading, templatesError]); // eslint-disable-line react-hooks/exhaustive-deps

  function analyzeRegionSelection(selection: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }) {
    const bounds = normalizeDragSelection(selection);
    const hiddenBaseFields = new Set<string>();
    const tableColumns: Record<string, string[]> = {};
    const elementIds: string[] = [];

    if (nativeSalesPreviewHtml) {
      const previewDocument = nativePreviewFrameRef.current?.contentDocument;
      const page = previewDocument?.querySelector<HTMLElement>(".sheet, .page, .doc, .print-page")
        ?? previewDocument?.body;
      if (!previewDocument || !page) {
        toast({
          title: "المعاينة لم تكتمل",
          description: "انتظر لحظة حتى يكتمل تحميل النموذج ثم أعد التحديد.",
          variant: "destructive",
        });
        return;
      }
      const pageRect = page.getBoundingClientRect();
      const toPageBounds = (node: HTMLElement): SelectionBounds => {
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left - pageRect.left,
          top: rect.top - pageRect.top,
          right: rect.right - pageRect.left,
          bottom: rect.bottom - pageRect.top,
        };
      };

      for (const node of Array.from(previewDocument.querySelectorAll<HTMLElement>("[data-print-field]"))) {
        if (!selectionIntersects(bounds, toPageBounds(node))) continue;
        for (const key of (node.dataset.printField ?? "").split(/\s+/).filter(Boolean)) {
          hiddenBaseFields.add(key);
        }
      }
      for (const node of Array.from(previewDocument.querySelectorAll<HTMLElement>("div,span,p,td,th,label,strong,b,small"))) {
        if (node.children.length > 0) continue;
        const key = isSalesDesignerDocument(documentType)
          ? inferPrintFieldFromLabel(node.textContent ?? "", documentType)
          : undefined;
        if (key && selectionIntersects(bounds, toPageBounds(node))) hiddenBaseFields.add(key);
      }
      for (const image of Array.from(previewDocument.querySelectorAll<HTMLImageElement>('img[alt*="qr" i], img[alt*="zatca" i]'))) {
        if (selectionIntersects(bounds, toPageBounds(image))) hiddenBaseFields.add("qr");
      }

      for (const table of Array.from(previewDocument.querySelectorAll<HTMLTableElement>("table"))) {
        const header = Array.from(table.rows).find(row =>
          Array.from(row.cells).some(cell => cell.tagName === "TH"),
        );
        if (!header) continue;
        for (const [columnIndex, cell] of Array.from(header.cells).entries()) {
          const key = cell.dataset.printColumn || inferPrintColumnFromLabel(cell.textContent ?? "");
          if (!key) continue;
          const columnWasSelected = Array.from(table.rows)
            .map(row => row.cells.item(columnIndex))
            .filter((candidate): candidate is HTMLTableCellElement => candidate !== null && candidate.colSpan <= 1)
            .some(candidate => selectionIntersects(bounds, toPageBounds(candidate)));
          if (columnWasSelected) hiddenBaseFields.add(key);
        }
      }
    } else {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const toPageBounds = (node: HTMLElement): SelectionBounds => {
        const rect = node.getBoundingClientRect();
        return {
          left: (rect.left - canvasRect.left) / zoom,
          top: (rect.top - canvasRect.top) / zoom,
          right: (rect.right - canvasRect.left) / zoom,
          bottom: (rect.bottom - canvasRect.top) / zoom,
        };
      };
      for (const cell of Array.from(canvas.querySelectorAll<HTMLElement>("[data-designer-element-id][data-designer-column-key]"))) {
        if (!selectionIntersects(bounds, toPageBounds(cell))) continue;
        const elementId = cell.dataset.designerElementId;
        const columnKey = cell.dataset.designerColumnKey;
        if (!elementId || !columnKey) continue;
        tableColumns[elementId] = Array.from(new Set([...(tableColumns[elementId] ?? []), columnKey]));
      }
      for (const element of layout.elements) {
        const elementBounds = {
          left: element.x,
          top: element.y,
          right: element.x + element.width,
          bottom: element.y + element.height,
        };
        if (element.type === "table" && (tableColumns[element.id]?.length ?? 0) > 0) continue;
        if (
          element.type === "table"
            ? selectionContainsCenter(bounds, elementBounds)
            : selectionIntersects(bounds, elementBounds)
        ) {
          elementIds.push(element.id);
        }
      }
    }

    const selectedCount = hiddenBaseFields.size
      + Object.values(tableColumns).reduce((total, keys) => total + keys.length, 0)
      + elementIds.length;
    if (selectedCount === 0) {
      toast({
        title: "لم يتم تحديد حقول قابلة للحذف",
        description: nativeSalesPreviewHtml
          ? "اسحب التحديد فوق عنوان العمود أو الحقل المطلوب إخفاؤه."
          : "اسحب التحديد فوق الأعمدة أو العناصر المطلوب حذفها.",
      });
      setPendingRegionSelection(null);
      return;
    }
    setPendingRegionSelection({
      bounds,
      hiddenBaseFields: Array.from(hiddenBaseFields),
      tableColumns,
      elementIds,
    });
  }

  // Track a drag anywhere on the page. In region-delete mode, the selection
  // targets native template fields/columns or editable table cells. Otherwise
  // it retains the existing multi-element marquee behavior.
  useEffect(() => {
    if (!marquee) return;
    const onMove = (ev: MouseEvent) => {
      const node = canvasRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / zoom;
      const y = (ev.clientY - rect.top)  / zoom;
      setMarquee(m => (m ? { ...m, x2: x, y2: y } : m));
    };
    const onUp = () => {
      const current = marquee;
      setMarquee(null);
      const bounds = normalizeDragSelection(current);
      if (bounds.right - bounds.left < 3 && bounds.bottom - bounds.top < 3) return;
      if (regionDeleteMode) {
        analyzeRegionSelection(current);
        return;
      }
      const hit = layout.elements
        .filter(el => selectionIntersects(bounds, {
          left: el.x,
          top: el.y,
          right: el.x + el.width,
          bottom: el.y + el.height,
        }))
        .map(el => el.id);
      if (hit.length === 0) return;
      if (current.additive) {
        setSelectedIds(prev => Array.from(new Set([...prev, ...hit])));
      } else {
        setSelectedIds(hit);
      }
      setSelectedElId(hit[hit.length - 1]);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [marquee, zoom, layout, regionDeleteMode, nativeSalesPreviewHtml, documentType]);

  // Esc closes the preset gallery modal.
  useEffect(() => {
    if (!showPresets) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowPresets(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showPresets]);

  // Delete-key removes all currently-selected elements; Esc clears selection.
  // Ignored when typing inside a form field so the inspector stays usable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIds.length > 0) { e.preventDefault(); deleteSelected(); }
      } else if (e.key === "Escape") {
        if (pendingRegionSelection) setPendingRegionSelection(null);
        else if (regionDeleteMode) setRegionDeleteMode(false);
        clearSelection();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && (e.key === "z" || e.key === "Z")) || e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds, layout, pendingRegionSelection, regionDeleteMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load selected template into editor state ------------------------------
  useEffect(() => {
    if (selectedTemplateId == null) return;
    const t = templates.find(x => x.id === selectedTemplateId);
    if (!t) return;
    const savedLayout = structuredClone(t.layoutJson ?? emptyLayout());
    setLayout(savedLayout);
    if (Number.isInteger(Number(t.layoutJson?.baseTemplateId))) {
      setBaseTemplateId(Number(t.layoutJson.baseTemplateId));
    }
    setTemplateName(t.name);
    setPaperSize(t.paperSize);
    setWidthMm(t.widthMm);
    setHeightMm(t.heightMm);
    setDirty(false);
    designOriginRef.current = {
      selectedTemplateId: t.id,
      layout: structuredClone(savedLayout),
      templateName: t.name,
      paperSize: t.paperSize,
      widthMm: t.widthMm,
      heightMm: t.heightMm,
      saved: true,
    };
  }, [selectedTemplateId, templates]);

  // Mutations -------------------------------------------------------------
  function invalidateSalesPrintChoices() {
    if (isSalesDesignerDocument(documentType) && company?.id != null) {
      qc.invalidateQueries({
        queryKey: ["print-designer", "templates", company.id, documentType],
      });
    }
  }

  const createMut = useMutation({
    mutationFn: async (body: any) => {
      const r = await fetch(`${API}/api/print-designer/templates`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<Template>;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["print-designer", "templates", company?.id, documentType] });
      if (isSalesDesignerDocument(row.documentType)) invalidateSalesPrintChoices();
      setSelectedTemplateId(row.id);
      setDirty(false);
      toast({ title: "تم إنشاء القالب" });
    },
    onError: (e: any) => toast({ title: "تعذر الإنشاء", description: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: async (body: any) => {
      const r = await fetch(`${API}/api/print-designer/templates/${selectedTemplateId}`, {
        method: "PATCH", headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["print-designer", "templates", company?.id, documentType] });
      invalidateSalesPrintChoices();
      setDirty(false);
      toast({ title: "تم الحفظ" });
    },
    onError: (e: any) => toast({ title: "تعذر الحفظ", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/print-designer/templates/${id}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["print-designer", "templates", company?.id, documentType] });
      invalidateSalesPrintChoices();
      setSelectedTemplateId(null);
      toast({ title: "تم الحذف" });
    },
    onError: (e: any) => toast({ title: "تعذر الحذف", description: e.message, variant: "destructive" }),
  });

  const setDefaultMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/print-designer/templates/${id}/set-default`, { method: "POST", headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["print-designer", "templates", company?.id, documentType] });
      invalidateSalesPrintChoices();
      toast({ title: "تم تعيينه افتراضياً" });
    },
  });

  // Helpers ---------------------------------------------------------------
  const selectedEl = useMemo(
    () => layout.elements.find(e => e.id === selectedElId) ?? null,
    [layout, selectedElId],
  );
  const pendingRegionLabels = useMemo(() => {
    if (!pendingRegionSelection) return [];
    const labels = pendingRegionSelection.hiddenBaseFields.map(
      field => PRINT_FIELD_LABELS[field] ?? field,
    );
    for (const [elementId, keys] of Object.entries(pendingRegionSelection.tableColumns)) {
      const table = layout.elements.find(element => element.id === elementId);
      for (const key of keys) {
        const column = table?.tableSpec?.columns.find(item => item.key === key);
        labels.push(column?.label ?? PRINT_FIELD_LABELS[designerColumnVisibilityKey(key) ?? ""] ?? key);
      }
    }
    for (const id of pendingRegionSelection.elementIds) {
      const element = layout.elements.find(item => item.id === id);
      labels.push(element?.text
        || (element?.type === "field" ? element.fieldKey : element?.type)
        || "عنصر");
    }
    return labels;
  }, [pendingRegionSelection, layout.elements]);

  function patchLayout(next: Layout) {
    // Snapshot the BEFORE state so Ctrl+Z can roll back to it. Any new edit
    // invalidates the redo stack — standard editor semantics.
    setPast(p => [...p, layout]);
    setFuture([]);
    setLayout(next);
    setDirty(true);
  }

  function undo() {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setPast(p => p.slice(0, -1));
    setFuture(f => [layout, ...f]);
    setLayout(prev);
    setDirty(true);
    // Clear selection — the element a user had highlighted may no longer
    // exist (or have a different position) in the restored layout.
    setSelectedElId(null);
    setSelectedIds([]);
  }

  function redo() {
    if (future.length === 0) return;
    const next = future[0];
    setFuture(f => f.slice(1));
    setPast(p => [...p, layout]);
    setLayout(next);
    setDirty(true);
    setSelectedElId(null);
    setSelectedIds([]);
  }

  function addElement(type: ElementType, fieldKey?: string, fieldLabel?: string) {
    const el = defaultElement(type, documentType, fieldKey, fieldLabel);
    if (type !== "container") {
      el.zIndex = (Math.max(0, ...layout.elements.map(e => e.zIndex ?? 0)) + 1);
    }
    patchLayout({ ...layout, elements: [...layout.elements, el] });
    selectOnly(el.id);
  }

  function selectOnly(id: string) {
    setSelectedElId(id);
    setSelectedIds([id]);
  }

  function toggleInSelection(id: string) {
    setSelectedIds(prev => {
      if (prev.includes(id)) {
        const next = prev.filter(x => x !== id);
        setSelectedElId(next[next.length - 1] ?? null);
        return next;
      }
      setSelectedElId(id);
      return [...prev, id];
    });
  }

  function clearSelection() {
    setSelectedElId(null);
    setSelectedIds([]);
  }

  function moveBy(ids: string[], dx: number, dy: number) {
    if ((dx === 0 && dy === 0) || ids.length === 0) return;
    const set = new Set(ids);
    patchLayout({
      ...layout,
      elements: layout.elements.map(e =>
        set.has(e.id) ? { ...e, x: e.x + dx, y: e.y + dy } : e
      ),
    });
  }

  function containedChildIds(container: Element): string[] {
    const cx1 = container.x, cy1 = container.y;
    const cx2 = container.x + container.width, cy2 = container.y + container.height;
    return layout.elements
      .filter(e => e.id !== container.id && e.type !== "container")
      .filter(e => {
        const mx = e.x + e.width / 2;
        const my = e.y + e.height / 2;
        return mx >= cx1 && mx <= cx2 && my >= cy1 && my <= cy2;
      })
      .map(e => e.id);
  }

  function updateElement(id: string, patch: Partial<Element>) {
    patchLayout({
      ...layout,
      elements: layout.elements.map(e => (e.id === id ? { ...e, ...patch } : e)),
    });
  }

  function deleteElement(id: string) {
    patchLayout({ ...layout, elements: layout.elements.filter(e => e.id !== id) });
    if (selectedElId === id) setSelectedElId(null);
    setSelectedIds(prev => prev.filter(x => x !== id));
  }

  function deleteSelected() {
    if (selectedIds.length === 0) return;
    const set = new Set(selectedIds);
    patchLayout({ ...layout, elements: layout.elements.filter(e => !set.has(e.id)) });
    clearSelection();
  }

  function deletePendingRegionSelection() {
    if (!pendingRegionSelection) return;
    const removedElementIds = new Set(pendingRegionSelection.elementIds);
    const selectedTableColumns = pendingRegionSelection.tableColumns;
    const elements = layout.elements.flatMap(element => {
      if (removedElementIds.has(element.id)) return [];
      const selectedColumns = new Set(selectedTableColumns[element.id] ?? []);
      if (element.type !== "table" || !element.tableSpec || selectedColumns.size === 0) {
        return [element];
      }
      const columns = element.tableSpec.columns.filter(column => !selectedColumns.has(column.key));
      return columns.length === 0
        ? []
        : [{ ...element, tableSpec: { ...element.tableSpec, columns } }];
    });
    const hiddenBaseFields = Array.from(new Set([
      ...(layout.hiddenBaseFields ?? []),
      ...pendingRegionSelection.hiddenBaseFields,
    ]));
    patchLayout({ ...layout, elements, hiddenBaseFields });
    const removedCount = pendingRegionSelection.hiddenBaseFields.length
      + Object.values(selectedTableColumns).reduce((total, keys) => total + keys.length, 0)
      + pendingRegionSelection.elementIds.length;
    setPendingRegionSelection(null);
    clearSelection();
    toast({
      title: `تم حذف ${removedCount} عنصر من نسخة القالب`,
      description: "تقدر ترجع التعديل بزر التراجع أو Ctrl+Z قبل الحفظ.",
    });
  }

  function duplicateElement(id: string) {
    const el = layout.elements.find(e => e.id === id);
    if (!el) return;
    const copy: Element = { ...el, id: uid(), x: el.x + 20, y: el.y + 20 };
    patchLayout({ ...layout, elements: [...layout.elements, copy] });
    selectOnly(copy.id);
  }

  function bringForward(id: string) {
    const max = Math.max(0, ...layout.elements.map(e => e.zIndex ?? 0));
    updateElement(id, { zIndex: max + 1 });
  }
  function sendBackward(id: string) {
    const min = Math.min(0, ...layout.elements.map(e => e.zIndex ?? 0));
    updateElement(id, { zIndex: min - 1 });
  }

  function save() {
    const body = { name: templateName, paperSize, widthMm, heightMm, layoutJson: layout };
    if (selectedTemplateId) updateMut.mutate(body);
    else createMut.mutate({ documentType, ...body });
  }

  function createNew() {
    setSelectedTemplateId(null);
    const blankLayout = {
      ...emptyLayout(),
      ...(documentType === "sales_quotation" ? { baseTemplateId } : {}),
    };
    const newName = `قالب ${DOC_TYPES.find(d => d.value === documentType)?.label ?? ""}`;
    setLayout(blankLayout);
    setTemplateName(newName);
    setPaperSize("A4"); setWidthMm(210); setHeightMm(297);
    setSelectedElId(null);
    setDirty(true);
    designOriginRef.current = {
      selectedTemplateId: null,
      layout: structuredClone(blankLayout),
      templateName: newName,
      paperSize: "A4",
      widthMm: 210,
      heightMm: 297,
      saved: false,
    };
  }

  function restoreDesign() {
    const origin = designOriginRef.current;
    if (!origin) return;
    if (!window.confirm("سيتم إلغاء كل تعديلاتك الحالية والعودة إلى التصميم الأصلي. هل تريد المتابعة؟")) return;
    if (isSalesDesignerDocument(documentType) && layout.baseTemplateVersion === 2) {
      const baseId = Number(layout.baseTemplateId) || baseTemplateId;
      const base = quotationBaseTemplates.find(template => template.id === baseId);
      if (base) {
        const restoredLayout = createQuotationBaseLayout(base.id, base.color, base.thermal);
        setLayout(restoredLayout);
        setBaseTemplateId(base.id);
        setPaperSize(base.thermal ? "80mm" : "A4");
        setWidthMm(base.thermal ? 80 : 210);
        setHeightMm(base.thermal ? 200 : 297);
        setSelectedElId(null);
        setSelectedIds([]);
        setPendingRegionSelection(null);
        setDirty(true);
        setPast([]);
        setFuture([]);
        designOriginRef.current = {
          selectedTemplateId,
          layout: structuredClone(restoredLayout),
          templateName,
          paperSize: base.thermal ? "80mm" : "A4",
          widthMm: base.thermal ? 80 : 210,
          heightMm: base.thermal ? 200 : 297,
          saved: false,
        };
        toast({ title: "تمت استعادة نموذج النظام الأصلي" });
        return;
      }
    }
    setSelectedTemplateId(origin.selectedTemplateId);
    setLayout(structuredClone(origin.layout));
    setTemplateName(origin.templateName);
    setPaperSize(origin.paperSize);
    setWidthMm(origin.widthMm);
    setHeightMm(origin.heightMm);
    setSelectedElId(null);
    setSelectedIds([]);
    setPendingRegionSelection(null);
    setDirty(!origin.saved);
    setPast([]);
    setFuture([]);
    toast({ title: "تمت استعادة التصميم الأصلي" });
  }

  // Apply a starter preset: deep-clone the layout (presets may reuse element
  // refs across calls), give every element a fresh id so subsequent edits
  // don't collide, and mark the editor dirty so the user is prompted to save.
  function applyPreset(p: PresetDescriptor) {
    const quotationBase = documentType === "sales_quotation"
      ? quotationBaseTemplates.find(template => template.id === baseTemplateId) ?? quotationBaseTemplates[0]
      : undefined;
    const raw = quotationBase
      ? createQuotationBaseLayout(quotationBase.id, quotationBase.color, quotationBase.thermal)
      : p.build();
    const targetPaperSize = quotationBase?.thermal ? "80mm" : p.paperSize;
    const targetWidthMm = quotationBase?.thermal ? 80 : p.widthMm;
    const targetHeightMm = quotationBase?.thermal ? 200 : p.heightMm;
    const cloned = {
      ...raw,
      ...(quotationBase ? { baseTemplateId: quotationBase.id } : {}),
      elements: raw.elements.map(el => ({
        ...el,
        id: `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      })),
    };
    setSelectedTemplateId(null);
    setLayout(cloned);
    if (quotationBase) setBaseTemplateId(quotationBase.id);
    setTemplateName(quotationBase
      ? `${quotationBase.name} — عرض سعر مخصص`
      : `${p.name} — ${DOC_TYPES.find(d => d.value === documentType)?.label ?? ""}`);
    setPaperSize(targetPaperSize);
    setWidthMm(targetWidthMm);
    setHeightMm(targetHeightMm);
    setSelectedElId(null);
    setDirty(true);
    setShowPresets(false);
    designOriginRef.current = {
      selectedTemplateId: null,
      layout: structuredClone(cloned),
      templateName: quotationBase
        ? `${quotationBase.name} — عرض سعر مخصص`
        : `${p.name} — ${DOC_TYPES.find(d => d.value === documentType)?.label ?? ""}`,
      paperSize: targetPaperSize,
      widthMm: targetWidthMm,
      heightMm: targetHeightMm,
      saved: false,
    };
    toast({ title: "تم تحميل القالب الجاهز", description: "يمكنك الآن التعديل ثم الحفظ" });
  }

  function startFromSalesBase(id: number, confirmUnsaved = true) {
    const base = quotationBaseTemplates.find(template => template.id === id);
    if (!base) return;
    if (confirmUnsaved && dirty && !window.confirm("سيتم استبدال التعديلات غير المحفوظة. هل تريد المتابعة؟")) return;
    const raw = createQuotationBaseLayout(base.id, base.color, base.thermal);
    const cloned: Layout = {
      ...raw,
      baseTemplateId: id,
      elements: raw.elements.map(el => ({ ...el, id: uid() })),
    };
    const newName = `${base.name} — ${DOC_TYPES.find(d => d.value === documentType)?.label ?? "مبيعات"} مخصص`;
    setBaseTemplateId(id);
    setSelectedTemplateId(null);
    setLayout(cloned);
    setTemplateName(newName);
    setPaperSize(base.thermal ? "80mm" : "A4");
    setWidthMm(base.thermal ? 80 : 210);
    setHeightMm(base.thermal ? 200 : 297);
    setSelectedElId(null);
    setSelectedIds([]);
    setDirty(true);
    designOriginRef.current = {
      selectedTemplateId: null,
      layout: structuredClone(cloned),
      templateName: newName,
      paperSize: base.thermal ? "80mm" : "A4",
      widthMm: base.thermal ? 80 : 210,
      heightMm: base.thermal ? 200 : 297,
      saved: false,
    };
    toast({
      title: "تم إنشاء نسخة قابلة للتعديل",
      description: "تم تحميل نموذج النظام كنسخة قابلة للتعديل، والقالب الأصلي لم يتغير.",
    });
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ documentType, name: templateName, paperSize, widthMm, heightMm, layoutJson: layout }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `${documentType}-${templateName}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  function previewPrint() {
    const win = window.open("", "_blank", "width=900,height=1100");
    if (!win) return;
    const quotationContext = {
      fields: DESIGNER_SAMPLE_FIELDS,
      rows: DESIGNER_SAMPLE_QUOTATION_ROWS,
      showQr: false,
    };
    const quotationPage = { widthMm, heightMm, name: templateName };
    const nativeBaseHtml = isSalesDesignerDocument(documentType) && layout.baseTemplateVersion === 2
      ? renderSalesBaseTemplatePreviewHtml(previewBaseTemplateId, documentType)
      : "";
    const html = isSalesDesignerDocument(documentType)
      ? (nativeBaseHtml
          ? composeQuotationBaseWithCustomLayout(nativeBaseHtml, layout, quotationContext, quotationPage, documentType)
          : renderQuotationCustomLayoutHtml(layout, quotationContext, quotationPage))
          .replace("</body>", `<script>setTimeout(()=>window.print(),300)<\/script></body>`)
      : `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${templateName}</title>
      <style>body{margin:0;font-family:Tahoma,Arial,sans-serif;background:#eee;padding:20px;display:flex;justify-content:center}
      .page{background:${layout.pageBackground ?? "#fff"};position:relative;box-shadow:0 0 8px rgba(0,0,0,.1);width:${widthMm}mm;height:${heightMm}mm}
      @media print{body{background:#fff;padding:0}.page{box-shadow:none}}
      </style></head><body><div class="page">${renderElementsHtml(layout.elements)}</div>
      <script>setTimeout(()=>window.print(),300)<\/script></body></html>`;
    win.document.write(html); win.document.close();
  }

  // ─────────────────────────── Render ───────────────────────────
  return (
    <div className="flex flex-col h-screen bg-slate-100" dir="rtl">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b shadow-sm flex-wrap">
        <FileText className="w-5 h-5 text-indigo-600" />
        <h1 className="text-lg font-bold">مصمم نماذج الطباعة</h1>
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <select
          value={documentType}
          onChange={e => setDocumentType(e.target.value as DocumentType)}
          className="border rounded px-2 py-1 text-sm bg-white"
        >
          {DOC_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        {isSalesDesignerDocument(documentType) && (
          <label className="flex items-center gap-2 rounded-lg border border-indigo-100 bg-indigo-50/70 px-2 py-1">
            <span className="text-xs font-semibold text-indigo-900">نموذج النظام</span>
            <select
              data-testid="select-sales-base-template"
              value={quotationBaseTemplates.some(item => item.id === baseTemplateId)
                ? baseTemplateId
                : getDefaultSalesPrintTemplateId(company, quotationBaseTemplates, documentType)}
              onChange={e => startFromSalesBase(Number(e.target.value))}
              className="max-w-[190px] rounded border border-indigo-200 bg-white px-2 py-1 text-xs"
              aria-label="اختر نموذج المبيعات الأساسي"
            >
              {quotationBaseTemplates.map(template => (
                <option key={template.id} value={template.id}>{template.name}</option>
              ))}
            </select>
          </label>
        )}
        <select
          value={selectedTemplateId ?? ""}
          onChange={e => setSelectedTemplateId(e.target.value ? Number(e.target.value) : null)}
          className="border rounded px-2 py-1 text-sm bg-white min-w-[180px]"
        >
          <option value="">— قالب جديد —</option>
          {templates.map(t => (
            <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " ⭐" : ""}</option>
          ))}
        </select>
        <input
          value={templateName}
          onChange={e => { setTemplateName(e.target.value); setDirty(true); }}
          className="border rounded px-2 py-1 text-sm bg-white min-w-[180px]"
          placeholder="اسم القالب"
        />
        <button onClick={() => setShowPresets(true)}
          className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700"
          title="ابدأ من قالب جاهز قابل للتعديل">
          <LayoutTemplate className="w-4 h-4" /> قوالب جاهزة
        </button>
        <button onClick={createNew} className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-slate-100 hover:bg-slate-200"
          title="صفحة بيضاء فارغة">
          <Plus className="w-4 h-4" /> فارغ جديد
        </button>
        <button onClick={undo} disabled={past.length === 0}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
          title="تراجع (Ctrl+Z)">
          <Undo2 className="w-3.5 h-3.5" /> تراجع
        </button>
        <button onClick={redo} disabled={future.length === 0}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
          title="إعادة (Ctrl+Y)">
          <Redo2 className="w-3.5 h-3.5" /> إعادة
        </button>
        <button
          data-testid="button-restore-original-design"
          onClick={restoreDesign}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-amber-50 text-amber-800 hover:bg-amber-100"
          title="استعادة التصميم كما كان عند تحميله">
          <RotateCcw className="w-3.5 h-3.5" /> استعادة التصميم
        </button>
        <button onClick={save} disabled={updateMut.isPending || createMut.isPending}
          className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
          <Save className="w-4 h-4" /> حفظ {dirty && "•"}
        </button>
        {selectedTemplateId && (
          <>
            <button onClick={() => setDefaultMut.mutate(selectedTemplateId)}
              className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-amber-100 hover:bg-amber-200 text-amber-900">
              <Star className="w-4 h-4" /> اجعله افتراضي
            </button>
            <button onClick={() => { if (confirm("حذف القالب؟")) deleteMut.mutate(selectedTemplateId); }}
              className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-rose-100 hover:bg-rose-200 text-rose-900">
              <Trash2 className="w-4 h-4" /> حذف
            </button>
          </>
        )}
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <button onClick={previewPrint} className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-slate-100 hover:bg-slate-200">
          <Printer className="w-4 h-4" /> معاينة
        </button>
        <button onClick={exportJson} className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-slate-100 hover:bg-slate-200">
          <Download className="w-4 h-4" /> JSON
        </button>
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <div className="flex items-center gap-1 text-sm">
          <button onClick={() => setZoom(z => Math.max(0.2, z - 0.1))} className="p-1 rounded hover:bg-slate-100" title="تصغير"><ZoomOut className="w-4 h-4"/></button>
          <span className="w-12 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(2, z + 0.1))} className="p-1 rounded hover:bg-slate-100" title="تكبير"><ZoomIn className="w-4 h-4"/></button>
          <button onClick={fitToPage}
            className="ml-1 flex items-center gap-1 px-2 py-1 text-xs rounded bg-indigo-50 hover:bg-indigo-100 text-indigo-700"
            title="ملاءمة الصفحة كاملة في الشاشة">
            <Maximize2 className="w-3.5 h-3.5"/> ملاءمة
          </button>
        </div>
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <button onClick={() => setShowLeftPanel(v => !v)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${showLeftPanel ? "bg-slate-100 hover:bg-slate-200 text-slate-700" : "bg-emerald-50 hover:bg-emerald-100 text-emerald-700"}`}
          title={showLeftPanel ? "إخفاء لوحة العناصر" : "إظهار لوحة العناصر"}>
          <PanelRightOpen className="w-3.5 h-3.5"/>
          {showLeftPanel ? "إخفاء العناصر" : "إظهار العناصر"}
        </button>
        <button onClick={() => setShowRightPanel(v => !v)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${showRightPanel ? "bg-slate-100 hover:bg-slate-200 text-slate-700" : "bg-emerald-50 hover:bg-emerald-100 text-emerald-700"}`}
          title={showRightPanel ? "إخفاء لوحة الخصائص" : "إظهار لوحة الخصائص"}>
          <PanelLeftOpen className="w-3.5 h-3.5"/>
          {showRightPanel ? "إخفاء الخصائص" : "إظهار الخصائص"}
        </button>
        <button
          onClick={() => { setShowLeftPanel(false); setShowRightPanel(false); }}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-violet-50 hover:bg-violet-100 text-violet-700"
          title="وضع التركيز — يخفي اللوحات الجانبية لرؤية النموذج كاملاً">
          <Maximize2 className="w-3.5 h-3.5"/> وضع التركيز
        </button>
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <button
          onClick={() => setMultiSelectMode(v => !v)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${multiSelectMode ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-slate-100 hover:bg-slate-200 text-slate-700"}`}
          title="أداة التحديد المتعدد — اضغط على عدة عناصر لتحديدها ثم اسحبها معاً (أو استخدم Shift+click)">
          <MousePointer2 className="w-3.5 h-3.5"/>
          {multiSelectMode ? `تحديد متعدد (${selectedIds.length})` : "تحديد متعدد"}
        </button>
        <button
          data-testid="button-region-delete-mode"
          aria-pressed={regionDeleteMode}
          onClick={() => {
            setRegionDeleteMode(value => !value);
            setPendingRegionSelection(null);
            setMarquee(null);
          }}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${regionDeleteMode ? "bg-rose-600 text-white hover:bg-rose-700" : "bg-rose-50 hover:bg-rose-100 text-rose-700"}`}
          title="اسحب مستطيلاً فوق حقل أو عمود، راجع التحديد ثم احذفه">
          <MousePointer2 className="w-3.5 h-3.5"/>
          {regionDeleteMode ? "إلغاء أداة الحذف" : "تحديد للحذف"}
        </button>
        {selectedIds.length > 1 && (
          <span className="text-xs text-indigo-700 bg-indigo-50 px-2 py-1 rounded">
            {selectedIds.length} عناصر محددة — اسحب أحدها لتحريك الكل
          </span>
        )}
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <button
          onClick={() => {
            // Pull every element back inside the page bounds. Useful when a
            // template was authored on a larger paper size or got dragged off
            // the visible area — without this the boxes stay invisible at
            // export time and the user can't reach them with the mouse.
            const pageW = widthMm * MM;
            const pageH = heightMm * MM;
            setLayout(prev => ({
              ...prev,
              elements: prev.elements.map(el => {
                const w = Math.min(el.width,  pageW);
                const h = Math.min(el.height, pageH);
                const x = Math.min(Math.max(0, el.x), Math.max(0, pageW - w));
                const y = Math.min(Math.max(0, el.y), Math.max(0, pageH - h));
                return { ...el, x, y, width: w, height: h };
              }),
            }));
          }}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-amber-50 hover:bg-amber-100 text-amber-700"
          title="ارجاع كل العناصر الخارجة من حدود الصفحة إلى داخل الإطار">
          <Maximize2 className="w-3.5 h-3.5"/> إرجاع للإطار
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left palette */}
        {showLeftPanel && (
        <div className="w-56 shrink-0 bg-white border-l overflow-y-auto p-3 text-sm space-y-4">
          <div>
            <div className="font-semibold mb-2 text-slate-700">العناصر</div>
            <div className="grid grid-cols-2 gap-2">
              <PaletteBtn icon={<Type className="w-4 h-4"/>}      label="نص"      onClick={() => addElement("text")} />
              <PaletteBtn icon={<ImageIcon className="w-4 h-4"/>} label="صورة"   onClick={() => addElement("image")} />
              <PaletteBtn icon={<TableIcon className="w-4 h-4"/>} label="جدول"   onClick={() => addElement("table")} />
              <PaletteBtn icon={<Square className="w-4 h-4"/>}    label="مستطيل" onClick={() => addElement("rect")} />
              <PaletteBtn icon={<Minus className="w-4 h-4"/>}     label="خط"     onClick={() => addElement("line")} />
              <PaletteBtn icon={<Box className="w-4 h-4"/>}       label="صندوق"  onClick={() => addElement("container")} />
            </div>
          </div>
          <div>
            <div className="font-semibold mb-2 text-slate-700">حقول البيانات</div>
            <div className="space-y-1">
              {FIELDS_BY_DOC[documentType].map(f => (
                <button key={f.key} onClick={() => addElement("field", f.key, `{${f.label}}`)}
                  className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-900 text-start">
                  <Tag className="w-3 h-3 shrink-0" /> {f.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="font-semibold mb-2 text-slate-700">إعدادات الصفحة</div>
            {documentType === "sales_quotation" && (
              <p className="mb-2 rounded-lg bg-indigo-50 p-2 text-[11px] leading-relaxed text-indigo-800">
                يتم إنشاء نسخة قابلة للتعديل من القالب المحدد؛ يظل القالب الأصلي محفوظًا دون تغيير.
              </p>
            )}
            <div className="space-y-2">
              <label className="block">
                <span className="text-xs text-slate-600">حجم الورق</span>
                <select value={paperSize} onChange={e => {
                  const v = e.target.value; setPaperSize(v); setDirty(true);
                  if (v === "A4")        { setWidthMm(210); setHeightMm(297); }
                  if (v === "A5")        { setWidthMm(148); setHeightMm(210); }
                  if (v === "80mm")      { setWidthMm(80);  setHeightMm(297); }
                  if (v === "Letter")    { setWidthMm(216); setHeightMm(279); }
                }} className="w-full border rounded px-2 py-1">
                  <option>A4</option><option>A5</option><option>Letter</option><option>80mm</option>
                </select>
              </label>
              <div className="flex gap-1">
                <label className="flex-1"><span className="text-xs text-slate-600">عرض (mm)</span>
                  <input type="number" value={widthMm} onChange={e => { setWidthMm(Number(e.target.value)||210); setDirty(true); }} className="w-full border rounded px-2 py-1"/></label>
                <label className="flex-1"><span className="text-xs text-slate-600">طول (mm)</span>
                  <input type="number" value={heightMm} onChange={e => { setHeightMm(Number(e.target.value)||297); setDirty(true); }} className="w-full border rounded px-2 py-1"/></label>
              </div>
              <label className="block">
                <span className="text-xs text-slate-600">خلفية الصفحة</span>
                <input type="color" value={layout.pageBackground ?? "#ffffff"} onChange={e => patchLayout({ ...layout, pageBackground: e.target.value })}
                  className="w-full h-8 border rounded"/>
              </label>
            </div>
          </div>
        </div>
        )}

        {/* Canvas */}
        <div ref={canvasViewportRef}
        className="relative flex-1 overflow-auto p-4 flex items-start justify-center bg-gradient-to-b from-slate-100 to-slate-200">
          <div className="pointer-events-none absolute start-6 top-5 z-10 flex items-center gap-2 rounded-full border border-emerald-200 bg-white/95 px-3 py-1.5 text-xs font-semibold text-emerald-800 shadow-sm">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {regionDeleteMode
              ? nativeSalesPreviewHtml
                ? "اسحب فوق حقول أو أعمدة القالب الأصلي، ثم راجعها قبل الحذف"
                : "اسحب فوق العناصر أو أعمدة الجدول، ثم راجعها قبل الحذف"
              : layout.baseTemplateVersion === 2
              ? "القالب الأصلي محفوظ — العناصر الجديدة تظهر فوقه"
              : "معاينة مباشرة — تتحدث مع كل تعديل"}
          </div>
          {templatesError && (
            <div role="alert" className="absolute start-1/2 top-14 z-20 -translate-x-1/2 rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs text-rose-800 shadow">
              تعذر تحميل القوالب المحفوظة. أعد تحميل الصفحة للمحاولة مرة أخرى.
            </div>
          )}
          {pendingRegionSelection && (
            <div
              role="status"
              data-testid="region-selection-review"
              className="absolute start-1/2 top-14 z-20 flex max-w-[min(92%,760px)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-xl border border-rose-200 bg-white/95 px-3 py-2 shadow-lg"
            >
              <span className="text-xs font-semibold text-slate-800">سيتم حذف:</span>
              <div className="flex max-w-[420px] flex-wrap gap-1">
                {pendingRegionLabels.map((label, index) => (
                  <span key={`${label}-${index}`} className="rounded-full bg-rose-50 px-2 py-1 text-[11px] text-rose-800">
                    {label}
                  </span>
                ))}
              </div>
              <button
                data-testid="button-confirm-region-delete"
                onClick={deletePendingRegionSelection}
                className="flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
              >
                <Trash2 className="h-3.5 w-3.5" /> حذف المحدد
              </button>
              <button
                data-testid="button-cancel-region-delete"
                onClick={() => setPendingRegionSelection(null)}
                className="rounded-lg px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
              >
                إلغاء
              </button>
            </div>
          )}
          <div
            ref={canvasRef}
            onMouseDown={e => {
              // Marquee selection: only fires when the click lands directly on
              // the empty canvas background (not on an existing element). The
              // canvas is zoom-scaled, so we convert client coords back to
              // page-space (unzoomed pixels) so the rect matches element data.
              if (e.target !== canvasRef.current) return;
              if (e.button !== 0) return;
              const rect = canvasRef.current.getBoundingClientRect();
              const x = (e.clientX - rect.left) / zoom;
              const y = (e.clientY - rect.top)  / zoom;
              const additive = e.shiftKey || e.ctrlKey || e.metaKey || multiSelectMode;
              if (!additive) clearSelection();
              setMarquee({ x1: x, y1: y, x2: x, y2: y, additive });
            }}
            style={{
              width:  widthMm * MM * zoom,
              height: heightMm * MM * zoom,
              background: layout.pageBackground ?? "#ffffff",
              boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
              position: "relative",
              transformOrigin: "top right",
            }}
            className="overflow-visible"
          >
            <div style={{
              position: "absolute", inset: 0, transform: `scale(${zoom})`,
              transformOrigin: "top right", width: widthMm * MM, height: heightMm * MM,
            }}>
              {visibleNativeSalesPreviewHtml && (
                <iframe
                  ref={nativePreviewFrameRef}
                  title="معاينة نموذج المبيعات الأصلي"
                  srcDoc={visibleNativeSalesPreviewHtml}
                  tabIndex={-1}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: widthMm * MM,
                    height: heightMm * MM,
                    border: 0,
                    pointerEvents: "none",
                    zIndex: 0,
                    background: "#fff",
                  }}
                />
              )}
              {marquee && (
                <div
                  style={{
                    position: "absolute",
                    left:   Math.min(marquee.x1, marquee.x2),
                    top:    Math.min(marquee.y1, marquee.y2),
                    width:  Math.abs(marquee.x2 - marquee.x1),
                    height: Math.abs(marquee.y2 - marquee.y1),
                    border: "1.5px dashed #4f46e5",
                    background: "rgba(99,102,241,0.10)",
                    pointerEvents: "none",
                    zIndex: 9999,
                  }}
                />
              )}
              {layout.elements.map(el => (
                <ElementRnd key={el.id} el={el}
                  selected={selectedIds.includes(el.id)}
                  primary={el.id === selectedElId}
                  onSelect={(shift) => {
                    if (shift || multiSelectMode) {
                      toggleInSelection(el.id);
                    } else if (selectedIds.includes(el.id) && selectedIds.length > 1) {
                      // Preserve the existing multi-selection so the drag that
                      // typically follows can move the whole group. Just promote
                      // this element to "primary" so the inspector targets it.
                      setSelectedElId(el.id);
                    } else {
                      selectOnly(el.id);
                    }
                  }}
                  onChange={p => updateElement(el.id, p)}
                  onDelete={() => deleteElement(el.id)}
                  onGroupMove={(dx, dy) => {
                    // Multi-selection wins over container auto-grouping so the
                    // user always gets exactly what they selected. Container's
                    // implicit children are only used when no multi-set exists.
                    if (selectedIds.length > 1 && selectedIds.includes(el.id)) {
                      const extras = el.type === "container" ? containedChildIds(el) : [];
                      moveBy(Array.from(new Set([...selectedIds, ...extras])), dx, dy);
                    } else if (el.type === "container") {
                      moveBy([el.id, ...containedChildIds(el)], dx, dy);
                    } else {
                      updateElement(el.id, { x: el.x + dx, y: el.y + dy });
                    }
                  }}
                />
              ))}
              {regionDeleteMode && (
                <div
                  data-testid="overlay-region-selector"
                  className="absolute inset-0 z-[9000] cursor-crosshair"
                  style={{ touchAction: "none" }}
                  onMouseDown={event => {
                    if (event.button !== 0) return;
                    const canvas = canvasRef.current;
                    if (!canvas) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const rect = canvas.getBoundingClientRect();
                    const x = (event.clientX - rect.left) / zoom;
                    const y = (event.clientY - rect.top) / zoom;
                    setPendingRegionSelection(null);
                    setMarquee({ x1: x, y1: y, x2: x, y2: y, additive: false });
                  }}
                />
              )}
            </div>
          </div>
        </div>

        {/* Right inspector */}
        {showRightPanel && (
        <div className="w-60 shrink-0 bg-white border-r overflow-y-auto p-3 text-sm">
          {!selectedEl ? (
            <div className="text-slate-500 text-center mt-10 text-xs">
              اختر عنصراً لتعديل خصائصه<br/>أو اسحب عنصراً من اللوحة اليمنى
            </div>
          ) : (
            <Inspector el={selectedEl}
              onChange={p => updateElement(selectedEl.id, p)}
              onDelete={() => deleteElement(selectedEl.id)}
              onDuplicate={() => duplicateElement(selectedEl.id)}
              onForward={() => bringForward(selectedEl.id)}
              onBackward={() => sendBackward(selectedEl.id)}
            />
          )}
        </div>
        )}
      </div>

      {/* ───────────── Preset gallery modal ───────────── */}
      {showPresets && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onMouseDown={e => { if (e.target === e.currentTarget) setShowPresets(false); }}
          role="dialog" aria-modal="true" aria-labelledby="preset-gallery-title"
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <div>
                <h2 id="preset-gallery-title" className="text-lg font-bold text-slate-800 flex items-center gap-2">
                  <LayoutTemplate className="w-5 h-5 text-indigo-600" />
                  اختر قالباً جاهزاً —{" "}
                  <span className="text-indigo-600">
                    {DOC_TYPES.find(d => d.value === documentType)?.label}
                  </span>
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  حمّل تصميماً جاهزاً وعدّل عليه، أو اختر "فارغ جديد" لتبدأ من صفحة بيضاء.
                </p>
              </div>
              <button onClick={() => setShowPresets(false)}
                aria-label="إغلاق"
                className="p-1.5 rounded hover:bg-slate-100 text-slate-500">
                <X className="w-5 h-5"/>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {(PRESETS_BY_DOC[documentType]?.length ?? 0) === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  لا توجد قوالب جاهزة لهذا النوع من المستندات بعد.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {(PRESETS_BY_DOC[documentType] ?? []).map(p => (
                    <button key={p.key}
                      onClick={() => applyPreset(p)}
                      className="group text-start border border-slate-200 rounded-lg overflow-hidden hover:border-indigo-400 hover:shadow-md transition bg-white">
                      <div className={`h-28 bg-gradient-to-br ${p.accent} relative flex items-center justify-center`}>
                        <LayoutTemplate className="w-12 h-12 text-white/80"/>
                        <span className="absolute top-2 start-2 text-[10px] bg-white/90 text-slate-700 px-2 py-0.5 rounded-full font-medium">
                          {p.paperSize}
                        </span>
                      </div>
                      <div className="p-3">
                        <div className="font-bold text-sm text-slate-800 mb-1 flex items-center gap-1">
                          {p.name}
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 opacity-0 group-hover:opacity-100 transition"/>
                        </div>
                        <div className="text-xs text-slate-500 leading-relaxed line-clamp-2">
                          {p.description}
                        </div>
                      </div>
                    </button>
                  ))}

                  {/* Blank option */}
                  <button onClick={() => { setShowPresets(false); createNew(); }}
                    className="group text-start border-2 border-dashed border-slate-300 rounded-lg overflow-hidden hover:border-slate-500 hover:bg-slate-50 transition">
                    <div className="h-28 bg-slate-50 flex items-center justify-center">
                      <Plus className="w-12 h-12 text-slate-400 group-hover:text-slate-600"/>
                    </div>
                    <div className="p-3">
                      <div className="font-bold text-sm text-slate-700 mb-1">صفحة فارغة</div>
                      <div className="text-xs text-slate-500">ابدأ التصميم من الصفر بدون أي عناصر مسبقة</div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Subcomponents ─────────────────────────

function PaletteBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="flex flex-col items-center justify-center gap-1 p-2 rounded border bg-slate-50 hover:bg-indigo-50 hover:border-indigo-300 transition">
      {icon}
      <span className="text-xs">{label}</span>
    </button>
  );
}

function ElementRnd({
  el, selected, primary, onSelect, onChange, onDelete, onGroupMove,
}: {
  el: Element;
  selected: boolean;
  primary: boolean;
  onSelect: (shiftKey: boolean) => void;
  onChange: (p: Partial<Element>) => void;
  onDelete: () => void;
  onGroupMove: (dx: number, dy: number) => void;
}) {
  const isContainer = el.type === "container";
  // Containers use only the title-bar as drag handle so children placed
  // visually inside remain clickable. Other element types are draggable
  // anywhere on their body (default Rnd behavior).
  const handleClass = isContainer ? `pd-container-handle-${el.id}` : undefined;
  const outline = primary
    ? "2px solid #6366f1"
    : selected
      ? "2px dashed #6366f1"
      : isContainer
        ? "1px dashed #94a3b8"
        : "1px dashed transparent";
  return (
    <Rnd
      size={{ width: el.width, height: el.height }}
      position={{ x: el.x, y: el.y }}
      bounds="parent"
      dragHandleClassName={handleClass}
      onDragStop={(_e, d) => {
        const dx = d.x - el.x;
        const dy = d.y - el.y;
        if (dx === 0 && dy === 0) return;
        onGroupMove(dx, dy);
      }}
      onResizeStop={(_e, _dir, ref, _delta, pos) => onChange({
        width: parseInt(ref.style.width), height: parseInt(ref.style.height), x: pos.x, y: pos.y,
      })}
      onMouseDown={e => { e.stopPropagation(); onSelect(e.shiftKey); }}
      style={{
        outline,
        zIndex: el.zIndex ?? (isContainer ? 0 : 1),
      }}
      enableResizing={el.type !== "line"}
    >
      {isContainer ? (
        <div style={{ width: "100%", height: "100%", position: "relative", boxSizing: "border-box",
          background: el.background ?? "transparent",
          border: `${el.borderWidth ?? 1}px ${el.borderStyle ?? "dashed"} ${el.borderColor ?? "#94a3b8"}`,
          borderRadius: 4, opacity: el.opacity ?? 1 }}>
          <div className={handleClass}
            style={{ position: "absolute", top: 0, insetInlineStart: 0, insetInlineEnd: 0, height: 20,
              background: primary ? "#6366f1" : "#cbd5e1", color: "#fff",
              fontSize: 11, padding: "2px 8px", cursor: "move",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              borderTopRightRadius: 4, borderTopLeftRadius: 4 }}>
            <span>{el.text || "صندوق"}</span>
            <span style={{ opacity: 0.85 }}>{Math.round(el.width)}×{Math.round(el.height)}</span>
          </div>
        </div>
      ) : (
        <ElementView el={el} />
      )}
      {primary && (
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="absolute -top-3 -start-3 bg-rose-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs shadow">
          ×
        </button>
      )}
    </Rnd>
  );
}

function ElementView({ el }: { el: Element }) {
  const common: React.CSSProperties = {
    width: "100%", height: "100%",
    background: el.background ?? "transparent", color: el.color ?? "#111827",
    fontFamily: el.fontFamily ?? "Tahoma, Arial, sans-serif", fontSize: el.fontSize ?? 14,
    fontWeight: el.fontWeight as any, fontStyle: el.fontStyle ?? "normal",
    textAlign: (el.textAlign ?? "start") as any,
    padding: el.padding ?? 0, opacity: el.opacity ?? 1,
    borderColor: el.borderColor, borderStyle: el.borderStyle ?? "solid",
    borderWidth: el.borderWidth ?? 0, borderRadius: 0,
    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
    overflow: "hidden", boxSizing: "border-box",
    whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: "normal",
  };
  if (el.type === "text" || el.type === "field") {
    return <div style={common}>{el.type === "field" ? sampleFieldText(el) : el.text}</div>;
  }
  if (el.type === "image") {
    return el.src
      ? <img src={el.src} style={{ ...common, objectFit: "contain" }} alt="" />
      : <div style={{ ...common, color: "#9ca3af", textAlign: "center" }}>صورة</div>;
  }
  if (el.type === "rect") return <div style={common} />;
  if (el.type === "container") {
    return (
      <div style={{
        ...common,
        background: el.background ?? "transparent",
        border: `${el.borderWidth ?? 1}px dashed ${el.borderColor ?? "#94a3b8"}`,
      }}>
        {el.text ? <span>{el.text}</span> : null}
      </div>
    );
  }
  if (el.type === "line") return <div style={{ ...common, background: el.background ?? "#000" }} />;
  if (el.type === "table") {
    const spec = el.tableSpec!;
    return (
      <table
        data-designer-element-id={el.id}
        style={{ ...common, borderCollapse: "collapse", tableLayout: "fixed" }}
      >
        <thead>
          <tr>{spec.columns.map(c => (
            <th key={c.key} style={{
              background: spec.headerBg, color: spec.headerColor,
              border: `${spec.borderWidth ?? 1}px solid ${spec.borderColor ?? "#e5e7eb"}`,
              padding: 5, textAlign: c.align ?? "start", width: c.width,
            }} data-designer-element-id={el.id}
              data-designer-column-key={c.key}>{c.label}</th>
          ))}</tr>
        </thead>
        <tbody>
          {[0,1,2].map(r => (
            <tr key={r} style={{ background: r % 2 === 0 ? spec.rowBg : spec.altRowBg }}>
              {spec.columns.map(c => (
                <td key={c.key} style={{
                  border: `${spec.borderWidth ?? 1}px solid ${spec.borderColor ?? "#e5e7eb"}`,
                  padding: 5, textAlign: c.align ?? "start",
                }} data-designer-element-id={el.id}
                  data-designer-column-key={c.key}>{sampleTableCell(c.key, r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return <div style={common}/>;
}

function Inspector({
  el, onChange, onDelete, onDuplicate, onForward, onBackward,
}: {
  el: Element;
  onChange: (p: Partial<Element>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onForward: () => void;
  onBackward: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-slate-800 text-sm">
          {el.type === "text" ? "نص" : el.type === "field" ? "حقل بيانات"
            : el.type === "image" ? "صورة" : el.type === "rect" ? "مستطيل"
            : el.type === "line" ? "خط" : el.type === "container" ? "صندوق"
            : "جدول"}
        </div>
        <div className="flex gap-1">
          <button onClick={onDuplicate} title="نسخ" className="p-1 rounded hover:bg-slate-100"><Copy className="w-4 h-4"/></button>
          <button onClick={onForward} title="للأمام" className="p-1 rounded hover:bg-slate-100">⬆</button>
          <button onClick={onBackward} title="للخلف" className="p-1 rounded hover:bg-slate-100">⬇</button>
          <button onClick={onDelete} title="حذف" className="p-1 rounded hover:bg-rose-100 text-rose-600"><Trash2 className="w-4 h-4"/></button>
        </div>
      </div>

      {/* Position & size */}
      <div className="grid grid-cols-2 gap-2">
        <Field label="X"     value={el.x}      onChange={v => onChange({ x: v })} />
        <Field label="Y"     value={el.y}      onChange={v => onChange({ y: v })} />
        <Field label="عرض"   value={el.width}  onChange={v => onChange({ width: v })} />
        <Field label="طول"   value={el.height} onChange={v => onChange({ height: v })} />
        <Field label="دوران"  value={el.rotation ?? 0} onChange={v => onChange({ rotation: v })} />
        <Field label="شفافية" value={el.opacity ?? 1}  step={0.05} max={1} onChange={v => onChange({ opacity: v })} />
      </div>

      {/* Text-like properties */}
      {(el.type === "text" || el.type === "field") && (
        <>
          <label className="block">
            <span className="text-xs text-slate-600">النص</span>
            <textarea value={el.text ?? ""} onChange={e => onChange({ text: e.target.value })}
              rows={2} className="w-full border rounded px-2 py-1 text-sm"/>
          </label>
        </>
      )}

      {el.type === "container" && (
        <label className="block">
          <span className="text-xs text-slate-600">عنوان الصندوق</span>
          <input type="text" value={el.text ?? ""}
            onChange={e => onChange({ text: e.target.value })}
            className="w-full border rounded px-2 py-1 text-sm"/>
          <p className="text-[11px] text-slate-500 mt-1">
            ضع العناصر بصرياً داخل الصندوق؛ عند سحب شريط العنوان تتحرك تلقائياً معه.
          </p>
        </label>
      )}

      {(el.type === "text" || el.type === "field" || el.type === "table") && (
        <>
          <label className="block">
            <span className="text-xs text-slate-600">الخط</span>
            <select value={el.fontFamily ?? "Tahoma"} onChange={e => onChange({ fontFamily: e.target.value })}
              className="w-full border rounded px-2 py-1 text-sm">
              <option value="Tahoma, Arial, sans-serif">Tahoma</option>
              <option value="'Cairo', sans-serif">Cairo</option>
              <option value="'Amiri', serif">Amiri</option>
              <option value="Arial, sans-serif">Arial</option>
              <option value="'Times New Roman', serif">Times New Roman</option>
              <option value="'Courier New', monospace">Courier New</option>
            </select>
          </label>
          <div className="grid grid-cols-3 gap-2">
            <Field label="حجم" value={el.fontSize ?? 14} onChange={v => onChange({ fontSize: v })} />
            <label className="block col-span-2">
              <span className="text-xs text-slate-600">سُمك</span>
              <select value={el.fontWeight ?? "400"} onChange={e => onChange({ fontWeight: e.target.value })}
                className="w-full border rounded px-2 py-1 text-sm">
                <option value="300">رفيع</option>
                <option value="400">عادي</option>
                <option value="600">شبه عريض</option>
                <option value="700">عريض</option>
                <option value="900">أسود</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-slate-600">المحاذاة</span>
            <div className="flex gap-1 mt-1">
              {(["start","center","end","justify"] as const).map(a => (
                <button key={a} onClick={() => onChange({ textAlign: a })}
                  className={`flex-1 px-2 py-1 border rounded text-xs ${el.textAlign === a ? "bg-indigo-100 border-indigo-400" : ""}`}>
                  {a === "start" ? "يمين" : a === "end" ? "يسار" : a === "center" ? "وسط" : "ضبط"}
                </button>
              ))}
            </div>
          </label>
        </>
      )}

      {/* Colors */}
      <div className="grid grid-cols-2 gap-2">
        <ColorField label="لون النص"     value={el.color}      onChange={v => onChange({ color: v })} />
        <ColorField label="خلفية"        value={el.background} onChange={v => onChange({ background: v })} />
        <ColorField label="لون الحد"     value={el.borderColor} onChange={v => onChange({ borderColor: v })} />
        <Field      label="سُمك الحد"    value={el.borderWidth ?? 0} onChange={v => onChange({ borderWidth: v })} />
      </div>

      {/* Image */}
      {el.type === "image" && (
        <label className="block">
          <span className="text-xs text-slate-600">رابط الصورة</span>
          <input value={el.src ?? ""} onChange={e => onChange({ src: e.target.value })}
            placeholder="https://..." className="w-full border rounded px-2 py-1 text-sm"/>
        </label>
      )}

      {/* Table editor */}
      {el.type === "table" && el.tableSpec && (
        <div className="space-y-2 border-t pt-3">
          <div className="font-semibold text-xs text-slate-700">أعمدة الجدول</div>
          {el.tableSpec.columns.map((c, idx) => (
            <div key={idx} className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-1.5">
              <div className="flex gap-1">
                <select
                  aria-label={`مصدر بيانات العمود ${idx + 1}`}
                  data-testid={`select-table-column-source-${idx}`}
                  value={c.key}
                  onChange={e => {
                    const cols = [...el.tableSpec!.columns];
                    cols[idx] = { ...c, key: e.target.value };
                    onChange({ tableSpec: { ...el.tableSpec!, columns: cols } });
                  }}
                  className="min-w-0 flex-1 rounded border bg-white px-1 py-0.5 text-[11px]"
                >
                  {[
                    ["no", "الترقيم"],
                    ["name", "اسم الصنف"],
                    ["code", "كود الصنف"],
                    ["description", "الوصف"],
                    ["qty", "الكمية"],
                    ["unit", "الوحدة"],
                    ["price", "سعر الوحدة"],
                    ["discount", "الخصم"],
                    ["vat", "الضريبة"],
                    ["total", "الإجمالي"],
                    ["date", "التاريخ"],
                    ["ref", "المرجع"],
                    ["account", "الحساب"],
                    ["debit", "مدين"],
                    ["credit", "دائن"],
                    ["balance", "الرصيد"],
                  ].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
                <button onClick={() => {
                    const cols = el.tableSpec!.columns.filter((_, i) => i !== idx);
                    onChange({ tableSpec: { ...el.tableSpec!, columns: cols } });
                  }}
                  aria-label="حذف العمود"
                  data-testid={`button-remove-table-column-${idx}`}
                  className="rounded px-1 text-rose-600 hover:bg-rose-100 text-xs">×</button>
              </div>
              <div className="flex gap-1">
                <input
                  aria-label={`عنوان العمود ${idx + 1}`}
                  value={c.label}
                  onChange={e => {
                    const cols = [...el.tableSpec!.columns];
                    cols[idx] = { ...c, label: e.target.value };
                    onChange({ tableSpec: { ...el.tableSpec!, columns: cols } });
                  }}
                  className="min-w-0 flex-1 rounded border bg-white px-1 py-0.5 text-xs"
                />
                <input
                  aria-label={`عرض العمود ${idx + 1}`}
                  type="number"
                  value={c.width ?? 80}
                  onChange={e => {
                    const cols = [...el.tableSpec!.columns];
                    cols[idx] = { ...c, width: Number(e.target.value) || 80 };
                    onChange({ tableSpec: { ...el.tableSpec!, columns: cols } });
                  }}
                  className="w-16 rounded border bg-white px-1 py-0.5 text-xs"
                />
              </div>
            </div>
          ))}
          <button onClick={() => {
              const cols = [...el.tableSpec!.columns, { key: "name", label: "عمود جديد", width: 80, align: "start" as const }];
              onChange({ tableSpec: { ...el.tableSpec!, columns: cols } });
            }}
            data-testid="button-add-table-column"
            className="text-xs px-2 py-1 bg-indigo-50 text-indigo-800 rounded hover:bg-indigo-100">+ إضافة عمود</button>
          <div className="grid grid-cols-2 gap-1 pt-2">
            <ColorField label="خلفية الرأس"  value={el.tableSpec.headerBg}    onChange={v => onChange({ tableSpec: { ...el.tableSpec!, headerBg: v }})} />
            <ColorField label="لون الرأس"    value={el.tableSpec.headerColor} onChange={v => onChange({ tableSpec: { ...el.tableSpec!, headerColor: v }})} />
            <ColorField label="خلفية الصف"   value={el.tableSpec.rowBg}       onChange={v => onChange({ tableSpec: { ...el.tableSpec!, rowBg: v }})} />
            <ColorField label="خلفية متبادلة" value={el.tableSpec.altRowBg}    onChange={v => onChange({ tableSpec: { ...el.tableSpec!, altRowBg: v }})} />
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, step = 1, max }: { label: string; value: number; onChange: (v: number) => void; step?: number; max?: number }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-600">{label}</span>
      <input type="number" value={Math.round(value * 100) / 100}
        step={step} max={max}
        onChange={e => onChange(Number(e.target.value) || 0)}
        className="w-full border rounded px-2 py-1 text-sm"/>
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-600">{label}</span>
      <div className="flex gap-1">
        <input type="color" value={value ?? "#000000"} onChange={e => onChange(e.target.value)}
          className="w-8 h-8 border rounded"/>
        <input type="text" value={value ?? ""} onChange={e => onChange(e.target.value)}
          className="flex-1 border rounded px-2 text-xs"/>
      </div>
    </label>
  );
}

// ───────────────────────── HTML renderer for print preview ─────────────────────────

function renderElementsHtml(elements: Element[]): string {
  return elements.map(el => {
    const base = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.width}px;height:${el.height}px;`
      + `font-family:${el.fontFamily ?? "Tahoma"};font-size:${el.fontSize ?? 14}px;`
      + `color:${el.color ?? "#000"};background:${el.background ?? "transparent"};`
      + `text-align:${el.textAlign ?? "start"};padding:${el.padding ?? 0}px;`
      + `opacity:${el.opacity ?? 1};`
      + (el.borderWidth ? `border:${el.borderWidth}px ${el.borderStyle ?? "solid"} ${el.borderColor ?? "#000"};` : "")
      + `z-index:${el.zIndex ?? 1};box-sizing:border-box;overflow:hidden;`
      + (el.rotation ? `transform:rotate(${el.rotation}deg);` : "");
    if (el.type === "text" || el.type === "field") {
      const content = el.type === "field" ? sampleFieldText(el) : (el.text ?? "");
      return `<div style="${base}">${escapeHtml(content)}</div>`;
    }
    if (el.type === "image") return el.src
      ? `<img src="${el.src}" style="${base};object-fit:contain"/>`
      : `<div style="${base}"></div>`;
    if (el.type === "rect") return `<div style="${base}"></div>`;
    if (el.type === "line") return `<div style="${base};background:${el.background ?? "#000"}"></div>`;
    if (el.type === "table" && el.tableSpec) {
      const s = el.tableSpec;
      const headers = s.columns.map(c =>
        `<th style="background:${s.headerBg ?? "#1f2937"};color:${s.headerColor ?? "#fff"};border:${s.borderWidth ?? 1}px solid ${s.borderColor ?? "#e5e7eb"};padding:4px;text-align:${c.align ?? "start"};width:${c.width ?? "auto"}px">${escapeHtml(c.label)}</th>`,
      ).join("");
      const rows = [0,1,2].map(r =>
        `<tr style="background:${r%2===0 ? s.rowBg ?? "#fff" : s.altRowBg ?? "#f9fafb"}">${
          s.columns.map(c => `<td style="border:${s.borderWidth ?? 1}px solid ${s.borderColor ?? "#e5e7eb"};padding:4px;text-align:${c.align ?? "start"}">${escapeHtml(sampleTableCell(c.key, r))}</td>`).join("")
        }</tr>`,
      ).join("");
      return `<table style="${base};border-collapse:collapse"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    return "";
  }).join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]!));
}
