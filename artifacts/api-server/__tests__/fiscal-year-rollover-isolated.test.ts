// Focused year-end rollover regression test. Opt in with
// FISCAL_YEAR_ROLLOVER_TEST=1 and run this file by itself; no shared business
// tenant is modified.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import bcrypt from "bcryptjs";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountsTable,
  auditLogTable,
  companiesTable,
  db,
  fiscalPeriodsTable,
  fiscalYearsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  pool,
  usersTable,
} from "@workspace/db";
import app from "../src/app.ts";

const armed = process.env.FISCAL_YEAR_ROLLOVER_TEST === "1";

test("full annual close zeros revenue/expense reports and creates one open successor",
  { skip: !armed }, async () => {
    const tag = `fyroll_${randomBytes(6).toString("hex")}`;
    let companyId: number | undefined;
    let adminId: number | undefined;
    let server: http.Server | undefined;
    const entryIds: number[] = [];

    try {
      const [company] = await db.insert(companiesTable).values({
        nameAr: `اختبار إقفال السنة ${tag}`,
        nameEn: `Fiscal close test ${tag}`,
        vatNumber: `3${randomBytes(7).toString("hex").slice(0, 13)}`,
        crNumber: `CR-${tag}`,
        city: "Riyadh",
        street: "Test",
        buildingNumber: "1",
        postalCode: "12345",
      }).returning();
      companyId = company.id;

      const token = randomBytes(32).toString("hex");
      const [admin] = await db.insert(usersTable).values({
        username: `${tag}_admin`,
        passwordHash: await bcrypt.hash("test-only", 4),
        role: "admin",
        companyId,
        sessionToken: token,
      }).returning({ id: usersTable.id });
      adminId = admin.id;

      const accounts = await db.insert(accountsTable).values([
        {
          companyId, code: `${tag}_asset`, nameAr: "أصل للاختبار",
          accountType: "asset", isPosting: true, level: 4,
        },
        {
          companyId, code: `${tag}_retained`, nameAr: "أرباح محتجزة للاختبار",
          accountType: "equity", isPosting: true, level: 4,
        },
        {
          companyId, code: `${tag}_pl_summary`, nameAr: "ملخص الأرباح والخسائر",
          accountType: "equity", isPosting: true, level: 4,
        },
        {
          companyId, code: `${tag}_revenue`, nameAr: "إيرادات للاختبار",
          accountType: "revenue", isPosting: true, level: 4,
        },
        {
          companyId, code: `${tag}_expense`, nameAr: "مصروفات للاختبار",
          accountType: "expense", isPosting: true, level: 4,
        },
      ]).returning();

      const startDate = "2025-04-01";
      const endDate = "2026-03-31";
      const [year] = await db.insert(fiscalYearsTable).values({
        companyId, name: `اختبار السنة ${tag}`, startDate, endDate, status: "open",
      }).returning();

      const periods = Array.from({ length: 12 }, (_, index) => {
        const monthStart = new Date(Date.UTC(2025, 3 + index, 1));
        const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0));
        const iso = (date: Date) => date.toISOString().slice(0, 10);
        return {
          companyId: companyId!,
          fiscalYearId: year.id,
          name: `فترة اختبار ${index + 1}`,
          startDate: iso(monthStart),
          endDate: iso(monthEnd),
          sequence: index + 1,
          status: "open" as const,
        };
      });
      const insertedPeriods = await db.insert(fiscalPeriodsTable).values(periods).returning();

      // A posted, balanced balance-sheet JE is the carry-forward source.
      const julyPeriod = insertedPeriods[3];
      const [entry] = await db.insert(journalEntriesTable).values({
        companyId,
        entryDate: "2025-07-15",
        currency: "SAR",
        exchangeRate: "1",
        description: `رصيد مرحّل للاختبار ${tag}`,
        entryType: "general",
        status: "posted",
        periodId: julyPeriod.id,
      }).returning();
      entryIds.push(entry.id);
      await db.insert(journalEntryLinesTable).values([
        { entryId: entry.id, accountId: accounts[0].id, debit: "1250.00", credit: "0", sortOrder: 0 },
        { entryId: entry.id, accountId: accounts[1].id, debit: "0", credit: "1250.00", sortOrder: 1 },
      ]);
      for (const [index, period] of insertedPeriods.entries()) {
        const [plEntry] = await db.insert(journalEntriesTable).values({
          companyId,
          entryDate: period.startDate,
          currency: "SAR",
          exchangeRate: "1",
          description: `نشاط إيراد ومصروف للاختبار ${tag} ${index + 1}`,
          entryType: "general",
          status: "posted",
          periodId: period.id,
        }).returning();
        entryIds.push(plEntry.id);
        await db.insert(journalEntryLinesTable).values([
          { entryId: plEntry.id, accountId: accounts[0].id, debit: "1200.00", credit: "0", sortOrder: 0 },
          { entryId: plEntry.id, accountId: accounts[3].id, debit: "0", credit: "1200.00", sortOrder: 1 },
          { entryId: plEntry.id, accountId: accounts[4].id, debit: "250.00", credit: "0", sortOrder: 2 },
          { entryId: plEntry.id, accountId: accounts[0].id, debit: "0", credit: "250.00", sortOrder: 3 },
        ]);
      }

      await new Promise<void>((resolve) => {
        server = app.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test API server did not bind");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const send = async (path: string, method: string, body?: unknown) => {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: body == null ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() as any };
      };

      const beforeCloseIncome = await send(
        `/api/accounting-reports/income-statement?fromDate=${startDate}&toDate=${endDate}&companyId=${companyId}`,
        "GET",
      );
      assert.equal(beforeCloseIncome.status, 200, JSON.stringify(beforeCloseIncome.body));
      assert.ok(Math.abs(beforeCloseIncome.body.totalRevenue - 14400) < 0.005, JSON.stringify(beforeCloseIncome.body));
      assert.ok(Math.abs(beforeCloseIncome.body.totalExpenses - 3000) < 0.005, JSON.stringify(beforeCloseIncome.body));
      assert.ok(Math.abs(beforeCloseIncome.body.netIncome - 11400) < 0.005, JSON.stringify(beforeCloseIncome.body));

      const closePeriodThroughApi = async (period: typeof insertedPeriods[number]) => {
        const validation = await send(`/api/fiscal/periods/${period.id}/validate?companyId=${companyId}`, "GET");
        assert.equal(validation.status, 200, JSON.stringify(validation.body));
        assert.equal(validation.body.ok, true, JSON.stringify(validation.body.issues));

        const closePl = await send(`/api/fiscal/periods/${period.id}/close-pl?companyId=${companyId}`, "POST", {
          plSummaryAccountId: accounts[2].id,
        });
        assert.equal(closePl.status, 200, JSON.stringify(closePl.body));
        assert.equal(closePl.body.created.length, 2);
        assert.equal(closePl.body.netIncome, 950);

        const transfer = await send(`/api/fiscal/periods/${period.id}/transfer-profit?companyId=${companyId}`, "POST", {
          plSummaryAccountId: accounts[2].id,
          retainedEarningsAccountId: accounts[1].id,
        });
        assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
        assert.equal(transfer.body.isProfit, true);
        assert.equal(transfer.body.amount, 950);

        const softClose = await send(`/api/fiscal/periods/${period.id}/soft-close?companyId=${companyId}`, "POST", {});
        assert.equal(softClose.status, 200, JSON.stringify(softClose.body));
        assert.equal(softClose.body.plClosed, true);
        const hardClose = await send(`/api/fiscal/periods/${period.id}/hard-close?companyId=${companyId}`, "POST", {});
        assert.equal(hardClose.status, 200, JSON.stringify(hardClose.body));
        assert.equal(hardClose.body.period.status, "permanently_closed");
      };
      for (const period of insertedPeriods) await closePeriodThroughApi(period);
      assert.equal((await db.select().from(fiscalYearsTable).where(eq(fiscalYearsTable.companyId, companyId))).length, 1,
        "closing the months must not create a fiscal year");
      await db.update(fiscalYearsTable).set({ status: "closed" }).where(eq(fiscalYearsTable.id, year.id));

      const finalized = await send(`/api/fiscal/years/${year.id}/status?companyId=${companyId}`, "PATCH", {
        status: "permanently_closed",
      });
      assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
      assert.equal(finalized.body.year.status, "permanently_closed");
      assert.equal(finalized.body.successorCreated, true);
      assert.equal(finalized.body.successorYear.startDate, "2026-04-01");
      assert.equal(finalized.body.successorYear.endDate, "2027-03-31");
      assert.equal(finalized.body.balancesCarryForwardFromHistory, true);

      const incomeStatement = await send(
        `/api/accounting-reports/income-statement?fromDate=${startDate}&toDate=${endDate}&companyId=${companyId}`,
        "GET",
      );
      assert.equal(incomeStatement.status, 200, JSON.stringify(incomeStatement.body));
      assert.ok(Math.abs(incomeStatement.body.totalRevenue) < 0.005, JSON.stringify(incomeStatement.body));
      assert.ok(Math.abs(incomeStatement.body.totalExpenses) < 0.005, JSON.stringify(incomeStatement.body));
      assert.ok(Math.abs(incomeStatement.body.netIncome) < 0.005, JSON.stringify(incomeStatement.body));

      const trialBalance = await send(
        `/api/accounting-reports/trial-balance?fromDate=${startDate}&toDate=${endDate}&companyId=${companyId}`,
        "GET",
      );
      assert.equal(trialBalance.status, 200, JSON.stringify(trialBalance.body));
      for (const account of [accounts[3], accounts[4]]) {
        const row = trialBalance.body.find((item: any) => item.id === account.id);
        assert.ok(row, `trial balance must include ${account.code}`);
        assert.ok(Math.abs(Number(row.balance)) < 0.005, `${account.code} should close to zero: ${JSON.stringify(row)}`);
      }
      const balanceSheet = await send(
        `/api/accounting-reports/balance-sheet?asOfDate=${endDate}&companyId=${companyId}`,
        "GET",
      );
      assert.equal(balanceSheet.status, 200, JSON.stringify(balanceSheet.body));
      assert.ok(
        Math.abs(balanceSheet.body.totalAssets + balanceSheet.body.totalLiabilitiesAndEquity) < 0.01,
        JSON.stringify(balanceSheet.body),
      );

      const successorPeriods = await db.select().from(fiscalPeriodsTable)
        .where(and(eq(fiscalPeriodsTable.companyId, companyId), eq(fiscalPeriodsTable.fiscalYearId, finalized.body.successorYear.id)));
      assert.equal(successorPeriods.length, 12);
      assert.ok(successorPeriods.every((period) => period.status === "open"));
      assert.equal(successorPeriods[0].startDate, "2026-04-01");
      assert.equal(successorPeriods.at(-1)?.endDate, "2027-03-31");

      const [preservedEntry] = await db.select().from(journalEntriesTable)
        .where(and(eq(journalEntriesTable.companyId, companyId), eq(journalEntriesTable.id, entry.id)));
      assert.equal(preservedEntry.status, "posted");
      const closeEntries = await db.select().from(journalEntriesTable).where(and(
        eq(journalEntriesTable.companyId, companyId),
        inArray(journalEntriesTable.entryType, [
          "closing_revenue", "closing_expense", "closing_transfer_profit", "closing_transfer_loss",
        ]),
      ));
      assert.equal(closeEntries.filter((item) => item.entryType === "closing_revenue").length, 12);
      assert.equal(closeEntries.filter((item) => item.entryType === "closing_expense").length, 12);
      assert.equal(closeEntries.filter((item) => item.entryType === "closing_transfer_profit").length, 12);
      const duplicateOpenings = await db.select().from(journalEntriesTable).where(and(
        eq(journalEntriesTable.companyId, companyId),
        eq(journalEntriesTable.entryType, "opening"),
        inArray(journalEntriesTable.entryDate, successorPeriods.map((period) => period.startDate)),
      ));
      assert.equal(duplicateOpenings.length, 0, "rollover must not duplicate prior posted balances as opening JEs");

      const replay = await send(`/api/fiscal/years/${year.id}/status?companyId=${companyId}`, "PATCH", {
        status: "permanently_closed",
      });
      assert.equal(replay.status, 400, "a finalized year cannot be finalized again");
      assert.equal((await db.select().from(fiscalYearsTable).where(eq(fiscalYearsTable.companyId, companyId))).length, 2,
        "repeating final approval must not create a duplicate successor year");
      assert.equal((await db.select().from(fiscalPeriodsTable).where(eq(fiscalPeriodsTable.companyId, companyId))).length, 24,
        "repeating final approval must not duplicate successor periods");
    } finally {
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
          server!.closeAllConnections?.();
        });
      }
      if (companyId != null) {
        await db.delete(auditLogTable).where(eq(auditLogTable.companyId, companyId)).catch(() => {});
        const allEntries = await db.select({ id: journalEntriesTable.id }).from(journalEntriesTable)
          .where(eq(journalEntriesTable.companyId, companyId)).catch(() => []);
        const allEntryIds = [...new Set([...entryIds, ...allEntries.map((item) => item.id)])];
        if (allEntryIds.length) {
          await db.delete(journalEntryLinesTable).where(inArray(journalEntryLinesTable.entryId, allEntryIds)).catch(() => {});
          await db.delete(journalEntriesTable).where(inArray(journalEntriesTable.id, allEntryIds)).catch(() => {});
        }
        await db.delete(fiscalPeriodsTable).where(eq(fiscalPeriodsTable.companyId, companyId)).catch(() => {});
        await db.delete(fiscalYearsTable).where(eq(fiscalYearsTable.companyId, companyId)).catch(() => {});
        await db.delete(accountsTable).where(eq(accountsTable.companyId, companyId)).catch(() => {});
        if (adminId != null) await db.delete(usersTable).where(eq(usersTable.id, adminId)).catch(() => {});
        await db.delete(companiesTable).where(eq(companiesTable.id, companyId)).catch(() => {});
      }
      await pool.end().catch(() => {});
    }
  });
