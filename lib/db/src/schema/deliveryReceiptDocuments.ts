import { pgTable, serial, text, integer, timestamp, numeric, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// ─── Goods Receipt / Delivery Documents (مستندات الاستلام والتسليم) ──────────
// A PURE electronic archive: proves goods were physically received (from a
// supplier, on a purchase invoice) or delivered (to a customer, on a sales
// invoice). It has ZERO accounting/inventory impact — no journal entry, no
// stock movement, no cost change, no invoice-status change. It only documents
// the hand-over with recipient data, an e-signature (or uploaded signature
// image), line quantities, and file attachments (reusing document_archives).
//
//   kind         — 'receipt' (purchase side) | 'delivery' (sales side)
//   invoiceType  — 'purchase' | 'sales' (the linked invoice's table)
//   signature*   — an uploaded PNG in object storage ("/objects/…"), NEVER a
//                  raw data: URI (prod edge WAF rejects data:base64 bodies).
export const deliveryReceiptDocumentsTable = pgTable(
  "delivery_receipt_documents",
  {
    id:            serial("id").primaryKey(),
    companyId:     integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    branchId:      integer("branch_id"),
    warehouseId:   integer("warehouse_id"),
    kind:          text("kind").notNull(),               // 'receipt' | 'delivery'
    docNumber:     text("doc_number").notNull(),
    docDate:       timestamp("doc_date", { withTimezone: true }).notNull().defaultNow(),
    // Linked invoice (snapshot number kept so the doc reads standalone).
    invoiceId:     integer("invoice_id"),
    invoiceType:   text("invoice_type"),                 // 'purchase' | 'sales'
    invoiceNumber: text("invoice_number"),
    // Party (customer for delivery, supplier for receipt) — snapshot name.
    partyId:       integer("party_id"),
    partyType:     text("party_type"),                   // 'customer' | 'supplier'
    partyName:     text("party_name"),
    // The internal employee handing over / receiving on our behalf.
    employeeId:    integer("employee_id"),
    employeeName:  text("employee_name"),
    // Status is free-text keyed by kind:
    //   receipt : 'full' | 'partial' | 'not_received'
    //   delivery: 'delivered' | 'partial' | 'deferred'
    status:        text("status").notNull().default("full"),
    notes:         text("notes"),
    // Recipient (the external person who signs).
    recipientName:     text("recipient_name"),
    recipientJob:      text("recipient_job"),
    recipientIdNumber: text("recipient_id_number"),
    recipientPhone:    text("recipient_phone"),
    // Signature: 'draw' (canvas) or 'image' (uploaded); path in object storage.
    signatureType:       text("signature_type"),         // 'draw' | 'image' | null
    signatureObjectPath: text("signature_object_path"),
    // Approval — editable until approved, then locked.
    isApproved:     boolean("is_approved").notNull().default(false),
    approvedBy:     integer("approved_by"),
    approvedByName: text("approved_by_name"),
    approvedAt:     timestamp("approved_at", { withTimezone: true }),
    // Audit columns (a full trail also lives in the audit table below).
    createdBy:      integer("created_by"),
    createdByName:  text("created_by_name"),
    updatedBy:      integer("updated_by"),
    updatedByName:  text("updated_by_name"),
    createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCompanyKind: index("drdoc_company_kind_idx").on(t.companyId, t.kind),
    byInvoice:     index("drdoc_invoice_idx").on(t.companyId, t.invoiceType, t.invoiceId),
    byParty:       index("drdoc_party_idx").on(t.companyId, t.partyType, t.partyId),
  }),
);

// ─── Line items (snapshot of the invoice lines being handed over) ────────────
export const deliveryReceiptDocumentLinesTable = pgTable(
  "delivery_receipt_document_lines",
  {
    id:         serial("id").primaryKey(),
    companyId:  integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    documentId: integer("document_id").notNull().references(() => deliveryReceiptDocumentsTable.id, { onDelete: "cascade" }),
    itemId:     integer("item_id"),
    itemName:   text("item_name").notNull(),
    unit:       text("unit"),
    orderedQty: numeric("ordered_qty", { precision: 18, scale: 4 }).default("0").notNull(),
    actualQty:  numeric("actual_qty",  { precision: 18, scale: 4 }).default("0").notNull(),
    notes:      text("notes"),
    sortOrder:  integer("sort_order").notNull().default(0),
  },
  (t) => ({
    byDoc: index("drdoc_lines_doc_idx").on(t.documentId),
  }),
);

// ─── Append-only audit trail ─────────────────────────────────────────────────
export const deliveryReceiptDocumentAuditTable = pgTable(
  "delivery_receipt_document_audit",
  {
    id:         serial("id").primaryKey(),
    companyId:  integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    documentId: integer("document_id").notNull().references(() => deliveryReceiptDocumentsTable.id, { onDelete: "cascade" }),
    action:     text("action").notNull(),                // 'create' | 'update' | 'approve' | 'send_email' | 'send_whatsapp' | 'print'
    userId:     integer("user_id"),
    userName:   text("user_name"),
    details:    jsonb("details"),
    at:         timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDoc: index("drdoc_audit_doc_idx").on(t.documentId, t.at),
  }),
);

// ─── Zod / types ─────────────────────────────────────────────────────────────
export const insertDeliveryReceiptDocumentSchema = createInsertSchema(
  deliveryReceiptDocumentsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertDeliveryReceiptDocumentLineSchema = createInsertSchema(
  deliveryReceiptDocumentLinesTable,
).omit({ id: true });

export type DeliveryReceiptDocument = typeof deliveryReceiptDocumentsTable.$inferSelect;
export type DeliveryReceiptDocumentLine = typeof deliveryReceiptDocumentLinesTable.$inferSelect;
export type DeliveryReceiptDocumentAudit = typeof deliveryReceiptDocumentAuditTable.$inferSelect;
export type InsertDeliveryReceiptDocument = z.infer<typeof insertDeliveryReceiptDocumentSchema>;
