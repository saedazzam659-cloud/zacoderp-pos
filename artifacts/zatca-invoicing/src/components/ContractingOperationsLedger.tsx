import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TablePagination, usePagination } from "@/components/TablePagination";
import ExportButtons from "@/components/ExportButtons";

export type LedgerRow = {
  id: number;
  date: string;
  type: string;
  reference: string;
  amount: string;
  status: string;
  source: string;
  details: string;
};

export default function ContractingOperationsLedger({
  title, rows, filename, action,
}: {
  title: string;
  rows: LedgerRow[];
  filename: string;
  action?: (id: number) => ReactNode;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const filtered = useMemo(() => rows.filter(row =>
    (!search || Object.values(row).some(value => String(value ?? "").toLowerCase().includes(search.toLowerCase()))) &&
    (!status || row.status === status) &&
    (!from || row.date.slice(0, 10) >= from) &&
    (!to || row.date.slice(0, 10) <= to)
  ), [rows, search, status, from, to]);
  const pager = usePagination(filtered);
  const columns = [
    { key: "reference", header: "الرقم / المرجع" },
    { key: "date", header: "التاريخ" },
    { key: "type", header: "النوع" },
    { key: "amount", header: "المبلغ / الكمية" },
    { key: "status", header: "الحالة" },
    { key: "source", header: "المصدر" },
    { key: "details", header: "التفاصيل" },
  ];
  return (
    <div className="mt-5 border-t pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">{title} <span className="text-xs font-normal text-muted-foreground">({filtered.length})</span></h4>
        <ExportButtons rows={filtered} columns={columns} filename={filename} title={title}
          subtitle={`البحث: ${search || "الكل"} • الحالة: ${status || "الكل"} • من: ${from || "البداية"} • إلى: ${to || "اليوم"}`} />
      </div>
      <div className="mb-3 grid gap-2 sm:grid-cols-4">
        <Input aria-label={`بحث ${title}`} placeholder="بحث بالرقم أو المصدر أو التفاصيل..." value={search} onChange={e => { setSearch(e.target.value); pager.reset(); }} />
        <select aria-label="تصفية الحالة" className="h-10 rounded-md border bg-background px-2 text-sm" value={status} onChange={e => { setStatus(e.target.value); pager.reset(); }}>
          <option value="">كل الحالات</option>
          {[...new Set(rows.map(row => row.status))].map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <Input aria-label="من تاريخ" type="date" value={from} onChange={e => { setFrom(e.target.value); pager.reset(); }} />
        <Input aria-label="إلى تاريخ" type="date" value={to} onChange={e => { setTo(e.target.value); pager.reset(); }} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b text-right text-muted-foreground">
            {columns.slice(0, 6).map(col => <th key={col.key} className="whitespace-nowrap p-2">{col.header}</th>)}
            <th className="p-2">الإجراء</th>
          </tr></thead>
          <tbody>{pager.pagedItems.map(row => <tr key={row.id} className="border-b align-top">
            <td className="p-2 font-medium">{row.reference}</td>
            <td className="whitespace-nowrap p-2">{row.date.slice(0, 10)}</td>
            <td className="p-2">{row.type}</td>
            <td className="p-2">{row.amount}</td>
            <td className="p-2">{row.status}</td>
            <td className="p-2">{row.source}</td>
            <td className="p-2"><div className="flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>{expanded === row.id ? "إخفاء" : "تفاصيل"}</Button>
              {action?.(row.id)}
            </div>{expanded === row.id && <p className="mt-2 min-w-48 text-xs text-muted-foreground">{row.details}</p>}</td>
          </tr>)}</tbody>
        </table>
        {!filtered.length && <p className="p-4 text-center text-sm text-muted-foreground">لا توجد عمليات مطابقة</p>}
      </div>
      <TablePagination page={pager.page} pageSize={pager.pageSize} pageCount={pager.pageCount} total={pager.total}
        onPageChange={pager.setPage} onPageSizeChange={pager.setPageSize} />
    </div>
  );
}