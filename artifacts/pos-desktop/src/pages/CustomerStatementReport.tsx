import { useEffect, useMemo, useState } from "react";
import {
  listSalesInvoices, listSalesReturns, listFinancialTx,
  type SalesInvoice, type SalesReturn, type FinancialTx,
} from "../lib/accounting";
import { listCustomers, getCustomerOpening, type LocalCustomer } from "../lib/customers";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, SearchCombobox, input } from "./_adminUi";
import { DateField, FilterField } from "./_reportFilters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

// One movement on the customer's AR sub-ledger. debit = customer owes more,
// credit = customer owes less. Built purely in TS from source documents so no
// Rust/SQLite changes are needed (Rust compiles only in CI).
type StmtLine = {
  date: string;
  docType: string;
  docNo: string;
  description: string;
  debit: number;
  credit: number;
};

// AR semantics (mirrors the web's AR-account-based كشف حساب):
//   • CREDIT sales invoice  → debit (AR رose). Cash/bank invoices settle on the
//     spot (DR cash / CR revenue) and never touch AR, so they are excluded.
//   • CREDIT sales return   → credit (AR fell). Cash/bank returns refund cash.
//   • Receipt voucher (سند قبض) for the customer → credit (payment received).
//   • Payment voucher (سند صرف) to the customer (refund) → debit.
function buildLines(
  customerId: number,
  invoices: SalesInvoice[],
  returns: SalesReturn[],
  txs: FinancialTx[],
): StmtLine[] {
  const lines: StmtLine[] = [];
  for (const inv of invoices) {
    if (inv.customerId !== customerId) continue;
    if (inv.paymentMethod !== "credit") continue;
    lines.push({
      date: inv.invoiceDate,
      docType: "فاتورة مبيعات",
      docNo: inv.invoiceNo,
      description: inv.notes || "",
      debit: inv.grandTotal,
      credit: 0,
    });
  }
  for (const r of returns) {
    if (r.customerId !== customerId) continue;
    if (r.paymentMethod !== "credit") continue;
    lines.push({
      date: r.returnDate,
      docType: "مرتجع مبيعات",
      docNo: r.returnNo,
      description: r.notes || "",
      debit: 0,
      credit: r.grandTotal,
    });
  }
  for (const t of txs) {
    if (t.partyType !== "customer" || t.partyId !== customerId) continue;
    const isReceipt = t.txType === "receipt";
    lines.push({
      date: t.txDate,
      docType: isReceipt ? "سند قبض" : "سند صرف",
      docNo: t.txNo,
      description: t.description || "",
      debit: isReceipt ? 0 : t.amount,
      credit: isReceipt ? t.amount : 0,
    });
  }
  lines.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1
      : a.docNo.localeCompare(b.docNo, undefined, { numeric: true }));
  return lines;
}

