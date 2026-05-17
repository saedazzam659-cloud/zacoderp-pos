// Ready-made starter layouts for the print designer.
// Each preset returns a complete Layout the user can load and then edit.
// All coordinates/sizes are in screen pixels at 96dpi (1mm ≈ 3.7795px),
// matching the rest of the designer.

import type { Layout, Element, TableColumn } from "./types";

const MM = 3.7795;
let counter = 0;
const uid = (p: string) => `pre_${p}_${++counter}`;

function txt(o: Partial<Element> & { text: string }): Element {
  return {
    id: uid("t"), type: "text", x: 0, y: 0, width: 200, height: 28, rotation: 0, zIndex: 1,
    fontFamily: "Tahoma, Arial, sans-serif", fontSize: 14, fontWeight: "400",
    textAlign: "start", color: "#111827", padding: 4, opacity: 1, ...o,
  };
}
function field(o: Partial<Element> & { fieldKey: string; text: string }): Element {
  return {
    id: uid("f"), type: "field", x: 0, y: 0, width: 200, height: 26, rotation: 0, zIndex: 1,
    fontFamily: "Tahoma, Arial, sans-serif", fontSize: 13, fontWeight: "500",
    textAlign: "start", color: "#111827", padding: 4, opacity: 1, ...o,
  };
}
function rect(o: Partial<Element>): Element {
  return {
    id: uid("r"), type: "rect", x: 0, y: 0, width: 200, height: 80, rotation: 0, zIndex: 0,
    background: "#f3f4f6", borderColor: "#d1d5db", borderWidth: 1, borderStyle: "solid",
    padding: 0, opacity: 1, ...o,
  };
}
function line(o: Partial<Element>): Element {
  return {
    id: uid("ln"), type: "line", x: 0, y: 0, width: 600, height: 2, rotation: 0, zIndex: 1,
    background: "#111827", padding: 0, opacity: 1, ...o,
  };
}
function table(cols: TableColumn[], o: Partial<Element>, theme: {
  headerBg: string; headerColor: string; rowBg?: string; altRowBg?: string;
  borderColor?: string;
}): Element {
  return {
    id: uid("tb"), type: "table", x: 0, y: 0, width: 720, height: 240, rotation: 0, zIndex: 2,
    background: "#ffffff", padding: 0, opacity: 1,
    fontFamily: "Tahoma, Arial, sans-serif", fontSize: 12, color: "#111827",
    tableSpec: {
      columns: cols,
      headerBg: theme.headerBg, headerColor: theme.headerColor,
      rowBg: theme.rowBg ?? "#ffffff",
      altRowBg: theme.altRowBg ?? "#f9fafb",
      borderColor: theme.borderColor ?? "#e5e7eb",
      borderWidth: 1,
    },
    ...o,
  };
}
function image(o: Partial<Element>): Element {
  return {
    id: uid("im"), type: "image", x: 0, y: 0, width: 110, height: 110, rotation: 0, zIndex: 3,
    background: "#f9fafb", borderColor: "#e5e7eb", borderWidth: 1, borderStyle: "dashed",
    padding: 0, opacity: 1, src: "", ...o,
  };
}

const SALES_COLS: TableColumn[] = [
  { key: "no",       label: "م",        width: 36,  align: "center" },
  { key: "name",     label: "الصنف",     width: 230, align: "start"  },
  { key: "qty",      label: "الكمية",   width: 60,  align: "center" },
  { key: "price",    label: "السعر",    width: 80,  align: "end"    },
  { key: "discount", label: "الخصم",    width: 70,  align: "end"    },
  { key: "vat",      label: "ضريبة 15%", width: 75,  align: "end"    },
  { key: "total",    label: "الإجمالي", width: 90,  align: "end"    },
];

