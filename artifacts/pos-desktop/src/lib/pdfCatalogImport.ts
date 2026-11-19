/**
 * Reads the repeated catalogue layout used by the BELLA CITY pipe price list.
 * PDF.js exposes positioned text runs rather than a table, so this module
 * detects each table's code/size/price columns and joins its product heading
 * to every row. It processes one page at a time; callers can discard the runs
 * immediately after calling extractPdfCatalogPage.
 */
export interface PdfCatalogTextRun {
  str: string;
  x: number;
  y: number;
  width?: number;
}

export interface PdfCatalogItem {
  nameAr: string;
  code: string;
  salePrice: string;
  size: string;
  unit: "متر";
}

interface TextLine {
  y: number;
  runs: PdfCatalogTextRun[];
}

interface TableColumns {
  lineIndex: number;
  codeX: number;
  sizeX: number;
  priceX: number;
  centerX: number;
}

export interface PdfCatalogPageResult {
  items: PdfCatalogItem[];
  productTitle?: string;
  detectedBrand: boolean;
}

const LINE_Y_TOLERANCE = 3.5;
const MAX_TITLE_DISTANCE = 125;
const HEADER_COLUMN_DISTANCE = 240;
const ROW_COLUMN_DISTANCE = 120;

function runCenter(run: PdfCatalogTextRun): number {
  return run.x + Math.max(0, run.width ?? 0) / 2;
}

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function headerKind(value: string): "code" | "size" | "price" | null {
  const text = normalizeLabel(value);
  if (text.includes("الكود") || text === "كود" || text.includes("itemcode") || text.includes("code") || text === "sku") return "code";
  if (text.includes("المقاس") || text.includes("القياس") || text === "مقاس" || text.includes("size") || text.includes("diameter")) return "size";
  if (text.includes("السعر") || text === "سعر" || text.includes("price")) return "price";
  return null;
}

function makeLines(runs: PdfCatalogTextRun[]): TextLine[] {
  const sorted = runs
    .filter((run) => run.str.trim())
    .sort((a, b) => (b.y - a.y) || (runCenter(a) - runCenter(b)));
  const lines: TextLine[] = [];
  for (const run of sorted) {
    const line = lines[lines.length - 1];
    if (!line || Math.abs(line.y - run.y) > LINE_Y_TOLERANCE) {
      lines.push({ y: run.y, runs: [run] });
    } else {
      line.runs.push(run);
      line.y = (line.y * (line.runs.length - 1) + run.y) / line.runs.length;
    }
  }
  return lines;
}

function findTables(line: TextLine, lineIndex: number): TableColumns[] {
  const headers = line.runs.flatMap((run) => {
    const kind = headerKind(run.str);
    return kind ? [{ kind, x: runCenter(run) }] : [];
  });
  const codeHeaders = headers.filter((header) => header.kind === "code");
  const usedPrices = new Set<number>();
  const usedSizes = new Set<number>();
  const tables: TableColumns[] = [];

  for (const code of codeHeaders) {
    const nearest = (kind: "size" | "price", used: Set<number>) => {
      let bestIndex = -1;
      let bestDistance = Infinity;
      headers.forEach((header, index) => {
        if (header.kind !== kind || used.has(index)) return;
        const distance = Math.abs(header.x - code.x);
        if (distance < bestDistance) {
          bestIndex = index;
          bestDistance = distance;
        }
      });
      if (bestIndex < 0 || bestDistance > HEADER_COLUMN_DISTANCE) return null;
      used.add(bestIndex);
      return headers[bestIndex].x;
    };

    const sizeX = nearest("size", usedSizes);
    const priceX = nearest("price", usedPrices);
    if (sizeX == null || priceX == null) continue;
    tables.push({
      lineIndex,
      codeX: code.x,
      sizeX,
      priceX,
      centerX: (code.x + sizeX + priceX) / 3,
    });
  }

  return tables;
}

function isHeaderLine(line: TextLine): boolean {
  const kinds = new Set(line.runs.map((run) => headerKind(run.str)).filter(Boolean));
  return kinds.has("code") && kinds.has("price") && kinds.has("size");
}

