export function printAuditPageIfNothingSelected(
  selectedCount: number,
  printPage: () => void,
): boolean {
  if (selectedCount !== 0) return false;
  printPage();
  return true;
}