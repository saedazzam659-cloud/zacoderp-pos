import * as React from "react";
import i18n from "@/i18n";
import ar from "@/i18n/locales/ar.json";
import en from "@/i18n/locales/en.json";
import { useTranslation } from "react-i18next";

const translations = new Map<string, string>();
const ambiguous = new Set<string>();

function collectPairs(arValue: unknown, enValue: unknown) {
  if (!arValue || !enValue || typeof arValue !== "object" || typeof enValue !== "object") return;
  for (const key of Object.keys(arValue)) {
    const arChild = (arValue as Record<string, unknown>)[key];
    const enChild = (enValue as Record<string, unknown>)[key];
    if (typeof arChild === "string" && typeof enChild === "string" && arChild !== enChild) {
      const current = translations.get(arChild);
      if (current && current !== enChild) ambiguous.add(arChild);
      else translations.set(arChild, enChild);
    } else {
      collectPairs(arChild, enChild);
    }
  }
}

collectPairs(ar, en);
for (const label of ambiguous) translations.delete(label);

// Common grid and form labels that are intentionally shared across pages but
// do not yet have a dedicated locale key.
const sharedLabels: Record<string, string> = {
  "رقم الفاتورة": "Invoice No.",
  "التاريخ": "Date",
  "العميل": "Customer",
  "الرقم الضريبي": "Tax number",
  "هاتف العميل": "Customer phone",
  "الفرع": "Branch",
  "المندوب": "Sales representative",
  "نوع الدفع": "Payment type",
  "العملة": "Currency",
  "الكمية المجانية": "Free quantity",
  "المجموع": "Subtotal",
  "الخصم": "Discount",
  "الضريبة": "Tax",
  "الإجمالي": "Total",
  "الإجمالي بعد الخصم": "Total after discount",
  "العمولة": "Commission",
  "حالة السداد": "Payment status",
  "القيد": "Journal entry",
  "الحالة": "Status",
  "المصدر": "Source",
  "أنشأه": "Created by",
  "رحّله": "Posted by",
  "ملاحظات": "Notes",
  "إجراءات": "Actions",
  "رقم": "Number",
  "الاسم": "Name",
  "الكود": "Code",
  "المبلغ": "Amount",
  "الكمية": "Quantity",
  "المستودع": "Warehouse",
  "الحساب": "Account",
  "الوصف": "Description",
  "طريقة الدفع": "Payment method",
  "تاريخ الإنشاء": "Created date",
  "تاريخ الترحيل": "Posted date",
  "تاريخ الاستحقاق": "Due date",
  "من": "From",
  "إلى": "To",
  "كل الحالات": "All statuses",
  "الكل": "All",
  "بحث": "Search",
  "إعادة المحاولة": "Retry",
  "جاري التحميل…": "Loading…",
  "جارٍ التحميل…": "Loading…",
  "لا توجد نتائج": "No results",
  "لا توجد بيانات": "No data",
};

for (const [arabic, english] of Object.entries(sharedLabels)) translations.set(arabic, english);

export function localizeUiText(value: string): string {
  if (!i18n.language?.startsWith("en")) return value;
  const trimmed = value.trim();
  const translated = translations.get(trimmed);
  if (!translated) return value;
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  return `${leading}${translated}${trailing}`;
}

export function LocalizedText({ value }: { value: string }) {
  useTranslation();
  return localizeUiText(value);
}

export function localizeUiChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") return localizeUiText(children);
  if (Array.isArray(children)) return children.map((child, index) =>
    <React.Fragment key={index}>{localizeUiChildren(child)}</React.Fragment>,
  );
  if (React.isValidElement<{ children?: React.ReactNode }>(children) && children.props.children != null) {
    return React.cloneElement(children, {
      ...children.props,
      children: localizeUiChildren(children.props.children),
    });
  }
  return children;
}
