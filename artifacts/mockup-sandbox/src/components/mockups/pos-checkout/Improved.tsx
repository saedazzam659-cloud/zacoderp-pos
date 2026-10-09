import "./_group.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Banknote,
  Barcode,
  Check,
  ChevronLeft,
  CircleHelp,
  CreditCard,
  Minus,
  Pause,
  Percent,
  Plus,
  Receipt,
  Search,
  ShoppingBag,
  Smartphone,
  Store,
  Trash2,
  UserRound,
  Wallet,
  Wifi,
  X,
} from "lucide-react";

type Product = {
  id: number;
  name: string;
  code: string;
  price: number;
  category: string;
  tint: string;
};

type CartLine = Product & { qty: number };

const products: Product[] = [
  { id: 1, name: "محول الحسابات العامة", code: "200", price: 350, category: "حسابات", tint: "#dceee8" },
  { id: 2, name: "محول النقد والبنوك", code: "121211", price: 425, category: "حسابات", tint: "#e7e9d8" },
  { id: 3, name: "محول الموردين والمشتريات", code: "111111", price: 280, category: "مشتريات", tint: "#f5e9d6" },
  { id: 4, name: "محول العملاء والمبيعات", code: "111110", price: 310, category: "مبيعات", tint: "#deebed" },
  { id: 5, name: "محول المخازن", code: "100033", price: 195, category: "مخزون", tint: "#e9e5f0" },
  { id: 6, name: "صنف نهائي", code: "102", price: 95, category: "مخزون", tint: "#f2e5db" },
  { id: 7, name: "صنف تكلفة", code: "202", price: 150, category: "مصروفات", tint: "#e3ebdc" },
  { id: 8, name: "مجموعة أصناف", code: "305", price: 80, category: "مخزون", tint: "#e7e6d7" },
  { id: 9, name: "إيجار الرياض المتقدم", code: "442", price: 500, category: "خدمات", tint: "#efe2d7" },
  { id: 10, name: "مصروف مقدم", code: "501", price: 240, category: "مصروفات", tint: "#dce8e6" },
];

const initialCart: CartLine[] = [
  { ...products[0], qty: 1 },
  { ...products[1], qty: 2 },
  { ...products[2], qty: 1 },
  { ...products[3], qty: 1 },
  { ...products[4], qty: 1 },
];

