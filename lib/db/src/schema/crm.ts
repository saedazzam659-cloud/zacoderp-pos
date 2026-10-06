// ─────────────────────────────────────────────────────────────────────────
// CRM module — Leads, Opportunities, Activities, Campaigns, Pipeline.
// Multi-company scoped. Integrates with existing customers + sales modules.
// Lead → Opportunity → Quotation → Invoice flow.
// ─────────────────────────────────────────────────────────────────────────
import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, pgEnum, date,
  index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { customersTable } from "./customers";

export const crmLeadStatusEnum = pgEnum("crm_lead_status", [
  "new", "contacted", "qualified", "rejected", "converted",
]);
export const crmInterestEnum = pgEnum("crm_interest_level", [
  "cold", "warm", "hot",
]);
export const crmOpportunityStageEnum = pgEnum("crm_opportunity_stage", [
  "prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost",
]);
export const crmActivityTypeEnum = pgEnum("crm_activity_type", [
  "call", "meeting", "task", "visit", "email", "note",
]);
export const crmActivityRelEnum = pgEnum("crm_activity_rel", [
  "lead", "customer", "opportunity",
]);
export const crmCampaignChannelEnum = pgEnum("crm_campaign_channel", [
  "facebook", "google", "instagram", "tiktok", "snapchat", "email", "sms", "referral", "event", "other",
]);

// 1) Leads
export const crmLeadsTable = pgTable("crm_leads", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:         integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  code:             text("code").notNull(),
  name:             text("name").notNull(),
  mobile:           text("mobile"),
  email:            text("email"),
  source:           text("source"),
  campaignId:       integer("campaign_id"),
  industry:         text("industry"),
  interestLevel:    crmInterestEnum("interest_level").notNull().default("warm"),
  status:           crmLeadStatusEnum("status").notNull().default("new"),
  assignedToUserId: integer("assigned_to_user_id"),
  conversionScore:  numeric("conversion_score", { precision: 5, scale: 2 }).notNull().default("0"),
  convertedCustomerId: integer("converted_customer_id").references(() => customersTable.id, { onDelete: "set null" }),
  notes:            text("notes"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});
export type CrmLead       = typeof crmLeadsTable.$inferSelect;
export type InsertCrmLead = typeof crmLeadsTable.$inferInsert;