// ─────────────────── Classic A4 sales invoice ───────────────────
function classicSalesInvoice(): Layout {
  const W = 210 * MM; // 794px
  return {
    pageBackground: "#ffffff",
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    elements: [
      // Header band
      rect({ x: 20, y: 20, width: W - 40, height: 110, background: "#f8fafc", borderColor: "#e2e8f0" }),
      image({ x: W - 140, y: 30, width: 90, height: 90 }),
      field({ fieldKey: "company.name", text: "{اسم الشركة}",
        x: 40, y: 36, width: W - 200, height: 32, fontSize: 22, fontWeight: "700", color: "#0f172a" }),
      field({ fieldKey: "company.vat", text: "الرقم الضريبي: {الرقم الضريبي}",
        x: 40, y: 70, width: W - 200, height: 22, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "company.address", text: "{عنوان الشركة}",
        x: 40, y: 90, width: W - 200, height: 22, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "company.phone", text: "هاتف: {هاتف الشركة}",
        x: 40, y: 108, width: W - 200, height: 20, fontSize: 11, color: "#64748b" }),

      // Title
      txt({ text: "فاتورة ضريبية", x: (W - 220) / 2, y: 140, width: 220, height: 36,
        fontSize: 22, fontWeight: "700", textAlign: "center", color: "#1e3a8a",
        background: "#dbeafe", borderColor: "#93c5fd", borderWidth: 1, borderStyle: "solid" }),

      // Invoice info (right) + customer info (left)
      rect({ x: 20, y: 190, width: (W - 60) / 2, height: 100, background: "#ffffff", borderColor: "#cbd5e1" }),
      txt({ text: "بيانات العميل", x: 30, y: 196, width: 150, height: 22, fontSize: 13, fontWeight: "700", color: "#1e293b" }),
      field({ fieldKey: "customer.name",    text: "{اسم العميل}",     x: 30, y: 220, width: (W - 80) / 2, height: 22, fontSize: 12 }),
      field({ fieldKey: "customer.vat",     text: "ضريبي: {ضريبي العميل}", x: 30, y: 242, width: (W - 80) / 2, height: 22, fontSize: 12 }),
      field({ fieldKey: "customer.address", text: "{عنوان العميل}",    x: 30, y: 264, width: (W - 80) / 2, height: 22, fontSize: 12, color: "#475569" }),

      rect({ x: 40 + (W - 60) / 2, y: 190, width: (W - 60) / 2, height: 100, background: "#ffffff", borderColor: "#cbd5e1" }),
      txt({ text: "بيانات الفاتورة", x: 50 + (W - 60) / 2, y: 196, width: 150, height: 22, fontSize: 13, fontWeight: "700", color: "#1e293b" }),
      field({ fieldKey: "invoice.number", text: "رقم: {رقم الفاتورة}",  x: 50 + (W - 60) / 2, y: 220, width: (W - 80) / 2, height: 22, fontSize: 12 }),
      field({ fieldKey: "invoice.date",   text: "تاريخ: {تاريخ الفاتورة}", x: 50 + (W - 60) / 2, y: 242, width: (W - 80) / 2, height: 22, fontSize: 12 }),

      // Items table
      table(SALES_COLS, { x: 20, y: 310, width: W - 40, height: 280 },
        { headerBg: "#1e3a8a", headerColor: "#ffffff", altRowBg: "#f1f5f9" }),

      // Totals box (right)
      rect({ x: W - 280, y: 610, width: 260, height: 150, background: "#f8fafc", borderColor: "#cbd5e1" }),
      txt({ text: "المجموع الفرعي", x: W - 270, y: 618, width: 110, height: 22, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "totals.subtotal", text: "{المجموع الفرعي}", x: W - 150, y: 618, width: 120, height: 22, fontSize: 12, textAlign: "end", fontWeight: "600" }),
      txt({ text: "الخصم", x: W - 270, y: 644, width: 110, height: 22, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "totals.discount", text: "{الخصم}", x: W - 150, y: 644, width: 120, height: 22, fontSize: 12, textAlign: "end", fontWeight: "600" }),
      txt({ text: "الضريبة 15%", x: W - 270, y: 670, width: 110, height: 22, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "totals.vat", text: "{الضريبة}", x: W - 150, y: 670, width: 120, height: 22, fontSize: 12, textAlign: "end", fontWeight: "600" }),
      line({ x: W - 270, y: 698, width: 240, height: 2, background: "#1e3a8a" }),
      txt({ text: "الإجمالي", x: W - 270, y: 706, width: 110, height: 30, fontSize: 16, fontWeight: "700", color: "#1e3a8a" }),
      field({ fieldKey: "totals.grand", text: "{الإجمالي}", x: W - 150, y: 706, width: 120, height: 30, fontSize: 16, textAlign: "end", fontWeight: "700", color: "#1e3a8a" }),

      // QR (left)
      field({ fieldKey: "qr.zatca", text: "{QR زاتكا}",
        x: 30, y: 610, width: 130, height: 130, fontSize: 10, textAlign: "center", color: "#64748b",
        background: "#ffffff", borderColor: "#cbd5e1", borderWidth: 1, borderStyle: "solid" }),
      txt({ text: "QR زاتكا", x: 30, y: 745, width: 130, height: 18, fontSize: 11, textAlign: "center", color: "#64748b" }),

      // Amount in words
      field({ fieldKey: "totals.grandWords", text: "المبلغ كتابة: {الإجمالي كتابة}",
        x: 170, y: 620, width: W - 470, height: 40, fontSize: 12, color: "#1e293b",
        background: "#fffbeb", borderColor: "#fcd34d", borderWidth: 1, borderStyle: "solid" }),
      field({ fieldKey: "notes", text: "ملاحظات: {ملاحظات}",
        x: 170, y: 668, width: W - 470, height: 70, fontSize: 11, color: "#64748b" }),

      // Footer
      line({ x: 20, y: 780, width: W - 40, height: 1, background: "#e2e8f0" }),
      txt({ text: "شكراً لتعاملكم معنا — تم إصدار هذه الفاتورة إلكترونياً وفق متطلبات هيئة الزكاة والضريبة والجمارك",
        x: 20, y: 790, width: W - 40, height: 24, fontSize: 11, textAlign: "center", color: "#94a3b8" }),
    ],
  };
}

// Parameterized invoice-style layout — used for sales/purchase/returns
// so each doc type carries its own field keys + title instead of all
// reusing the customer.* / invoice.* keys.
interface InvoiceVariant {
  title: string;
  partyHeading: string;          // e.g. "بيانات العميل" / "بيانات المورد"
  partyNameKey: string;          // e.g. "customer.name" / "supplier.name"
  partyNameLabel: string;
  partyVatKey: string;
  partyVatLabel: string;
  partyAddressKey?: string;
  partyAddressLabel?: string;
  docNumberKey: string;          // e.g. "invoice.number" / "return.number"
  docNumberLabel: string;
  docDateKey: string;
  docDateLabel: string;
  tableCols?: TableColumn[];
}

const V_SALES_INVOICE: InvoiceVariant = {
  title: "فاتورة ضريبية",
  partyHeading: "بيانات العميل",
  partyNameKey: "customer.name",    partyNameLabel: "اسم العميل",
  partyVatKey:  "customer.vat",     partyVatLabel:  "ضريبي العميل",
  partyAddressKey: "customer.address", partyAddressLabel: "عنوان العميل",
  docNumberKey: "invoice.number", docNumberLabel: "رقم الفاتورة",
  docDateKey:   "invoice.date",   docDateLabel:   "تاريخ الفاتورة",
};
const V_PURCHASE_INVOICE: InvoiceVariant = {
  title: "فاتورة مشتريات",
  partyHeading: "بيانات المورد",
  partyNameKey: "supplier.name", partyNameLabel: "اسم المورد",
  partyVatKey:  "supplier.vat",  partyVatLabel:  "ضريبي المورد",
  docNumberKey: "invoice.number", docNumberLabel: "رقم الفاتورة",
  docDateKey:   "invoice.date",   docDateLabel:   "تاريخ الفاتورة",
  tableCols: [
    { key: "no",    label: "م",        width: 36,  align: "center" },
    { key: "name",  label: "الصنف",     width: 280, align: "start"  },
    { key: "qty",   label: "الكمية",   width: 70,  align: "center" },
    { key: "price", label: "السعر",    width: 90,  align: "end"    },
    { key: "total", label: "الإجمالي", width: 110, align: "end"    },
  ],
};
const V_SALES_RETURN: InvoiceVariant = {
  title: "مرتجع مبيعات",
  partyHeading: "بيانات العميل",
  partyNameKey: "customer.name", partyNameLabel: "اسم العميل",
  partyVatKey:  "customer.vat",  partyVatLabel:  "ضريبي العميل",
  docNumberKey: "return.number", docNumberLabel: "رقم المرتجع",
  docDateKey:   "return.date",   docDateLabel:   "تاريخ المرتجع",
  tableCols: [
    { key: "no",    label: "م",         width: 36,  align: "center" },
    { key: "name",  label: "الصنف",      width: 320, align: "start"  },
    { key: "qty",   label: "الكمية",    width: 80,  align: "center" },
    { key: "total", label: "إجمالي المرتجع", width: 130, align: "end" },
  ],
};
const V_PURCHASE_RETURN: InvoiceVariant = {
  title: "مرتجع مشتريات",
  partyHeading: "بيانات المورد",
  partyNameKey: "supplier.name", partyNameLabel: "اسم المورد",
  partyVatKey:  "supplier.vat",  partyVatLabel:  "ضريبي المورد",
  docNumberKey: "return.number", docNumberLabel: "رقم المرتجع",
  docDateKey:   "return.date",   docDateLabel:   "تاريخ المرتجع",
  tableCols: V_SALES_RETURN.tableCols,
};

