export interface ClothingVariantIdentifierInput {
  parentItemId: number;
  parentCode: string;
  color: string;
  size: string;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function hash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (const character of value) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(7, "0");
}

function variantToken(input: ClothingVariantIdentifierInput): string {
  const pair = `${input.parentItemId}|${normalize(input.color)}|${normalize(input.size)}`;
  const reversed = [...pair].reverse().join("");
  return `${hash32(pair, 0x811c9dc5)}${hash32(reversed, 0x9e3779b9)}`;
}

function takeUnique(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(normalize(candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(normalize(candidate));
  return candidate;
}

/**
 * Build stable, collision-checked defaults for a clothing variant.
 * `usedCodes` and `usedBarcodes` must contain normalized lowercase values;
 * each chosen value is added to its set so a batch cannot generate duplicates.
 * The barcode uses Code 128 and remains an ordinary item barcode.
 */
export function generateClothingVariantIdentifiers(
  input: ClothingVariantIdentifierInput,
  usedCodes: Set<string>,
  usedBarcodes: Set<string>,
): { code: string; barcode: string } {
  const parentStem = input.parentCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "MODEL";
  const idToken = Math.max(0, Math.floor(input.parentItemId)).toString(36).toUpperCase();
  const token = variantToken(input);

  return {
    code: takeUnique(`${parentStem}-${idToken}-${token}`, usedCodes),
    barcode: takeUnique(`C${idToken}${token}`, usedBarcodes),
  };
}
