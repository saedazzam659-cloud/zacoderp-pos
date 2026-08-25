export type NumericInputValue = string | number | readonly string[] | undefined;

function isNumericValue(value: NumericInputValue, expected: number): boolean {
  if (value === expected) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed !== "" && Number(trimmed) === expected;
}

export function isZeroValue(value: NumericInputValue): boolean {
  return isNumericValue(value, 0);
}

export function isOneValue(value: NumericInputValue): boolean {
  return isNumericValue(value, 1);
}

export function shouldBlankNumericValue({
  value,
  showZeros,
  hideDefaultOne,
  focused,
  typedSinceFocus,
}: {
  value: NumericInputValue;
  showZeros: boolean;
  hideDefaultOne: boolean;
  focused: boolean;
  typedSinceFocus: boolean;
}): boolean {
  if (focused && typedSinceFocus) return false;
  return (!showZeros && isZeroValue(value)) ||
    (hideDefaultOne && isOneValue(value));
}