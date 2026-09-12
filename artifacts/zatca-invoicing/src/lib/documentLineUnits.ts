/**
 * Transaction forms may display a historical item-unit relation that has since
 * been disabled.  New choices must exclude it, while an unchanged loaded line
 * still needs an option so Radix Select can render its current value.
 */
export function isActiveItemUnit(row: any): boolean {
  return row?.isActive !== false && row?.unit?.isActive !== false;
}

export function activeItemUnits(rows: any[]): any[] {
  return rows.filter(isActiveItemUnit);
}

export function itemUnitsWithHistoricalSelection(rows: any[], selectedId: string | number | null | undefined): any[] {
  const active = activeItemUnits(rows);
  if (selectedId == null || selectedId === "") return active;
  const selected = rows.find((row: any) => String(row?.unitId) === String(selectedId));
  if (selected && !isActiveItemUnit(selected)) return [...active, selected];
  return active;
}

export function isActiveCatalogUnit(unit: any): boolean {
  return unit?.isActive !== false;
}

export function catalogUnitsWithHistoricalSelection(rows: any[], selectedId: string | number | null | undefined): any[] {
  const active = rows.filter(isActiveCatalogUnit);
  if (selectedId == null || selectedId === "") return active;
  const selected = rows.find((row: any) => String(row?.id) === String(selectedId));
  if (selected && !isActiveCatalogUnit(selected)) return [...active, selected];
  return active;
}

/**
 * UI row keys must never be sent as persisted document-line ids.  Keep the
 * numeric DB id (when present) and drop only UI metadata.
 */
export function serializeDocumentLine(line: any): any {
  const { _id, _pricingNote, ...payload } = line;
  return payload;
}

/**
 * Return/conversion payloads identify their source by the real source-line id.
 * Existing return rows do not persist that relationship, so match the source
 * row by the stable item/unit snapshot and consume each candidate once.
 */
export function sourceLineIdForLine(
  line: any,
  sourceLines: any[],
  usedSourceIds: Set<number> = new Set<number>(),
): number | undefined {
  const candidates = sourceLines.filter((source: any) =>
    source?.id != null
    && !usedSourceIds.has(Number(source.id))
    && String(source.itemId ?? "") === String(line.itemId ?? ""),
  );
  const sameUnit = candidates.find((source: any) =>
    (line.unitId == null || line.unitId === "" || String(source.unitId ?? "") === String(line.unitId))
    && (line.conversionFactor == null || line.conversionFactor === "" ||
      String(source.conversionFactor ?? "1") === String(line.conversionFactor)),
  );
  const source = sameUnit ?? candidates[0];
  if (!source?.id) return undefined;
  const id = Number(source.id);
  usedSourceIds.add(id);
  return id;
}