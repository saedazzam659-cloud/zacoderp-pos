import { pgTable, serial, integer, text, numeric, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const posSessionStatusEnum = pgEnum("pos_session_status", ["open", "closed", "force_closed"]);

export const posSessionsTable = pgTable("pos_sessions", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  userId:       integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  branchId:     integer("branch_id"),
  cashBoxId:    integer("cash_box_id"),
  openingCash:  numeric("opening_cash", { precision: 15, scale: 2 }).notNull().default("0"),
  closingCash:  numeric("closing_cash", { precision: 15, scale: 2 }),
  expectedCash: numeric("expected_cash", { precision: 15, scale: 2 }),
  difference:   numeric("difference",    { precision: 15, scale: 2 }),
  openedAt:     timestamp("opened_at").defaultNow().notNull(),
  closedAt:     timestamp("closed_at"),
  status:       posSessionStatusEnum("status").notNull().default("open"),
  device:       text("device"),
  notes:        text("notes"),
  closedNotes:  text("closed_notes"),
});
