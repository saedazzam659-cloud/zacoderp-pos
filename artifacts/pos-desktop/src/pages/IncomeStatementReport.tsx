import { useState } from "react";
import { reportLedgerLines, type LedgerLine } from "../lib/reports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField, CostCenterField } from "./_reportFilters";

type Row = { accountId: number; code: string; name: string; amount: number };

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

export default function IncomeStatementReport() {
  const { branches, costCenters } = useDimensions();
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [data, setData] = useState<{ revenues: Row[]; expenses: Row[]; totalRevenue: number; totalExpenses: number } | null>(null);
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
      const byCode = (a: Row, b: Row) => a.code.localeCompare(b.code, undefined, { numeric: true });
      const revenues = [...rev.values()].filter((r) => Math.abs(r.amount) > 0.001).sort(byCode);
      const expenses = [...exp.values()].filter((r) => Math.abs(r.amount) > 0.001).sort(byCode);
      setData({
        revenues, expenses,
        totalRevenue: revenues.reduce((s, r) => s + r.amount, 0),
        totalExpenses: expenses.reduce((s, r) => s + r.amount, 0),
      });
    } finally { setLoading(false); }
  }

  const netIncome = data ? data.totalRevenue - data.totalExpenses : 0;
  const isProfit = netIncome >= 0;

  return (
    <Page title="قائمة الدخل" subtitle="الإيرادات والمصروفات وصافي الربح/الخسارة خلال الفترة (القيود المرحّلة فقط).">
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

      {data && (
        <>
          <Card style={{ marginBottom: 16 }}>
            <h3 style={{ margin: "0 0 8px", color: "#15803d" }}>الإيرادات</h3>
            {data.revenues.length === 0 ? <Empty text="لا توجد إيرادات" /> : (
              <Table>
                <thead><tr><Th style={{ width: 120 }}>الكود</Th><Th>الحساب</Th><Th style={{ textAlign: "left", width: 160 }}>المبلغ</Th></tr></thead>
                <tbody>
                  {data.revenues.map((r) => (<tr key={r.accountId}><Td mono>{r.code}</Td><Td>{r.name}</Td><Td num style={{ color: "#15803d" }}>{fmt(r.amount)}</Td></tr>))}
                  <tr style={{ fontWeight: 700, background: "#ecfdf5" }}><Td colSpan={2}>إجمالي الإيرادات</Td><Td num>{fmt(data.totalRevenue)}</Td></tr>
                </tbody>
              </Table>
            )}
          </Card>

          <Card style={{ marginBottom: 16 }}>
            <h3 style={{ margin: "0 0 8px", color: "#b91c1c" }}>المصروفات</h3>
            {data.expenses.length === 0 ? <Empty text="لا توجد مصروفات" /> : (
              <Table>
                <thead><tr><Th style={{ width: 120 }}>الكود</Th><Th>الحساب</Th><Th style={{ textAlign: "left", width: 160 }}>المبلغ</Th></tr></thead>
                <tbody>
                  {data.expenses.map((r) => (<tr key={r.accountId}><Td mono>{r.code}</Td><Td>{r.name}</Td><Td num style={{ color: "#b91c1c" }}>{fmt(r.amount)}</Td></tr>))}
                  <tr style={{ fontWeight: 700, background: "#fef2f2" }}><Td colSpan={2}>إجمالي المصروفات</Td><Td num>{fmt(data.totalExpenses)}</Td></tr>
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
