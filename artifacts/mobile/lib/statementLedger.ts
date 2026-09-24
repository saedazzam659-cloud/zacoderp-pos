/** Preserve API transaction order: document IDs are not unique across types. */
export function statementBalances(
  opening: number,
  lines: ReadonlyArray<{ debit: number; credit: number }>,
): number[] {
  let balance = opening;
  return lines.map(line => {
    balance += Number(line.debit || 0) - Number(line.credit || 0);
    return balance;
  });
}

export function statementExclusion(data: {
  excluded?: boolean;
  reason?: string;
  message?: string;
} | null | undefined): string | null {
  if (!data?.excluded) return null;
  return data.message || (data.reason === 'display_only'
    ? 'هذا العميل مُعلَّم «للعرض فقط» — أرصدته لا تظهر في كشوفات الحسابات.'
    : 'هذا العميل مستبعد من كشوفات الحسابات.');
}