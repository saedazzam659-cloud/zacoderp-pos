import { pgTable, serial, integer, text, numeric, timestamp, boolean, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { branchesTable } from "./branches";

// ─── POS terminals (طرق البيع) ──────────────────────────────────────────────
// A "POS terminal" = a configured selling station. Each terminal lives in one
// branch, may be paired to one physical machine (machineCode — e.g. a device
// fingerprint stored in the browser) and optionally points at a default cash
// box. Cashiers pick a terminal at login, which then drives the session
// (branch + cashBox) and prevents two cashiers from sharing one terminal at
// the same time.
export const posTerminalsTable = pgTable("pos_terminals", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:    integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  code:        text("code").notNull(),
  nameAr:      text("name_ar").notNull(),
  nameEn:      text("name_en"),
  // The hardware identifier this terminal is paired to. Stored on first
  // successful login from a device (the POS UI generates and persists a
  // random pos_device_id in localStorage and sends it as machineCode).
  // null = not yet paired; on next pair attempt the server stamps it in.
  machineCode: text("machine_code"),
  cashBoxId:   integer("cash_box_id"),
  isActive:    boolean("is_active").notNull().default(true),
  notes:       text("notes"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
  updatedAt:   timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniqCodePerCompany: uniqueIndex("pos_terminals_company_code_uniq").on(t.companyId, t.code),
}));

export const posSessionStatusEnum = pgEnum("pos_session_status", ["open", "closed", "force_closed"]);

export const posSessionsTable = pgTable("pos_sessions", {
  id:           serial("id").primaryKey(),
  companyId:    integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  userId:       integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  branchId:     integer("branch_id"),
  cashBoxId:    integer("cash_box_id"),
  // The terminal this session is bound to (added with the طرق البيع feature).
  // Nullable for backwards compatibility with older sessions.
  posTerminalId: integer("pos_terminal_id"),
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
