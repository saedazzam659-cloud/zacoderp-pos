import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { TrendingUp, PlayCircle } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Preview = {
  id: number; code: string; nameAr: string;
  purchaseValue: number; scrapValue: number;
  accumulatedDepreciation: number; bookValue: number;
  monthlyDepreciation: number; applicable: number;
};
type Run = {
  id: number; assetId: number; periodMonth: number; periodYear: number;
  depreciationAmount: string; bookValueBefore: string; bookValueAfter: string;
  postedBy: string | null; postedAt: string;
};

export default function FaDepreciation() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const now = new Date();
  const [period, setPeriod] = useState({ month: now.getMonth() + 1, year: now.getFullYear() });

  const { data: preview = [], isLoading } = useQuery<Preview[]>({
    queryKey:["fa/dep-preview", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/depreciation/preview?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: runs = [] } = useQuery<Run[]>({
    queryKey:["fa/dep-runs", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets/depreciation/runs?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });

  const totalMonthly = preview.reduce((s,p)=>s+p.applicable, 0);
  const totalAccum   = preview.reduce((s,p)=>s+p.accumulatedDepreciation, 0);
  const totalBook    = preview.reduce((s,p)=>s+p.bookValue, 0);

  const postMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/fixed-assets/depreciation/post`, { method:"POST",
        headers: { ...headers, "Content-Type":"application/json" },
        body: JSON.stringify({ companyId: cid, periodMonth: period.month, periodYear: period.year }) });
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw new Error(j.error || "فشل الترحيل"); }
      return r.json();
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey:["fa/dep-preview", cid] });
      qc.invalidateQueries({ queryKey:["fa/dep-runs", cid] });
      qc.invalidateQueries({ queryKey:["fa/assets", cid] });
      toast({ title: "تم الترحيل", description: `تم ترحيل إهلاك ${d.posted} أصل لشهر ${period.month}/${period.year}` });
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-violet-600" />
            إهلاك الأصول الثابتة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            عرض الإهلاك المتوقع لكل أصل وترحيله شهرياً
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select className="h-10 px-3 rounded-md border border-input bg-background text-sm"
            value={period.month} onChange={(e)=>setPeriod({...period, month: Number(e.target.value)})}>
            {Array.from({length:12}, (_,i)=>i+1).map(m =>
              <option key={m} value={m}>{m.toString().padStart(2,"0")}</option>)}
          </select>
          <select className="h-10 px-3 rounded-md border border-input bg-background text-sm"
            value={period.year} onChange={(e)=>setPeriod({...period, year: Number(e.target.value)})}>
            {Array.from({length:6}, (_,i)=>now.getFullYear()-3+i).map(y =>
              <option key={y} value={y}>{y}</option>)}
          </select>
          <Button onClick={()=>postMut.mutate()} disabled={postMut.isPending} className="bg-violet-600 hover:bg-violet-700">
            <PlayCircle className="h-4 w-4 ms-2" />
            {postMut.isPending ? "جاري الترحيل…" : "ترحيل الإهلاك الشهري"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="border rounded-lg p-4 bg-emerald-50">
          <div className="text-xs text-emerald-700">إجمالي الإهلاك الشهري</div>
          <div className="text-xl font-bold mt-1 text-emerald-800 font-mono">
            {totalMonthly.toLocaleString("ar-EG", { maximumFractionDigits: 2 })} ر.س
          </div>
        </div>
        <div className="border rounded-lg p-4 bg-amber-50">
          <div className="text-xs text-amber-700">إجمالي الإهلاك المتراكم</div>
          <div className="text-xl font-bold mt-1 text-amber-800 font-mono">
            {totalAccum.toLocaleString("ar-EG", { maximumFractionDigits: 2 })} ر.س
          </div>
        </div>
        <div className="border rounded-lg p-4 bg-violet-50">
          <div className="text-xs text-violet-700">إجمالي القيمة الدفترية</div>
          <div className="text-xl font-bold mt-1 text-violet-800 font-mono">
            {totalBook.toLocaleString("ar-EG", { maximumFractionDigits: 2 })} ر.س
          </div>
        </div>
      </div>

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="px-4 py-2 border-b bg-violet-50 text-sm font-semibold text-violet-800">
          الإهلاك المتوقع للأصول النشطة
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-gradient-to-b from-violet-50 to-violet-100 text-violet-900 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">الكود</th>
                <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                <th className="px-3 py-2 text-start font-semibold">قيمة الشراء</th>
                <th className="px-3 py-2 text-start font-semibold">قيمة الخردة</th>
                <th className="px-3 py-2 text-start font-semibold">المتراكم</th>
                <th className="px-3 py-2 text-start font-semibold">الدفترية</th>
                <th className="px-3 py-2 text-start font-semibold">الإهلاك الشهري</th>
                <th className="px-3 py-2 text-start font-semibold">المطبق</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">جاري التحميل…</td></tr>}
              {!isLoading && preview.length===0 && <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">لا توجد أصول نشطة</td></tr>}
              {preview.map(p => (
                <tr key={p.id} className="hover:bg-violet-50/40">
                  <td className="px-3 py-2 font-mono">{p.code}</td>
                  <td className="px-3 py-2 font-semibold">{p.nameAr}</td>
                  <td className="px-3 py-2 font-mono">{p.purchaseValue.toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-2 font-mono">{p.scrapValue.toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-2 font-mono text-amber-700">{p.accumulatedDepreciation.toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-2 font-mono text-emerald-700">{p.bookValue.toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-2 font-mono">{p.monthlyDepreciation.toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-2 font-mono text-violet-700 font-bold">{p.applicable.toLocaleString("ar-EG")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
        <div className="px-4 py-2 border-b bg-slate-50 text-sm font-semibold text-slate-800">
          سجل ترحيل الإهلاك ({runs.length})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-slate-50 text-slate-800 border-b">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">رقم</th>
                <th className="px-3 py-2 text-start font-semibold">رقم الأصل</th>
                <th className="px-3 py-2 text-start font-semibold">الفترة</th>
                <th className="px-3 py-2 text-start font-semibold">قيمة الإهلاك</th>
                <th className="px-3 py-2 text-start font-semibold">قبل</th>
                <th className="px-3 py-2 text-start font-semibold">بعد</th>
                <th className="px-3 py-2 text-start font-semibold">المرحّل بواسطة</th>
                <th className="px-3 py-2 text-start font-semibold">التاريخ</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {runs.length===0 && <tr><td colSpan={8} className="text-center py-6 text-muted-foreground">لا توجد ترحيلات سابقة</td></tr>}
              {runs.slice(0, 50).map(r => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-3 py-1.5 font-mono">{r.id}</td>
                  <td className="px-3 py-1.5 font-mono">{r.assetId}</td>
                  <td className="px-3 py-1.5 font-mono">{r.periodMonth}/{r.periodYear}</td>
                  <td className="px-3 py-1.5 font-mono text-violet-700">{Number(r.depreciationAmount).toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-1.5 font-mono">{Number(r.bookValueBefore).toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-1.5 font-mono">{Number(r.bookValueAfter).toLocaleString("ar-EG")}</td>
                  <td className="px-3 py-1.5">{r.postedBy || "—"}</td>
                  <td className="px-3 py-1.5 font-mono">{r.postedAt?.slice(0,10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
