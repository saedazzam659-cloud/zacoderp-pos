import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const CRM_WHATSAPP_DDL = [
  `CREATE TABLE IF NOT EXISTS crm_whatsapp_contacts (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    normalized_phone TEXT NOT NULL,
    notes TEXT,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    deleted_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_whatsapp_contacts_company_phone_uq
    ON crm_whatsapp_contacts(company_id, normalized_phone)`,
  `CREATE INDEX IF NOT EXISTS crm_whatsapp_contacts_company_active_idx
    ON crm_whatsapp_contacts(company_id, deleted_at)`,
  `CREATE TABLE IF NOT EXISTS crm_whatsapp_campaigns (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS crm_whatsapp_campaign_recipients (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    campaign_id INTEGER NOT NULL REFERENCES crm_whatsapp_campaigns(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES crm_whatsapp_contacts(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    normalized_phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_sent',
    sent_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_whatsapp_recipients_campaign_phone_uq
    ON crm_whatsapp_campaign_recipients(company_id, campaign_id, normalized_phone)`,
  `CREATE INDEX IF NOT EXISTS crm_whatsapp_recipients_campaign_idx
    ON crm_whatsapp_campaign_recipients(company_id, campaign_id)`,
] as const;

/**
 * Additive-only schema for CRM WhatsApp marketing, run against the active
 * database before generic schema validation (central and routed agent DBs).
 */
export async function ensureCrmWhatsAppSchema(): Promise<void> {
  for (const statement of CRM_WHATSAPP_DDL) {
    await db.execute(sql.raw(statement));
  }
}
