type NameMasterRow = {
  id?: number | string;
  code?: unknown;
  customerCode?: unknown;
  supplierCode?: unknown;
  itemCode?: unknown;
  nameAr?: unknown;
  nameEn?: unknown;
  name?: unknown;
  partyName?: unknown;
};

/**
 * Restore spacing only when the OCR name is an exact character-for-character
 * match to one uniquely code-matched master after whitespace is removed.
 * Any other OCR difference remains visible for manual review.
 */
export function repairNameSpacingFromMaster(
  sourceName: unknown,
  sourceCode: unknown,
  rows: NameMasterRow[] | undefined,
  codeFields: Array<keyof NameMasterRow>,
): { name: string; repaired: boolean } {
  const name = String(sourceName ?? "").trim();
  const code = String(sourceCode ?? "").trim().toLocaleLowerCase();
  if (!name || !code || !rows?.length) return { name, repaired: false };

  const matches = rows.filter((row) =>
    codeFields.some((field) => String(row[field] ?? "").trim().toLocaleLowerCase() === code),
  );
  const unique = [...new Map(matches.map((row) => [row.id ?? row, row])).values()];
  if (unique.length !== 1) return { name, repaired: false };

  const masterName = String(
    unique[0].nameAr ?? unique[0].name ?? unique[0].nameEn ?? unique[0].partyName ?? "",
  ).trim();
  if (!masterName || !/\s/u.test(masterName)) return { name, repaired: false };

  const compact = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");
  if (compact(name) !== compact(masterName)) return { name, repaired: false };

  const sourceSpaces = (name.match(/\s/gu) ?? []).length;
  const masterSpaces = (masterName.match(/\s/gu) ?? []).length;
  if (sourceSpaces >= masterSpaces) return { name, repaired: false };
  return { name: masterName, repaired: true };
}