function isProductTitle(line: TextLine): boolean {
  const text = line.runs.map((run) => run.str).join(" ").trim();
  const normalized = normalizeLabel(text);
  if (!text || text.length > 100 || isHeaderLine(line)) return false;
  if (/bella\s*city/i.test(text) || normalized.includes("theegyptianitalian")) return false;
  if (/\d{6,}/.test(text)) return false;
  return /[\p{L}]/u.test(text);
}

function titleForTable(lines: TextLine[], table: TableColumns, previousTitle?: string): string | undefined {
  let best: { score: number; title: string } | undefined;
  const headerY = lines[table.lineIndex]?.y;
  if (headerY == null) return previousTitle;

  for (let index = table.lineIndex - 1; index >= 0; index--) {
    const line = lines[index];
    const verticalDistance = line.y - headerY;
    if (verticalDistance < 0) continue;
    if (verticalDistance > MAX_TITLE_DISTANCE) break;
    const nearbyRuns = line.runs.filter((run) => Math.abs(runCenter(run) - table.centerX) <= 180);
    if (!nearbyRuns.length || !isProductTitle({ ...line, runs: nearbyRuns })) continue;
    const centers = nearbyRuns.map(runCenter);
    const lineCenter = centers.reduce((sum, value) => sum + value, 0) / centers.length;
    const horizontalDistance = Math.abs(lineCenter - table.centerX);
    const score = verticalDistance + horizontalDistance * 0.4;
    if (!best || score < best.score) {
      best = { score, title: nearbyRuns.map((run) => run.str).join(" ").replace(/\s+/g, " ").trim() };
    }
  }

  return best?.title || previousTitle;
}

function isNumericCell(value: string): boolean {
  return /^[\s\d٠-٩۰-۹.,٫٬-]+$/.test(value.trim()) && /\d/.test(value);
}

function isItemCode(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  const digitCount = (compact.match(/[0-9٠-٩۰-۹]/g) ?? []).length;
  return digitCount >= 6 && /^[\da-z٠-٩۰-۹_-]+$/i.test(compact);
}

function nearestRun(
  runs: PdfCatalogTextRun[],
  targetX: number,
  predicate: (value: string) => boolean,
  excluded: Set<number>,
): { index: number; run: PdfCatalogTextRun } | null {
  let bestIndex = -1;
  let bestRun: PdfCatalogTextRun | null = null;
  let bestDistance = Infinity;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    if (excluded.has(index) || !predicate(run.str)) continue;
    const distance = Math.abs(runCenter(run) - targetX);
    if (distance > ROW_COLUMN_DISTANCE) continue;
    if (distance < bestDistance) {
      bestIndex = index;
      bestRun = run;
      bestDistance = distance;
    }
  }
  return bestRun ? { index: bestIndex, run: bestRun } : null;
}

function buildName(title: string, size: string, code: string): string {
  const suffix = size.trim() ? ` - مقاس ${size.trim()}` : ` - ${code.trim()}`;
  return `${title.trim()}${suffix}`;
}

/**
 * Convert one PDF page's positioned runs to catalogue rows. Repeated tables
 * side-by-side are separated by their header column positions. `previousTitle`
 * is used only when a table continues on the next page without repeating its
 * product heading.
 */
