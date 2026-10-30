import { useEffect, useMemo, useState } from "react";
import {
  listSalesInvoices, listSalesReturns, listFinancialTx,
  type SalesInvoice, type SalesReturn, type FinancialTx,
} from "../lib/accounting";
import { listCustomers, getCustomerOpening, type LocalCustomer } from "../lib/customers";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, SearchCombobox, input, ExportButtons } from "./_adminUi";
import { DateField, FilterField } from "./_reportFilters";
import { useDataRefresh } from "../lib/dataBus";
import type { ExportColumn } from "../lib/exporters";
import { uiText, useUiLanguage } from "../lib/appSettings";

// Flat row mirroring the on-screen statement table (opening row + per-line
// running balance + totals/closing row) for Excel/PDF export.
type StmtExportRow = {
  date: string;
  docType: string;
  docNo: string;
  description: string;
  debit: number | "";
  credit: number | "";
  balance: number;
};

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
//   • CREDIT sales invoice  → debit (AR rose).
//   • CASH/BANK sales invoice (when includeCash) → shown as a PAIR: the invoice
//     debit + an immediate settlement credit on the same date, so it appears in
//     the statement yet nets to zero on the running balance (it settled on the
//     spot: DR cash / CR revenue, never touching AR). No double-count: cash
//     invoices do NOT create a financial_transactions row.
//   • CREDIT sales return   → credit (AR fell). Cash/bank returns refund cash →
//     shown as a pair (return credit + refund debit) when includeCash.
//   • Receipt voucher (سند قبض) for the customer → credit (payment received).
//   • Payment voucher (سند صرف) to the customer (refund) → debit.
function buildLines(
  customerId: number,
  invoices: SalesInvoice[],
  returns: SalesReturn[],
  txs: FinancialTx[],
  includeCash: boolean,
  language: "ar" | "en",
): StmtLine[] {
  const lines: StmtLine[] = [];
  for (const inv of invoices) {
    if (inv.customerId !== customerId) continue;
    if (inv.paymentMethod === "credit") {
      lines.push({
        date: inv.invoiceDate,
        docType: uiText("فاتورة مبيعات", "Sales invoice", language),
        docNo: inv.invoiceNo,
        description: inv.notes || "",
        debit: inv.grandTotal,
        credit: 0,
      });
    } else if (includeCash) {
      const settle = inv.paymentMethod === "bank" ? uiText("سداد بنكي فوري", "Immediate bank receipt", language) : uiText("سداد نقدي فوري", "Immediate cash receipt", language);
      lines.push({
        date: inv.invoiceDate,
        docType: uiText("فاتورة مبيعات نقدية", "Cash sales invoice", language),
        docNo: inv.invoiceNo,
        description: inv.notes || "",
        debit: inv.grandTotal,
        credit: 0,
      });
      lines.push({
        date: inv.invoiceDate,
        docType: settle,
        docNo: inv.invoiceNo,
        description: uiText("تحصيل قيمة الفاتورة النقدية فوراً", "Immediate settlement of cash invoice", language),
        debit: 0,
        credit: inv.grandTotal,
      });
    }
  }
  for (const r of returns) {
    if (r.customerId !== customerId) continue;
    if (r.paymentMethod === "credit") {
      lines.push({
        date: r.returnDate,
        docType: uiText("مرتجع مبيعات", "Sales return", language),
        docNo: r.returnNo,
        description: r.notes || "",
        debit: 0,
        credit: r.grandTotal,
      });
    } else if (includeCash) {
      const refund = r.paymentMethod === "bank" ? uiText("استرداد بنكي فوري", "Immediate bank refund", language) : uiText("استرداد نقدي فوري", "Immediate cash refund", language);
      lines.push({
        date: r.returnDate,
        docType: uiText("مرتجع مبيعات نقدي", "Cash sales return", language),
        docNo: r.returnNo,
        description: r.notes || "",
        debit: 0,
        credit: r.grandTotal,
      });
      lines.push({
        date: r.returnDate,
        docType: refund,
        docNo: r.returnNo,
        description: uiText("رد قيمة المرتجع النقدي فوراً", "Immediate refund of cash return", language),
        debit: r.grandTotal,
        credit: 0,
      });
    }
  }
  for (const t of txs) {
    if (t.partyType !== "customer" || t.partyId !== customerId) continue;
    const isReceipt = t.txType === "receipt";
    lines.push({
      date: t.txDate,
      docType: isReceipt ? uiText("سند قبض", "Receipt voucher", language) : uiText("سند صرف", "Payment voucher", language),
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
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [customers, setCustomers] = useState<LocalCustomer[]>([]);
  const [customerId, setCustomerId] = useState<number | "">("");
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [includeOpening, setIncludeOpening] = useState(true);
  const [includeCash, setIncludeCash] = useState(true);
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
    if (customerId === "") { setErr(text("اختر العميل أولاً", "Select a customer first.")); return; }
    if (fromDate > toDate) { setErr(text("تاريخ البداية يجب أن يكون قبل تاريخ النهاية", "Start date must be on or before end date.")); return; }
    const customer = customers.find((c) => c.id === customerId);
    if (!customer) { setErr(text("العميل غير موجود", "Customer not found.")); return; }
    setErr(null); setLoading(true);
    try {
      // High limits so the statement is not truncated to the default 200.
      const [invoices, returns, txs] = await Promise.all([
        listSalesInvoices(100000),
        listSalesReturns(100000),
        listFinancialTx(100000),
      ]);
      const all = buildLines(customerId, invoices, returns, txs, includeCash, language);
      // Opening = net movement of every document dated BEFORE the period start.
      // The period is INCLUSIVE on both ends; movements after toDate are excluded
      // entirely (they belong to a later statement, not this one).
      //
      // Seed the create-time opening overlay (the GL opening JE is invisible to a
      // document-based statement) as a normal movement dated on openingDate: if it
      // predates the period it folds into the opening balance below; if it falls
      // INSIDE the period it shows as a visible "رصيد افتتاحي" row. It used to be
      // dropped entirely whenever it was dated on/after the period start, so an
      // opening entered on the same day you create the customer never appeared.
      // debit (مدين) raises AR, credit lowers it.
      const ov = getCustomerOpening(customerId);
      if (ov && ov.openingBalance) {
        all.push({
          date: ov.openingDate,
          docType: text("رصيد افتتاحي", "Opening balance"),
          docNo: "—",
          description: text("رصيد افتتاحي للعميل", "Customer opening balance"),
          debit: ov.openingNature === "debit" ? ov.openingBalance : 0,
          credit: ov.openingNature === "credit" ? ov.openingBalance : 0,
        });
        all.sort((a, b) =>
          a.date < b.date ? -1 : a.date > b.date ? 1
            : a.docNo.localeCompare(b.docNo, undefined, { numeric: true }));
      }
      let opening = 0;
      const inRange: StmtLine[] = [];
      for (const l of all) {
        if (l.date < fromDate) opening += l.debit - l.credit;
        else if (l.date <= toDate) inRange.push(l);
      }
      if (!includeOpening) opening = 0;
      setResult({ customer, opening, lines: inRange });
    } finally { setLoading(false); }
  }

  // Re-run the displayed statement when an invoice/voucher is created on another
  // tab, but only when a statement is already shown.
  useDataRefresh(["invoices", "vouchers", "journal"], () => { if (result) void run(); });

  const totals = (result?.lines ?? []).reduce((s, l) => { s.dr += l.debit; s.cr += l.credit; return s; }, { dr: 0, cr: 0 });
  const closing = result ? result.opening + totals.dr - totals.cr : 0;

  // Export rows mirror the on-screen table exactly: opening row + per-line
  // running balance + totals/closing row. Raw numbers so Excel stays numeric.
  const exportRows = useMemo<StmtExportRow[]>(() => {
    if (!result) return [];
    const out: StmtExportRow[] = [];
    out.push({ date: "", docType: "", docNo: "", description: text("الرصيد الافتتاحي", "Opening balance"), debit: "", credit: "", balance: result.opening });
    let running = result.opening;
    for (const l of result.lines) {
      running += l.debit - l.credit;
      out.push({
        date: l.date,
        docType: l.docType,
        docNo: l.docNo,
        description: l.description || "—",
        debit: l.debit > 0.001 ? l.debit : "",
        credit: l.credit > 0.001 ? l.credit : "",
        balance: running,
      });
    }
    out.push({ date: "", docType: "", docNo: "", description: text("الإجمالي / الرصيد الختامي", "Total / closing balance"), debit: totals.dr, credit: totals.cr, balance: closing });
    return out;
  }, [result, totals.dr, totals.cr, closing, language]);

  const exportCols: ExportColumn<StmtExportRow>[] = [
    { header: text("التاريخ", "Date"), cell: (r) => r.date },
    { header: text("النوع", "Type"), cell: (r) => r.docType },
    { header: text("المستند", "Document"), cell: (r) => r.docNo },
    { header: text("البيان", "Description"), cell: (r) => r.description },
    { header: text("مدين", "Debit"), cell: (r) => r.debit },
    { header: text("دائن", "Credit"), cell: (r) => r.credit },
    { header: text("الرصيد", "Balance"), cell: (r) => r.balance },
  ];

  return (
    <Page title={text("كشف حساب عميل", "Customer statement")} subtitle={text("حركة حساب العميل خلال الفترة (الفواتير الآجلة والنقدية، المرتجعات، سندات القبض والصرف) مع الرصيد الافتتاحي والجاري. الفواتير النقدية تظهر مع سداد فوري مقابل لها فلا تؤثر على الرصيد.", "Customer account activity for the period, including credit and cash invoices, returns, and vouchers, with opening and running balances. Cash invoices are paired with immediate settlement and do not affect the balance.")}>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <FilterField label={text("العميل", "Customer")}>
            <SearchCombobox
              value={customerId}
              onChange={(v) => setCustomerId(v === "" ? "" : Number(v))}
              options={customerOpts}
              style={{ ...input, padding: "8px 10px", minWidth: 240 }}
            />
          </FilterField>
          <DateField label={text("من تاريخ", "From date")} value={fromDate} onChange={setFromDate} />
          <DateField label={text("إلى تاريخ", "To date")} value={toDate} onChange={setToDate} />
          <FilterField label={text("الرصيد الافتتاحي", "Opening balance")}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, height: 38 }}>
              <input
                type="checkbox"
                checked={includeOpening}
                onChange={(e) => setIncludeOpening(e.target.checked)}
                style={{ width: 16, height: 16 }}
              />
              {text("تضمين", "Include")}
            </label>
          </FilterField>
          <FilterField label={text("الفواتير النقدية", "Cash invoices")}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, height: 38 }}>
              <input
                type="checkbox"
                checked={includeCash}
                onChange={(e) => setIncludeCash(e.target.checked)}
                style={{ width: 16, height: 16 }}
              />
              {text("تضمين", "Include")}
            </label>
          </FilterField>
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : text("عرض", "Run report")}</button>
        </div>
        {err && <div style={{ marginTop: 8, color: "#991b1b", fontSize: 13 }}>⚠️ {err}</div>}
      </Card>

      {result && (
        <Card>
          {exportRows.length > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
              <ExportButtons
                columns={exportCols}
                rows={exportRows}
                filenameBase={text("كشف-حساب-عميل", "customer-statement")}
                title={`${text("كشف حساب عميل", "Customer statement")} — ${result.customer.nameAr} — ${fromDate} → ${toDate}`}
              />
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginBottom: 14, fontSize: 13 }}>
            <div><b>{text("العميل:", "Customer:")}</b> {result.customer.nameAr}</div>
            {result.customer.vatNumber && <div><b>{text("الرقم الضريبي:", "Tax number:")}</b> {result.customer.vatNumber}</div>}
            {result.customer.phone && <div><b>{text("الهاتف:", "Phone:")}</b> {result.customer.phone}</div>}
            <div><b>{text("الفترة:", "Period:")}</b> {fromDate} → {toDate}</div>
          </div>
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 110 }}>{text("التاريخ", "Date")}</Th>
                <Th style={{ width: 120 }}>{text("النوع", "Type")}</Th>
                <Th style={{ width: 110 }}>{text("المستند", "Document")}</Th>
                <Th>{text("البيان", "Description")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 130 }}>{text("مدين", "Debit")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 130 }}>{text("دائن", "Credit")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 150 }}>{text("الرصيد", "Balance")}</Th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ background: "#fffbeb", fontWeight: 600 }}>
                <Td colSpan={6}>{text("الرصيد الافتتاحي", "Opening balance")}</Td>
                <Td num>{fmt(result.opening)}</Td>
              </tr>
              {result.lines.length === 0 && (
                <tr><Td colSpan={7}><Empty text={text("لا توجد حركة في الفترة المحددة", "No activity for this period")} /></Td></tr>
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
                <Td colSpan={4}>{text("الإجمالي / الرصيد الختامي", "Total / closing balance")}</Td>
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
