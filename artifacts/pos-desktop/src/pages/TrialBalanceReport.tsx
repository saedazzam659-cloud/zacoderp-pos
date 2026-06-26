import { useState } from "react";
import { reportLedgerLines, type LedgerLine } from "../lib/reports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, ExportButtons } from "./_adminUi";
import { useDimensions, DateField, BranchField, CostCenterField } from "./_reportFilters";
import type { ExportColumn } from "../lib/exporters";

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
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [rows, setRows] = useState<Agg[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
    setErr(null); setLoading(true);
    try {
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
      const out = [...map.values()]
        .filter((a) => Math.abs(a.openNet) > 0.001 || a.periodDr > 0.001 || a.periodCr > 0.001)
        .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
      setRows(out);
    } finally { setLoading(false); }
  }

  const totals = (rows ?? []).reduce((s, a) => {
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

  const numCell = (n: number): number | string => (Math.abs(n) > 0.001 ? n : "");
  const exportRows: TBExportRow[] = rows && rows.length > 0
    ? [
        ...rows.map((a): TBExportRow => {
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
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : "عرض"}</button>
        </div>
        {err && <div style={{ marginTop: 8, color: "#b91c1c", fontSize: 13 }}>{err}</div>}
      </Card>

      {rows && (
        <Card>
          {rows.length > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
              <ExportButtons columns={exportCols} rows={exportRows} filenameBase="ميزان-المراجعة" title={`ميزان المراجعة بالمجاميع — ${fromDate} ← ${toDate}`} />
            </div>
          )}
          {rows.length === 0 ? <Empty text="لا توجد حركة في الفترة المحددة" /> : (
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
                {rows.map((a) => {
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
          {rows.length > 0 && (
            <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 6, fontSize: 13, fontWeight: 600,
              background: balanced ? "#ecfdf5" : "#fef2f2", color: balanced ? "#15803d" : "#991b1b" }}>
              {balanced ? "✓ الميزان متوازن" : `⚠️ فرق غير متوازن: ${fmt(Math.abs(totals.closeDr - totals.closeCr))}`}
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}
