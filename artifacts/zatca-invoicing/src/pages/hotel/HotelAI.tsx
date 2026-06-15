import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sparkles, TrendingUp, AlertTriangle, BedDouble } from "lucide-react";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function HotelAI() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [recHotelId, setRecHotelId] = useState<string>("");
  const [recCheckIn, setRecCheckIn] = useState<string>("");
  const [recCheckOut, setRecCheckOut] = useState<string>("");
  const [recGuests, setRecGuests] = useState<string>("2");
  const [recPrefs, setRecPrefs] = useState<string>("");
  const [recBudget, setRecBudget] = useState<string>("");
  const [recommendations, setRecommendations] = useState<any[] | null>(null);
  const [recExp, setRecExp] = useState<string>("");
  const [recLoading, setRecLoading] = useState(false);

  const { data: hotels = [] } = useQuery<any[]>({
    queryKey: ["hotel/hotels", cid],
    queryFn: async () => (await fetch(`${API}/api/hotel/hotels?companyId=${cid}`, { headers })).json(),
    enabled: !!cid, staleTime: 60_000,
  });

  const { data: forecast } = useQuery<any>({
    queryKey: ["hotel-ai/forecast", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hotel-ai/forecast?companyId=${cid}&days=30`, { headers });
      if (!r.ok) throw new Error("فشل تحميل التوقع");
      return r.json();
    },
    enabled: !!cid, staleTime: 30_000,
  });

  const { data: maintenanceRisk } = useQuery<any>({
    queryKey: ["hotel-ai/maintenance-risk", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hotel-ai/maintenance-risk?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل المخاطر");
      return r.json();
    },
    enabled: !!cid, staleTime: 60_000,
  });

  async function fetchRecommendations() {
    if (!recHotelId || !recCheckIn || !recCheckOut) {
      toast({ title: "اختر الفندق وحدد التواريخ", variant: "destructive" });
      return;
    }
    setRecLoading(true);
    try {
      const r = await fetch(`${API}/api/hotel-ai/recommend-room`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: cid, hotelId: Number(recHotelId),
          checkIn: recCheckIn, checkOut: recCheckOut,
          guestsCount: Number(recGuests || 2),
          preferences: recPrefs,
          budget: recBudget ? Number(recBudget) : null,
        }),
      });
      if (!r.ok) throw new Error("فشل التوصية");
      const data = await r.json();
      setRecommendations(data.recommendations || []);
      setRecExp(data.explanation || "");
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setRecLoading(false);
    }
  }

  return (
    <div className="space-y-6 p-4" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-violet-600" />
          الذكاء الاصطناعي للفنادق
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          توصيات الغرف، توقع الإشغال، وتنبؤ مخاطر الصيانة
        </p>
      </div>

      {/* Forecast Card */}
      <div className="border rounded-lg bg-white shadow-sm overflow-hidden">
        <div className="bg-gradient-to-l from-emerald-50 to-emerald-100 border-b px-4 py-3 flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-emerald-700" />
          <h2 className="font-bold text-emerald-900">توقع الإشغال — 30 يوماً قادماً</h2>
        </div>
        <div className="p-4">
          {!forecast && <p className="text-muted-foreground text-sm">جاري التحميل…</p>}
          {forecast && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div className="bg-emerald-50 border border-emerald-200 rounded p-3">
                  <p className="text-[11px] text-emerald-700">إجمالي الغرف</p>
                  <p className="text-2xl font-bold text-emerald-900">{forecast.totalRooms}</p>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded p-3">
                  <p className="text-[11px] text-blue-700">متوسط الإشغال</p>
                  <p className="text-2xl font-bold text-blue-900">{forecast.averageOccupancy}%</p>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded p-3">
                  <p className="text-[11px] text-amber-700">ذروة الإشغال</p>
                  <p className="text-2xl font-bold text-amber-900">{forecast.peakOccupancy}%</p>
                </div>
                <div className="bg-violet-50 border border-violet-200 rounded p-3">
                  <p className="text-[11px] text-violet-700">تاريخ الذروة</p>
                  <p className="text-sm font-bold text-violet-900 font-mono">{forecast.peakDate}</p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-2">{forecast.explanation}</p>
              <div className="flex gap-px h-16 items-end overflow-x-auto bg-slate-50 rounded p-2">
                {forecast.series?.map((p: any) => (
                  <div key={p.date}
                    className="bg-emerald-500 hover:bg-emerald-600 transition-colors flex-shrink-0"
                    style={{ height: `${Math.max(2, p.occupancyRate)}%`, width: "10px" }}
                    title={`${p.date}: ${p.occupancyRate}% (${p.occupied} غرفة)`}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Room Recommendation */}
      <div className="border rounded-lg bg-white shadow-sm overflow-hidden">
        <div className="bg-gradient-to-l from-cyan-50 to-cyan-100 border-b px-4 py-3 flex items-center gap-2">
          <BedDouble className="h-5 w-5 text-cyan-700" />
          <h2 className="font-bold text-cyan-900">توصية ذكية للغرف</h2>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label>الفندق *</Label>
              <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={recHotelId} onChange={(e) => setRecHotelId(e.target.value)}>
                <option value="">— اختر —</option>
                {hotels.map((h: any) => <option key={h.id} value={h.id}>{h.nameAr}</option>)}
              </select>
            </div>
            <div>
              <Label>تاريخ الدخول *</Label>
              <DateField value={recCheckIn} onChange={(e) => setRecCheckIn(e.target.value)} />
            </div>
            <div>
              <Label>تاريخ الخروج *</Label>
              <DateField value={recCheckOut} onChange={(e) => setRecCheckOut(e.target.value)} />
            </div>
            <div>
              <Label>عدد الضيوف</Label>
              <Input type="number" min="1" value={recGuests} onChange={(e) => setRecGuests(e.target.value)} />
            </div>
            <div>
              <Label>التفضيلات</Label>
              <Input value={recPrefs} onChange={(e) => setRecPrefs(e.target.value)} placeholder="إطلالة، شرفة…" />
            </div>
            <div>
              <Label>الميزانية / ليلة (ر.س)</Label>
              <Input type="number" value={recBudget} onChange={(e) => setRecBudget(e.target.value)} />
            </div>
          </div>
          <Button onClick={fetchRecommendations} disabled={recLoading}
            className="bg-cyan-600 hover:bg-cyan-700">
            <Sparkles className="h-4 w-4 ms-2" />
            {recLoading ? "جارٍ التحليل…" : "احصل على التوصيات"}
          </Button>
          {recommendations && recommendations.length === 0 && (
            <p className="text-amber-700 text-sm">لا توجد غرف متاحة في هذه الفترة.</p>
          )}
          {recommendations && recommendations.length > 0 && (
            <div>
              <p className="text-sm text-muted-foreground mb-2">{recExp}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {recommendations.map((r: any, i: number) => (
                  <div key={r.id} className="border rounded p-3 flex items-center justify-between hover:bg-cyan-50/40">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="bg-cyan-100 text-cyan-800 text-[10px] font-bold rounded-full w-6 h-6 flex items-center justify-center">{i+1}</span>
                        <span className="font-bold">غرفة {r.roomNumber}</span>
                        <span className="text-[11px] text-muted-foreground">({r.roomType}, {r.capacity} ضيوف)</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1">{r.features || "بدون مميزات إضافية"}</p>
                    </div>
                    <div className="text-end">
                      <p className="font-mono font-bold">{r.basePrice.toLocaleString("ar-SA")} ر.س</p>
                      <p className="text-[10px] text-emerald-700">نقاط: {r.score}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Maintenance Risk */}
      <div className="border rounded-lg bg-white shadow-sm overflow-hidden">
        <div className="bg-gradient-to-l from-orange-50 to-orange-100 border-b px-4 py-3 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-orange-700" />
          <h2 className="font-bold text-orange-900">تنبؤ مخاطر الصيانة</h2>
        </div>
        <div className="p-4">
          {!maintenanceRisk && <p className="text-muted-foreground text-sm">جاري التحليل…</p>}
          {maintenanceRisk && (
            <>
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-rose-50 border border-rose-200 rounded p-3">
                  <p className="text-[11px] text-rose-700">عالية الخطر</p>
                  <p className="text-2xl font-bold text-rose-900">{maintenanceRisk.highRisk}</p>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded p-3">
                  <p className="text-[11px] text-amber-700">متوسطة</p>
                  <p className="text-2xl font-bold text-amber-900">{maintenanceRisk.mediumRisk}</p>
                </div>
                <div className="bg-emerald-50 border border-emerald-200 rounded p-3">
                  <p className="text-[11px] text-emerald-700">منخفضة</p>
                  <p className="text-2xl font-bold text-emerald-900">{maintenanceRisk.lowRisk}</p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs" dir="rtl">
                  <thead className="bg-slate-50 border-b">
                    <tr>
                      <th className="px-3 py-2 text-start">الغرفة</th>
                      <th className="px-3 py-2 text-start">النوع</th>
                      <th className="px-3 py-2 text-start">الحالة</th>
                      <th className="px-3 py-2 text-center">مهام أخيرة</th>
                      <th className="px-3 py-2 text-center">الحجوزات</th>
                      <th className="px-3 py-2 text-center">المخاطر</th>
                      <th className="px-3 py-2 text-start">التوصية</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {maintenanceRisk.rooms?.slice(0, 15).map((r: any) => (
                      <tr key={r.roomId}>
                        <td className="px-3 py-2 font-mono font-bold">{r.roomNumber}</td>
                        <td className="px-3 py-2">{r.roomType}</td>
                        <td className="px-3 py-2">{r.currentStatus}</td>
                        <td className="px-3 py-2 text-center">{r.recentTasks}</td>
                        <td className="px-3 py-2 text-center">{r.totalBookings}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            r.riskLevel === "high"   ? "bg-rose-100 text-rose-800" :
                            r.riskLevel === "medium" ? "bg-amber-100 text-amber-800" :
                                                       "bg-emerald-100 text-emerald-800"
                          }`}>{r.riskScore}</span>
                        </td>
                        <td className="px-3 py-2 text-[11px]">{r.recommendation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
