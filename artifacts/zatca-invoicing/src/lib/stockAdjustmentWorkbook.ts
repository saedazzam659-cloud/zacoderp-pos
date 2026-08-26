import * as XLSX from "xlsx";

export const STOCK_ADJUSTMENT_HEADERS = {
  itemId: "معرّف الصنف | Item ID",
  itemCode: "كود الصنف | Item Code",
  itemName: "اسم الصنف | Item Name",
  unitId: "معرّف الوحدة | Unit ID",
  unitName: "الوحدة | Unit",
  qty: "كمية التسوية (+/-) | Adjustment Qty",
  costPrice: "سعر التكلفة | Cost Price",
  notes: "ملاحظة | Notes",
} as const;

export interface StockAdjustmentTemplateItem {
  id: number;
  code?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  unitId?: number | null;
  costPrice?: string | number | null;
}

export interface StockAdjustmentTemplateUnit {
  id: number;
  code?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
}

export interface ImportedAdjustmentLine {
  itemId: string;
  unitId: string;
  qty: string;
  costPrice: string;
  notes: string;
  conversionFactor: string;
}

export type StockAdjustmentImportIssueCode =
  | "missing_headers"
  | "unknown_item"
  | "item_identity_mismatch"
  | "duplicate_item"
  | "invalid_qty"
  | "zero_qty"
  | "invalid_cost"
  | "unknown_unit"
  | "no_adjustments";

export interface StockAdjustmentImportIssue {
  row: number;
  code: StockAdjustmentImportIssueCode;
  value?: string;
}

type RawRow = Record<string, unknown>;

const HEADER_ALIASES: Record<keyof typeof STOCK_ADJUSTMENT_HEADERS, string[]> = {
  itemId: [STOCK_ADJUSTMENT_HEADERS.itemId, "itemId", "Item ID", "معرّف الصنف"],
  itemCode: [STOCK_ADJUSTMENT_HEADERS.itemCode, "itemCode", "Item Code", "كود الصنف"],
  itemName: [STOCK_ADJUSTMENT_HEADERS.itemName, "itemName", "Item Name", "اسم الصنف"],
  unitId: [STOCK_ADJUSTMENT_HEADERS.unitId, "unitId", "Unit ID", "معرّف الوحدة"],
  unitName: [STOCK_ADJUSTMENT_HEADERS.unitName, "unitName", "Unit", "الوحدة"],
  qty: [STOCK_ADJUSTMENT_HEADERS.qty, "qty", "Adjustment Qty", "Quantity", "كمية التسوية", "الكمية"],
  costPrice: [STOCK_ADJUSTMENT_HEADERS.costPrice, "costPrice", "Cost Price", "سعر التكلفة"],
  notes: [STOCK_ADJUSTMENT_HEADERS.notes, "notes", "Notes", "ملاحظة", "ملاحظات"],
};

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

export function normalizeWorkbookNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const normalized = text(value)
    .replace(/[−–—]/g, "-")
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٬,\s]/g, "")
    .replace(/٫/g, ".");
  return normalized === "" ? Number.NaN : Number(normalized);
}

function readField(row: RawRow, field: keyof typeof STOCK_ADJUSTMENT_HEADERS): unknown {
  for (const alias of HEADER_ALIASES[field]) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) return row[alias];
  }
  return undefined;
}

function hasHeader(rows: RawRow[], field: keyof typeof STOCK_ADJUSTMENT_HEADERS): boolean {
  return rows.some(row => HEADER_ALIASES[field].some(alias => Object.prototype.hasOwnProperty.call(row, alias)));
}