export function extractPdfCatalogPage(
  runs: PdfCatalogTextRun[],
  previousTitle?: string,
): PdfCatalogPageResult {
  const lines = makeLines(runs);
  const detectedBrand = /bella\s*city/i.test(runs.map((run) => run.str).join(" "));
  const tables = lines.flatMap((line, index) => findTables(line, index));
  const items: PdfCatalogItem[] = [];
  let productTitle = previousTitle;

  for (let tableIndex = 0; tableIndex < tables.length; tableIndex++) {
    const table = tables[tableIndex];
    const title = titleForTable(lines, table, previousTitle);
    if (title) productTitle = title;

    let endLine = lines.length;
    for (let nextIndex = tableIndex + 1; nextIndex < tables.length; nextIndex++) {
      const next = tables[nextIndex];
      if (Math.abs(next.centerX - table.centerX) < HEADER_COLUMN_DISTANCE / 2) {
        endLine = Math.min(endLine, next.lineIndex);
        break;
      }
    }

    for (let lineIndex = table.lineIndex + 1; lineIndex < endLine; lineIndex++) {
      const line = lines[lineIndex];
      const codeRuns = line.runs
        .map((run, index) => ({ run, index }))
        .filter(({ run }) => isItemCode(run.str))
        .filter(({ run }) => {
          const eligibleTables = tables.filter((candidate) => candidate.lineIndex <= lineIndex);
          const closestTable = eligibleTables.reduce((best, candidate) => {
            const distance = Math.abs(runCenter(run) - candidate.codeX);
            const bestDistance = Math.abs(runCenter(run) - best.codeX);
            return distance < bestDistance || (distance === bestDistance && candidate.lineIndex > best.lineIndex)
              ? candidate
              : best;
          }, eligibleTables[0] ?? table);
          return closestTable === table;
        });

      for (const { run: codeRun, index: codeIndex } of codeRuns) {
        const code = codeRun.str.replace(/\s+/g, "").trim();
        const excluded = new Set([codeIndex]);
        const price = nearestRun(line.runs, table.priceX, isNumericCell, excluded);
        if (!price) continue;
        excluded.add(price.index);
        const size = nearestRun(line.runs, table.sizeX, isNumericCell, excluded);
        const rawSize = size?.run.str.trim() ?? "";
        const rowTitle = title ?? previousTitle;
        if (!rowTitle) continue;
        items.push({
          nameAr: buildName(rowTitle, rawSize, code),
          code,
          salePrice: price.run.str.trim(),
          size: rawSize,
          unit: "متر",
        });
      }
    }
  }

  const unique = new Map<string, PdfCatalogItem>();
  for (const item of items) {
    const key = `${item.code.toLowerCase()}|${item.size}`;
    if (!unique.has(key)) unique.set(key, item);
  }

  return { items: [...unique.values()], productTitle, detectedBrand };
}

/** Convert extracted PDF catalogue rows into the normal importer grid. */
export function pdfCatalogItemsToGrid(items: PdfCatalogItem[]): string[][] {
  return [
    ["اسم الصنف", "الكود", "سعر البيع", "وحدة القياس"],
    ...items.map((item) => [item.nameAr, item.code, item.salePrice, item.unit]),
  ];
}

