import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Cloud-stored archived document files. The actual bytes live in object
// storage (see lib/objectStorage); this table is the per-tenant index that
// links a screen + business-document key (docKey) to the stored object path.
//
//   screenKey  — which form created it (e.g. "journal_entries", "sales_invoices")
//   docKey     — stable identifier of the specific document being archived
//                (mirrors the client-side `jeKey`, e.g. "journal_entries:42")
//   objectPath — "/objects/<id>" path returned by the upload-url endpoint,
//                served back through GET /api/storage/objects/*.
export const documentArchivesTable = pgTable(
  "document_archives",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    screenKey: text("screen_key").notNull(),
    docKey: text("doc_key").notNull(),
    filename: text("filename").notNull(),
    objectPath: text("object_path").notNull(),
    contentType: text("content_type"),
    bytes: integer("bytes"),
    pages: integer("pages"),
    uploadedBy: integer("uploaded_by"),
    uploadedByName: text("uploaded_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDoc: index("document_archives_company_screen_doc_idx").on(
      t.companyId,
      t.screenKey,
      t.docKey,
    ),
  }),
);

export const insertDocumentArchiveSchema = createInsertSchema(documentArchivesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertDocumentArchive = z.infer<typeof insertDocumentArchiveSchema>;
export type DocumentArchive = typeof documentArchivesTable.$inferSelect;
