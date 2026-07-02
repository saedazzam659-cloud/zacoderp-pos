import { pgTable, serial, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { companiesTable } from "./companies";
import { itemsTable } from "./inventory";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────
// Item Usage Control (التحكم في توجيه الصنف) — Phase أ.
//
// Per-item × per-screen routing rule. Governs where a given item is allowed to
// appear/be used across the ERP screens. The DEFAULT (no row) is "allowed"
// everywhere, so we persist ONLY non-default rules — this keeps the table lean
// even at millions of items and lets the central resolver treat "absent = allowed".
//
// mode ∈ allowed | hidden | readonly | requires_approval | requires_permission
// (validated in the app layer — see api-server/src/lib/itemUsageControl.ts).
//
// Purely additive: a new table + a new tab inside the existing Items form.
// Enforcement across screens is wired gradually in Phase ب via the central
// resolver; this table is the single source of truth.
// ─────────────────────────────────────────────────────────────────────────
export const itemUsageControlsTable = pgTable("item_usage_controls", {
  id:        serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  itemId:    integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  // Free-form slug (e.g. "sales_invoices", "pos"). Kept as text so a NEW screen
  // is just a new key — no schema change (matches the spec's extensibility goal).
  screenKey: text("screen_key").notNull(),
  mode:      text("mode").notNull().default("allowed"),
  // Optional human reason shown to the user when the item is restricted.
  reason:    text("reason"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // One rule per (company, item, screen).
  itemScreenUniq:       uniqueIndex("item_usage_controls_item_screen_uniq").on(t.companyId, t.itemId, t.screenKey),
  // Fast "all rules for this item" lookups (the item form + per-item resolver).
  companyItemIdx:       index("item_usage_controls_company_item_idx").on(t.companyId, t.itemId),
  // Fast "which items are restricted on this screen" lookups (Phase ب filters).
  companyScreenModeIdx: index("item_usage_controls_company_screen_mode_idx").on(t.companyId, t.screenKey, t.mode),
}));

export const insertItemUsageControlSchema = createInsertSchema(itemUsageControlsTable)
  .omit({ id: true, createdAt: true, updatedAt: true });

export type ItemUsageControl = typeof itemUsageControlsTable.$inferSelect;
