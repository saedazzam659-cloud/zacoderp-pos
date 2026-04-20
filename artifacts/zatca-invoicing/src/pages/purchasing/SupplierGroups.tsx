import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Plus, Pencil, Trash2, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const EMPTY = { code: "", nameAr: "", nameEn: "", discountPercent: "0", notes: "", isActive: true };

export default function SupplierGroups() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [form, setForm]       = useState<any>(EMPTY);
  const [editId, setEditId]   = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data: groups = [], isLoading } = useQuery<any[]>({
    queryKey: ["supplier-groups", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/purchasing/supplier-groups?companyId=${cid}` : `${API}/api/purchasing/supplier-groups`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    },
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["supplier-groups"] });

  const createMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`${API}/api/purchasing/supplier-groups`, { method: "POST", headers, body: JSON.stringify({ ...data, companyId: cid }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      return j;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: "✓ تم حفظ المجموعة" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, data }: any) => {
      const res = await fetch(`${API}/api/purchasing/supplier-groups/${id}`, { method: "PUT", headers, body: JSON.stringify(data) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      return j;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: "✓ تم التعديل" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/supplier-groups/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: "✓ تم الحذف" }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); }

  function handleEdit(g: any) {
    setForm({ ...g, discountPercent: String(g.discountPercent ?? "0") });
    setEditId(g.id); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editId) updateMut.mutate({ id: editId, data: form });
    else createMut.mutate(form);
  }

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />مجموعات الموردين
          </h1>
          <p className="text-sm text-muted-foreground mt-1">تصنيف الموردين ونسب الخصم المكتسب</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />مجموعة جديدة
        </Button>
      </div>

      {showForm && (
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">{editId ? "تعديل المجموعة" : "مجموعة جديدة"}</h2>
            <Button variant="ghost" size="icon" onClick={reset}><X className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <Label>الكود *</Label>
                <Input placeholder="SG001" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} required />
              </div>
              <div className="space-y-1.5">
                <Label>الاسم العربي *</Label>
                <Input placeholder="موردو المواد الخام" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} required />
              </div>
              <div className="space-y-1.5">
                <Label>الاسم الإنجليزي</Label>
                <Input placeholder="Raw Material Suppliers" dir="ltr" value={form.nameEn ?? ""} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>نسبة الخصم المكتسب (%)</Label>
                <Input type="text" inputMode="decimal" placeholder="0.00" value={form.discountPercent} onChange={e => setForm((p: any) => ({ ...p, discountPercent: e.target.value.replace(/[^0-9.]/g, "") }))} />
              </div>
              <div className="space-y-1.5">
                <Label>ملاحظات</Label>
                <Input placeholder="اختياري" value={form.notes ?? ""} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <Switch checked={form.isActive} onCheckedChange={v => setForm((p: any) => ({ ...p, isActive: v }))} />
                <Label>نشط</Label>
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-2 border-t">
              <Button type="button" variant="outline" onClick={reset}>إلغاء</Button>
              <Button type="submit" disabled={createMut.isPending || updateMut.isPending}>
                {editId ? "حفظ التعديل" : "إضافة المجموعة"}
              </Button>
            </div>
          </form>
        </div>
      )}

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground text-sm">جاري التحميل...</div>
        ) : groups.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground text-sm">لا توجد مجموعات بعد</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground">الكود</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground">الاسم</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground">الاسم (EN)</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground">نسبة الخصم</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground">الحالة</th>
                <th className="text-right px-4 py-3 font-semibold text-muted-foreground">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <tr key={g.id} className="border-b hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs text-primary">{g.code}</td>
                  <td className="px-4 py-2.5 font-medium">{g.nameAr}</td>
                  <td className="px-4 py-2.5 text-muted-foreground dir-ltr">{g.nameEn ?? "—"}</td>
                  <td className="px-4 py-2.5">{Number(g.discountPercent || 0).toFixed(2)}%</td>
                  <td className="px-4 py-2.5">
                    <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border",
                      g.isActive ? "bg-green-50 text-green-700 border-green-200" : "bg-muted text-muted-foreground border-border"
                    )}>
                      {g.isActive ? "نشط" : "موقوف"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEdit(g)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => { if (confirm("حذف المجموعة؟")) deleteMut.mutate(g.id); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
