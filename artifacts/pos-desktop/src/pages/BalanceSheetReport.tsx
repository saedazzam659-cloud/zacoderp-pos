import { useMemo, useState } from "react";
import { uiText } from "../lib/appSettings";
import { accountHierarchyPrintFilters, printAccountingReport } from "../lib/accountingReportPrint";
import { reportLedgerLines, type LedgerLine } from "../lib/reports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, btnSecondary, fmt, todayStr, ExportButtons } from "./_adminUi";
import { useDimensions, useReportAccounts, DateField, BranchField, CostCenterField, AccountHierarchyFields } from "./_reportFilters";
import type { ExportColumn } from "../lib/exporters";
import { filterAccountReportRows, type AccountLevelMode } from "../lib/accountReportFilters";
import { ReportSummaryCards } from "../components/ReportSummaryCards";
import { ReportDisplayLayout } from "../components/ReportDisplayLayout";

type Row = { accountId: number; code: string; name: string; balance: number };

type BSExportRow = { code: string; name: string; amount: number | string };

export default function BalanceSheetReport() {
  const { branches, costCenters } = useDimensions();
  const { accounts, loading: accountsLoading, error: accountsError, refreshAccounts } = useReportAccounts();
  const [asOfDate, setAsOfDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [parentIds, setParentIds] = useState<number[]>([]);
  const [levelMode, setLevelMode] = useState<AccountLevelMode>("all");
  const [showZero, setShowZero] = useState(false);
  const [data, setData] = useState<{
    assets: Row[]; liabilities: Row[]; equity: Row[];
    totalAssets: number; totalLiabilities: number; totalEquity: number; netIncome: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setErr(null);
    setLoading(true);
    try {
      const allAccounts = await refreshAccounts();
      const lines = await reportLedgerLines({
        toDate: asOfDate,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
      });
      const assets = new Map<number, Row>();
      const liabilities = new Map<number, Row>();
      const equity = new Map<number, Row>();
      let netIncome = 0;
      for (const l of lines as LedgerLine[]) {
        const delta = l.debit - l.credit;
        if (l.accountType === "asset") {
          const r = assets.get(l.accountId) ?? { accountId: l.accountId, code: l.accountCode, name: l.accountName, balance: 0 };
          r.balance += delta; assets.set(l.accountId, r);
        } else if (l.accountType === "liability") {
          const r = liabilities.get(l.accountId) ?? { accountId: l.accountId, code: l.accountCode, name: l.accountName, balance: 0 };
          r.balance += delta; liabilities.set(l.accountId, r);
        } else if (l.accountType === "equity") {
          const r = equity.get(l.accountId) ?? { accountId: l.accountId, code: l.accountCode, name: l.accountName, balance: 0 };
          r.balance += delta; equity.set(l.accountId, r);
        } else if (l.accountType === "revenue") {
          netIncome += l.credit - l.debit;
        } else if (l.accountType === "expense") {
          netIncome -= l.debit - l.credit;
        }
      }
      for (const account of allAccounts) {
        if (account.type === "asset" && !assets.has(account.id)) {
          assets.set(account.id, { accountId: account.id, code: account.code, name: account.nameAr, balance: 0 });
        } else if (account.type === "liability" && !liabilities.has(account.id)) {
          liabilities.set(account.id, { accountId: account.id, code: account.code, name: account.nameAr, balance: 0 });
        } else if (account.type === "equity" && !equity.has(account.id)) {
          equity.set(account.id, { accountId: account.id, code: account.code, name: account.nameAr, balance: 0 });
        }
      }
      const byCode = (a: Row, b: Row) => a.code.localeCompare(b.code, undefined, { numeric: true });
      const assetRows = [...assets.values()].sort(byCode);
      const liabRows = [...liabilities.values()].sort(byCode);
      const equityRows = [...equity.values()].sort(byCode);
      const totalAssets = assetRows.reduce((s, r) => s + r.balance, 0);
      const totalLiabilities = liabRows.reduce((s, r) => s + -r.balance, 0);
      const totalEquity = equityRows.reduce((s, r) => s + -r.balance, 0) + netIncome;
      setData({ assets: assetRows, liabilities: liabRows, equity: equityRows, totalAssets, totalLiabilities, totalEquity, netIncome });
    } catch (e) {
      setErr(typeof e === "string" ? e : (e as Error)?.message ?? "تعذر تحميل التقرير");
    } finally { setLoading(false); }
  }

  const shownData = useMemo(() => {
    if (!data) return null;
    const filterGroup = (group: Row[]) => {
      const hierarchyRows = filterAccountReportRows(group, accounts, { parentIds, levelMode });
      return showZero ? hierarchyRows : hierarchyRows.filter((r) => Math.abs(r.balance) > 0.001);
    };
    const assets = filterGroup(data.assets);
    const liabilities = filterGroup(data.liabilities);
    const equity = filterGroup(data.equity);
    const totalAssets = assets.reduce((sum, row) => sum + row.balance, 0);
    const totalLiabilities = liabilities.reduce((sum, row) => sum - row.balance, 0);
    const totalEquity = equity.reduce((sum, row) => sum - row.balance, 0) + data.netIncome;
    return { ...data, assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity };
  }, [data, accounts, parentIds, levelMode, showZero]);

  const totalLE = shownData ? shownData.totalLiabilities + shownData.totalEquity : 0;
  const balanced = shownData ? Math.abs(shownData.totalAssets - totalLE) < 0.01 : true;
  const branchLabel = branchId === "" ? uiText("كل الفروع", "All branches") : branches.find((branch) => branch.id === branchId)?.nameAr ?? "";
  const costCenterLabel = costCenterId === "" ? uiText("كل مراكز التكلفة", "All cost centers") : costCenters.find((center) => center.id === costCenterId)?.nameAr ?? "";
  function printReport() {
    if (!shownData) return;
    printAccountingReport({
      title: uiText("الميزانية العمومية", "Balance sheet"),
      subtitle: `${uiText("حتى تاريخ", "As of")}: ${asOfDate}`,
      filters: [
        `${uiText("الفرع", "Branch")}: ${branchLabel}`,
        `${uiText("مركز التكلفة", "Cost center")}: ${costCenterLabel}`,
        ...accountHierarchyPrintFilters(accounts, parentIds, levelMode, showZero),
      ],
      summaries: [
        { label: uiText("إجمالي الأصول", "Total assets"), value: Math.abs(shownData.totalAssets) },
        { label: uiText("إجمالي الخصوم", "Total liabilities"), value: Math.abs(shownData.totalLiabilities) },
        { label: uiText("حقوق الملكية", "Equity"), value: Math.abs(shownData.totalEquity - shownData.netIncome) },
        { label: uiText("صافي دخل الفترة الحالية", "Current period net income"), value: shownData.netIncome },
        { label: uiText("إجمالي الخصوم وحقوق الملكية", "Total liabilities and equity"), value: Math.abs(totalLE), emphasis: true },
      ],
      notice: {
        text: balanced
          ? `${uiText("الميزانية متوازنة", "Balance sheet is balanced")} — ${fmt(Math.abs(shownData.totalAssets))}`
          : `${uiText("فرق غير متوازن", "Out-of-balance difference")}: ${fmt(Math.abs(shownData.totalAssets - totalLE))}`,
        balanced,
      },
      sections: [
        {
          title: uiText("الأصول", "Assets"),
          columns: [uiText("الكود", "Code"), uiText("الحساب", "Account"), uiText("الرصيد", "Balance")],
          rows: shownData.assets.map((row) => [row.code, row.name, Math.abs(row.balance)]),
          totalRow: ["", uiText("إجمالي الأصول", "Total assets"), Math.abs(shownData.totalAssets)],
        },
        {
          title: uiText("الخصوم", "Liabilities"),
          columns: [uiText("الكود", "Code"), uiText("الحساب", "Account"), uiText("الرصيد", "Balance")],
          rows: shownData.liabilities.map((row) => [row.code, row.name, Math.abs(row.balance)]),
          totalRow: ["", uiText("إجمالي الخصوم", "Total liabilities"), Math.abs(shownData.totalLiabilities)],
        },
        {
          title: uiText("حقوق الملكية", "Equity"),
          columns: [uiText("الكود", "Code"), uiText("الحساب", "Account"), uiText("الرصيد", "Balance")],
          rows: shownData.equity.map((row) => [row.code, row.name, Math.abs(row.balance)]),
          totalRow: ["", uiText("إجمالي حقوق الملكية", "Total equity"), Math.abs(shownData.totalEquity - shownData.netIncome)],
        },
      ],
    });
  }

  const exportRows: BSExportRow[] = shownData
    ? [
        { code: "", name: "الأصول", amount: "" },
        ...shownData.assets.map((r): BSExportRow => ({ code: r.code, name: r.name, amount: Math.abs(r.balance) })),
        { code: "", name: "إجمالي الأصول", amount: Math.abs(shownData.totalAssets) },
        { code: "", name: "الخصوم", amount: "" },
        ...shownData.liabilities.map((r): BSExportRow => ({ code: r.code, name: r.name, amount: Math.abs(r.balance) })),
        { code: "", name: "إجمالي الخصوم", amount: Math.abs(shownData.totalLiabilities) },
        { code: "", name: "حقوق الملكية", amount: "" },
        ...shownData.equity.map((r): BSExportRow => ({ code: r.code, name: r.name, amount: Math.abs(r.balance) })),
        { code: "", name: "إجمالي حقوق الملكية", amount: Math.abs(shownData.totalEquity - shownData.netIncome) },
        { code: "", name: "صافي دخل الفترة الحالية", amount: shownData.netIncome },
        { code: "", name: "إجمالي الخصوم وحقوق الملكية", amount: Math.abs(totalLE) },
      ]
    : [];
  const exportCols: ExportColumn<BSExportRow>[] = [
    { header: "الكود", cell: (r) => r.code },
    { header: "الحساب", cell: (r) => r.name },
    { header: "الرصيد", cell: (r) => r.amount },
  ];

  const Section = ({ title, rows, total, color, natural }: { title: string; rows: Row[]; total: number; color: string; natural: "debit" | "credit" }) => (
    <Card style={{ marginBottom: 12 }}>
      <h3 style={{ margin: "0 0 8px", color }}>{title}</h3>
      {rows.length === 0 ? <Empty text="لا توجد بيانات" /> : (
        <Table>
          <thead><tr><Th style={{ width: 120 }}>الكود</Th><Th>الحساب</Th><Th style={{ textAlign: "left", width: 160 }}>الرصيد</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.accountId}><Td mono>{r.code}</Td><Td>{r.name}</Td>
                <Td num>{fmt(Math.abs(natural === "debit" ? r.balance : -r.balance))}</Td></tr>
            ))}
            <tr style={{ fontWeight: 700, background: "#f8fafc" }}><Td colSpan={2}>الإجمالي</Td><Td num>{fmt(Math.abs(total))}</Td></tr>
          </tbody>
        </Table>
      )}
    </Card>
  );

  return (
    <Page title="الميزانية العمومية" subtitle="الأصول مقابل الخصوم وحقوق الملكية حتى تاريخ معين (القيود المرحّلة فقط).">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <DateField label="حتى تاريخ" value={asOfDate} onChange={setAsOfDate} />
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
        <ReportDisplayLayout reportKey="balance-sheet">
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <button type="button" onClick={printReport} style={btnSecondary}>🖨️ {uiText("طباعة", "Print")}</button>
            <ExportButtons columns={exportCols} rows={exportRows} filenameBase="الميزانية-العمومية" title={`الميزانية العمومية — حتى ${asOfDate}`} />
          </div>
          <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontWeight: 600,
            background: balanced ? "#ecfdf5" : "#fef2f2", color: balanced ? "#15803d" : "#991b1b" }}>
            {balanced ? `✓ الميزانية متوازنة — ${fmt(Math.abs(shownData.totalAssets))}` : `⚠️ فرق: ${fmt(Math.abs(shownData.totalAssets - totalLE))}`}
          </div>
          <ReportSummaryCards items={[
            { label: "إجمالي الأصول", value: shownData.totalAssets, accent: "#059669" },
            { label: "إجمالي الخصوم", value: shownData.totalLiabilities, accent: "#dc2626" },
            { label: "حقوق الملكية", value: shownData.totalEquity - shownData.netIncome, accent: "#2563eb" },
            { label: "صافي دخل الفترة الحالية", value: shownData.netIncome, accent: "#0f766e" },
          ]} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: 12, alignItems: "start" }}>
            <Section title="الأصول" rows={shownData.assets} total={shownData.totalAssets} color="#1e40af" natural="debit" />
            <div>
              <Section title="الخصوم" rows={shownData.liabilities} total={shownData.totalLiabilities} color="#b91c1c" natural="credit" />
              <Section title="حقوق الملكية" rows={shownData.equity} total={shownData.totalEquity - shownData.netIncome} color="#7c3aed" natural="credit" />
              <Card style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", color: "#64748b" }}>
                  <span>صافي دخل الفترة الحالية</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(shownData.netIncome)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 16, borderTop: "1px solid #e2e8f0", paddingTop: 8, marginTop: 4 }}>
                  <span>إجمالي الخصوم وحقوق الملكية</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(Math.abs(totalLE))}</span>
                </div>
              </Card>
            </div>
          </div>
        </>
        </ReportDisplayLayout>
      )}
    </Page>
  );
}
