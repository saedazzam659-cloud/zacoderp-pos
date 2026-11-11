import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff, FileText, Loader2, Printer, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

type DocumentKey =
  | "sales_invoice"
  | "sales_quotation"
  | "sales_return"
  | "sales_order"
  | "purchase_order"
  | "purchase_invoice"
  | "receipt_voucher"
  | "payment_voucher";

type FieldKey =
  | "itemCode" | "itemName" | "quantity" | "freeQuantity" | "unit" | "unitPrice"
  | "discountPercent" | "discountAmount" | "taxRate" | "taxAmount" | "lineTotal"
  | "companyDetails" | "documentNumber" | "date" | "partyName" | "partyVat"
  | "partyAddress" | "branch" | "seller" | "paymentMethod" | "currency"
  | "exchangeRate" | "notes" | "qr" | "amountInWords" | "subtotal"
  | "discountTotal" | "taxTotal" | "grandTotal" | "validUntil" | "deliveryDate"
  | "receiverDetails" | "terms" | "status" | "createdAt" | "treasury" | "account"
  | "invoiceNumber" | "description" | "signatures" | "printedAt";

type VisibilityMap = Partial<Record<DocumentKey, Partial<Record<FieldKey, boolean>>>>;
type FieldGroup = { title: string; fields: { key: FieldKey; label: string; hint?: string }[] };

const itemFields: FieldGroup = {
  title: "تفاصيل الأصناف",
  fields: [
    { key: "itemCode", label: "رمز الصنف" },
    { key: "itemName", label: "اسم الصنف" },
    { key: "quantity", label: "الكمية" },
    { key: "freeQuantity", label: "الكمية المجانية" },
    { key: "unit", label: "وحدة القياس" },
    { key: "unitPrice", label: "سعر الوحدة" },
    { key: "discountPercent", label: "نسبة الخصم" },
    { key: "discountAmount", label: "قيمة الخصم" },
    { key: "taxRate", label: "نسبة الضريبة" },
    { key: "taxAmount", label: "قيمة الضريبة" },
    { key: "lineTotal", label: "إجمالي السطر" },
  ],
};

const documentFields: FieldGroup = {
  title: "بيانات المستند",
  fields: [
    { key: "companyDetails", label: "بيانات الشركة" },
    { key: "documentNumber", label: "رقم المستند" },
    { key: "date", label: "التاريخ" },
    { key: "partyName", label: "اسم العميل أو المورد" },
    { key: "partyVat", label: "الرقم الضريبي للطرف" },
    { key: "partyAddress", label: "عنوان الطرف" },
    { key: "branch", label: "الفرع" },
    { key: "seller", label: "مندوب المبيعات" },
    { key: "invoiceNumber", label: "رقم الفاتورة المرتبطة" },
  ],
};

const amountFields: FieldGroup = {
  title: "المبالغ والضريبة",
  fields: [
    { key: "currency", label: "العملة" },
    { key: "exchangeRate", label: "سعر الصرف" },
    { key: "subtotal", label: "الإجمالي قبل الخصم والضريبة" },
    { key: "discountTotal", label: "إجمالي الخصم" },
    { key: "taxTotal", label: "إجمالي الضريبة" },
    { key: "grandTotal", label: "الإجمالي النهائي" },
    { key: "amountInWords", label: "المبلغ كتابةً" },
  ],
};

const extraFields: FieldGroup = {
  title: "معلومات إضافية",
  fields: [
    { key: "paymentMethod", label: "طريقة الدفع" },
    { key: "treasury", label: "الخزينة" },
    { key: "account", label: "الحساب" },
    { key: "notes", label: "ملاحظات" },
    { key: "description", label: "البيان" },
    { key: "qr", label: "رمز الاستجابة السريعة" },
    { key: "validUntil", label: "صالح حتى" },
    { key: "deliveryDate", label: "تاريخ التسليم" },
    { key: "receiverDetails", label: "بيانات المستلم" },
    { key: "terms", label: "الشروط والأحكام" },
    { key: "status", label: "حالة المستند" },
    { key: "createdAt", label: "تاريخ الإنشاء" },
    { key: "signatures", label: "التوقيعات" },
    { key: "printedAt", label: "وقت الطباعة" },
  ],
};

