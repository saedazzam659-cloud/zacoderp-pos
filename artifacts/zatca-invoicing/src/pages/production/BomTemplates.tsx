import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { Plus, Search, ListTree, Edit3, Trash2, Power, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

const API = import.meta.env.VITE_API_URL || "";

type Tmpl = {
  id: number;
  productItemId: number;
  productNameAr: string | null;
  productNameEn: string | null;
  nameAr: string;
  nameEn: string | null;
  outputQty: string;
  outputUnitCode: string;
  isActive: boolean;
  linesCount: number;
  updatedAt: string;
};

export default function BomTemplates() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<Tmpl[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");

  async function load() {
    setLoading(true);
    try {
      const url = `${API}/api/production/bom-templates${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (token) void load(); /* eslint-disable-next-line */ }, [token]);
  useEffect(() => {
    const id = setTimeout(() => { if (token) void load(); }, 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line
  }, [q]);

  async function toggleActive(t: Tmpl) {
    try {
      const r = await fetch(`${API}/api/production/bom-templates/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isActive: !t.isActive }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  async function remove(t: Tmpl) {
    if (!confirm(`حذف القالب "${t.nameAr}"؟`)) return;
    try {
      const r = await fetch(`${API}/api/production/bom-templates/${t.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast({ title: "✓ تم الحذف" });
      await load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    }
  }

  const list = useMemo(() => rows ?? [], [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 p-2 text-white shadow">
            <ListTree className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">قوالب قائمة المكوّنات (BOM)</h1>
            <p className="text-sm text-slate-500">
              عرّف مكوّنات كل منتج نهائي مرة واحدة، وستُسحب تلقائياً عند إنشاء أوامر الإنتاج.
            </p>
          </div>
        </div>
        <Link href="/production/bom-templates/new">
          <Button data-testid="btn-new-bom-template">
            <Plus className="h-4 w-4 me-1" />
            قالب جديد
          </Button>
        </Link>
      </div>

      <div className="flex items-center gap-2 max-w-md">
        <Search className="h-4 w-4 text-slate-400" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ابحث عن قالب أو منتج…"
          data-testid="input-search-bom"
        />
      </div>

      {loading && rows == null ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-slate-500">
          لا توجد قوالب بعد. اضغط <strong>«قالب جديد»</strong> لإنشاء أول قالب.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="p-2 text-start">المنتج النهائي</th>
                <th className="p-2 text-start">اسم القالب</th>
                <th className="p-2 text-center">الناتج</th>
                <th className="p-2 text-center">عدد المكوّنات</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-end">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {list.map(t => (
                <tr key={t.id} className="border-t hover:bg-slate-50">
                  <td className="p-2">{t.productNameAr || t.productNameEn || `#${t.productItemId}`}</td>
                  <td className="p-2 font-medium">{t.nameAr}</td>
                  <td className="p-2 text-center">{t.outputQty} {t.outputUnitCode}</td>
                  <td className="p-2 text-center">
                    <Badge variant="secondary">{t.linesCount}</Badge>
                  </td>
                  <td className="p-2 text-center">
                    {t.isActive
                      ? <Badge className="bg-emerald-100 text-emerald-700">نشط</Badge>
                      : <Badge className="bg-slate-200 text-slate-600">معطّل</Badge>}
                  </td>
                  <td className="p-2 text-end">
                    <div className="inline-flex gap-1">
                      <Link href={`/production/bom-templates/${t.id}`}>
                        <Button size="sm" variant="ghost" title="تعديل">
                          <Edit3 className="h-4 w-4" />
                        </Button>
                      </Link>
                      <Button size="sm" variant="ghost" onClick={() => toggleActive(t)} title={t.isActive ? "تعطيل" : "تنشيط"}>
                        {t.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(t)} title="حذف" className="text-red-600">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
