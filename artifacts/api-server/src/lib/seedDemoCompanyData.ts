// Demo master-data seed.  This deliberately runs as one transaction: a demo
// tenant is useful only when its references form a complete, tenant-local set.
import { db } from "@workspace/db";
import {
  bankAccountsTable, branchesTable, cashBoxesTable, currenciesTable,
  customersTable, itemGroupsTable, itemsTable, suppliersTable, unitsTable, warehousesTable,
} from "@workspace/db";
import { and, eq, or, sql } from "drizzle-orm";
import {
  ensureBankAccountLedger, ensureCashBoxAccount, ensureCustomerLedger,
  ensureSupplierLedger, ensureWarehouseAccount,
} from "./entityAccounts.js";

type Logger = { info?: (o: unknown, msg?: string) => void; warn?: (o: unknown, msg?: string) => void };
type SeedResult = { seeded: string[]; reused: string[]; repaired: string[] };
type Tx = any;

const DEMO = {
  branch: { code: "BR-0001", name: "الفرع الرئيسي" },
  warehouse: { code: "WH-0001", name: "المخزن الرئيسي" },
  unit: { code: "UNT-0001", name: "حبة" },
  group: { code: "GRP-0001", name: "مجموعة عامة" },
  item: { code: "ITM-0001", name: "صنف تجريبي" },
  customer: "عميل نقدي",
  supplier: { code: "SUP-0001", name: "مورد محلي" },
  bank: { code: "BNK-0001", name: "البنك العام" },
  cash: { code: "CSH-0001", name: "الخزنة الرئيسية" },
} as const;

/** Pick an existing demo row by stable code/name, without ever reading another tenant. */
async function findDemo(tx: Tx, table: any, companyId: number, code: string | null, name: string) {
  const matches: any[] = [];
  if (code) matches.push(eq(table.code, code));
  matches.push(eq(table.nameAr, name));
  const rows = await tx.select().from(table).where(and(eq(table.companyId, companyId), or(...matches)));
  return rows.find((r: any) => code && r.code === code) ?? rows.find((r: any) => r.nameAr === name) ?? null;
}

