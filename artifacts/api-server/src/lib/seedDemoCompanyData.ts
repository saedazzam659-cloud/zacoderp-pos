// ── DEMO-EDITION SEED ────────────────────────────────────────────────
// When the SuperAdmin creates a company as "نسخة ديمو" from the add-company
// screen, we pre-seed the master data a brand-new user would otherwise
// have to create by hand before issuing their first invoice:
//   • فرع رئيسي        (main branch)
//   • مخزن رئيسي       (default warehouse, linked to the branch, with its
//                        auto-minted GL sub-account when possible)
//   • وحدة قياس        (حبة)
//   • مجموعة أصناف      (مجموعة عامة)
//   • صنف تجريبي        (linked to the unit + group)
//   • عميل نقدي         (+ ledger sub-account)
//   • مورد محلي         (+ ledger sub-account)
// The default CURRENCY is already seeded by /register itself from the
// selected country — nothing currency-related happens here.
//
// Every step is individually fail-safe: a failure is logged and the rest
// of the seed continues; the company registration itself is NEVER blocked.
import { db } from "@workspace/db";
import {
  branchesTable,
  warehousesTable,
  unitsTable,
  itemGroupsTable,
  itemsTable,
  customersTable,
  suppliersTable,
} from "@workspace/db";
import {
  ensureWarehouseAccount,
  ensureCustomerLedger,
  ensureSupplierLedger,
} from "./entityAccounts.js";

type Logger = { info?: (o: unknown, msg?: string) => void; warn?: (o: unknown, msg?: string) => void };

export async function seedDemoCompanyData(
  companyId: number,
  opts: { country: string; currencyCode: string },
  log?: Logger,
): Promise<{ seeded: string[] }> {
  const seeded: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); seeded.push(name); }
    catch (err) { log?.warn?.({ err, companyId, step: name }, "demo seed step failed"); }
  };

  let branchId: number | null = null;
  await step("branch", async () => {
    const [b] = await db.insert(branchesTable).values({
      companyId, code: "BR-0001", nameAr: "الفرع الرئيسي", isMain: true, status: "active",
    }).returning();
    branchId = b.id;
  });

  await step("warehouse", async () => {
    let accountId: number | null = null;
    try { accountId = await ensureWarehouseAccount(companyId, "المخزن الرئيسي"); }
    catch (err) { log?.warn?.({ err, companyId }, "demo seed: warehouse account mint failed"); }
    await db.insert(warehousesTable).values({
      companyId, code: "WH-0001", nameAr: "المخزن الرئيسي",
      branchId, isDefault: true, accountId,
    });
  });

  let unitId: number | null = null;
  await step("unit", async () => {
    const [u] = await db.insert(unitsTable).values({
      companyId, code: "UNT-0001", nameAr: "حبة", conversionFactor: "1",
    }).returning();
    unitId = u.id;
  });

  let groupId: number | null = null;
  await step("itemGroup", async () => {
    const [g] = await db.insert(itemGroupsTable).values({
      companyId, code: "GRP-0001", nameAr: "مجموعة عامة",
    }).returning();
    groupId = g.id;
  });

  await step("item", async () => {
    await db.insert(itemsTable).values({
      companyId, code: "ITM-0001", nameAr: "صنف تجريبي",
      unitId, groupId,
    });
  });

  await step("customer", async () => {
    let accountId: number | null = null;
    try { accountId = await ensureCustomerLedger(companyId, "عميل نقدي"); }
    catch (err) { log?.warn?.({ err, companyId }, "demo seed: customer ledger mint failed"); }
    await db.insert(customersTable).values({
      companyId, nameAr: "عميل نقدي", accountId, branchId,
    } as typeof customersTable.$inferInsert);
  });

  await step("supplier", async () => {
    let accountId: number | null = null;
    try { accountId = await ensureSupplierLedger(companyId, "مورد محلي"); }
    catch (err) { log?.warn?.({ err, companyId }, "demo seed: supplier ledger mint failed"); }
    await db.insert(suppliersTable).values({
      // «محلي» = محلي بالنسبة لدولة الشركة المختارة — لا نفترض السعودية.
      companyId, code: "SUP-0001", nameAr: "مورد محلي", accountId, branchId,
      country: opts.country, currencyCode: opts.currencyCode,
    } as typeof suppliersTable.$inferInsert);
  });

  return { seeded };
}