export function buildStockAdjustmentWorkbook(
  items: StockAdjustmentTemplateItem[],
  units: StockAdjustmentTemplateUnit[],
): XLSX.WorkBook {
  const unitMap = new Map(units.map(unit => [Number(unit.id), unit]));
  const data = items.map(item => {
    const unit = item.unitId ? unitMap.get(Number(item.unitId)) : undefined;
    return {
      [STOCK_ADJUSTMENT_HEADERS.itemId]: item.id,
      [STOCK_ADJUSTMENT_HEADERS.itemCode]: item.code ?? "",
      [STOCK_ADJUSTMENT_HEADERS.itemName]: item.nameAr || item.nameEn || "",
      [STOCK_ADJUSTMENT_HEADERS.unitId]: item.unitId ?? "",
      [STOCK_ADJUSTMENT_HEADERS.unitName]: unit?.nameAr || unit?.nameEn || unit?.code || "",
      [STOCK_ADJUSTMENT_HEADERS.qty]: 0,
      [STOCK_ADJUSTMENT_HEADERS.costPrice]: Number(item.costPrice ?? 0),
      [STOCK_ADJUSTMENT_HEADERS.notes]: "",
    };
  });
  const ws = XLSX.utils.json_to_sheet(data, { header: Object.values(STOCK_ADJUSTMENT_HEADERS) });
  ws["!cols"] = [
    { hidden: true },
    { wch: 18 },
    { wch: 34 },
    { hidden: true },
    { wch: 18 },
    { wch: 22 },
    { wch: 18 },
    { wch: 30 },
  ];
  ws["!autofilter"] = { ref: ws["!ref"] || "A1:H1" };
  const instructions = XLSX.utils.aoa_to_sheet([
    ["تعليمات قالب التسوية المخزنية | Stock Adjustment Template Instructions"],
    ["أدخل فقط كمية التسوية: موجب للزيادة وسالب للنقص. الصفوف ذات الكمية صفر لن تُستورد."],
    ["Enter only the adjustment quantity: positive to increase and negative to decrease. Zero rows are ignored."],
    ["لا تحذف أو تعدّل معرّف الصنف المخفي. يمكنك تعديل التكلفة والملاحظة قبل رفع الملف."],
    ["Do not delete or change the hidden Item ID. Cost and notes may be edited before upload."],
  ]);
  instructions["!cols"] = [{ wch: 110 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "التسوية | Adjustment");
  XLSX.utils.book_append_sheet(wb, instructions, "تعليمات | Instructions");
  return wb;
}

export function parseStockAdjustmentRows(
  rows: RawRow[],
  items: StockAdjustmentTemplateItem[],
  units: StockAdjustmentTemplateUnit[],
): { lines: ImportedAdjustmentLine[]; issues: StockAdjustmentImportIssue[] } {
  if (!hasHeader(rows, "qty") || (!hasHeader(rows, "itemId") && !hasHeader(rows, "itemCode"))) {
    return { lines: [], issues: [{ row: 1, code: "missing_headers" }] };
  }

  const itemById = new Map(items.map(item => [String(item.id), item]));
  const itemByCode = new Map(items.filter(item => text(item.code)).map(item => [text(item.code).toLowerCase(), item]));
  const unitById = new Map(units.map(unit => [String(unit.id), unit]));
  const unitByCodeOrName = new Map<string, StockAdjustmentTemplateUnit>();
  for (const unit of units) {
    for (const key of [unit.code, unit.nameAr, unit.nameEn]) {
      if (text(key)) unitByCodeOrName.set(text(key).toLowerCase(), unit);
    }
  }

  const lines: ImportedAdjustmentLine[] = [];
  const issues: StockAdjustmentImportIssue[] = [];
  const seenItems = new Set<number>();

  rows.forEach((row, index) => {
    const excelRow = index + 2;
    const qtyRaw = readField(row, "qty");
    const qtyText = text(qtyRaw);
    const idText = text(readField(row, "itemId"));
    const codeText = text(readField(row, "itemCode"));
    const costText = text(readField(row, "costPrice"));
    const notes = text(readField(row, "notes"));
    if (!idText && !codeText && !qtyText && !costText && !notes) return;

    const qty = normalizeWorkbookNumber(qtyRaw);
    // The generated template intentionally contains every stock item with qty=0.
    if (Number.isFinite(qty) && qty === 0) return;
    if (!qtyText || !Number.isFinite(qty)) {
      issues.push({ row: excelRow, code: "invalid_qty", value: qtyText });
      return;
    }

    const item = idText ? itemById.get(idText) : itemByCode.get(codeText.toLowerCase());
    if (!item) {
      issues.push({ row: excelRow, code: "unknown_item", value: codeText || idText });
      return;
    }
    if (codeText && text(item.code).toLowerCase() !== codeText.toLowerCase()) {
      issues.push({ row: excelRow, code: "item_identity_mismatch", value: codeText });
      return;
    }
    if (seenItems.has(item.id)) {
      issues.push({ row: excelRow, code: "duplicate_item", value: item.code || String(item.id) });
      return;
    }

    const cost = normalizeWorkbookNumber(readField(row, "costPrice"));
    if (!Number.isFinite(cost) || cost < 0) {
      issues.push({ row: excelRow, code: "invalid_cost", value: costText });
      return;
    }

    const unitIdText = text(readField(row, "unitId"));
    const unitNameText = text(readField(row, "unitName"));
    const unit = unitIdText
      ? unitById.get(unitIdText)
      : (unitNameText ? unitByCodeOrName.get(unitNameText.toLowerCase()) : undefined);
    if ((unitIdText || unitNameText) && !unit) {
      issues.push({ row: excelRow, code: "unknown_unit", value: unitNameText || unitIdText });
      return;
    }

    seenItems.add(item.id);
    lines.push({
      itemId: String(item.id),
      unitId: unit ? String(unit.id) : (item.unitId ? String(item.unitId) : ""),
      qty: String(qty),
      costPrice: String(cost),
      notes,
      conversionFactor: "1",
    });
  });

  if (!issues.length && !lines.length) issues.push({ row: 0, code: "no_adjustments" });
  return { lines, issues };
}

export function readStockAdjustmentWorkbook(
  data: ArrayBuffer,
  items: StockAdjustmentTemplateItem[],
  units: StockAdjustmentTemplateUnit[],
): { lines: ImportedAdjustmentLine[]; issues: StockAdjustmentImportIssue[] } {
  const wb = XLSX.read(data, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { lines: [], issues: [{ row: 1, code: "missing_headers" }] };
  const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: "", raw: true });
  return parseStockAdjustmentRows(rows, items, units);
}