export default function CustomerStatementReport() {
  const [customers, setCustomers] = useState<LocalCustomer[]>([]);
  const [customerId, setCustomerId] = useState<number | "">("");
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [includeOpening, setIncludeOpening] = useState(true);
  const [result, setResult] = useState<{ customer: LocalCustomer; opening: number; lines: StmtLine[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { void (async () => setCustomers(await listCustomers()))(); }, []);

  const customerOpts = useMemo(
    () => customers
      .slice()
      .sort((a, b) => a.nameAr.localeCompare(b.nameAr))
      .map((c) => ({ value: c.id, label: c.nameAr, hint: c.vatNumber ?? c.phone ?? "" })),
    [customers],
  );

  async function run() {
    if (customerId === "") { setErr("اختر العميل أولاً"); return; }
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
    const customer = customers.find((c) => c.id === customerId);
    if (!customer) { setErr("العميل غير موجود"); return; }
    setErr(null); setLoading(true);
    try {
      // High limits so the statement is not truncated to the default 200.
      const [invoices, returns, txs] = await Promise.all([
        listSalesInvoices(100000),
        listSalesReturns(100000),
        listFinancialTx(100000),
      ]);
      const all = buildLines(customerId, invoices, returns, txs);
      // Opening = net movement of every document dated BEFORE the period start.
      // The period is INCLUSIVE on both ends; movements after toDate are excluded
      // entirely (they belong to a later statement, not this one).
      let opening = 0;
      // Seed the opening balance from the create-time overlay (the GL opening
      // JE is invisible to a document-based statement). Only counts when it
      // predates the period start; debit (مدين) raises AR, credit lowers it.
      const ov = getCustomerOpening(customerId);
      if (ov && ov.openingDate < fromDate) {
        opening += ov.openingNature === "debit" ? ov.openingBalance : -ov.openingBalance;
      }
      const inRange: StmtLine[] = [];
      for (const l of all) {
        if (l.date < fromDate) opening += l.debit - l.credit;
        else if (l.date <= toDate) inRange.push(l);
      }
      if (!includeOpening) opening = 0;
      setResult({ customer, opening, lines: inRange });
    } finally { setLoading(false); }
  }

  const totals = (result?.lines ?? []).reduce((s, l) => { s.dr += l.debit; s.cr += l.credit; return s; }, { dr: 0, cr: 0 });
  const closing = result ? result.opening + totals.dr - totals.cr : 0;

  return (
    <Page title="كشف حساب عميل" subtitle="حركة حساب العميل خلال الفترة (فواتير آجلة، مرتجعات آجلة، سندات القبض والصرف) مع الرصيد الافتتاحي والجاري.">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <FilterField label="العميل">
            <SearchCombobox
              value={customerId}
              onChange={(v) => setCustomerId(v === "" ? "" : Number(v))}
              options={customerOpts}
              style={{ ...input, padding: "8px 10px", minWidth: 240 }}
            />
          </FilterField>
          <DateField label="من تاريخ" value={fromDate} onChange={setFromDate} />
          <DateField label="إلى تاريخ" value={toDate} onChange={setToDate} />
          <FilterField label="الرصيد الافتتاحي">
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, height: 38 }}>
              <input
                type="checkbox"
                checked={includeOpening}
                onChange={(e) => setIncludeOpening(e.target.checked)}
                style={{ width: 16, height: 16 }}
              />
              تضمين
            </label>
          </FilterField>
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : "عرض"}</button>
        </div>
        {err && <div style={{ marginTop: 8, color: "#991b1b", fontSize: 13 }}>⚠️ {err}</div>}
      </Card>

      {result && (
        <Card>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginBottom: 14, fontSize: 13 }}>
            <div><b>العميل:</b> {result.customer.nameAr}</div>
            {result.customer.vatNumber && <div><b>الرقم الضريبي:</b> {result.customer.vatNumber}</div>}
            {result.customer.phone && <div><b>الهاتف:</b> {result.customer.phone}</div>}
            <div><b>الفترة:</b> {fromDate} ← {toDate}</div>
          </div>
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 110 }}>التاريخ</Th>
                <Th style={{ width: 120 }}>النوع</Th>
                <Th style={{ width: 110 }}>المستند</Th>
                <Th>البيان</Th>
                <Th style={{ textAlign: "left", width: 130 }}>مدين</Th>
                <Th style={{ textAlign: "left", width: 130 }}>دائن</Th>
                <Th style={{ textAlign: "left", width: 150 }}>الرصيد</Th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ background: "#fffbeb", fontWeight: 600 }}>
                <Td colSpan={6}>الرصيد الافتتاحي</Td>
                <Td num>{fmt(result.opening)}</Td>
              </tr>
              {result.lines.length === 0 && (
                <tr><Td colSpan={7}><Empty text="لا توجد حركة في الفترة المحددة" /></Td></tr>
              )}
              {(() => {
                let running = result.opening;
                return result.lines.map((l, i) => {
                  running += l.debit - l.credit;
                  return (
                    <tr key={i}>
                      <Td mono>{l.date}</Td>
                      <Td>{l.docType}</Td>
                      <Td mono>{l.docNo}</Td>
                      <Td>{l.description || "—"}</Td>
                      <Td num>{l.debit > 0.001 ? fmt(l.debit) : ""}</Td>
                      <Td num>{l.credit > 0.001 ? fmt(l.credit) : ""}</Td>
                      <Td num>{fmt(running)}</Td>
                    </tr>
                  );
                });
              })()}
              <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                <Td colSpan={4}>الإجمالي / الرصيد الختامي</Td>
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
