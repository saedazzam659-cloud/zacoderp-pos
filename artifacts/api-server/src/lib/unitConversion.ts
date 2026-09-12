import { db, itemsTable, itemUnitPricesTable, unitsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

/**
 * Unit conversion deliberately does not use JavaScript Number.  PostgreSQL
 * numeric values arrive as strings and are kept as reduced rational numbers
 * for the complete graph traversal.  Decimal output is used whenever the
 * result terminates; a non-terminating result is represented as `numerator/
 * denominator` so precision is never silently discarded.
 */
export type Rational = { numerator: bigint; denominator: bigint };

export class UnitConversionError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "UnitConversionError";
    this.code = code;
    this.details = details;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1n;
}

export function reduceRational(value: Rational): Rational {
  if (value.denominator === 0n) throw new UnitConversionError("DIVIDE_BY_ZERO", "Cannot divide by zero");
  const sign = value.denominator < 0n ? -1n : 1n;
  const denominator = value.denominator < 0n ? -value.denominator : value.denominator;
  const divisor = gcd(value.numerator, denominator);
  return {
    numerator: (value.numerator * sign) / divisor,
    denominator: denominator / divisor,
  };
}

/** Parse a decimal or the exact rational notation emitted by this module. */
export function parseExactDecimal(value: string | number | bigint): Rational {
  const raw = String(value).trim();
  if (!raw) throw new UnitConversionError("INVALID_DECIMAL", "Decimal value is required");
  if (/^[+-]?\d+\/\d+$/.test(raw)) {
    const [n, d] = raw.split("/");
    return reduceRational({ numerator: BigInt(n), denominator: BigInt(d) });
  }
  const scientific = raw.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))[eE]([+-]?\d+)$/);
  if (scientific) {
    const sign = scientific[1] === "-" ? -1n : 1n;
    const whole = scientific[2] ?? "0";
    const fraction = scientific[3] ?? scientific[4] ?? "";
    const exponent = Number(scientific[5]);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) {
      throw new UnitConversionError("INVALID_DECIMAL", `Decimal exponent is out of range: ${raw}`);
    }
    const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
    const shiftedScale = fraction.length - exponent;
    if (shiftedScale <= 0) {
      return reduceRational({ numerator: sign * BigInt(digits) * (10n ** BigInt(-shiftedScale)), denominator: 1n });
    }
    return reduceRational({ numerator: sign * BigInt(digits), denominator: 10n ** BigInt(shiftedScale) });
  }
  const match = raw.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);
  if (!match) {
    throw new UnitConversionError("INVALID_DECIMAL", `Invalid decimal value: ${raw}`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  return reduceRational({
    numerator: sign * BigInt(digits),
    denominator: 10n ** BigInt(fraction.length),
  });
}

export function addRational(a: Rational, b: Rational): Rational {
  return reduceRational({
    numerator: a.numerator * b.denominator + b.numerator * a.denominator,
    denominator: a.denominator * b.denominator,
  });
}

export function multiplyRational(a: Rational, b: Rational): Rational {
  return reduceRational({ numerator: a.numerator * b.numerator, denominator: a.denominator * b.denominator });
}

export function divideRational(a: Rational, b: Rational): Rational {
  if (b.numerator === 0n) throw new UnitConversionError("DIVIDE_BY_ZERO", "Cannot divide by zero");
  return reduceRational({ numerator: a.numerator * b.denominator, denominator: a.denominator * b.numerator });
}

function terminatingDecimal(value: Rational): string | null {
  const reduced = reduceRational(value);
  let denominator = reduced.denominator;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos++;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives++;
  }
  if (denominator !== 1n) return null;
  const places = Math.max(twos, fives);
  const scale = 10n ** BigInt(places);
  const scaled = reduced.numerator * scale / reduced.denominator;
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, "0");
  if (places === 0) return `${negative ? "-" : ""}${digits}`;
  const split = digits.length - places;
  const whole = digits.slice(0, split) || "0";
  const decimal = digits.slice(split).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${decimal ? `.${decimal}` : ""}`;
}

/** Canonical exact string representation of a rational value. */
export function formatRational(value: Rational): string {
  const decimal = terminatingDecimal(value);
  if (decimal !== null) return decimal;
  const reduced = reduceRational(value);
  return `${reduced.numerator}/${reduced.denominator}`;
}

export function multiplyQuantity(quantity: string, factor: string): string {
  return formatRational(multiplyRational(parseExactDecimal(quantity), parseExactDecimal(factor)));
}

export function divideQuantity(quantity: string, factor: string): string {
  return formatRational(divideRational(parseExactDecimal(quantity), parseExactDecimal(factor)));
}

function compareRational(a: Rational, b: Rational): bigint {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  return left < right ? -1n : left > right ? 1n : 0n;
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder < 0n ? quotient - 1n : quotient;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder > 0n ? quotient + 1n : quotient;
}

/**
 * Round an exact quantity for display only. Persistence and conversion
 * results remain unrounded. Supported modes intentionally match common
 * accounting settings.
 */
export function roundQuantity(quantity: string, decimalPlaces: number, mode = "half_up"): string {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 18) {
    throw new UnitConversionError("INVALID_DECIMAL_PLACES", "decimalPlaces must be an integer from 0 to 18");
  }
  const value = parseExactDecimal(quantity);
  const scale = 10n ** BigInt(decimalPlaces);
  const scaled = divideRational(
    { numerator: value.numerator * scale, denominator: value.denominator },
    { numerator: 1n, denominator: 1n },
  );
  const floor = floorDiv(scaled.numerator, scaled.denominator);
  const ceil = ceilDiv(scaled.numerator, scaled.denominator);
  const normalizedMode = mode.trim().toLowerCase().replace(/-/g, "_");
  let rounded: bigint;
  switch (normalizedMode) {
    case "floor":
    case "down":
      rounded = floor;
      break;
    case "ceil":
    case "up":
      rounded = ceil;
      break;
    case "trunc":
    case "truncate":
      rounded = scaled.numerator / scaled.denominator;
      break;
    case "half_even":
      {
        const lowerDistance = scaled.numerator - floor * scaled.denominator;
        const upperDistance = ceil * scaled.denominator - scaled.numerator;
        if (lowerDistance < upperDistance) rounded = floor;
        else if (upperDistance < lowerDistance) rounded = ceil;
        else rounded = floor % 2n === 0n ? floor : ceil;
      }
      break;
    case "half_down":
      {
        const lowerDistance = scaled.numerator - floor * scaled.denominator;
        const upperDistance = ceil * scaled.denominator - scaled.numerator;
        if (lowerDistance < upperDistance) rounded = floor;
        else if (upperDistance < lowerDistance) rounded = ceil;
        else rounded = scaled.numerator < 0n ? ceil : floor;
      }
      break;
    case "half_up":
      {
        const lowerDistance = scaled.numerator - floor * scaled.denominator;
        const upperDistance = ceil * scaled.denominator - scaled.numerator;
        if (lowerDistance < upperDistance) rounded = floor;
        else if (upperDistance < lowerDistance) rounded = ceil;
        else rounded = scaled.numerator < 0n ? floor : ceil;
      }
      break;
    case "bankers":
      {
        const lowerDistance = scaled.numerator - floor * scaled.denominator;
        const upperDistance = ceil * scaled.denominator - scaled.numerator;
        if (lowerDistance < upperDistance) rounded = floor;
        else if (upperDistance < lowerDistance) rounded = ceil;
        else rounded = floor % 2n === 0n ? floor : ceil;
      }
      break;
    default:
      throw new UnitConversionError("INVALID_ROUNDING_MODE", `Unsupported rounding mode: ${mode}`);
  }
  const negative = rounded < 0n;
  const absolute = (negative ? -rounded : rounded).toString().padStart(decimalPlaces + 1, "0");
  if (decimalPlaces === 0) return `${negative ? "-" : ""}${absolute}`;
  const split = absolute.length - decimalPlaces;
  return `${negative ? "-" : ""}${absolute.slice(0, split)}.${absolute.slice(split)}`;
}

/**
 * Persistence boundary helper. Exact graph results can be non-terminating
 * rationals (for example 1/3), while numeric PostgreSQL columns require a
 * finite decimal. Callers storing a snapshot must make this rounding
 * explicit; this helper never changes the exact value returned by the graph.
 */
export function decimalForStorage(value: string, decimalPlaces = 18, mode = "half_up"): string {
  return roundQuantity(value, decimalPlaces, mode);
}

/** Backward-compatible descriptive alias used by movement snapshot writers. */
export const toStorageDecimal = decimalForStorage;

export interface UnitGraphRow {
  id?: number;
  unitId: number;
  referenceUnitId: number | null;
  relationFactor: string;
  conversionFactor?: string | null;
  isBase?: boolean;
  isActive?: boolean;
  legacyConversionConflict?: boolean;
}

export interface UnitGraphResolution {
  baseUnitId: number | null;
  factors: Map<number, string>;
  conflict: boolean;
}

/**
 * Validate and resolve all active directed edges. `baseUnitId` may be null
 * only for an intentionally unresolved legacy graph; callers that need a
 * conversion should reject that conflict rather than guessing a root.
 */
export function resolveUnitGraph(input: {
  baseUnitId: number | null;
  rows: UnitGraphRow[];
}): UnitGraphResolution {
  const active = input.rows.filter((row) => row.isActive !== false);
  const byUnit = new Map<number, UnitGraphRow>();
  for (const row of active) {
    if (byUnit.has(row.unitId)) {
      throw new UnitConversionError("DUPLICATE_UNIT", "Each item may have only one active row per unit");
    }
    if (row.referenceUnitId === row.unitId) {
      throw new UnitConversionError("SELF_REFERENCE", "A unit cannot reference itself");
    }
    const relation = parseExactDecimal(row.relationFactor);
    if (relation.numerator <= 0n) {
      throw new UnitConversionError("INVALID_RELATION_FACTOR", "relationFactor must be positive");
    }
    byUnit.set(row.unitId, row);
  }

  const baseUnitId = input.baseUnitId;
  if (baseUnitId === null) {
    const marked = active.filter((row) => row.isBase && row.referenceUnitId === null);
    if (marked.length !== 1) {
      throw new UnitConversionError("AMBIGUOUS_BASE", "The item does not have exactly one base unit");
    }
  }
  const root = baseUnitId ?? active.find((row) => row.isBase)?.unitId ?? null;
  if (root === null) throw new UnitConversionError("MISSING_BASE", "The item has no base unit");

  const states = new Map<number, 0 | 1 | 2>();
  const factors = new Map<number, Rational>();
  factors.set(root, { numerator: 1n, denominator: 1n });
  const visit = (unitId: number): Rational => {
    if (states.get(unitId) === 1) throw new UnitConversionError("CYCLE", "Unit references form a cycle");
    if (states.get(unitId) === 2) return factors.get(unitId)!;
    states.set(unitId, 1);
    if (unitId === root) {
      states.set(unitId, 2);
      return factors.get(unitId)!;
    }
    const row = byUnit.get(unitId);
    if (!row) throw new UnitConversionError("UNLINKED_UNIT", "Unit is not linked to this item");
    if (row.referenceUnitId === null) {
      throw new UnitConversionError("UNROOTED_UNIT", "Every non-base unit must reference another unit");
    }
    const target = row.referenceUnitId;
    if (!byUnit.has(target) && target !== root) {
      throw new UnitConversionError("UNLINKED_REFERENCE", "Reference unit is not linked to this item");
    }
    const result = multiplyRational(parseExactDecimal(row.relationFactor), visit(target));
    factors.set(unitId, result);
    states.set(unitId, 2);
    return result;
  };

  for (const row of active) {
    const resolved = visit(row.unitId);
    if (row.legacyConversionConflict) {
      throw new UnitConversionError("LEGACY_CONFLICT", "Legacy unit conversion data is ambiguous");
    }
    // A base marker on a non-root row is always stale/conflicting.
    if (row.isBase && row.unitId !== root) {
      throw new UnitConversionError("CONFLICTING_BASE", "An item may have only one base unit");
    }
    factors.set(row.unitId, resolved);
  }
  return {
    baseUnitId: root,
    factors: new Map([...factors].map(([id, factor]) => [id, formatRational(factor)])),
    conflict: false,
  };
}

export interface ResolveItemUnitConversionArgs {
  companyId: number;
  itemId: number;
  unitId?: number;
  unitCode?: string;
  /**
   * Only trusted persisted callers may provide this. HTTP routes pass a factor
   * from an existing/source document row after resolving that row's unit; it
   * is never accepted directly from the request payload.
   */
  historicalFactor?: string;
  executor?: any;
}

export interface ResolvedItemUnitConversion {
  factor: string;
  baseUnitId: number | null;
  unitId: number | null;
  itemId: number;
  companyId: number;
  unitCode?: string | null;
  historical: boolean;
  legacyConflict: boolean;
  decimalPlaces?: number;
  roundingMode?: string;
}

/**
 * Resolve one item's unit to its base unit. An explicit unit never falls back
 * to the global catalog conversion factor: it must belong to the item graph
 * (with the item's base unit as the one permitted implicit root).
 */
export async function resolveItemUnitConversion(args: ResolveItemUnitConversionArgs): Promise<ResolvedItemUnitConversion> {
  const executor = args.executor ?? db;
  const [item] = await executor.select().from(itemsTable).where(
    and(eq(itemsTable.id, args.itemId), eq(itemsTable.companyId, args.companyId)),
  );
  if (!item) throw new UnitConversionError("ITEM_NOT_FOUND", "Item does not belong to this company");

  let requestedUnitId = args.unitId;
  let requestedCode: string | null = null;
  if (args.unitCode !== undefined) {
    const [catalogUnit] = await executor.select().from(unitsTable).where(
      and(eq(unitsTable.companyId, args.companyId), eq(unitsTable.code, args.unitCode)),
    );
    if (!catalogUnit) throw new UnitConversionError("UNIT_NOT_FOUND", "Unit does not belong to this company");
    requestedCode = catalogUnit.code;
    if (requestedUnitId !== undefined && requestedUnitId !== catalogUnit.id) {
      throw new UnitConversionError("UNIT_CONFLICT", "unitId and unitCode refer to different units");
    }
    requestedUnitId = catalogUnit.id;
  }
  // Explicit live requests must prove the unit belongs to the tenant before
  // they can ever be considered for an item graph. Trusted historical
  // snapshots are the sole exception: their old relation/unit may have been
  // removed after posting, and the persisted factor remains authoritative.
  if (args.unitId !== undefined && args.historicalFactor === undefined && args.unitCode === undefined) {
    const [catalogUnit] = await executor.select().from(unitsTable).where(
      and(eq(unitsTable.companyId, args.companyId), eq(unitsTable.id, args.unitId)),
    );
    if (!catalogUnit) throw new UnitConversionError("UNIT_NOT_FOUND", "Unit does not belong to this company");
  }

  // A persisted movement may carry the factor that was valid when it was
  // posted.  Once tenant and item ownership are established, that snapshot is
  // authoritative even when its old link was subsequently disabled/deleted or
  // the current graph is now conflicting. HTTP routes never pass this escape
  // hatch.
  if (args.historicalFactor !== undefined) {
    const factor = parseExactDecimal(args.historicalFactor);
    if (factor.numerator <= 0n) throw new UnitConversionError("INVALID_HISTORICAL_FACTOR", "Historical factor must be positive");
    return {
      factor: formatRational(factor),
      baseUnitId: item.unitId ?? null,
      unitId: requestedUnitId ?? item.unitId ?? null,
      itemId: args.itemId,
      companyId: args.companyId,
      unitCode: requestedCode,
      historical: true,
      legacyConflict: false,
    };
  }

  const rows = await executor.select().from(itemUnitPricesTable).where(
    and(eq(itemUnitPricesTable.itemId, args.itemId), eq(itemUnitPricesTable.companyId, args.companyId)),
  );
  const baseUnitId = item.unitId ?? null;
  const chosenId = requestedUnitId ?? baseUnitId ?? rows.find((row: UnitGraphRow) => row.isBase)?.unitId ?? null;

  if (rows.length === 0) {
    if (baseUnitId === null) {
      throw new UnitConversionError("MISSING_BASE", "The item has no base unit");
    }
    if (chosenId !== null && chosenId !== baseUnitId) {
      if (args.historicalFactor !== undefined) {
        const factor = parseExactDecimal(args.historicalFactor);
        if (factor.numerator <= 0n) throw new UnitConversionError("INVALID_HISTORICAL_FACTOR", "Historical factor must be positive");
        return { factor: formatRational(factor), baseUnitId, unitId: chosenId, itemId: args.itemId, companyId: args.companyId, historical: true, legacyConflict: false };
      }
      throw new UnitConversionError("UNLINKED_UNIT", "Explicit unit is not linked to this item");
    }
    if (chosenId === null) throw new UnitConversionError("MISSING_BASE", "The item has no base unit");
    return { factor: "1", baseUnitId, unitId: chosenId, itemId: args.itemId, companyId: args.companyId, historical: false, legacyConflict: false };
  }

  let graph: UnitGraphResolution;
  try {
    graph = resolveUnitGraph({ baseUnitId, rows });
  } catch (error) {
    if (args.historicalFactor !== undefined && error instanceof UnitConversionError && error.code === "LEGACY_CONFLICT") {
      const factor = parseExactDecimal(args.historicalFactor);
      if (factor.numerator <= 0n) throw new UnitConversionError("INVALID_HISTORICAL_FACTOR", "Historical factor must be positive");
      return { factor: formatRational(factor), baseUnitId, unitId: chosenId, itemId: args.itemId, companyId: args.companyId, historical: true, legacyConflict: true };
    }
    throw error;
  }
  if (chosenId === null) throw new UnitConversionError("MISSING_BASE", "The item has no base unit");
  const row = rows.find((candidate: UnitGraphRow) => candidate.unitId === chosenId);
  if (!row && chosenId !== graph.baseUnitId) {
    if (args.historicalFactor !== undefined) {
      const factor = parseExactDecimal(args.historicalFactor);
      if (factor.numerator <= 0n) throw new UnitConversionError("INVALID_HISTORICAL_FACTOR", "Historical factor must be positive");
      return { factor: formatRational(factor), baseUnitId: graph.baseUnitId, unitId: chosenId, itemId: args.itemId, companyId: args.companyId, historical: true, legacyConflict: false };
    }
    throw new UnitConversionError("UNLINKED_UNIT", "Explicit unit is not linked to this item");
  }
  // Existing documents carry an immutable conversion snapshot.  Validate the
  // selected unit against the current item graph above, but do not silently
  // re-price that historical row when an operator edits the catalog later.
  if (args.historicalFactor !== undefined) {
    const factor = parseExactDecimal(args.historicalFactor);
    if (factor.numerator <= 0n) throw new UnitConversionError("INVALID_HISTORICAL_FACTOR", "Historical factor must be positive");
    return {
      factor: formatRational(factor),
      baseUnitId: graph.baseUnitId,
      unitId: chosenId,
      itemId: args.itemId,
      companyId: args.companyId,
      historical: true,
      legacyConflict: graph.conflict,
      unitCode: requestedCode,
      decimalPlaces: row?.decimalPlaces ?? undefined,
      roundingMode: row?.roundingMode ?? undefined,
    };
  }
  if (row?.isActive === false) throw new UnitConversionError("INACTIVE_UNIT", "The item's unit link is inactive");
  if (row?.legacyConversionConflict) throw new UnitConversionError("LEGACY_CONFLICT", "Legacy unit conversion data is ambiguous");
  return {
    factor: graph.factors.get(chosenId) ?? "1",
    baseUnitId: graph.baseUnitId,
    unitId: chosenId,
    itemId: args.itemId,
    companyId: args.companyId,
    unitCode: requestedCode,
    historical: false,
    legacyConflict: graph.conflict,
    decimalPlaces: row?.decimalPlaces ?? undefined,
    roundingMode: row?.roundingMode ?? undefined,
  };
}

export function isPositiveExactDecimal(value: unknown): value is string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return false;
  if (String(value).includes("/")) return false;
  try {
    const parsed = parseExactDecimal(value);
    return parsed.numerator > 0n;
  } catch {
    return false;
  }
}
