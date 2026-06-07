import { db } from "@workspace/db";
import {
  accountsTable, customersTable, suppliersTable,
  journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { and, eq, like, inArray, sql } from "drizzle-orm";
import { ensureCustomerLedger, ensureSupplierLedger } from "./entityAccounts.js";
import { loadMappings } from "./accountingMappings.js";
import { nextSequenceNumber } from "./sequences.js";
import { assertWritableForDate, assertWritableForPeriodId } from "./periodGuard.js";
import { createdAuditFor } from "./journalAudit.js";

type Party = "customer" | "supplier";

export interface OpeningImportResult {
  applied: number;
  total: number;
  errors: { row: number; error: string }[];
  entryId?: number;
  docNumber?: string | null;
}

/** Normalise a free-typed debit/credit indicator (Arabic or English). */
function normType(raw: any, fallback: "debit" | "credit"): "debit" | "credit" {
  const s = String(raw ?? "").trim().toLowerCase();
  if (["debit", "dr", "d", "مدين", "مدينة", "م"].includes(s)) return "debit";
  if (["credit", "cr", "c", "دائن", "دائنة", "د"].includes(s)) return "credit";
  return fallback;
}

/**
 * Bulk-import opening balances for customers or suppliers from a parsed
 * spreadsheet. Each row carries a party identifier (`id` from the exported
 * template, or a matching `name`), a `balance` amount, and a `type`
 * (مدين/دائن). All rows are aggregated into ONE balanced journal entry of
 * `entryType = "opening"`, saved as `status = "draft"` for manual review and
 * posting from مركز الترحيل.
 *
 * Re-running REPLACES the previous import: the prior opening JE created by this
 * importer (identified by a hidden marker in its description) is deleted before
 * the new one is inserted, so balances never double up.
 */
export async function importPartyOpeningBalances(opts: {
  req: any;
  cid: number;
  party: Party;
  rows: any[];
  date?: string;
}): Promise<OpeningImportResult> {
  const { req, cid, party, rows } = opts;
  const date = (opts.date && String(opts.date).trim()) || new Date().toISOString().slice(0, 10);
  const isCustomer = party === "customer";
  const marker = isCustomer ? "[ob:customers]" : "[ob:suppliers]";
  const label = isCustomer ? "الأرصدة الافتتاحية للعملاء" : "الأرصدة الافتتاحية للموردين";
  const defaultType: "debit" | "credit" = isCustomer ? "debit" : "credit";
  const notFoundMsg = isCustomer ? "العميل غير موجود" : "المورد غير موجود";

  if (!Array.isArray(rows) || rows.length === 0) {
    return { applied: 0, total: 0, errors: [] };
  }

  // Reject writing into a closed fiscal period before doing any work.
  const writability = await assertWritableForDate(cid, date);
  if (!writability.ok) {
    const err: any = new Error(writability.reason || "الفترة المالية مقفلة");
    err.status = 423;
    throw err;
  }

  // Load this company's parties once for id / name matching.
  const partyRows = isCustomer
    ? await db.select({ id: customersTable.id, nameAr: customersTable.nameAr, accountId: customersTable.accountId })
        .from(customersTable).where(eq(customersTable.companyId, cid))
    : await db.select({ id: suppliersTable.id, nameAr: suppliersTable.nameAr, accountId: suppliersTable.accountId })
        .from(suppliersTable).where(eq(suppliersTable.companyId, cid));
  const byId = new Map<number, typeof partyRows[number]>(partyRows.map(p => [Number(p.id), p]));
  const byName = new Map<string, typeof partyRows[number]>(
    partyRows.map(p => [String(p.nameAr ?? "").trim().toLowerCase(), p]),
  );

  const errors: { row: number; error: string }[] = [];
  const lines: { accountId: number; debit: string; credit: string; description: string }[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const rowNum = i + 2; // +1 for header row, +1 for 1-based display
    const rawBal = r.balance ?? r.openingBalance ?? r.amount ?? "";

    // Silently skip rows the user left blank (the exported template lists
    // every party; most rows will have no balance).
    if (rawBal === "" || rawBal == null) continue;

    const amount = parseFloat(String(rawBal).replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount === 0) {
      errors.push({ row: rowNum, error: "الرصيد غير صالح" });
      continue;
    }

    // Resolve the party by id first (robust), then by exact Arabic name.
    let p: typeof partyRows[number] | null = null;
    const idRaw = r.id ?? r.customerId ?? r.supplierId ?? r.partyId;
    if (idRaw != null && String(idRaw).trim() !== "" && Number.isFinite(Number(idRaw))) {
      p = byId.get(Number(idRaw)) ?? null;
    }
    if (!p) {
      const nm = String(r.name ?? r.nameAr ?? "").trim().toLowerCase();
      if (nm) p = byName.get(nm) ?? null;
    }
    if (!p) {
      errors.push({ row: rowNum, error: notFoundMsg });
      continue;
    }

    // Ensure the party has a posting ledger sub-account; create + persist one
    // the first time so future documents reuse it.
    let accId = p.accountId ?? null;
    if (!accId) {
      accId = isCustomer
        ? await ensureCustomerLedger(cid, p.nameAr ?? "")
        : await ensureSupplierLedger(cid, p.nameAr ?? "");
      if (accId) {
        if (isCustomer) {
          await db.update(customersTable).set({ accountId: accId }).where(eq(customersTable.id, p.id));
        } else {
          await db.update(suppliersTable).set({ accountId: accId }).where(eq(suppliersTable.id, p.id));
        }
      }
    }
    if (!accId) {
      errors.push({ row: rowNum, error: "تعذّر تحديد حساب الطرف (اضبط الحساب الأب في ربط الحسابات)" });
      continue;
    }

    const type = normType(r.type ?? r.balanceType, defaultType);
    // Round to 2dp BEFORE both the line write and the running totals so the
    // counter line nets to an exactly-balanced entry (no float drift).
    const abs = +Math.abs(amount).toFixed(2);
    if (type === "debit") {
      lines.push({ accountId: accId, debit: abs.toFixed(2), credit: "0", description: p.nameAr ?? label });
      totalDebit += abs;
    } else {
      lines.push({ accountId: accId, debit: "0", credit: abs.toFixed(2), description: p.nameAr ?? label });
      totalCredit += abs;
    }
  }

  const appliedCount = lines.length;

  // Resolve the counter account up front (when there is movement) so a
  // misconfigured COA fails BEFORE we touch any prior data.
  if (appliedCount > 0) {
    const mappedCounter = (await loadMappings(cid, "warehouse"))("warehouse", "opening_balance");
    let counterAccId = mappedCounter;
    if (!counterAccId) {
      const [acc] = await db.select({ id: accountsTable.id }).from(accountsTable)
        .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.code, "3301")));
      counterAccId = acc?.id ?? null;
    }
    if (!counterAccId) {
      const err: any = new Error("لم يتم العثور على حساب الرصيد الافتتاحي (3301). اضبطه في ربط الحسابات أولاً.");
      err.status = 400;
      throw err;
    }

    const net = +(totalDebit - totalCredit).toFixed(2);
    if (net > 0) {
      lines.push({ accountId: counterAccId, debit: "0", credit: net.toFixed(2), description: label });
    } else if (net < 0) {
      lines.push({ accountId: counterAccId, debit: Math.abs(net).toFixed(2), credit: "0", description: label });
    }
  }

  // Pre-allocate the doc number outside the transaction: nextSequenceNumber runs
  // its own atomic transaction, so calling it here avoids nesting a second pooled
  // connection inside our advisory-locked transaction below.
  let docNumber: string | null = null;
  if (appliedCount > 0) {
    try {
      docNumber = await nextSequenceNumber(cid, "journal_entry", {
        userId: req?.authUser?.id ?? null,
        refTable: "journal_entries",
        docDate: date,
      });
    } catch {
      docNumber = null;
    }
  }

  // Everything that mutates the ledger runs in ONE transaction guarded by a
  // per-company + per-party advisory lock, so two concurrent imports of the same
  // party type can't both pass the "find previous" check and double-insert.
  const lockKey = isCustomer ? 220101 : 220102;
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${cid}, ${lockKey})`);

    // REPLACE: find prior import JE(s) by marker. Block the replace if any of
    // them sits in a closed/locked fiscal period — deleting it would silently
    // mutate locked-period history.
    const prev = await tx.select({
      id: journalEntriesTable.id,
      periodId: journalEntriesTable.periodId,
    }).from(journalEntriesTable).where(and(
      eq(journalEntriesTable.companyId, cid),
      eq(journalEntriesTable.entryType, "opening"),
      like(journalEntriesTable.description, `%${marker}%`),
    ));
    for (const pr of prev) {
      const g = await assertWritableForPeriodId(cid, pr.periodId);
      if (!g.ok) {
        const err: any = new Error(
          `لا يمكن استبدال الأرصدة الافتتاحية السابقة لأن قيدها يقع في فترة مقفلة: ${g.reason || ""}`.trim(),
        );
        err.status = 423;
        throw err;
      }
    }
    if (prev.length) {
      await tx.delete(journalEntriesTable).where(inArray(journalEntriesTable.id, prev.map(p => p.id)));
    }

    // Zero applied lines means the re-upload cleared all balances — honour the
    // "re-upload = full replace" contract by leaving NO opening JE behind.
    if (appliedCount === 0) {
      return { applied: 0, total: rows.length, errors };
    }

    const [entry] = await tx.insert(journalEntriesTable).values({
      companyId: cid,
      docNumber,
      entryDate: date,
      currency: "SAR",
      exchangeRate: "1",
      description: `${label} ${marker}`,
      entryType: "opening",
      branchId: null,
      periodId: writability.period?.id ?? null,
      status: "draft",
      ...createdAuditFor(req),
    }).returning();

    // Legacy QYD fallback when no central sequence is configured.
    if (!docNumber) {
      const result = await tx.execute<{ next: number }>(sql`
        SELECT COALESCE(MAX(
          CASE WHEN doc_number ~ '^QYD-[0-9]+$'
               THEN (regexp_replace(doc_number, '^QYD-', ''))::int ELSE 0 END
        ), 0) + 1 AS next
        FROM journal_entries
        WHERE company_id = ${cid} AND id <> ${entry.id}
      `);
      const next = Number((result as any).rows?.[0]?.next ?? 1);
      docNumber = `QYD-${String(next).padStart(4, "0")}`;
      await tx.update(journalEntriesTable).set({ docNumber }).where(eq(journalEntriesTable.id, entry.id));
    }

    await tx.insert(journalEntryLinesTable).values(lines.map((l, i) => ({
      entryId: entry.id,
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      description: l.description,
      sortOrder: i,
    })));

    return { applied: appliedCount, total: rows.length, errors, entryId: entry.id, docNumber };
  });
}
