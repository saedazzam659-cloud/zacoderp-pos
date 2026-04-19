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
import { Plus, Search, Pencil, Trash2, BookOpen, ArrowUpDown, Calendar, CheckCircle2, FileText } from "lucide-react";

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
        <Button onClick={() => navigate("/accounting/journals/new")} className="gap-2">
          <Plus className="h-4 w-4" />
          قيد جديد
        </Button>
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
                      <tr key={entry.id} className="hover:bg-muted/20 transition-colors">
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
