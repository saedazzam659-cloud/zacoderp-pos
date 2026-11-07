export const isoPayrollDate = (v: unknown) => String(v ?? "").slice(0, 10);

export function addPayrollDays(d: string, n: number) {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** Allocate by calendar days in integer cents; the final bucket receives the remainder. */
export function allocationBuckets(assignments: any[], periodStart: string, periodEnd: string, amount: number) {
  const buckets: any[] = [];
  const latest = new Map<string, any>();
  for (let date = periodStart; date <= periodEnd; date = addPayrollDays(date, 1)) {
    const active = assignments.filter((x) => isoPayrollDate(x.effectiveFrom) <= date && (!x.effectiveTo || isoPayrollDate(x.effectiveTo) >= date));
    const shares = new Map<string, { projectId: number | null; costCenterId: number | null; salaryAllocationPct: number; provisionAllocationPct: number }>();
    const rows = active.length ? active : [{ projectId: null, costCenterId: null, salaryAllocationPct: 100, provisionAllocationPct: 100 }];
    const salaryTotal = rows.reduce((sum, x) => sum + Number(x.salaryAllocationPct ?? 100), 0);
    const provisionTotal = rows.reduce((sum, x) => sum + Number(x.provisionAllocationPct ?? x.salaryAllocationPct ?? 100), 0);
    if (Math.abs(salaryTotal - 100) > 0.001 || Math.abs(provisionTotal - 100) > 0.001) {
      throw new Error(`نسب توزيع الموظف لا تساوي 100% في ${date}`);
    }
    for (const a of rows) {
      const projectId = a.projectId ?? null, costCenterId = a.costCenterId ?? null;
      const key = `${projectId ?? ""}:${costCenterId ?? ""}`;
      const share = shares.get(key) ?? { projectId, costCenterId, salaryAllocationPct: 0, provisionAllocationPct: 0 };
      share.salaryAllocationPct += Number(a.salaryAllocationPct ?? 100);
      share.provisionAllocationPct += Number(a.provisionAllocationPct ?? a.salaryAllocationPct ?? 100);
      shares.set(key, share);
    }
    for (const share of shares.values()) {
      const key = `${share.projectId ?? ""}:${share.costCenterId ?? ""}:${share.salaryAllocationPct}:${share.provisionAllocationPct}`;
      let bucket = latest.get(key);
      if (!bucket || addPayrollDays(bucket.periodEnd, 1) !== date) {
        bucket = { ...share, periodStart: date, periodEnd: date, days: 0 };
        buckets.push(bucket);
        latest.set(key, bucket);
      }
      bucket.days++;
      bucket.periodEnd = date;
    }
  }
  const totalCents = Math.round(amount * 100);
  const weights = buckets.map((b) => b.days * b.salaryAllocationPct);
  const totalWeight = weights.reduce((sum, x) => sum + x, 0);
  let assigned = 0;
  return buckets.map((bucket, i) => {
    const cents = i === buckets.length - 1 ? totalCents - assigned : Math.round(totalCents * weights[i] / totalWeight);
    assigned += cents;
    return { ...bucket, allocatedAmount: (cents / 100).toFixed(2) };
  });
}

/** Split any accounting component using frozen snapshot day weights in cents. */
export function allocateComponentBySnapshots(amount: number, snapshots: Array<{ days: number; costCenterId: number | null; salaryAllocationPct?: string | number; provisionAllocationPct?: string | number | null }>, basis: "salary" | "provision" = "salary") {
  const weights = snapshots.map((s) => s.days * Number(basis === "provision" ? (s.provisionAllocationPct ?? s.salaryAllocationPct ?? 100) : (s.salaryAllocationPct ?? 100)));
  const totalDays = weights.reduce((sum, x) => sum + x, 0);
  if (!snapshots.length || !totalDays) return [];
  const totalCents = Math.round(amount * 100);
  let used = 0;
  return snapshots.map((snapshot, i) => {
    const cents = i === snapshots.length - 1 ? totalCents - used : Math.round(totalCents * weights[i] / totalDays);
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