function classicInvoiceLike(v: InvoiceVariant, accent = "#1e3a8a"): Layout {
  const W = 210 * MM;
  const cols = v.tableCols ?? SALES_COLS;
  return {
    pageBackground: "#ffffff",
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    elements: [
      rect({ x: 20, y: 20, width: W - 40, height: 110, background: "#f8fafc", borderColor: "#e2e8f0" }),
      image({ x: W - 140, y: 30, width: 90, height: 90 }),
      field({ fieldKey: "company.name", text: "{اسم الشركة}",
        x: 40, y: 36, width: W - 200, height: 32, fontSize: 22, fontWeight: "700", color: "#0f172a" }),
      field({ fieldKey: "company.vat", text: "الرقم الضريبي: {الرقم الضريبي}",
        x: 40, y: 70, width: W - 200, height: 22, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "company.address", text: "{عنوان الشركة}",
        x: 40, y: 90, width: W - 200, height: 22, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "company.phone", text: "هاتف: {هاتف الشركة}",
        x: 40, y: 108, width: W - 200, height: 20, fontSize: 11, color: "#64748b" }),

      txt({ text: v.title, x: (W - 220) / 2, y: 140, width: 220, height: 36,
        fontSize: 22, fontWeight: "700", textAlign: "center", color: accent,
        background: "#dbeafe", borderColor: "#93c5fd", borderWidth: 1, borderStyle: "solid" }),

      rect({ x: 20, y: 190, width: (W - 60) / 2, height: 100, background: "#ffffff", borderColor: "#cbd5e1" }),
      txt({ text: v.partyHeading, x: 30, y: 196, width: 150, height: 22, fontSize: 13, fontWeight: "700", color: "#1e293b" }),
      field({ fieldKey: v.partyNameKey, text: `{${v.partyNameLabel}}`, x: 30, y: 220, width: (W - 80) / 2, height: 22, fontSize: 12 }),
      field({ fieldKey: v.partyVatKey,  text: `ضريبي: {${v.partyVatLabel}}`, x: 30, y: 242, width: (W - 80) / 2, height: 22, fontSize: 12 }),
      ...(v.partyAddressKey ? [field({ fieldKey: v.partyAddressKey, text: `{${v.partyAddressLabel}}`, x: 30, y: 264, width: (W - 80) / 2, height: 22, fontSize: 12, color: "#475569" })] : []),

      rect({ x: 40 + (W - 60) / 2, y: 190, width: (W - 60) / 2, height: 100, background: "#ffffff", borderColor: "#cbd5e1" }),
      txt({ text: "بيانات المستند", x: 50 + (W - 60) / 2, y: 196, width: 150, height: 22, fontSize: 13, fontWeight: "700", color: "#1e293b" }),
      field({ fieldKey: v.docNumberKey, text: `رقم: {${v.docNumberLabel}}`,  x: 50 + (W - 60) / 2, y: 220, width: (W - 80) / 2, height: 22, fontSize: 12 }),
      field({ fieldKey: v.docDateKey,   text: `تاريخ: {${v.docDateLabel}}`,   x: 50 + (W - 60) / 2, y: 242, width: (W - 80) / 2, height: 22, fontSize: 12 }),

      table(cols, { x: 20, y: 310, width: W - 40, height: 280 },
        { headerBg: accent, headerColor: "#ffffff", altRowBg: "#f1f5f9" }),

      rect({ x: W - 280, y: 610, width: 260, height: 150, background: "#f8fafc", borderColor: "#cbd5e1" }),
      txt({ text: "المجموع الفرعي", x: W - 270, y: 618, width: 110, height: 22, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "totals.subtotal", text: "{المجموع الفرعي}", x: W - 150, y: 618, width: 120, height: 22, fontSize: 12, textAlign: "end", fontWeight: "600" }),
      txt({ text: "الضريبة 15%", x: W - 270, y: 644, width: 110, height: 22, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "totals.vat", text: "{الضريبة}", x: W - 150, y: 644, width: 120, height: 22, fontSize: 12, textAlign: "end", fontWeight: "600" }),
      line({ x: W - 270, y: 672, width: 240, height: 2, background: accent }),
      txt({ text: "الإجمالي", x: W - 270, y: 680, width: 110, height: 30, fontSize: 16, fontWeight: "700", color: accent }),
      field({ fieldKey: "totals.grand", text: "{الإجمالي}", x: W - 150, y: 680, width: 120, height: 30, fontSize: 16, textAlign: "end", fontWeight: "700", color: accent }),

      field({ fieldKey: "qr.zatca", text: "{QR زاتكا}",
        x: 30, y: 610, width: 130, height: 130, fontSize: 10, textAlign: "center", color: "#64748b",
        background: "#ffffff", borderColor: "#cbd5e1", borderWidth: 1, borderStyle: "solid" }),

      line({ x: 20, y: 780, width: W - 40, height: 1, background: "#e2e8f0" }),
      txt({ text: "تم إصدار هذا المستند إلكترونياً",
        x: 20, y: 790, width: W - 40, height: 24, fontSize: 11, textAlign: "center", color: "#94a3b8" }),
    ],
  };
}

