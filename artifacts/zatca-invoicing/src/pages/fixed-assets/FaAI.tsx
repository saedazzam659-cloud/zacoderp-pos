import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Sparkles, Brain, AlertTriangle, Bell } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type AnalyzedAsset = {
  id: number; code: string; nameAr: string;
  score: number; level: "low"|"medium"|"high"; recommendation: string;
  remainingMonths: number; ageMonths: number;
  totalMaintenanceCost: number; bookValue: number;
};
type AlertItem = {
  insuranceAlerts: { id:number; code:string; nameAr:string; insuranceEnd:string|null; daysLeft:number }[];
  maintenanceAlerts: { id:number; code:string; nameAr:string; lastService:string|null; daysSinceLast:number }[];
};
type Forecast = { months: number; series: { period: string; depreciation: number }[] };

const RECOMMEND_LABEL: Record<string,string> = {
  keep: "احتفاظ", maintain: "صيانة", replace: "استبدال", sell: "بيع",
};
const RECOMMEND_BADGE: Record<string,string> = {
  keep:    "bg-emerald-100 text-emerald-800",
  maintain:"bg-amber-100 text-amber-800",
  replace: "bg-rose-100 text-rose-800",
  sell:    "bg-blue-100 text-blue-800",
};

export default function FaAI() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [advice, setAdvice] = useState<string | null>(null);
  const [aiOn,   setAiOn]   = useState<boolean | null>(null);

  const { data: alerts } = useQuery<AlertItem>({
    queryKey:["fa/alerts", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets-ai/alerts?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: forecast } = useQuery<Forecast>({
    queryKey:["fa/forecast", cid],
    queryFn: async () => (await fetch(`${API}/api/fixed-assets-ai/forecast?companyId=${cid}&months=12`, { headers })).json(),
    enabled: !!cid,
  });

  const analyzeMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/fixed-assets-ai/analyze-all`, { method:"POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify({ companyId: cid }) });
      if (!r.ok) throw new Error("فشل التحليل");
      return r.json() as Promise<{ analyzed: number; items: AnalyzedAsset[] }>;
    },
    onSuccess: (d) => {
      toast({ title: "تم التحليل", description: `تم تحليل ${d.analyzed} أصل` });
      qc.invalidateQueries({ queryKey:["fa/assets", cid] });
    },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const adviceMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/fixed-assets-ai/advice`, { method:"POST",
        headers: { ...headers, "Content-Type":"application/json" }, body: JSON.stringify({ companyId: cid }) });
      if (!r.ok) throw new Error("فشل الطلب");
      return r.json() as Promise<{ ai: boolean; advice: string }>;
    },
    onSuccess: (d) => { setAdvice(d.advice); setAiOn(d.ai); },
    onError: (e:any) => toast({ title:"خطأ", description: e?.message, variant:"destructive" }),
  });

  const items = analyzeMut.data?.items ?? [];

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-pink-600" />
            التحليل الذكي للأصول
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            تقييم المخاطر، التوصيات، تنبيهات التأمين والصيانة الدورية، وتوقع الإهلاك
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button onClick={()=>analyzeMut.mutate()} disabled={analyzeMut.isPending} className="bg-pink-600 hover:bg-pink-700">
            <Brain className="h-4 w-4 ms-2" />
            {analyzeMut.isPending ? "جاري التحليل…" : "تحليل كل الأصول"}
          </Button>
          <Button variant="outline" onClick={()=>adviceMut.mutate()} disabled={adviceMut.isPending}>
            <Sparkles className="h-4 w-4 ms-2" />
            {adviceMut.isPending ? "…" : "نصيحة ذكية"}
          </Button>
        </div>
      </div>

      {advice && (
        <div className="border-2 border-pink-300 rounded-lg p-4 bg-gradient-to-l from-pink-50 to-white">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="h-4 w-4 text-pink-600" />
            <span className="font-semibold text-pink-800">نصيحة المساعد الذكي</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${aiOn ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
              {aiOn ? "AI" : "rule-based"}
            </span>
          </div>
          <div className="text-sm leading-relaxed whitespace-pre-line">{advice}</div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border rounded-lg bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-2 border-b bg-amber-50 text-sm font-semibold text-amber-800 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            انتهاء وثائق التأمين القريبة
          </div>
          <div className="p-3">
            {!alerts?.insuranceAlerts.length && <div className="text-center text-muted-foreground py-4">لا توجد تنبيهات</div>}
            {alerts?.insuranceAlerts.map(a => (
              <div key={a.id} className={`flex items-center justify-between border-b py-2 text-sm ${a.daysLeft < 0 ? "text-rose-700" : a.daysLeft < 14 ? "text-amber-700" : ""}`}>
                <div>
                  <div className="font-semibold">{a.code} — {a.nameAr}</div>
                  <div className="text-xs text-muted-foreground">ينتهي: {a.insuranceEnd}</div>
                </div>
                <div className="font-mono font-bold">
                  {a.daysLeft < 0 ? `منتهية منذ ${Math.abs(a.daysLeft)} يوم` : `${a.daysLeft} يوم`}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="border rounded-lg bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-2 border-b bg-orange-50 text-sm font-semibold text-orange-800 flex items-center gap-2">
            <Bell className="h-4 w-4" />
            تنبيهات صيانة دورية متأخرة
          </div>
          <div className="p-3">
            {!alerts?.maintenanceAlerts.length && <div className="text-center text-muted-foreground py-4">لا توجد تنبيهات</div>}
            {alerts?.maintenanceAlerts.map(a => (
              <div key={a.id} className="flex items-center justify-between border-b py-2 text-sm">
                <div>
                  <div className="font-semibold">{a.code} — {a.nameAr}</div>
                  <div className="text-xs text-muted-foreground">آخر صيانة: {a.lastService || "—"}</div>
                </div>
                <div className="font-mono font-bold text-orange-700">
                  {a.daysSinceLast >= 9999 ? "بدون سجل" : `${a.daysSinceLast} يوم`}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {forecast?.series && forecast.series.length > 0 && (
        <div className="border rounded-lg bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-2 border-b bg-violet-50 text-sm font-semibold text-violet-800">
            توقع الإهلاك للـ {forecast.months} شهر القادمة
          </div>
          <div className="overflow-x-auto p-3">
            <div className="flex items-end gap-2 h-40">
              {forecast.series.map((s, i) => {
                const max = Math.max(...forecast.series.map(x => x.depreciation), 1);
                const h = (s.depreciation / max) * 100;
                return (
                  <div key={i} className="flex-1 flex flex-col items-center min-w-[40px]">
                    <div className="text-[10px] text-violet-700 mb-1">{Math.round(s.depreciation).toLocaleString("ar-EG")}</div>
                    <div className="w-full bg-violet-500 rounded-t" style={{ height: `${h}%`, minHeight: "4px" }} />
                    <div className="text-[10px] text-muted-foreground mt-1">{s.period}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="border rounded-lg bg-white overflow-hidden shadow-sm">
          <div className="px-4 py-2 border-b bg-pink-50 text-sm font-semibold text-pink-800">
            نتائج التحليل ({items.length} أصل) — مرتبة من الأعلى مخاطرة
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs" dir="rtl">
              <thead className="bg-gradient-to-b from-pink-50 to-pink-100 text-pink-900 border-b">
                <tr>
                  <th className="px-3 py-2 text-start font-semibold">الكود</th>
                  <th className="px-3 py-2 text-start font-semibold">الاسم</th>
                  <th className="px-3 py-2 text-start font-semibold">عمر (شهر)</th>
                  <th className="px-3 py-2 text-start font-semibold">متبقي (شهر)</th>
                  <th className="px-3 py-2 text-start font-semibold">تكلفة الصيانة</th>
                  <th className="px-3 py-2 text-start font-semibold">الدفترية</th>
                  <th className="px-3 py-2 text-start font-semibold">المخاطرة</th>
                  <th className="px-3 py-2 text-start font-semibold">التوصية</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map(it => (
                  <tr key={it.id} className="hover:bg-pink-50/40">
                    <td className="px-3 py-2 font-mono">{it.code}</td>
                    <td className="px-3 py-2 font-semibold">{it.nameAr}</td>
                    <td className="px-3 py-2 font-mono">{it.ageMonths}</td>
                    <td className="px-3 py-2 font-mono">{it.remainingMonths}</td>
                    <td className="px-3 py-2 font-mono">{it.totalMaintenanceCost.toLocaleString("ar-EG")}</td>
                    <td className="px-3 py-2 font-mono">{it.bookValue.toLocaleString("ar-EG")}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold font-mono">{it.score}</span>
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          it.level === "high" ? "bg-rose-100 text-rose-800"
                          : it.level === "medium" ? "bg-amber-100 text-amber-800"
                          : "bg-emerald-100 text-emerald-800"
                        }`}>
                          {it.level === "high" ? "عالية" : it.level === "medium" ? "متوسطة" : "منخفضة"}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${RECOMMEND_BADGE[it.recommendation]}`}>
                        {RECOMMEND_LABEL[it.recommendation] || it.recommendation}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
