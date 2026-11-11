import type { Element, Layout } from "@/pages/printDesigner/types";
import { applyPrintFieldVisibility } from "./printFieldVisibility";

export interface CustomPrintRow {
  [key: string]: string;
}

export interface CustomPrintContext {
  fields: Record<string, string>;
  rows: CustomPrintRow[];
  qrDataUrl?: string;
  showQr?: boolean;
  hiddenFields?: string[];
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cssColor(value: unknown, fallback: string): string {
  const color = String(value ?? "");
  return /^(#[0-9a-f]{3,8}|[a-z]{1,24}|rgba?\([\d.,%\s]+\))$/i.test(color) ? color : fallback;
}

function cssNumber(value: unknown, fallback: number, min = 0, max = 5000): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function cssFont(value: unknown): string {
  const font = String(value ?? "");
  const allowed = [
    "Tahoma, Arial, sans-serif",
    "'Cairo', sans-serif",
    "'Amiri', serif",
    "Arial, sans-serif",
    "'Times New Roman', serif",
    "'Courier New', monospace",
  ];
  return allowed.includes(font) ? font : allowed[0];
}

function safeImageSource(value: unknown): string {
  const src = String(value ?? "").trim();
  if (/^https?:\/\/[^\s"'<>]+$/i.test(src)) return src;
  if (/^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,[a-z0-9+/=]+$/i.test(src)) return src;
  return "";
}

function elementStyle(element: Element): string {
  const align = ["start", "end", "center", "justify"].includes(String(element.textAlign))
    ? element.textAlign
    : "start";
  const borderStyle = ["solid", "dashed", "dotted", "double"].includes(String(element.borderStyle))
    ? element.borderStyle
    : "solid";
  const styles = [
    "position:absolute",
    `left:${cssNumber(element.x, 0)}px`,
    `top:${cssNumber(element.y, 0)}px`,
    `width:${cssNumber(element.width, 1)}px`,
    `height:${cssNumber(element.height, 1)}px`,
    `font-family:${cssFont(element.fontFamily)}`,
    `font-size:${cssNumber(element.fontSize, 14, 6, 96)}px`,
    `font-weight:${cssNumber(element.fontWeight, 400, 100, 900)}`,
    `font-style:${element.fontStyle === "italic" ? "italic" : "normal"}`,
    `text-align:${align}`,
    `color:${cssColor(element.color, "#111827")}`,
    `background:${cssColor(element.background, "transparent")}`,
    `padding:${cssNumber(element.padding, 0, 0, 100)}px`,
    `opacity:${cssNumber(element.opacity, 1, 0, 1)}`,
    `z-index:${cssNumber(element.zIndex, 1, -1000, 10000)}`,
    "box-sizing:border-box",
    "overflow:hidden",
    "white-space:pre-wrap",
    "overflow-wrap:anywhere",
  ];
  const borderWidth = cssNumber(element.borderWidth, 0, 0, 24);
  if (borderWidth > 0) {
    styles.push(`border:${borderWidth}px ${borderStyle} ${cssColor(element.borderColor, "#94a3b8")}`);
  }
  const rotation = cssNumber(element.rotation, 0, -360, 360);
  if (rotation !== 0) styles.push(`transform:rotate(${rotation}deg)`);
  return styles.join(";");
}

function renderField(element: Element, context: CustomPrintContext): string {
  const fieldKey = element.fieldKey ?? "";
  const visibilityField = customFieldVisibilityKey(fieldKey);
  const printFieldAttr = visibilityField ? ` data-print-field="${visibilityField}"` : "";
  if (context.hiddenFields?.includes(fieldKey)) return "";
  if (fieldKey === "qr.zatca") {
    const src = context.showQr ? safeImageSource(context.qrDataUrl) : "";
    return src
      ? `<img${printFieldAttr} src="${escapeHtml(src)}" alt="QR" style="${elementStyle(element)};object-fit:contain" />`
      : "";
  }
  const value = context.fields[fieldKey] ?? "—";
  const label = element.text ?? "";
  const content = /\{[^{}]*\}/.test(label)
    ? label.replace(/\{[^{}]*\}/g, () => value)
    : value;
  return `<div${printFieldAttr} style="${elementStyle(element)}">${escapeHtml(content)}</div>`;
}

function customFieldVisibilityKey(fieldKey: string): string | undefined {
  if (fieldKey.startsWith("company.")) return "companyDetails";
  if (fieldKey === "quotation.number" || fieldKey === "invoice.number") return "documentNumber";
  if (fieldKey === "quotation.date" || fieldKey === "invoice.date") return "date";
  if (fieldKey === "quotation.validUntil") return "validUntil";
  if (fieldKey === "customer.name") return "partyName";
  if (fieldKey === "customer.vat") return "partyVat";
  if (fieldKey === "customer.address") return "partyAddress";
  if (fieldKey === "totals.subtotal") return "subtotal";
  if (fieldKey === "totals.discount") return "discountTotal";
  if (fieldKey === "totals.vat") return "taxTotal";
  if (fieldKey === "totals.grand") return "grandTotal";
  if (fieldKey === "totals.grandWords") return "amountInWords";
  if (fieldKey === "notes") return "notes";
  if (fieldKey === "qr.zatca") return "qr";
  return undefined;
}

function customColumnVisibilityKey(key: string): string | undefined {
  if (key === "name" || key === "itemName") return "itemName";
  if (key === "code" || key === "itemCode") return "itemCode";
  if (key === "qty" || key === "quantity") return "quantity";
  if (key === "freeQty" || key === "freeQuantity") return "freeQuantity";
  if (key === "unit") return "unit";
  if (key === "price" || key === "unitPrice") return "unitPrice";
  if (key === "discountPercent") return "discountPercent";
  if (key === "discount") return "discountAmount";
  if (key === "vat" || key === "tax") return "taxAmount";
  if (key === "taxRate") return "taxRate";
  if (key === "total" || key === "lineTotal") return "lineTotal";
  if (key === "description") return "description";
  if (key === "account") return "account";
  return undefined;
}

function renderTable(element: Element, context: CustomPrintContext): string {
  const spec = element.tableSpec;
  if (!spec?.columns?.length) return "";
  const border = `${cssNumber(spec.borderWidth, 1, 0, 12)}px solid ${cssColor(spec.borderColor, "#e5e7eb")}`;
  const headers = spec.columns.map(column => {
    const visibilityField = customColumnVisibilityKey(column.key);
    const attr = visibilityField ? ` data-print-column="${visibilityField}"` : "";
    return `<th${attr} style="background:${cssColor(spec.headerBg, "#1f2937")};color:${cssColor(spec.headerColor, "#fff")};border:${border};padding:5px;text-align:${["start", "end", "center"].includes(String(column.align)) ? column.align : "start"};width:${cssNumber(column.width, 80, 16, 1000)}px">${escapeHtml(column.label)}</th>`;
  }).join("");
  const rows = context.rows.length > 0
    ? context.rows
    : [{ no: "", name: "", qty: "", unit: "", price: "", discount: "", vat: "", total: "" }];
  const body = rows.map((row, rowIndex) => `<tr style="background:${rowIndex % 2 === 0 ? cssColor(spec.rowBg, "#fff") : cssColor(spec.altRowBg, "#f9fafb")}">${
    spec.columns.map(column => {
      const visibilityField = customColumnVisibilityKey(column.key);
      const attr = visibilityField ? ` data-print-column="${visibilityField}"` : "";
      return `<td${attr} style="border:${border};padding:5px;text-align:${["start", "end", "center"].includes(String(column.align)) ? column.align : "start"}">${escapeHtml(row[column.key] ?? "—")}</td>`;
    }).join("")
  }</tr>`).join("");
  return `<table style="${elementStyle(element)};border-collapse:collapse;table-layout:fixed"><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderElement(element: Element, context: CustomPrintContext): string {
  if (element.type === "field") return renderField(element, context);
  if (element.type === "text") return `<div style="${elementStyle(element)}">${escapeHtml(element.text)}</div>`;
  if (element.type === "image") {
    const src = safeImageSource(element.src);
    return src ? `<img src="${escapeHtml(src)}" alt="" style="${elementStyle(element)};object-fit:contain" />` : "";
  }
  if (element.type === "table") return renderTable(element, context);
  if (element.type === "line" || element.type === "rect") {
    return `<div style="${elementStyle(element)}"></div>`;
  }
  if (element.type === "container") {
    const title = element.text ? `<span>${escapeHtml(element.text)}</span>` : "";
    return `<div style="${elementStyle(element)};border:${cssNumber(element.borderWidth, 1, 0, 24)}px dashed ${cssColor(element.borderColor, "#94a3b8")}">${title}</div>`;
  }
  return "";
}

export function renderQuotationCustomLayoutHtml(
  layout: Layout,
  context: CustomPrintContext,
  page: { widthMm: number; heightMm: number; name: string },
): string {
  const widthMm = cssNumber(page.widthMm, 210, 40, 1000);
  const heightMm = cssNumber(page.heightMm, 297, 60, 2000);
  const background = cssColor(layout.pageBackground, "#ffffff");
  const elements = Array.isArray(layout.elements) ? layout.elements : [];
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${escapeHtml(page.name)}</title><style>
    @page{size:${widthMm}mm ${heightMm}mm;margin:0}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#fff;color:#111827;font-family:Tahoma,Arial,sans-serif}
    body{direction:rtl}
    .custom-print-page{position:relative;width:${widthMm}mm;height:${heightMm}mm;overflow:hidden;background:${background};margin:0 auto}
    @media screen{body{padding:18px;background:#edf1f5}.custom-print-page{box-shadow:0 14px 48px rgba(15,23,42,.16)}}
    @media print{html,body{width:${widthMm}mm;height:${heightMm}mm;background:#fff}.custom-print-page{box-shadow:none}}
  </style></head><body><main class="custom-print-page">${elements.map(el => renderElement(el, context)).join("")}</main></body></html>`;
}

function cssLengthToMm(value: string | undefined): number {
  const match = value?.trim().match(/^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|px)?$/i);
  if (!match) return 0;
  const number = Number(match[1]);
  const unit = (match[2] ?? "mm").toLowerCase();
  const factor = unit === "cm" ? 10 : unit === "in" ? 25.4 : unit === "pt" ? 25.4 / 72 : unit === "px" ? 25.4 / 96 : 1;
  return Math.max(0, number * factor);
}

function nativePageOffsetsMm(nativeHtml: string): { top: number; right: number; bottom: number; left: number } {
  const rule = nativeHtml.match(/@page\s*{([^}]*)}/i)?.[1] ?? "";
  const value = rule.match(/\bmargin\s*:\s*([^;]+)/i)?.[1]?.trim();
  if (!value) return { top: 0, right: 0, bottom: 0, left: 0 };
  const values = value.split(/\s+/).slice(0, 4).map(cssLengthToMm);
  if (values.length === 1) return { top: values[0], right: values[0], bottom: values[0], left: values[0] };
  if (values.length === 2) return { top: values[0], right: values[1], bottom: values[0], left: values[1] };
  if (values.length === 3) return { top: values[0], right: values[1], bottom: values[2], left: values[1] };
  return { top: values[0] ?? 0, right: values[1] ?? 0, bottom: values[2] ?? 0, left: values[3] ?? 0 };
}

/**
 * Adds editable designer elements over a native quotation renderer without
 * replacing or approximating the built-in template itself.
 */
export function composeQuotationBaseWithCustomLayout(
  nativeHtml: string,
  layout: Layout,
  context: CustomPrintContext,
  page: { widthMm: number; heightMm: number; name: string },
): string {
  const widthMm = cssNumber(page.widthMm, 210, 40, 1000);
  const heightMm = cssNumber(page.heightMm, 297, 60, 2000);
  const offsets = nativePageOffsetsMm(nativeHtml);
  const hiddenBaseFields = Array.isArray(layout.hiddenBaseFields)
    ? layout.hiddenBaseFields.filter(field => typeof field === "string" && field.length > 0)
    : [];
  const nativeTemplateHtml = hiddenBaseFields.length > 0
    ? applyPrintFieldVisibility(nativeHtml, "sales_quotation", {
        sales_quotation: Object.fromEntries(hiddenBaseFields.map(field => [field, false])),
      })
    : nativeHtml;
  const elements = (Array.isArray(layout.elements) ? layout.elements : [])
    .map(element => renderElement(element, context))
    .join("");
  const overlay = `<div aria-hidden="true" style="position:absolute;top:-${offsets.top}mm;left:-${offsets.left}mm;width:${widthMm}mm;height:${heightMm}mm;overflow:hidden;background:transparent;z-index:2147483647;pointer-events:none;margin:0;padding:0;box-sizing:border-box">${elements}</div>`;
  const bodyClose = /<\/body\s*>/i;
  return bodyClose.test(nativeTemplateHtml)
    ? nativeTemplateHtml.replace(bodyClose, `${overlay}</body>`)
    : `${nativeTemplateHtml}${overlay}`;
}
