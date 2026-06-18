import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Plus, Pencil, Trash2, Building2, FileText, ArrowRightLeft, Wallet, Printer, FileSpreadsheet, FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { sisterCompaniesApi, type SisterCompany } from "@/lib/sisterCompaniesApi";
import { AccountCombobox } from "@/components/AccountCombobox";
import { useBranches } from "@/hooks/useBranches";
import { exportToExcel, exportToPDF, type ExportColumn } from "@/lib/export";

const EMPTY: Partial<SisterCompany> = {
  branchId: null,
  nameAr: "", nameEn: "", vatNumber: "", crNumber: "", phone: "", email: "",
  address: "", accountId: null, defaultCogsAccountId: null,
  defaultRevenueAccountId: null, defaultInventoryAccountId: null,
  notes: "", isActive: true,
};

export default function SisterCompanies() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Partial<SisterCompany>>(EMPTY);
  const { data: branches = [] } = useBranches();

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["sister-companies"],
    queryFn: () => sisterCompaniesApi.list(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sister-companies"] });

  const saveMut = useMutation({
    mutationFn: async (body: Partial<SisterCompany>) =>
      body.id ? sisterCompaniesApi.update(body.id, body) : sisterCompaniesApi.create(body),
    onSuccess: () => { invalidate(); setShowForm(false); setEditing(EMPTY);
      toast({ title: "تم الحفظ" }); },
    onError: (e: any) => toast({ title: "خطأ", description: String(e?.message || e), variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: number) => sisterCompaniesApi.remove(id),
    onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); },
    onError: (e: any) => toast({ title: "تعذّر الحذف", description: String(e?.message || e), variant: "destructive" }),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Building2 className="h-5 w-5" /> الشركات الشقيقة
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          {(() => {
            const cols: ExportColumn[] = [
              { header: "#", key: "n", width: 5 },
              { header: "الاسم", key: "nameAr", width: 30 },
              { header: "الاسم بالإنجليزية", key: "nameEn", width: 30 },
              { header: "الرقم الضريبي", key: "vatNumber", width: 18 },
              { header: "السجل التجاري", key: "crNumber", width: 18 },
              { header: "الهاتف", key: "phone", width: 16 },
              { header: "البريد الإلكتروني", key: "email", width: 24 },
              { header: "الحالة", key: "status", width: 10 },
            ];
            const data = (rows as any[]).map((r, i) => ({
              n: i + 1, nameAr: r.nameAr ?? "", nameEn: r.nameEn ?? "",
              vatNumber: r.vatNumber ?? "", crNumber: r.crNumber ?? "",
              phone: r.phone ?? "", email: r.email ?? "",
              status: r.isActive ? "نشطة" : "موقوفة",
            }));
            return (
              <>
                <Button variant="outline" size="sm" onClick={() => window.print()} data-testid="btn-print">
                  <Printer className="h-4 w-4 ml-1" /> طباعة
                </Button>
                <Button variant="outline" size="sm" disabled={data.length === 0}
                  onClick={() => exportToExcel(data, cols, "sister-companies", "الشركات الشقيقة")}
                  data-testid="btn-export-excel">
                  <FileSpreadsheet className="h-4 w-4 ml-1" /> Excel
                </Button>
                <Button variant="outline" size="sm" disabled={data.length === 0}
                  onClick={() => exportToPDF(data, cols, "sister-companies", "الشركات الشقيقة")}
                  data-testid="btn-export-pdf">
                  <FileDown className="h-4 w-4 ml-1" /> PDF
                </Button>
              </>
            );
          })()}
          <Button onClick={() => { setEditing(EMPTY); setShowForm(true); }} data-testid="btn-new-sister">
            <Plus className="h-4 w-4 ml-1" /> جديد
          </Button>
        </div>
      </div>

      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-base">
            {editing.id ? "تعديل شركة شقيقة" : "إضافة شركة شقيقة"}
          </CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block"><span className="text-sm">الاسم بالعربية *</span>
                <Input value={editing.nameAr ?? ""} onChange={e => setEditing(p => ({ ...p, nameAr: e.target.value }))} /></label>
              <label className="block"><span className="text-sm">الاسم بالإنجليزية</span>
                <Input value={editing.nameEn ?? ""} onChange={e => setEditing(p => ({ ...p, nameEn: e.target.value }))} /></label>
              <label className="block"><span className="text-sm">الرقم الضريبي</span>
                <Input value={editing.vatNumber ?? ""} onChange={e => setEditing(p => ({ ...p, vatNumber: e.target.value }))} /></label>
              <label className="block"><span className="text-sm">السجل التجاري</span>
                <Input value={editing.crNumber ?? ""} onChange={e => setEditing(p => ({ ...p, crNumber: e.target.value }))} /></label>
              <label className="block"><span className="text-sm">الهاتف</span>
                <Input value={editing.phone ?? ""} onChange={e => setEditing(p => ({ ...p, phone: e.target.value }))} /></label>
              <label className="block"><span className="text-sm">البريد الإلكتروني</span>
                <Input type="email" value={editing.email ?? ""} onChange={e => setEditing(p => ({ ...p, email: e.target.value }))} /></label>
              <label className="block"><span className="text-sm">الفرع</span>
                <select
                  className="w-full border rounded-md px-3 py-2 text-sm bg-card h-9"
                  value={editing.branchId != null ? String(editing.branchId) : ""}
                  onChange={e => setEditing(p => ({ ...p, branchId: e.target.value ? Number(e.target.value) : null }))}
                  data-testid="select-sister-branch"
                >
                  <option value="">بدون فرع</option>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
                </select>
              </label>
              <label className="block md:col-span-2"><span className="text-sm">العنوان</span>
                <Input value={editing.address ?? ""} onChange={e => setEditing(p => ({ ...p, address: e.target.value }))} /></label>
            </div>
            <div className="border-t pt-3 space-y-3">
              <div className="text-sm font-semibold text-muted-foreground">الحسابات المحاسبية الافتراضية</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div><span className="text-sm">حساب الذمم (AR)</span>
                  <AccountCombobox value={editing.accountId != null ? String(editing.accountId) : ""} onValueChange={(v: string) => setEditing(p => ({ ...p, accountId: v ? Number(v) : null }))} /></div>
                <div><span className="text-sm">تكلفة البضاعة المباعة (COGS)</span>
                  <AccountCombobox value={editing.defaultCogsAccountId != null ? String(editing.defaultCogsAccountId) : ""} onValueChange={(v: string) => setEditing(p => ({ ...p, defaultCogsAccountId: v ? Number(v) : null }))} /></div>
                <div><span className="text-sm">إيراد التوريد الداخلي</span>
                  <AccountCombobox value={editing.defaultRevenueAccountId != null ? String(editing.defaultRevenueAccountId) : ""} onValueChange={(v: string) => setEditing(p => ({ ...p, defaultRevenueAccountId: v ? Number(v) : null }))} /></div>
                <div><span className="text-sm">المخزون</span>
                  <AccountCombobox value={editing.defaultInventoryAccountId != null ? String(editing.defaultInventoryAccountId) : ""} onValueChange={(v: string) => setEditing(p => ({ ...p, defaultInventoryAccountId: v ? Number(v) : null }))} /></div>
              </div>
            </div>
            <label className="block"><span className="text-sm">ملاحظات</span>
              <Input value={editing.notes ?? ""} onChange={e => setEditing(p => ({ ...p, notes: e.target.value }))} /></label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editing.isActive ?? true} onChange={e => setEditing(p => ({ ...p, isActive: e.target.checked }))} /> نشطة
            </label>
            <div className="flex gap-2">
              <Button disabled={!editing.nameAr || saveMut.isPending} onClick={() => saveMut.mutate(editing)} data-testid="btn-save-sister">حفظ</Button>
              <Button variant="outline" onClick={() => { setShowForm(false); setEditing(EMPTY); }}>إلغاء</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-4 space-y-2"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
          ) : (
            <table className="w-full text-sm" data-testid="table-sisters">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-right">#</th>
                  <th className="p-2 text-right">الاسم</th>
                  <th className="p-2 text-right">الرقم الضريبي</th>
                  <th className="p-2 text-right">السجل</th>
                  <th className="p-2 text-right">الهاتف</th>
                  <th className="p-2 text-right">الحالة</th>
                  <th className="p-2 text-right">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">لا توجد شركات شقيقة بعد</td></tr>
                )}
                {rows.map((r: any, i: number) => (
                  <tr key={r.id} className="border-t hover:bg-muted/30"
                    onDoubleClick={() => { setEditing(r); setShowForm(true); }}>
                    <td className="p-2">{i + 1}</td>
                    <td className="p-2 font-medium">{r.nameAr} {r.nameEn && <span className="text-muted-foreground text-xs">({r.nameEn})</span>}</td>
                    <td className="p-2">{r.vatNumber ?? "—"}</td>
                    <td className="p-2">{r.crNumber ?? "—"}</td>
                    <td className="p-2">{r.phone ?? "—"}</td>
                    <td className="p-2">{r.isActive ? <span className="text-green-700">نشطة</span> : <span className="text-gray-500">موقوفة</span>}</td>
                    <td className="p-2 flex gap-1">
                      <Link href={`/inventory/sister-companies/${r.id}/statement`}>
                        <Button size="sm" variant="ghost" title="كشف حساب"><FileText className="h-4 w-4" /></Button>
                      </Link>
                      <Link href={`/inventory/sister-transfers/new?sisterId=${r.id}`}>
                        <Button size="sm" variant="ghost" title="تحويل"><ArrowRightLeft className="h-4 w-4" /></Button>
                      </Link>
                      <Link href={`/inventory/sister-settlements/new?sisterId=${r.id}`}>
                        <Button size="sm" variant="ghost" title="سند تسوية"><Wallet className="h-4 w-4" /></Button>
                      </Link>
                      <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setShowForm(true); }} title="تعديل"><Pencil className="h-4 w-4" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => { if (confirm(`حذف ${r.nameAr}؟`)) delMut.mutate(r.id); }} title="حذف"><Trash2 className="h-4 w-4 text-red-600" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
