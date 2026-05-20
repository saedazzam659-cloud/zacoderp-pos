import { pgTable, serial, text, integer, timestamp, numeric, boolean, date, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// ─── Sister Companies ────────────────────────────────────────────────────
// Affiliated entities under the same legal owner / VAT / CR. Stock moves
// between them are NOT ZATCA invoices (seller==buyer at the tax-registration
// level). Kept in a dedicated table — not in `customers` — to avoid leaking
// into customer reports / credit limits / sales analytics.
export const sisterCompaniesTable = pgTable("sister_companies", {
  id:        serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  nameAr:    text("name_ar").notNull(),
  nameEn:    text("name_en"),
  vatNumber: text("vat_number"),
  crNumber:  text("cr_number"),
  phone:     text("phone"),
  email:     text("email"),
  address:   text("address"),
  // 4 default GL accounts used when posting a sister transfer.
  // Each is nullable — the transfer form lets the user override per doc,
  // but the defaults make data entry painless once configured.
  accountId:                   integer("account_id"),                  // AR / due-from sister co (control account)
  defaultCogsAccountId:        integer("default_cogs_account_id"),     // DR on transfer = inventory cost
  defaultRevenueAccountId:     integer("default_revenue_account_id"),  // CR on transfer = supply price
  defaultInventoryAccountId:   integer("default_inventory_account_id"),// CR on transfer = inventory cost
  notes:     text("notes"),
  isActive:  boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const sisterDocStatusEnum = pgEnum("sister_doc_status", ["draft", "posted", "cancelled"]);

// ─── Sister Transfer (goods out → sister co) ─────────────────────────────
export const sisterTransfersTable = pgTable("sister_transfers", {
  id:                serial("id").primaryKey(),
  companyId:         integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  transferNumber:    text("transfer_number").notNull(),
  transferDate:      date("transfer_date").notNull(),
  sisterCompanyId:   integer("sister_company_id").notNull().references(() => sisterCompaniesTable.id),
  fromWarehouseId:   integer("from_warehouse_id").notNull(),
  // Account overrides (default to the sister-co master)
  arAccountId:        integer("ar_account_id"),
  cogsAccountId:      integer("cogs_account_id"),
  revenueAccountId:   integer("revenue_account_id"),
  inventoryAccountId: integer("inventory_account_id"),
  totalCost:         numeric("total_cost",   { precision: 18, scale: 4 }).default("0").notNull(),
  totalSupply:       numeric("total_supply", { precision: 18, scale: 4 }).default("0").notNull(),
  journalEntryId:    integer("journal_entry_id"),
  status:            sisterDocStatusEnum("status").default("draft").notNull(),
  notes:             text("notes"),
  createdAt:         timestamp("created_at").defaultNow().notNull(),
  updatedAt:         timestamp("updated_at").defaultNow().notNull(),
});

export const sisterTransferItemsTable = pgTable("sister_transfer_items", {
  id:          serial("id").primaryKey(),
  transferId:  integer("transfer_id").notNull().references(() => sisterTransfersTable.id, { onDelete: "cascade" }),
  itemId:      integer("item_id").notNull(),
  unitId:      integer("unit_id"),
  qty:         numeric("qty",          { precision: 18, scale: 4 }).notNull(),
  costPrice:   numeric("cost_price",   { precision: 14, scale: 4 }).default("0").notNull(),
  supplyPrice: numeric("supply_price", { precision: 14, scale: 4 }).default("0").notNull(),
  // Track how much of this line was already returned to block over-return.
  returnedQty: numeric("returned_qty", { precision: 18, scale: 4 }).default("0").notNull(),
});

// ─── Sister Return (goods back from sister co) ───────────────────────────
export const sisterReturnsTable = pgTable("sister_returns", {
  id:                serial("id").primaryKey(),
  companyId:         integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  returnNumber:      text("return_number").notNull(),
  returnDate:        date("return_date").notNull(),
  // The original transfer being reversed. Required so we restore stock at
  // the original cost layer and reverse the exact same accounts.
  transferId:        integer("transfer_id").notNull().references(() => sisterTransfersTable.id),
  sisterCompanyId:   integer("sister_company_id").notNull().references(() => sisterCompaniesTable.id),
  toWarehouseId:     integer("to_warehouse_id").notNull(),
  totalCost:         numeric("total_cost",   { precision: 18, scale: 4 }).default("0").notNull(),
  totalSupply:       numeric("total_supply", { precision: 18, scale: 4 }).default("0").notNull(),
  journalEntryId:    integer("journal_entry_id"),
  status:            sisterDocStatusEnum("status").default("draft").notNull(),
  notes:             text("notes"),
  createdAt:         timestamp("created_at").defaultNow().notNull(),
  updatedAt:         timestamp("updated_at").defaultNow().notNull(),
});

export const sisterReturnItemsTable = pgTable("sister_return_items", {
  id:                  serial("id").primaryKey(),
  returnId:            integer("return_id").notNull().references(() => sisterReturnsTable.id, { onDelete: "cascade" }),
  // FK to the original transfer line so we know the exact cost/supply
  // price to reverse and can decrement that line's returnedQty.
  transferItemId:      integer("transfer_item_id").notNull().references(() => sisterTransferItemsTable.id),
  itemId:              integer("item_id").notNull(),
  unitId:              integer("unit_id"),
  qty:                 numeric("qty",          { precision: 18, scale: 4 }).notNull(),
  costPrice:           numeric("cost_price",   { precision: 14, scale: 4 }).default("0").notNull(),
  supplyPrice:         numeric("supply_price", { precision: 14, scale: 4 }).default("0").notNull(),
});

// ─── Sister Settlement (cash receipt / payment) ──────────────────────────
// Two directions:
//   • receive: sister co paid us → DR cash/bank,  CR sister AR
//   • pay:     we paid sister co → DR sister AR,  CR cash/bank
export const sisterSettlementDirectionEnum = pgEnum("sister_settlement_direction", ["receive", "pay"]);
export const sisterSettlementPaymentTypeEnum = pgEnum("sister_settlement_payment_type", ["cash", "bank"]);

export const sisterSettlementsTable = pgTable("sister_settlements", {
  id:                serial("id").primaryKey(),
  companyId:         integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:              text("code").notNull(),
  date:              date("date").notNull(),
  sisterCompanyId:   integer("sister_company_id").notNull().references(() => sisterCompaniesTable.id),
  direction:         sisterSettlementDirectionEnum("direction").notNull(),
  paymentType:       sisterSettlementPaymentTypeEnum("payment_type").notNull(),
  cashBoxId:         integer("cash_box_id"),
  bankAccountId:     integer("bank_account_id"),
  amount:            numeric("amount", { precision: 18, scale: 4 }).notNull(),
  description:       text("description"),
  journalEntryId:    integer("journal_entry_id"),
  status:            sisterDocStatusEnum("status").default("draft").notNull(),
  createdAt:         timestamp("created_at").defaultNow().notNull(),
  updatedAt:         timestamp("updated_at").defaultNow().notNull(),
});

// ─── Zod / types ─────────────────────────────────────────────────────────
export const insertSisterCompanySchema  = createInsertSchema(sisterCompaniesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSisterTransferSchema = createInsertSchema(sisterTransfersTable).omit({ id: true, createdAt: true, updatedAt: true, journalEntryId: true });
export const insertSisterReturnSchema   = createInsertSchema(sisterReturnsTable).omit({ id: true, createdAt: true, updatedAt: true, journalEntryId: true });
export const insertSisterSettlementSchema = createInsertSchema(sisterSettlementsTable).omit({ id: true, createdAt: true, updatedAt: true, journalEntryId: true });

export type SisterCompany   = typeof sisterCompaniesTable.$inferSelect;
export type SisterTransfer  = typeof sisterTransfersTable.$inferSelect;
export type SisterTransferItem = typeof sisterTransferItemsTable.$inferSelect;
export type SisterReturn    = typeof sisterReturnsTable.$inferSelect;
export type SisterReturnItem = typeof sisterReturnItemsTable.$inferSelect;
export type SisterSettlement = typeof sisterSettlementsTable.$inferSelect;
export type InsertSisterCompany = z.infer<typeof insertSisterCompanySchema>;
