import "./_group.css";
import {
  Banknote,
  ChevronLeft,
  CreditCard,
  Minus,
  Pause,
  Percent,
  Plus,
  Receipt,
  ScanBarcode,
  Search,
  Smartphone,
  Store,
  Trash2,
  User,
  Wallet,
  Wifi,
} from "lucide-react";

const products = [
  { id: 1, name: "محول الحسابات العامة", code: "200", price: 350 },
  { id: 2, name: "محول النقد والبنوك", code: "121211", price: 425 },
  { id: 3, name: "محول الموردين والمشتريات", code: "111111", price: 280 },
  { id: 4, name: "محول العملاء والمبيعات", code: "111110", price: 310 },
  { id: 5, name: "محول المخازن", code: "100033", price: 195 },
  { id: 6, name: "صنف نهائي", code: "102", price: 95 },
  { id: 7, name: "صنف تكلفة", code: "202", price: 150 },
  { id: 8, name: "مجموعة أصناف", code: "305", price: 80 },
  { id: 9, name: "إيجار الرياض المتقدم", code: "442", price: 500 },
  { id: 10, name: "مصروف مقدم", code: "501", price: 240 },
];

const cart = [
  { id: 1, name: "محول الحسابات العامة", qty: 1, price: 350 },
  { id: 2, name: "محول النقد والبنوك", qty: 2, price: 425 },
  { id: 3, name: "محول الموردين والمشتريات", qty: 1, price: 280 },
  { id: 4, name: "محول العملاء والمبيعات", qty: 1, price: 310 },
  { id: 5, name: "محول المخازن", qty: 1, price: 195 },
];

