type QuantityLine = {
  itemId?: number | string | null;
  itemCode?: string | null;
  itemName?: string | null;
  unit?: string | null;
  unitId?: number | string | null;
  conversionFactor?: number | string | null;
  qty?: number | string | null;
  freeQty?: number | string | null;
};

export type DocumentQuantityDifference = {
  key: string;
  itemName: string;
  itemCode: string | null;
  unit: string | null;
  sourceQuantity: number;
  invoiceQuantity: number;
  difference: number;
};

function itemKey(line: QuantityLine, fallback: string) {
  if (line.itemId != null) return `item:${line.itemId}`;
  if (line.itemCode?.trim()) return `code:${line.itemCode.trim().toLocaleLowerCase()}`;
  if (line.itemName?.trim()) return `name:${line.itemName.trim().toLocaleLowerCase()}`;
  return fallback;
}

function numeric(value: number | string | null | undefined, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function compareDocumentQuantities(
  sourceLines: QuantityLine[] = [],
  invoiceLines: QuantityLine[] = [],
): DocumentQuantityDifference[] {
  const grouped = new Map<string, {
    itemName: string;
    itemCode: string | null;
    unit: string | null;
    referenceFactor: number;
    sourceBase: number;
    invoiceBase: number;
  }>();

  const addLines = (lines: QuantityLine[], side: "sourceBase" | "invoiceBase") => {
    lines.forEach((line, index) => {
      if (line.itemId == null && !line.itemCode?.trim() && !line.itemName?.trim()) return;
      const key = itemKey(line, `line:${index}`);
      const factor = numeric(line.conversionFactor, 1) || 1;
      const row = grouped.get(key) ?? {
        itemName: line.itemName?.trim() || line.itemCode?.trim() || "—",
        itemCode: line.itemCode?.trim() || null,
        unit: line.unit?.trim() || null,
        referenceFactor: factor,
        sourceBase: 0,
        invoiceBase: 0,
      };
      const quantity = numeric(line.qty) + numeric(line.freeQty);
      row[side] += quantity * factor;
      if (!row.itemCode && line.itemCode?.trim()) row.itemCode = line.itemCode.trim();
      if ((!row.itemName || row.itemName === "—") && line.itemName?.trim()) row.itemName = line.itemName.trim();
      grouped.set(key, row);
    });
  };

  addLines(sourceLines, "sourceBase");
  addLines(invoiceLines, "invoiceBase");
  return [...grouped.entries()]
    .map(([key, row]) => {
      const sourceQuantity = row.sourceBase / row.referenceFactor;
      const invoiceQuantity = row.invoiceBase / row.referenceFactor;
      const difference = invoiceQuantity - sourceQuantity;
      return { key, itemName: row.itemName, itemCode: row.itemCode, unit: row.unit, sourceQuantity, invoiceQuantity, difference };
    })
    .filter(row => Math.abs(row.difference) > 0.0001);
}
