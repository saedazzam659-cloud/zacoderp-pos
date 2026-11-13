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

type Agg = {
  accountId: number; code: string; name: string;
  openNet: number; periodDr: number; periodCr: number;
};

type TBExportRow = {
  code: string; name: string;
  openDr: number | string; openCr: number | string;
  periodDr: number | string; periodCr: number | string;
  closeDr: number | string; closeCr: number | string;
};

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

export default function TrialBalanceReport() {
  const { branches, costCenters } = useDimensions();
  const { accounts, loading: accountsLoading, error: accountsError, refreshAccounts } = useReportAccounts();
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [parentIds, setParentIds] = useState<number[]>([]);
  const [levelMode, setLevelMode] = useState<AccountLevelMode>("all");
  const [showZero, setShowZero] = useState(false);
  const [rows, setRows] = useState<Agg[] | null>(null);
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
      const map = new Map<number, Agg>();
      for (const l of lines as LedgerLine[]) {
        let a = map.get(l.accountId);
        if (!a) { a = { accountId: l.accountId, code: l.accountCode, name: l.accountName, openNet: 0, periodDr: 0, periodCr: 0 }; map.set(l.accountId, a); }
        if (l.entryDate < fromDate) {
          a.openNet += l.debit - l.credit;
        } else {
          a.periodDr += l.debit;
          a.periodCr += l.credit;
        }
      }
      for (const account of allAccounts) {
        if (!map.has(account.id)) {
          map.set(account.id, { accountId: account.id, code: account.code, name: account.nameAr, openNet: 0, periodDr: 0, periodCr: 0 });
        }
      }
      const out = [...map.values()].sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
      setRows(out);
    } catch (e) {
      setErr(typeof e === "string" ? e : (e as Error)?.message ?? "تعذر تحميل التقرير");
    } finally { setLoading(false); }
  }

  const visibleRows = useMemo(() => {
    if (!rows) return null;
    const hierarchyRows = filterAccountReportRows(rows, accounts, { parentIds, levelMode });
    return showZero
      ? hierarchyRows
      : hierarchyRows.filter((a) => Math.abs(a.openNet) > 0.001 || a.periodDr > 0.001 || a.periodCr > 0.001);
  }, [rows, accounts, parentIds, levelMode, showZero]);

  const totals = (visibleRows ?? []).reduce((s, a) => {
    const close = a.openNet + a.periodDr - a.periodCr;
    s.openDr += a.openNet > 0 ? a.openNet : 0;
    s.openCr += a.openNet < 0 ? -a.openNet : 0;
    s.periodDr += a.periodDr;
    s.periodCr += a.periodCr;
    s.closeDr += close > 0 ? close : 0;
    s.closeCr += close < 0 ? -close : 0;
    return s;
  }, { openDr: 0, openCr: 0, periodDr: 0, periodCr: 0, closeDr: 0, closeCr: 0 });

  const balanced = Math.abs(totals.closeDr - totals.closeCr) < 0.01;
  const cell = (n: number) => (Math.abs(n) > 0.001 ? fmt(n) : "");

  const branchLabel = branchId === "" ? uiText("كل الفروع", "All branches") : branches.find((branch) => branch.id === branchId)?.nameAr ?? "";
  const costCenterLabel = costCenterId === "" ? uiText("كل مراكز التكلفة", "All cost centers") : costCenters.find((center) => center.id === costCenterId)?.nameAr ?? "";
  function printReport() {
    if (!visibleRows?.length) return;
    printAccountingReport({
      title: uiText("ميزان المراجعة بالمجاميع", "Trial balance"),
      subtitle: `${uiText("الفترة", "Period")}: ${fromDate} — ${toDate}`,
      orientation: "landscape",
      filters: [
        `${uiText("الفرع", "Branch")}: ${branchLabel}`,
        `${uiText("مركز التكلفة", "Cost center")}: ${costCenterLabel}`,
        ...accountHierarchyPrintFilters(accounts, parentIds, levelMode, showZero),
      ],
      notice: {
        text: balanced
          ? uiText("ميزان المراجعة متوازن", "Trial balance is balanced")
          : `${uiText("فرق غير متوازن", "Out-of-balance difference")}: ${fmt(Math.abs(totals.closeDr - totals.closeCr))}`,
        balanced,
      },
      sections: [{
        title: uiText("الأرصدة والحركة", "Balances and activity"),
        columns: [
          uiText("الكود", "Code"),
          uiText("اسم الحساب", "Account"),
          uiText("افتتاحي مدين", "Opening debit"),
          uiText("افتتاحي دائن", "Opening credit"),
          uiText("حركة مدين", "Period debit"),
          uiText("حركة دائن", "Period credit"),
          uiText("ختامي مدين", "Closing debit"),
          uiText("ختامي دائن", "Closing credit"),
        ],
        rows: visibleRows.map((account) => {
          const close = account.openNet + account.periodDr - account.periodCr;
          return [
            account.code,
            account.name,
            account.openNet > 0 ? account.openNet : "",
            account.openNet < 0 ? -account.openNet : "",
            account.periodDr > 0.001 ? account.periodDr : "",
            account.periodCr > 0.001 ? account.periodCr : "",
            close > 0 ? close : "",
            close < 0 ? -close : "",
          ];
        }),
        totalRow: [
          "",
          uiText("الإجمالي", "Total"),
          totals.openDr,
          totals.openCr,
          totals.periodDr,
          totals.periodCr,
          totals.closeDr,
          totals.closeCr,
        ],
      }],
    });
  }

  const numCell = (n: number): number | string => (Math.abs(n) > 0.001 ? n : "");
  const exportRows: TBExportRow[] = visibleRows && visibleRows.length > 0
    ? [
        ...visibleRows.map((a): TBExportRow => {
          const close = a.openNet + a.periodDr - a.periodCr;
          return {
            code: a.code, name: a.name,
            openDr: numCell(a.openNet > 0 ? a.openNet : 0),
            openCr: numCell(a.openNet < 0 ? -a.openNet : 0),
            periodDr: numCell(a.periodDr),
            periodCr: numCell(a.periodCr),
            closeDr: numCell(close > 0 ? close : 0),
            closeCr: numCell(close < 0 ? -close : 0),
          };
        }),
        {
          code: "", name: "الإجمالي",
          openDr: totals.openDr, openCr: totals.openCr,
          periodDr: totals.periodDr, periodCr: totals.periodCr,
          closeDr: totals.closeDr, closeCr: totals.closeCr,
        },
      ]
    : [];
  const exportCols: ExportColumn<TBExportRow>[] = [
    { header: "الكود", cell: (r) => r.code },
    { header: "اسم الحساب", cell: (r) => r.name },
    { header: "افتتاحي مدين", cell: (r) => r.openDr },
    { header: "افتتاحي دائن", cell: (r) => r.openCr },
    { header: "حركة مدين", cell: (r) => r.periodDr },
    { header: "حركة دائن", cell: (r) => r.periodCr },
    { header: "ختامي مدين", cell: (r) => r.closeDr },
    { header: "ختامي دائن", cell: (r) => r.closeCr },
  ];

  return (
    <Page title="ميزان المراجعة بالمجاميع" subtitle="الأرصدة الافتتاحية + حركة الفترة + الأرصدة الختامية لكل حساب (القيود المرحّلة فقط).">
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

      {visibleRows && (
        <ReportDisplayLayout reportKey="trial-balance">
        <Card>
          {visibleRows.length > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <button type="button" onClick={printReport} style={btnSecondary}>🖨️ {uiText("طباعة", "Print")}</button>
              <ExportButtons columns={exportCols} rows={exportRows} filenameBase="ميزان-المراجعة" title={`ميزان المراجعة بالمجاميع — ${fromDate} ← ${toDate}`} />
            </div>
          )}
          {visibleRows.length > 0 && <ReportSummaryCards items={[
            { label: "افتتاحي مدين", value: totals.openDr, accent: "#b45309" },
            { label: "افتتاحي دائن", value: totals.openCr, accent: "#b45309" },
            { label: "حركة مدين", value: totals.periodDr, accent: "#2563eb" },
            { label: "حركة دائن", value: totals.periodCr, accent: "#2563eb" },
            { label: "ختامي مدين", value: totals.closeDr, accent: "#059669" },
            { label: "ختامي دائن", value: totals.closeCr, accent: "#059669" },
          ]} />}
          {visibleRows.length === 0 ? <Empty text="لا توجد حركة في الفترة المحددة" /> : (
            <Table>
              <thead>
                <tr>
                  <Th rowSpan={2}>الكود</Th><Th rowSpan={2}>اسم الحساب</Th>
                  <Th colSpan={2} style={{ textAlign: "center", background: "#fffbeb" }}>الرصيد الافتتاحي</Th>
                  <Th colSpan={2} style={{ textAlign: "center", background: "#f1f5f9" }}>حركة الفترة</Th>
                  <Th colSpan={2} style={{ textAlign: "center", background: "#ecfdf5" }}>الرصيد الختامي</Th>
                </tr>
                <tr>
                  <Th style={{ textAlign: "left", background: "#fffbeb" }}>مدين</Th><Th style={{ textAlign: "left", background: "#fffbeb" }}>دائن</Th>
                  <Th style={{ textAlign: "left", background: "#f1f5f9" }}>مدين</Th><Th style={{ textAlign: "left", background: "#f1f5f9" }}>دائن</Th>
                  <Th style={{ textAlign: "left", background: "#ecfdf5" }}>مدين</Th><Th style={{ textAlign: "left", background: "#ecfdf5" }}>دائن</Th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((a) => {
                  const close = a.openNet + a.periodDr - a.periodCr;
                  return (
                    <tr key={a.accountId}>
                      <Td mono>{a.code}</Td>
                      <Td>{a.name}</Td>
                      <Td num>{cell(a.openNet > 0 ? a.openNet : 0)}</Td>
                      <Td num>{cell(a.openNet < 0 ? -a.openNet : 0)}</Td>
                      <Td num>{cell(a.periodDr)}</Td>
                      <Td num>{cell(a.periodCr)}</Td>
                      <Td num>{cell(close > 0 ? close : 0)}</Td>
                      <Td num>{cell(close < 0 ? -close : 0)}</Td>
                    </tr>
                  );
                })}
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td colSpan={2}>الإجمالي</Td>
                  <Td num>{fmt(totals.openDr)}</Td><Td num>{fmt(totals.openCr)}</Td>
                  <Td num>{fmt(totals.periodDr)}</Td><Td num>{fmt(totals.periodCr)}</Td>
                  <Td num>{fmt(totals.closeDr)}</Td><Td num>{fmt(totals.closeCr)}</Td>
                </tr>
              </tbody>
            </Table>
          )}
          {visibleRows.length > 0 && (
            <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 6, fontSize: 13, fontWeight: 600,
              background: balanced ? "#ecfdf5" : "#fef2f2", color: balanced ? "#15803d" : "#991b1b" }}>
              {balanced ? "✓ الميزان متوازن" : `⚠️ فرق غير متوازن: ${fmt(Math.abs(totals.closeDr - totals.closeCr))}`}
            </div>
          )}
        </Card>
        </ReportDisplayLayout>
      )}
    </Page>
  );
}
