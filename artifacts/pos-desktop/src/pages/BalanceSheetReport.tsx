import { useState } from "react";
import { reportLedgerLines, type LedgerLine } from "../lib/reports";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr } from "./_adminUi";
import { useDimensions, DateField, BranchField, CostCenterField } from "./_reportFilters";

type Row = { accountId: number; code: string; name: string; balance: number };

export default function BalanceSheetReport() {
  const { branches, costCenters } = useDimensions();
  const [asOfDate, setAsOfDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [data, setData] = useState<{
    assets: Row[]; liabilities: Row[]; equity: Row[];
    totalAssets: number; totalLiabilities: number; totalEquity: number; netIncome: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
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
      const byCode = (a: Row, b: Row) => a.code.localeCompare(b.code, undefined, { numeric: true });
      const assetRows = [...assets.values()].filter((r) => Math.abs(r.balance) > 0.001).sort(byCode);
      const liabRows = [...liabilities.values()].filter((r) => Math.abs(r.balance) > 0.001).sort(byCode);
      const equityRows = [...equity.values()].filter((r) => Math.abs(r.balance) > 0.001).sort(byCode);
      const totalAssets = assetRows.reduce((s, r) => s + r.balance, 0);
      const totalLiabilities = liabRows.reduce((s, r) => s + -r.balance, 0);
      const totalEquity = equityRows.reduce((s, r) => s + -r.balance, 0) + netIncome;
      setData({ assets: assetRows, liabilities: liabRows, equity: equityRows, totalAssets, totalLiabilities, totalEquity, netIncome });
    } finally { setLoading(false); }
  }

  const totalLE = data ? data.totalLiabilities + data.totalEquity : 0;
  const balanced = data ? Math.abs(data.totalAssets - totalLE) < 0.01 : true;

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
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : "عرض"}</button>
        </div>
      </Card>

      {data && (
        <>
          <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontWeight: 600,
            background: balanced ? "#ecfdf5" : "#fef2f2", color: balanced ? "#15803d" : "#991b1b" }}>
            {balanced ? `✓ الميزانية متوازنة — ${fmt(Math.abs(data.totalAssets))}` : `⚠️ فرق: ${fmt(Math.abs(data.totalAssets - totalLE))}`}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
            <Section title="الأصول" rows={data.assets} total={data.totalAssets} color="#1e40af" natural="debit" />
            <div>
              <Section title="الخصوم" rows={data.liabilities} total={data.totalLiabilities} color="#b91c1c" natural="credit" />
              <Section title="حقوق الملكية" rows={data.equity} total={data.totalEquity - data.netIncome} color="#7c3aed" natural="credit" />
              <Card style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", color: "#64748b" }}>
                  <span>صافي دخل الفترة الحالية</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(data.netIncome)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 16, borderTop: "1px solid #e2e8f0", paddingTop: 8, marginTop: 4 }}>
                  <span>إجمالي الخصوم وحقوق الملكية</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(Math.abs(totalLE))}</span>
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
