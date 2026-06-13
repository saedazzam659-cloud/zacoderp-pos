import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, ArrowRightLeft, Send, Trash2, CheckCircle2, Printer, FileSpreadsheet, FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { sisterCompaniesApi } from "@/lib/sisterCompaniesApi";
import { exportToExcel, exportToPDF, type ExportColumn } from "@/lib/export";

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  draft:     { label: "مسودة",   color: "bg-amber-50 text-amber-700" },
  posted:    { label: "مُرحَّل",  color: "bg-green-50 text-green-700" },
  cancelled: { label: "ملغي",    color: "bg-red-50 text-red-600" },
};

export default function SisterTransfers() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: transfers = [], isLoading } = useQuery({
    queryKey: ["sister-transfers"], queryFn: () => sisterCompaniesApi.listTransfers(),
  });
  const { data: sisters = [] } = useQuery({
    queryKey: ["sister-companies"], queryFn: () => sisterCompaniesApi.list(),
  });
  const sisterMap = Object.fromEntries((sisters as any[]).map(s => [s.id, s.nameAr]));

  const postMut = useMutation({
    mutationFn: (id: number) => sisterCompaniesApi.postTransfer(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sister-transfers"] });
      toast({ title: "تم الترحيل وإنشاء القيد" }); },
    onError: (e: any) => toast({ title: "تعذّر الترحيل", description: String(e?.message || e), variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: number) => sisterCompaniesApi.deleteTransfer(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sister-transfers"] });
      toast({ title: "تم الحذف" }); },
    onError: (e: any) => toast({ title: "تعذّر الحذف", description: String(e?.message || e), variant: "destructive" }),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <ArrowRightLeft className="h-5 w-5" /> تحويلات الشركات الشقيقة
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          {(() => {
            const cols: ExportColumn[] = [
              { header: "رقم", key: "transferNumber", width: 14 },
              { header: "رقم القيد", key: "journalEntryNumber", width: 14 },
              { header: "التاريخ", key: "transferDate", width: 14 },
              { header: "الشركة الشقيقة", key: "sister", width: 28 },
              { header: "تكلفة", key: "totalCost", width: 14 },
              { header: "قيمة التوريد", key: "totalSupply", width: 14 },
              { header: "الحالة", key: "status", width: 10 },
            ];
            const data = (transfers as any[]).map((t: any) => ({
              transferNumber: t.transferNumber,
              journalEntryNumber: t.journalEntryNumber ?? "",
              transferDate: t.transferDate,
              sister: sisterMap[t.sisterCompanyId] ?? `#${t.sisterCompanyId}`,
              totalCost: Number(t.totalCost).toFixed(2),
              totalSupply: Number(t.totalSupply).toFixed(2),
              status: (STATUS_LABEL[t.status] ?? { label: t.status }).label,
            }));
            const totals = data.length ? {
              transferNumber: "الإجمالي",
              totalCost: (transfers as any[]).reduce((s: number, t: any) => s + Number(t.totalCost || 0), 0).toFixed(2),
              totalSupply: (transfers as any[]).reduce((s: number, t: any) => s + Number(t.totalSupply || 0), 0).toFixed(2),
            } : null;
            return (
              <>
                <Button variant="outline" size="sm" onClick={() => window.print()} data-testid="btn-print">
                  <Printer className="h-4 w-4 ml-1" /> طباعة
                </Button>
                <Button variant="outline" size="sm" disabled={data.length === 0}
                  onClick={() => exportToExcel(data, cols, "sister-transfers", "تحويلات الشركات الشقيقة", totals)}
                  data-testid="btn-export-excel">
                  <FileSpreadsheet className="h-4 w-4 ml-1" /> Excel
                </Button>
                <Button variant="outline" size="sm" disabled={data.length === 0}
                  onClick={() => exportToPDF(data, cols, "sister-transfers", "تحويلات الشركات الشقيقة", undefined, true, totals)}
                  data-testid="btn-export-pdf">
                  <FileDown className="h-4 w-4 ml-1" /> PDF
                </Button>
              </>
            );
          })()}
          <Link href="/inventory/sister-transfers/new">
            <Button data-testid="btn-new-transfer"><Plus className="h-4 w-4 ml-1" /> تحويل جديد</Button>
          </Link>
        </div>
      </div>

      <Card><CardContent className="p-0 overflow-x-auto">
        {isLoading ? <div className="p-4"><Skeleton className="h-32" /></div> : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-right">رقم</th>
                <th className="p-2 text-right">رقم القيد</th>
                <th className="p-2 text-right">التاريخ</th>
                <th className="p-2 text-right">الشركة الشقيقة</th>
                <th className="p-2 text-right">تكلفة</th>
                <th className="p-2 text-right">قيمة التوريد</th>
                <th className="p-2 text-right">الحالة</th>
                <th className="p-2 text-right">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {(transfers as any[]).length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">لا توجد تحويلات</td></tr>
              )}
              {(transfers as any[]).map((t: any) => {
                const st = STATUS_LABEL[t.status] ?? { label: t.status, color: "" };
                return (
                  <tr key={t.id} className="border-t hover:bg-muted/30">
                    <td className="p-2 font-mono">{t.transferNumber}</td>
                    <td className="p-2 font-mono">
                      {t.journalEntryId ? (
                        <Link href={`/accounting/journals/${t.journalEntryId}`}
                          className="text-primary hover:underline" title="عرض القيد">
                          {t.journalEntryNumber ?? `#${t.journalEntryId}`}
                        </Link>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="p-2">{t.transferDate}</td>
                    <td className="p-2">{sisterMap[t.sisterCompanyId] ?? `#${t.sisterCompanyId}`}</td>
                    <td className="p-2 text-left">{Number(t.totalCost).toFixed(2)}</td>
                    <td className="p-2 text-left">{Number(t.totalSupply).toFixed(2)}</td>
                    <td className="p-2"><span className={`px-2 py-0.5 rounded text-xs ${st.color}`}>{st.label}</span></td>
                    <td className="p-2 flex gap-1">
                      {t.status === "draft" && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => postMut.mutate(t.id)} title="ترحيل" disabled={postMut.isPending}>
                            <Send className="h-3 w-3" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => { if (confirm("حذف؟")) delMut.mutate(t.id); }} title="حذف">
                            <Trash2 className="h-3 w-3 text-red-600" />
                          </Button>
                        </>
                      )}
                      {t.status === "posted" && (
                        <Link href={`/inventory/sister-returns/new?transferId=${t.id}`}>
                          <Button size="sm" variant="ghost" title="إنشاء مرتجع">
                            <CheckCircle2 className="h-3 w-3 text-blue-600" /> مرتجع
                          </Button>
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  );
}
