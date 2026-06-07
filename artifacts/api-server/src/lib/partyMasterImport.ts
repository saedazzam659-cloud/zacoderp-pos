import { db } from "@workspace/db";
import { customersTable, suppliersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ensureCustomerLedger, ensureSupplierLedger } from "./entityAccounts.js";

type Party = "customer" | "supplier";

export interface MasterImportResult {
  created: number;
  updated: number;
  total: number;
  errors: { row: number; error: string }[];
}

/** Trim a free-typed cell into a non-empty string, or null when blank. */
function txt(v: any): string | null {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
}

/** Coerce a money cell into a non-negative numeric string, or null when blank. */
function money(v: any): string | null {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return (n < 0 ? 0 : n).toFixed(2);
}

/**
 * Bulk-import customer or supplier MASTER DATA (names, tax/CR numbers, address,
 * contact, credit terms) from a parsed spreadsheet. This mirrors the items
 * master-data importer: each row is upserted, never aggregated into a JE — it
 * carries NO opening balance.
 *
 * Matching precedence (first hit wins):
 *   - supplier: code → vatNumber → nameAr (case-insensitive)
 *   - customer: vatNumber → nameAr (customers have no `code` column)
 * A match → UPDATE; otherwise INSERT (with an auto-created AR/AP sub-account via
 * ensureCustomerLedger / ensureSupplierLedger, matching the POST routes).
 *
 * Blank cells NEVER overwrite existing values: only columns with a real value
 * are written, so a partial re-upload won't wipe data the row already had.
 * `nameAr` is the only required column.
 */
export async function importPartyMasterData(opts: {
  req: any;
  cid: number;
  party: Party;
  rows: any[];
}): Promise<MasterImportResult> {
  const { cid, party, rows } = opts;
  const isCustomer = party === "customer";

  if (!Array.isArray(rows) || rows.length === 0) {
    return { created: 0, updated: 0, total: 0, errors: [] };
  }

  const existing = isCustomer
    ? await db.select().from(customersTable).where(eq(customersTable.companyId, cid))
    : await db.select().from(suppliersTable).where(eq(suppliersTable.companyId, cid));

  const byVat  = new Map<string, any>();
  const byName = new Map<string, any>();
  const byCode = new Map<string, any>();
  const index = (r: any) => {
    if (r.vatNumber) byVat.set(String(r.vatNumber).trim(), r);
    if (r.nameAr)    byName.set(String(r.nameAr).trim().toLowerCase(), r);
    if (!isCustomer && r.code) byCode.set(String(r.code).trim().toLowerCase(), r);
  };
  // Drop a row's OLD keys before re-indexing the updated row, so that a later
  // row in the SAME batch can't match a stale key after an earlier update
  // changed this record's vat/code/name. Guarded with identity checks so we
  // never evict a key that legitimately points at a different record.
  const deindex = (r: any) => {
    const v = r.vatNumber && String(r.vatNumber).trim();
    if (v && byVat.get(v) === r) byVat.delete(v);
    const n = r.nameAr && String(r.nameAr).trim().toLowerCase();
    if (n && byName.get(n) === r) byName.delete(n);
    if (!isCustomer && r.code) {
      const c = String(r.code).trim().toLowerCase();
      if (byCode.get(c) === r) byCode.delete(c);
    }
  };
  for (const r of existing) index(r);

  // Concrete per-party mutators keep Drizzle's column types narrow (a shared
  // `table` union would lose the `.set(...)` / `.values(...)` typing).
  async function upsertRow(matchId: number | null, patch: Record<string, any>, accountId: number | null) {
    if (isCustomer) {
      if (matchId != null) {
        const [row] = await db.update(customersTable).set(patch).where(eq(customersTable.id, matchId)).returning();
        return row;
      }
      const [row] = await db.insert(customersTable)
        .values({ companyId: cid, accountId, ...patch, country: patch.country ?? "SA" } as typeof customersTable.$inferInsert)
        .returning();
      return row;
    } else {
      if (matchId != null) {
        const [row] = await db.update(suppliersTable).set(patch).where(eq(suppliersTable.id, matchId)).returning();
        return row;
      }
      const [row] = await db.insert(suppliersTable)
        .values({ companyId: cid, accountId, ...patch, country: patch.country ?? "SA" } as typeof suppliersTable.$inferInsert)
        .returning();
      return row;
    }
  }

  let created = 0, updated = 0;
  const errors: { row: number; error: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const nameAr = txt(r.nameAr ?? r.name);
      if (!nameAr) { errors.push({ row: i + 2, error: "الاسم العربي للطرف مطلوب" }); continue; }

      // Build a patch of ONLY the provided columns (blank cells are skipped so
      // they never clobber existing data on an update).
      const patch: Record<string, any> = { nameAr };
      const setIf = (k: string, val: any) => { if (val !== null && val !== undefined) patch[k] = val; };
      setIf("nameEn",         txt(r.nameEn));
      setIf("vatNumber",      txt(r.vatNumber));
      setIf("crNumber",       txt(r.crNumber));
      setIf("email",          txt(r.email));
      setIf("phone",          txt(r.phone));
      setIf("city",           txt(r.city));
      setIf("district",       txt(r.district));
      setIf("street",         txt(r.street));
      setIf("buildingNumber", txt(r.buildingNumber));
      setIf("postalCode",     txt(r.postalCode));
      setIf("country",        txt(r.country));
      setIf("creditLimit",    money(r.creditLimit));
      if (isCustomer) {
        const pt = r.paymentTermsDays;
        if (pt !== undefined && pt !== null && String(pt).trim() !== "") {
          const n = Number(pt);
          if (Number.isFinite(n) && n >= 0) patch.paymentTermsDays = Math.floor(n);
        }
      } else {
        setIf("code",         txt(r.code));
        setIf("currencyCode", txt(r.currencyCode));
      }

      // Resolve an existing row by the party-specific key precedence.
      const vat  = patch.vatNumber as string | undefined;
      const code = (patch.code as string | undefined)?.toLowerCase();
      let match: any = null;
      if (!isCustomer && code && byCode.has(code)) match = byCode.get(code);
      if (!match && vat && byVat.has(vat)) match = byVat.get(vat);
      if (!match && byName.has(nameAr.toLowerCase())) match = byName.get(nameAr.toLowerCase());

      // On insert, create the AR/AP sub-account. A genuine failure must surface
      // as a row error (caught below) instead of silently inserting a party
      // with no ledger; a legitimate null (no parent account mapped yet) is
      // allowed through, matching the single-create route's behaviour.
      let accountId: number | null = match?.accountId ?? null;
      if (!match) {
        accountId = isCustomer
          ? await ensureCustomerLedger(cid, nameAr)
          : await ensureSupplierLedger(cid, nameAr);
      }

      if (match) deindex(match);
      const row = await upsertRow(match ? match.id : null, patch, accountId);
      if (row) index(row);
      if (match) updated++; else created++;
    } catch (e: any) {
      errors.push({ row: i + 2, error: e?.message || "خطأ غير معروف" });
    }
  }

  return { created, updated, total: rows.length, errors };
}
