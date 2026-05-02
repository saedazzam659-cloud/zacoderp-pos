import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight, Plus, Send, Trash2, Loader2, Users, Clock, X, Check, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api, getToken, getStoredUser,
  type RTable, type RMenuCategory, type RMenuItem, type ROrder, type ROrderItem,
} from "@/lib/api";

export default function WaiterApp() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const user = getStoredUser();
  const [openTableId, setOpenTableId] = useState<number | null>(null);
  const [activeOrder, setActiveOrder] = useState<(ROrder & { items: ROrderItem[] }) | null>(null);
  const [activeCat, setActiveCat] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => { if (!getToken()) setLocation("/login"); }, [setLocation]);

  const tablesQ = useQuery({ queryKey: ["r-tables"], queryFn: () => api.rTables(), refetchInterval: 5000 });
  const catsQ   = useQuery({ queryKey: ["r-cats"],   queryFn: () => api.rCategories() });
  const itemsQ  = useQuery({ queryKey: ["r-items"],  queryFn: () => api.rMenuItems() });

  // Open table → fetch or create draft order
  useEffect(() => {
    if (!openTableId) { setActiveOrder(null); return; }
    const tbl = tablesQ.data?.find(t => t.id === openTableId);
    if (!tbl) return;
    (async () => {
      if (tbl.currentOrderId) {
        try {
          const o = await api.rOrder(tbl.currentOrderId);
          setActiveOrder(o);
        } catch (e: any) {
          // fall through to create new order
        }
      }
      if (!tbl.currentOrderId) {
        // Create a draft order
        try {
          const o = await api.rCreateOrder({
            branchId: tbl.branchId, tableId: tbl.id, channel: "dine_in", guestCount: 2,
          });
          await qc.invalidateQueries({ queryKey: ["r-tables"] });
          const full = await api.rOrder(o.id);
          setActiveOrder(full);
        } catch (e: any) {
          alert(e?.message ?? "تعذّر إنشاء الطلب");
        }
      }
    })();
  }, [openTableId, tablesQ.data, qc]);

  const addItem = useMutation({
    mutationFn: ({ orderId, menuItemId }: { orderId: number; menuItemId: number }) =>
      api.rAddItem(orderId, { menuItemId, qty: 1 }),
    onSuccess: async () => {
      if (activeOrder) setActiveOrder(await api.rOrder(activeOrder.id));
    },
  });

  const removeItem = useMutation({
    mutationFn: ({ orderId, itemId }: { orderId: number; itemId: number }) =>
      api.rRemoveItem(orderId, itemId),
    onSuccess: async () => {
      if (activeOrder) setActiveOrder(await api.rOrder(activeOrder.id));
    },
  });

  const sendOrder = useMutation({
    mutationFn: (id: number) => api.rSendOrder(id),
    onSuccess: async () => {
      if (activeOrder) setActiveOrder(await api.rOrder(activeOrder.id));
      await qc.invalidateQueries({ queryKey: ["r-tables"] });
    },
  });

  const cancelOrder = useMutation({
    mutationFn: (id: number) => api.rCancelOrder(id),
    onSuccess: async () => {
      setActiveOrder(null); setOpenTableId(null);
      await qc.invalidateQueries({ queryKey: ["r-tables"] });
    },
  });

  const filteredItems = useMemo(() => {
    let arr = itemsQ.data ?? [];
    if (activeCat) arr = arr.filter(i => i.categoryId === activeCat);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      arr = arr.filter(i => i.nameAr.includes(s) || (i.code ?? "").toLowerCase().includes(s));
    }
    return arr;
  }, [itemsQ.data, activeCat, search]);

  const tableColor = (t: RTable) => {
    switch (t.status) {
      case "free":     return "bg-emerald-500/20 border-emerald-400 text-emerald-100";
      case "occupied": return "bg-rose-500/30 border-rose-400 text-rose-50";
      case "reserved": return "bg-amber-500/30 border-amber-400 text-amber-50";
      case "cleaning": return "bg-slate-500/30 border-slate-400 text-slate-100";
    }
  };

  return (
    <div dir="rtl" className="min-h-screen bg-slate-950 text-white">
      <header className="flex items-center justify-between p-3 border-b border-white/10 bg-slate-900">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/restaurant")}>
            <ChevronRight className="h-4 w-4 ml-1" /> رجوع
          </Button>
          <div className="font-bold">تطبيق النادل — {user?.username}</div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["r-tables"] })}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </header>

      {!activeOrder ? (
        <div className="p-4">
          <div className="text-sm text-white/70 mb-3">اختر طاولة لبدء طلب جديد أو متابعة طلب مفتوح:</div>
          {tablesQ.isLoading ? (
            <Loader2 className="animate-spin mx-auto mt-12" />
          ) : (tablesQ.data ?? []).length === 0 ? (
            <div className="text-center text-white/60 mt-12">
              لا توجد طاولات معرّفة.
              <div className="text-xs mt-2">يجب إضافة الطاولات من إعدادات نظام الفواتير.</div>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
              {tablesQ.data!.map(t => (
                <button
                  key={t.id}
                  onClick={() => setOpenTableId(t.id)}
                  className={`rounded-xl border-2 p-4 text-center hover:scale-105 transition ${tableColor(t)}`}
                >
                  <div className="text-xs opacity-80">{t.code}</div>
                  <div className="text-lg font-bold mt-1">{t.nameAr}</div>
                  <div className="text-[11px] opacity-70 mt-1 flex items-center justify-center gap-1">
                    <Users className="h-3 w-3" /> {t.capacity}
                  </div>
                  <div className="text-[10px] mt-1 opacity-90">
                    {t.status === "free" ? "متاحة" : t.status === "occupied" ? "مشغولة" : t.status === "reserved" ? "محجوزة" : "تنظيف"}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-0 h-[calc(100vh-56px)]">
          {/* Menu */}
          <div className="md:col-span-2 flex flex-col border-l border-white/10">
            <div className="p-2 border-b border-white/10 bg-slate-900 flex gap-2 items-center">
              <Input
                placeholder="بحث في القائمة..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="bg-slate-800 border-slate-700"
              />
            </div>
            <div className="flex gap-2 p-2 overflow-x-auto bg-slate-900/50 border-b border-white/10">
              <button
                onClick={() => setActiveCat(null)}
                className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap ${activeCat == null ? "bg-amber-500 text-slate-900 font-bold" : "bg-slate-800"}`}
              >الكل</button>
              {(catsQ.data ?? []).map(c => (
                <button
                  key={c.id}
                  onClick={() => setActiveCat(c.id)}
                  className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap ${activeCat === c.id ? "bg-amber-500 text-slate-900 font-bold" : "bg-slate-800"}`}
                  style={{ background: activeCat === c.id ? undefined : (c.color ?? undefined) }}
                >
                  {c.nameAr}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto p-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
              {filteredItems.length === 0 ? (
                <div className="col-span-full text-center text-white/50 py-12">لا توجد أصناف</div>
              ) : filteredItems.map(it => (
                <button
                  key={it.id}
                  disabled={addItem.isPending}
                  onClick={() => addItem.mutate({ orderId: activeOrder.id, menuItemId: it.id })}
                  className="rounded-lg p-3 bg-slate-800 hover:bg-slate-700 text-right disabled:opacity-50 transition"
                >
                  <div className="font-semibold text-sm">{it.nameAr}</div>
                  <div className="text-amber-400 font-bold text-base mt-1">{Number(it.price).toFixed(2)} ر.س</div>
                  {it.prepTimeMinutes > 0 && (
                    <div className="text-[11px] text-white/50 mt-1 flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {it.prepTimeMinutes} د
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Order side */}
          <div className="flex flex-col bg-slate-900">
            <div className="p-3 border-b border-white/10">
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-bold">{activeOrder.orderNumber}</div>
                  <div className="text-xs text-white/60">
                    طاولة #{tablesQ.data?.find(t => t.id === activeOrder.tableId)?.nameAr}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => { setActiveOrder(null); setOpenTableId(null); }}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="text-xs mt-1 text-white/70">
                الحالة: <span className="font-semibold">{statusLabel(activeOrder.status)}</span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {activeOrder.items.length === 0 ? (
                <div className="text-center text-white/50 py-10">اضغط الأصناف لإضافتها</div>
              ) : activeOrder.items.map(li => (
                <div key={li.id} className="flex justify-between items-center p-2 mb-1 rounded bg-slate-800">
                  <div className="flex-1">
                    <div className="text-sm font-semibold">{li.nameSnapshot}</div>
                    <div className="text-xs text-white/60">
                      {Number(li.qty).toFixed(0)} × {Number(li.price).toFixed(2)}
                      <span className={`ms-2 px-1.5 py-0.5 rounded text-[10px] ${
                        li.status === "served" ? "bg-emerald-700" :
                        li.status === "ready" ? "bg-amber-700" :
                        li.status === "preparing" ? "bg-blue-700" : "bg-slate-700"
                      }`}>{statusLabel(li.status as any)}</span>
                    </div>
                  </div>
                  <div className="text-amber-400 font-bold mr-2">{Number(li.total).toFixed(2)}</div>
                  {!li.sentAt && (
                    <Button variant="ghost" size="sm" onClick={() => removeItem.mutate({ orderId: activeOrder.id, itemId: li.id })}>
                      <Trash2 className="h-4 w-4 text-red-400" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <div className="p-3 border-t border-white/10 space-y-1 text-sm">
              <Row label="المجموع الفرعي" v={activeOrder.subtotal} />
              <Row label="ضريبة 15%" v={activeOrder.vatAmount} />
              <Row label="الإجمالي" v={activeOrder.total} bold />
            </div>
            <div className="p-3 grid grid-cols-2 gap-2 border-t border-white/10 bg-slate-950">
              <Button
                disabled={activeOrder.items.length === 0 || sendOrder.isPending}
                onClick={() => sendOrder.mutate(activeOrder.id)}
                className="bg-amber-500 hover:bg-amber-600 text-slate-900 font-bold"
              >
                <Send className="h-4 w-4 ml-1" /> إرسال للمطبخ
              </Button>
              <Button
                variant="destructive"
                disabled={cancelOrder.isPending}
                onClick={() => { if (confirm("إلغاء الطلب نهائياً؟")) cancelOrder.mutate(activeOrder.id); }}
              >
                <X className="h-4 w-4 ml-1" /> إلغاء
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, v, bold }: { label: string; v: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-bold text-base" : ""}`}>
      <span>{label}</span>
      <span>{Number(v).toFixed(2)} ر.س</span>
    </div>
  );
}

function statusLabel(s: ROrder["status"] | ROrderItem["status"]) {
  const m: Record<string, string> = {
    draft: "مسودة", sent: "أُرسل", preparing: "قيد التحضير", ready: "جاهز",
    served: "تم التقديم", billed: "مفوتر", cancelled: "ملغى", pending: "بانتظار",
  };
  return m[s] ?? s;
}
