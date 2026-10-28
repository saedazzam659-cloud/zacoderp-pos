import { eq, inArray } from "drizzle-orm";
import {
  db, companiesTable, usersTable, userBranchesTable, branchesTable,
  accountsTable, warehousesTable, warehouseGroupsTable, cashBoxesTable, bankAccountsTable,
  customersTable, suppliersTable, itemsTable, itemGroupsTable, unitsTable,
  currenciesTable, salesRepsTable, customerGroupsTable, supplierGroupsTable, costCentersTable,
} from "@workspace/db";
import { sameTransferLocation, withTransferLocation, type TransferLocation } from "./companyTransfer.js";

type CopyCounts = Record<string, { added: number; skipped: number }>;
type Row = Record<string, any>;
type CopyProgress = (event: { stage: string; counts: CopyCounts }) => void | Promise<void>;

const norm = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase();
const asKey = (value: unknown) => String(value ?? "").trim();

export async function copyCompanyMasterData(
  sourceCompanyId: number,
  targetCompanyId: number,
  targetAgentInstanceId?: number | null,
  onProgress?: CopyProgress,
  customerOverrides: Record<number, { action?: "skip" | "add"; nameAr?: string; vatNumber?: string | null; crNumber?: string | null }> = {},
  sourceAgentInstanceId?: number | null,
) {
  const sourceLocation: TransferLocation = sourceAgentInstanceId == null
    ? { kind: "central" }
    : { kind: "agent", agentId: sourceAgentInstanceId };
  const targetLocation: TransferLocation = targetAgentInstanceId == null
    ? { kind: "central" }
    : { kind: "agent", agentId: targetAgentInstanceId };
  if (!Number.isInteger(sourceCompanyId) || sourceCompanyId <= 0
    || !Number.isInteger(targetCompanyId) || targetCompanyId <= 0
    || (sourceAgentInstanceId != null && (!Number.isInteger(sourceAgentInstanceId) || sourceAgentInstanceId <= 0))
    || (targetAgentInstanceId != null && (!Number.isInteger(targetAgentInstanceId) || targetAgentInstanceId <= 0))
    || (sameTransferLocation(sourceLocation, targetLocation) && sourceCompanyId === targetCompanyId)) {
    throw new Error("اختر شركتين مختلفتين وصحيحتين");
  }

  const sourceTables = [
    branchesTable, unitsTable, costCentersTable, accountsTable,
    customerGroupsTable, supplierGroupsTable, itemGroupsTable, warehouseGroupsTable,
    currenciesTable, usersTable, salesRepsTable, customersTable, suppliersTable,
    warehousesTable, itemsTable, cashBoxesTable, bankAccountsTable,
  ];
  const { source, sourceRowsByTable, sourceUserBranches } = await withTransferLocation(sourceLocation, async () => {
    const [source] = await db.select({ id: companiesTable.id, nameAr: companiesTable.nameAr, deletedAt: companiesTable.deletedAt })
      .from(companiesTable).where(eq(companiesTable.id, sourceCompanyId));
    if (!source || source.deletedAt) throw new Error("الشركة المصدر غير موجودة أو محذوفة في قاعدة بياناتها");
    const sourceRowsByTable = new Map<any, Row[]>();
    for (const table of sourceTables) {
      sourceRowsByTable.set(table, await db.select().from(table).where(eq(table.companyId, sourceCompanyId)) as Row[]);
    }
    const sourceUserIds = (sourceRowsByTable.get(usersTable) ?? []).map((user) => user.id);
    const sourceUserBranches = sourceUserIds.length
      ? await db.select().from(userBranchesTable).where(inArray(userBranchesTable.userId, sourceUserIds))
      : [];
    return { source, sourceRowsByTable, sourceUserBranches };
  });

  return withTransferLocation(targetLocation, async () => {
    const [target] = await db.select({ id: companiesTable.id, nameAr: companiesTable.nameAr, deletedAt: companiesTable.deletedAt })
      .from(companiesTable).where(eq(companiesTable.id, targetCompanyId));
    if (!target || target.deletedAt) throw new Error("الشركة الهدف غير موجودة أو محذوفة في قاعدة بياناتها");

    const counts: CopyCounts = {};
    const bump = (type: string, added: boolean) => {
      counts[type] ??= { added: 0, skipped: 0 };
      counts[type][added ? "added" : "skipped"]++;
    };
    const reportStage = async (stage: string) => {
      if (onProgress) {
        await onProgress({
          stage,
          counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, { ...value }])),
        });
      }
    };
    await db.transaction(async (tx) => {
    const srcRows = async (table: any): Promise<Row[]> => sourceRowsByTable.get(table) ?? [];
    const dstRows = async (table: any): Promise<Row[]> =>
      tx.select().from(table).where(eq(table.companyId, targetCompanyId)) as Promise<Row[]>;
    const insert = async (table: any, value: Row): Promise<number> => {
      const [row] = await tx.insert(table).values(value).returning({ id: table.id });
      return Number(row.id);
    };
    const strip = (row: Row, keys: string[]) => {
      const out = { ...row };
      for (const key of ["id", "companyId", "createdAt", "updatedAt", ...keys]) delete out[key];
      return out;
    };
    const mapExisting = (sourceRows: Row[], targetRows: Row[], keyOf: (row: Row) => string) => {
      const dstByKey = new Map<string, Row>();
      for (const row of targetRows) {
        const key = norm(keyOf(row));
        if (key && !dstByKey.has(key)) dstByKey.set(key, row);
      }
      const idMap = new Map<number, number>();
      for (const row of sourceRows) {
        const key = norm(keyOf(row));
        const existing = key ? dstByKey.get(key) : undefined;
        if (existing) idMap.set(row.id, existing.id);
      }
      return { dstByKey, idMap };
    };

    const srcBranches = await srcRows(branchesTable);
    const dstBranches = await dstRows(branchesTable);
    const branchState = mapExisting(srcBranches, dstBranches, (r) => r.code);
    const branchMap = branchState.idMap;
    let hasMainBranch = dstBranches.some((row) => row.isMain);
    for (const row of srcBranches) {
      const key = norm(row.code);
      if (key && branchState.dstByKey.has(key)) { bump("branches", false); continue; }
      const newId = await insert(branchesTable, {
        ...strip(row, ["regionId"]),
        companyId: targetCompanyId, regionId: null,
        isMain: !!row.isMain && !hasMainBranch,
      });
      branchMap.set(row.id, newId);
      if (row.isMain && !hasMainBranch) hasMainBranch = true;
      if (key) branchState.dstByKey.set(key, { id: newId });
      bump("branches", true);
    }
    await reportStage("branches");

    // Units and chart accounts precede items, parties, tills, and banks.
    const srcUnits = await srcRows(unitsTable);
    const dstUnits = await dstRows(unitsTable);
    const unitState = mapExisting(srcUnits, dstUnits, (r) => r.code);
    const unitMap = unitState.idMap;
    for (const row of srcUnits) {
      const key = norm(row.code);
      if (key && unitState.dstByKey.has(key)) { bump("units", false); continue; }
      const id = await insert(unitsTable, { ...strip(row, []), companyId: targetCompanyId });
      unitMap.set(row.id, id);
      if (key) unitState.dstByKey.set(key, { id });
      bump("units", true);
    }
    await reportStage("units");

    const srcCostCenters = await srcRows(costCentersTable);
    const dstCostCenters = await dstRows(costCentersTable);
    const costCenterState = mapExisting(srcCostCenters, dstCostCenters, (r) => r.code);
    const costCenterMap = costCenterState.idMap;
    const pendingCostCenters = srcCostCenters
      .filter((row) => !costCenterMap.has(row.id))
      .sort((a, b) => Number(a.level ?? 1) - Number(b.level ?? 1) || asKey(a.code).localeCompare(asKey(b.code)));
    for (const row of srcCostCenters) if (costCenterMap.has(row.id)) bump("cost_centers", false);
    const parentPendingCostCenters = [...pendingCostCenters];
    while (parentPendingCostCenters.length) {
      const index = parentPendingCostCenters.findIndex((row) => row.parentId == null || costCenterMap.has(row.parentId));
      if (index < 0) throw new Error("تعذر نسخ شجرة مراكز التكلفة: يوجد مركز أب غير موجود أو علاقة دائرية");
      const [row] = parentPendingCostCenters.splice(index, 1);
      const key = norm(row.code);
      if (key && costCenterState.dstByKey.has(key)) {
        costCenterMap.set(row.id, costCenterState.dstByKey.get(key)!.id);
        bump("cost_centers", false);
        continue;
      }
      const id = await insert(costCentersTable, {
        ...strip(row, ["parentId"]),
        companyId: targetCompanyId,
        parentId: row.parentId == null ? null : costCenterMap.get(row.parentId) ?? null,
      });
      costCenterMap.set(row.id, id);
      if (key) costCenterState.dstByKey.set(key, { id });
      bump("cost_centers", true);
    }
    await reportStage("cost_centers");

    const srcAccounts = await srcRows(accountsTable);
    const dstAccounts = await dstRows(accountsTable);
    const accountState = mapExisting(srcAccounts, dstAccounts, (r) => r.code);
    const accountMap = accountState.idMap;
    // Add new accounts root-first. The second pass restores every parent link.
    const pendingAccounts = srcAccounts
      .filter((row) => !accountMap.has(row.id))
      .sort((a, b) => Number(a.level ?? 1) - Number(b.level ?? 1) || asKey(a.code).localeCompare(asKey(b.code)));
    for (const row of srcAccounts) if (accountMap.has(row.id)) bump("accounts", false);
    const parentPending = [...pendingAccounts];
    while (parentPending.length) {
      const index = parentPending.findIndex((row) => row.parentId == null || accountMap.has(row.parentId));
      if (index < 0) throw new Error("تعذر نسخ شجرة الحسابات: يوجد حساب أب غير موجود أو علاقة دائرية");
      const [row] = parentPending.splice(index, 1);
      const key = norm(row.code);
      if (key && accountState.dstByKey.has(key)) {
        accountMap.set(row.id, accountState.dstByKey.get(key)!.id);
        bump("accounts", false);
        continue;
      }
      const id = await insert(accountsTable, {
        ...strip(row, ["parentId", "costCenterId"]),
        companyId: targetCompanyId,
        parentId: row.parentId == null ? null : accountMap.get(row.parentId) ?? null,
        costCenterId: row.costCenterId == null ? null : costCenterMap.get(row.costCenterId) ?? null,
      });
      accountMap.set(row.id, id);
      if (key) accountState.dstByKey.set(key, { id });
      bump("accounts", true);
    }
    await reportStage("accounts");

    // Copy item groups as an item-catalog dependency, not accounting balances.
    const srcItemGroups = await srcRows(itemGroupsTable);
    const dstItemGroups = await dstRows(itemGroupsTable);
    const itemGroupState = mapExisting(srcItemGroups, dstItemGroups, (r) => r.code);
    const itemGroupMap = itemGroupState.idMap;
    for (const row of srcItemGroups) {
      const key = norm(row.code);
      if (key && itemGroupState.dstByKey.has(key)) { bump("item_groups", false); continue; }
      const id = await insert(itemGroupsTable, {
        ...strip(row, ["costAccountId", "revenueAccountId", "parentAccountId", "accountId"]),
        companyId: targetCompanyId,
        costAccountId: row.costAccountId == null ? null : accountMap.get(row.costAccountId) ?? null,
        revenueAccountId: row.revenueAccountId == null ? null : accountMap.get(row.revenueAccountId) ?? null,
        parentAccountId: row.parentAccountId == null ? null : accountMap.get(row.parentAccountId) ?? null,
        accountId: row.accountId == null ? null : accountMap.get(row.accountId) ?? null,
      });
      itemGroupMap.set(row.id, id);
      if (key) itemGroupState.dstByKey.set(key, { id });
      bump("item_groups", true);
    }
    await reportStage("item_groups");

    const srcWhGroups = await srcRows(warehouseGroupsTable);
    const dstWhGroups = await dstRows(warehouseGroupsTable);
    const whGroupState = mapExisting(srcWhGroups, dstWhGroups, (r) => r.code);
    const whGroupMap = whGroupState.idMap;
    for (const row of srcWhGroups) {
      const key = norm(row.code);
      if (key && whGroupState.dstByKey.has(key)) { bump("warehouse_groups", false); continue; }
      const id = await insert(warehouseGroupsTable, { ...strip(row, []), companyId: targetCompanyId });
      whGroupMap.set(row.id, id);
      if (key) whGroupState.dstByKey.set(key, { id });
      bump("warehouse_groups", true);
    }
    await reportStage("warehouse_groups");

    const copyGroups = async (table: any, kind: "customer_groups" | "supplier_groups", stage: string) => {
      const src = await srcRows(table);
      const dst = await dstRows(table);
      const state = mapExisting(src, dst, (row) => row.code);
      for (const row of src) {
        const key = norm(row.code);
        if (key && state.dstByKey.has(key)) { bump(kind, false); continue; }
        const id = await insert(table, { ...strip(row, []), companyId: targetCompanyId });
        state.idMap.set(row.id, id);
        if (key) state.dstByKey.set(key, { id });
        bump(kind, true);
      }
      await reportStage(stage);
      return state.idMap;
    };
    const customerGroupMap = await copyGroups(customerGroupsTable, "customer_groups", "customer_groups");
    const supplierGroupMap = await copyGroups(supplierGroupsTable, "supplier_groups", "supplier_groups");

    const srcCurrencies = await srcRows(currenciesTable);
    const dstCurrencies = await dstRows(currenciesTable);
    const currencyByCode = new Map(dstCurrencies.map((row) => [norm(row.code), row.id]));
    for (const row of srcCurrencies) if (!currencyByCode.has(norm(row.code))) currencyByCode.set(norm(row.code), null);
    const currencyId = (id: number | null) => {
      const row = srcCurrencies.find((candidate) => candidate.id === id);
      return row ? currencyByCode.get(norm(row.code)) ?? null : null;
    };

    const srcUsers = await srcRows(usersTable);
    const dstUsers = await dstRows(usersTable);
    const userState = mapExisting(srcUsers, dstUsers, (r) => r.username);
    const userMap = userState.idMap;
    const newlyCopiedUserIds = new Set<number>();
    for (const row of srcUsers) {
      const key = norm(row.username);
      if (key && userState.dstByKey.has(key)) { bump("users", false); continue; }
      const id = await insert(usersTable, {
        ...strip(row, [
          "sessionToken", "sessionId", "currentSessionId", "sessionChannel", "lastLoginAt",
        ]),
        companyId: targetCompanyId,
        isActive: false,
        sessionToken: null, sessionId: null, currentSessionId: null,
        sessionChannel: null, lastLoginAt: null,
      });
      userMap.set(row.id, id);
      newlyCopiedUserIds.add(row.id);
      if (key) userState.dstByKey.set(key, { id });
      bump("users", true);
    }
    for (const link of sourceUserBranches as Row[]) {
      if (!newlyCopiedUserIds.has(Number(link.userId))) continue;
      const userId = userMap.get(Number(link.userId));
      const branchId = branchMap.get(Number(link.branchId));
      if (userId == null || branchId == null) continue;
      await tx.insert(userBranchesTable).values({ userId, branchId }).onConflictDoNothing();
    }
    await reportStage("users");

    const srcReps = await srcRows(salesRepsTable);
    const dstReps = await dstRows(salesRepsTable);
    const repState = mapExisting(srcReps, dstReps, (r) => r.code || r.nameAr);
    const repMap = repState.idMap;
    for (const row of srcReps) {
      const key = norm(row.code || row.nameAr);
      if (key && repState.dstByKey.has(key)) { bump("sales_reps", false); continue; }
      const id = await insert(salesRepsTable, {
        ...strip(row, ["branchId", "userId", "accountId"]),
        companyId: targetCompanyId,
        branchId: row.branchId == null ? null : branchMap.get(row.branchId) ?? null,
        userId: row.userId == null ? null : userMap.get(row.userId) ?? null,
        accountId: row.accountId == null ? null : accountMap.get(row.accountId) ?? null,
      });
      repMap.set(row.id, id);
      if (key) repState.dstByKey.set(key, { id });
      bump("sales_reps", true);
    }
    await reportStage("sales_reps");

    const copyParties = async (
      table: any,
      kind: "customers" | "suppliers",
      keyOf: (r: Row) => string,
      groupMap: Map<number, number>,
    ) => {
      const src = await srcRows(table);
      const dst = await dstRows(table);
      const state = mapExisting(src, dst, keyOf);
      const customerIdentityKeys = new Set<string>();
      const addCustomerKeys = (row: Row) => {
        const name = norm(row.nameAr);
        if (name) customerIdentityKeys.add(`nameAr:${name}`);
      };
      if (kind === "customers") {
        for (const row of dst) addCustomerKeys(row);
      }
      for (const row of src) {
        const override = kind === "customers" ? customerOverrides[Number(row.id)] : undefined;
        if (override?.action === "skip") { bump(kind, false); addCustomerKeys(row); continue; }
        const copyRow = kind === "customers"
          ? { ...row, ...(override?.nameAr !== undefined ? { nameAr: override.nameAr } : {}),
            ...(override?.vatNumber !== undefined ? { vatNumber: override.vatNumber } : {}),
            ...(override?.crNumber !== undefined ? { crNumber: override.crNumber } : {}) }
          : row;
        const key = norm(keyOf(copyRow));
        const nameKey = norm(copyRow.nameAr);
        const hasCustomerCollision = kind === "customers" && Boolean(nameKey && customerIdentityKeys.has(`nameAr:${nameKey}`));
        const hasCollision = kind === "customers"
          ? hasCustomerCollision
          : Boolean(key && state.dstByKey.has(key));
        if (hasCollision) {
          bump(kind, false);
          if (kind === "customers") addCustomerKeys(copyRow);
          continue;
        }
        const id = await insert(table, {
          ...strip(copyRow, ["accountId", "branchId", "salesRepId", "regionId", "customerGroupId", "groupId", "openingBalance"]),
          companyId: targetCompanyId,
          accountId: copyRow.accountId == null ? null : accountMap.get(copyRow.accountId) ?? null,
          branchId: copyRow.branchId == null ? null : branchMap.get(copyRow.branchId) ?? null,
          salesRepId: copyRow.salesRepId == null ? null : repMap.get(copyRow.salesRepId) ?? null,
          regionId: null,
          ...(kind === "customers"
            ? { customerGroupId: copyRow.customerGroupId == null ? null : groupMap.get(copyRow.customerGroupId) ?? null }
            : { groupId: copyRow.groupId == null ? null : groupMap.get(copyRow.groupId) ?? null, openingBalance: "0" }),
        });
        if (kind === "customers") {
          addCustomerKeys(copyRow);
        } else if (key) {
          state.dstByKey.set(key, { id });
        }
        bump(kind, true);
      }
    };
    await copyParties(customersTable, "customers", (r) => r.vatNumber || r.nameAr, customerGroupMap);
    await reportStage("customers");
    await copyParties(suppliersTable, "suppliers", (r) => r.code || r.vatNumber || r.nameAr, supplierGroupMap);
    await reportStage("suppliers");

    const srcWarehouses = await srcRows(warehousesTable);
    const dstWarehouses = await dstRows(warehousesTable);
    const whState = mapExisting(srcWarehouses, dstWarehouses, (r) => r.code);
    const warehouseMap = whState.idMap;
    let hasDefaultWarehouse = dstWarehouses.some((row) => row.isDefault);
    for (const row of srcWarehouses) {
      const key = norm(row.code);
      if (key && whState.dstByKey.has(key)) { bump("warehouses", false); continue; }
      const id = await insert(warehousesTable, {
        ...strip(row, ["groupId", "branchId", "accountId"]),
        companyId: targetCompanyId,
        groupId: row.groupId == null ? null : whGroupMap.get(row.groupId) ?? null,
        branchId: row.branchId == null ? null : branchMap.get(row.branchId) ?? null,
        accountId: row.accountId == null ? null : accountMap.get(row.accountId) ?? null,
        isDefault: !!row.isDefault && !hasDefaultWarehouse,
      });
      warehouseMap.set(row.id, id);
      if (row.isDefault && !hasDefaultWarehouse) hasDefaultWarehouse = true;
      if (key) whState.dstByKey.set(key, { id });
      bump("warehouses", true);
    }
    await reportStage("warehouses");

    const srcItems = await srcRows(itemsTable);
    const dstItems = await dstRows(itemsTable);
    const itemState = mapExisting(srcItems, dstItems, (r) => r.code);
    const itemMap = itemState.idMap;
    const newlyCopiedItems = new Set<number>();
    for (const row of srcItems) {
      const key = norm(row.code);
      if (key && itemState.dstByKey.has(key)) { bump("items", false); continue; }
      const id = await insert(itemsTable, {
        ...strip(row, ["groupId", "posGroupId", "subgroupId", "posSubgroupId", "unitId", "parentItemId", "costAccountId", "revenueAccountId"]),
        companyId: targetCompanyId,
        groupId: row.groupId == null ? null : itemGroupMap.get(row.groupId) ?? null,
        posGroupId: row.posGroupId == null ? null : itemGroupMap.get(row.posGroupId) ?? null,
        subgroupId: null, posSubgroupId: null,
        unitId: row.unitId == null ? null : unitMap.get(row.unitId) ?? null,
        parentItemId: null,
        costAccountId: row.costAccountId == null ? null : accountMap.get(row.costAccountId) ?? null,
        revenueAccountId: row.revenueAccountId == null ? null : accountMap.get(row.revenueAccountId) ?? null,
      });
      itemMap.set(row.id, id);
      newlyCopiedItems.add(row.id);
      if (key) itemState.dstByKey.set(key, { id });
      bump("items", true);
    }
    for (const row of srcItems) {
      if (row.parentItemId == null || !newlyCopiedItems.has(row.id) || !itemMap.has(row.parentItemId)) continue;
      await tx.update(itemsTable).set({ parentItemId: itemMap.get(row.parentItemId)! })
        .where(eq(itemsTable.id, itemMap.get(row.id)!));
    }
    await reportStage("items");

    const srcCashBoxes = await srcRows(cashBoxesTable);
    const dstCashBoxes = await dstRows(cashBoxesTable);
    const cashState = mapExisting(srcCashBoxes, dstCashBoxes, (r) => r.code);
    for (const row of srcCashBoxes) {
      const key = norm(row.code);
      if (key && cashState.dstByKey.has(key)) { bump("cash_boxes", false); continue; }
      const id = await insert(cashBoxesTable, {
        ...strip(row, ["branchId", "currencyId", "accountId", "cashExpenseManagerUserId", "accessUserIds"]),
        companyId: targetCompanyId,
        branchId: row.branchId == null ? null : branchMap.get(row.branchId) ?? null,
        currencyId: currencyId(row.currencyId),
        accountId: row.accountId == null ? null : accountMap.get(row.accountId) ?? null,
        cashExpenseManagerUserId: row.cashExpenseManagerUserId == null
          ? null : userMap.get(row.cashExpenseManagerUserId) ?? null,
        accessUserIds: null,
      });
      if (key) cashState.dstByKey.set(key, { id });
      bump("cash_boxes", true);
    }
    await reportStage("cash_boxes");

    const srcBanks = await srcRows(bankAccountsTable);
    const dstBanks = await dstRows(bankAccountsTable);
    const bankState = mapExisting(srcBanks, dstBanks, (r) => r.code || r.accountNumber);
    for (const row of srcBanks) {
      const key = norm(row.code || row.accountNumber);
      if (key && bankState.dstByKey.has(key)) { bump("bank_accounts", false); continue; }
      const branchIds = Array.isArray(row.branchIds)
        ? row.branchIds.flatMap((id: number) => branchMap.has(id) ? [branchMap.get(id)!] : [])
        : [];
      const id = await insert(bankAccountsTable, {
        ...strip(row, ["branchId", "branchIds", "currencyId", "accountId"]),
        companyId: targetCompanyId,
        branchId: row.branchId == null ? null : branchMap.get(row.branchId) ?? null,
        branchIds: branchIds.length ? branchIds : null,
        currencyId: currencyId(row.currencyId),
        accountId: row.accountId == null ? null : accountMap.get(row.accountId) ?? null,
      });
      if (key) bankState.dstByKey.set(key, { id });
      bump("bank_accounts", true);
    }
    await reportStage("bank_accounts");
    });
    return {
      sourceCompany: source.nameAr,
      targetCompany: target.nameAr,
      sourceAgentInstanceId: sourceAgentInstanceId ?? null,
      targetAgentInstanceId: targetAgentInstanceId ?? null,
      counts,
    };
  });
}