const salesCommon: FieldKey[] = [
  "companyDetails", "documentNumber", "date", "partyName", "partyVat", "partyAddress",
  "branch", "seller", "paymentMethod", "currency", "exchangeRate", "notes", "qr",
  "amountInWords", "subtotal", "discountTotal", "taxTotal", "grandTotal",
  "invoiceNumber", "description", "createdAt", "signatures", "printedAt",
];
const purchaseCommon: FieldKey[] = [
  "companyDetails", "documentNumber", "date", "partyName", "partyVat", "partyAddress",
  "branch", "seller", "paymentMethod", "currency", "exchangeRate", "notes",
  "amountInWords", "subtotal", "discountTotal", "taxTotal", "grandTotal",
  "invoiceNumber", "description", "receiverDetails", "terms", "status", "signatures", "printedAt",
];
const voucherCommon: FieldKey[] = [
  "companyDetails", "documentNumber", "date", "partyName", "partyVat", "partyAddress",
  "branch", "paymentMethod", "currency", "exchangeRate", "notes", "amountInWords",
  "grandTotal", "treasury", "account", "invoiceNumber", "description", "signatures", "printedAt",
];
const itemKeys = itemFields.fields.map((field) => field.key);

const documents: {
  key: DocumentKey;
  label: string;
  type: string;
  accent: string;
  fields: FieldKey[];
}[] = [
  { key: "sales_invoice", label: "فاتورة مبيعات", type: "مبيعات", accent: "border-r-teal-600", fields: [...itemKeys, ...salesCommon.filter((key) => key !== "invoiceNumber")] },
  { key: "sales_quotation", label: "عرض سعر", type: "مبيعات", accent: "border-r-sky-600", fields: [...itemKeys, ...salesCommon.filter((key) => key !== "paymentMethod" && key !== "invoiceNumber"), "validUntil", "deliveryDate", "terms", "status"] },
  { key: "sales_return", label: "مرتجع مبيعات", type: "مبيعات", accent: "border-r-rose-600", fields: [...itemKeys, ...salesCommon] },
  { key: "sales_order", label: "أمر بيع", type: "مبيعات", accent: "border-r-indigo-600", fields: [...itemKeys, ...salesCommon.filter((key) => key !== "paymentMethod" && key !== "qr" && key !== "invoiceNumber"), "validUntil", "deliveryDate", "terms", "status"] },
  { key: "purchase_order", label: "أمر شراء", type: "مشتريات", accent: "border-r-amber-600", fields: [...itemKeys, ...purchaseCommon.filter((key) => key !== "paymentMethod" && key !== "invoiceNumber" && key !== "qr"), "validUntil", "deliveryDate"] },
  { key: "purchase_invoice", label: "فاتورة مشتريات", type: "مشتريات", accent: "border-r-orange-600", fields: [...itemKeys, ...purchaseCommon] },
  { key: "receipt_voucher", label: "سند قبض", type: "سندات", accent: "border-r-emerald-600", fields: voucherCommon },
  { key: "payment_voucher", label: "سند صرف", type: "سندات", accent: "border-r-rose-600", fields: voucherCommon },
];

