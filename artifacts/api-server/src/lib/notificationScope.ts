import { and, inArray, isNull, or, sql } from "drizzle-orm";
import { notificationsTable } from "@workspace/db";
import { canAccessModule } from "../middleware/permissions.js";

// Deliberately explicit: notification producers must opt into a known module
// key, and an unknown key is hidden from ordinary users rather than becoming
// an accidental broadcast.
export const NOTIFICATION_MODULE_KEYS = [
  "accounts", "accounting_reports", "accounting_maintenance",
  "inventory_reports", "items", "warehouses",
  "suppliers", "supplier_settlements", "purchase_invoices",
  "hr_module", "hr_employees", "hr_payroll", "fixed_assets",
  "production", "simple_manufacturing", "security_events", "ai_tools",
  "maintenance", "contracting", "sales_module", "sales_reports",
  "pos", "cash_module", "cash_reports", "zatca",
] as const;

export function visibleNotificationModules(user: any): string[] {
  if (user?.role === "superadmin") return [...NOTIFICATION_MODULE_KEYS];
  return NOTIFICATION_MODULE_KEYS.filter((module) => canAccessModule(user, module, "view"));
}

/** Drizzle condition for ORM notification queries. */
export function notificationScopeWhere(user: any) {
  const modules = visibleNotificationModules(user);
  const moduleScope = modules.length
    ? or(isNull(notificationsTable.moduleKey), inArray(notificationsTable.moduleKey, modules))
    : isNull(notificationsTable.moduleKey);
  const branchScope = user?.viewAllBranches
    ? undefined
    : (user?.branchIds?.length
      ? or(isNull(notificationsTable.branchId), inArray(notificationsTable.branchId, user.branchIds))
      : isNull(notificationsTable.branchId));
  return branchScope ? and(moduleScope, branchScope) : moduleScope;
}

/** SQL fragment for raw queries using the notifications table alias `n`. */
export function notificationScopeSql(user: any) {
  const modules = visibleNotificationModules(user);
  const moduleSql = modules.length
    ? sql`(n.module_key IS NULL OR n.module_key IN (${sql.join(modules.map((module) => sql`${module}`), sql`, `)}))`
    : sql`n.module_key IS NULL`;
  const branchSql = user?.viewAllBranches
    ? sql`TRUE`
    : user?.branchIds?.length
      ? sql`(n.branch_id IS NULL OR n.branch_id IN (${sql.join(user.branchIds.map((id: number) => sql`${id}`), sql`, `)}))`
      : sql`n.branch_id IS NULL`;
  return sql`AND ${moduleSql} AND ${branchSql}`;
}