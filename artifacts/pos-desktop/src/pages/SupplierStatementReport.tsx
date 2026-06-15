import { useEffect, useMemo, useState } from "react";
import {
  listPurchases, listPurchaseReturns, listFinancialTx, listSuppliers,
  type Purchase, type PurchaseReturn, type FinancialTx, type Supplier,
} from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, SearchCombobox, input } from "./_adminUi";
import { DateField, FilterField } from "./_reportFilters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

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
//   • CREDIT purchase invoice → credit (AP rose, we owe more). Cash/bank
//     invoices settle on the spot (DR purchases / CR cash) and never touch AP.
//   • CREDIT purchase return  → debit (AP fell). Cash/bank returns refund cash.
//   • Payment voucher (سند صرف) to the supplier → debit (we paid, AP fell).
//   • Receipt voucher (سند قبض) from the supplier (refund/advance) → credit.
function buildLines(
  supplierId: number,
  purchases: Purchase[],
  returns: PurchaseReturn[],
  txs: FinancialTx[],
): StmtLine[] {
  const lines: StmtLine[] = [];
  for (const inv of purchases) {
    if (inv.supplierId !== supplierId) continue;
    if (inv.paymentMethod !== "credit") continue;
    lines.push({
      date: inv.invoiceDate,
      docType: "فاتورة مشتريات",
      docNo: inv.invoiceNo,
      description: inv.notes || "",
      debit: 0,
      credit: inv.grandTotal,
    });
  }
  for (const r of returns) {
    if (r.supplierId !== supplierId) continue;
    lines.push({
      date: r.returnDate,
      docType: "مرتجع مشتريات",
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
      docType: isPayment ? "سند صرف" : "سند قبض",
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
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [includeOpening, setIncludeOpening] = useState(true);
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
    if (supplierId === "") { setErr("اختر المورد أولاً"); return; }
    if (fromDate > toDate) { setErr("تاريخ البداية يجب أن يكون قبل تاريخ النهاية"); return; }
    const supplier = suppliers.find((s) => s.id === supplierId);
    if (!supplier) { setErr("المورد غير موجود"); return; }
    setErr(null); setLoading(true);
    try {
      const [purchases, returns, txs] = await Promise.all([
        listPurchases(100000),
        listPurchaseReturns(100000),
        listFinancialTx(100000),
      ]);
      const all = buildLines(supplierId, purchases, returns, txs);
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

  const totals = (result?.lines ?? []).reduce((s, l) => { s.dr += l.debit; s.cr += l.credit; return s; }, { dr: 0, cr: 0 });
  const closing = result ? result.opening + totals.cr - totals.dr : 0;

  return (
    <Page title="كشف حساب مورد" subtitle="حركة حساب المورد خلال الفترة (فواتير آجلة، مرتجعات آجلة، سندات الصرف والقبض) مع الرصيد الافتتاحي والجاري. الرصيد الموجب = مستحق للمورد.">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <FilterField label="المورد">
            <SearchCombobox
              value={supplierId}
              onChange={(v) => setSupplierId(v === "" ? "" : Number(v))}
              options={supplierOpts}
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
            <div><b>المورد:</b> {result.supplier.nameAr}</div>
            {result.supplier.vatNumber && <div><b>الرقم الضريبي:</b> {result.supplier.vatNumber}</div>}
            {result.supplier.phone && <div><b>الهاتف:</b> {result.supplier.phone}</div>}
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