/** Best-effort normalization for OCR grids from scanned PDF pages. */
export function extractPdfCatalogFromGrid(grid: string[][]): PdfCatalogPageResult {
  const tables: Array<TableColumns & { sizeColumn: number; priceColumn: number; codeColumn: number }> = [];
  const items: PdfCatalogItem[] = [];
  let productTitle: string | undefined;

  for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
    const row = grid[rowIndex] ?? [];
    const headers = row.flatMap((cell, index) => {
      const kind = headerKind(cell);
      return kind ? [{ kind, index }] : [];
    });
    const codeHeaders = headers.filter((header) => header.kind === "code");
    const usedPrices = new Set<number>();
    const usedSizes = new Set<number>();

    const newTables = codeHeaders.flatMap((code) => {
      const closest = (kind: "price" | "size", used: Set<number>) => {
        const choices = headers.filter((header) => header.kind === kind && !used.has(header.index));
        choices.sort((a, b) => Math.abs(a.index - code.index) - Math.abs(b.index - code.index));
        const pick = choices[0];
        if (!pick) return null;
        used.add(pick.index);
        return pick.index;
      };
      const sizeColumn = closest("size", usedSizes);
      const priceColumn = closest("price", usedPrices);
      if (sizeColumn == null || priceColumn == null) return [];
      return [{
        lineIndex: rowIndex,
        codeX: code.index,
        sizeX: sizeColumn,
        priceX: priceColumn,
        centerX: (code.index + sizeColumn + priceColumn) / 3,
        codeColumn: code.index,
        sizeColumn,
        priceColumn,
      }];
    });
    tables.push(...newTables);
  }

  const titleBefore = (header: TableColumns, headerRowIndex: number): string | undefined => {
    for (let rowIndex = headerRowIndex - 1; rowIndex >= Math.max(0, headerRowIndex - 8); rowIndex--) {
      const row = grid[rowIndex] ?? [];
      const candidates = row.flatMap((cell, index) => {
        const value = cell.trim();
        if (!value || !/[\p{L}]/u.test(value) || headerKind(value) || /bella\s*city/i.test(value) || /\d{6,}/.test(value)) return [];
        return [{ value, index, distance: Math.abs(index - header.centerX) }];
      });
      candidates.sort((a, b) => a.distance - b.distance);
      if (candidates[0]) return candidates[0].value;
    }
    return undefined;
  };

  for (let tableIndex = 0; tableIndex < tables.length; tableIndex++) {
    const table = tables[tableIndex];
    const title = titleBefore(table, table.lineIndex);
    if (title) productTitle = title;
    let endRow = grid.length;
    for (let nextIndex = tableIndex + 1; nextIndex < tables.length; nextIndex++) {
      if (Math.abs(tables[nextIndex].centerX - table.centerX) < 2) {
        endRow = Math.min(endRow, tables[nextIndex].lineIndex);
        break;
      }
    }
    for (let rowIndex = table.lineIndex + 1; rowIndex < endRow; rowIndex++) {
      const row = grid[rowIndex] ?? [];
      const codeColumns = row.flatMap((cell, index) => isItemCode(cell) ? [{ cell, index }] : []);
      for (const codeCell of codeColumns) {
        const activeTables = tables.filter((candidate) => candidate.lineIndex <= rowIndex);
        const closestTable = activeTables.reduce((best, candidate) => {
          const distance = Math.abs(codeCell.index - candidate.codeColumn);
          const bestDistance = Math.abs(codeCell.index - best.codeColumn);
          return distance < bestDistance || (distance === bestDistance && candidate.lineIndex > best.lineIndex)
            ? candidate
            : best;
        }, activeTables[0] ?? table);
        if (closestTable !== table) continue;
        const numeric = row.flatMap((cell, index) => isNumericCell(cell) ? [{ cell, index }] : []);
        const closestValue = (column: number, excluded: Set<number>) => {
          const choices = numeric.filter((value) => !excluded.has(value.index));
          choices.sort((a, b) => Math.abs(a.index - column) - Math.abs(b.index - column));
          return choices[0] ?? null;
        };
        const excluded = new Set([codeCell.index]);
        const price = closestValue(table.priceColumn, excluded);
        if (!price) continue;
        excluded.add(price.index);
        const size = closestValue(table.sizeColumn, excluded);
        const itemTitle = title ?? productTitle;
        if (!itemTitle) continue;
        const code = codeCell.cell.replace(/\s+/g, "").trim();
        const rawSize = size?.cell.trim() ?? "";
        items.push({
          nameAr: buildName(itemTitle, rawSize, code),
          code,
          salePrice: price.cell.trim(),
          size: rawSize,
          unit: "متر",
        });
      }
    }
  }

  const unique = new Map<string, PdfCatalogItem>();
  for (const item of items) {
    const key = `${item.code.toLowerCase()}|${item.size}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return { items: [...unique.values()], productTitle, detectedBrand: gridHasBellaCity(grid) };
}

/** Detect brand text from OCR/text grids, including the BELLA CITY logo. */
export function gridHasBellaCity(grid: string[][]): boolean {
  return /bella\s*city/i.test(grid.flat().join(" "));
}

/** Returns true when a page contains item-code-looking cells not in extracted rows. */
export function hasUnparsedCatalogCodes(values: string[], items: PdfCatalogItem[]): boolean {
  const found = new Set(values.flatMap((value) => isItemCode(value) ? [value.replace(/\s+/g, "").toLowerCase()] : []));
  const parsed = new Set(items.map((item) => item.code.replace(/\s+/g, "").toLowerCase()));
  return [...found].some((code) => !parsed.has(code));
}