// ─────────────────── Modern A4 sales invoice ───────────────────
function modernSalesInvoice(): Layout {
  const W = 210 * MM;
  return {
    pageBackground: "#ffffff",
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    elements: [
      rect({ x: 0, y: 0, width: W, height: 8, background: "#10b981", borderWidth: 0 }),
      image({ x: 30, y: 30, width: 80, height: 80, borderWidth: 0 }),
      field({ fieldKey: "company.name", text: "{اسم الشركة}",
        x: 130, y: 35, width: W - 160, height: 30, fontSize: 24, fontWeight: "700", color: "#064e3b" }),
      field({ fieldKey: "company.vat", text: "VAT: {الرقم الضريبي}",
        x: 130, y: 70, width: W - 160, height: 22, fontSize: 12, color: "#047857" }),
      field({ fieldKey: "company.phone", text: "{هاتف الشركة}",
        x: 130, y: 92, width: W - 160, height: 22, fontSize: 12, color: "#047857" }),

      txt({ text: "INVOICE / فاتورة", x: 30, y: 140, width: W - 60, height: 36,
        fontSize: 22, fontWeight: "700", color: "#10b981", textAlign: "start" }),
      line({ x: 30, y: 178, width: W - 60, height: 3, background: "#10b981" }),

      // info row
      txt({ text: "العميل", x: 30, y: 196, width: 120, height: 20, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "customer.name", text: "{اسم العميل}", x: 30, y: 214, width: 240, height: 24, fontSize: 14, fontWeight: "600" }),
      field({ fieldKey: "customer.vat",  text: "{ضريبي العميل}", x: 30, y: 238, width: 240, height: 20, fontSize: 11, color: "#6b7280" }),

      txt({ text: "رقم الفاتورة", x: W - 250, y: 196, width: 100, height: 20, fontSize: 11, color: "#6b7280", textAlign: "end" }),
      field({ fieldKey: "invoice.number", text: "{رقم الفاتورة}", x: W - 250, y: 214, width: 100, height: 24, fontSize: 14, fontWeight: "600", textAlign: "end" }),
      txt({ text: "التاريخ", x: W - 140, y: 196, width: 110, height: 20, fontSize: 11, color: "#6b7280", textAlign: "end" }),
      field({ fieldKey: "invoice.date", text: "{تاريخ الفاتورة}", x: W - 140, y: 214, width: 110, height: 24, fontSize: 14, fontWeight: "600", textAlign: "end" }),

      table(SALES_COLS, { x: 30, y: 290, width: W - 60, height: 300 },
        { headerBg: "#10b981", headerColor: "#ffffff", altRowBg: "#ecfdf5", borderColor: "#d1fae5" }),

      // totals
      rect({ x: W - 290, y: 610, width: 260, height: 130, background: "#ecfdf5", borderColor: "#10b981", borderWidth: 2 }),
      txt({ text: "المجموع الفرعي", x: W - 280, y: 618, width: 120, height: 22, fontSize: 12 }),
      field({ fieldKey: "totals.subtotal", text: "{المجموع الفرعي}", x: W - 160, y: 618, width: 120, height: 22, fontSize: 12, textAlign: "end", fontWeight: "600" }),
      txt({ text: "الضريبة", x: W - 280, y: 644, width: 120, height: 22, fontSize: 12 }),
      field({ fieldKey: "totals.vat", text: "{الضريبة}", x: W - 160, y: 644, width: 120, height: 22, fontSize: 12, textAlign: "end", fontWeight: "600" }),
      line({ x: W - 280, y: 678, width: 240, height: 2, background: "#10b981" }),
      txt({ text: "الإجمالي", x: W - 280, y: 690, width: 120, height: 30, fontSize: 18, fontWeight: "700", color: "#064e3b" }),
      field({ fieldKey: "totals.grand", text: "{الإجمالي}", x: W - 160, y: 690, width: 120, height: 30, fontSize: 18, textAlign: "end", fontWeight: "700", color: "#064e3b" }),

      field({ fieldKey: "qr.zatca", text: "{QR زاتكا}",
        x: 30, y: 610, width: 130, height: 130, fontSize: 10, textAlign: "center",
        background: "#ffffff", borderColor: "#10b981", borderWidth: 2 }),

      txt({ text: "© شكراً لتعاملكم معنا — Generated by Zacoderp",
        x: 0, y: 1080, width: W, height: 24, fontSize: 10, textAlign: "center", color: "#9ca3af" }),
    ],
  };
}

// ─────────────────── Minimal/elegant sales invoice ───────────────────
function minimalSalesInvoice(): Layout {
  const W = 210 * MM;
  return {
    pageBackground: "#ffffff",
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    elements: [
      field({ fieldKey: "company.name", text: "{اسم الشركة}",
        x: 30, y: 40, width: W - 60, height: 36, fontSize: 26, fontWeight: "300", color: "#111827", textAlign: "center" }),
      field({ fieldKey: "company.vat", text: "{الرقم الضريبي}",
        x: 30, y: 76, width: W - 60, height: 20, fontSize: 11, color: "#6b7280", textAlign: "center" }),
      line({ x: 30, y: 110, width: W - 60, height: 1, background: "#111827" }),

      txt({ text: "فاتورة", x: 30, y: 130, width: W - 60, height: 28, fontSize: 18, fontWeight: "300", textAlign: "center", color: "#111827" }),

      txt({ text: "العميل:", x: 30, y: 180, width: 80, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "customer.name", text: "{اسم العميل}", x: 110, y: 180, width: 280, height: 22, fontSize: 12 }),
      txt({ text: "الرقم:", x: W - 250, y: 180, width: 60, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "invoice.number", text: "{رقم الفاتورة}", x: W - 190, y: 180, width: 160, height: 22, fontSize: 12 }),
      txt({ text: "التاريخ:", x: W - 250, y: 204, width: 60, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "invoice.date", text: "{تاريخ الفاتورة}", x: W - 190, y: 204, width: 160, height: 22, fontSize: 12 }),

      table(SALES_COLS, { x: 30, y: 250, width: W - 60, height: 320 },
        { headerBg: "#ffffff", headerColor: "#111827", altRowBg: "#ffffff", borderColor: "#111827" }),

      line({ x: W - 280, y: 600, width: 250, height: 1, background: "#111827" }),
      txt({ text: "الإجمالي", x: W - 280, y: 612, width: 100, height: 30, fontSize: 16, fontWeight: "300" }),
      field({ fieldKey: "totals.grand", text: "{الإجمالي}", x: W - 180, y: 612, width: 150, height: 30, fontSize: 18, fontWeight: "600", textAlign: "end" }),

      field({ fieldKey: "qr.zatca", text: "{QR}", x: 30, y: 612, width: 100, height: 100, fontSize: 9, textAlign: "center" }),
    ],
  };
}