const groups = [documentFields, itemFields, amountFields, extraFields];
const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const englishLabels: Record<string, string> = {
  "تفاصيل الأصناف": "Item details",
  "رمز الصنف": "Item code",
  "اسم الصنف": "Item name",
  "الكمية": "Quantity",
  "الكمية المجانية": "Free quantity",
  "وحدة القياس": "Unit of measure",
  "سعر الوحدة": "Unit price",
  "نسبة الخصم": "Discount percentage",
  "قيمة الخصم": "Discount amount",
  "نسبة الضريبة": "Tax rate",
  "قيمة الضريبة": "Tax amount",
  "إجمالي السطر": "Line total",
  "بيانات المستند": "Document details",
  "بيانات الشركة": "Company details",
  "رقم المستند": "Document number",
  "التاريخ": "Date",
  "اسم العميل أو المورد": "Customer or supplier name",
  "الرقم الضريبي للطرف": "Party VAT number",
  "عنوان الطرف": "Party address",
  "الفرع": "Branch",
  "مندوب المبيعات": "Sales representative",
  "رقم الفاتورة المرتبطة": "Related invoice number",
  "المبالغ والضريبة": "Amounts and tax",
  "العملة": "Currency",
  "سعر الصرف": "Exchange rate",
  "الإجمالي قبل الخصم والضريبة": "Subtotal before discount and tax",
  "إجمالي الخصم": "Total discount",
  "إجمالي الضريبة": "Total tax",
  "الإجمالي النهائي": "Grand total",
  "المبلغ كتابةً": "Amount in words",
  "معلومات إضافية": "Additional information",
  "طريقة الدفع": "Payment method",
  "الخزينة": "Treasury",
  "الحساب": "Account",
  "ملاحظات": "Notes",
  "البيان": "Description",
  "رمز الاستجابة السريعة": "QR code",
  "صالح حتى": "Valid until",
  "تاريخ التسليم": "Delivery date",
  "بيانات المستلم": "Receiver details",
  "الشروط والأحكام": "Terms and conditions",
  "حالة المستند": "Document status",
  "تاريخ الإنشاء": "Created at",
  "التوقيعات": "Signatures",
  "وقت الطباعة": "Print time",
  "فاتورة مبيعات": "Sales invoice",
  "عرض سعر": "Sales quotation",
  "مرتجع مبيعات": "Sales return",
  "أمر بيع": "Sales order",
  "أمر شراء": "Purchase order",
  "فاتورة مشتريات": "Purchase invoice",
  "سند قبض": "Receipt voucher",
  "سند صرف": "Payment voucher",
  "مبيعات": "Sales",
  "مشتريات": "Purchases",
  "سندات": "Vouchers",
  "إعدادات المستندات · على مستوى الشركة": "Document settings · company-wide",
  "إعدادات قالب الطباعة المحدد": "Settings for this print template",
  "هذا الإعداد يخص نوع المستند المحدد والقالب الحالي فقط.": "This setting applies only to the selected document type and current template.",
  "حقول الطباعة": "Print field visibility",
  "حدّد ما يظهر في النسخ المطبوعة لكل نوع مستند. إعداد الإخفاء يخص شكل الطباعة فقط ولا يغيّر أي قيمة محاسبية.": "Choose which fields appear on printed copies of each document type. Hiding a field changes print presentation only; it never changes accounting values.",
  "عرض افتراضي آمن": "Safe default display",
  "الحقول غير المحددة تحافظ على الطباعة الحالية": "Fields without a setting keep their current print behavior",
  "نوع المستند": "Document type",
  "اختر قالباً لضبط حقوله": "Choose a document to configure its fields",
  "حقلاً ظاهراً": "fields shown",
  "من": "of",
  "ظاهرة": "shown",
  "تظهر الحقول المفعّلة في المخرجات المطبوعة لهذا النوع.": "Enabled fields appear on printed copies of this document type.",
  "استعادة إعدادات القالب": "Restore template defaults",
  "تُحفظ التغييرات للقالب المحدد ونوع المستند فقط.": "Changes are saved only for this template and document type.",
  "التغييرات تُحفظ للشركة بالكامل، وتؤثر على المظهر المطبوع فقط.": "Changes are saved company-wide and affect print appearance only.",
  "إظهار الكل": "Show all",
  "إخفاء الكل": "Hide all",
  "الافتراضي": "Default",
  "يظهر في الطباعة": "Shown in print",
  "مخفي من الطباعة": "Hidden from print",
  "إخفاء": "Hide",
  "إظهار": "Show",
  "جارٍ الحفظ...": "Saving...",
  "حفظ الإعدادات": "Save settings",
  "تعذّر قراءة رد الحفظ.": "Could not read the save response.",
  "تعذّر الحفظ": "Could not save",
  "تعذّر حفظ إعدادات حقول الطباعة.": "Could not save print field settings.",
  "تم حفظ إعدادات حقول الطباعة": "Print field settings saved",
  "تعذّر حفظ إعدادات حقول الطباعة. تحقق من الاتصال وحاول مجدداً.": "Could not save print field settings. Check your connection and try again.",
};