// 2) Campaigns
export const crmCampaignsTable = pgTable("crm_campaigns", {
  id:              serial("id").primaryKey(),
  companyId:       integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  code:            text("code").notNull(),
  name:            text("name").notNull(),
  channel:         crmCampaignChannelEnum("channel").notNull().default("other"),
  budget:          numeric("budget", { precision: 15, scale: 2 }).notNull().default("0"),
  startDate:       date("start_date"),
  endDate:         date("end_date"),
  expectedRevenue: numeric("expected_revenue", { precision: 15, scale: 2 }).notNull().default("0"),
  actualRevenue:   numeric("actual_revenue", { precision: 15, scale: 2 }).notNull().default("0"),
  isActive:        boolean("is_active").notNull().default(true),
  notes:           text("notes"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});
export type CrmCampaign       = typeof crmCampaignsTable.$inferSelect;
export type InsertCrmCampaign = typeof crmCampaignsTable.$inferInsert;

// 3) Pipeline stages (configurable per company)
export const crmPipelineStagesTable = pgTable("crm_pipeline_stages", {
  id:        serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name:      text("name").notNull(),
  orderNo:   integer("order_no").notNull().default(0),
  probability: numeric("probability", { precision: 5, scale: 2 }).notNull().default("50"),
  isActive:  boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type CrmPipelineStage       = typeof crmPipelineStagesTable.$inferSelect;
export type InsertCrmPipelineStage = typeof crmPipelineStagesTable.$inferInsert;

// 4) Opportunities
export const crmOpportunitiesTable = pgTable("crm_opportunities", {
  id:                 serial("id").primaryKey(),
  companyId:          integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:           integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),
  code:               text("code").notNull(),
  title:              text("title").notNull(),
  leadId:             integer("lead_id").references(() => crmLeadsTable.id, { onDelete: "set null" }),
  customerId:         integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
  campaignId:         integer("campaign_id").references(() => crmCampaignsTable.id, { onDelete: "set null" }),
  stage:              crmOpportunityStageEnum("stage").notNull().default("prospecting"),
  pipelineStageId:    integer("pipeline_stage_id").references(() => crmPipelineStagesTable.id, { onDelete: "set null" }),
  dealValue:          numeric("deal_value", { precision: 15, scale: 2 }).notNull().default("0"),
  successProbability: numeric("success_probability", { precision: 5, scale: 2 }).notNull().default("50"),
  expectedCloseDate:  date("expected_close_date"),
  closedAt:           timestamp("closed_at"),
  closedReason:       text("closed_reason"),
  assignedToUserId:   integer("assigned_to_user_id"),
  notes:              text("notes"),
  createdAt:          timestamp("created_at").defaultNow().notNull(),
  updatedAt:          timestamp("updated_at").defaultNow().notNull(),
});
export type CrmOpportunity       = typeof crmOpportunitiesTable.$inferSelect;
export type InsertCrmOpportunity = typeof crmOpportunitiesTable.$inferInsert;

// 5) Activities (calls, meetings, tasks, visits, emails, notes)
export const crmActivitiesTable = pgTable("crm_activities", {
  id:          serial("id").primaryKey(),
  companyId:   integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  type:        crmActivityTypeEnum("type").notNull().default("task"),
  relatedType: crmActivityRelEnum("related_type").notNull(),
  relatedId:   integer("related_id").notNull(),
  subject:     text("subject").notNull(),
  scheduledAt: timestamp("scheduled_at"),
  completedAt: timestamp("completed_at"),
  userId:      integer("user_id"),
  notes:       text("notes"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
});
export type CrmActivity       = typeof crmActivitiesTable.$inferSelect;
export type InsertCrmActivity = typeof crmActivitiesTable.$inferInsert;

// 6) WhatsApp marketing contacts. These are deliberately separate from CRM
// customers; `customerId` is populated only by the explicit convert action.
export const crmWhatsAppContactsTable = pgTable("crm_whatsapp_contacts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  normalizedPhone: text("normalized_phone").notNull(),
  notes: text("notes"),
  customerId: integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  companyPhoneUnique: uniqueIndex("crm_whatsapp_contacts_company_phone_uq").on(t.companyId, t.normalizedPhone),
  companyActiveIndex: index("crm_whatsapp_contacts_company_active_idx").on(t.companyId, t.deletedAt),
}));
export const insertCrmWhatsAppContactSchema = createInsertSchema(crmWhatsAppContactsTable).omit({
  id: true, normalizedPhone: true, customerId: true, deletedAt: true, createdAt: true, updatedAt: true,
});
export type CrmWhatsAppContact = typeof crmWhatsAppContactsTable.$inferSelect;
export type InsertCrmWhatsAppContact = z.infer<typeof insertCrmWhatsAppContactSchema>;

// 7) Campaigns save one reusable message for many separately opened chats.
export const crmWhatsAppCampaignsTable = pgTable("crm_whatsapp_campaigns", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export const insertCrmWhatsAppCampaignSchema = createInsertSchema(crmWhatsAppCampaignsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type CrmWhatsAppCampaign = typeof crmWhatsAppCampaignsTable.$inferSelect;
export type InsertCrmWhatsAppCampaign = z.infer<typeof insertCrmWhatsAppCampaignSchema>;

// Recipient phone/name snapshots preserve campaign history even if the
// contact is later removed or edited in the reusable address book.
export const crmWhatsAppCampaignRecipientsTable = pgTable("crm_whatsapp_campaign_recipients", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => crmWhatsAppCampaignsTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => crmWhatsAppContactsTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  normalizedPhone: text("normalized_phone").notNull(),
  status: text("status").notNull().default("not_sent"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  campaignPhoneUnique: uniqueIndex("crm_whatsapp_recipients_campaign_phone_uq")
    .on(t.companyId, t.campaignId, t.normalizedPhone),
  campaignIndex: index("crm_whatsapp_recipients_campaign_idx").on(t.companyId, t.campaignId),
}));
export const insertCrmWhatsAppCampaignRecipientSchema = createInsertSchema(crmWhatsAppCampaignRecipientsTable).omit({
  id: true, sentAt: true, createdAt: true,
});
export type CrmWhatsAppCampaignRecipient = typeof crmWhatsAppCampaignRecipientsTable.$inferSelect;
export type InsertCrmWhatsAppCampaignRecipient = z.infer<typeof insertCrmWhatsAppCampaignRecipientSchema>;
