import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Plus,
  Minus,
  Trash2,
  Percent,
  CreditCard,
  Banknote,
  Smartphone,
  Wallet,
  User as UserIcon,
  Pause,
  Receipt,
  Wifi,
  WifiOff,
  Sparkles,
  ChevronLeft,
  Store,
  ScanBarcode,
  ShoppingBag,
  X,
  Check,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { categories, products, type PosProduct } from "@/lib/posData";

type CartLine = {
  product: PosProduct;
  qty: number;
};

const VAT_RATE = 15;

function formatSAR(n: number) {
  return new Intl.NumberFormat("ar-SA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export default function CashierPage() {
  const [activeCat, setActiveCat] = useState("all");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discountPct, setDiscountPct] = useState(0);
  const [paid, setPaid] = useState(false);
  const [paidMethod, setPaidMethod] = useState<string | null>(null);
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [time, setTime] = useState(new Date());
  const [mobileCartOpen, setMobileCartOpen] = useState(false);

  useEffect(() => {
    const onO = () => setOnline(true);
    const onF = () => setOnline(false);
    window.addEventListener("online", onO);
    window.addEventListener("offline", onF);
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => {
      window.removeEventListener("online", onO);
      window.removeEventListener("offline", onF);
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(() => {
    let list = products;
    if (activeCat !== "all") list = list.filter((p) => p.categoryId === activeCat);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (p) =>
          p.nameAr.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q),
      );
    }
    return list;
  }, [activeCat, search]);

  const addToCart = (p: PosProduct) => {
    setCart((c) => {
      const existing = c.find((l) => l.product.id === p.id);
      if (existing) {
        return c.map((l) =>
          l.product.id === p.id ? { ...l, qty: l.qty + 1 } : l,
        );
      }
      return [...c, { product: p, qty: 1 }];
    });
  };

  const updateQty = (id: string, delta: number) => {
    setCart((c) =>
      c
        .map((l) =>
          l.product.id === id ? { ...l, qty: Math.max(0, l.qty + delta) } : l,
        )
        .filter((l) => l.qty > 0),
    );
  };

  const removeLine = (id: string) => {
    setCart((c) => c.filter((l) => l.product.id !== id));
  };

  const clearCart = () => {
    setCart([]);
    setDiscountPct(0);
    setPaid(false);
    setPaidMethod(null);
  };

  const subtotal = cart.reduce((s, l) => s + l.product.price * l.qty, 0);
  const discountAmount = (subtotal * discountPct) / 100;
  const afterDiscount = subtotal - discountAmount;
  const vatAmount = (afterDiscount * VAT_RATE) / 100;
  const grandTotal = afterDiscount + vatAmount;
  const itemCount = cart.reduce((n, l) => n + l.qty, 0);

  const pay = (method: string) => {
    if (cart.length === 0) return;
    setPaidMethod(method);
    setPaid(true);
  };

  const timeStr = new Intl.DateTimeFormat("ar-SA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(time);

  return (
    <div
      dir="rtl"
      className="min-h-screen w-full bg-background text-foreground flex flex-col"
    >
      {/* TOP BAR */}
      <header className="h-16 border-b border-border bg-card/80 backdrop-blur-xl px-4 lg:px-6 flex items-center justify-between gap-4 sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-chart-2 grid place-items-center shadow-lg shadow-primary/30 hover-elevate active-elevate-2"
          >
            <Store className="w-5 h-5 text-primary-foreground" strokeWidth={2.4} />
          </Link>
          <div className="hidden sm:block">
            <p className="text-sm font-extrabold leading-tight">
              زاكود <span className="text-primary">POS</span>
            </p>
            <p className="text-[10px] text-muted-foreground leading-tight">
              الفرع الرئيسي • الرياض
            </p>
          </div>
        </div>

        <div className="flex-1 max-w-xl">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث باسم المنتج أو الباركود..."
              className="h-11 pr-10 pl-12 text-sm font-medium rounded-xl"
            />
            <button
              type="button"
              title="مسح الباركود"
              className="absolute left-1.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg bg-muted text-foreground grid place-items-center hover-elevate active-elevate-2"
            >
              <ScanBarcode className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className={`hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-bold border ${
              online
                ? "bg-primary/10 text-primary border-primary/20"
                : "bg-destructive/10 text-destructive border-destructive/20"
            }`}
          >
            {online ? (
              <Wifi className="w-3 h-3" />
            ) : (
              <WifiOff className="w-3 h-3" />
            )}
            {online ? "متصل" : "دون اتصال"}
          </div>
          <div className="hidden lg:flex items-center gap-2 text-xs font-semibold text-muted-foreground font-mono px-2.5 py-1.5 rounded-full bg-muted">
            {timeStr}
          </div>
          <button className="w-10 h-10 rounded-xl border border-border bg-card grid place-items-center hover-elevate active-elevate-2">
            <UserIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => setMobileCartOpen(true)}
            className="lg:hidden relative w-10 h-10 rounded-xl border border-border bg-card grid place-items-center hover-elevate active-elevate-2"
          >
            <ShoppingBag className="w-4 h-4" />
            {itemCount > 0 && (
              <span className="absolute -top-1 -left-1 min-w-5 h-5 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-black grid place-items-center">
                {itemCount}
              </span>
            )}
          </button>
        </div>
      </header>

      <div className="flex-1 grid lg:grid-cols-[1fr_22rem] xl:grid-cols-[1fr_24rem] min-h-0">
        {/* LEFT — products */}
        <section className="flex flex-col min-h-0">
          {/* Categories */}
          <div className="px-4 lg:px-6 py-3 border-b border-border overflow-x-auto">
            <div className="flex items-center gap-2 min-w-max">
              {categories.map((c) => {
                const active = activeCat === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => setActiveCat(c.id)}
                    className={`flex items-center gap-2 px-4 h-11 rounded-xl border font-bold text-sm whitespace-nowrap transition-all hover-elevate active-elevate-2 ${
                      active
                        ? "bg-primary text-primary-foreground border-primary shadow-md shadow-primary/25"
                        : "bg-card border-border text-foreground"
                    }`}
                  >
                    <span className="text-base">{c.icon}</span>
                    {c.nameAr}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Products grid */}
          <div className="flex-1 overflow-y-auto p-4 lg:p-6">
            {filtered.length === 0 ? (
              <div className="h-full grid place-items-center text-center text-muted-foreground py-20">
                <div>
                  <div className="text-5xl mb-3">🔍</div>
                  <p className="font-bold">لا توجد منتجات مطابقة</p>
                  <p className="text-xs mt-1">جرّب كلمة بحث أخرى أو فئة مختلفة</p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
                {filtered.map((p) => {
                  const inCart = cart.find((l) => l.product.id === p.id);
                  return (
                    <motion.button
                      key={p.id}
                      layout
                      whileTap={{ scale: 0.97 }}
                      onClick={() => addToCart(p)}
                      className={`relative text-right rounded-2xl border bg-card p-3 hover-elevate active-elevate-2 transition-all ${
                        inCart ? "border-primary ring-2 ring-primary/20" : "border-card-border"
                      }`}
                    >
                      {inCart && (
                        <div className="absolute top-2 left-2 min-w-6 h-6 px-1.5 rounded-full bg-primary text-primary-foreground text-[11px] font-black grid place-items-center shadow">
                          {inCart.qty}
                        </div>
                      )}
                      <div className="aspect-square rounded-xl bg-gradient-to-br from-muted to-muted/30 grid place-items-center text-5xl mb-2">
                        {p.emoji}
                      </div>
                      <p className="font-bold text-sm leading-snug line-clamp-2 min-h-[2.5rem]">
                        {p.nameAr}
                      </p>
                      <div className="mt-2 flex items-baseline justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {p.sku}
                        </span>
                        <span className="text-base font-black text-primary">
                          {formatSAR(p.price)}
                          <span className="text-[10px] text-muted-foreground font-bold mr-0.5">
                            ر.س
                          </span>
                        </span>
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* RIGHT — cart panel (desktop) */}
        <aside className="hidden lg:flex flex-col border-r border-border bg-card/60 backdrop-blur-xl">
          <CartPanel
            cart={cart}
            updateQty={updateQty}
            removeLine={removeLine}
            clearCart={clearCart}
            subtotal={subtotal}
            discountPct={discountPct}
            setDiscountPct={setDiscountPct}
            discountAmount={discountAmount}
            vatAmount={vatAmount}
            grandTotal={grandTotal}
            itemCount={itemCount}
            pay={pay}
          />
        </aside>
      </div>

      {/* Mobile cart sheet */}
      <AnimatePresence>
        {mobileCartOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileCartOpen(false)}
              className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 250 }}
              className="fixed inset-y-0 right-0 w-full max-w-md bg-card z-50 flex flex-col lg:hidden"
            >
              <div className="h-14 px-4 border-b border-border flex items-center justify-between">
                <p className="font-extrabold">السلة</p>
                <button
                  onClick={() => setMobileCartOpen(false)}
                  className="w-9 h-9 rounded-lg grid place-items-center hover-elevate active-elevate-2"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <CartPanel
                cart={cart}
                updateQty={updateQty}
                removeLine={removeLine}
                clearCart={clearCart}
                subtotal={subtotal}
                discountPct={discountPct}
                setDiscountPct={setDiscountPct}
                discountAmount={discountAmount}
                vatAmount={vatAmount}
                grandTotal={grandTotal}
                itemCount={itemCount}
                pay={(m) => {
                  pay(m);
                  setMobileCartOpen(false);
                }}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Receipt modal */}
      <AnimatePresence>
        {paid && (
          <ReceiptModal
            method={paidMethod || ""}
            cart={cart}
            subtotal={subtotal}
            discountAmount={discountAmount}
            vatAmount={vatAmount}
            grandTotal={grandTotal}
            onClose={clearCart}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Cart Panel ---------- */

function CartPanel(props: {
  cart: CartLine[];
  updateQty: (id: string, delta: number) => void;
  removeLine: (id: string) => void;
  clearCart: () => void;
  subtotal: number;
  discountPct: number;
  setDiscountPct: (n: number) => void;
  discountAmount: number;
  vatAmount: number;
  grandTotal: number;
  itemCount: number;
  pay: (method: string) => void;
}) {
  const {
    cart,
    updateQty,
    removeLine,
    clearCart,
    subtotal,
    discountPct,
    setDiscountPct,
    discountAmount,
    vatAmount,
    grandTotal,
    itemCount,
    pay,
  } = props;

  return (
    <>
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <p className="text-sm font-extrabold">فاتورة جديدة</p>
          <p className="text-[11px] text-muted-foreground">
            #{Math.floor(Date.now() / 1000)
              .toString()
              .slice(-6)}
            • {itemCount} صنف
          </p>
        </div>
        <button className="px-2.5 h-8 rounded-lg border border-border bg-card text-xs font-bold inline-flex items-center gap-1 hover-elevate active-elevate-2">
          <UserIcon className="w-3 h-3" />
          عميل
        </button>
      </div>

      {/* Lines */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {cart.length === 0 ? (
          <div className="h-full grid place-items-center text-center text-muted-foreground p-6">
            <div>
              <div className="w-16 h-16 mx-auto rounded-2xl bg-muted grid place-items-center text-3xl mb-3">
                🛒
              </div>
              <p className="font-bold text-sm">السلة فارغة</p>
              <p className="text-xs mt-1">اضغط على المنتج لإضافته</p>
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {cart.map((l) => (
                <motion.li
                  key={l.product.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 30 }}
                  className="rounded-xl bg-card border border-border p-2.5 flex items-start gap-2.5"
                >
                  <div className="w-12 h-12 rounded-lg bg-muted grid place-items-center text-2xl shrink-0">
                    {l.product.emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold leading-tight line-clamp-1">
                      {l.product.nameAr}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {formatSAR(l.product.price)} ر.س / {l.product.unit}
                    </p>
                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
                        <button
                          onClick={() => updateQty(l.product.id, -1)}
                          className="w-7 h-7 rounded-md grid place-items-center hover-elevate active-elevate-2"
                          aria-label="إنقاص"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="min-w-7 text-center font-black text-sm">
                          {l.qty}
                        </span>
                        <button
                          onClick={() => updateQty(l.product.id, 1)}
                          className="w-7 h-7 rounded-md grid place-items-center hover-elevate active-elevate-2"
                          aria-label="زيادة"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <p className="text-sm font-black text-primary">
                        {formatSAR(l.product.price * l.qty)}
                        <span className="text-[10px] text-muted-foreground font-bold mr-0.5">
                          ر.س
                        </span>
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => removeLine(l.product.id)}
                    className="w-7 h-7 rounded-md grid place-items-center text-muted-foreground hover:text-destructive hover-elevate active-elevate-2"
                    aria-label="حذف"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>

      {/* Totals + Pay */}
      <div className="border-t border-border bg-gradient-to-b from-card to-muted/30 p-4 space-y-3">
        {/* Discount */}
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-1 bg-card border border-border rounded-xl px-2.5 py-1.5">
            <Percent className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground">خصم</span>
            <input
              type="number"
              min={0}
              max={100}
              value={discountPct || ""}
              onChange={(e) =>
                setDiscountPct(Math.max(0, Math.min(100, +e.target.value || 0)))
              }
              placeholder="0"
              className="flex-1 bg-transparent outline-none text-sm font-bold text-end"
            />
            <span className="text-xs text-muted-foreground">%</span>
          </div>
          <button
            onClick={() => clearCart()}
            disabled={cart.length === 0}
            className="px-3 h-9 rounded-xl border border-border bg-card text-xs font-bold inline-flex items-center gap-1 disabled:opacity-40 hover-elevate active-elevate-2"
            title="إفراغ السلة"
          >
            <Pause className="w-3.5 h-3.5" />
            تعليق
          </button>
        </div>

        {/* Totals */}
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">المجموع الفرعي</span>
            <span className="font-bold">{formatSAR(subtotal)} ر.س</span>
          </div>
          {discountPct > 0 && (
            <div className="flex items-center justify-between text-destructive">
              <span>الخصم ({discountPct}%)</span>
              <span className="font-bold">- {formatSAR(discountAmount)} ر.س</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">ضريبة القيمة المضافة 15%</span>
            <span className="font-bold">{formatSAR(vatAmount)} ر.س</span>
          </div>
          <div className="h-px bg-border my-2" />
          <div className="flex items-center justify-between">
            <span className="font-extrabold">الإجمالي</span>
            <span className="text-2xl font-black text-primary">
              {formatSAR(grandTotal)}
              <span className="text-sm text-muted-foreground font-bold mr-1">ر.س</span>
            </span>
          </div>
        </div>

        {/* Payment buttons */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <PayButton
            disabled={cart.length === 0}
            onClick={() => pay("cash")}
            icon={<Banknote className="w-4 h-4" />}
            label="نقداً"
          />
          <PayButton
            disabled={cart.length === 0}
            onClick={() => pay("card")}
            icon={<CreditCard className="w-4 h-4" />}
            label="شبكة"
          />
          <PayButton
            disabled={cart.length === 0}
            onClick={() => pay("apple")}
            icon={<Smartphone className="w-4 h-4" />}
            label="Apple Pay"
          />
          <PayButton
            disabled={cart.length === 0}
            onClick={() => pay("wallet")}
            icon={<Wallet className="w-4 h-4" />}
            label="محفظة"
          />
        </div>

        <Button
          disabled={cart.length === 0}
          onClick={() => pay("cash")}
          className="w-full h-13 py-3.5 text-base font-extrabold rounded-xl bg-gradient-to-l from-primary via-primary to-chart-2 text-primary-foreground pos-glow disabled:opacity-50 disabled:pos-glow-none"
        >
          <span className="inline-flex items-center gap-2">
            <Receipt className="w-5 h-5" />
            إتمام الدفع
            <ChevronLeft className="w-4 h-4" />
          </span>
        </Button>
      </div>
    </>
  );
}

function PayButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="h-11 rounded-xl border border-border bg-card font-bold text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-40 hover-elevate active-elevate-2"
    >
      {icon}
      {label}
    </button>
  );
}

/* ---------- Receipt Modal ---------- */

function ReceiptModal(props: {
  method: string;
  cart: CartLine[];
  subtotal: number;
  discountAmount: number;
  vatAmount: number;
  grandTotal: number;
  onClose: () => void;
}) {
  const { method, cart, subtotal, discountAmount, vatAmount, grandTotal, onClose } =
    props;
  const methodLabel: Record<string, string> = {
    cash: "نقداً",
    card: "شبكة",
    apple: "Apple Pay",
    wallet: "محفظة",
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm grid place-items-center p-4"
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ type: "spring", damping: 22, stiffness: 250 }}
        className="bg-card rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden border border-card-border"
      >
        <div className="bg-gradient-to-br from-primary to-chart-2 text-primary-foreground p-6 text-center relative overflow-hidden">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.15, type: "spring", damping: 15 }}
            className="w-16 h-16 mx-auto rounded-full bg-white/20 grid place-items-center mb-3 ring-4 ring-white/20"
          >
            <Check className="w-9 h-9" strokeWidth={3} />
          </motion.div>
          <p className="text-lg font-extrabold">تم الدفع بنجاح</p>
          <p className="text-sm opacity-90 mt-0.5">
            {methodLabel[method] || method}
          </p>
          <Sparkles className="absolute top-4 right-4 w-5 h-5 opacity-40" />
          <Sparkles className="absolute bottom-4 left-4 w-4 h-4 opacity-30" />
        </div>

        <div className="p-6 space-y-3">
          <div className="text-center">
            <p className="text-3xl font-black text-primary">
              {formatSAR(grandTotal)}
              <span className="text-base text-muted-foreground font-bold mr-1">ر.س</span>
            </p>
            <p className="text-[11px] text-muted-foreground mt-1 font-mono">
              فاتورة #{Math.floor(Date.now() / 1000).toString().slice(-8)}
            </p>
          </div>

          <div className="bg-muted/40 rounded-xl p-3 space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">عدد الأصناف</span>
              <span className="font-bold">
                {cart.reduce((n, l) => n + l.qty, 0)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">قبل الضريبة</span>
              <span className="font-bold">
                {formatSAR(subtotal - discountAmount)} ر.س
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">ض.ق.م 15%</span>
              <span className="font-bold">{formatSAR(vatAmount)} ر.س</span>
            </div>
          </div>

          {/* QR placeholder */}
          <div className="grid place-items-center py-2">
            <div className="w-32 h-32 bg-white border-4 border-foreground/10 rounded-xl grid place-items-center p-2">
              <div
                className="w-full h-full"
                style={{
                  backgroundImage:
                    "linear-gradient(45deg, #000 25%, transparent 25%), linear-gradient(-45deg, #000 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #000 75%), linear-gradient(-45deg, transparent 75%, #000 75%)",
                  backgroundSize: "8px 8px",
                  backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0px",
                }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground mt-2 font-mono">
              QR متوافق مع زاتكا
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              onClick={onClose}
              className="h-11 rounded-xl border border-border bg-card font-bold text-sm hover-elevate active-elevate-2"
            >
              فاتورة جديدة
            </button>
            <button
              onClick={onClose}
              className="h-11 rounded-xl bg-primary text-primary-foreground font-bold text-sm inline-flex items-center justify-center gap-1.5 hover-elevate active-elevate-2"
            >
              <Receipt className="w-4 h-4" />
              طباعة
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