// ─────────────────── 80mm thermal sales ───────────────────
function thermalSalesInvoice(): Layout {
  const W = 80 * MM; // ~302
  return {
    pageBackground: "#ffffff",
    margins: { top: 4, right: 4, bottom: 4, left: 4 },
    elements: [
      field({ fieldKey: "company.name", text: "{اسم الشركة}",
        x: 8, y: 10, width: W - 16, height: 24, fontSize: 14, fontWeight: "700", textAlign: "center" }),
      field({ fieldKey: "company.vat", text: "VAT: {الرقم الضريبي}",
        x: 8, y: 36, width: W - 16, height: 16, fontSize: 9, textAlign: "center", color: "#374151" }),
      field({ fieldKey: "company.phone", text: "{هاتف الشركة}",
        x: 8, y: 52, width: W - 16, height: 14, fontSize: 9, textAlign: "center", color: "#374151" }),
      line({ x: 8, y: 70, width: W - 16, height: 1, background: "#000" }),

      txt({ text: "فاتورة ضريبية مبسطة", x: 8, y: 76, width: W - 16, height: 18,
        fontSize: 11, fontWeight: "700", textAlign: "center" }),

      field({ fieldKey: "invoice.number", text: "رقم: {رقم الفاتورة}", x: 8, y: 100, width: W - 16, height: 16, fontSize: 9 }),
      field({ fieldKey: "invoice.date",   text: "تاريخ: {تاريخ الفاتورة}", x: 8, y: 116, width: W - 16, height: 16, fontSize: 9 }),
      field({ fieldKey: "customer.name",  text: "العميل: {اسم العميل}",   x: 8, y: 132, width: W - 16, height: 16, fontSize: 9 }),
      line({ x: 8, y: 152, width: W - 16, height: 1, background: "#000" }),

      table([
        { key: "name",  label: "الصنف",   width: W - 130, align: "start" },
        { key: "qty",   label: "كمية",   width: 40,      align: "center" },
        { key: "price", label: "السعر",  width: 45,      align: "end"    },
        { key: "total", label: "إجمالي", width: 50,      align: "end"    },
      ], { x: 8, y: 158, width: W - 16, height: 180 },
        { headerBg: "#000000", headerColor: "#ffffff" }),

      line({ x: 8, y: 348, width: W - 16, height: 1, background: "#000" }),
      txt({ text: "المجموع الفرعي", x: 8, y: 352, width: 100, height: 16, fontSize: 9 }),
      field({ fieldKey: "totals.subtotal", text: "{المجموع الفرعي}", x: W - 100, y: 352, width: 92, height: 16, fontSize: 9, textAlign: "end" }),
      txt({ text: "ضريبة 15%", x: 8, y: 370, width: 100, height: 16, fontSize: 9 }),
      field({ fieldKey: "totals.vat", text: "{الضريبة}", x: W - 100, y: 370, width: 92, height: 16, fontSize: 9, textAlign: "end" }),
      line({ x: 8, y: 390, width: W - 16, height: 1, background: "#000" }),
      txt({ text: "الإجمالي", x: 8, y: 394, width: 100, height: 22, fontSize: 12, fontWeight: "700" }),
      field({ fieldKey: "totals.grand", text: "{الإجمالي}", x: W - 100, y: 394, width: 92, height: 22, fontSize: 12, fontWeight: "700", textAlign: "end" }),

      field({ fieldKey: "qr.zatca", text: "{QR}", x: (W - 100) / 2, y: 426, width: 100, height: 100, fontSize: 8, textAlign: "center",
        background: "#ffffff", borderColor: "#000", borderWidth: 1 }),
      txt({ text: "شكراً لزيارتكم", x: 8, y: 540, width: W - 16, height: 18, fontSize: 10, textAlign: "center" }),
    ],
  };
}

