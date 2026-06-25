import { db, extRecordsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ExtensionManifest } from "./manifest.js";
import type { ExtensionContext } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────
// Extension data store — the additive "ext_* tables" runtime.
//
// An extension declares logical "tables" (collections) in its SIGNED manifest.
// Their rows live in the generic, tenant-scoped `ext_records` table — the
// extension NEVER creates DDL and NEVER touches a core table. Every operation
// here is hard-scoped by (company_id, extension_id, collection); an extension
// can only ever see its OWN rows for the caller's OWN tenant.
// ─────────────────────────────────────────────────────────────────────────

export class DataStoreError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export interface DataRecord {
  id: string;
  collection: string;
  data: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

function clampLimit(n: number | undefined): number {
  if (!Number.isFinite(n) || !n || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n as number), MAX_LIMIT);
}

function requireCompany(ctx: ExtensionContext): number {
  if (ctx.companyId == null) throw new DataStoreError(400, "EXT_NO_COMPANY", "لم يتم تحديد الشركة");
  return ctx.companyId;
}

// A write/read is allowed only for a collection the SIGNED manifest declares.
function requireDeclared(manifest: ExtensionManifest, collection: string): void {
  const ok = (manifest.tables ?? []).some((t) => t.key === collection);
  if (!ok) {
    throw new DataStoreError(
      404,
      "EXT_COLLECTION_NOT_DECLARED",
      `المجموعة غير معرّفة في البيان: ${collection}`,
    );
  }
}

function toRecord(row: typeof extRecordsTable.$inferSelect): DataRecord {
  return {
    id: row.recordId,
    collection: row.collection,
    data: row.data,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export async function dataList(
  manifest: ExtensionManifest,
  ctx: ExtensionContext,
  extensionId: string,
  collection: string,
  opts: { limit?: number } = {},
): Promise<DataRecord[]> {
  requireDeclared(manifest, collection);
  const companyId = requireCompany(ctx);
  const rows = await db
    .select()
    .from(extRecordsTable)
    .where(
      and(
        eq(extRecordsTable.companyId, companyId),
        eq(extRecordsTable.extensionId, extensionId),
        eq(extRecordsTable.collection, collection),
      ),
    )
    .orderBy(desc(extRecordsTable.id))
    .limit(clampLimit(opts.limit));
  return rows.map(toRecord);
}

export async function dataGet(
  manifest: ExtensionManifest,
  ctx: ExtensionContext,
  extensionId: string,
  collection: string,
  recordId: string,
): Promise<DataRecord> {
  requireDeclared(manifest, collection);
  const companyId = requireCompany(ctx);
  const [row] = await db
    .select()
    .from(extRecordsTable)
    .where(
      and(
        eq(extRecordsTable.companyId, companyId),
        eq(extRecordsTable.extensionId, extensionId),
        eq(extRecordsTable.collection, collection),
        eq(extRecordsTable.recordId, recordId),
      ),
    )
    .limit(1);
  if (!row) throw new DataStoreError(404, "EXT_RECORD_NOT_FOUND", "السجل غير موجود");
  return toRecord(row);
}

export async function dataCreate(
  manifest: ExtensionManifest,
  ctx: ExtensionContext,
  extensionId: string,
  collection: string,
  data: unknown,
): Promise<DataRecord> {
  requireDeclared(manifest, collection);
  const companyId = requireCompany(ctx);
  const recordId = randomUUID();
  const [row] = await db
    .insert(extRecordsTable)
    .values({
      companyId,
      extensionId,
      collection,
      recordId,
      data: (data ?? {}) as object,
    })
    .returning();
  return toRecord(row);
}

export async function dataUpdate(
  manifest: ExtensionManifest,
  ctx: ExtensionContext,
  extensionId: string,
  collection: string,
  recordId: string,
  data: unknown,
): Promise<DataRecord> {
  requireDeclared(manifest, collection);
  const companyId = requireCompany(ctx);
  const [row] = await db
    .update(extRecordsTable)
    .set({ data: (data ?? {}) as object, updatedAt: new Date() })
    .where(
      and(
        eq(extRecordsTable.companyId, companyId),
        eq(extRecordsTable.extensionId, extensionId),
        eq(extRecordsTable.collection, collection),
        eq(extRecordsTable.recordId, recordId),
      ),
    )
    .returning();
  if (!row) throw new DataStoreError(404, "EXT_RECORD_NOT_FOUND", "السجل غير موجود");
  return toRecord(row);
}

export async function dataRemove(
  manifest: ExtensionManifest,
  ctx: ExtensionContext,
  extensionId: string,
  collection: string,
  recordId: string,
): Promise<{ ok: true; id: string }> {
  requireDeclared(manifest, collection);
  const companyId = requireCompany(ctx);
  const rows = await db
    .delete(extRecordsTable)
    .where(
      and(
        eq(extRecordsTable.companyId, companyId),
        eq(extRecordsTable.extensionId, extensionId),
        eq(extRecordsTable.collection, collection),
        eq(extRecordsTable.recordId, recordId),
      ),
    )
    .returning({ recordId: extRecordsTable.recordId });
  if (rows.length === 0) throw new DataStoreError(404, "EXT_RECORD_NOT_FOUND", "السجل غير موجود");
  return { ok: true, id: recordId };
}