export default function PrintFieldVisibilityTab({
  user,
  token,
  setUser,
  templateKey,
  initialDocumentKey,
}: {
  user: any;
  token: string;
  setUser: any;
  templateKey?: string;
  initialDocumentKey?: DocumentKey;
}) {
  const { i18n } = useTranslation();
  const isArabic = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith("ar");
  const translate = (arabic: string) => isArabic ? arabic : englishLabels[arabic] ?? arabic;
  const qc = useQueryClient();
  const { toast } = useToast();
  const companyId = user?.company?.id ?? user?.companyId;
  const companySettings = templateKey
    ? user?.company?.printTemplateFieldVisibility?.[templateKey]
    : user?.company?.printFieldVisibility;
  const availableDocuments = useMemo(
    () => documents.filter((item) => templateKey
      ? templateKey.startsWith("custom:")
        ? item.key.startsWith("sales_")
        : item.key.startsWith("sales_")
      : !item.key.startsWith("sales_")),
    [templateKey],
  );
  const settingsSnapshot = JSON.stringify(companySettings ?? {});
  const [visibility, setVisibility] = useState<VisibilityMap>({});
  const [selectedDocument, setSelectedDocument] = useState<DocumentKey>(
    initialDocumentKey
      ?? (templateKey?.startsWith("custom:") ? "sales_quotation" : templateKey ? "sales_invoice" : "purchase_order"),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    try {
      setVisibility(JSON.parse(settingsSnapshot));
    } catch {
      setVisibility({});
    }
  }, [settingsSnapshot]);

  const document = availableDocuments.find((item) => item.key === selectedDocument) ?? availableDocuments[0] ?? documents[0]!;
  const groupsForDocument = useMemo(
    () => groups.map((group) => ({
      ...group,
      fields: group.fields.filter((field) => document.fields.includes(field.key)),
    })).filter((group) => group.fields.length > 0),
    [document],
  );
  const hasChanges = JSON.stringify(visibility) !== settingsSnapshot;
  const defaultVisible = (documentKey: DocumentKey, field: FieldKey): boolean => {
    const company = user?.company ?? {};
    if (field === "freeQuantity" && company.showFreeQuantity === false) return false;
    if (documentKey === "sales_quotation") {
      if (field === "qr") return company.printQuotationShowQr === true;
      if (field === "partyAddress") return company.printQuotationShowCustomerAddress !== false;
    }
    if (documentKey === "purchase_order") {
      const options = company.purchaseOrderPrintOptions ?? {};
      const legacyDefaults: Partial<Record<FieldKey, boolean>> = {
        companyDetails: options.showCompanyDetails,
        branch: options.showBranch,
        partyName: options.showSupplierDetails,
        partyVat: options.showSupplierDetails,
        partyAddress: options.showSupplierDetails,
        itemCode: options.showItemCode,
        taxRate: options.showTaxBreakdown,
        taxAmount: options.showTaxBreakdown,
        notes: options.showNotes,
        terms: options.showTerms ?? false,
        deliveryDate: options.showDeliveryDate,
        receiverDetails: options.showReceiverDetails,
      };
      const legacy = legacyDefaults[field];
      if (typeof legacy === "boolean") return legacy;
    }
    return true;
  };
  const isFieldVisible = (documentKey: DocumentKey, field: FieldKey) =>
    visibility[documentKey]?.[field] ?? defaultVisible(documentKey, field);
  const shownCount = document.fields.filter((field) => isFieldVisible(selectedDocument, field)).length;

  function updateField(field: FieldKey, shown: boolean) {
    setVisibility((current) => ({
      ...current,
      [selectedDocument]: { ...current[selectedDocument], [field]: shown },
    }));
  }

  function setAllFields(shown: boolean) {
    setVisibility((current) => ({
      ...current,
      [selectedDocument]: Object.fromEntries(document.fields.map((field) => [field, shown])),
    }));
  }

  function resetDocument() {
    setVisibility((current) => {
      const next = { ...current };
      delete next[selectedDocument];
      return next;
    });
  }

  function resetTemplateDefaults() {
    if (templateKey) setVisibility({});
  }

  async function saveSettings() {
    if (!companyId || saving || !hasChanges) return;
    setSaving(true);
    try {
      const nextTemplateVisibility = templateKey
        ? {
            ...(user?.company?.printTemplateFieldVisibility ?? {}),
            [templateKey]: visibility,
          }
        : undefined;
      const response = await fetch(`${API}/api/companies/${companyId}/general-settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(templateKey
          ? { printTemplateFieldVisibility: nextTemplateVisibility }
          : { printFieldVisibility: visibility }),
      });
      const raw = await response.text();
      let result: any = {};
      try {
        result = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(response.ok ? translate("تعذّر قراءة رد الحفظ.") : `${translate("تعذّر الحفظ")} (${response.status}).`);
      }
      if (!response.ok) throw new Error(translate("تعذّر حفظ إعدادات حقول الطباعة."));

      const savedVisibility = templateKey
        ? result?.printTemplateFieldVisibility?.[templateKey] ?? visibility
        : result?.printFieldVisibility ?? visibility;
      setVisibility(savedVisibility);
      setUser?.((current: any) => current ? {
        ...current,
        company: templateKey
          ? {
              ...current.company,
              printTemplateFieldVisibility: {
                ...(current.company?.printTemplateFieldVisibility ?? {}),
                [templateKey]: savedVisibility,
              },
            }
          : { ...current.company, printFieldVisibility: savedVisibility },
      } : current);
      qc.invalidateQueries({ queryKey: ["auth-me"] });
      toast({ title: translate("تم حفظ إعدادات حقول الطباعة") });
    } catch {
      toast({ title: translate("تعذّر حفظ إعدادات حقول الطباعة. تحقق من الاتصال وحاول مجدداً."), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section dir={isArabic ? "rtl" : "ltr"} className="space-y-5" data-testid="print-field-visibility-panel">
      <header className="relative overflow-hidden rounded-2xl border border-teal-900/10 bg-gradient-to-l from-teal-950 to-teal-800 px-5 py-6 text-white shadow-sm sm:px-7">
        <div className="absolute -left-10 -top-16 h-52 w-52 rounded-full border border-white/10" aria-hidden="true" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-2xl">
            <div className="mb-3 flex items-center gap-2 text-teal-100">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/10"><Printer className="h-4 w-4" /></span>
              <span className="text-xs font-semibold tracking-wide">
                {translate(templateKey ? "إعدادات قالب الطباعة المحدد" : "إعدادات المستندات · على مستوى الشركة")}
              </span>
            </div>
            <h2 className="text-xl font-bold sm:text-2xl">{translate("حقول الطباعة")}</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-teal-50/85">
              {translate("حدّد ما يظهر في النسخ المطبوعة لكل نوع مستند. إعداد الإخفاء يخص شكل الطباعة فقط ولا يغيّر أي قيمة محاسبية.")}
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-white/15 bg-white/10 px-4 py-3">
            <ShieldCheck className="h-5 w-5 shrink-0 text-teal-100" />
            <div>
              <div className="text-sm font-semibold">{translate("عرض افتراضي آمن")}</div>
              <div className="mt-0.5 text-xs text-teal-50/80">{translate("الحقول غير المحددة تحافظ على الطباعة الحالية")}</div>
            </div>
          </div>
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.65fr)]">
        <aside className="rounded-2xl border border-border/70 bg-card p-3 shadow-sm">
          <div className="flex items-center justify-between px-2 pb-3 pt-1">
            <div>
              <h3 className="text-sm font-bold">{translate("نوع المستند")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{translate("اختر قالباً لضبط حقوله")}</p>
            </div>
            <FileText className="h-4 w-4 text-teal-700" />
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-1">
            {availableDocuments.map((item, index) => {
              const active = item.key === selectedDocument;
              const count = item.fields.filter((field) => isFieldVisible(item.key, field)).length;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setSelectedDocument(item.key)}
                  data-testid={`select-print-document-${item.key}`}
                  aria-pressed={active}
                  className={`group flex min-w-0 items-center gap-3 rounded-xl border-r-[3px] px-3 py-3 ${isArabic ? "text-right" : "text-left"} transition-colors ${item.accent} ${active ? "bg-teal-50 ring-1 ring-teal-700/15 dark:bg-teal-950/30" : "border-y border-l border-transparent hover:bg-muted/70"}`}
                >
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-bold ${active ? "bg-teal-800 text-white" : "bg-muted text-muted-foreground"}`}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm font-semibold ${active ? "text-teal-950 dark:text-teal-100" : ""}`}>{translate(item.label)}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{translate(item.type)} · {count} {translate("حقلاً ظاهراً")}</span>
                  </span>
                  {active && <Check className="h-4 w-4 shrink-0 text-teal-700" />}
                </button>
              );
            })}
          </div>
        </aside>

        <main className="min-w-0 rounded-2xl border border-border/70 bg-card shadow-sm">
          <div className="sticky top-0 z-20 flex flex-col gap-4 rounded-t-2xl border-b border-border/70 bg-card px-4 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-bold">{translate(document.label)}</h3>
                <span className="rounded-full bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-800 dark:bg-teal-950/40 dark:text-teal-200">
                  {shownCount} {translate("من")} {document.fields.length} {translate("ظاهرة")}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {translate(templateKey
                  ? "هذا الإعداد يخص نوع المستند المحدد والقالب الحالي فقط."
                  : "تظهر الحقول المفعّلة في المخرجات المطبوعة لهذا النوع.")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="print-field-document-select">{translate("نوع المستند")}</label>
              <select
                id="print-field-document-select"
                value={selectedDocument}
                onChange={(event) => setSelectedDocument(event.target.value as DocumentKey)}
                data-testid="print-field-document-select"
                className="h-9 min-w-40 rounded-md border border-input bg-background px-3 text-sm"
              >
                {availableDocuments.map((item) => (
                  <option key={item.key} value={item.key}>{translate(item.label)}</option>
                ))}
              </select>
              <Button type="button" variant="outline" size="sm" onClick={() => setAllFields(true)} data-testid={`show-all-print-fields-${selectedDocument}`}>
                <Eye className="ms-1.5 h-4 w-4" /> {translate("إظهار الكل")}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setAllFields(false)} data-testid={`hide-all-print-fields-${selectedDocument}`}>
                <EyeOff className="ms-1.5 h-4 w-4" /> {translate("إخفاء الكل")}
              </Button>
              {templateKey ? (
                <Button type="button" variant="ghost" size="sm" onClick={resetTemplateDefaults} data-testid="reset-template-print-fields">
                  <RotateCcw className="ms-1.5 h-4 w-4" /> {translate("استعادة إعدادات القالب")}
                </Button>
              ) : (
                <Button type="button" variant="ghost" size="sm" onClick={resetDocument} data-testid={`reset-print-fields-${selectedDocument}`}>
                  <RotateCcw className="ms-1.5 h-4 w-4" /> {translate("الافتراضي")}
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-5 p-4 sm:p-6">
            {groupsForDocument.map((group) => (
              <section key={group.title} aria-label={translate(group.title)}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="h-4 w-1 rounded-full bg-teal-700" />
                  <h4 className="text-sm font-bold">{translate(group.title)}</h4>
                  <span className="text-xs text-muted-foreground">({group.fields.length})</span>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {group.fields.map((field) => {
                    const checked = isFieldVisible(selectedDocument, field.key);
                    return (
                      <div
                        key={field.key}
                        className={`flex min-h-[58px] items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 transition-colors ${checked ? "border-teal-900/10 bg-teal-50/45 dark:bg-teal-950/15" : "border-border/70 bg-muted/30"}`}
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${checked ? "bg-teal-700" : "bg-muted-foreground/40"}`} />
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{translate(field.label)}</div>
                            <div className="text-[11px] text-muted-foreground">{translate(checked ? "يظهر في الطباعة" : "مخفي من الطباعة")}</div>
                          </div>
                        </div>
                        <Switch
                          checked={checked}
                          onCheckedChange={(value) => updateField(field.key, value)}
                          aria-label={`${translate(checked ? "إخفاء" : "إظهار")} ${translate(field.label)}`}
                          data-testid={`toggle-print-field-${selectedDocument}-${field.key}`}
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <footer className="flex flex-col gap-3 border-t border-border/70 bg-muted/20 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="text-xs leading-5 text-muted-foreground" data-testid="print-field-visibility-save-hint">
              {translate(templateKey
                ? "تُحفظ التغييرات للقالب المحدد ونوع المستند فقط."
                : "التغييرات تُحفظ للشركة بالكامل، وتؤثر على المظهر المطبوع فقط.")}
            </p>
            <Button
              type="button"
              onClick={saveSettings}
              disabled={!hasChanges || saving || !companyId}
              data-testid="save-print-field-visibility"
              className="min-w-36 bg-teal-800 text-white hover:bg-teal-900"
            >
              {saving ? <Loader2 className="ms-2 h-4 w-4 animate-spin" /> : <Save className="ms-2 h-4 w-4" />}
              {saving ? translate("جارٍ الحفظ...") : translate("حفظ الإعدادات")}
            </Button>
          </footer>
        </main>
      </div>
    </section>
  );
}
