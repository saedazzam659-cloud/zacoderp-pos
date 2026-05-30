import { useEffect, useMemo, useState } from "react";
import { reportLedgerLines, type LedgerLine } from "../lib/reports";
import { listAccounts, type Account } from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, SearchCombobox, input } from "./_adminUi";
import { useDimensions, DateField, BranchField, CostCenterField, FilterField } from "./_reportFilters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

export default function AccountStatementReport({ initialAccountId, onConsumed }: { initialAccountId?: number | null; onConsumed?: () => void } = {}) {
  const { branches, costCenters } = useDimensions();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<number | "">(initialAccountId ?? "");
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [branchId, setBranchId] = useState<number | "">("");
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [result, setResult] = useState<{ opening: number; lines: LedgerLine[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { void (async () => setAccounts(await listAccounts()))(); }, []);

  // When opened via a Chart-of-Accounts balance-pill drill-down, preselect the
  // account and auto-run the statement for the current period.
  useEffect(() => {
    if (initialAccountId == null) return;
    setAccountId(initialAccountId);
    void runFor(initialAccountId);
    onConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAccountId]);

  const accountOpts = useMemo(
    () => accounts
      .filter((a) => a.isLeaf)
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
      .map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` })),
    [accounts],
  );

  async function run() { await runFor(accountId); }
  async function runFor(acct: number | "") {
    if (acct === "") { setErr("اختر الحساب أولاً"); return; }
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
    setErr(null); setLoading(true);
    try {
      const lines = await reportLedgerLines({
        toDate,
        accountId: acct,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
      });
      let opening = 0;
      const inRange: LedgerLine[] = [];
      for (const l of lines as LedgerLine[]) {
        if (l.entryDate < fromDate) opening += l.debit - l.credit;
        else inRange.push(l);
      }
      inRange.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : a.entryNo.localeCompare(b.entryNo, undefined, { numeric: true })));
      setResult({ opening, lines: inRange });
    } finally { setLoading(false); }
  }

  const totals = (result?.lines ?? []).reduce((s, l) => { s.dr += l.debit; s.cr += l.credit; return s; }, { dr: 0, cr: 0 });
  const closing = result ? result.opening + totals.dr - totals.cr : 0;

  return (
    <Page title="كشف حساب" subtitle="حركة حساب معين خلال الفترة مع الرصيد الافتتاحي والرصيد الجاري (القيود المرحّلة فقط).">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <FilterField label="الحساب">
            <SearchCombobox
              value={accountId}
              onChange={(v) => setAccountId(v === "" ? "" : Number(v))}
              options={accountOpts}
              style={{ ...input, padding: "8px 10px", minWidth: 240 }}
            />
          </FilterField>
          <DateField label="من تاريخ" value={fromDate} onChange={setFromDate} />
          <DateField label="إلى تاريخ" value={toDate} onChange={setToDate} />
          <BranchField branches={branches} value={branchId} onChange={setBranchId} />
          <CostCenterField costCenters={costCenters} value={costCenterId} onChange={setCostCenterId} />
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : "عرض"}</button>
        </div>
        {err && <div style={{ marginTop: 8, color: "#991b1b", fontSize: 13 }}>⚠️ {err}</div>}
      </Card>

      {result && (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 110 }}>التاريخ</Th><Th style={{ width: 90 }}>القيد</Th><Th>البيان</Th>
                <Th style={{ textAlign: "left", width: 130 }}>مدين</Th>
                <Th style={{ textAlign: "left", width: 130 }}>دائن</Th>
                <Th style={{ textAlign: "left", width: 150 }}>الرصيد</Th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ background: "#fffbeb", fontWeight: 600 }}>
                <Td colSpan={5}>الرصيد الافتتاحي</Td>
                <Td num>{fmt(result.opening)}</Td>
              </tr>
              {result.lines.length === 0 && (
                <tr><Td colSpan={6}><Empty text="لا توجد حركة في الفترة المحددة" /></Td></tr>
              )}
              {(() => {
                let running = result.opening;
                return result.lines.map((l, i) => {
                  running += l.debit - l.credit;
                  return (
                    <tr key={i}>
                      <Td mono>{l.entryDate}</Td>
                      <Td mono>{l.entryNo}</Td>
                      <Td>{l.description || "—"}</Td>
                      <Td num>{l.debit > 0.001 ? fmt(l.debit) : ""}</Td>
                      <Td num>{l.credit > 0.001 ? fmt(l.credit) : ""}</Td>
                      <Td num>{fmt(running)}</Td>
                    </tr>
                  );
                });
              })()}
              <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                <Td colSpan={3}>الإجمالي / الرصيد الختامي</Td>
                <Td num>{fmt(totals.dr)}</Td>
                <Td num>{fmt(totals.cr)}</Td>
                <Td num>{fmt(closing)}</Td>
              </tr>
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
