import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { FileText, ArrowLeft, Printer, FileSpreadsheet, FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { sisterCompaniesApi } from "@/lib/sisterCompaniesApi";
import { exportToExcel, exportToPDF, type ExportColumn } from "@/lib/export";
import { DateField } from "@/components/ui/date-field";

export default function SisterCompanyStatement() {
  const [, params] = useRoute<{ id: string }>("/inventory/sister-companies/:id/statement");
  const sid = Number(params?.id);
  const [from, setFrom] = useState<string>("");
  const [to,   setTo]   = useState<string>("");

  const { data: sister } = useQuery({
    queryKey: ["sister-company", sid],
    queryFn: () => sisterCompaniesApi.get(sid),
    enabled: !!sid,
  });
  const { data: stmt, isLoading } = useQuery({
    queryKey: ["sister-statement", sid, from, to],
    queryFn: () => sisterCompaniesApi.statement(sid, from || undefined, to || undefined),
    enabled: !!sid,
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <FileText className="h-5 w-5" /> كشف حساب — {sister?.nameAr ?? "…"}
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          {(() => {
            const cols: ExportColumn[] = [
              { header: "التاريخ", key: "date", width: 14 },
              { header: "المستند", key: "docNumber", width: 16 },
              { header: "النوع", key: "type", width: 16 },
              { header: "البيان", key: "description", width: 36 },
              { header: "مدين", key: "debit", width: 14 },
              { header: "دائن", key: "credit", width: 14 },
              { header: "الرصيد", key: "balance", width: 14 },
            ];
            const data = stmt ? [
              { date: "", docNumber: "", type: "", description: "الرصيد الافتتاحي", debit: "", credit: "", balance: Number(stmt.opening).toFixed(2) },
              ...stmt.rows.map((r: any) => ({
                date: r.date, docNumber: r.docNumber, type: r.type,
                description: r.description,
                debit:  r.debit  ? Number(r.debit ).toFixed(2) : "",
                credit: r.credit ? Number(r.credit).toFixed(2) : "",
                balance: Number(r.balance).toFixed(2),
              })),
            ] : [];
            const totals = stmt ? {
              date: "الرصيد الختامي",
              balance: Number(stmt.closing).toFixed(2),
            } : null;
            const title = `كشف حساب — ${sister?.nameAr ?? ""}`;
            const subtitle = (from || to) ? `الفترة: ${from || "—"} إلى ${to || "—"}` : undefined;
            const disabled = !stmt || data.length === 0;
            return (
              <>
                <Button variant="outline" size="sm" onClick={() => window.print()} data-testid="btn-print">
                  <Printer className="h-4 w-4 ml-1" /> طباعة
                </Button>
                <Button variant="outline" size="sm" disabled={disabled}
                  onClick={() => exportToExcel(data, cols, `sister-statement-${sid}`, title, totals)}
                  data-testid="btn-export-excel">
                  <FileSpreadsheet className="h-4 w-4 ml-1" /> Excel
                </Button>
                <Button variant="outline" size="sm" disabled={disabled}
                  onClick={() => exportToPDF(data, cols, `sister-statement-${sid}`, title, subtitle, true, totals)}
                  data-testid="btn-export-pdf">
                  <FileDown className="h-4 w-4 ml-1" /> PDF
                </Button>
              </>
            );
          })()}
          <Link href="/inventory/sister-companies">
            <Button variant="outline"><ArrowLeft className="h-4 w-4 ml-1" /> رجوع</Button>
          </Link>
        </div>
      </div>

      <Card><CardContent className="flex flex-wrap gap-3 items-end pt-6">
        <label><span className="text-sm">من تاريخ</span>
          <DateField value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label><span className="text-sm">إلى تاريخ</span>
          <DateField value={to} onChange={e => setTo(e.target.value)} /></label>
        <Button variant="outline" onClick={() => { setFrom(""); setTo(""); }}>إعادة تعيين</Button>
      </CardContent></Card>

      <Card><CardContent className="p-0 overflow-x-auto">
        {isLoading || !stmt ? <div className="p-4"><Skeleton className="h-32" /></div> : (
          <table className="w-full text-sm" data-testid="table-statement">
            <thead className="bg-muted/50"><tr>
              <th className="p-2 text-right">التاريخ</th>
              <th className="p-2 text-right">المستند</th>
              <th className="p-2 text-right">النوع</th>
              <th className="p-2 text-right">البيان</th>
              <th className="p-2 text-left">مدين</th>
              <th className="p-2 text-left">دائن</th>
              <th className="p-2 text-left">الرصيد</th>
            </tr></thead>
            <tbody>
              <tr className="border-t bg-muted/20 font-semibold">
                <td className="p-2" colSpan={6}>الرصيد الافتتاحي</td>
                <td className="p-2 text-left">{Number(stmt.opening).toFixed(2)}</td>
              </tr>
              {stmt.rows.length === 0 && (
                <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">لا توجد حركات في الفترة</td></tr>
              )}
              {stmt.rows.map((r, i) => (
                <tr key={i} className="border-t hover:bg-muted/30">
                  <td className="p-2">{r.date}</td>
                  <td className="p-2 font-mono">{r.docNumber}</td>
                  <td className="p-2">{r.type}</td>
                  <td className="p-2 text-muted-foreground">{r.description}</td>
                  <td className="p-2 text-left">{r.debit  ? Number(r.debit ).toFixed(2) : ""}</td>
                  <td className="p-2 text-left">{r.credit ? Number(r.credit).toFixed(2) : ""}</td>
                  <td className="p-2 text-left font-medium">{Number(r.balance).toFixed(2)}</td>
                </tr>
              ))}
              <tr className="border-t bg-muted/20 font-bold">
                <td className="p-2" colSpan={6}>الرصيد الختامي</td>
                <td className="p-2 text-left">{Number(stmt.closing).toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  );
}
