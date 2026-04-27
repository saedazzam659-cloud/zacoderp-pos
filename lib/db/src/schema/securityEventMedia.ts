import { pgTable, serial, integer, varchar, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

// ─── Tracks ownership of security-event media uploads ───────────────
// Stamped at upload-URL issuance time so that downstream readers (the
// AI vision endpoint, the events API, the storage proxy) can verify
// the requester's company actually owns a given /objects/... path
// before serving or analyzing it. This is the authorization-binding
// layer that prevents one tenant from analyzing another tenant's
// uploaded image just by knowing/guessing its object path.
export const securityEventMediaTable = pgTable("security_event_media", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  userId: integer("user_id"),
  objectPath: text("object_path").notNull(),
  kind: varchar("kind", { length: 16 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: false }).notNull().defaultNow(),
}, (t) => ({
  byPath: uniqueIndex("security_event_media_path_idx").on(t.objectPath),
  byCompany: index("security_event_media_company_idx").on(t.companyId),
}));

export type SecurityEventMediaRow = typeof securityEventMediaTable.$inferSelect;