export async function previewCompanyCustomerDuplicates(
  sourceCompanyId: number,
  targetCompanyId: number,
  targetAgentInstanceId?: number | null,
  sourceAgentInstanceId?: number | null,
) {
  if (!Number.isInteger(sourceCompanyId) || sourceCompanyId <= 0
    || !Number.isInteger(targetCompanyId) || targetCompanyId <= 0
    || (sourceAgentInstanceId != null && (!Number.isInteger(sourceAgentInstanceId) || sourceAgentInstanceId <= 0))
    || (targetAgentInstanceId != null && (!Number.isInteger(targetAgentInstanceId) || targetAgentInstanceId <= 0))) {
    throw new Error("اختر شركتين مختلفتين وصحيحتين");
  }
  const sourceLocation: TransferLocation = sourceAgentInstanceId == null
    ? { kind: "central" }
    : { kind: "agent", agentId: sourceAgentInstanceId };
  const targetLocation: TransferLocation = targetAgentInstanceId == null
    ? { kind: "central" }
    : { kind: "agent", agentId: targetAgentInstanceId };
  if (sourceCompanyId === targetCompanyId && sameTransferLocation(sourceLocation, targetLocation)) {
    throw new Error("اختر شركتين مختلفتين وصحيحتين");
  }
  const sourceRows = await withTransferLocation(sourceLocation, async () => {
    const [source] = await db.select({ id: companiesTable.id, deletedAt: companiesTable.deletedAt })
      .from(companiesTable).where(eq(companiesTable.id, sourceCompanyId));
    if (!source || source.deletedAt) throw new Error("الشركة المصدر غير موجودة أو محذوفة في قاعدة بياناتها");
    return db.select().from(customersTable).where(eq(customersTable.companyId, sourceCompanyId));
  });
  return withTransferLocation(targetLocation, async () => {
    const [target] = await db.select({ id: companiesTable.id, nameAr: companiesTable.nameAr, deletedAt: companiesTable.deletedAt })
      .from(companiesTable).where(eq(companiesTable.id, targetCompanyId));
    if (!target || target.deletedAt) throw new Error("الشركة الهدف غير موجودة أو محذوفة في قاعدة بياناتها");
    const targetRows = await db.select().from(customersTable).where(eq(customersTable.companyId, targetCompanyId));
    const normalize = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase();
    const seenSource = new Map<string, Row>();
    const conflicts: Row[] = [];
    for (const sourceRow of sourceRows) {
      const keys = ([["nameAr", normalize(sourceRow.nameAr)]] as const).filter(([, value]) => value);
      const targetMatches = targetRows.filter((candidate) =>
        keys.some(([field, value]) => normalize(candidate[field]) === value));
      const sourceMatches: Row[] = [];
      for (const [field, value] of keys) {
        const prior = seenSource.get(`${field}:${value}`);
        if (prior && !sourceMatches.some((match) => match.id === prior.id)) sourceMatches.push(prior);
      }
      if (targetMatches.length || sourceMatches.length) {
        conflicts.push({
          source: {
            id: sourceRow.id, nameAr: sourceRow.nameAr, vatNumber: sourceRow.vatNumber,
            crNumber: sourceRow.crNumber, phone: sourceRow.phone,
          },
          targetMatches: targetMatches.map((row) => ({
            id: row.id, nameAr: row.nameAr, vatNumber: row.vatNumber, crNumber: row.crNumber, phone: row.phone,
          })),
          sourceMatches: sourceMatches.map((row) => ({
            id: row.id, nameAr: row.nameAr, vatNumber: row.vatNumber, crNumber: row.crNumber, phone: row.phone,
          })),
          reasons: ["name"],
        });
      }
      for (const [field, value] of keys) if (!seenSource.has(`${field}:${value}`)) seenSource.set(`${field}:${value}`, sourceRow);
    }
    return { targetCompany: target.nameAr, totalCustomers: sourceRows.length, conflicts };
  });
}
