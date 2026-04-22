import { pgTable, serial, text, integer, boolean, timestamp, jsonb, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
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
  sessionToken: text("session_token"),
  sessionId: text("session_id"),
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
