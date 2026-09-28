export const IC_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export function internalControlAllowed(user: any, key = "internal_control", action = "view"): boolean {
  if (user?.companyMenuPermissions?.internal_control !== true) return false;
  if (user.role === "admin" && user.permissions?.internal_control?.view === false) return false;
  if (user.role === "admin" || user.role === "superadmin") return true;
  return user.permissions?.internal_control?.view === true && user.permissions?.[key]?.[action] === true;
}
export function internalControlBranchAllowed(user: any, branchId: number | null): boolean {
  return user?.viewAllBranches === true || (branchId != null && (user?.branchIds ?? []).includes(branchId));
}
// Only routes implemented by the ERP. Collection links intentionally do not
// invent an id query parameter that their destination would ignore.
export function internalControlDocumentUrl(source: string, id: unknown, projectId?: unknown): string | null {
  const valid = (v: unknown) => /^\d+$/.test(String(v)) && Number(v) > 0;
  if (!valid(id)) return null;
  const paths: Record<string, string> = {
    journal_entries: "/accounting/journals", receipt_vouchers: "/cash/receipt-vouchers",
    payment_vouchers: "/cash/payment-vouchers", sales_invoices: "/sales/invoices",
    purchase_invoices: "/purchasing/invoices",
  };
  if (paths[source]) return `${paths[source]}/${id}`;
  if (source === "contracting_projects") return `/contracting/projects/${id}`;
  if (source.startsWith("contracting_") && valid(projectId)) {
    const tab = source === "contracting_guarantees" ? "?tab=guarantees"
      : source === "contracting_progress_bills" ? "?tab=bills" : "";
    return `/contracting/projects/${projectId}${tab}`;
  }
  return ({ stock_balance: "/inventory/reports/stock-balance", stock_adjustments: "/inventory/adjustments",
    accounting_adjustments: "/accounting/adjustments" } as Record<string, string>)[source] ?? null;
}
export function internalControlEventKey(source: string, id: string | number, event = "observation"): string {
  return `${source}:${id}:${event}`;
}
export function exceedsThreshold(value: unknown, threshold: unknown): boolean {
  return threshold !== null && threshold !== undefined && Number.isFinite(Number(threshold))
    && Number.isFinite(Number(value)) && Number(value) > Number(threshold);
}
export function reviewerTransition(status: string, action: string, note?: string): string {
  if (action === "ignore" && !note?.trim()) throw new Error("سبب التجاهل مطلوب");
  if (action === "note" || action === "assign") return status;
  if (action === "reopen") {
    if (!["resolved", "ignored"].includes(status)) throw new Error("يمكن إعادة فتح الحالات المعالجة أو المتجاهلة فقط");
    return "open";
  }
  if (["resolved", "ignored"].includes(status)) throw new Error("أعد فتح الحالة أولاً");
  if (action === "review") return "in_review";
  if (action === "resolve") return "resolved";
  if (action === "ignore") return "ignored";
  throw new Error("إجراء غير صالح");
}