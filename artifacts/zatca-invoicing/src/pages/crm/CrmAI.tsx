import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Sparkles, TrendingUp, AlertTriangle, Trophy, Flame } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type ScoredLead = { id: number; code: string; name: string; interestLevel: string; status: string; score: number; activitiesCount: number };
type Forecast = {
  pipelineValue: number; weightedValue: number; forecastNext30Days: number;
  winRate: number; won: number; lost: number;
  byStage: Record<string, { count: number; value: number }>;
};
type RepRow = { userId: string; opportunities: number; won: number; conversionRate: number; totalValue: number };
type Alerts = {
  staleLeads: { id: number; code: string; name: string; status: string; daysSilent: number }[];
  overdueOpps: { id: number; code: string; title: string; stage: string; expectedCloseDate: string | null }[];
};

const STAGE_LABEL: Record<string,string> = {
  prospecting:"استكشاف", qualification:"تأهيل", proposal:"عرض",
  negotiation:"تفاوض", closed_won:"فوز", closed_lost:"خسارة",
};

export default function CrmAI() {
  const { user, token } = useAuth() as any;
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const { data: scored } = useQuery<{ leads: ScoredLead[] }>({
    queryKey:["crm-ai/score", cid],
    queryFn: async () => (await fetch(`${API}/api/crm-ai/score-leads?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: forecast } = useQuery<Forecast>({
    queryKey:["crm-ai/forecast", cid],
    queryFn: async () => (await fetch(`${API}/api/crm-ai/forecast?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: reps } = useQuery<{ reps: RepRow[] }>({
    queryKey:["crm-ai/reps", cid],
    queryFn: async () => (await fetch(`${API}/api/crm-ai/rep-performance?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });
  const { data: alerts } = useQuery<Alerts>({
    queryKey:["crm-ai/alerts", cid],
    queryFn: async () => (await fetch(`${API}/api/crm-ai/alerts?companyId=${cid}`, { headers })).json(),
    enabled: !!cid,
  });

  const topLeads = (scored?.leads ?? []).slice(0, 10);

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center gap-2">
        <Sparkles className="h-6 w-6 text-pink-600" />
        <div>
          <h1 className="text-2xl font-bold">الذكاء الاصطناعي — CRM</h1>
          <p className="text-sm text-muted-foreground">تقييم الفرص، توقع المبيعات، أداء المندوبين، تنبيهات تلقائية</p>
        </div>
      </div>

      {/* Forecast cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="border rounded-lg p-3 bg-gradient-to-br from-indigo-50 to-white">
          <div className="text-[11px] text-indigo-700 font-semibold flex items-center gap-1">
            <TrendingUp className="h-3.5 w-3.5" /> قيمة خط الأنابيب
          </div>
          <div className="text-xl font-bold mt-1 font-mono">{Number(forecast?.pipelineValue ?? 0).toLocaleString("ar-EG")}</div>
          <div className="text-[10px] text-muted-foreground">ر.س</div>
        </div>
        <div className="border rounded-lg p-3 bg-gradient-to-br from-emerald-50 to-white">
          <div className="text-[11px] text-emerald-700 font-semibold">القيمة المرجّحة</div>
          <div className="text-xl font-bold mt-1 font-mono">{Number(forecast?.weightedValue ?? 0).toLocaleString("ar-EG")}</div>
          <div className="text-[10px] text-muted-foreground">ر.س (مرجّحة باحتمالية النجاح)</div>
        </div>
        <div className="border rounded-lg p-3 bg-gradient-to-br from-amber-50 to-white">
          <div className="text-[11px] text-amber-700 font-semibold">توقع 30 يوماً</div>
          <div className="text-xl font-bold mt-1 font-mono">{Number(forecast?.forecastNext30Days ?? 0).toLocaleString("ar-EG")}</div>
          <div className="text-[10px] text-muted-foreground">ر.س متوقع الإغلاق</div>
        </div>
        <div className="border rounded-lg p-3 bg-gradient-to-br from-rose-50 to-white">
          <div className="text-[11px] text-rose-700 font-semibold flex items-center gap-1">
            <Trophy className="h-3.5 w-3.5" /> نسبة الفوز
          </div>
          <div className="text-xl font-bold mt-1 font-mono">{forecast?.winRate ?? 0}%</div>
          <div className="text-[10px] text-muted-foreground">{forecast?.won ?? 0} فوز / {forecast?.lost ?? 0} خسارة</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Top scored leads */}
        <div className="border rounded-lg bg-white shadow-sm">
          <div className="px-3 py-2 bg-pink-50 border-b font-semibold text-pink-900 text-sm flex items-center gap-2">
            <Flame className="h-4 w-4" /> أفضل العملاء المحتملين (Lead Scoring)
          </div>
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-pink-50/60 text-pink-900 border-b">
              <tr>
                <th className="px-2 py-1.5 text-start">الكود</th>
                <th className="px-2 py-1.5 text-start">الاسم</th>
                <th className="px-2 py-1.5 text-start">الاهتمام</th>
                <th className="px-2 py-1.5 text-start">أنشطة</th>
                <th className="px-2 py-1.5 text-start">النقاط</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {topLeads.length === 0 && <tr><td colSpan={5} className="px-2 py-4 text-center text-muted-foreground">— لا توجد بيانات —</td></tr>}
              {topLeads.map(l => (
                <tr key={l.id} className="hover:bg-pink-50/30">
                  <td className="px-2 py-1.5 font-mono">{l.code}</td>
                  <td className="px-2 py-1.5 font-semibold">{l.name}</td>
                  <td className="px-2 py-1.5">{l.interestLevel}</td>
                  <td className="px-2 py-1.5 font-mono">{l.activitiesCount}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-pink-500" style={{ width: `${l.score}%` }} />
                      </div>
                      <span className="font-mono text-[10px]">{l.score}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Rep performance */}
        <div className="border rounded-lg bg-white shadow-sm">
          <div className="px-3 py-2 bg-indigo-50 border-b font-semibold text-indigo-900 text-sm flex items-center gap-2">
            <Trophy className="h-4 w-4" /> أداء المندوبين
          </div>
          <table className="w-full text-xs" dir="rtl">
            <thead className="bg-indigo-50/60 text-indigo-900 border-b">
              <tr>
                <th className="px-2 py-1.5 text-start">المندوب</th>
                <th className="px-2 py-1.5 text-start">الفرص</th>
                <th className="px-2 py-1.5 text-start">المحققة</th>
                <th className="px-2 py-1.5 text-start">% التحويل</th>
                <th className="px-2 py-1.5 text-start">إجمالي القيمة</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(reps?.reps ?? []).length === 0 && <tr><td colSpan={5} className="px-2 py-4 text-center text-muted-foreground">— لا توجد بيانات —</td></tr>}
              {(reps?.reps ?? []).map(r => (
                <tr key={r.userId} className="hover:bg-indigo-50/30">
                  <td className="px-2 py-1.5 font-mono">#{r.userId}</td>
                  <td className="px-2 py-1.5 font-mono">{r.opportunities}</td>
                  <td className="px-2 py-1.5 font-mono text-emerald-700">{r.won}</td>
                  <td className="px-2 py-1.5 font-mono">{r.conversionRate}%</td>
                  <td className="px-2 py-1.5 font-mono">{r.totalValue.toLocaleString("ar-EG")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* By stage breakdown */}
      <div className="border rounded-lg bg-white shadow-sm">
        <div className="px-3 py-2 bg-amber-50 border-b font-semibold text-amber-900 text-sm">توزيع الفرص حسب المرحلة</div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 p-3">
          {Object.entries(forecast?.byStage ?? {}).map(([k, v]) => (
            <div key={k} className="border rounded p-2 text-center">
              <div className="text-[10px] text-muted-foreground">{STAGE_LABEL[k] ?? k}</div>
              <div className="text-lg font-bold">{v.count}</div>
              <div className="text-[10px] font-mono text-amber-700">{v.value.toLocaleString("ar-EG")}</div>
            </div>
          ))}
          {Object.keys(forecast?.byStage ?? {}).length === 0 && (
            <div className="col-span-6 text-center text-muted-foreground py-3">— لا توجد فرص —</div>
          )}
        </div>
      </div>

      {/* Alerts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border rounded-lg bg-white shadow-sm">
          <div className="px-3 py-2 bg-rose-50 border-b font-semibold text-rose-900 text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> عملاء محتملون بدون متابعة (أكثر من 7 أيام)
          </div>
          <div className="p-2 space-y-1 max-h-64 overflow-y-auto">
            {(alerts?.staleLeads ?? []).length === 0 && <div className="text-center py-4 text-muted-foreground text-xs">— لا توجد —</div>}
            {(alerts?.staleLeads ?? []).map(l => (
              <div key={l.id} className="flex items-center justify-between text-xs bg-rose-50/30 rounded p-2">
                <div><span className="font-mono text-[10px]">{l.code}</span> — <span className="font-semibold">{l.name}</span></div>
                <div className="text-rose-700 font-mono text-[10px]">{l.daysSilent} يوم</div>
              </div>
            ))}
          </div>
        </div>
        <div className="border rounded-lg bg-white shadow-sm">
          <div className="px-3 py-2 bg-amber-50 border-b font-semibold text-amber-900 text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> فرص متأخرة عن تاريخ الإغلاق
          </div>
          <div className="p-2 space-y-1 max-h-64 overflow-y-auto">
            {(alerts?.overdueOpps ?? []).length === 0 && <div className="text-center py-4 text-muted-foreground text-xs">— لا توجد —</div>}
            {(alerts?.overdueOpps ?? []).map(o => (
              <div key={o.id} className="flex items-center justify-between text-xs bg-amber-50/30 rounded p-2">
                <div><span className="font-mono text-[10px]">{o.code}</span> — <span className="font-semibold">{o.title}</span></div>
                <div className="text-amber-700 font-mono text-[10px]">{o.expectedCloseDate}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
