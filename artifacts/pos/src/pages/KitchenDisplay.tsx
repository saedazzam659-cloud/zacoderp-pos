import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChefHat, ChevronRight, Clock, Loader2, Check, Flame, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, getToken, type ROrder, type ROrderItem } from "@/lib/api";

const STATIONS = [
  { id: "",        label: "الكل" },
  { id: "kitchen", label: "المطبخ" },
  { id: "grill",   label: "الشواية" },
  { id: "bar",     label: "البار" },
  { id: "cold",    label: "البارد" },
  { id: "dessert", label: "الحلويات" },
];

export default function KitchenDisplay() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [station, setStation] = useState("");

  useEffect(() => { if (!getToken()) setLocation("/login"); }, [setLocation]);

  const ticketsQ = useQuery({
    queryKey: ["r-kitchen", station],
    queryFn: () => api.rKitchen(station || undefined),
    refetchInterval: 4000,
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "preparing" | "ready" | "served" }) =>
      api.rKitchenSetStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["r-kitchen"] }),
  });

  return (
    <div dir="rtl" className="min-h-screen bg-slate-950 text-white">
      <header className="flex items-center justify-between p-3 border-b border-white/10 bg-slate-900">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/restaurant")}>
            <ChevronRight className="h-4 w-4 ml-1" /> رجوع
          </Button>
          <ChefHat className="text-rose-400" />
          <div className="font-bold">شاشة المطبخ</div>
        </div>
        <div className="flex gap-2 items-center">
          {STATIONS.map(s => (
            <button
              key={s.id}
              onClick={() => setStation(s.id)}
              className={`px-3 py-1 rounded-full text-xs ${station === s.id ? "bg-rose-500 text-white font-bold" : "bg-slate-800 text-white/70"}`}
            >{s.label}</button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["r-kitchen"] })}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="p-3">
        {ticketsQ.isLoading ? (
          <Loader2 className="animate-spin mx-auto mt-12" />
        ) : (ticketsQ.data ?? []).length === 0 ? (
          <div className="text-center text-white/50 py-20">
            لا توجد تذاكر حالياً
            <div className="text-xs mt-2">سيتم تحديث الشاشة تلقائياً كل 4 ثوانٍ</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {ticketsQ.data!.map(t => <TicketCard key={t.id} ticket={t} setStatus={setStatus} />)}
          </div>
        )}
      </main>
    </div>
  );
}

function TicketCard({ ticket, setStatus }: { ticket: ROrder & { items: ROrderItem[] }; setStatus: any }) {
  const minutesAgo = ticket.sentAt ? Math.floor((Date.now() - new Date(ticket.sentAt).getTime()) / 60000) : 0;
  const urgent = minutesAgo > 10;
  const allReady = ticket.items.every(i => ["ready", "served"].includes(i.status));

  return (
    <div className={`rounded-xl border-2 ${urgent ? "border-rose-500 animate-pulse" : "border-slate-700"} bg-slate-900 overflow-hidden`}>
      <div className={`p-2 flex justify-between items-center ${urgent ? "bg-rose-900" : "bg-slate-800"}`}>
        <div>
          <div className="font-bold">{ticket.orderNumber}</div>
          <div className="text-[11px] text-white/70">{ticket.channel === "dine_in" ? "صالة" : ticket.channel === "takeaway" ? "سفري" : "توصيل"}</div>
        </div>
        <div className={`flex items-center gap-1 text-sm ${urgent ? "text-rose-300 font-bold" : "text-white/70"}`}>
          {urgent && <Flame className="h-4 w-4" />}
          <Clock className="h-4 w-4" /> {minutesAgo} د
        </div>
      </div>
      <div className="p-2 space-y-1 max-h-72 overflow-y-auto">
        {ticket.items.map(it => (
          <div key={it.id} className="flex items-center gap-2 p-2 bg-slate-800 rounded">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate">{it.nameSnapshot}</div>
              <div className="text-xs text-white/60">{Number(it.qty).toFixed(0)} ×</div>
              {it.notes && <div className="text-[11px] text-amber-300 truncate">📝 {it.notes}</div>}
            </div>
            {it.status === "pending" && (
              <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => setStatus.mutate({ id: it.id, status: "preparing" })}>
                ابدأ
              </Button>
            )}
            {it.status === "preparing" && (
              <Button size="sm" className="bg-amber-500 text-slate-900 hover:bg-amber-600" onClick={() => setStatus.mutate({ id: it.id, status: "ready" })}>
                جاهز
              </Button>
            )}
            {it.status === "ready" && (
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setStatus.mutate({ id: it.id, status: "served" })}>
                <Check className="h-4 w-4" />
              </Button>
            )}
            {it.status === "served" && (
              <span className="text-xs text-emerald-400">✓ تم</span>
            )}
          </div>
        ))}
      </div>
      {allReady && (
        <div className="p-2 bg-emerald-900/40 text-center text-emerald-300 text-sm font-semibold border-t border-emerald-700">
          ✓ كل الأصناف جاهزة
        </div>
      )}
    </div>
  );
}
