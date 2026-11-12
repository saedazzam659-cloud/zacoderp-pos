import { useMemo, useState } from "react";
import { uiText } from "../lib/appSettings";
import { accountHierarchyPrintFilters, printAccountingReport } from "../lib/accountingReportPrint";
import { reportLedgerLines, type LedgerLine } from "../lib/reports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, btnSecondary, fmt, todayStr, ExportButtons } from "./_adminUi";
import { useDimensions, useReportAccounts, DateField, BranchField, CostCenterField, AccountHierarchyFields } from "./_reportFilters";
import type { ExportColumn } from "../lib/exporters";
import { filterAccountReportRows, type AccountLevelMode } from "../lib/accountReportFilters";

type Row = { accountId: number; code: string; name: string; amount: number };

type ISExportRow = { code: string; name: string; amount: number | string };

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

export default function IncomeStatementReport() {
  const { branches, costCenters } = useDimensions();
  const { accounts, loading: accountsLoading, error: accountsError, refreshAccounts } = useReportAccounts();
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [parentIds, setParentIds] = useState<number[]>([]);
  const [levelMode, setLevelMode] = useState<AccountLevelMode>("all");
  const [showZero, setShowZero] = useState(false);
  const [data, setData] = useState<{ revenues: Row[]; expenses: Row[]; totalRevenue: number; totalExpenses: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
    setErr(null); setLoading(true);
    try {
      const allAccounts = await refreshAccounts();
      const lines = await reportLedgerLines({
        toDate,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
      });
      const rev = new Map<number, Row>();
      const exp = new Map<number, Row>();
      for (const l of lines as LedgerLine[]) {
        if (l.entryDate < fromDate) continue;
        if (l.accountType === "revenue") {
          const r = rev.get(l.accountId) ?? { accountId: l.accountId, code: l.accountCode, name: l.accountName, amount: 0 };
          r.amount += l.credit - l.debit; rev.set(l.accountId, r);
        } else if (l.accountType === "expense") {
          const r = exp.get(l.accountId) ?? { accountId: l.accountId, code: l.accountCode, name: l.accountName, amount: 0 };
          r.amount += l.debit - l.credit; exp.set(l.accountId, r);
        }
      }
      for (const account of allAccounts) {
        if (account.type === "revenue" && !rev.has(account.id)) {
          rev.set(account.id, { accountId: account.id, code: account.code, name: account.nameAr, amount: 0 });
        }
        if (account.type === "expense" && !exp.has(account.id)) {
          exp.set(account.id, { accountId: account.id, code: account.code, name: account.nameAr, amount: 0 });
        }
      }
      const byCode = (a: Row, b: Row) => a.code.localeCompare(b.code, undefined, { numeric: true });
      const revenues = [...rev.values()].sort(byCode);
      const expenses = [...exp.values()].sort(byCode);
      setData({
        revenues, expenses,
        totalRevenue: revenues.reduce((s, r) => s + r.amount, 0),
        totalExpenses: expenses.reduce((s, r) => s + r.amount, 0),
      });
    } catch (e) {
      setErr(typeof e === "string" ? e : (e as Error)?.message ?? "تعذر تحميل التقرير");
    } finally { setLoading(false); }
  }

  const shownData = useMemo(() => {
    if (!data) return null;
    const filterGroup = (group: Row[]) => {
      const hierarchyRows = filterAccountReportRows(group, accounts, { parentIds, levelMode });
      return showZero ? hierarchyRows : hierarchyRows.filter((r) => Math.abs(r.amount) > 0.001);
    };
    const revenues = filterGroup(data.revenues);
    const expenses = filterGroup(data.expenses);
    return {
      revenues,
      expenses,
      totalRevenue: revenues.reduce((sum, row) => sum + row.amount, 0),
      totalExpenses: expenses.reduce((sum, row) => sum + row.amount, 0),
    };
  }, [data, accounts, parentIds, levelMode, showZero]);

  const netIncome = shownData ? shownData.totalRevenue - shownData.totalExpenses : 0;
  const isProfit = netIncome >= 0;
  const branchLabel = branchId === "" ? uiText("كل الفروع", "All branches") : branches.find((branch) => branch.id === branchId)?.nameAr ?? "";
  const costCenterLabel = costCenterId === "" ? uiText("كل مراكز التكلفة", "All cost centers") : costCenters.find((center) => center.id === costCenterId)?.nameAr ?? "";
  function printReport() {
    if (!shownData) return;
    printAccountingReport({
      title: uiText("قائمة الدخل", "Income statement"),
      subtitle: uiText("الإيرادات والمصروفات وصافي الربح أو الخسارة", "Revenue, expenses, and net profit or loss"),
      filters: [
        `${uiText("الفترة", "Period")}: ${fromDate} — ${toDate}`,
        `${uiText("الفرع", "Branch")}: ${branchLabel}`,
        `${uiText("مركز التكلفة", "Cost center")}: ${costCenterLabel}`,
        ...accountHierarchyPrintFilters(accounts, parentIds, levelMode, showZero),
      ],
      summaries: [
        { label: uiText("إجمالي الإيرادات", "Total revenue"), value: shownData.totalRevenue },
        { label: uiText("إجمالي المصروفات", "Total expenses"), value: shownData.totalExpenses },
        { label: isProfit ? uiText("صافي الربح", "Net profit") : uiText("صافي الخسارة", "Net loss"), value: Math.abs(netIncome), emphasis: true },
      ],
      sections: [
        {
          title: uiText("الإيرادات", "Revenue"),
          columns: [uiText("الكود", "Code"), uiText("الحساب", "Account"), uiText("المبلغ", "Amount")],
          rows: shownData.revenues.map((row) => [row.code, row.name, row.amount]),
          totalRow: ["", uiText("إجمالي الإيرادات", "Total revenue"), shownData.totalRevenue],
        },
        {
          title: uiText("المصروفات", "Expenses"),
          columns: [uiText("الكود", "Code"), uiText("الحساب", "Account"), uiText("المبلغ", "Amount")],
          rows: shownData.expenses.map((row) => [row.code, row.name, row.amount]),
          totalRow: ["", uiText("إجمالي المصروفات", "Total expenses"), shownData.totalExpenses],
        },
      ],
    });
  }

  const exportRows: ISExportRow[] = shownData
    ? [
        { code: "", name: "الإيرادات", amount: "" },
        ...shownData.revenues.map((r): ISExportRow => ({ code: r.code, name: r.name, amount: r.amount })),
        { code: "", name: "إجمالي الإيرادات", amount: shownData.totalRevenue },
        { code: "", name: "المصروفات", amount: "" },
        ...shownData.expenses.map((r): ISExportRow => ({ code: r.code, name: r.name, amount: r.amount })),
        { code: "", name: "إجمالي المصروفات", amount: shownData.totalExpenses },
        { code: "", name: isProfit ? "صافي الربح" : "صافي الخسارة", amount: Math.abs(netIncome) },
      ]
    : [];
  const exportCols: ExportColumn<ISExportRow>[] = [
    { header: "الكود", cell: (r) => r.code },
    { header: "الحساب", cell: (r) => r.name },
    { header: "المبلغ", cell: (r) => r.amount },
  ];

  return (
    <Page title="قائمة الدخل" subtitle="الإيرادات والمصروفات وصافي الربح/الخسارة خلال الفترة (القيود المرحّلة فقط).">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <DateField label="من تاريخ" value={fromDate} onChange={setFromDate} />
          <DateField label="إلى تاريخ" value={toDate} onChange={setToDate} />
          <BranchField branches={branches} value={branchId} onChange={setBranchId} />
          <CostCenterField costCenters={costCenters} value={costCenterId} onChange={setCostCenterId} />
          <AccountHierarchyFields
            accounts={accounts}
            parentIds={parentIds}
            onParentIdsChange={setParentIds}
            levelMode={levelMode}
            onLevelModeChange={setLevelMode}
            showZero={showZero}
            onShowZeroChange={setShowZero}
          />
          <button onClick={run} disabled={loading || accountsLoading} style={btnPrimary}>{loading ? "..." : "عرض"}</button>
        </div>
        {accountsError && <div style={{ marginTop: 8, color: "#b91c1c", fontSize: 13 }}>{accountsError}</div>}
        {err && <div style={{ marginTop: 8, color: "#b91c1c", fontSize: 13 }}>{err}</div>}
      </Card>

      {shownData && (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <button type="button" onClick={printReport} style={btnSecondary}>🖨️ {uiText("طباعة", "Print")}</button>
            <ExportButtons columns={exportCols} rows={exportRows} filenameBase="قائمة-الدخل" title={`قائمة الدخل — ${fromDate} ← ${toDate}`} />
          </div>
          <Card style={{ marginBottom: 16 }}>
            <h3 style={{ margin: "0 0 8px", color: "#15803d" }}>الإيرادات</h3>
            {shownData.revenues.length === 0 ? <Empty text="لا توجد إيرادات" /> : (
              <Table>
                <thead><tr><Th style={{ width: 120 }}>الكود</Th><Th>الحساب</Th><Th style={{ textAlign: "left", width: 160 }}>المبلغ</Th></tr></thead>
                <tbody>
                  {shownData.revenues.map((r) => (<tr key={r.accountId}><Td mono>{r.code}</Td><Td>{r.name}</Td><Td num style={{ color: "#15803d" }}>{fmt(r.amount)}</Td></tr>))}
                  <tr style={{ fontWeight: 700, background: "#ecfdf5" }}><Td colSpan={2}>إجمالي الإيرادات</Td><Td num>{fmt(shownData.totalRevenue)}</Td></tr>
                </tbody>
              </Table>
            )}
          </Card>

          <Card style={{ marginBottom: 16 }}>
            <h3 style={{ margin: "0 0 8px", color: "#b91c1c" }}>المصروفات</h3>
            {shownData.expenses.length === 0 ? <Empty text="لا توجد مصروفات" /> : (
              <Table>
                <thead><tr><Th style={{ width: 120 }}>الكود</Th><Th>الحساب</Th><Th style={{ textAlign: "left", width: 160 }}>المبلغ</Th></tr></thead>
                <tbody>
                  {shownData.expenses.map((r) => (<tr key={r.accountId}><Td mono>{r.code}</Td><Td>{r.name}</Td><Td num style={{ color: "#b91c1c" }}>{fmt(r.amount)}</Td></tr>))}
                  <tr style={{ fontWeight: 700, background: "#fef2f2" }}><Td colSpan={2}>إجمالي المصروفات</Td><Td num>{fmt(shownData.totalExpenses)}</Td></tr>
                </tbody>
              </Table>
            )}
          </Card>

          <Card style={{ background: isProfit ? "#ecfdf5" : "#fef2f2", border: `2px solid ${isProfit ? "#86efac" : "#fca5a5"}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: 18, color: isProfit ? "#15803d" : "#b91c1c" }}>{isProfit ? "صافي الربح" : "صافي الخسارة"}</span>
              <span style={{ fontWeight: 700, fontSize: 22, color: isProfit ? "#15803d" : "#b91c1c" }}>{fmt(Math.abs(netIncome))}</span>
            </div>
          </Card>
        </>
      )}
    </Page>
  );
}
