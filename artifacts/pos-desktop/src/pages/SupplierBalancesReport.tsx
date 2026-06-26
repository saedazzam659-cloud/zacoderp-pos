import { useState } from "react";
import { listSuppliers, type Supplier } from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, btnPrimary, fmt, SearchCombobox, input, ExportButtons } from "./_adminUi";
import { FilterField } from "./_reportFilters";
import type { ExportColumn } from "../lib/exporters";

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
    note: s.balance < -0.001 ? "مدين" : s.balance > 0.001 ? "دائن" : "",
  }));
  if (shown.length > 0) {
    exportRows.push({
      code: "", name: `الإجمالي (${shown.length} مورد)`, vatNumber: "", phone: "",
      balance: shown.reduce((s, r) => s + r.balance, 0), note: "",
    });
  }
  const exportCols: ExportColumn<BalExportRow>[] = [
    { header: "الكود", cell: (r) => r.code },
    { header: "المورد", cell: (r) => r.name },
    { header: "الرقم الضريبي", cell: (r) => r.vatNumber },
    { header: "الهاتف", cell: (r) => r.phone },
    { header: "الرصيد", cell: (r) => r.balance },
    { header: "الطبيعة", cell: (r) => r.note },
  ];

  return (
    <Page title="أرصدة الموردين" subtitle="الرصيد الحالي لكل مورد. الرصيد الموجب = مستحق للمورد (دائن)، السالب = دفعة مقدمة لدى المورد (مدين).">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <FilterField label="التصفية">
            <SearchCombobox
              value={filter}
              onChange={(v) => setFilter((v as Filter) || "all")}
              options={[
                { value: "owed", label: "مستحق للمورد فقط" },
                { value: "advance", label: "دفعات مقدمة فقط" },
                { value: "zero", label: "رصيد صفري" },
                { value: "all", label: "الكل" },
              ]}
              style={{ ...input, padding: "8px 10px", minWidth: 200 }}
            />
          </FilterField>
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
                filenameBase="أرصدة-الموردين"
                title="أرصدة الموردين"
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 24, marginBottom: 10, fontSize: 13 }}>
            <div><b>إجمالي المستحق للموردين:</b> {fmt(totalOwed)}</div>
            <div><b>إجمالي الدفعات المقدمة:</b> {fmt(totalAdvance)}</div>
          </div>
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 120 }}>الكود</Th>
                <Th>المورد</Th>
                <Th style={{ width: 160 }}>الرقم الضريبي</Th>
                <Th style={{ width: 140 }}>الهاتف</Th>
                <Th style={{ textAlign: "left", width: 160 }}>الرصيد</Th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><Td colSpan={5}><Empty text="لا يوجد موردون مطابقون للتصفية" /></Td></tr>
              )}
              {shown.map((s) => (
                <tr key={s.id}>
                  <Td mono>{s.code || "—"}</Td>
                  <Td>{s.nameAr}</Td>
                  <Td mono>{s.vatNumber || "—"}</Td>
                  <Td mono>{s.phone || "—"}</Td>
                  <Td num style={{ color: s.balance < -0.001 ? "#991b1b" : undefined }}>
                    {fmt(s.balance)} {s.balance < -0.001 ? "(مدين)" : s.balance > 0.001 ? "(دائن)" : ""}
                  </Td>
                </tr>
              ))}
              {shown.length > 0 && (
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td colSpan={4}>الإجمالي ({shown.length} مورد)</Td>
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
