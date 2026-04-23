import { db } from "@workspace/db";
import { accountingMappingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export type MappingLookup = (documentType: string, roleKey: string) => number | null;

export async function loadMappings(companyId: number, documentType: string): Promise<MappingLookup> {
  const rows = await db.select().from(accountingMappingsTable)
    .where(and(
      eq(accountingMappingsTable.companyId, companyId),
      eq(accountingMappingsTable.documentType, documentType),
    ));
  const byRole = new Map<string, number | null>();
  for (const r of rows) byRole.set(r.roleKey, r.accountId ?? null);
  return (_dt, roleKey) => byRole.get(roleKey) ?? null;
}

export function pickAccount(current: number | null | undefined, mapped: number | null): number | null {
  return current ?? mapped ?? null;
}