export async function seedDemoCompanyData(
  companyId: number,
  opts: { country: string; currencyCode: string },
  log?: Logger,
): Promise<SeedResult> {
  const result: SeedResult = { seeded: [], reused: [], repaired: [] };
  const mark = (name: string, state: keyof SeedResult) => result[state].push(name);

  try {
    await db.transaction(async (tx) => {
      // Serialize all seed/retry callers for this tenant before any lookup.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${companyId})`);
      // SAR is intentionally the demo base currency, irrespective of a
      // registration request's preferred currency.
      let currency = await findDemo(tx, currenciesTable, companyId, "SAR", "ريال سعودي");
      if (!currency) {
        [currency] = await tx.insert(currenciesTable).values({
          companyId, code: "SAR", nameAr: "ريال سعودي", nameEn: "Saudi Riyal", symbol: "ر.س", isDefault: true,
        }).returning();
        mark("SAR", "seeded");
      } else mark("SAR", "reused");
      await tx.update(currenciesTable).set({ isDefault: false })
        .where(eq(currenciesTable.companyId, companyId));
      await tx.update(currenciesTable).set({ isDefault: true, isActive: true })
        .where(and(eq(currenciesTable.id, currency.id), eq(currenciesTable.companyId, companyId)));

      let branch = await findDemo(tx, branchesTable, companyId, DEMO.branch.code, DEMO.branch.name);
      if (!branch) {
        [branch] = await tx.insert(branchesTable).values({
          companyId, code: DEMO.branch.code, nameAr: DEMO.branch.name, isMain: true, status: "active",
        }).returning();
        mark("main branch", "seeded");
      } else mark("main branch", "reused");
      await tx.update(branchesTable).set({ isMain: false }).where(eq(branchesTable.companyId, companyId));
      await tx.update(branchesTable).set({ isMain: true, status: "active" })
        .where(and(eq(branchesTable.id, branch.id), eq(branchesTable.companyId, companyId)));

      let warehouse = await findDemo(tx, warehousesTable, companyId, DEMO.warehouse.code, DEMO.warehouse.name);
      const warehouseAccountId = await ensureWarehouseAccount(companyId, DEMO.warehouse.name, tx);
      if (!warehouse) {
        [warehouse] = await tx.insert(warehousesTable).values({
          companyId, code: DEMO.warehouse.code, nameAr: DEMO.warehouse.name, branchId: branch.id,
          isDefault: true, accountId: warehouseAccountId,
        }).returning();
        mark("main warehouse", "seeded");
      } else {
        await tx.update(warehousesTable).set({ branchId: branch.id, accountId: warehouseAccountId, isActive: true })
          .where(and(eq(warehousesTable.id, warehouse.id), eq(warehousesTable.companyId, companyId)));
        mark("main warehouse", "reused");
      }
      await tx.update(warehousesTable).set({ isDefault: false }).where(eq(warehousesTable.companyId, companyId));
      await tx.update(warehousesTable).set({ isDefault: true })
        .where(and(eq(warehousesTable.id, warehouse.id), eq(warehousesTable.companyId, companyId)));

      let unit = await findDemo(tx, unitsTable, companyId, DEMO.unit.code, DEMO.unit.name);
      if (!unit) {
        [unit] = await tx.insert(unitsTable).values({ companyId, code: DEMO.unit.code, nameAr: DEMO.unit.name, conversionFactor: "1" }).returning();
        mark("unit", "seeded");
      } else mark("unit", "reused");
      let group = await findDemo(tx, itemGroupsTable, companyId, DEMO.group.code, DEMO.group.name);
      if (!group) {
        [group] = await tx.insert(itemGroupsTable).values({ companyId, code: DEMO.group.code, nameAr: DEMO.group.name }).returning();
        mark("general item group", "seeded");
      } else mark("general item group", "reused");
      let item = await findDemo(tx, itemsTable, companyId, DEMO.item.code, DEMO.item.name);
      if (!item) {
        await tx.insert(itemsTable).values({ companyId, code: DEMO.item.code, nameAr: DEMO.item.name, unitId: unit.id, groupId: group.id });
        mark("demo item", "seeded");
      } else {
        await tx.update(itemsTable).set({ unitId: unit.id, groupId: group.id })
          .where(and(eq(itemsTable.id, item.id), eq(itemsTable.companyId, companyId)));
        mark("demo item", "repaired");
      }

      let customer = await findDemo(tx, customersTable, companyId, null, DEMO.customer);
      const customerAccountId = await ensureCustomerLedger(companyId, DEMO.customer, false, "local", tx);
      if (!customer) {
        [customer] = await tx.insert(customersTable).values({ companyId, nameAr: DEMO.customer, accountId: customerAccountId, branchId: branch.id }).returning();
        mark("local cash customer", "seeded");
      } else {
        await tx.update(customersTable).set({ accountId: customerAccountId, branchId: branch.id })
          .where(and(eq(customersTable.id, customer.id), eq(customersTable.companyId, companyId)));
        mark("local cash customer", "repaired");
      }

      let supplier = await findDemo(tx, suppliersTable, companyId, DEMO.supplier.code, DEMO.supplier.name);
      const supplierAccountId = await ensureSupplierLedger(companyId, DEMO.supplier.name, "local", tx);
      if (!supplier) {
        [supplier] = await tx.insert(suppliersTable).values({ companyId, code: DEMO.supplier.code, nameAr: DEMO.supplier.name, accountId: supplierAccountId, branchId: branch.id, country: opts.country, currencyCode: "SAR" }).returning();
        mark("local supplier", "seeded");
      } else {
        await tx.update(suppliersTable).set({ accountId: supplierAccountId, branchId: branch.id, currencyCode: "SAR" })
          .where(and(eq(suppliersTable.id, supplier.id), eq(suppliersTable.companyId, companyId)));
        mark("local supplier", "repaired");
      }

      let bank = await findDemo(tx, bankAccountsTable, companyId, DEMO.bank.code, DEMO.bank.name);
      const bankAccountId = await ensureBankAccountLedger(companyId, DEMO.bank.name, tx);
      if (!bank) {
        await tx.insert(bankAccountsTable).values({
          companyId, code: DEMO.bank.code, nameAr: DEMO.bank.name, branchId: branch.id,
          currencyId: currency.id, accountId: bankAccountId,
        });
        mark("general bank", "seeded");
      } else {
        await tx.update(bankAccountsTable).set({
          branchId: branch.id, currencyId: currency.id, accountId: bankAccountId, isActive: true,
        }).where(and(eq(bankAccountsTable.id, bank.id), eq(bankAccountsTable.companyId, companyId)));
        mark("general bank", "repaired");
      }

      let cashbox = await findDemo(tx, cashBoxesTable, companyId, DEMO.cash.code, DEMO.cash.name);
      const cashAccountId = await ensureCashBoxAccount(companyId, DEMO.cash.name, tx);
      if (!cashbox) {
        await tx.insert(cashBoxesTable).values({
          companyId, code: DEMO.cash.code, nameAr: DEMO.cash.name, branchId: branch.id,
          currencyId: currency.id, accountId: cashAccountId,
        });
        mark("main cashbox/treasury", "seeded");
      } else {
        await tx.update(cashBoxesTable).set({
          branchId: branch.id, currencyId: currency.id, accountId: cashAccountId, isActive: true,
        }).where(and(eq(cashBoxesTable.id, cashbox.id), eq(cashBoxesTable.companyId, companyId)));
        mark("main cashbox/treasury", "repaired");
      }
    });
    log?.info?.({ companyId, ...result }, "demo company seed complete");
    return result;
  } catch (err) {
    log?.warn?.({ err, companyId, result }, "demo company seed rolled back");
    throw err;
  }
}