// ─────────────────── Generic voucher (receipt/payment) ───────────────────
function classicVoucher(kind: "receipt" | "payment"): Layout {
  const W = 210 * MM;
  const color = kind === "receipt" ? "#059669" : "#dc2626";
  const titleAr = kind === "receipt" ? "سند قبض" : "سند صرف";
  const partyLabel = kind === "receipt" ? "استلمنا من السيد" : "صرفنا للسيد";
  const partyKey = kind === "receipt" ? "voucher.payer" : "voucher.beneficiary";
  return {
    pageBackground: "#ffffff",
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    elements: [
      rect({ x: 30, y: 30, width: W - 60, height: 90, background: "#f8fafc", borderColor: color, borderWidth: 2 }),
      image({ x: 50, y: 45, width: 60, height: 60, borderWidth: 0 }),
      field({ fieldKey: "company.name", text: "{اسم الشركة}", x: 120, y: 50, width: W - 200, height: 28, fontSize: 20, fontWeight: "700" }),
      field({ fieldKey: "company.vat",  text: "VAT: {الرقم الضريبي}", x: 120, y: 82, width: W - 200, height: 22, fontSize: 12, color: "#475569" }),

      txt({ text: titleAr, x: (W - 260) / 2, y: 150, width: 260, height: 50, fontSize: 28, fontWeight: "700",
        textAlign: "center", color: "#fff", background: color, borderWidth: 0 }),

      txt({ text: "رقم السند", x: 50, y: 230, width: 100, height: 24, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "voucher.number", text: "{رقم السند}", x: 150, y: 230, width: 200, height: 28, fontSize: 14, fontWeight: "600",
        background: "#f3f4f6", borderColor: "#d1d5db", borderWidth: 1, borderStyle: "solid" }),

      txt({ text: "التاريخ", x: W - 350, y: 230, width: 100, height: 24, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "voucher.date", text: "{التاريخ}", x: W - 250, y: 230, width: 200, height: 28, fontSize: 14, fontWeight: "600",
        background: "#f3f4f6", borderColor: "#d1d5db", borderWidth: 1, borderStyle: "solid" }),

      txt({ text: "المبلغ", x: 50, y: 280, width: 100, height: 24, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "voucher.amount", text: "{المبلغ}", x: 150, y: 280, width: 300, height: 40, fontSize: 22, fontWeight: "700", color,
        background: "#fff", borderColor: color, borderWidth: 2, borderStyle: "solid" }),

      txt({ text: partyLabel, x: 50, y: 350, width: 200, height: 24, fontSize: 12, color: "#475569" }),
      field({ fieldKey: partyKey, text: kind === "receipt" ? "{المستلم منه}" : "{المستفيد}",
        x: 50, y: 374, width: W - 100, height: 32, fontSize: 16, fontWeight: "600",
        background: "#fffbeb", borderColor: "#fcd34d", borderWidth: 1, borderStyle: "solid" }),

      txt({ text: "وذلك مقابل (البيان)", x: 50, y: 422, width: 200, height: 24, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "voucher.description", text: "{البيان}", x: 50, y: 446, width: W - 100, height: 80, fontSize: 13,
        background: "#f9fafb", borderColor: "#d1d5db", borderWidth: 1, borderStyle: "solid" }),

      txt({ text: "المبلغ كتابة", x: 50, y: 540, width: 200, height: 24, fontSize: 12, color: "#475569" }),
      field({ fieldKey: "voucher.amountWords", text: "{المبلغ كتابة}", x: 50, y: 564, width: W - 100, height: 40, fontSize: 14, fontWeight: "500",
        background: "#fff", borderColor: "#d1d5db", borderWidth: 1, borderStyle: "solid" }),

      txt({ text: "توقيع المستلم", x: 80, y: 720, width: 200, height: 24, fontSize: 12, textAlign: "center", color: "#475569" }),
      line({ x: 60, y: 712, width: 240, height: 1, background: "#475569" }),
      txt({ text: "توقيع المحاسب", x: W - 320, y: 720, width: 200, height: 24, fontSize: 12, textAlign: "center", color: "#475569" }),
      line({ x: W - 340, y: 712, width: 240, height: 1, background: "#475569" }),
    ],
  };
}

// ─────────────────── Bank / Treasury slip (own field keys) ───────────────────
function bankReceiptSlip(): Layout {
  const W = 210 * MM;
  return {
    pageBackground: "#ffffff",
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    elements: [
      rect({ x: 30, y: 30, width: W - 60, height: 80, background: "#eff6ff", borderColor: "#3b82f6", borderWidth: 2 }),
      image({ x: 50, y: 45, width: 50, height: 50, borderWidth: 0 }),
      field({ fieldKey: "company.name", text: "{اسم الشركة}", x: 110, y: 50, width: W - 200, height: 26, fontSize: 18, fontWeight: "700" }),
      txt({ text: "إيصال بنكي", x: W - 220, y: 60, width: 170, height: 28, fontSize: 18, fontWeight: "700", textAlign: "end", color: "#1d4ed8" }),

      rect({ x: 30, y: 140, width: W - 60, height: 90, background: "#ffffff", borderColor: "#cbd5e1" }),
      txt({ text: "اسم البنك", x: 40, y: 150, width: 100, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "bank.name", text: "{اسم البنك}", x: 40, y: 174, width: (W - 80) / 2, height: 28, fontSize: 14, fontWeight: "600" }),
      txt({ text: "رقم الحساب", x: 50 + (W - 80) / 2, y: 150, width: 120, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "bank.account", text: "{رقم الحساب}", x: 50 + (W - 80) / 2, y: 174, width: (W - 80) / 2, height: 28, fontSize: 14, fontWeight: "600" }),

      txt({ text: "التاريخ", x: 40, y: 260, width: 100, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "voucher.date", text: "{التاريخ}", x: 40, y: 284, width: 240, height: 28, fontSize: 14, fontWeight: "600",
        background: "#f3f4f6", borderColor: "#d1d5db", borderWidth: 1, borderStyle: "solid" }),

      txt({ text: "المبلغ", x: 40, y: 340, width: 100, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "voucher.amount", text: "{المبلغ}", x: 40, y: 364, width: 360, height: 44, fontSize: 24, fontWeight: "700", color: "#1d4ed8",
        background: "#fff", borderColor: "#3b82f6", borderWidth: 2, borderStyle: "solid" }),
    ],
  };
}
function treasurySlip(): Layout {
  const W = 210 * MM;
  return {
    pageBackground: "#ffffff",
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    elements: [
      rect({ x: 30, y: 30, width: W - 60, height: 80, background: "#fef3c7", borderColor: "#d97706", borderWidth: 2 }),
      image({ x: 50, y: 45, width: 50, height: 50, borderWidth: 0 }),
      field({ fieldKey: "company.name", text: "{اسم الشركة}", x: 110, y: 50, width: W - 200, height: 26, fontSize: 18, fontWeight: "700" }),
      txt({ text: "إيصال خزينة", x: W - 220, y: 60, width: 170, height: 28, fontSize: 18, fontWeight: "700", textAlign: "end", color: "#b45309" }),

      rect({ x: 30, y: 140, width: W - 60, height: 70, background: "#ffffff", borderColor: "#cbd5e1" }),
      txt({ text: "اسم الخزينة", x: 40, y: 150, width: 120, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "treasury.name", text: "{اسم الخزينة}", x: 40, y: 174, width: W - 80, height: 28, fontSize: 14, fontWeight: "600" }),

      txt({ text: "التاريخ", x: 40, y: 230, width: 100, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "voucher.date", text: "{التاريخ}", x: 40, y: 254, width: 240, height: 28, fontSize: 14, fontWeight: "600",
        background: "#f3f4f6", borderColor: "#d1d5db", borderWidth: 1, borderStyle: "solid" }),

      txt({ text: "المبلغ", x: 40, y: 310, width: 100, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "voucher.amount", text: "{المبلغ}", x: 40, y: 334, width: 360, height: 44, fontSize: 24, fontWeight: "700", color: "#b45309",
        background: "#fff", borderColor: "#d97706", borderWidth: 2, borderStyle: "solid" }),
    ],
  };
}

