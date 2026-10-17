import {
  accountsTable,
  bankAccountsTable,
  branchesTable,
  cashBoxesTable,
  currenciesTable,
  db,
  warehousesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { computeNextChildCode } from "./entityAccounts.js";

/**
 * Provision the basic operational records only for a freshly-created company.
 * Safe to retry: existing defaults are reused and no duplicate records/accounts
 * are created. This must not be called from startup or company-update flows.
 */
export async function seedNewCompanyOperationalDefaults(companyId: number): Promise<void> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new Error("Invalid new company id");
  }

  await db.transaction(async (tx) => {
    const [currency] = await tx.select({ id: currenciesTable.id }).from(currenciesTable)
      .where(and(eq(currenciesTable.companyId, companyId), eq(currenciesTable.isDefault, true)))
      .limit(1);
    if (!currency) throw new Error(`Default currency missing for new company ${companyId}`);

    let [branch] = await tx.select({ id: branchesTable.id }).from(branchesTable)
      .where(and(eq(branchesTable.companyId, companyId), eq(branchesTable.isMain, true)))
      .limit(1);
    if (!branch) {
      [branch] = await tx.insert(branchesTable).values({
        companyId,
        code: "BR-0001",
        nameAr: "الفرع الرئيسي",
        nameEn: "Main Branch",
        isMain: true,
        status: "active",
      }).returning({ id: branchesTable.id });
    }

    const [warehouse] = await tx.select({ id: warehousesTable.id }).from(warehousesTable)
      .where(and(eq(warehousesTable.companyId, companyId), eq(warehousesTable.isDefault, true)))
      .limit(1);
    if (!warehouse) {
      await tx.insert(warehousesTable).values({
        companyId,
        branchId: branch.id,
        code: "WH-0001",
        nameAr: "المخزن الرئيسي",
        nameEn: "Main Warehouse",
        isDefault: true,
        isActive: true,
      });
    }

    const accounts = await tx.select().from(accountsTable).where(eq(accountsTable.companyId, companyId));
    const accountByName = (name: string) => accounts.find((account) => account.nameAr.trim() === name);
    const accountByCode = (code: string) => accounts.find((account) => account.code.trim() === code);
    const cashParent = accountByCode("1101")
      ?? accounts.find((account) => account.accountType === "asset" && !account.isPosting && /نقدية|صندوق|خزينة/.test(account.nameAr));
    const bankParent = accountByCode("1102")
      ?? accounts.find((account) => account.accountType === "asset" && !account.isPosting && /بنوك|مصارف/.test(account.nameAr));
    if (!cashParent || !bankParent) {
      throw new Error(`Cash/bank parent accounts missing for new company ${companyId}`);
    }

    async function ensurePostingAccount(nameAr: string, nameEn: string, parentId: number): Promise<number> {
      const existing = accountByName(nameAr);
      if (existing) {
        if (existing.companyId !== companyId || existing.accountType !== "asset" || !existing.isPosting) {
          throw new Error(`Invalid default account "${nameAr}" for new company ${companyId}`);
        }
        return existing.id;
      }
      const siblings = accounts.filter((account) => account.parentId === parentId);
      const code = computeNextChildCode(
        (accounts.find((account) => account.id === parentId)?.code ?? ""),
        new Set(siblings.map((account) => account.code)),
      );
      const [created] = await tx.insert(accountsTable).values({
        companyId,
        parentId,
        code,
        nameAr,
        nameEn,
        accountType: "asset",
        reportDirection: "balance_sheet",
        level: (accounts.find((account) => account.id === parentId)?.level ?? 1) + 1,
        isPosting: true,
        isActive: true,
      }).returning({ id: accountsTable.id });
      accounts.push({
        id: created.id,
        companyId,
        parentId,
        code,
        nameAr,
        nameEn,
        accountType: "asset",
        reportDirection: "balance_sheet",
        level: (accounts.find((account) => account.id === parentId)?.level ?? 1) + 1,
        isPosting: true,
        isActive: true,
        costCenterId: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return created.id;
    }

    const cashAccountId = await ensurePostingAccount("الخزينة الرئيسية", "Main Treasury", cashParent.id);
    const bankAccountId = await ensurePostingAccount("بنك عام", "General Bank", bankParent.id);

    const [cashBox] = await tx.select({ id: cashBoxesTable.id }).from(cashBoxesTable)
      .where(and(eq(cashBoxesTable.companyId, companyId), eq(cashBoxesTable.nameAr, "الخزينة الرئيسية")))
      .limit(1);
    if (!cashBox) {
      await tx.insert(cashBoxesTable).values({
        companyId,
        branchId: branch.id,
        code: "CB-0001",
        nameAr: "الخزينة الرئيسية",
        nameEn: "Main Treasury",
        currencyId: currency.id,
        accountId: cashAccountId,
        isActive: true,
      });
    }

    const [bank] = await tx.select({ id: bankAccountsTable.id }).from(bankAccountsTable)
      .where(and(eq(bankAccountsTable.companyId, companyId), eq(bankAccountsTable.nameAr, "بنك عام")))
      .limit(1);
    if (!bank) {
      await tx.insert(bankAccountsTable).values({
        companyId,
        branchId: branch.id,
        branchIds: [branch.id],
        code: "BA-0001",
        nameAr: "بنك عام",
        nameEn: "General Bank",
        bankName: "بنك عام",
        bankNameEn: "General Bank",
        currencyId: currency.id,
        accountId: bankAccountId,
        isActive: true,
      });
    }
  });
}
