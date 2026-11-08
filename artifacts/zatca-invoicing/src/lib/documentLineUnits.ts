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

export function defaultDocumentUnitId(
  rows: any[],
  baseUnitId: string | number | null | undefined,
): string {
  if (baseUnitId != null && baseUnitId !== "") {
    const itemBaseRow = rows.find((row: any) => String(row.unitId) === String(baseUnitId));
    if (itemBaseRow) return isActiveItemUnit(itemBaseRow) ? String(itemBaseRow.unitId) : "";
    return String(baseUnitId);
  }

  const active = activeItemUnits(rows);
  const markedBase = active.find((row: any) => row.isBase === true && row.referenceUnitId == null);
  if (markedBase) return String(markedBase.unitId);

  if (rows.length === 1 && rows[0].referenceUnitId == null && isActiveItemUnit(rows[0])) {
    return String(rows[0].unitId);
  }
  return "";
}

/**
 * Transaction forms may offer only item-owned units, plus the item's saved
 * base when older data has no explicit base row. A selected non-linked unit is
 * retained as a disabled historical choice so an unchanged old document can
 * still be saved without making that unit available for new lines.
 */
export function documentItemUnitOptions(
  rows: any[],
  baseUnitId: string | number | null | undefined,
  catalogUnits: any[],
  selectedId: string | number | null | undefined,
  preserveHistorical = true,
): any[] {
  const options = itemUnitsWithHistoricalSelection(rows, preserveHistorical ? selectedId : undefined);
  const hasOption = (id: unknown) => options.some((row: any) => String(row.unitId) === String(id));

  if (baseUnitId != null && baseUnitId !== "" && !hasOption(baseUnitId)) {
    const explicitBaseRow = rows.find((row: any) => String(row.unitId) === String(baseUnitId));
    const catalogUnit = catalogUnits.find((unit: any) => String(unit.id) === String(baseUnitId));
    if (!explicitBaseRow && catalogUnit && catalogUnit.isActive !== false) {
      options.unshift({
        unitId: Number(baseUnitId),
        conversionFactor: "1",
        isBase: true,
        isActive: true,
        unit: catalogUnit,
      });
    }
  }

  if (preserveHistorical && selectedId != null && selectedId !== "" && !hasOption(selectedId)) {
    const historicalUnit = catalogUnits.find((unit: any) => String(unit.id) === String(selectedId));
    if (historicalUnit) {
      options.push({
        unitId: Number(selectedId),
        conversionFactor: "1",
        isActive: false,
        historicalOnly: true,
        unit: historicalUnit,
      });
    }
  }
  return options;
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
 * A persisted line id is valid only while the line still refers to its original
 * item. Selecting a different item turns the row into a replacement line.
 */
export function persistedLineIdForSelectedItem(line: any, selectedItemId: unknown): number | undefined {
  if (line?.id == null || line?.itemId == null || selectedItemId == null) return undefined;
  if (!String(line.itemId) || !String(selectedItemId) || String(line.itemId) !== String(selectedItemId)) {
    return undefined;
  }
  const id = Number(line.id);
  return Number.isInteger(id) && id > 0 ? id : undefined;
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