// ─────────────────── Generic statement (account/journal) ───────────────────
function classicAccountStatement(): Layout {
  const W = 210 * MM;
  return {
    pageBackground: "#ffffff",
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    elements: [
      field({ fieldKey: "company.name", text: "{اسم الشركة}",
        x: 30, y: 30, width: W - 60, height: 30, fontSize: 20, fontWeight: "700", textAlign: "center" }),
      txt({ text: "كشف حساب", x: 30, y: 64, width: W - 60, height: 26, fontSize: 16, textAlign: "center", color: "#475569" }),
      line({ x: 30, y: 96, width: W - 60, height: 2, background: "#111827" }),

      txt({ text: "اسم الحساب", x: 30, y: 110, width: 100, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "account.name", text: "{اسم الحساب}", x: 130, y: 110, width: 280, height: 22, fontSize: 13, fontWeight: "600" }),
      txt({ text: "رقم الحساب", x: W - 300, y: 110, width: 100, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "account.code", text: "{رقم الحساب}", x: W - 200, y: 110, width: 170, height: 22, fontSize: 13, fontWeight: "600" }),

      txt({ text: "من تاريخ", x: 30, y: 134, width: 100, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "period.from", text: "{من تاريخ}", x: 130, y: 134, width: 180, height: 22, fontSize: 12 }),
      txt({ text: "إلى تاريخ", x: W - 300, y: 134, width: 100, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "period.to", text: "{إلى تاريخ}", x: W - 200, y: 134, width: 170, height: 22, fontSize: 12 }),

      table([
        { key: "date",        label: "التاريخ",  width: 90,  align: "center" },
        { key: "ref",         label: "المرجع",   width: 80,  align: "center" },
        { key: "description", label: "البيان",   width: 280, align: "start"  },
        { key: "debit",       label: "مدين",     width: 90,  align: "end"    },
        { key: "credit",      label: "دائن",     width: 90,  align: "end"    },
        { key: "balance",     label: "الرصيد",  width: 100, align: "end"    },
      ], { x: 30, y: 170, width: W - 60, height: 480 },
        { headerBg: "#1f2937", headerColor: "#fff", altRowBg: "#f9fafb" }),

      txt({ text: "الرصيد الافتتاحي", x: W - 320, y: 680, width: 140, height: 22, fontSize: 12 }),
      field({ fieldKey: "totals.opening", text: "{الرصيد الافتتاحي}", x: W - 180, y: 680, width: 150, height: 22, fontSize: 12, textAlign: "end", fontWeight: "600" }),
      txt({ text: "إجمالي المدين", x: W - 320, y: 704, width: 140, height: 22, fontSize: 12 }),
      field({ fieldKey: "totals.debit", text: "{إجمالي المدين}", x: W - 180, y: 704, width: 150, height: 22, fontSize: 12, textAlign: "end", fontWeight: "600" }),
      txt({ text: "إجمالي الدائن", x: W - 320, y: 728, width: 140, height: 22, fontSize: 12 }),
      field({ fieldKey: "totals.credit", text: "{إجمالي الدائن}", x: W - 180, y: 728, width: 150, height: 22, fontSize: 12, textAlign: "end", fontWeight: "600" }),
      line({ x: W - 320, y: 756, width: 290, height: 2, background: "#111827" }),
      txt({ text: "الرصيد الختامي", x: W - 320, y: 764, width: 140, height: 28, fontSize: 14, fontWeight: "700" }),
      field({ fieldKey: "totals.closing", text: "{الرصيد الختامي}", x: W - 180, y: 764, width: 150, height: 28, fontSize: 14, textAlign: "end", fontWeight: "700" }),
    ],
  };
}

