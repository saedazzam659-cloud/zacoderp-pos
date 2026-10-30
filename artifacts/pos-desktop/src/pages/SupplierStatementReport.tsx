import { useEffect, useMemo, useState } from "react";
import {
  listPurchases, listPurchaseReturns, listFinancialTx, listSuppliers,
  type Purchase, type PurchaseReturn, type FinancialTx, type Supplier,
} from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, SearchCombobox, input, ExportButtons } from "./_adminUi";
import { DateField, FilterField } from "./_reportFilters";
import { useDataRefresh } from "../lib/dataBus";
import type { ExportColumn } from "../lib/exporters";
import { uiText, useUiLanguage } from "../lib/appSettings";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

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

// One movement on the supplier's AP sub-ledger. AP is a liability with a normal
// CREDIT balance — positive running balance = we owe the supplier (دائن). Built
// purely in TS from source documents so no Rust/SQLite changes are needed.
type StmtLine = {
  date: string;
  docType: string;
  docNo: string;
  description: string;
  debit: number;
  credit: number;
};

// AP semantics (mirror of the customer AR statement, signs flipped):
//   • CREDIT purchase invoice → credit (AP rose, we owe more).
//   • CASH/BANK purchase invoice (when includeCash) → shown as a PAIR: the
//     invoice credit + an immediate settlement debit on the same date, so it
//     appears in the statement yet nets to zero on the running balance (it
//     settled on the spot: DR purchases / CR cash, never touching AP). No
//     double-count: cash invoices do NOT create a financial_transactions row.
//   • CREDIT purchase return  → debit (AP fell). Cash/bank returns refund cash.
//   • Payment voucher (سند صرف) to the supplier → debit (we paid, AP fell).
//   • Receipt voucher (سند قبض) from the supplier (refund/advance) → credit.
function buildLines(
  supplierId: number,
  purchases: Purchase[],
  returns: PurchaseReturn[],
  txs: FinancialTx[],
  includeCash: boolean,
  language: "ar" | "en",
): StmtLine[] {
  const lines: StmtLine[] = [];
  for (const inv of purchases) {
    if (inv.supplierId !== supplierId) continue;
    if (inv.paymentMethod === "credit") {
      lines.push({
        date: inv.invoiceDate,
        docType: uiText("فاتورة مشتريات", "Purchase invoice", language),
        docNo: inv.invoiceNo,
        description: inv.notes || "",
        debit: 0,
        credit: inv.grandTotal,
      });
    } else if (includeCash) {
      const settle = inv.paymentMethod === "bank" ? uiText("سداد بنكي فوري", "Immediate bank payment", language) : uiText("سداد نقدي فوري", "Immediate cash payment", language);
      lines.push({
        date: inv.invoiceDate,
        docType: uiText("فاتورة مشتريات نقدية", "Cash purchase invoice", language),
        docNo: inv.invoiceNo,
        description: inv.notes || "",
        debit: 0,
        credit: inv.grandTotal,
      });
      lines.push({
        date: inv.invoiceDate,
        docType: settle,
        docNo: inv.invoiceNo,
        description: uiText("سداد قيمة الفاتورة النقدية فوراً", "Immediate settlement of cash invoice", language),
        debit: inv.grandTotal,
        credit: 0,
      });
    }
  }
  for (const r of returns) {
    if (r.supplierId !== supplierId) continue;
    lines.push({
      date: r.returnDate,
        docType: uiText("مرتجع مشتريات", "Purchase return", language),
      docNo: r.returnNo,
      description: r.notes || "",
      debit: r.grandTotal,
      credit: 0,
    });
  }
  for (const t of txs) {
    if (t.partyType !== "supplier" || t.partyId !== supplierId) continue;
    const isPayment = t.txType === "payment";
    lines.push({
      date: t.txDate,
      docType: isPayment ? uiText("سند صرف", "Payment voucher", language) : uiText("سند قبض", "Receipt voucher", language),
      docNo: t.txNo,
      description: t.description || "",
      debit: isPayment ? t.amount : 0,
      credit: isPayment ? 0 : t.amount,
    });
  }
  lines.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1
      : a.docNo.localeCompare(b.docNo, undefined, { numeric: true }));
  return lines;
}

