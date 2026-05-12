import { pgTable, serial, text, integer, boolean, timestamp, jsonb, primaryKey, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  // Username uniqueness is NO LONGER global. Two partial unique indexes
  // are enforced via raw SQL in the schema-pin / ensureSchema layer:
  //   • UNIQUE(company_id, username) WHERE company_id IS NOT NULL
  //   • UNIQUE(username)             WHERE company_id IS NULL
  // The first lets two different companies each own a user named "ahmed"
  // (the whole point of the companyCode redesign). The second keeps
  // SuperAdmin (company_id IS NULL) globally unique so the SuperAdmin
  // login flow can still find them by username alone.
  username: text("username").notNull(),
  email: text("email"),
  passwordHash: text("password_hash").notNull(),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("admin"),
  // ─── Profile fields ────────────────────────────────────────
  code:    text("code"),       // user code (per-company employee number)
  nameAr:  text("name_ar"),    // الاسم بالعربية
  nameEn:  text("name_en"),    // English name
  // ─── Granular per-screen / per-action permissions ─────────
  // Shape: { "<moduleKey>": { view, create, edit, delete, post, export, ... } }
  // For admin/superadmin, full access is granted regardless of this map.
  permissions: jsonb("permissions"),
  // Branch-visibility scope. When true (default), the user can see data from
  // every branch of their company. When false, the user can only see data
  // belonging to the branches linked through `user_branches`. Admin and
  // superadmin roles always bypass this restriction.
  viewAllBranches: boolean("view_all_branches").notNull().default(true),
  scopeOwnCustomersOnly: boolean("scope_own_customers_only").notNull().default(false),
  // Per-SuperAdmin opt-out for the maintenance-critical email digest.
  // Defaults to true so existing recipients keep getting alerts; only meaningful
  // for users with role='superadmin' (other roles are never on the digest list).
  notifyMaintenanceEmail: boolean("notify_maintenance_email").notNull().default(true),
  // Per-SuperAdmin severity threshold for the maintenance digest. Combined
  // with notifyMaintenanceEmail above so opt-outs still suppress everything.
  // Allowed values:
  //   "critical" — receive only when the sweep surfaced at least one critical
  //                finding (the historical default — preserves prior behaviour).
  //   "warning"  — receive when the sweep surfaced critical OR warn findings.
  //   "all"      — receive on any non-OK signal, including silently-broken
  //                tools (status = 'error') with no critical/warn rows.
  // Other roles never reach the digest list, so this column is harmless on them.
  notifyMaintenanceSeverity: text("notify_maintenance_severity").notNull().default("critical"),
  // ─── Approval permissions (per-user document approval workflow) ─────
  // Whether the user can approve documents at all. When false, the
  // "approve" button is hidden in document UIs regardless of any other
  // approval-related fields below.
  canApprove:           boolean("can_approve").notNull().default(false),
  // Hierarchical approval level (0 = none, 1 = L1 …). Documents whose
  // amount exceeds this user's `maxApprovalAmount` get bumped to the
  // next level for further approval.
  approvalLevel:        integer("approval_level").notNull().default(0),
  // Maximum total amount this user is allowed to approve in one shot.
  // 0 = no cap (use with caution; combine with role/company controls).
  maxApprovalAmount:    numeric("max_approval_amount", { precision: 18, scale: 2 }).notNull().default("0"),
  // When true, this user's approval is not final — the document moves
  // to the next level for a second signoff before being marked Approved.
  requireSecondApproval: boolean("require_second_approval").notNull().default(false),
  sessionToken: text("session_token"),
  sessionId: text("session_id"),
  // ID of the user's currently-selected manual session (FK to sessions.id, see
  // schema/sessions.ts). Soft reference (no FK constraint) to avoid a circular
  // import. Cleared if the user is removed from the session or the session is
  // archived. Persisted server-side so the picker selection survives reload.
  currentSessionId: integer("current_session_id"),
  lastLoginAt: timestamp("last_login_at"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Many-to-many: a user can be granted access to multiple branches
export const userBranchesTable = pgTable("user_branches", {
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  branchId: integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.branchId] }),
}));

export type UserBranch = typeof userBranchesTable.$inferSelect;

export const subscriptionsTable = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  plan: text("plan").notNull().default("starter"),
  maxUsers: integer("max_users").notNull().default(1),
  maxBranches: integer("max_branches").notNull().default(1),
  maxWarehouses: integer("max_warehouses").notNull().default(1),
  maxInvoices: integer("max_invoices").notNull().default(50),
  billingCycle: text("billing_cycle").notNull().default("monthly"),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  price: text("price").notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
export type Subscription = typeof subscriptionsTable.$inferSelect;
