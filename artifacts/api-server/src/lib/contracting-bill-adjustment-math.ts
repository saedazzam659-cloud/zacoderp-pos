/**
 * Exact-cent settlement math shared by detail summaries and reports.
 *
 * Retention is already included in the persisted bill net amount. Advance and
 * settlement rows belong to their dedicated accounting flows and therefore
 * must not be subtracted again here. Only ordinary detail deductions and
 * penalties alter this settlement adjustment.
 */

export type SignedAdjustmentRow = {
  amount: number | string | null | undefined;
  kind?: string | null;
};

export type SignedContractingBillNetInput = {
  rawNetAmount: number | string | null | undefined;
  additions?: readonly SignedAdjustmentRow[];
  deductions?: readonly SignedAdjustmentRow[];
  penalties?: readonly SignedAdjustmentRow[];
};

export type SignedContractingBillNet = {
  rawNetAmount: string;
  additionsTotal: string;
  generalDeductionsTotal: string;
  penaltiesTotal: string;
  signedAdjustmentAmount: string;
  unclampedNetAmount: string;
  adjustedNetAmount: string;
};

const DEDUCTIONS_OWNED_BY_OTHER_FLOWS = new Set(["retention", "advance", "settlement"]);

/**
 * Parse a decimal monetary value to cents without going through binary
 * floating point. Values beyond two decimals are rounded half-up so callers
 * cannot create a one-cent discrepancy between preview and posting.
 */
export function exactCents(value: number | string | null | undefined): bigint {
  const raw = String(value ?? "0").trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
    throw new Error(`قيمة مالية غير صالحة: ${raw || "—"}`);
  }
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [wholePart = "0", fractionPart = ""] = unsigned.split(".");
  let cents = BigInt(wholePart || "0") * 100n;
  const fraction = `${fractionPart}00`;
  cents += BigInt(fraction.slice(0, 2) || "0");
  if (fraction.length > 2 && Number(fraction[2]) >= 5) cents += 1n;
  return negative ? -cents : cents;
}

export function formatExactCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function sumExactCents(values: readonly (number | string | null | undefined)[]): string {
  return formatExactCents(values.reduce((sum, value) => sum + exactCents(value), 0n));
}

function sumRows(rows: readonly SignedAdjustmentRow[] | undefined): bigint {
  return (rows ?? []).reduce((sum, row) => sum + exactCents(row.amount), 0n);
}

export function calculateSignedContractingBillNet(
  input: SignedContractingBillNetInput,
): SignedContractingBillNet {
  const rawNet = exactCents(input.rawNetAmount);
  const additions = sumRows(input.additions);
  const generalDeductions = (input.deductions ?? [])
    .filter((row) => !DEDUCTIONS_OWNED_BY_OTHER_FLOWS.has(String(row.kind ?? "")))
    .reduce((sum, row) => sum + exactCents(row.amount), 0n);
  const penalties = sumRows(input.penalties);
  const signedAdjustment = additions - generalDeductions - penalties;
  const unclampedNet = rawNet + signedAdjustment;
  const adjustedNet = unclampedNet < 0n ? 0n : unclampedNet;
  return {
    rawNetAmount: formatExactCents(rawNet),
    additionsTotal: formatExactCents(additions),
    generalDeductionsTotal: formatExactCents(generalDeductions),
    penaltiesTotal: formatExactCents(penalties),
    signedAdjustmentAmount: formatExactCents(signedAdjustment),
    unclampedNetAmount: formatExactCents(unclampedNet),
    adjustedNetAmount: formatExactCents(adjustedNet),
  };
}