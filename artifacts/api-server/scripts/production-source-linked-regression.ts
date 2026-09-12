/**
 * Focused, disposable-tenant verification for the production wizard's
 * source-linked create/edit path.
 *
 * This deliberately runs the real production router in an in-process
 * Express/http server. It does not use the deployed API, a browser, or the
 * broad test suite. The fixture is a uniquely marked sandbox company and is
 * deleted only after the company marker and owned admin are re-verified.
 *
 * Required safety opt-in:
 *   PRODUCTION_SOURCE_LINKED_ALLOW_DEV_DB=1
 *
 * Example:
 *   PRODUCTION_SOURCE_LINKED_ALLOW_DEV_DB=1 \
 *     pnpm --filter @workspace/api-server exec tsx \
 *     scripts/production-source-linked-regression.ts
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import express from "express";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import {
  accountingAdjustmentRunsTable,
  accountingAdjustmentsTable,
  accountsTable,
  bomTemplateLinesTable,
  bomTemplatesTable,
  companiesTable,
  db,
  employeesTable,
  itemsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  manufacturingSettingsTable,
  payrollAllocationSnapshotsTable,
  payrollLinesTable,
  payrollRunsTable,
  pool,
  productionCostAllocationsTable,
  productionDriverReconciliationsTable,
  productionEventsTable,
  productionOrderItemsTable,
  productionOrderStagesTable,
  productionOrdersTable,
  productionOverheadClosuresTable,
  subscriptionsTable,
  stockBalanceTable,
  stockLedgerTable,
  unitsTable,
  usersTable,
  warehousesTable,
} from "@workspace/db";

import productionRouter from "../src/routes/production.ts";

const PERIOD = "2099-12";
const PERIOD_START = `${PERIOD}-01`;
const PERIOD_END = `${PERIOD}-31`;

type Fixture = {
  tag: string;
  companyId: number;
  companyCode: string;
  crNumber: string;
  nameAr: string;
  adminUserId: number;
  adminUsername: string;
  authUser: Record<string, unknown>;
  finishedItemId: number;
  rawItemId: number;
  unitId: number;
  rawWarehouseId: number;
  finishedWarehouseId: number;
  sourcePayrollId: number;
  sourcePrepaidId: number;
  accounts: {
    sourceExpense: number;
    sourceCounterpart: number;
    wip: number;
    rawInventory: number;
    finishedGoods: number;
    variance: number;
    waste: number;
  };
};

type JsonResponse = {
  status: number;
  body: any;
};

function requireDevelopmentOptIn(): void {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.REPLIT_DEPLOYMENT === "1" ||
    process.env.REPLIT_DEPLOYMENT === "true"
  ) {
    throw new Error(
      "The source-linked regression is disabled for production deployments.",
    );
  }
  if (process.env.PRODUCTION_SOURCE_LINKED_ALLOW_DEV_DB !== "1") {
    throw new Error(
      "Set PRODUCTION_SOURCE_LINKED_ALLOW_DEV_DB=1 for the disposable development fixture.",
    );
  }
}

function vatNumberForTag(tag: string): string {
  const digits = BigInt(`0x${tag}`).toString().slice(-14).padStart(14, "0");
  return `3${digits}`;
}

async function assertOwnedFixture(
  executor: any,
  fixture: Fixture,
): Promise<void> {
  const [company] = await executor
    .select({
      id: companiesTable.id,
      code: companiesTable.code,
      crNumber: companiesTable.crNumber,
      nameAr: companiesTable.nameAr,
      isSandbox: companiesTable.isSandbox,
    })
    .from(companiesTable)
    .where(
      and(
        eq(companiesTable.id, fixture.companyId),
        eq(companiesTable.code, fixture.companyCode),
        eq(companiesTable.crNumber, fixture.crNumber),
        eq(companiesTable.nameAr, fixture.nameAr),
        eq(companiesTable.isSandbox, true),
      ),
    )
    .limit(1);
  if (!company) {
    throw new Error(
      "Disposable fixture ownership proof failed for the company.",
    );
  }

  const [admin] = await executor
    .select({
      id: usersTable.id,
      companyId: usersTable.companyId,
      username: usersTable.username,
      role: usersTable.role,
    })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.id, fixture.adminUserId),
        eq(usersTable.companyId, fixture.companyId),
        eq(usersTable.username, fixture.adminUsername),
        eq(usersTable.role, "admin"),
      ),
    )
    .limit(1);
  if (!admin) {
    throw new Error("Disposable fixture ownership proof failed for the admin.");
  }
}

async function recoverOwnedFixture(companyId: number): Promise<Fixture> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new Error("The cleanup-only company id must be a positive integer.");
  }

  // Validate every existing PSLR marker before considering the requested row.
  // A sandbox flag alone is deliberately insufficient: this command must
  // never turn into a generic sandbox-company deletion tool.
  const markedCompanies = await db
    .select({
      id: companiesTable.id,
      code: companiesTable.code,
      crNumber: companiesTable.crNumber,
      nameAr: companiesTable.nameAr,
      isSandbox: companiesTable.isSandbox,
    })
    .from(companiesTable)
    .where(
      or(
        like(companiesTable.code, "PSLR-%"),
        like(companiesTable.crNumber, "PSLR-CR-%"),
        like(companiesTable.nameAr, "بيئة تحقق ربط مصادر الإنتاج — %"),
      ),
    );
  for (const marked of markedCompanies) {
    const code = String(marked.code ?? "");
    const upperTag = code.startsWith("PSLR-") ? code.slice(5) : "";
    const tag = upperTag.toLowerCase();
    const coherent =
      /^PSLR-[0-9A-F]{20}$/.test(code) &&
      marked.isSandbox === true &&
      marked.crNumber === `PSLR-CR-${upperTag}` &&
      marked.nameAr === `بيئة تحقق ربط مصادر الإنتاج — ${tag}`;
    if (!coherent) {
      throw new Error(
        `Refusing cleanup: malformed or non-sandbox PSLR marker company ${marked.id}.`,
      );
    }
  }

  const [company] = await db
    .select({
      id: companiesTable.id,
      code: companiesTable.code,
      crNumber: companiesTable.crNumber,
      nameAr: companiesTable.nameAr,
      isSandbox: companiesTable.isSandbox,
    })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .limit(1);
  if (!company) {
    throw new Error(`No company exists for cleanup-only id ${companyId}.`);
  }

  const code = String(company.code ?? "");
  const upperTag = code.startsWith("PSLR-") ? code.slice(5) : "";
  const tag = upperTag.toLowerCase();
  if (
    !/^PSLR-[0-9A-F]{20}$/.test(code) ||
    company.isSandbox !== true ||
    company.crNumber !== `PSLR-CR-${upperTag}` ||
    company.nameAr !== `بيئة تحقق ربط مصادر الإنتاج — ${tag}`
  ) {
    throw new Error(
      `Refusing cleanup-only id ${companyId}: ownership marker proof failed.`,
    );
  }

  const admins = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      role: usersTable.role,
    })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.companyId, companyId),
        eq(usersTable.username, `pslr_admin_${tag}`),
        eq(usersTable.role, "admin"),
      ),
    );
  if (admins.length !== 1) {
    throw new Error(
      `Refusing cleanup-only id ${companyId}: expected exactly one owned admin marker.`,
    );
  }
  const admin = admins[0];
  return {
    tag,
    companyId,
    companyCode: company.code,
    crNumber: company.crNumber,
    nameAr: company.nameAr,
    adminUserId: admin.id,
    adminUsername: admin.username,
    authUser: {},
    finishedItemId: 0,
    rawItemId: 0,
    unitId: 0,
    rawWarehouseId: 0,
    finishedWarehouseId: 0,
    sourcePayrollId: 0,
    sourcePrepaidId: 0,
    accounts: {
      sourceExpense: 0,
      sourceCounterpart: 0,
      wip: 0,
      rawInventory: 0,
      finishedGoods: 0,
      variance: 0,
      waste: 0,
    },
  };
}

async function insertSourceJournal(
  tx: any,
  companyId: number,
  sourceExpenseAccountId: number,
  counterpartAccountId: number,
  code: string,
): Promise<number> {
  const [journal] = await tx
    .insert(journalEntriesTable)
    .values({
      companyId,
      docNumber: code,
      entryDate: `${PERIOD}-15`,
      currency: "SAR",
      exchangeRate: "1",
      description: `Source-linked regression source ${code}`,
      entryType: "source_linked_regression",
      status: "posted",
    })
    .returning({ id: journalEntriesTable.id });
  await tx.insert(journalEntryLinesTable).values([
    {
      entryId: journal.id,
      accountId: sourceExpenseAccountId,
      debit: "100.00",
      credit: "0",
      description: "Manufacturing source expense",
      sortOrder: 0,
    },
    {
      entryId: journal.id,
      accountId: counterpartAccountId,
      debit: "0",
      credit: "100.00",
      description: "Manufacturing source counterpart",
      sortOrder: 1,
    },
  ]);
  return journal.id;
}

async function createFixture(): Promise<Fixture> {
  const tag = randomBytes(10).toString("hex");
  const companyCode = `PSLR-${tag.toUpperCase()}`;
  const crNumber = `PSLR-CR-${tag.toUpperCase()}`;
  const nameAr = `بيئة تحقق ربط مصادر الإنتاج — ${tag}`;
  const adminUsername = `pslr_admin_${tag}`;

  return db.transaction(async (tx) => {
    const [collision] = await tx
      .select({ id: companiesTable.id })
      .from(companiesTable)
      .where(eq(companiesTable.code, companyCode))
      .limit(1);
    if (collision) {
      throw new Error(
        "The unique disposable fixture marker unexpectedly exists.",
      );
    }

    const [company] = await tx
      .insert(companiesTable)
      .values({
        nameAr,
        nameEn: `Production Source Linked Regression — ${tag}`,
        vatNumber: vatNumberForTag(tag),
        crNumber,
        city: "Riyadh",
        street: "Development regression verification",
        buildingNumber: "1",
        postalCode: "00000",
        country: "SA",
        code: companyCode,
        status: "active",
        isSandbox: true,
        menuPermissions: JSON.stringify({ production: true }),
      })
      .returning({ id: companiesTable.id });

    const [admin] = await tx
      .insert(usersTable)
      .values({
        username: adminUsername,
        passwordHash: "source-linked-regression-not-for-login",
        companyId: company.id,
        role: "admin",
        nameAr: "مدير تحقق ربط المصادر",
        nameEn: "Source Linked Regression Admin",
        permissions: {},
        isActive: true,
      })
      .returning({ id: usersTable.id });

    await tx.insert(subscriptionsTable).values({
      companyId: company.id,
      plan: "starter",
      maxUsers: 2,
      maxBranches: 1,
      maxWarehouses: 2,
      maxInvoices: 50,
      maxHrUsers: 2,
      billingCycle: "monthly",
      startDate: "2099-01-01",
      endDate: "2100-01-01",
      isActive: true,
      price: "0",
    });

    const accountRows = await tx
      .insert(accountsTable)
      .values([
        {
          companyId: company.id,
          code: `PSLR-EXP-${tag}`,
          nameAr: "مصروف مصدر التصنيع",
          nameEn: "Manufacturing source expense",
          accountType: "expense",
          level: 1,
          isPosting: true,
          isActive: true,
        },
        {
          companyId: company.id,
          code: `PSLR-OFF-${tag}`,
          nameAr: "مقابل مصدر التصنيع",
          nameEn: "Manufacturing source counterpart",
          accountType: "liability",
          level: 1,
          isPosting: true,
          isActive: true,
        },
        {
          companyId: company.id,
          code: `PSLR-WIP-${tag}`,
          nameAr: "إنتاج تحت التشغيل",
          nameEn: "WIP",
          accountType: "asset",
          level: 1,
          isPosting: true,
          isActive: true,
        },
        {
          companyId: company.id,
          code: `PSLR-RAW-${tag}`,
          nameAr: "مخزون خامات",
          nameEn: "Raw inventory",
          accountType: "asset",
          level: 1,
          isPosting: true,
          isActive: true,
        },
        {
          companyId: company.id,
          code: `PSLR-FG-${tag}`,
          nameAr: "مخزون إنتاج تام",
          nameEn: "Finished goods",
          accountType: "asset",
          level: 1,
          isPosting: true,
          isActive: true,
        },
        {
          companyId: company.id,
          code: `PSLR-VAR-${tag}`,
          nameAr: "فروقات تصنيع",
          nameEn: "Manufacturing variance",
          accountType: "expense",
          level: 1,
          isPosting: true,
          isActive: true,
        },
        {
          companyId: company.id,
          code: `PSLR-WASTE-${tag}`,
          nameAr: "هالك تصنيع",
          nameEn: "Manufacturing waste",
          accountType: "expense",
          level: 1,
          isPosting: true,
          isActive: true,
        },
      ])
      .returning({ id: accountsTable.id });
    assert.equal(accountRows.length, 7);
    const [
      sourceExpense,
      sourceCounterpart,
      wip,
      rawInventory,
      finishedGoods,
      variance,
      waste,
    ] = accountRows.map((row) => row.id);

    const [unit] = await tx
      .insert(unitsTable)
      .values({
        companyId: company.id,
        code: "PCE",
        nameAr: "حبة",
        nameEn: "Piece",
        conversionFactor: "1",
      })
      .returning({ id: unitsTable.id });

    const [rawItem] = await tx
      .insert(itemsTable)
      .values({
        companyId: company.id,
        unitId: unit.id,
        code: `PSLR-RAW-${tag}`,
        nameAr: "خامة تحقق",
        nameEn: "Regression raw material",
        itemType: "stock",
        itemNature: "raw",
        costPrice: "1",
        salePrice: "0",
        vatRate: "15",
        status: "active",
      })
      .returning({ id: itemsTable.id });
    const [finishedItem] = await tx
      .insert(itemsTable)
      .values({
        companyId: company.id,
        unitId: unit.id,
        code: `PSLR-FG-${tag}`,
        nameAr: "منتج تحقق",
        nameEn: "Regression finished product",
        itemType: "stock",
        itemNature: "finished",
        costPrice: "1",
        salePrice: "10",
        vatRate: "15",
        status: "active",
      })
      .returning({ id: itemsTable.id });

    const [rawWarehouse] = await tx
      .insert(warehousesTable)
      .values({
        companyId: company.id,
        code: `PSLR-RW-${tag}`,
        nameAr: "مخزن خامات التحقق",
        nameEn: "Regression raw warehouse",
        allowNegative: false,
        isActive: true,
        isDefault: false,
      })
      .returning({ id: warehousesTable.id });
    const [finishedWarehouse] = await tx
      .insert(warehousesTable)
      .values({
        companyId: company.id,
        code: `PSLR-FW-${tag}`,
        nameAr: "مخزن إنتاج التحقق",
        nameEn: "Regression finished warehouse",
        allowNegative: false,
        isActive: true,
        isDefault: false,
      })
      .returning({ id: warehousesTable.id });

    await tx.insert(manufacturingSettingsTable).values({
      companyId: company.id,
      defaultRawWarehouseId: rawWarehouse.id,
      defaultFinishedWarehouseId: finishedWarehouse.id,
      defaultWipAccountId: wip,
      defaultRawInventoryAccountId: rawInventory,
      defaultFinishedGoodsAccountId: finishedGoods,
      defaultLaborAccountId: sourceExpense,
      defaultOverheadAccountId: sourceExpense,
      defaultVarianceAccountId: variance,
      defaultWasteAccountId: waste,
    });
    await tx.insert(stockBalanceTable).values({
      companyId: company.id,
      itemId: rawItem.id,
      warehouseId: rawWarehouse.id,
      qty: "100",
      avgCost: "1",
    });

    const [bom] = await tx
      .insert(bomTemplatesTable)
      .values({
        companyId: company.id,
        productItemId: finishedItem.id,
        nameAr: "قالب تحقق",
        nameEn: "Regression BOM",
        outputQty: "1",
        outputUnitCode: "PCE",
        isActive: true,
      })
      .returning({ id: bomTemplatesTable.id });
    await tx.insert(bomTemplateLinesTable).values({
      templateId: bom.id,
      itemId: rawItem.id,
      description: "خامة تحقق",
      quantity: "1",
      unitCode: "PCE",
    });

    const payrollJournalId = await insertSourceJournal(
      tx,
      company.id,
      sourceExpense,
      sourceCounterpart,
      `PSLR-PAY-${tag}`,
    );
    const prepaidJournalId = await insertSourceJournal(
      tx,
      company.id,
      sourceExpense,
      sourceCounterpart,
      `PSLR-PRE-${tag}`,
    );

    const [employee] = await tx
      .insert(employeesTable)
      .values({
        companyId: company.id,
        code: `PSLR-EMP-${tag}`,
        nameAr: "موظف تحقق",
        nameEn: "Regression employee",
        status: "active",
      })
      .returning({ id: employeesTable.id });
    const [payroll] = await tx
      .insert(payrollRunsTable)
      .values({
        companyId: company.id,
        code: `PSLR-PAYRUN-${tag}`,
        year: 2099,
        month: 12,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        totalGross: "100",
        totalDeductions: "0",
        totalNet: "100",
        employeesCount: 1,
        status: "posted",
        postedJournalId: payrollJournalId,
        manufacturingEligible: true,
        manufacturingAllocationMethod: "operating_hours",
        approvedManufacturingHours: "100",
      })
      .returning({ id: payrollRunsTable.id });
    const [payrollLine] = await tx
      .insert(payrollLinesTable)
      .values({
        payrollRunId: payroll.id,
        employeeId: employee.id,
        basicSalary: "100",
        grossSalary: "100",
        netSalary: "100",
      })
      .returning({ id: payrollLinesTable.id });
    await tx.insert(payrollAllocationSnapshotsTable).values({
      companyId: company.id,
      payrollRunId: payroll.id,
      payrollLineId: payrollLine.id,
      employeeId: employee.id,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      days: 30,
      costBasis: "gross",
      basisAmount: "100",
      allocatedAmount: "100",
    });

    const [adjustment] = await tx
      .insert(accountingAdjustmentsTable)
      .values({
        companyId: company.id,
        type: "prepaid",
        name: `Prepaid source ${tag}`,
        expenseAccountId: sourceExpense,
        contraAccountId: sourceCounterpart,
        totalAmount: "100",
        startDate: PERIOD_START,
        endDate: PERIOD_END,
        monthlyAmount: "100",
        manufacturingEligible: true,
        manufacturingAllocationMethod: "production_quantity",
        approvedProductionQuantity: "100",
        autoGenerate: true,
        carryForwardEnabled: true,
        status: "active",
      })
      .returning({ id: accountingAdjustmentsTable.id });
    const [prepaidRun] = await tx
      .insert(accountingAdjustmentRunsTable)
      .values({
        adjustmentId: adjustment.id,
        companyId: company.id,
        periodMonth: PERIOD,
        journalEntryId: prepaidJournalId,
        amount: "100",
      })
      .returning({ id: accountingAdjustmentRunsTable.id });

    const fixture: Fixture = {
      tag,
      companyId: company.id,
      companyCode,
      crNumber,
      nameAr,
      adminUserId: admin.id,
      adminUsername,
      authUser: {
        id: admin.id,
        username: adminUsername,
        role: "admin",
        companyId: company.id,
        permissions: {},
        viewAllBranches: true,
        branchIds: [],
        companyMenuPermissions: { production: true },
      },
      finishedItemId: finishedItem.id,
      rawItemId: rawItem.id,
      unitId: unit.id,
      rawWarehouseId: rawWarehouse.id,
      finishedWarehouseId: finishedWarehouse.id,
      sourcePayrollId: payroll.id,
      sourcePrepaidId: prepaidRun.id,
      accounts: {
        sourceExpense,
        sourceCounterpart,
        wip,
        rawInventory,
        finishedGoods,
        variance,
        waste,
      },
    };
    // The proof is part of the creation transaction. If it fails, the marker
    // company and all of its fixture rows roll back together.
    await assertOwnedFixture(tx, fixture);
    return fixture;
  });
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await db.transaction(async (tx) => {
    // Never issue a cascading delete until every identity marker is checked.
    await assertOwnedFixture(tx, fixture);

    const orders = await tx
      .select({ id: productionOrdersTable.id })
      .from(productionOrdersTable)
      .where(eq(productionOrdersTable.companyId, fixture.companyId));
    const orderIds = orders.map((row) => row.id);
    const boms = await tx
      .select({ id: bomTemplatesTable.id })
      .from(bomTemplatesTable)
      .where(eq(bomTemplatesTable.companyId, fixture.companyId));
    const bomIds = boms.map((row) => row.id);
    const journals = await tx
      .select({ id: journalEntriesTable.id })
      .from(journalEntriesTable)
      .where(eq(journalEntriesTable.companyId, fixture.companyId));
    const journalIds = journals.map((row) => row.id);
    const payrolls = await tx
      .select({ id: payrollRunsTable.id })
      .from(payrollRunsTable)
      .where(eq(payrollRunsTable.companyId, fixture.companyId));
    const payrollIds = payrolls.map((row) => row.id);

    await tx
      .delete(productionDriverReconciliationsTable)
      .where(
        eq(productionDriverReconciliationsTable.companyId, fixture.companyId),
      );
    await tx
      .delete(productionOverheadClosuresTable)
      .where(eq(productionOverheadClosuresTable.companyId, fixture.companyId));
    // The immutable-allocation trigger must remain enabled everywhere else.
    // PostgreSQL's session_replication_role is transaction-local here, and
    // only this already-proven company allocation delete runs while user
    // triggers are in replica mode. If the DB role cannot set it, abort
    // rather than attempting a global trigger/session bypass.
    let replicaModeEntered = false;
    try {
      await tx.execute(sql.raw("SET LOCAL session_replication_role = replica"));
      replicaModeEntered = true;
      const modeResult = await tx.execute(
        sql.raw("SELECT current_setting('session_replication_role') AS mode"),
      );
      const mode = (modeResult as any).rows?.[0]?.mode;
      if (mode !== "replica") {
        throw new Error(
          `Safe cleanup could not verify session-local replica mode (got ${String(mode)}).`,
        );
      }
      await tx
        .delete(productionCostAllocationsTable)
        .where(eq(productionCostAllocationsTable.companyId, fixture.companyId));
    } catch (error: any) {
      if (!replicaModeEntered) {
        throw new Error(
          "Safe cleanup cannot enter transaction-local replica mode for the owned " +
            `allocation delete (${String(error?.message ?? error)}); ` +
            "no global trigger bypass was attempted.",
        );
      }
      throw error;
    } finally {
      if (replicaModeEntered) {
        await tx.execute(
          sql.raw("SET LOCAL session_replication_role = origin"),
        );
        const restoredResult = await tx.execute(
          sql.raw("SELECT current_setting('session_replication_role') AS mode"),
        );
        const restoredMode = (restoredResult as any).rows?.[0]?.mode;
        if (restoredMode !== "origin") {
          throw new Error(
            `Safe cleanup failed to restore session-local replica mode (got ${String(restoredMode)}).`,
          );
        }
      }
    }
    if (orderIds.length) {
      await tx
        .delete(productionOrderItemsTable)
        .where(inArray(productionOrderItemsTable.orderId, orderIds));
      await tx
        .delete(productionOrderStagesTable)
        .where(inArray(productionOrderStagesTable.orderId, orderIds));
    }
    await tx
      .delete(productionEventsTable)
      .where(eq(productionEventsTable.companyId, fixture.companyId));
    await tx
      .delete(productionOrdersTable)
      .where(eq(productionOrdersTable.companyId, fixture.companyId));

    if (bomIds.length) {
      await tx
        .delete(bomTemplateLinesTable)
        .where(inArray(bomTemplateLinesTable.templateId, bomIds));
    }
    await tx
      .delete(bomTemplatesTable)
      .where(eq(bomTemplatesTable.companyId, fixture.companyId));

    await tx
      .delete(accountingAdjustmentRunsTable)
      .where(eq(accountingAdjustmentRunsTable.companyId, fixture.companyId));
    await tx
      .delete(accountingAdjustmentsTable)
      .where(eq(accountingAdjustmentsTable.companyId, fixture.companyId));
    await tx
      .delete(payrollAllocationSnapshotsTable)
      .where(eq(payrollAllocationSnapshotsTable.companyId, fixture.companyId));
    if (payrollIds.length) {
      await tx
        .delete(payrollLinesTable)
        .where(inArray(payrollLinesTable.payrollRunId, payrollIds));
    }
    await tx
      .delete(payrollRunsTable)
      .where(eq(payrollRunsTable.companyId, fixture.companyId));

    if (journalIds.length) {
      await tx
        .delete(journalEntryLinesTable)
        .where(inArray(journalEntryLinesTable.entryId, journalIds));
    }
    await tx
      .delete(journalEntriesTable)
      .where(eq(journalEntriesTable.companyId, fixture.companyId));
    await tx
      .delete(employeesTable)
      .where(eq(employeesTable.companyId, fixture.companyId));
    await tx
      .delete(stockLedgerTable)
      .where(eq(stockLedgerTable.companyId, fixture.companyId));
    await tx
      .delete(stockBalanceTable)
      .where(eq(stockBalanceTable.companyId, fixture.companyId));
    await tx
      .delete(manufacturingSettingsTable)
      .where(eq(manufacturingSettingsTable.companyId, fixture.companyId));
    await tx
      .delete(warehousesTable)
      .where(eq(warehousesTable.companyId, fixture.companyId));
    await tx
      .delete(itemsTable)
      .where(eq(itemsTable.companyId, fixture.companyId));
    await tx
      .delete(unitsTable)
      .where(eq(unitsTable.companyId, fixture.companyId));
    await tx
      .delete(accountsTable)
      .where(eq(accountsTable.companyId, fixture.companyId));
    await tx
      .delete(usersTable)
      .where(eq(usersTable.companyId, fixture.companyId));
    await tx
      .delete(subscriptionsTable)
      .where(eq(subscriptionsTable.companyId, fixture.companyId));
    const deleted = await tx
      .delete(companiesTable)
      .where(
        and(
          eq(companiesTable.id, fixture.companyId),
          eq(companiesTable.code, fixture.companyCode),
          eq(companiesTable.crNumber, fixture.crNumber),
          eq(companiesTable.nameAr, fixture.nameAr),
          eq(companiesTable.isSandbox, true),
        ),
      )
      .returning({ id: companiesTable.id });
    if (deleted.length !== 1 || deleted[0].id !== fixture.companyId) {
      throw new Error("Disposable fixture cleanup ownership proof failed.");
    }
  });

  const [remaining] = await db
    .select({ id: companiesTable.id })
    .from(companiesTable)
    .where(eq(companiesTable.id, fixture.companyId))
    .limit(1);
  if (remaining) {
    throw new Error(
      "The disposable source-linked fixture still exists after cleanup.",
    );
  }
}

async function startInProcessRouter(fixture: Fixture): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).authUser = fixture.authUser;
    next();
  });
  app.use("/api/production", productionRouter);

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(
      "The in-process production router did not expose a local port.",
    );
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  return { status: response.status, body: parsed };
}

function wizardBody(
  fixture: Fixture,
  sourceType: "payroll" | "prepaid_amortization",
  sourceRecordId: number,
  requestId: string,
  amountDriver: "hours" | "quantity",
  numerator: number,
): Record<string, unknown> {
  return {
    wizardRequestId: requestId,
    title: `Source-linked ${sourceType} ${requestId}`,
    productItemId: fixture.finishedItemId,
    plannedQty: amountDriver === "quantity" ? numerator : 60,
    unitCode: "PCE",
    plannedStartDate: PERIOD_START,
    plannedEndDate: PERIOD_END,
    rawWarehouseId: fixture.rawWarehouseId,
    finishedWarehouseId: fixture.finishedWarehouseId,
    plannedHours: amountDriver === "hours" ? numerator : 0,
    costPeriod: PERIOD,
    allocations: [
      {
        sourceType,
        sourceRecordId,
        treatment: "manufacturing_overhead",
      },
    ],
    costConfiguration: {
      payroll: {
        mode: sourceType === "payroll" ? "linked" : "none",
        amount: 0,
      },
      fixed_asset_depreciation: { mode: "none", amount: 0 },
      prepaid_amortization: {
        mode: sourceType === "prepaid_amortization" ? "linked" : "none",
        amount: 0,
      },
    },
    wipAccountId: fixture.accounts.wip,
    rawInventoryAccountId: fixture.accounts.rawInventory,
    finishedGoodsAccountId: fixture.accounts.finishedGoods,
    laborAccountId: fixture.accounts.sourceExpense,
    overheadAccountId: fixture.accounts.sourceExpense,
    varianceAccountId: fixture.accounts.variance,
    wasteAccountId: fixture.accounts.waste,
  };
}

async function allocationRows(
  fixture: Fixture,
  sourceType: string,
): Promise<any[]> {
  return db
    .select()
    .from(productionCostAllocationsTable)
    .where(
      and(
        eq(productionCostAllocationsTable.companyId, fixture.companyId),
        eq(productionCostAllocationsTable.sourceType, sourceType),
      ),
    );
}

async function orderCount(fixture: Fixture): Promise<number> {
  const rows = await db
    .select({ id: productionOrdersTable.id })
    .from(productionOrdersTable)
    .where(eq(productionOrdersTable.companyId, fixture.companyId));
  return rows.length;
}

async function eventCount(fixture: Fixture): Promise<number> {
  const rows = await db
    .select({ id: productionEventsTable.id })
    .from(productionEventsTable)
    .where(eq(productionEventsTable.companyId, fixture.companyId));
  return rows.length;
}

async function insertDriverDelta(
  fixture: Fixture,
  allocation: any,
  delta: string,
  driverMethod: string,
  reversalJournalEntryId: number | null = null,
): Promise<void> {
  await db.insert(productionDriverReconciliationsTable).values({
    companyId: fixture.companyId,
    orderId: allocation.orderId,
    sourceType: allocation.sourceType,
    sourceRecordId: allocation.sourceRecordId,
    baseAllocationId: allocation.id,
    periodStart: allocation.periodStart,
    periodEnd: allocation.periodEnd,
    driverMethod,
    plannedNumerator: driverMethod === "operating_hours" ? "60" : "60",
    actualNumerator: driverMethod === "operating_hours" ? "70" : "50",
    denominatorOrRate: "100",
    sourceAmount: allocation.sourceAmount,
    baseAllocatedAmount: allocation.allocatedAmount,
    reconciledAmount: (
      Number(allocation.allocatedAmount) + Number(delta)
    ).toFixed(2),
    deltaAmount: delta,
    journalEntryId: null,
    reversalJournalEntryId,
    snapshotMeta: allocation.snapshotMeta ?? {},
    createdBy: fixture.adminUserId,
  });
}

async function runVerification(
  fixture: Fixture,
  baseUrl: string,
): Promise<void> {
  // Positive unreversed driver delta: 60 base + 10 delta leaves 30 capacity.
  const payrollBody = wizardBody(
    fixture,
    "payroll",
    fixture.sourcePayrollId,
    `pslr-pay-${fixture.tag}`,
    "hours",
    60,
  );
  const payrollCreate = await request(
    baseUrl,
    "POST",
    "/api/production/orders/wizard",
    payrollBody,
  );
  assert.equal(payrollCreate.status, 201, JSON.stringify(payrollCreate.body));
  const payrollOrderId = Number(payrollCreate.body.id);
  assert.ok(payrollOrderId > 0);

  const payrollAllocationsBeforeEdit = await allocationRows(fixture, "payroll");
  assert.equal(payrollAllocationsBeforeEdit.length, 1);
  const payrollAllocationBeforeEdit = JSON.stringify(
    payrollAllocationsBeforeEdit[0],
  );
  await insertDriverDelta(
    fixture,
    payrollAllocationsBeforeEdit[0],
    "10.00",
    "operating_hours",
  );

  const beforeRejectedOrderCount = await orderCount(fixture);
  const beforeRejectedEventCount = await eventCount(fixture);
  const beforeRejectedAllocations = await allocationRows(fixture, "payroll");
  const rejectedPayroll = await request(
    baseUrl,
    "POST",
    "/api/production/orders/wizard",
    wizardBody(
      fixture,
      "payroll",
      fixture.sourcePayrollId,
      `pslr-pay-over-${fixture.tag}`,
      "hours",
      31,
    ),
  );
  assert.equal(
    rejectedPayroll.status,
    409,
    JSON.stringify(rejectedPayroll.body),
  );
  assert.equal(await orderCount(fixture), beforeRejectedOrderCount);
  assert.equal(await eventCount(fixture), beforeRejectedEventCount);
  assert.deepEqual(
    await allocationRows(fixture, "payroll"),
    beforeRejectedAllocations,
  );

  // Same wizard request is an actual API replay, not a second historical
  // allocation. This also exercises source-linked create idempotency.
  const payrollReplay = await request(
    baseUrl,
    "POST",
    "/api/production/orders/wizard",
    payrollBody,
  );
  assert.equal(payrollReplay.status, 200, JSON.stringify(payrollReplay.body));
  assert.equal(payrollReplay.body.id, payrollOrderId);
  assert.equal(payrollReplay.body.idempotentReplay, true);
  assert.deepEqual(
    await allocationRows(fixture, "payroll"),
    beforeRejectedAllocations,
  );

  // The real edit endpoint changes the source-linked order header without
  // rewriting the immutable source allocation snapshot.
  const edited = await request(
    baseUrl,
    "PATCH",
    `/api/production/orders/${payrollOrderId}`,
    {
      title: "Source-linked payroll edited",
    },
  );
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.title, "Source-linked payroll edited");
  const editedAgain = await request(
    baseUrl,
    "PATCH",
    `/api/production/orders/${payrollOrderId}`,
    {
      title: "Source-linked payroll edited",
    },
  );
  assert.equal(editedAgain.status, 200, JSON.stringify(editedAgain.body));
  const payrollAfterEdit = await allocationRows(fixture, "payroll");
  assert.equal(
    JSON.stringify(payrollAfterEdit[0]),
    payrollAllocationBeforeEdit,
  );

  // Actual lifecycle reconciliation: create a fresh source-linked order, give
  // it one final stage fact, and let the real status handler issue, complete,
  // and create the immutable negative driver delta (20 actual quantity versus
  // 30 planned source allocation). This is intentionally not seeded directly.
  const lifecycleBody = wizardBody(
    fixture,
    "payroll",
    fixture.sourcePayrollId,
    `pslr-pay-final-${fixture.tag}`,
    "hours",
    30,
  );
  const lifecycleCreate = await request(
    baseUrl,
    "POST",
    "/api/production/orders/wizard",
    lifecycleBody,
  );
  assert.equal(
    lifecycleCreate.status,
    201,
    JSON.stringify(lifecycleCreate.body),
  );
  const lifecycleOrderId = Number(lifecycleCreate.body.id);
  assert.ok(lifecycleOrderId > 0);
  await db.insert(productionOrderStagesTable).values({
    orderId: lifecycleOrderId,
    sequence: 1,
    code: `PSLR-FINAL-${fixture.tag}`,
    nameAr: "مرحلة تحقق الإقفال",
    nameEn: "Finalization regression stage",
    status: "done",
    inputQty: "60",
    outputQty: "20",
    wasteQty: "40",
    quantityUnit: "PCE",
    wasteUnit: "PCE",
    wasteClassification: "normal",
    actualDurationMinutes: 1200,
    operatorUserId: fixture.adminUserId,
  });

  const approveLifecycle = await request(
    baseUrl,
    "POST",
    `/api/production/orders/${lifecycleOrderId}/status`,
    { status: "approved" },
  );
  assert.equal(
    approveLifecycle.status,
    200,
    JSON.stringify(approveLifecycle.body),
  );
  const startLifecycle = await request(
    baseUrl,
    "POST",
    `/api/production/orders/${lifecycleOrderId}/status`,
    { status: "in_production" },
  );
  assert.equal(startLifecycle.status, 200, JSON.stringify(startLifecycle.body));
  const qualityLifecycle = await request(
    baseUrl,
    "POST",
    `/api/production/orders/${lifecycleOrderId}/status`,
    { status: "quality_check" },
  );
  assert.equal(
    qualityLifecycle.status,
    200,
    JSON.stringify(qualityLifecycle.body),
  );
  const completeLifecycle = await request(
    baseUrl,
    "POST",
    `/api/production/orders/${lifecycleOrderId}/status`,
    { status: "completed" },
  );
  assert.equal(
    completeLifecycle.status,
    200,
    JSON.stringify(completeLifecycle.body),
  );
  const lifecycleDeltas = await db
    .select()
    .from(productionDriverReconciliationsTable)
    .where(
      and(
        eq(productionDriverReconciliationsTable.companyId, fixture.companyId),
        eq(productionDriverReconciliationsTable.orderId, lifecycleOrderId),
      ),
    );
  assert.equal(lifecycleDeltas.length, 1);
  assert.equal(Number(lifecycleDeltas[0].deltaAmount), -10);
  assert.ok(Number(lifecycleDeltas[0].journalEntryId) > 0);
  assert.equal(lifecycleDeltas[0].reversalJournalEntryId, null);

  // The real status endpoint is retry-safe: repeating completion returns the
  // committed order and must not create a second reconciliation row.
  const completeLifecycleReplay = await request(
    baseUrl,
    "POST",
    `/api/production/orders/${lifecycleOrderId}/status`,
    { status: "completed" },
  );
  assert.equal(
    completeLifecycleReplay.status,
    200,
    JSON.stringify(completeLifecycleReplay.body),
  );
  const lifecycleDeltasAfterReplay = await db
    .select({ id: productionDriverReconciliationsTable.id })
    .from(productionDriverReconciliationsTable)
    .where(
      and(
        eq(productionDriverReconciliationsTable.companyId, fixture.companyId),
        eq(productionDriverReconciliationsTable.orderId, lifecycleOrderId),
      ),
    );
  assert.equal(lifecycleDeltasAfterReplay.length, 1);

  // Negative unreversed driver delta: 60 base - 10 delta leaves 50 used, so
  // a second 50-unit source-linked order exactly exhausts the source.
  const prepaidBody = wizardBody(
    fixture,
    "prepaid_amortization",
    fixture.sourcePrepaidId,
    `pslr-pre-${fixture.tag}`,
    "quantity",
    60,
  );
  const prepaidCreate = await request(
    baseUrl,
    "POST",
    "/api/production/orders/wizard",
    prepaidBody,
  );
  assert.equal(prepaidCreate.status, 201, JSON.stringify(prepaidCreate.body));
  const prepaidAllocation = (
    await allocationRows(fixture, "prepaid_amortization")
  )[0];
  assert.ok(prepaidAllocation);
  const prepaidAllocationSnapshot = JSON.stringify(prepaidAllocation);
  await insertDriverDelta(
    fixture,
    prepaidAllocation,
    "-10.00",
    "production_quantity",
  );

  const prepaidSecondBody = wizardBody(
    fixture,
    "prepaid_amortization",
    fixture.sourcePrepaidId,
    `pslr-pre-second-${fixture.tag}`,
    "quantity",
    50,
  );
  const prepaidSecond = await request(
    baseUrl,
    "POST",
    "/api/production/orders/wizard",
    prepaidSecondBody,
  );
  assert.equal(prepaidSecond.status, 201, JSON.stringify(prepaidSecond.body));
  assert.equal(
    (await allocationRows(fixture, "prepaid_amortization")).length,
    2,
  );

  // A second save of the successful source-linked order remains idempotent,
  // while the original historical allocation remains byte-for-byte unchanged.
  const prepaidReplay = await request(
    baseUrl,
    "POST",
    "/api/production/orders/wizard",
    prepaidSecondBody,
  );
  assert.equal(prepaidReplay.status, 200, JSON.stringify(prepaidReplay.body));
  assert.equal(prepaidReplay.body.idempotentReplay, true);
  const prepaidAfterReplay = await allocationRows(
    fixture,
    "prepaid_amortization",
  );
  assert.equal(prepaidAfterReplay.length, 2);
  assert.equal(
    JSON.stringify(
      prepaidAfterReplay.find((row) => row.id === prepaidAllocation.id),
    ),
    prepaidAllocationSnapshot,
  );

  // A reversed delta must not reach the closure snapshot. The wizard leaves
  // draft orders pending issue, so this narrow fixture marks only those draft
  // source-linked orders as issued/completed with one authentic posted issue
  // journal before asking the real closure endpoint for its snapshot. The
  // lifecycle order keeps the issue/receipt journals created by the handler.
  const issueJournalId = await db.transaction((tx) =>
    insertSourceJournal(
      tx,
      fixture.companyId,
      fixture.accounts.sourceExpense,
      fixture.accounts.sourceCounterpart,
      `PSLR-ISSUE-${fixture.tag}`,
    ),
  );
  const draftOrders = await db
    .select({ id: productionOrdersTable.id })
    .from(productionOrdersTable)
    .where(
      and(
        eq(productionOrdersTable.companyId, fixture.companyId),
        eq(productionOrdersTable.status, "draft"),
      ),
    );
  assert.equal(draftOrders.length, 3);
  await db
    .update(productionOrdersTable)
    .set({ status: "completed", issueJournalEntryId: issueJournalId })
    .where(
      and(
        eq(productionOrdersTable.companyId, fixture.companyId),
        eq(productionOrdersTable.status, "draft"),
      ),
    );

  const prepaidSecondAllocation = prepaidAfterReplay.find(
    (row) => row.id !== prepaidAllocation.id,
  );
  assert.ok(prepaidSecondAllocation);
  await insertDriverDelta(
    fixture,
    prepaidSecondAllocation,
    "30.00",
    "production_quantity",
    issueJournalId,
  );

  const closure = await request(
    baseUrl,
    "POST",
    "/api/production/overhead-closures",
    {
      period: PERIOD,
      correctionDate: PERIOD_END,
      varianceAccountId: fixture.accounts.variance,
    },
  );
  assert.equal(closure.status, 201, JSON.stringify(closure.body));
  assert.equal(Number(closure.body.actualAmount), 100);
  assert.equal(Number(closure.body.appliedAmount), 90);
  assert.equal(Number(closure.body.varianceAmount), 10);
  const closureSources = Array.isArray(closure.body.sourceSnapshot)
    ? closure.body.sourceSnapshot
    : [];
  assert.equal(closureSources.length, 1);
  assert.equal(closureSources[0].sourceType, "payroll");
  assert.equal(Number(closureSources[0].appliedAmount), 90);
}

async function main(): Promise<void> {
  requireDevelopmentOptIn();
  let fixture: Fixture | null = null;
  let server: Server | null = null;
  const failures: unknown[] = [];
  try {
    fixture = await createFixture();
    const started = await startInProcessRouter(fixture);
    server = started.server;
    await runVerification(fixture, started.baseUrl);
  } catch (error) {
    failures.push(error);
  } finally {
    if (server) {
      try {
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (fixture) {
      try {
        await cleanupFixture(fixture);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    try {
      await pool.end();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(
          failures,
          "Source-linked regression and/or cleanup failed",
        );
  }
  console.log(
    "[production-source-linked] PASS: source-linked create/edit, positive/negative " +
      "unreversed driver capacity, replay idempotency, historical snapshot immutability, " +
      "failed-save atomicity, live-only closure snapshot reconciliation, and cleanup",
  );
}

async function cleanupOwnedMain(companyId: number): Promise<void> {
  requireDevelopmentOptIn();
  const failures: unknown[] = [];
  try {
    const fixture = await recoverOwnedFixture(companyId);
    await cleanupFixture(fixture);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await pool.end();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Owned-fixture cleanup failed");
  }
  console.log(
    `[production-source-linked] PASS: cleanup-only removed owned disposable company ${companyId}`,
  );
}

const cleanupFlag = process.argv.indexOf("--cleanup-owned");
if (cleanupFlag >= 0) {
  const rawCompanyId = process.argv[cleanupFlag + 1];
  if (
    cleanupFlag !== 2 ||
    process.argv.length !== cleanupFlag + 2 ||
    !rawCompanyId
  ) {
    throw new Error(
      "Usage: production-source-linked-regression.ts --cleanup-owned <companyId>",
    );
  }
  await cleanupOwnedMain(Number(rawCompanyId));
} else {
  if (process.argv.length > 2) {
    throw new Error(
      "Unknown arguments. Use --cleanup-owned <companyId> only for owned-fixture recovery.",
    );
  }
  await main();
}
