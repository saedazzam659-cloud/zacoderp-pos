import { pgTable, uuid, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { agentInstancesTable } from "./agentInstances";
import { usersTable } from "./users";

/**
 * Central-control-plane record for a one-time ZATCA registration hand-off.
 * The payload is AES-GCM ciphertext only; this table must never be installed
 * in an agent business database or included in company exports.
 */
export const zatcaRegistrationTransfersTable = pgTable("zatca_registration_transfers", {
  id: uuid("id").primaryKey(),
  sourceCompanyId: integer("source_company_id").notNull().references(() => companiesTable.id),
  targetAgentId: integer("target_agent_id").notNull().references(() => agentInstancesTable.id),
  targetCompanyId: integer("target_company_id").notNull(),
  targetInstallationId: text("target_installation_id").notNull(),
  targetDbFingerprint: text("target_db_fingerprint").notNull(),
  state: text("state").notNull().default("prepared"),
  payloadEnc: text("payload_enc"),
  payloadHash: text("payload_hash").notNull(),
  targetBinding: text("target_binding").notNull(),
  chainSnapshot: jsonb("chain_snapshot").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  completedAt: timestamp("completed_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  completedByUserId: integer("completed_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  cancelledByUserId: integer("cancelled_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  error: text("error"),
  auditMeta: jsonb("audit_meta"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  sourceStateIdx: index("zatca_registration_transfers_source_state_idx").on(t.sourceCompanyId, t.state),
  expiryIdx: index("zatca_registration_transfers_expiry_idx").on(t.expiresAt),
}));

export type ZatcaRegistrationTransfer = typeof zatcaRegistrationTransfersTable.$inferSelect;