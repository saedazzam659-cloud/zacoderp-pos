import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { journalEntriesApi } from "@/lib/journalEntriesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Search, Pencil, Trash2, BookOpen, ArrowUpDown, Calendar, CheckCircle2, FileText, Printer, FileSpreadsheet, FileDown } from "lucide-react";
import * as XLSX from "xlsx";

const ENTRY_TYPES: Record<string, string> = {
  general:     "قيد عام",
  opening:     "قيد افتتاحي",
  closing:     "قيد إقفال",
  adjustment:  "قيد تسوية",
  depreciation:"قيد إهلاك",
};
const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  draft:   { label: "مسودة", cls: "bg-yellow-50 text-yellow-700 border-yellow-200" },
  posted:  { label: "مرحّل",  cls: "bg-green-50 text-green-700 border-green-200" },
  voided:  { label: "ملغي",   cls: "bg-red-50 text-red-700 border-red-200" },
};

export default function JournalEntries() {
  const { user } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const [search, setSearch] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: entries = [], isLoading } = useQuery<any[]>({
    queryKey: ["journal-entries", cid],
    queryFn: () => journalEntriesApi.list(cid),
    enabled: !!user,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => journalEntriesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-entries", cid] });
      setDeleteId(null);
    },
  });

  const filtered = entries.filter(e =>
    !search ||
    e.docNumber?.includes(search) ||
    e.description?.includes(search) ||
    e.entryDate?.includes(search)
  );

  const totalDebit  = entries.reduce((s: number, e: any) => s + Number(e.totalDebit  ?? 0), 0);
  const totalCredit = entries.reduce((s: number, e: any) => s + Number(e.totalCredit ?? 0), 0);

  const buildRows = () => filtered.map((e: any) => ({
    "رقم المستند": e.docNumber ?? `QYD-${String(e.id).padStart(4, "0")}`,
    "التاريخ":   e.entryDate ?? "",
    "النوع":     ENTRY_TYPES[e.entryType] ?? e.entryType ?? "",
    "البيان":    e.description ?? "",
    "المدين":    Number(e.totalDebit  ?? 0).toFixed(2),
    "الدائن":    Number(e.totalCredit ?? 0).toFixed(2),
    "الحالة":    (STATUS_MAP[e.status] ?? STATUS_MAP.posted).label,
  }));

  const handleExportExcel = () => {
    const rows = buildRows();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 32 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "القيود المحاسبية");
    XLSX.writeFile(wb, `journal-entries-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const escapeHtml = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

  const buildPrintHtml = () => {
    const rows = buildRows();
    const cols = Object.keys(rows[0] ?? { "رقم المستند": "", "التاريخ": "", "النوع": "", "البيان": "", "المدين": "", "الدائن": "", "الحالة": "" });
    const today = new Date().toLocaleDateString("ar-SA");
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>القيود المحاسبية</title>
<style>
@page { size: A4 landscape; margin: 12mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; padding:0; }
.h { text-align:center; margin-bottom:8px; }
.h h1 { margin:0 0 4px; font-size:18px; }
.h .meta { font-size:11px; color:#555; }
.totals { display:flex; gap:16px; justify-content:center; margin:8px 0 12px; font-size:12px; }
.totals span b { color:#1e3a8a; }
table { width:100%; border-collapse:collapse; font-size:11px; }
thead th { background:#1e3a8a; color:#fff; padding:6px 8px; border:1px solid #1e3a8a; text-align:right; font-weight:600; }
tbody td { padding:5px 8px; border:1px solid #d1d5db; text-align:right; }
tbody tr:nth-child(even) td { background:#f5f7fb; }
.num { font-family: "Consolas",monospace; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة / حفظ PDF</button>
<div class="h">
  <h1>القيود المحاسبية</h1>
  <div class="meta">تاريخ التقرير: ${today} — عدد القيود: ${rows.length}</div>
</div>
<div class="totals">
  <span>إجمالي المدين: <b>${totalDebit.toFixed(2)}</b></span>
  <span>إجمالي الدائن: <b>${totalCredit.toFixed(2)}</b></span>
</div>
<table>
  <thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
  <tbody>
    ${rows.map(r => `<tr>${cols.map(c => {
      const isNum = c === "المدين" || c === "الدائن";
      return `<td class="${isNum ? "num" : ""}">${escapeHtml((r as any)[c])}</td>`;
    }).join("")}</tr>`).join("")}
  </tbody>
</table>
<script>setTimeout(()=>window.print(),300);</script>
</body></html>`;
  };

  const openPrintWindow = (html: string) => {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) return;
    w.document.open(); w.document.write(html); w.document.close();
  };

  const handleExportPDF = () => openPrintWindow(buildPrintHtml());
  const handlePrint    = () => openPrintWindow(buildPrintHtml());

  return (
    <div className="p-6 space-y-5" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <BookOpen className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">القيود المحاسبية</h1>
            <p className="text-xs text-muted-foreground">إدارة قيود اليومية والتسويات</p>
          </div>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <Button variant="outline" size="sm" onClick={handlePrint} className="gap-1.5">
            <Printer className="h-4 w-4" /> طباعة
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportExcel} className="gap-1.5 text-green-700 border-green-200 hover:bg-green-50">
            <FileSpreadsheet className="h-4 w-4" /> Excel
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportPDF} className="gap-1.5 text-red-700 border-red-200 hover:bg-red-50">
            <FileDown className="h-4 w-4" /> PDF
          </Button>
          <Button onClick={() => navigate("/accounting/journals/new")} className="gap-2">
            <Plus className="h-4 w-4" />
            قيد جديد
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="border-2">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <FileText className="h-8 w-8 text-blue-500 bg-blue-50 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">إجمالي القيود</p>
                <p className="text-2xl font-bold text-foreground">{entries.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-2">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <ArrowUpDown className="h-8 w-8 text-green-500 bg-green-50 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">إجمالي المدين</p>
                <p className="text-2xl font-bold text-green-600">{totalDebit.toFixed(2)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-2">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-8 w-8 text-purple-500 bg-purple-50 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">إجمالي الدائن</p>
                <p className="text-2xl font-bold text-purple-600">{totalCredit.toFixed(2)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="ابحث برقم المستند أو البيان أو التاريخ..."
              className="pr-9"
            />
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            سجل القيود ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-16 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <BookOpen className="h-10 w-10 text-muted-foreground/30 mx-auto" />
              <p className="text-muted-foreground text-sm">لا توجد قيود محاسبية</p>
              <Button variant="outline" size="sm" onClick={() => navigate("/accounting/journals/new")}>
                <Plus className="h-3.5 w-3.5 ml-1" />
                إنشاء أول قيد
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30 text-muted-foreground">
                    <th className="px-4 py-2.5 text-right font-medium">رقم المستند</th>
                    <th className="px-4 py-2.5 text-right font-medium">التاريخ</th>
                    <th className="px-4 py-2.5 text-right font-medium">النوع</th>
                    <th className="px-4 py-2.5 text-right font-medium">البيان</th>
                    <th className="px-4 py-2.5 text-right font-medium">المدين</th>
                    <th className="px-4 py-2.5 text-right font-medium">الدائن</th>
                    <th className="px-4 py-2.5 text-right font-medium">الحالة</th>
                    <th className="px-4 py-2.5 text-center font-medium">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((entry: any) => {
                    const st = STATUS_MAP[entry.status] ?? STATUS_MAP.posted;
                    return (
                      <tr
                        key={entry.id}
                        className="hover:bg-muted/20 transition-colors cursor-pointer"
                        onDoubleClick={() => navigate(`/accounting/journals/${entry.id}?tab=lines`)}
                        title="انقر مرتين لعرض سطور القيد"
                      >
                        <td className="px-4 py-3 font-mono text-xs font-semibold text-primary">
                          {entry.docNumber ?? `QYD-${String(entry.id).padStart(4, "0")}`}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground flex items-center gap-1.5">
                          <Calendar className="h-3.5 w-3.5" />
                          {entry.entryDate}
                        </td>
                        <td className="px-4 py-3 text-xs">{ENTRY_TYPES[entry.entryType] ?? entry.entryType}</td>
                        <td className="px-4 py-3 text-muted-foreground max-w-[200px] truncate">{entry.description ?? "—"}</td>
                        <td className="px-4 py-3 font-mono text-green-700 font-medium">
                          {Number(entry.totalDebit ?? 0).toFixed(2)}
                        </td>
                        <td className="px-4 py-3 font-mono text-red-700 font-medium">
                          {Number(entry.totalCredit ?? 0).toFixed(2)}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={`text-[10px] ${st.cls}`}>{st.label}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-primary"
                              onClick={() => navigate(`/accounting/journals/${entry.id}`)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleteId(entry.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد الحذف</AlertDialogTitle>
            <AlertDialogDescription>هل أنت متأكد من حذف هذا القيد؟ لا يمكن التراجع.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            >
              حذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
