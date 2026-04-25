import { db } from "@workspace/db";
import { accountingMappingsTable, accountsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

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

// ───────────────────────────────────────────────────────────────────────────
// DEFAULT MAPPING TEMPLATE
// ───────────────────────────────────────────────────────────────────────────
//
// This list is the canonical "out-of-the-box" wiring between document roles
// and Chart-of-Accounts entries identified by their numeric `code`.  It is
// the source of truth for two flows:
//
//   1. Auto-seeding immediately after a tenant imports the standard COA via
//      POST /api/accounts/bulk-import.  The bulk-import handler calls
//      `seedDefaultAccountingMappings(cid)` so that a brand-new company
//      walks straight into a fully-wired ledger without anyone having to
//      open the mappings page.
//
//   2. The manual "تطبيق الربط الافتراضي" button in the UI, exposed through
//      POST /api/accounting-mappings/seed-defaults — useful for tenants who
//      created accounts ad-hoc, deleted some mappings, or want to re-apply
//      the template after editing the COA.
//
// Each entry's `accountCode` is matched against `accounts.code` for the
// current company.  Missing accounts are silently skipped — the seeder
// never invents accounts; that's the COA-template's job.  Roles that the
// spreadsheet leaves intentionally blank (cash/bank lines on settlements,
// inventory_source/destination on transfers, etc.) are omitted here so we
// never blindly point them at the wrong account; the user sets those in
// the UI when their cashbox/bank/warehouse hierarchy is in place.

export interface DefaultMapping {
  documentType: string;
  roleKey:      string;
  accountCode:  string;
}

export const DEFAULT_MAPPINGS: DefaultMapping[] = [
  // فواتير المشتريات
  { documentType: "purchase_invoice", roleKey: "inventory",          accountCode: "11051" },
  { documentType: "purchase_invoice", roleKey: "vat_input",          accountCode: "11071" },
  { documentType: "purchase_invoice", roleKey: "payable",            accountCode: "21011" },
  { documentType: "purchase_invoice", roleKey: "discount",           accountCode: "4103"  },

  // مرتجع المشتريات
  { documentType: "purchase_return",  roleKey: "payable",            accountCode: "21011" },
  { documentType: "purchase_return",  roleKey: "inventory",          accountCode: "11051" },
  { documentType: "purchase_return",  roleKey: "vat_input",          accountCode: "11071" },

  // فواتير المبيعات
  { documentType: "sales_invoice",    roleKey: "receivable",         accountCode: "11031" },
  { documentType: "sales_invoice",    roleKey: "revenue",            accountCode: "4101"  },
  { documentType: "sales_invoice",    roleKey: "vat_output",         accountCode: "21041" },
  { documentType: "sales_invoice",    roleKey: "cogs",               accountCode: "5101"  },
  { documentType: "sales_invoice",    roleKey: "inventory",          accountCode: "11051" },

  // مرتجع المبيعات
  { documentType: "sales_return",     roleKey: "revenue_return",     accountCode: "4101"  },
  { documentType: "sales_return",     roleKey: "vat_output",         accountCode: "21041" },
  { documentType: "sales_return",     roleKey: "receivable",         accountCode: "11031" },
  { documentType: "sales_return",     roleKey: "inventory",          accountCode: "11051" },
  { documentType: "sales_return",     roleKey: "cogs",               accountCode: "5101"  },

  // تسوية العملاء
  { documentType: "customer_settlement", roleKey: "cash",            accountCode: "11011" },
  { documentType: "customer_settlement", roleKey: "bank",            accountCode: "11021" },
  { documentType: "customer_settlement", roleKey: "receivable",      accountCode: "11031" },

  // المخازن
  { documentType: "warehouse",            roleKey: "inventory",       accountCode: "11051" },
  { documentType: "warehouse",            roleKey: "opening_balance", accountCode: "3301"  },

  // تسوية المخازن
  { documentType: "warehouse_adjustment", roleKey: "inventory",        accountCode: "11051" },
  { documentType: "warehouse_adjustment", roleKey: "adjustment_gain",  accountCode: "4104"  },
  { documentType: "warehouse_adjustment", roleKey: "adjustment_loss",  accountCode: "5504"  },

  // الخزن (الصناديق النقدية)
  { documentType: "cashbox",              roleKey: "cash_on_hand",    accountCode: "11011" },

  // البنوك
  { documentType: "bank",                 roleKey: "bank_main",       accountCode: "11021" },
  { documentType: "bank",                 roleKey: "bank_fees",       accountCode: "5212"  },

  // الاعتمادات المستندية
  { documentType: "letter_of_credit",     roleKey: "lc_margin",       accountCode: "1150"  },
  { documentType: "letter_of_credit",     roleKey: "lc_liability",    accountCode: "2150"  },
  { documentType: "letter_of_credit",     roleKey: "lc_commission",   accountCode: "5830"  },
  { documentType: "letter_of_credit",     roleKey: "lc_expenses",     accountCode: "5835"  },
  { documentType: "letter_of_credit",     roleKey: "lc_fx_diff",      accountCode: "5840"  },
];

export interface SeedDefaultsResult {
  /** Mappings actually inserted (a row that didn't exist before). */
  inserted: number;
  /** Mappings updated (overwrite=true and the role was already wired). */
  updated:  number;
  /** Template entries skipped because the company doesn't have that COA code. */
  skippedMissingAccount: number;
  /** Template entries skipped because a mapping already exists (overwrite=false). */
  skippedAlreadyMapped:  number;
  /** When >0, the names of the COA codes the template references but the
      tenant doesn't yet have — handy for the UI to nudge "import COA first". */
  missingAccountCodes: string[];
}

/**
 * Apply the canonical accounting-mapping template to a company's books.
 *
 * Behaviour notes:
 *   • Pure additive by default (`overwrite=false`): never touches a
 *     `(documentType, roleKey)` row that already exists, so it's safe to
 *     run repeatedly and safe to chain after bulk-import without nuking
 *     hand-tuned wiring.
 *   • Locked rows (`is_locked = true`) are NEVER overwritten regardless
 *     of the flag — accountants explicitly pin those.
 *   • Looks up accounts by `code` for THIS tenant only — there's no
 *     cross-tenant leak, even though `accounts.id` is a global serial.
 */
export async function seedDefaultAccountingMappings(
  companyId: number,
  opts: { overwrite?: boolean } = {},
): Promise<SeedDefaultsResult> {
  const overwrite = !!opts.overwrite;

  // 1. Look up every account the template refers to, in one round-trip.
  const wantedCodes = Array.from(new Set(DEFAULT_MAPPINGS.map((m) => m.accountCode)));
  const accounts = await db.select({
    id:   accountsTable.id,
    code: accountsTable.code,
  }).from(accountsTable).where(and(
    eq(accountsTable.companyId, companyId),
    inArray(accountsTable.code, wantedCodes),
  ));
  const codeToId = new Map<string, number>();
  for (const a of accounts) codeToId.set(a.code, a.id);

  const missingAccountCodes = wantedCodes.filter((c) => !codeToId.has(c));

  // 2. Snapshot the existing mapping rows (to know what's already there
  //    and which ones are locked).
  const existing = await db.select().from(accountingMappingsTable)
    .where(eq(accountingMappingsTable.companyId, companyId));
  const existingByKey = new Map<string, { id: number; isLocked: boolean; accountId: number | null }>();
  for (const r of existing) {
    existingByKey.set(`${r.documentType}::${r.roleKey}`, {
      id: r.id, isLocked: r.isLocked, accountId: r.accountId,
    });
  }

  let inserted = 0, updated = 0;
  let skippedMissingAccount = 0, skippedAlreadyMapped = 0;

  // 3. Run the whole template inside a transaction so a mid-loop conflict
  //    (e.g. another concurrent /seed-defaults call racing on the same
  //    tenant) can't leave the company half-seeded.  Inserts use
  //    `onConflictDoNothing` against the (company, doc_type, role_key)
  //    unique index so a concurrent insert silently no-ops instead of
  //    blowing up the whole transaction.
  await db.transaction(async (tx) => {
    for (const m of DEFAULT_MAPPINGS) {
      const accountId = codeToId.get(m.accountCode);
      if (!accountId) { skippedMissingAccount++; continue; }

      const key = `${m.documentType}::${m.roleKey}`;
      const cur = existingByKey.get(key);

      if (!cur) {
        const ret = await tx.insert(accountingMappingsTable).values({
          companyId,
          documentType: m.documentType,
          roleKey:      m.roleKey,
          accountId,
        }).onConflictDoNothing({
          target: [
            accountingMappingsTable.companyId,
            accountingMappingsTable.documentType,
            accountingMappingsTable.roleKey,
          ],
        }).returning({ id: accountingMappingsTable.id });
        if (ret.length > 0) inserted++;
        else skippedAlreadyMapped++; // A concurrent caller beat us to it.
        continue;
      }

      if (cur.isLocked) { skippedAlreadyMapped++; continue; }

      if (!overwrite) {
        // Even a row whose accountId is NULL counts as "already exists" for
        // the additive default — the user may have intentionally cleared it.
        skippedAlreadyMapped++;
        continue;
      }

      if (cur.accountId === accountId) { skippedAlreadyMapped++; continue; }

      // Re-check is_locked at write time to avoid a TOCTOU race where the
      // user locks the row between our snapshot and this UPDATE.
      const ret = await tx.update(accountingMappingsTable)
        .set({ accountId, updatedAt: sql`now()` })
        .where(and(
          eq(accountingMappingsTable.id, cur.id),
          eq(accountingMappingsTable.isLocked, false),
        ))
        .returning({ id: accountingMappingsTable.id });
      if (ret.length > 0) updated++;
      else skippedAlreadyMapped++;
    }
  });

  return { inserted, updated, skippedMissingAccount, skippedAlreadyMapped, missingAccountCodes };
}
