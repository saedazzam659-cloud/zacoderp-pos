import { useState } from "react";
import {
  listPurchases, listPurchaseReturns, listFinancialTx, listSuppliers,
  type Purchase, type PurchaseReturn, type FinancialTx,
} from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, todayStr, ExportButtons } from "./_adminUi";
import { DateField } from "./_reportFilters";
import { useDataRefresh } from "../lib/dataBus";
import type { ExportColumn } from "../lib/exporters";

// Flat row mirroring the on-screen aging table (per-supplier buckets + totals row).
type AgeExportRow = {
  name: string;
  b0: number;
  b30: number;
  b60: number;
  b90: number;
  total: number;
};

// Accounts-payable aging. We FIFO-apply every AP-reducing event (credit purchase
// returns + payment vouchers to the supplier) against that supplier's CREDIT
// purchase invoices oldest-first, then bucket each invoice's REMAINING
// outstanding amount by its age (asOf − invoiceDate).
type AgeRow = {
  supplierId: number; name: string;
  b0: number; b30: number; b60: number; b90: number; total: number;
};

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.floor((db - da) / 86400000);
}

export default function SupplierAgingReport() {
  const [asOf, setAsOf] = useState(todayStr());
  const [rows, setRows] = useState<AgeRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      const [suppliers, purchases, returns, txs] = await Promise.all([
        listSuppliers(),
        listPurchases(100000),
        listPurchaseReturns(100000),
        listFinancialTx(100000),
      ]);
      const nameById = new Map(suppliers.map((s) => [s.id, s.nameAr]));

      // Per-supplier ordered list of outstanding credit invoices (oldest first).
      const bySupplier = new Map<number, { date: string; remaining: number }[]>();
      const creditInvs = purchases
        .filter((p: Purchase) => p.paymentMethod === "credit" && p.invoiceDate <= asOf)
        .sort((a, b) => (a.invoiceDate < b.invoiceDate ? -1 : 1));
      for (const inv of creditInvs) {
        const arr = bySupplier.get(inv.supplierId) ?? [];
        arr.push({ date: inv.invoiceDate, remaining: inv.grandTotal });
        bySupplier.set(inv.supplierId, arr);
      }

      // Credits available per supplier = credit returns + payment vouchers (≤ asOf).
      const credits = new Map<number, number>();
      for (const r of returns as PurchaseReturn[]) {
        if (r.returnDate > asOf) continue;
        credits.set(r.supplierId, (credits.get(r.supplierId) ?? 0) + r.grandTotal);
      }
      for (const t of txs as FinancialTx[]) {
        if (t.partyType !== "supplier" || t.partyId == null) continue;
        if (t.txDate > asOf) continue;
        // payment to supplier reduces AP; a receipt (refund from supplier) raises it
        const delta = t.txType === "payment" ? t.amount : -t.amount;
        credits.set(t.partyId, (credits.get(t.partyId) ?? 0) + delta);
      }

      // FIFO-apply credits oldest-first.
      for (const [sid, invs] of bySupplier) {
        let avail = credits.get(sid) ?? 0;
        for (const inv of invs) {
          if (avail <= 0) break;
          const used = Math.min(avail, inv.remaining);
          inv.remaining -= used; avail -= used;
        }
      }

      const out: AgeRow[] = [];
      for (const [sid, invs] of bySupplier) {
        const row: AgeRow = { supplierId: sid, name: nameById.get(sid) || `#${sid}`, b0: 0, b30: 0, b60: 0, b90: 0, total: 0 };
        for (const inv of invs) {
          if (inv.remaining <= 0.001) continue;
          const age = daysBetween(inv.date, asOf);
          if (age <= 30) row.b0 += inv.remaining;
          else if (age <= 60) row.b30 += inv.remaining;
          else if (age <= 90) row.b60 += inv.remaining;
          else row.b90 += inv.remaining;
          row.total += inv.remaining;
        }
        if (row.total > 0.001) out.push(row);
      }
      out.sort((a, b) => b.total - a.total);
      setRows(out);
    } finally { setLoading(false); }
  }

  // Re-run the displayed aging when an invoice/voucher/journal is posted on
  // another tab, but only when a report is already shown.
  useDataRefresh(["invoices", "vouchers", "journal", "suppliers"], () => { if (rows) void run(); });

  const totals = (rows ?? []).reduce(
    (s, r) => { s.b0 += r.b0; s.b30 += r.b30; s.b60 += r.b60; s.b90 += r.b90; s.total += r.total; return s; },
    { b0: 0, b30: 0, b60: 0, b90: 0, total: 0 },
  );

  // Export rows mirror the on-screen table: per-supplier buckets + totals row.
  const exportRows: AgeExportRow[] = (rows ?? []).map((r) => ({
    name: r.name, b0: r.b0, b30: r.b30, b60: r.b60, b90: r.b90, total: r.total,
  }));
  if (rows && rows.length > 0) {
    exportRows.push({
      name: `الإجمالي (${rows.length} مورد)`,
      b0: totals.b0, b30: totals.b30, b60: totals.b60, b90: totals.b90, total: totals.total,
    });
  }
  const exportCols: ExportColumn<AgeExportRow>[] = [
    { header: "المورد", cell: (r) => r.name },
    { header: "0 - 30 يوم", cell: (r) => r.b0 },
    { header: "31 - 60 يوم", cell: (r) => r.b30 },
    { header: "61 - 90 يوم", cell: (r) => r.b60 },
    { header: "أكثر من 90", cell: (r) => r.b90 },
    { header: "الإجمالي", cell: (r) => r.total },
  ];

  return (
    <Page title="أعمار ديون الموردين" subtitle="توزيع المستحق لكل مورد على فترات تقادم الفواتير الآجلة (تطبيق الدفعات والمرتجعات على الأقدم أولاً).">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <DateField label="حتى تاريخ" value={asOf} onChange={setAsOf} />
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : "عرض"}</button>
        </div>
      </Card>

      {rows && (
        <Card>
          {exportRows.length > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
              <ExportButtons
                columns={exportCols}
                rows={exportRows}
                filenameBase="أعمار-ديون-الموردين"
                title={`أعمار ديون الموردين — حتى ${asOf}`}
              />
            </div>
          )}
          <Table>
            <thead>
              <tr>
                <Th>المورد</Th>
                <Th style={{ textAlign: "left", width: 120 }}>0 - 30 يوم</Th>
                <Th style={{ textAlign: "left", width: 120 }}>31 - 60 يوم</Th>
                <Th style={{ textAlign: "left", width: 120 }}>61 - 90 يوم</Th>
                <Th style={{ textAlign: "left", width: 120 }}>أكثر من 90</Th>
                <Th style={{ textAlign: "left", width: 150 }}>الإجمالي</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><Td colSpan={6}><Empty text="لا توجد ديون مستحقة حتى التاريخ المحدد" /></Td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.supplierId}>
                  <Td>{r.name}</Td>
                  <Td num>{r.b0 > 0.001 ? fmt(r.b0) : ""}</Td>
                  <Td num>{r.b30 > 0.001 ? fmt(r.b30) : ""}</Td>
                  <Td num>{r.b60 > 0.001 ? fmt(r.b60) : ""}</Td>
                  <Td num style={{ color: r.b90 > 0.001 ? "#991b1b" : undefined }}>{r.b90 > 0.001 ? fmt(r.b90) : ""}</Td>
                  <Td num>{fmt(r.total)}</Td>
                </tr>
              ))}
              {rows.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td>الإجمالي ({rows.length} مورد)</Td>
                  <Td num>{fmt(totals.b0)}</Td>
                  <Td num>{fmt(totals.b30)}</Td>
                  <Td num>{fmt(totals.b60)}</Td>
                  <Td num>{fmt(totals.b90)}</Td>
                  <Td num>{fmt(totals.total)}</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