function classicJournalEntry(): Layout {
  const W = 210 * MM;
  return {
    pageBackground: "#ffffff",
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    elements: [
      field({ fieldKey: "company.name", text: "{اسم الشركة}",
        x: 30, y: 30, width: W - 60, height: 30, fontSize: 20, fontWeight: "700", textAlign: "center" }),
      txt({ text: "قيد محاسبي", x: 30, y: 64, width: W - 60, height: 26, fontSize: 16, textAlign: "center", color: "#475569" }),
      line({ x: 30, y: 96, width: W - 60, height: 2, background: "#111827" }),

      txt({ text: "رقم القيد", x: 30, y: 110, width: 100, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "je.number", text: "{رقم القيد}", x: 130, y: 110, width: 180, height: 22, fontSize: 13, fontWeight: "600" }),
      txt({ text: "التاريخ", x: W - 300, y: 110, width: 100, height: 22, fontSize: 11, color: "#6b7280" }),
      field({ fieldKey: "je.date", text: "{التاريخ}", x: W - 200, y: 110, width: 170, height: 22, fontSize: 12 }),

      field({ fieldKey: "je.description", text: "البيان: {البيان}",
        x: 30, y: 140, width: W - 60, height: 40, fontSize: 12, color: "#1e293b",
        background: "#fffbeb", borderColor: "#fcd34d", borderWidth: 1, borderStyle: "solid" }),

      table([
        { key: "account",     label: "الحساب",   width: 260, align: "start"  },
        { key: "description", label: "البيان",   width: 280, align: "start"  },
        { key: "debit",       label: "مدين",     width: 110, align: "end"    },
        { key: "credit",      label: "دائن",     width: 110, align: "end"    },
      ], { x: 30, y: 190, width: W - 60, height: 480 },
        { headerBg: "#1f2937", headerColor: "#fff", altRowBg: "#f9fafb" }),

      txt({ text: "إجمالي المدين", x: 30, y: 690, width: 200, height: 28, fontSize: 14, fontWeight: "700" }),
      field({ fieldKey: "je.totalDebit", text: "{إجمالي المدين}", x: 230, y: 690, width: 180, height: 28, fontSize: 14, fontWeight: "700", textAlign: "end" }),
      txt({ text: "إجمالي الدائن", x: W - 380, y: 690, width: 200, height: 28, fontSize: 14, fontWeight: "700" }),
      field({ fieldKey: "je.totalCredit", text: "{إجمالي الدائن}", x: W - 180, y: 690, width: 150, height: 28, fontSize: 14, fontWeight: "700", textAlign: "end" }),

      txt({ text: "المعتمد", x: 60, y: 780, width: 160, height: 24, fontSize: 12, textAlign: "center", color: "#475569" }),
      line({ x: 40, y: 772, width: 200, height: 1, background: "#475569" }),
      txt({ text: "المراجع", x: (W - 160) / 2, y: 780, width: 160, height: 24, fontSize: 12, textAlign: "center", color: "#475569" }),
      line({ x: (W - 200) / 2, y: 772, width: 200, height: 1, background: "#475569" }),
      txt({ text: "المحاسب", x: W - 220, y: 780, width: 160, height: 24, fontSize: 12, textAlign: "center", color: "#475569" }),
      line({ x: W - 240, y: 772, width: 200, height: 1, background: "#475569" }),
    ],
  };
}

export interface PresetDescriptor {
  key: string;
  name: string;
  description: string;
  paperSize: "A4" | "A5" | "Letter" | "80mm";
  widthMm: number;
  heightMm: number;
  build: () => Layout;
  accent: string; // tailwind-ish color for the preview card
}

export const PRESETS_BY_DOC: Record<string, PresetDescriptor[]> = {
  sales_invoice: [
    { key: "classic", name: "كلاسيكي A4",  description: "تصميم رسمي بإطار أزرق وبيانات شركة وعميل وجدول كامل", paperSize: "A4", widthMm: 210, heightMm: 297, build: classicSalesInvoice, accent: "from-blue-500 to-indigo-600" },
    { key: "modern",  name: "حديث أخضر",    description: "شريط علوي بارز، جدول ملوّن، صندوق إجمالي مميز", paperSize: "A4", widthMm: 210, heightMm: 297, build: modernSalesInvoice,  accent: "from-emerald-500 to-teal-600" },
    { key: "minimal", name: "بسيط أنيق",   description: "تصميم نظيف بخطوط رفيعة بدون ألوان داعمة",      paperSize: "A4", widthMm: 210, heightMm: 297, build: minimalSalesInvoice, accent: "from-slate-500 to-slate-700" },
    { key: "thermal", name: "إيصال 80mm",  description: "للطابعات الحرارية، صفحة ضيقة وخط أكبر",       paperSize: "80mm", widthMm: 80, heightMm: 200, build: thermalSalesInvoice, accent: "from-gray-700 to-black" },
  ],
  purchase_invoice: [
    { key: "classic", name: "كلاسيكي A4", description: "بيانات المورد + جدول مشتريات مبسّط", paperSize: "A4", widthMm: 210, heightMm: 297, build: () => classicInvoiceLike(V_PURCHASE_INVOICE, "#0e7490"), accent: "from-cyan-500 to-blue-600" },
  ],
  sales_return: [
    { key: "classic", name: "كلاسيكي A4", description: "تخطيط مرتجع مع بيانات العميل ورقم المرتجع", paperSize: "A4", widthMm: 210, heightMm: 297, build: () => classicInvoiceLike(V_SALES_RETURN, "#b91c1c"), accent: "from-rose-500 to-red-600" },
  ],
  purchase_return: [
    { key: "classic", name: "كلاسيكي A4", description: "تخطيط مرتجع مع بيانات المورد ورقم المرتجع", paperSize: "A4", widthMm: 210, heightMm: 297, build: () => classicInvoiceLike(V_PURCHASE_RETURN, "#b91c1c"), accent: "from-rose-500 to-red-600" },
  ],
  receipt_voucher: [
    { key: "classic", name: "سند قبض كلاسيكي", description: "تصميم رسمي أخضر مع خانات التوقيع",  paperSize: "A4", widthMm: 210, heightMm: 297, build: () => classicVoucher("receipt"), accent: "from-emerald-500 to-emerald-700" },
  ],
  payment_voucher: [
    { key: "classic", name: "سند صرف كلاسيكي", description: "تصميم رسمي أحمر مع خانات التوقيع", paperSize: "A4", widthMm: 210, heightMm: 297, build: () => classicVoucher("payment"), accent: "from-rose-500 to-red-700" },
  ],
  bank_receipt: [
    { key: "classic", name: "إيصال بنكي", description: "تصميم بحقول البنك ورقم الحساب والمبلغ", paperSize: "A4", widthMm: 210, heightMm: 297, build: bankReceiptSlip, accent: "from-blue-500 to-blue-700" },
  ],
  treasury_receipt: [
    { key: "classic", name: "إيصال خزينة", description: "تصميم باسم الخزينة والمبلغ والتاريخ", paperSize: "A4", widthMm: 210, heightMm: 297, build: treasurySlip, accent: "from-amber-500 to-amber-700" },
  ],
  account_statement: [
    { key: "classic", name: "كشف حساب كلاسيكي", description: "جدول تفصيلي + إجماليات وأرصدة", paperSize: "A4", widthMm: 210, heightMm: 297, build: classicAccountStatement, accent: "from-slate-600 to-slate-800" },
  ],
  journal_entry: [
    { key: "classic", name: "قيد محاسبي كلاسيكي", description: "جدول مدين/دائن مع خانات التوقيع", paperSize: "A4", widthMm: 210, heightMm: 297, build: classicJournalEntry, accent: "from-indigo-600 to-purple-700" },
  ],
};
