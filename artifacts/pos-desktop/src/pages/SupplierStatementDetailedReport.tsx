import { useEffect, useMemo, useState } from "react";
import {
  listPurchases, listPurchaseReturns, listFinancialTx, listSuppliers,
  getPurchase, getPurchaseReturn,
  type Supplier,
} from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, SearchCombobox, input } from "./_adminUi";
import { DateField, FilterField } from "./_reportFilters";

function firstOfYear(): string { return todayStr().slice(0, 4) + "-01-01"; }

// A document on the supplier ledger, expanded with its item lines. Same AP
// sign convention as the summary statement (positive running = we owe).
type DetailLine = { itemName: string; qty: number; unitCost: number; lineTotal: number };
type DetailDoc = {
  date: string; docType: string; docNo: string; description: string;
  debit: number; credit: number; lines: DetailLine[];
};

export default function SupplierStatementDetailedReport() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [fromDate, setFromDate] = useState(firstOfYear());
  const [toDate, setToDate] = useState(todayStr());
  const [result, setResult] = useState<{ supplier: Supplier; opening: number; docs: DetailDoc[] } | null>(null);
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
      // Opening = net (credit − debit) of every AP movement BEFORE fromDate.
      let opening = 0;
      const creditInvIds: number[] = [];
      const returnIds: number[] = [];
      for (const inv of purchases) {
        if (inv.supplierId !== supplierId || inv.paymentMethod !== "credit") continue;
        if (inv.invoiceDate < fromDate) opening += inv.grandTotal;
        else if (inv.invoiceDate <= toDate) creditInvIds.push(inv.id);
      }
      for (const r of returns) {
        if (r.supplierId !== supplierId) continue;
        if (r.returnDate < fromDate) opening -= r.grandTotal;
        else if (r.returnDate <= toDate) returnIds.push(r.id);
      }
      for (const t of txs) {
        if (t.partyType !== "supplier" || t.partyId !== supplierId) continue;
        const signed = t.txType === "payment" ? -t.amount : t.amount;
        if (t.txDate < fromDate) opening += signed;
      }

      const docs: DetailDoc[] = [];
      const [fullInvs, fullRets] = await Promise.all([
        Promise.all(creditInvIds.map((id) => getPurchase(id))),
        Promise.all(returnIds.map((id) => getPurchaseReturn(id))),
      ]);
      for (const inv of fullInvs) {
        docs.push({
          date: inv.invoiceDate, docType: "فاتورة مشتريات", docNo: inv.invoiceNo,
          description: inv.notes || "", debit: 0, credit: inv.grandTotal,
          lines: inv.lines.map((l) => ({ itemName: l.itemName || `#${l.itemId}`, qty: l.qty, unitCost: l.unitCost, lineTotal: l.lineTotal })),
        });
      }
      for (const r of fullRets) {
        docs.push({
          date: r.returnDate, docType: "مرتجع مشتريات", docNo: r.returnNo,
          description: r.notes || "", debit: r.grandTotal, credit: 0,
          lines: r.lines.map((l) => ({ itemName: l.itemName || `#${l.itemId}`, qty: l.qty, unitCost: l.unitCost, lineTotal: l.lineTotal })),
        });
      }
      // Payment / receipt vouchers in range (no item lines).
      for (const t of txs) {
        if (t.partyType !== "supplier" || t.partyId !== supplierId) continue;
        if (t.txDate < fromDate || t.txDate > toDate) continue;
        const isPayment = t.txType === "payment";
        docs.push({
          date: t.txDate, docType: isPayment ? "سند صرف" : "سند قبض", docNo: t.txNo,
          description: t.description || "", debit: isPayment ? t.amount : 0, credit: isPayment ? 0 : t.amount,
          lines: [],
        });
      }
      docs.sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1
          : a.docNo.localeCompare(b.docNo, undefined, { numeric: true }));
      setResult({ supplier, opening, docs });
    } finally { setLoading(false); }
  }

  const totals = (result?.docs ?? []).reduce((s, d) => { s.dr += d.debit; s.cr += d.credit; return s; }, { dr: 0, cr: 0 });
  const closing = result ? result.opening + totals.cr - totals.dr : 0;

  return (
    <Page title="كشف حساب مورد تفصيلي" subtitle="حركة المورد خلال الفترة مع تفصيل أصناف كل فاتورة ومرتجع. الرصيد الموجب = مستحق للمورد.">
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
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : "عرض"}</button>
        </div>
        {err && <div style={{ marginTop: 8, color: "#991b1b", fontSize: 13 }}>⚠️ {err}</div>}
      </Card>

      {result && (
        <Card>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginBottom: 14, fontSize: 13 }}>
            <div><b>المورد:</b> {result.supplier.nameAr}</div>
            {result.supplier.vatNumber && <div><b>الرقم الضريبي:</b> {result.supplier.vatNumber}</div>}
            <div><b>الفترة:</b> {fromDate} ← {toDate}</div>
          </div>
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 110 }}>التاريخ</Th>
                <Th style={{ width: 120 }}>النوع</Th>
                <Th style={{ width: 110 }}>المستند</Th>
                <Th>البيان / الصنف</Th>
                <Th style={{ textAlign: "left", width: 90 }}>الكمية</Th>
                <Th style={{ textAlign: "left", width: 110 }}>التكلفة</Th>
                <Th style={{ textAlign: "left", width: 120 }}>مدين</Th>
                <Th style={{ textAlign: "left", width: 120 }}>دائن</Th>
                <Th style={{ textAlign: "left", width: 140 }}>الرصيد</Th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ background: "#fffbeb", fontWeight: 600 }}>
                <Td colSpan={8}>الرصيد الافتتاحي</Td>
                <Td num>{fmt(result.opening)}</Td>
              </tr>
              {result.docs.length === 0 && (
                <tr><Td colSpan={9}><Empty text="لا توجد حركة في الفترة المحددة" /></Td></tr>
              )}
              {(() => {
                let running = result.opening;
                const out: React.ReactNode[] = [];
                result.docs.forEach((d, i) => {
                  running += d.credit - d.debit;
                  out.push(
                    <tr key={`d${i}`} style={{ fontWeight: 600, background: "#f8fafc" }}>
                      <Td mono>{d.date}</Td>
                      <Td>{d.docType}</Td>
                      <Td mono>{d.docNo}</Td>
                      <Td>{d.description || "—"}</Td>
                      <Td />
                      <Td />
                      <Td num>{d.debit > 0.001 ? fmt(d.debit) : ""}</Td>
                      <Td num>{d.credit > 0.001 ? fmt(d.credit) : ""}</Td>
                      <Td num>{fmt(running)}</Td>
                    </tr>,
                  );
                  d.lines.forEach((l, j) => {
                    out.push(
                      <tr key={`d${i}l${j}`} style={{ color: "#64748b", fontSize: 13 }}>
                        <Td />
                        <Td />
                        <Td />
                        <Td style={{ paddingInlineStart: 24 }}>{l.itemName}</Td>
                        <Td num>{fmt(l.qty)}</Td>
                        <Td num>{fmt(l.unitCost)}</Td>
                        <Td colSpan={2} num>{fmt(l.lineTotal)}</Td>
                        <Td />
                      </tr>,
                    );
                  });
                });
                return out;
              })()}
              <tr style={{ fontWeight: 700, background: "#f1f5f9" }}>
                <Td colSpan={6}>الإجمالي / الرصيد الختامي</Td>
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
