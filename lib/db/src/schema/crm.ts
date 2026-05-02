// ─────────────────────────────────────────────────────────────────────────
// CRM module — Leads, Opportunities, Activities, Campaigns, Pipeline.
// Multi-company scoped. Integrates with existing customers + sales modules.
// Lead → Opportunity → Quotation → Invoice flow.
// ─────────────────────────────────────────────────────────────────────────
import {
  pgTable, serial, text, integer, numeric, timestamp, boolean, pgEnum, date,
} from "drizzle-orm/pg-core";
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
