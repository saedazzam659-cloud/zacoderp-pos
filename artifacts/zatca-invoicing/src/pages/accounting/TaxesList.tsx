import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Plus, Pencil, Trash2, Percent, Search, Star, ShieldCheck } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Tax = {
  id: number; companyId: number; code: string; nameAr: string; nameEn: string | null;
  rate: string; rateType: "percent" | "fixed"; currencyCode: string | null;
  branchId: number | null; costCenter: string | null;
  isActive: boolean; isDefault: boolean; isSystem: boolean; notes: string | null;
};

export default function TaxesList() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "inactive">("all");
  const [confirmDelId, setConfirmDelId] = useState<number | null>(null);

  const { data: taxes = [], isLoading } = useQuery<Tax[]>({
    queryKey: ["taxes", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/taxes${cid ? `?companyId=${cid}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return taxes.filter(tx => {
      if (filter === "active" && !tx.isActive) return false;
      if (filter === "inactive" && tx.isActive) return false;
      if (!q) return true;
      return tx.code.toLowerCase().includes(q)
        || tx.nameAr.toLowerCase().includes(q)
        || (tx.nameEn ?? "").toLowerCase().includes(q);
    });
  }, [taxes, search, filter]);

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/taxes/${id}`, { method: "DELETE", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "تعذّر حذف الضريبة");
      return d;
    },
    onSuccess: () => {
      toast({ title: "تم حذف الضريبة" });
      qc.invalidateQueries({ queryKey: ["taxes", cid] });
      setConfirmDelId(null);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const setDefaultMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/taxes/${id}/set-default`, { method: "POST", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "تعذّر تعيين الضريبة الافتراضية");
      return d;
    },
    onSuccess: () => {
      toast({ title: "تم تعيين الضريبة الافتراضية" });
      qc.invalidateQueries({ queryKey: ["taxes", cid] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const fmtRate = (tx: Tax) => tx.rateType === "fixed" ? `${tx.rate}` : `${tx.rate}%`;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-fuchsia-500 text-white shadow-md">
            <Percent className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">إدارة الضرائب</h1>
            <p className="text-sm text-muted-foreground">عرّف ضرائب ديناميكية تُطبَّق على المبيعات والمشتريات والقيود</p>
          </div>
        </div>
        <Button size="lg" onClick={() => navigate("/accounting/taxes/new")} className="gap-2 bg-gradient-to-l from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 shadow-md">
          <Plus className="h-5 w-5" /> ضريبة جديدة
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground right-3" />
          <Input placeholder="ابحث بالكود أو الاسم..." value={search} onChange={e => setSearch(e.target.value)} className="pr-9" />
        </div>
        <div className="flex items-center gap-1 border rounded-md p-1 bg-muted/30">
          {[
            { v: "all", l: "الكل" },
            { v: "active", l: "المفعّلة" },
            { v: "inactive", l: "المعطّلة" },
          ].map(o => (
            <button key={o.v} onClick={() => setFilter(o.v as any)}
              className={cn("px-3 py-1.5 text-xs rounded transition-all", filter === o.v ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-muted/50")}>
              {o.l}
            </button>
          ))}
        </div>
        <Badge variant="secondary" className="text-xs">{`الإجمالي: ${taxes.length}`}</Badge>
      </div>

      {/* List */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-6 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : taxes.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground text-sm">
            <Percent className="h-12 w-12 mx-auto mb-2 opacity-20" />
            <p className="font-semibold mb-1">لا توجد ضرائب بعد</p>
            <p className="text-xs">ابدأ بإضافة ضريبة جديدة</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">لا توجد نتائج مطابقة</div>
        ) : (
          <div className="divide-y">
            {filtered.map(tx => (
              <div key={tx.id} className="flex items-center gap-2 p-3 hover:bg-muted/30 transition-colors">
                <span className={cn("font-mono text-xs px-2 py-0.5 rounded border",
                  tx.isActive ? "bg-indigo-50 text-indigo-700 border-indigo-200" : "bg-gray-100 text-gray-500 border-gray-200")}>
                  {tx.code}
                </span>
                <div className="flex-1 min-w-0">
                  <div className={cn("text-sm font-medium truncate", !tx.isActive && "text-muted-foreground line-through")}>
                    {tx.nameAr}
                    {tx.nameEn && <span className="text-[11px] text-muted-foreground mx-2">— {tx.nameEn}</span>}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {tx.rateType === "fixed" ? "قيمة ثابتة" : "نسبة مئوية"}
                    {tx.currencyCode && <span className="mx-1">• {tx.currencyCode}</span>}
                  </div>
                </div>
                <span className="font-mono text-sm font-bold text-indigo-700 px-2">{fmtRate(tx)}</span>
                {tx.isSystem && <Badge variant="outline" className="text-[10px] h-5 bg-emerald-50 text-emerald-700 border-emerald-200 gap-1"><ShieldCheck className="h-3 w-3" /> زاتكا</Badge>}
                {tx.isDefault && <Badge variant="outline" className="text-[10px] h-5 bg-amber-50 text-amber-700 border-amber-200 gap-1"><Star className="h-3 w-3 fill-amber-500" /> افتراضية</Badge>}
                {!tx.isActive && <Badge variant="outline" className="text-[10px] h-5 bg-gray-50 text-gray-600 border-gray-200">معطّلة</Badge>}
                <div className="flex items-center gap-1">
                  {!tx.isDefault && (
                    <Button size="sm" variant="ghost" onClick={() => setDefaultMut.mutate(tx.id)} disabled={setDefaultMut.isPending}
                      className="h-7 px-2 text-[11px] text-amber-600 hover:text-amber-700 hover:bg-amber-50" title="تعيين كافتراضية">
                      <Star className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/accounting/taxes/${tx.id}`)} className="h-7 w-7 p-0" title="تعديل">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  {confirmDelId === tx.id ? (
                    <div className="flex items-center gap-1 bg-red-50 border border-red-300 rounded-md px-2 py-1">
                      <span className="text-[10px] text-red-700 font-medium">تأكيد؟</span>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelId(null)} className="h-6 px-2 text-[10px]">إلغاء</Button>
                      <Button size="sm" variant="destructive" onClick={() => delMut.mutate(tx.id)} disabled={delMut.isPending} className="h-6 px-2 text-[10px]">حذف</Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelId(tx.id)} disabled={tx.isSystem || tx.isDefault}
                      className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50 disabled:opacity-30" title={tx.isSystem ? "ضريبة النظام لا تُحذف" : tx.isDefault ? "الافتراضية لا تُحذف" : "حذف"}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