const categories = ["الكل", "حسابات", "مبيعات", "مشتريات", "مخزون", "مصروفات", "خدمات"];
const formatSar = (value: number) =>
  new Intl.NumberFormat("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

const paymentMethods = [
  { id: "cash", label: "نقداً", Icon: Banknote, configured: true },
  { id: "card", label: "مدى / شبكة", Icon: CreditCard, configured: true },
  { id: "apple", label: "Apple Pay", Icon: Smartphone, configured: false },
  { id: "wallet", label: "محفظة", Icon: Wallet, configured: false },
];

export function Improved() {
  const [cart, setCart] = useState<CartLine[]>(initialCart);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("الكل");
  const [discount, setDiscount] = useState("0");
  const [selectedPayment, setSelectedPayment] = useState("cash");
  const [customerAdded, setCustomerAdded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return products.filter((product) => {
      const matchesCategory = activeCategory === "الكل" || product.category === activeCategory;
      const matchesSearch =
        !query ||
        product.name.toLocaleLowerCase().includes(query) ||
        product.code.toLocaleLowerCase().includes(query);
      return matchesCategory && matchesSearch;
    });
  }, [activeCategory, search]);

  const subtotal = cart.reduce((sum, line) => sum + line.price * line.qty, 0);
  const discountRate = Math.min(50, Math.max(0, Number(discount) || 0));
  const discountAmount = subtotal * (discountRate / 100);
  const taxable = subtotal - discountAmount;
  const vat = taxable * 0.15;
  const total = taxable + vat;
  const itemCount = cart.reduce((sum, line) => sum + line.qty, 0);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const showNotice = (message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 2600);
  };

  const addProduct = (product: Product) => {
    setCart((current) => {
      const exists = current.some((line) => line.id === product.id);
      return exists
        ? current.map((line) => line.id === product.id ? { ...line, qty: line.qty + 1 } : line)
        : [...current, { ...product, qty: 1 }];
    });
    showNotice(`أُضيف ${product.name} إلى الفاتورة`);
  };

  const changeQuantity = (productId: number, change: number) => {
    setCart((current) =>
      current
        .map((line) => line.id === productId ? { ...line, qty: line.qty + change } : line)
        .filter((line) => line.qty > 0),
    );
  };

  const removeLine = (line: CartLine) => {
    setCart((current) => current.filter((item) => item.id !== line.id));
    showNotice(`تم حذف ${line.name}`);
  };

  return (
    <main
      dir="rtl"
      className="flex h-[100dvh] min-h-[420px] w-full flex-col overflow-hidden text-[#183a35]"
      style={{ background: "#f1f5f1", fontFamily: "'Tajawal', 'Cairo', sans-serif" }}
    >
      <header className="z-10 flex h-[56px] shrink-0 items-center gap-3 border-b border-[#dce7e1] bg-[#fbfcf8] px-3 sm:px-5">
        <div className="flex min-w-[144px] items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#08796c] text-[#f7fbf7] shadow-[0_4px_12px_rgba(8,121,108,.19)]">
            <Store className="h-[18px] w-[18px]" strokeWidth={2.2} />
          </div>
          <div className="leading-none">
            <div className="text-[14px] font-extrabold tracking-[-.03em]">زاكود <span className="text-[#08796c]">POS</span></div>
            <div className="mt-1 text-[10px] font-medium text-[#71857d]">الفرع الرئيسي <span className="px-0.5 text-[#b5c4bc]">•</span> نقطة البيع ٠١</div>
          </div>
        </div>

        <label className="relative mx-auto flex h-[36px] w-full max-w-[400px] items-center rounded-xl border border-[#dce7e1] bg-[#f5f8f4] transition focus-within:border-[#69aa9b] focus-within:ring-2 focus-within:ring-[#08796c]/10">
          <Search className="mr-3 h-4 w-4 shrink-0 text-[#71857d]" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="ابحث باسم المنتج أو الباركود..."
            aria-label="ابحث باسم المنتج أو الباركود"
            className="h-full min-w-0 flex-1 bg-transparent px-2 text-[12px] font-medium outline-none placeholder:text-[#899a92]"
          />
          {search ? (
            <button onClick={() => setSearch("")} aria-label="مسح البحث" className="ml-2 grid h-7 w-7 place-items-center rounded-lg text-[#778980] hover:bg-white hover:text-[#183a35]">
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <span className="ml-2 flex h-6 items-center gap-1 rounded-md border border-[#dce7e1] bg-[#fbfcf8] px-1.5 text-[9px] font-semibold text-[#83948c]">
              <Barcode className="h-3 w-3" /> باركود
            </span>
          )}
        </label>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden h-7 items-center gap-1.5 rounded-full border border-[#cde4d8] bg-[#edf6ef] px-2.5 text-[10px] font-bold text-[#387b5d] sm:inline-flex">
            <Wifi className="h-3 w-3" /> متصل
          </span>
          <button
            onClick={() => showNotice("المستخدم: الكاشير سارة")}
            aria-label="معلومات المستخدم"
            className="grid h-9 w-9 place-items-center rounded-xl border border-[#dce7e1] bg-white text-[#587168] transition hover:border-[#95bbae] hover:text-[#08796c] focus-visible:outline-2 focus-visible:outline-[#08796c]"
          >
            <UserRound className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_390px]">
        <section className="flex min-h-0 flex-col">
          <div className="flex h-[47px] shrink-0 items-center gap-2 overflow-x-auto border-b border-[#dce7e1] px-3 sm:px-5">
            <span className="ml-1 shrink-0 text-[10px] font-bold text-[#81928a]">التصنيفات</span>
            {categories.map((category) => {
              const active = activeCategory === category;
              return (
                <button
                  key={category}
                  onClick={() => setActiveCategory(category)}
                  className={`h-[29px] shrink-0 rounded-lg px-3 text-[11px] font-bold transition focus-visible:outline-2 focus-visible:outline-[#08796c] ${
                    active
                      ? "bg-[#183f38] text-[#fbfcf8] shadow-[0_3px_8px_rgba(24,63,56,.15)]"
                      : "border border-[#dce7e1] bg-[#fbfcf8] text-[#60776e] hover:border-[#9dbdb1] hover:bg-white"
                  }`}
                >
                  {category}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5">
            <div className="mb-2.5 flex items-center justify-between">
              <div>
                <h1 className="text-[14px] font-extrabold tracking-[-.02em]">الأصناف</h1>
                <p className="mt-0.5 text-[10px] text-[#82928b]">اختر صنفاً لإضافته إلى الفاتورة</p>
              </div>
              <span className="rounded-md bg-[#e6eee8] px-2 py-1 text-[10px] font-bold text-[#557268]">{filteredProducts.length} صنف</span>
            </div>
            {filteredProducts.length ? (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
                {filteredProducts.map((product) => (
                  <button
                    key={product.id}
                    onClick={() => addProduct(product)}
                    className="group relative flex min-h-[98px] flex-col justify-between overflow-hidden rounded-xl border border-[#dce7e1] bg-[#fffefa] p-2.5 text-right shadow-[0_1px_2px_rgba(36,65,54,.03)] transition hover:-translate-y-0.5 hover:border-[#83b7a8] hover:shadow-[0_7px_18px_rgba(39,82,66,.09)] active:translate-y-0 focus-visible:outline-2 focus-visible:outline-[#08796c]"
                  >
                    <span className="absolute inset-x-0 top-0 h-[2px] bg-[#c6ddd3] transition group-hover:bg-[#08796c]" />
                    <span className="flex items-start justify-between gap-2">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[#396c5e]" style={{ background: product.tint }}>
                        <ShoppingBag className="h-[15px] w-[15px]" strokeWidth={1.9} />
                      </span>
                      <span className="mt-1 font-mono text-[9px] tracking-wide text-[#91a098]">{product.code}</span>
                    </span>
                    <span className="mt-2 line-clamp-2 min-h-[30px] text-[11px] font-bold leading-[1.45] text-[#284940]">{product.name}</span>
                    <span className="mt-1 flex items-center justify-between">
                      <span className="text-[9px] font-medium text-[#889a91]">{product.category}</span>
                      <span className="text-[12px] font-extrabold text-[#08796c]">{formatSar(product.price)} <small className="text-[9px] font-semibold text-[#81928a]">ر.س</small></span>
                    </span>
                    <span className="absolute bottom-2 left-2 grid h-5 w-5 place-items-center rounded-md bg-[#eef5ef] text-[#327f6c] opacity-0 transition group-hover:opacity-100">
                      <Plus className="h-3 w-3" />
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid min-h-[180px] place-items-center rounded-2xl border border-dashed border-[#cbdad2] bg-[#f8faf6] px-4 text-center">
                <div>
                  <Search className="mx-auto mb-2 h-5 w-5 text-[#87a197]" />
                  <p className="text-[12px] font-bold">لا توجد أصناف مطابقة</p>
                  <button onClick={() => { setSearch(""); setActiveCategory("الكل"); }} className="mt-1.5 text-[11px] font-bold text-[#08796c] hover:underline">مسح البحث والتصنيف</button>
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className="flex min-h-0 flex-col border-t border-[#d9e5de] bg-[#f8faf6] lg:border-r lg:border-t-0">
          <div className="flex h-[47px] shrink-0 items-center justify-between border-b border-[#dfe8e2] px-3.5">
            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-[#e5f0e9] text-[#277461]"><Receipt className="h-4 w-4" /></span>
              <div className="leading-tight">
                <p className="text-[12px] font-extrabold">فاتورة جديدة</p>
                <p className="mt-0.5 text-[10px] text-[#7a8e84]">{itemCount} وحدات <span className="px-0.5">·</span> اليوم، ١٠:٤٢ ص</p>
              </div>
            </div>
            <button
              onClick={() => { setCustomerAdded((value) => !value); showNotice(customerAdded ? "تم إزالة العميل من الفاتورة" : "تم اختيار العميل النقدي"); }}
              className={`flex h-[29px] items-center gap-1.5 rounded-lg border px-2.5 text-[10px] font-bold transition ${customerAdded ? "border-[#a8ccbb] bg-[#edf6ef] text-[#36745a]" : "border-[#dce7e1] bg-white text-[#60766d] hover:border-[#9ebcaf]"}`}
            >
              {customerAdded ? <Check className="h-3 w-3" /> : <UserRound className="h-3 w-3" />}
              {customerAdded ? "عميل نقدي" : "إضافة عميل"}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
            {cart.length ? (
              <ul className="space-y-1.5">
                {cart.map((line) => (
                  <li key={line.id} className="flex min-h-[66px] items-center gap-2 rounded-[11px] border border-[#e0e9e3] bg-[#fffefa] px-2 py-1.5">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] text-[#4d7769]" style={{ background: line.tint }}>
                      <ShoppingBag className="h-[14px] w-[14px]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <p className="truncate text-[11px] font-bold text-[#284940]">{line.name}</p>
                        <strong className="shrink-0 text-[11px] font-extrabold text-[#246b5b]">{formatSar(line.price * line.qty)} <small className="text-[8px] font-medium text-[#81928a]">ر.س</small></strong>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="text-[9px] text-[#84958c]">{formatSar(line.price)} ر.س / وحدة</span>
                        <span className="inline-flex h-[23px] items-center rounded-md border border-[#e0e9e3] bg-[#f6f8f4]">
                          <button onClick={() => changeQuantity(line.id, -1)} aria-label={`تقليل كمية ${line.name}`} className="grid h-[22px] w-[24px] place-items-center rounded-r-md text-[#647c71] transition hover:bg-[#e6efea] hover:text-[#08796c]">
                            <Minus className="h-3 w-3" />
                          </button>
                          <strong className="min-w-[22px] text-center text-[10px] font-bold">{line.qty}</strong>
                          <button onClick={() => changeQuantity(line.id, 1)} aria-label={`زيادة كمية ${line.name}`} className="grid h-[22px] w-[24px] place-items-center rounded-l-md text-[#647c71] transition hover:bg-[#e6efea] hover:text-[#08796c]">
                            <Plus className="h-3 w-3" />
                          </button>
                        </span>
                      </div>
                    </div>
                    <button onClick={() => removeLine(line)} aria-label={`حذف ${line.name}`} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[#9aa8a1] transition hover:bg-[#fbefeb] hover:text-[#bb604f]">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="grid h-full min-h-[100px] place-items-center rounded-xl border border-dashed border-[#cfddd5] text-center">
                <div>
                  <ShoppingBag className="mx-auto mb-1.5 h-5 w-5 text-[#89a398]" />
                  <p className="text-[11px] font-bold text-[#60766d]">الفاتورة فارغة</p>
                  <p className="mt-0.5 text-[9px] text-[#8a9a92]">اختر صنفاً من القائمة لإضافته</p>
                </div>
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-[#dce7e1] bg-[#fbfcf8] px-3 py-2">
            <div className="mb-1.5 flex items-center gap-1.5">
              <label className="flex h-[29px] min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-[#dce7e1] bg-white px-2">
                <Percent className="h-3.5 w-3.5 shrink-0 text-[#729084]" />
                <span className="shrink-0 text-[10px] font-bold text-[#667d73]">خصم</span>
                <input
                  value={discount}
                  onChange={(event) => setDiscount(event.target.value.replace(/[^\d]/g, "").slice(0, 2))}
                  onBlur={() => setDiscount(String(discountRate))}
                  aria-label="نسبة الخصم"
                  inputMode="numeric"
                  className="min-w-0 flex-1 bg-transparent text-left text-[11px] font-bold outline-none"
                />
                <span className="text-[10px] text-[#7f9288]">%</span>
              </label>
              <button
                onClick={() => { setPaused((value) => !value); showNotice(paused ? "تم استئناف الفاتورة" : "تم تعليق الفاتورة مؤقتاً"); }}
                className={`flex h-[29px] shrink-0 items-center gap-1 rounded-lg border px-2.5 text-[10px] font-bold transition ${paused ? "border-[#e5d1a9] bg-[#fbf3e3] text-[#8e6928]" : "border-[#dce7e1] bg-white text-[#687e74] hover:border-[#b5c8bd]"}`}
              >
                <Pause className="h-3 w-3" /> {paused ? "استئناف" : "تعليق"}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
              <span className="text-[#7d8e85]">المجموع الفرعي</span>
              <strong className="text-left font-bold">{formatSar(subtotal)} ر.س</strong>
              {discountRate > 0 && <><span className="text-[#7d8e85]">الخصم ({discountRate}٪)</span><strong className="text-left font-bold text-[#9b6548]">−{formatSar(discountAmount)} ر.س</strong></>}
              <span className="text-[#7d8e85]">ضريبة القيمة المضافة ١٥٪</span>
              <strong className="text-left font-bold">{formatSar(vat)} ر.س</strong>
            </div>

            <div className="my-1.5 h-px bg-[#e1e9e3]" />
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-extrabold">الإجمالي المستحق</span>
              <span className="rounded-lg bg-[#e7f2ec] px-2 py-0.5 text-[19px] font-black leading-none tracking-[-.03em] text-[#08796c]">
                {formatSar(total)} <small className="text-[10px] font-bold tracking-normal text-[#587e70]">ر.س</small>
              </span>
            </div>

            <div className="mb-1.5 grid grid-cols-2 gap-1.5">
              {paymentMethods.map(({ id, label, Icon, configured }) => {
                const selected = selectedPayment === id;
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={!configured}
                    title={configured ? `الدفع بواسطة ${label}` : "يتطلب تفعيل هذه الطريقة من إعدادات الدفع"}
                    onClick={() => {
                      setSelectedPayment(id);
                      showNotice(`طريقة الدفع المحددة: ${label}`);
                    }}
                    className={`flex h-[36px] min-w-0 items-center gap-2 rounded-lg border px-2 text-right transition focus-visible:outline-2 focus-visible:outline-[#08796c] ${
                      !configured
                        ? "cursor-not-allowed border-[#e5e9e5] bg-[#f5f6f2] text-[#a4aea8]"
                        : selected
                          ? "border-[#278a76] bg-[#edf6ef] text-[#176a58] shadow-[inset_0_0_0_1px_rgba(39,138,118,.1)]"
                          : "border-[#dce7e1] bg-white text-[#60776d] hover:border-[#9bbcae] hover:bg-[#f8fbf7]"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-[10px] font-extrabold">{label}</span>
                      <span className={`mt-0.5 block text-[8px] ${configured ? "text-[#809188]" : "text-[#a1aaa4]"}`}>
                        {configured ? (selected ? "محددة" : "جاهز") : "يتطلب الإعداد"}
                      </span>
                    </span>
                    {selected && configured && <Check className="h-3 w-3 shrink-0" />}
                    {!configured && <CircleHelp className="h-3 w-3 shrink-0" />}
                  </button>
                );
              })}
            </div>

            <button
              disabled={!cart.length}
              onClick={() => {
                const method = paymentMethods.find((item) => item.id === selectedPayment);
                if (method?.configured) showNotice(`الفاتورة جاهزة للتحصيل عبر ${method.label}`);
              }}
              className="flex h-[38px] w-full items-center justify-center gap-2 rounded-[10px] bg-[#08796c] text-[12px] font-extrabold text-white shadow-[0_4px_10px_rgba(8,121,108,.15)] transition hover:bg-[#07695e] active:translate-y-px disabled:cursor-not-allowed disabled:bg-[#a7bdb3]"
            >
              <Receipt className="h-4 w-4" /> إتمام الدفع <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          </div>
        </aside>
      </div>

      {notice && (
        <div role="status" className="fixed bottom-3 left-3 z-50 flex max-w-[min(360px,calc(100vw-24px))] items-center gap-2 rounded-xl border border-[#cfe0d5] bg-[#fffefa] px-3 py-2 text-[11px] font-bold text-[#315b4c] shadow-[0_8px_26px_rgba(28,61,48,.14)]">
          <Check className="h-4 w-4 shrink-0 text-[#16816d]" />
          <span className="truncate">{notice}</span>
          <button onClick={() => setNotice("")} aria-label="إغلاق التنبيه" className="mr-1 grid h-5 w-5 shrink-0 place-items-center rounded text-[#71857b] hover:bg-[#eff4ef]"><X className="h-3 w-3" /></button>
        </div>
      )}
    </main>
  );
}
