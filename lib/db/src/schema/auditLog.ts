import {
  pgTable, serial, integer, text, timestamp, jsonb, index,
} from "drizzle-orm/pg-core";

// Centralised activity / audit log for RBAC-protected operations.
// Every authenticated mutation is recorded here (asynchronously) so admins
// can review what happened, who did it, and from where.
//
// We intentionally denormalise `username` and `companyId` so log rows stay
// useful even after the underlying user is renamed or removed. Foreign keys
// to users/companies are omitted for the same reason — old audit rows must
// survive user deletion.
export const auditLogTable = pgTable("audit_log", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id"),               // nullable: anonymous/auth-failed
  username:   text("username"),                 // snapshot for display
  role:       text("role"),                     // snapshot of user.role at time of action
  companyId:  integer("company_id"),            // tenant scope for filtering
  module:     text("module").notNull(),         // e.g. "sales_invoices"
  action:     text("action").notNull(),         // view | create | edit | delete | post | export | login | denied
  method:     text("method"),                   // HTTP verb (GET/POST/PUT/PATCH/DELETE)
  path:       text("path"),                     // request URL path
  entityType: text("entity_type"),              // optional: model name (e.g. "invoice")
  entityId:   text("entity_id"),                // optional: id of affected row (string for flexibility)
  statusCode: integer("status_code"),           // HTTP response status
  ip:         text("ip"),                       // client IP (proxy-aware)
  userAgent:  text("user_agent"),
  metadata:   jsonb("metadata"),                // extra payload (small!)
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byCompanyTime: index("audit_company_time_idx").on(t.companyId, t.createdAt),
  byUserTime:    index("audit_user_time_idx").on(t.userId, t.createdAt),
  byModuleTime:  index("audit_module_time_idx").on(t.module, t.createdAt),
}));

export type AuditLogRow = typeof auditLogTable.$inferSelect;
export type AuditLogInsert = typeof auditLogTable.$inferInsert;
