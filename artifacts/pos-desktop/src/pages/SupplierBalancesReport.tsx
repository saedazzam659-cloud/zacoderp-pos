import { useState } from "react";
import { listSuppliers, type Supplier } from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, SearchCombobox, input, ExportButtons } from "./_adminUi";
import { FilterField } from "./_reportFilters";
import { useDataRefresh } from "../lib/dataBus";
import type { ExportColumn } from "../lib/exporters";
import { uiText, useUiLanguage } from "../lib/appSettings";

// Flat row mirroring the on-screen balances table (per-supplier rows + totals row).
type BalExportRow = {
  code: string;
  name: string;
  vatNumber: string;
  phone: string;
  balance: number;
  note: string;
};

// suppliers_local.balance is the supplier AP balance: positive = we owe the
// supplier (دائن), negative = the supplier owes us (مدين, e.g. over-payment).
type Filter = "all" | "owed" | "advance" | "zero";

export default function SupplierBalancesReport() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<Supplier[] | null>(null);
  const [filter, setFilter] = useState<Filter>("owed");
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      const list = await listSuppliers();
      setRows(list.slice().sort((a, b) => b.balance - a.balance));
    } finally { setLoading(false); }
  }

  // Re-run the displayed balances when an invoice/voucher/journal is posted on
  // another tab, but only when balances are already shown.
  useDataRefresh(["invoices", "vouchers", "journal", "suppliers"], () => { if (rows) void run(); });

  const shown = (rows ?? []).filter((s) => {
    if (filter === "owed") return s.balance > 0.001;
    if (filter === "advance") return s.balance < -0.001;
    if (filter === "zero") return Math.abs(s.balance) <= 0.001;
    return true;
  });

  const totalOwed = shown.reduce((s, r) => s + (r.balance > 0 ? r.balance : 0), 0);
  const totalAdvance = shown.reduce((s, r) => s + (r.balance < 0 ? -r.balance : 0), 0);

  // Export rows mirror the on-screen table: per-supplier rows + totals row.
  const exportRows: BalExportRow[] = shown.map((s) => ({
    code: s.code || "—",
    name: s.nameAr,
    vatNumber: s.vatNumber || "—",
    phone: s.phone || "—",
    balance: s.balance,
    note: s.balance < -0.001 ? text("مدين", "Debit") : s.balance > 0.001 ? text("دائن", "Credit") : "",
  }));
  if (shown.length > 0) {
    exportRows.push({
      code: "", name: `${text("الإجمالي", "Total")} (${shown.length} ${text("مورد", "suppliers")})`, vatNumber: "", phone: "",
      balance: shown.reduce((s, r) => s + r.balance, 0), note: "",
    });
  }
  const exportCols: ExportColumn<BalExportRow>[] = [
    { header: text("الكود", "Code"), cell: (r) => r.code },
    { header: text("المورد", "Supplier"), cell: (r) => r.name },
    { header: text("الرقم الضريبي", "Tax number"), cell: (r) => r.vatNumber },
    { header: text("الهاتف", "Phone"), cell: (r) => r.phone },
    { header: text("الرصيد", "Balance"), cell: (r) => r.balance },
    { header: text("الطبيعة", "Type"), cell: (r) => r.note },
  ];

  return (
    <Page title={text("أرصدة الموردين", "Supplier balances")} subtitle={text("الرصيد الحالي لكل مورد. الرصيد الموجب = مستحق للمورد (دائن)، السالب = دفعة مقدمة لدى المورد (مدين).", "Current balance for each supplier. Positive means payable to the supplier; negative means an advance payment.")}>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <FilterField label={text("التصفية", "Filter")}>
            <SearchCombobox
              value={filter}
              onChange={(v) => setFilter((v as Filter) || "all")}
              options={[
                { value: "owed", label: text("مستحق للمورد فقط", "Payables only") },
                { value: "advance", label: text("دفعات مقدمة فقط", "Advances only") },
                { value: "zero", label: text("رصيد صفري", "Zero balance") },
                { value: "all", label: text("الكل", "All") },
              ]}
              style={{ ...input, padding: "8px 10px", minWidth: 200 }}
            />
          </FilterField>
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "..." : text("عرض", "Run report")}</button>
        </div>
      </Card>

      {rows && (
        <Card>
          {exportRows.length > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
              <ExportButtons
                columns={exportCols}
                rows={exportRows}
                filenameBase={text("أرصدة-الموردين", "supplier-balances")}
                title={text("أرصدة الموردين", "Supplier balances")}
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 24, marginBottom: 10, fontSize: 13 }}>
            <div><b>{text("إجمالي المستحق للموردين:", "Total payable to suppliers:")}</b> {fmt(totalOwed)}</div>
            <div><b>{text("إجمالي الدفعات المقدمة:", "Total supplier advances:")}</b> {fmt(totalAdvance)}</div>
          </div>
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 120 }}>{text("الكود", "Code")}</Th>
                <Th>{text("المورد", "Supplier")}</Th>
                <Th style={{ width: 160 }}>{text("الرقم الضريبي", "Tax number")}</Th>
                <Th style={{ width: 140 }}>{text("الهاتف", "Phone")}</Th>
                <Th style={{ textAlign: language === "en" ? "right" : "left", width: 160 }}>{text("الرصيد", "Balance")}</Th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><Td colSpan={5}><Empty text={text("لا يوجد موردون مطابقون للتصفية", "No suppliers match this filter")} /></Td></tr>
              )}
              {shown.map((s) => (
                <tr key={s.id}>
                  <Td mono>{s.code || "—"}</Td>
                  <Td>{s.nameAr}</Td>
                  <Td mono>{s.vatNumber || "—"}</Td>
                  <Td mono>{s.phone || "—"}</Td>
                  <Td num style={{ color: s.balance < -0.001 ? "#991b1b" : undefined }}>
                    {fmt(s.balance)} {s.balance < -0.001 ? `(${text("مدين", "Debit")})` : s.balance > 0.001 ? `(${text("دائن", "Credit")})` : ""}
                  </Td>
                </tr>
              ))}
              {shown.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td colSpan={4}>{text("الإجمالي", "Total")} ({shown.length} {text("مورد", "suppliers")})</Td>
                  <Td num>{fmt(shown.reduce((s, r) => s + r.balance, 0))}</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
