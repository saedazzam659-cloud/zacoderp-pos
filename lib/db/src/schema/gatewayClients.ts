import { pgTable, serial, text, integer, timestamp, boolean, index, jsonb, numeric } from "drizzle-orm/pg-core";

export const gatewayClientsTable = pgTable("gateway_clients", {
  id:                serial("id").primaryKey(),
  nameAr:            text("name_ar").notNull(),
  nameEn:            text("name_en"),
  vatNumber:         text("vat_number").notNull().unique(),
  crNumber:          text("cr_number"),
  contactEmail:      text("contact_email"),
  contactPhone:      text("contact_phone"),
  addressAr:         text("address_ar"),
  city:              text("city"),
  zatcaCsidEnc:      text("zatca_csid_enc"),
  zatcaPcsidEnc:     text("zatca_pcsid_enc"),
  zatcaPrivateKeyEnc: text("zatca_private_key_enc"),
  zatcaEnv:          text("zatca_env").notNull().default("sandbox"),
  // ZATCA invoice chain state — must increment monotonically per device
  // (CSID). lastIcv = Invoice Counter Value of the last submitted invoice.
  // lastInvoiceHash = SHA-256 hash of the last invoice (used as PIH —
  // Previous Invoice Hash — for the next one). Both reset only when a
  // new device serial is registered.
  lastIcv:           integer("last_icv").notNull().default(0),
  lastInvoiceHash:   text("last_invoice_hash"),
  egsSerial:         text("egs_serial"),
  // Onboarding-wizard artifacts (Option B). When the SuperAdmin generates
  // a CSR through our wizard we store the public CSR (so they can re-
  // download it) plus the encrypted private key so we can use it for
  // signing once ZATCA returns the matching CSID.
  csrPem:            text("csr_pem"),
  csrPrivateKeyEnc:  text("csr_private_key_enc"),
  status:            text("status").notNull().default("pending"),
  notes:             text("notes"),
  monthlyQuota:      integer("monthly_quota").notNull().default(1000),
  invoicesThisMonth: integer("invoices_this_month").notNull().default(0),
  totalInvoices:     integer("total_invoices").notNull().default(0),
  createdAt:         timestamp("created_at").defaultNow().notNull(),
  updatedAt:         timestamp("updated_at").defaultNow().notNull(),
  lastInvoiceAt:     timestamp("last_invoice_at"),
}, (t) => ({
  byVat:    index("gateway_clients_vat_idx").on(t.vatNumber),
  byStatus: index("gateway_clients_status_idx").on(t.status),
}));

export const gatewayApiKeysTable = pgTable("gateway_api_keys", {
  id:          serial("id").primaryKey(),
  clientId:    integer("client_id").notNull().references(() => gatewayClientsTable.id, { onDelete: "cascade" }),
  label:       text("label").notNull(),
  keyHash:     text("key_hash").notNull().unique(),
  keyPrefix:   text("key_prefix").notNull(),
  scope:       text("scope").notNull().default("invoice_submit"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
  lastUsedAt:  timestamp("last_used_at"),
  lastUsedIp:  text("last_used_ip"),
  revokedAt:   timestamp("revoked_at"),
  expiresAt:   timestamp("expires_at"),
}, (t) => ({
  byClient: index("gateway_api_keys_client_idx").on(t.clientId),
  byHash:   index("gateway_api_keys_hash_idx").on(t.keyHash),
}));

export const gatewayInvoicesTable = pgTable("gateway_invoices", {
  id:              serial("id").primaryKey(),
  clientId:        integer("client_id").notNull().references(() => gatewayClientsTable.id, { onDelete: "cascade" }),
  apiKeyId:        integer("api_key_id").references(() => gatewayApiKeysTable.id, { onDelete: "set null" }),
  fileName:        text("file_name"),
  fileSize:        integer("file_size"),
  invoiceNumber:   text("invoice_number"),
  invoiceDate:     timestamp("invoice_date"),
  totalAmount:     numeric("total_amount", { precision: 18, scale: 2 }),
  vatAmount:       numeric("vat_amount", { precision: 18, scale: 2 }),
  status:          text("status").notNull().default("received"),
  zatcaUuid:       text("zatca_uuid"),
  zatcaResponse:   jsonb("zatca_response"),
  errorMessage:    text("error_message"),
  // ZATCA chain fields snapshot (for audit + replay)
  icv:             integer("icv"),
  pih:             text("pih"),                  // previous invoice hash used
  invoiceHash:     text("invoice_hash"),         // sha256 of canonical payload (becomes PIH for next)
  invoiceType:     text("invoice_type"),         // 388 / 381 / 383
  invoiceFlow:     text("invoice_flow"),         // standard / simplified
  canonicalJson:   jsonb("canonical_json"),      // normalized invoice payload
  // Phase 1B: built UBL XML + base64 TLV QR (used by viewer + PDF)
  ublXml:          text("ubl_xml"),
  qrTlv:           text("qr_tlv"),
  // Phase 1B: ZATCA HTTP submission tracking
  zatcaSubmittedAt: timestamp("zatca_submitted_at"),
  clearanceStatus:  text("clearance_status"),    // pending | cleared | rejected | warning
  clearanceNotes:   jsonb("clearance_notes"),    // raw warnings/errors from ZATCA
  receivedAt:      timestamp("received_at").defaultNow().notNull(),
  processedAt:     timestamp("processed_at"),
  ip:              text("ip"),
}, (t) => ({
  byClient:  index("gateway_invoices_client_idx").on(t.clientId, t.receivedAt),
  byStatus:  index("gateway_invoices_status_idx").on(t.status),
}));

export type GatewayClient = typeof gatewayClientsTable.$inferSelect;
export type GatewayApiKey = typeof gatewayApiKeysTable.$inferSelect;
export type GatewayInvoice = typeof gatewayInvoicesTable.$inferSelect;
