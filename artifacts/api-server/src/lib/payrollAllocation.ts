export const isoPayrollDate = (v: unknown) => String(v ?? "").slice(0, 10);

export function addPayrollDays(d: string, n: number) {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** Allocate by calendar days in integer cents; the final bucket receives the remainder. */
export function allocationBuckets(assignments: any[], periodStart: string, periodEnd: string, amount: number) {
  const days: Array<{ date: string; projectId: number | null; costCenterId: number | null }> = [];
  for (let date = periodStart; date <= periodEnd; date = addPayrollDays(date, 1)) {
    const a = assignments.find((x) => isoPayrollDate(x.effectiveFrom) <= date && (!x.effectiveTo || isoPayrollDate(x.effectiveTo) >= date));
    days.push({ date, projectId: a?.projectId ?? null, costCenterId: a?.costCenterId ?? null });
  }
  const buckets: any[] = [];
  for (const day of days) {
    const last = buckets[buckets.length - 1];
    if (last && last.projectId === day.projectId && last.costCenterId === day.costCenterId) {
      last.days++; last.periodEnd = day.date;
    } else buckets.push({ ...day, periodStart: day.date, periodEnd: day.date, days: 1 });
  }
  const totalCents = Math.round(amount * 100);
  let assigned = 0;
  return buckets.map((bucket, i) => {
    const cents = i === buckets.length - 1 ? totalCents - assigned : Math.round(totalCents * bucket.days / days.length);
    assigned += cents;
    return { ...bucket, allocatedAmount: (cents / 100).toFixed(2) };
  });
}

/** Split any accounting component using frozen snapshot day weights in cents. */
export function allocateComponentBySnapshots(amount: number, snapshots: Array<{ days: number; costCenterId: number | null }>) {
  const totalDays = snapshots.reduce((sum, s) => sum + s.days, 0);
  if (!snapshots.length || !totalDays) return [];
  const totalCents = Math.round(amount * 100);
  let used = 0;
  return snapshots.map((snapshot, i) => {
    const cents = i === snapshots.length - 1 ? totalCents - used : Math.round(totalCents * snapshot.days / totalDays);
    used += cents;
    return { costCenterId: snapshot.costCenterId, amount: cents / 100 };
  });
}

export function assignmentsOverlap(a: { effectiveFrom: unknown; effectiveTo?: unknown }, b: { effectiveFrom: unknown; effectiveTo?: unknown }) {
  return isoPayrollDate(a.effectiveFrom) <= (b.effectiveTo ? isoPayrollDate(b.effectiveTo) : "9999-12-31")
    && isoPayrollDate(b.effectiveFrom) <= (a.effectiveTo ? isoPayrollDate(a.effectiveTo) : "9999-12-31");
}

/** Whether deleting an assignment would erase context already frozen in payroll. */
export function assignmentRepresentedBySnapshot(assignment: any, snapshot: any) {
  return snapshot.projectId === assignment.projectId && snapshot.costCenterId === assignment.costCenterId
    && isoPayrollDate(snapshot.periodStart) <= (assignment.effectiveTo ? isoPayrollDate(assignment.effectiveTo) : "9999-12-31")
    && isoPayrollDate(snapshot.periodEnd) >= isoPayrollDate(assignment.effectiveFrom);
}

/** Closing an open assignment is safe only after every frozen payroll period. */
export function assignmentCloseConflictsWithSnapshot(assignment: any, newFrom: string, snapshots: any[]) {
  return snapshots.some(snapshot =>
    isoPayrollDate(snapshot.periodEnd) >= isoPayrollDate(newFrom)
    && assignmentRepresentedBySnapshot(assignment, snapshot));
}