export default function SupplierStatementReport() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [includeOpening, setIncludeOpening] = useState(true);
  const [includeCash, setIncludeCash] = useState(true);
  const [result, setResult] = useState<{ supplier: Supplier; opening: number; lines: StmtLine[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { void (async () => setSuppliers(await listSuppliers()))(); }, []);

  const supplierOpts = useMemo(
    () => suppliers
      .slice()
      .sort((a, b) => a.nameAr.localeCompare(b.nameAr))
      .map((s) => ({ value: s.id, label: s.nameAr, hint: s.vatNumber ?? s.phone ?? "" })),
    [suppliers],
  );

  async function run() {
    if (supplierId === "") { setErr(text("اختر المورد أولاً", "Select a supplier first.")); return; }
    if (fromDate > toDate) { setErr(text("تاريخ البداية يجب أن يكون قبل تاريخ النهاية", "Start date must be on or before end date.")); return; }
    const supplier = suppliers.find((s) => s.id === supplierId);
    if (!supplier) { setErr(text("المورد غير موجود", "Supplier not found.")); return; }
    setErr(null); setLoading(true);
    try {
      const [purchases, returns, txs] = await Promise.all([
        listPurchases(100000),
        listPurchaseReturns(100000),
        listFinancialTx(100000),
      ]);
      const all = buildLines(supplierId, purchases, returns, txs, includeCash, language);
      // Opening = net movement (credit − debit) of every document dated BEFORE
      // the period start. The period is INCLUSIVE on both ends.
      let opening = 0;
      const inRange: StmtLine[] = [];
      for (const l of all) {
        if (l.date < fromDate) opening += l.credit - l.debit;
        else if (l.date <= toDate) inRange.push(l);
      }
      if (!includeOpening) opening = 0;
      setResult({ supplier, opening, lines: inRange });
    } finally { setLoading(false); }
  }

  // Re-run the displayed statement when an invoice/voucher is created on another
  // tab, but only when a statement is already shown.
  useDataRefresh(["invoices", "vouchers", "journal"], () => { if (result) void run(); });

  const totals = (result?.lines ?? []).reduce((s, l) => { s.dr += l.debit; s.cr += l.credit; return s; }, { dr: 0, cr: 0 });
  const closing = result ? result.opening + totals.cr - totals.dr : 0;

  // Export rows mirror the on-screen table exactly: opening row + per-line
  // running balance (AP: credit − debit) + totals/closing row. Raw numbers so
  // Excel stays numeric.
  const exportRows = useMemo<StmtExportRow[]>(() => {
    if (!result) return [];
    const out: StmtExportRow[] = [];
    out.push({ date: "", docType: "", docNo: "", description: text("الرصيد الافتتاحي", "Opening balance"), debit: "", credit: "", balance: result.opening });
    let running = result.opening;
    for (const l of result.lines) {
      running += l.credit - l.debit;
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
    <Page title={text("كشف حساب مورد", "Supplier statement")} subtitle={text("حركة حساب المورد خلال الفترة (الفواتير الآجلة والنقدية، المرتجعات، سندات الصرف والقبض) مع الرصيد الافتتاحي والجاري. الفواتير النقدية تظهر مع سداد فوري مقابل لها فلا تؤثر على الرصيد. الرصيد الموجب = مستحق للمورد.", "Supplier account activity for the period, including credit and cash invoices, returns, and vouchers, with opening and running balances. Cash invoices are paired with immediate settlement and do not affect the balance. A positive balance is payable to the supplier.")}>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <FilterField label={text("المورد", "Supplier")}>
            <SearchCombobox
              value={supplierId}
              onChange={(v) => setSupplierId(v === "" ? "" : Number(v))}
              options={supplierOpts}
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
                filenameBase={text("كشف-حساب-مورد", "supplier-statement")}
                title={`${text("كشف حساب مورد", "Supplier statement")} — ${result.supplier.nameAr} — ${fromDate} → ${toDate}`}
              />
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginBottom: 14, fontSize: 13 }}>
            <div><b>{text("المورد:", "Supplier:")}</b> {result.supplier.nameAr}</div>
            {result.supplier.vatNumber && <div><b>{text("الرقم الضريبي:", "Tax number:")}</b> {result.supplier.vatNumber}</div>}
            {result.supplier.phone && <div><b>{text("الهاتف:", "Phone:")}</b> {result.supplier.phone}</div>}
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
                  running += l.credit - l.debit;
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
