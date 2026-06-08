import { db } from "@workspace/db";
import { customersTable, suppliersTable, accountsTable, branchesTable } from "@workspace/db";
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

  // ── Chart-of-accounts + branch lookups for the new linkage columns ────────
  // Loaded once per import. `takenCodes` is mutated in-memory as we mint
  // sub-accounts so a single run never produces a duplicate code across rows
  // (nextChildCode in entityAccounts only checks direct siblings — here we must
  // be globally collision-safe because we batch many customers under the same
  // parent in one transaction-less loop).
  const allAccounts = await db.select().from(accountsTable).where(eq(accountsTable.companyId, cid));
  const allBranches = await db.select().from(branchesTable).where(eq(branchesTable.companyId, cid));
  const accByCode = new Map<string, any>();
  const accById = new Map<number, any>();
  for (const a of allAccounts) {
    const c = (a.code ?? "").trim();
    if (c && !accByCode.has(c)) accByCode.set(c, a);
    if (a.id != null) accById.set(a.id, a);
  }
  const takenCodes = new Set<string>(allAccounts.map(a => (a.code ?? "").trim()).filter(Boolean));

  // Compute an account's TRUE depth from the parentId chain (root = level 1),
  // NOT the stored `level` column. The chart-of-accounts bulk-import persists
  // `level = 2` for every account that merely has a parent (regardless of how
  // deep it sits), so the stored value is unreliable for nested trees — the
  // UI itself draws the tree from the parentId chain. Walking the chain here
  // guarantees a customer minted under a level-4 parent lands at level 5.
  // `seen` guards against a corrupt cyclic parent reference.
  function accountDepth(acc: any): number {
    let depth = 1;
    let cur = acc;
    const seen = new Set<number>();
    while (cur?.parentId != null && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = accById.get(cur.parentId);
      if (!parent) break;
      depth++;
      cur = parent;
    }
    return depth;
  }
  const branchByKey = new Map<string, any>();
  for (const b of allBranches) {
    for (const key of [b.nameAr, b.nameEn, b.code]) {
      const k = (key ?? "").trim().toLowerCase();
      if (k && !branchByKey.has(k)) branchByKey.set(k, b);
    }
  }
  // Resolve the PARENT account by matching a branch name to an account name
  // (exact first, then "contains") — the convention the user follows when they
  // create one customer control account per branch in the chart of accounts.
  function findAccountByBranchName(name: string | null | undefined): any | null {
    const n = (name ?? "").trim().toLowerCase();
    if (!n) return null;
    let hit = allAccounts.find(a =>
      (a.nameAr ?? "").trim().toLowerCase() === n || (a.nameEn ?? "").trim().toLowerCase() === n);
    if (!hit) hit = allAccounts.find(a =>
      (a.nameAr ?? "").toLowerCase().includes(n) || (a.nameEn ?? "").toLowerCase().includes(n));
    return hit ?? null;
  }
  // Mint the next free sequential code under `parent` (numeric concat with a
  // zero-padded 4-digit suffix "10005"→"100050001", "100050002"…, dashed
  // "<parent>-NNN" fallback for non-numeric parents), insert the posting
  // sub-account, and demote the parent to a roll-up node.
  async function createPartySubAccount(parent: any, name: string): Promise<number> {
    const parentCode = (parent.code ?? "").trim();
    let code = "";
    if (/^\d+$/.test(parentCode)) {
      for (let nn = 1; nn < 10_000; nn++) {
        const cand = `${parentCode}${String(nn).padStart(4, "0")}`;
        if (!takenCodes.has(cand)) { code = cand; break; }
      }
    }
    if (!code) {
      const prefix = `${parentCode}-`;
      let seq = 1;
      for (const c of takenCodes) {
        if (c.startsWith(prefix)) {
          const v = parseInt(c.slice(prefix.length), 10);
          if (Number.isFinite(v) && v >= seq) seq = v + 1;
        }
      }
      do { code = `${prefix}${String(seq).padStart(3, "0")}`; seq++; } while (takenCodes.has(code));
    }
    const [created] = await db.insert(accountsTable).values({
      companyId: cid,
      parentId: parent.id,
      code,
      nameAr: name,
      accountType: "asset",
      reportDirection: parent.reportDirection ?? null,
      level: accountDepth(parent) + 1,
      isPosting: true,
      isActive: true,
    } as typeof accountsTable.$inferInsert).returning();
    takenCodes.add(code);
    if (parent.isPosting) {
      await db.update(accountsTable).set({ isPosting: false }).where(eq(accountsTable.id, parent.id));
      parent.isPosting = false;
    }
    return created.id;
  }

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

      // ── Branch + chart-of-accounts linkage (new master-data columns) ──────
      // Customers: `branch` sets branchId AND (via the `accountNumber` override
      // or by matching an account named after the branch) picks the PARENT
      // account under which a per-customer sub-account is auto-minted
      // (10005 → 100051, 100052 …). Suppliers: a single `accountNumber` column
      // links the supplier DIRECTLY to an existing account (no sub-account, no
      // numbering). A bad branch/account reference surfaces as a row error.
      let customerParent: any = null;
      if (isCustomer) {
        const branchText = txt(r.branch ?? r["الفرع"] ?? r.branchName);
        const acctText   = txt(r.accountNumber ?? r["رقم الحساب"] ?? r.account);
        let branch: any = null;
        if (branchText) {
          branch = branchByKey.get(branchText.toLowerCase()) ?? null;
          if (!branch) { errors.push({ row: i + 2, error: `الفرع غير موجود في النظام: ${branchText}` }); continue; }
          patch.branchId = branch.id;
        }
        if (acctText) {
          customerParent = accByCode.get(acctText) ?? null;
          if (!customerParent) { errors.push({ row: i + 2, error: `رقم الحساب الرئيسي غير موجود في شجرة الحسابات: ${acctText}` }); continue; }
        } else if (branch) {
          customerParent = findAccountByBranchName(branch.nameAr) ?? findAccountByBranchName(branch.nameEn);
          if (!customerParent) { errors.push({ row: i + 2, error: `لا يوجد حساب في شجرة الحسابات باسم الفرع: ${branch.nameAr}` }); continue; }
        }
      } else {
        const acctText = txt(r.accountNumber ?? r["رقم الحساب"] ?? r.account);
        if (acctText) {
          const acc = accByCode.get(acctText);
          if (!acc) { errors.push({ row: i + 2, error: `رقم الحساب غير موجود في شجرة الحسابات: ${acctText}` }); continue; }
          patch.accountId = acc.id; // direct link — persists on both insert and update
        }
      }

      // Resolve the ledger account id:
      //  - customer + resolved parent + (new row OR existing row with no account)
      //      → mint a sequential sub-account under that parent.
      //  - customer with no parent column → ensureCustomerLedger fallback.
      //  - supplier with explicit accountNumber → already set in patch.accountId.
      //  - supplier insert with no column → ensureSupplierLedger.
      // A genuine ledger-creation failure surfaces as a per-row error (caught
      // below) instead of silently inserting a party with no ledger.
      let accountId: number | null = match?.accountId ?? null;
      if (isCustomer) {
        if (customerParent && (!match || match.accountId == null)) {
          accountId = await createPartySubAccount(customerParent, nameAr);
          if (match) patch.accountId = accountId; // persist on the update path
        } else if (!match) {
          accountId = await ensureCustomerLedger(cid, nameAr);
        }
      } else {
        if (patch.accountId != null) {
          accountId = patch.accountId as number;
        } else if (!match) {
          accountId = await ensureSupplierLedger(cid, nameAr);
        }
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
