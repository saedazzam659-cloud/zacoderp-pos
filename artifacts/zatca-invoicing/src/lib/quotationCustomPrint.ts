import type { Element, Layout } from "@/pages/printDesigner/types";

export interface CustomPrintRow {
  [key: string]: string;
}

export interface CustomPrintContext {
  fields: Record<string, string>;
  rows: CustomPrintRow[];
  qrDataUrl?: string;
  showQr?: boolean;
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
  if (fieldKey === "qr.zatca") {
    const src = context.showQr ? safeImageSource(context.qrDataUrl) : "";
    return src
      ? `<img src="${escapeHtml(src)}" alt="QR" style="${elementStyle(element)};object-fit:contain" />`
      : "";
  }
  const value = context.fields[fieldKey] ?? "—";
  const label = element.text ?? "";
  const content = /\{[^{}]*\}/.test(label)
    ? label.replace(/\{[^{}]*\}/g, () => value)
    : value;
  return `<div style="${elementStyle(element)}">${escapeHtml(content)}</div>`;
}

function renderTable(element: Element, context: CustomPrintContext): string {
  const spec = element.tableSpec;
  if (!spec?.columns?.length) return "";
  const border = `${cssNumber(spec.borderWidth, 1, 0, 12)}px solid ${cssColor(spec.borderColor, "#e5e7eb")}`;
  const headers = spec.columns.map(column =>
    `<th style="background:${cssColor(spec.headerBg, "#1f2937")};color:${cssColor(spec.headerColor, "#fff")};border:${border};padding:5px;text-align:${["start", "end", "center"].includes(String(column.align)) ? column.align : "start"};width:${cssNumber(column.width, 80, 16, 1000)}px">${escapeHtml(column.label)}</th>`,
  ).join("");
  const rows = context.rows.length > 0
    ? context.rows
    : [{ no: "", name: "", qty: "", unit: "", price: "", discount: "", vat: "", total: "" }];
  const body = rows.map((row, rowIndex) => `<tr style="background:${rowIndex % 2 === 0 ? cssColor(spec.rowBg, "#fff") : cssColor(spec.altRowBg, "#f9fafb")}">${
    spec.columns.map(column =>
      `<td style="border:${border};padding:5px;text-align:${["start", "end", "center"].includes(String(column.align)) ? column.align : "start"}">${escapeHtml(row[column.key] ?? "—")}</td>`,
    ).join("")
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