const sar = (value: number) =>
  new Intl.NumberFormat("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

export function Current() {
  const subtotal = cart.reduce((sum, row) => sum + row.price * row.qty, 0);
  const vat = subtotal * 0.15;

  return (
    <main dir="rtl" className="h-screen w-full overflow-hidden bg-background text-foreground flex flex-col">
      <header className="h-16 shrink-0 border-b border-border bg-card/80 px-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-emerald-400 grid place-items-center text-primary-foreground">
            <Store className="w-5 h-5" />
          </div>
          <div className="hidden sm:block">
            <p className="text-sm font-extrabold">زاكود <span className="text-primary">POS</span></p>
            <p className="text-[10px] text-muted-foreground">الفرع الرئيسي • زاكود ERP</p>
          </div>
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input className="w-full h-10 rounded-xl border border-border bg-card pr-10 pl-11 text-xs" placeholder="ابحث باسم المنتج أو الباركود..." />
          <ScanBarcode className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden md:inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1.5 text-[11px] font-bold text-primary">
            <Wifi className="w-3 h-3" /> متصل
          </span>
          <button className="w-10 h-10 rounded-xl border border-border bg-card grid place-items-center"><User className="w-4 h-4" /></button>
        </div>
      </header>

      <div className="flex-1 min-h-0 grid lg:grid-cols-[1fr_22rem] xl:grid-cols-[1fr_24rem]">
        <section className="flex min-h-0 flex-col">
          <div className="overflow-x-auto border-b border-border px-4 py-3">
            <div className="flex min-w-max gap-2">
              {["الكل", "مجموعات الأصناف", "أصل", "إيجار النقل المتقدم", "مصروف مقدم"].map((category, index) => (
                <button key={category} className={`h-10 rounded-xl border px-4 text-xs font-bold ${index === 0 ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"}`}>
                  {category}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
              {products.map((product) => (
                <button key={product.id} className="rounded-2xl border border-card-border bg-card p-3 text-right">
                  <div className="mb-2 aspect-square rounded-xl bg-gradient-to-br from-muted to-muted/30 grid place-items-center text-5xl">📦</div>
                  <p className="min-h-10 line-clamp-2 text-sm font-bold leading-snug">{product.name}</p>
                  <div className="mt-2 flex items-baseline justify-between gap-1">
                    <span className="font-mono text-[10px] text-muted-foreground">{product.code}</span>
                    <span className="text-sm font-black text-primary">{sar(product.price)} <small className="text-[10px] text-muted-foreground">ر.س</small></span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>

        <aside className="hidden lg:flex flex-col border-r border-border bg-card/60">
          <div className="shrink-0 border-b border-border px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-extrabold">فاتورة جديدة</p>
              <p className="text-[11px] text-muted-foreground">9 أصناف</p>
            </div>
            <button className="h-8 rounded-lg border border-border bg-card px-2.5 text-xs font-bold inline-flex items-center gap-1"><User className="w-3 h-3" /> عميل</button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
            <ul className="space-y-1.5">
              {cart.map((row) => (
                <li key={row.id} className="rounded-xl border border-border bg-card p-2 flex items-center gap-2">
                  <div className="w-9 h-9 shrink-0 rounded-lg bg-muted grid place-items-center text-lg">📦</div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-bold">{row.name}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{sar(row.price)} ر.س / وحدة</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1 rounded-lg bg-muted p-0.5">
                        <span className="w-7 h-7 grid place-items-center"><Minus className="w-3.5 h-3.5" /></span>
                        <strong className="min-w-7 text-center text-sm">{row.qty}</strong>
                        <span className="w-7 h-7 grid place-items-center"><Plus className="w-3.5 h-3.5" /></span>
                      </span>
                      <strong className="text-sm text-primary">{sar(row.price * row.qty)} <small className="text-[10px] text-muted-foreground">ر.س</small></strong>
                    </div>
                  </div>
                  <span className="w-7 h-7 grid place-items-center text-muted-foreground"><Trash2 className="w-3.5 h-3.5" /></span>
                </li>
              ))}
            </ul>
          </div>
          <div className="shrink-0 border-t border-border bg-gradient-to-b from-card to-muted/30 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex h-9 flex-1 items-center gap-1 rounded-xl border border-border bg-card px-2.5">
                <Percent className="w-3.5 h-3.5 text-muted-foreground" /><span className="text-xs text-muted-foreground">خصم</span>
                <span className="flex-1 text-end text-sm">0</span><span className="text-xs text-muted-foreground">%</span>
              </div>
              <button className="h-9 rounded-xl border border-border bg-card px-3 text-xs font-bold inline-flex items-center gap-1"><Pause className="w-3.5 h-3.5" /> تعليق</button>
            </div>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">المجموع الفرعي</span><strong>{sar(subtotal)} ر.س</strong></div>
              <div className="flex justify-between"><span className="text-muted-foreground">ضريبة القيمة المضافة 15%</span><strong>{sar(vat)} ر.س</strong></div>
              <div className="my-2 h-px bg-border" />
              <div className="flex items-center justify-between"><strong>الإجمالي</strong><strong className="text-2xl text-primary">{sar(subtotal + vat)} <small className="text-sm text-muted-foreground">ر.س</small></strong></div>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button className="h-11 rounded-xl border border-border bg-card inline-flex items-center justify-center gap-1.5 text-sm font-bold"><Banknote className="w-4 h-4" /> نقداً</button>
              <button className="h-11 rounded-xl border border-border bg-card inline-flex items-center justify-center gap-1.5 text-sm font-bold"><CreditCard className="w-4 h-4" /> شبكة</button>
              <button className="h-11 rounded-xl border border-border bg-card inline-flex items-center justify-center gap-1.5 text-sm font-bold"><Smartphone className="w-4 h-4" /> Apple Pay</button>
              <button className="h-11 rounded-xl border border-border bg-card inline-flex items-center justify-center gap-1.5 text-sm font-bold"><Wallet className="w-4 h-4" /> محفظة</button>
            </div>
            <button className="h-13 w-full rounded-xl bg-primary px-4 text-base font-extrabold text-primary-foreground inline-flex items-center justify-center gap-2">
              <Receipt className="w-5 h-5" /> إتمام الدفع <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}
