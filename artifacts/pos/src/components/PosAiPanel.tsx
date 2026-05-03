import { useEffect, useMemo, useState } from "react";
import { Sparkles, X, Send, AlertTriangle, Loader2, Tag, MessageSquare, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { posAi, type Suggestion, type FraudResult } from "@/lib/posAi";
import type { Item } from "@/lib/api";

type Props = {
  customerId?: number | null;
  cart: Array<{ item: Item; qty: number }>;
  totalAmount: number;
  discountPct: number;
  paymentType: string;
  allItems: Item[];
  onAddItem?: (item: Item) => void;
  onApplyDiscount?: (pct: number) => void;
};

type Tab = "suggest" | "discount" | "chat" | "fraud";

export default function PosAiPanel(props: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("suggest");

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          // Compact icon-only floating action button. Placed at bottom-left
          // (out of the cart's payment-button area), hidden when printing,
          // with a tooltip so the purpose stays discoverable.
          title="مساعد الذكاء الاصطناعي"
          aria-label="مساعد الذكاء الاصطناعي"
          className="fixed bottom-4 left-4 z-40 grid place-items-center h-11 w-11 rounded-full bg-gradient-to-tr from-emerald-500 to-teal-600 text-white shadow-md shadow-emerald-500/30 hover:scale-110 transition print:hidden"
          dir="rtl"
        >
          <Sparkles className="h-5 w-5" />
          <span className="sr-only">مساعد الذكاء الاصطناعي</span>
        </button>
      )}
      {open && (
        <div className="fixed bottom-6 left-6 z-40 w-[380px] max-w-[calc(100vw-2rem)] rounded-2xl bg-white border border-slate-200 shadow-2xl flex flex-col overflow-hidden" dir="rtl" style={{ maxHeight: "min(620px, 85vh)" }}>
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-tr from-emerald-500 to-teal-600 text-white">
            <div className="flex items-center gap-2 font-semibold">
              <Sparkles className="h-5 w-5" /> مساعد POS الذكي
            </div>
            <button onClick={() => setOpen(false)} className="hover:bg-white/20 rounded p-1">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-4 border-b text-xs">
            {([
              { k: "suggest", label: "اقتراحات", I: Lightbulb },
              { k: "discount", label: "خصم ذكي", I: Tag },
              { k: "fraud", label: "تدقيق", I: AlertTriangle },
              { k: "chat", label: "محادثة", I: MessageSquare },
            ] as const).map(({ k, label, I }) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`flex flex-col items-center gap-1 py-2 transition ${
                  tab === k ? "bg-emerald-50 text-emerald-700 border-b-2 border-emerald-600" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <I className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {tab === "suggest" && <SuggestPane {...props} />}
            {tab === "discount" && <DiscountPane {...props} />}
            {tab === "fraud" && <FraudPane {...props} />}
            {tab === "chat" && <ChatPane />}
          </div>
        </div>
      )}
    </>
  );
}

function SuggestPane({ cart, customerId, allItems, onAddItem }: Props) {
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<Suggestion[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const itemIds = useMemo(() => cart.map((c) => c.item.id), [cart]);
  const key = itemIds.join(",") + "|" + (customerId ?? "");

  useEffect(() => {
    let aborted = false;
    setLoading(true); setErr(null);
    posAi.suggest({ itemIds, customerId, limit: 6 })
      .then((r) => { if (!aborted) setList(r.suggestions); })
      .catch((e) => { if (!aborted) setErr(e.message); })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (loading) return <div className="flex justify-center py-8 text-slate-500"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (err) return <div className="text-sm text-red-600">{err}</div>;
  if (!list.length) return <div className="text-sm text-slate-500 text-center py-6">لا توجد اقتراحات حالياً.</div>;

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500 mb-2">منتجات قد يحتاجها العميل بناءً على البيانات السابقة:</p>
      {list.map((s) => {
        const item = allItems.find((i) => i.id === s.itemId);
        return (
          <div key={`${s.itemId}-${s.itemName}`} className="border rounded-lg p-2 flex items-center justify-between gap-2 hover:bg-emerald-50/50">
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">{s.itemName}</div>
              <div className="text-xs text-slate-500 truncate">{s.reason}</div>
            </div>
            {item && onAddItem && (
              <Button size="sm" variant="outline" className="shrink-0 text-emerald-700 border-emerald-300" onClick={() => onAddItem(item)}>
                إضافة
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DiscountPane({ customerId, totalAmount, cart, onApplyDiscount }: Props) {
  const [loading, setLoading] = useState(false);
  const [advice, setAdvice] = useState<{ suggestedPercent: number; reasons: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const qty = cart.reduce((s, c) => s + c.qty, 0);

  const ask = async () => {
    setLoading(true); setErr(null);
    try {
      const a = await posAi.discount({ customerId, totalAmount, qty, hour: new Date().getHours() });
      setAdvice(a);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-600">
        إجمالي السلة: <b>{totalAmount.toFixed(2)}</b> ر.س — {qty} وحدة
      </div>
      <Button onClick={ask} disabled={loading} className="w-full bg-emerald-600 hover:bg-emerald-700">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "اقترح خصماً مناسباً"}
      </Button>
      {err && <div className="text-sm text-red-600">{err}</div>}
      {advice && (
        <div className="border rounded-lg p-3 bg-emerald-50 border-emerald-200">
          <div className="text-2xl font-bold text-emerald-700">{advice.suggestedPercent}%</div>
          <ul className="text-xs text-slate-700 mt-2 space-y-1 list-disc pr-4">
            {advice.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
          {advice.suggestedPercent > 0 && onApplyDiscount && (
            <Button size="sm" className="mt-2 w-full bg-emerald-600 hover:bg-emerald-700" onClick={() => onApplyDiscount(advice.suggestedPercent)}>
              تطبيق هذا الخصم
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function FraudPane({ discountPct, totalAmount, cart, paymentType }: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FraudResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const check = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await posAi.fraudCheck({
        discountPct, totalAmount,
        qty: cart.reduce((s, c) => s + c.qty, 0),
        lines: cart.map((c) => ({
          itemName: c.item.nameAr, qty: c.qty,
          discount: 0, lineTotal: c.qty * Number(c.item.salePrice),
        })),
        paymentType,
      });
      setResult(r);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const sevColor = (s: string) =>
    s === "high" ? "bg-red-50 text-red-700 border-red-300"
    : s === "medium" ? "bg-amber-50 text-amber-700 border-amber-300"
    : "bg-slate-50 text-slate-700 border-slate-300";

  return (
    <div className="space-y-3">
      <Button onClick={check} disabled={loading} className="w-full bg-amber-600 hover:bg-amber-700">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "فحص العملية"}
      </Button>
      {err && <div className="text-sm text-red-600">{err}</div>}
      {result && (
        <div className={`border rounded-lg p-3 ${sevColor(result.severity)}`}>
          <div className="font-semibold mb-2">
            {result.flags.length === 0 ? "✅ لا توجد ملاحظات." : `⚠ ${result.flags.length} تنبيه — مستوى ${result.severity}`}
          </div>
          <ul className="text-xs space-y-1 list-disc pr-4">
            {result.flags.map((f, i) => <li key={i}>{f.message}</li>)}
          </ul>
          {result.block && <div className="mt-2 text-xs font-bold">يُنصح بمراجعة المشرف قبل الإكمال.</div>}
        </div>
      )}
    </div>
  );
}

function ChatPane() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [msgs, setMsgs] = useState<Array<{ role: "user" | "ai"; text: string }>>([
    { role: "ai", text: "مرحباً 👋 اسألني عن مبيعات اليوم، أفضل عميل، أو أكثر المنتجات مبيعاً." },
  ]);
  const [chips, setChips] = useState<string[]>(["مبيعات اليوم", "أفضل عميل", "أكثر المنتجات مبيعاً"]);

  const send = async (text?: string) => {
    const question = (text ?? q).trim();
    if (!question || loading) return;
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setQ(""); setLoading(true);
    try {
      const r = await posAi.chat(question);
      setMsgs((m) => [...m, { role: "ai", text: r.answer }]);
      if (r.suggestions) setChips(r.suggestions);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "ai", text: `خطأ: ${e.message}` }]);
    } finally { setLoading(false); }
  };

  return (
    <div className="flex flex-col h-full" style={{ minHeight: 320 }}>
      <div className="flex-1 overflow-y-auto space-y-2 mb-2">
        {msgs.map((m, i) => (
          <div key={i} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-line ${
            m.role === "user" ? "bg-emerald-600 text-white self-end mr-auto ml-0" : "bg-slate-100 text-slate-800"
          }`}>{m.text}</div>
        ))}
        {loading && <div className="text-slate-400 text-xs">يفكر…</div>}
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {chips.map((c) => (
          <button key={c} onClick={() => send(c)} className="text-xs px-2 py-1 rounded-full bg-slate-100 hover:bg-emerald-50 text-slate-700">
            {c}
          </button>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="اكتب سؤالك…" className="text-sm" />
        <Button type="submit" disabled={loading || !q.trim()} className="bg-emerald-600 hover:bg-emerald-700">
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
