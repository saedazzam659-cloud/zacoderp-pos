import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const kioskTokensTable = pgTable("kiosk_tokens", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  label:            text("label").notNull(),
  tokenHash:        text("token_hash").notNull().unique(),
  scope:            text("scope").notNull().default("face_attendance"),
  createdByUserId:  integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  lastUsedAt:       timestamp("last_used_at"),
  lastUsedIp:       text("last_used_ip"),
  revokedAt:        timestamp("revoked_at"),
}, (t) => ({
  byCompany: index("kiosk_tokens_company_idx").on(t.companyId, t.createdAt),
  byHash:    index("kiosk_tokens_hash_idx").on(t.tokenHash),
}));

export type KioskToken = typeof kioskTokensTable.$inferSelect;
