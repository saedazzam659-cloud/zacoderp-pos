import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { FileText, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { sisterCompaniesApi } from "@/lib/sisterCompaniesApi";

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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <FileText className="h-5 w-5" /> كشف حساب — {sister?.nameAr ?? "…"}
        </h1>
        <Link href="/inventory/sister-companies">
          <Button variant="outline"><ArrowLeft className="h-4 w-4 ml-1" /> رجوع</Button>
        </Link>
      </div>

      <Card><CardContent className="flex flex-wrap gap-3 items-end pt-6">
        <label><span className="text-sm">من تاريخ</span>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label><span className="text-sm">إلى تاريخ</span>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
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
