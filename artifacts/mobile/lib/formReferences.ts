// A query must not reuse another server/account's numeric company or document IDs.
export async function formScope(companyId: number, userId: number, generation: number,
  getDomain: () => Promise<string>, sessionGeneration: () => number) {
  const domain = await getDomain();
  if (sessionGeneration() !== generation) throw new Error('تغيّرت جلسة الخادم — أعد فتح النموذج');
  return [domain, companyId, userId, generation] as const;
}

export async function referenceList<T>(path: string, request: (path: string) => Promise<unknown>): Promise<T[]> {
  const data = await request(path);
  if (!Array.isArray(data)) throw new Error('استجابة بيانات غير متوقعة من الخادم — أعد المحاولة أو تواصل مع الدعم');
  return data as T[];
}

export function positiveId(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function selectedBranch(branches: any[], selected: unknown, historical?: unknown): number | null {
  return positiveId(selected) ?? positiveId(historical) ??
    positiveId((branches.find((b) => b.isDefault || b.is_default) ?? branches[0])?.id);
}

export function branchWarehouses(warehouses: any[], branchId: unknown): any[] {
  const id = positiveId(branchId);
  return id ? warehouses.filter((w) => positiveId(w.branchId ?? w.branch_id) === id) : [];
}

export function selectedWarehouse(warehouses: any[], selected: unknown): number | null {
  const id = positiveId(selected);
  if (id && warehouses.some((w) => positiveId(w.id) === id)) return id;
  return positiveId((warehouses.find((w) => w.isDefault || w.is_default) ?? warehouses[0])?.id);
}

export function requiredReference(label: string, loading: boolean, error: unknown, data: unknown): string {
  if (loading || data === undefined && !error) return `جارٍ تحميل ${label} — انتظر ثم أعد المحاولة`;
  if (error || !Array.isArray(data)) return `تعذّر تحميل ${label}: ${error instanceof Error ? error.message : 'استجابة غير متوقعة'} — أعد المحاولة`;
  return '';
}