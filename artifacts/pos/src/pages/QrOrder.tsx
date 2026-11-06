import { useMemo, useState } from "react";
import { useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle, ArrowDown, Check, ChefHat, Languages, Loader2, Minus, Plus,
  ShoppingBag, Trash2, Utensils, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import RestaurantModifierDialog, { type RestaurantModifierSelection } from "@/components/RestaurantModifierDialog";
import { api, type RMenuCategory, type RMenuItem } from "@/lib/api";
import { tr, usePosLanguage } from "@/lib/posLanguage";

type CartLine = {
  key: string;
  item: RMenuItem;
  qty: number;
  modifiers: RestaurantModifierSelection;
};

export default function QrOrderPage() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? "";
  const { language, setLanguage } = usePosLanguage();
  const isArabic = language === "ar";
  const dir = isArabic ? "rtl" : "ltr";
  const text = (ar: string, en: string) => tr(language, ar, en);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [modifierItem, setModifierItem] = useState<RMenuItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [confirmedOrder, setConfirmedOrder] = useState<string | null>(null);

  const menuQ = useQuery({
    queryKey: ["public-r-table-menu", token],
    queryFn: () => api.publicRTableMenu(token),
    enabled: Boolean(token),
    retry: 1,
  });
  const placeOrder = useMutation({
    mutationFn: () => api.publicRPlaceOrder(token, {
      items: cart.map(line => ({
        menuItemId: line.item.id,
        qty: line.qty,
        modifiers: line.modifiers,
      })),
    }),
    onSuccess: response => {
      setConfirmedOrder(response.orderNumber);
      setCart([]);
      setCartOpen(false);
    },
  });

  const categories = useMemo(
    () => (menuQ.data?.categories ?? []).filter(category => category.isActive)
      .sort((a, b) => a.displayOrder - b.displayOrder),
    [menuQ.data?.categories],
  );
  const items = useMemo(() => (menuQ.data?.items ?? []).filter(item =>
    item.isActive && item.showInPos !== false && (categoryId == null || item.categoryId === categoryId)),
  [menuQ.data?.items, categoryId]);
  const cartCount = cart.reduce((sum, line) => sum + line.qty, 0);
  const cartTotal = cart.reduce((sum, line) => sum + line.qty * getLinePrice(line), 0);
  const currency = useMemo(() => new Intl.NumberFormat(isArabic ? "ar-SA" : "en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }), [isArabic]);
  const money = (amount: number) => `${currency.format(amount)} ${text("ر.س", "SAR")}`;
  const itemName = (item: RMenuItem) => isArabic ? item.nameAr : item.nameEn || item.nameAr;
  const categoryName = (category: RMenuCategory) => isArabic ? category.nameAr : category.nameEn || category.nameAr;

  function getLinePrice(line: CartLine) {
    const extras = line.item.modifierGroups?.reduce((sum, group) => {
      const selected = new Set(line.modifiers.find(entry => entry.groupId === group.id)?.optionIds ?? []);
      return sum + group.options.reduce((groupSum, option) =>
        groupSum + (selected.has(option.id) ? Number(option.extraPrice) || 0 : 0), 0);
    }, 0) ?? 0;
    return (Number(line.item.price) || 0) + extras;
  }

  function addItem(item: RMenuItem, modifiers: RestaurantModifierSelection = []) {
    const key = `${item.id}:${modifiers.map(group => `${group.groupId}=${[...group.optionIds].sort().join(",")}`).sort().join(";")}`;
    setCart(current => {
      const existing = current.find(line => line.key === key);
      if (existing) return current.map(line => line.key === key ? { ...line, qty: line.qty + 1 } : line);
      return [...current, { key, item, qty: 1, modifiers }];
    });
    setModifierItem(null);
  }

  function changeQty(key: string, delta: number) {
    setCart(current => current.flatMap(line => {
      if (line.key !== key) return [line];
      const qty = line.qty + delta;
      return qty > 0 ? [{ ...line, qty }] : [];
    }));
  }

  const closeConfirmation = () => setConfirmedOrder(null);

  return (
    <div dir={dir} lang={language} className="min-h-[100dvh] bg-[#f5f4ed] text-[#173b36]">
      <header className="sticky top-0 z-20 border-b border-[#dce6dc] bg-[#f8f8f2]/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[#174b43] text-[#f2cf87]">
              <Utensils className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-black sm:text-lg">{text("قائمة الطعام", "The menu")}</p>
              <p className="truncate text-xs font-semibold text-[#647b70]" data-testid="text-qr-table-name">
                {menuQ.data?.table.nameAr ?? text("طلب الطاولة", "Table order")}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setLanguage(isArabic ? "en" : "ar")}
            className="h-10 shrink-0 rounded-xl border-[#d5e0d7] bg-[#fffef9] font-bold text-[#174b43]"
            aria-label={text("التبديل إلى الإنجليزية", "Switch to Arabic")} data-testid="button-qr-language">
            <Languages className="me-2 size-4" />{isArabic ? "EN" : "عربي"}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-28 pt-5 sm:px-6 sm:pt-8">
        {menuQ.isLoading ? (
          <div role="status" aria-label={text("جارٍ تحميل القائمة", "Loading menu")} className="space-y-6">
            <div className="h-36 animate-pulse rounded-[1.75rem] bg-[#e3e9dc]" />
            <div className="flex gap-2"><div className="h-10 w-24 animate-pulse rounded-full bg-[#e3e9dc]" /><div className="h-10 w-28 animate-pulse rounded-full bg-[#e3e9dc]" /></div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <div key={i} className="h-36 animate-pulse rounded-2xl bg-[#e3e9dc]" />)}</div>
          </div>
        ) : menuQ.isError ? (
          <section className="mx-auto mt-12 max-w-lg rounded-[1.75rem] border border-[#e8c6b9] bg-[#fffaf5] p-7 text-center" role="alert">
            <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[#f8e8df] text-[#a34b36]"><AlertCircle className="size-6" /></span>
            <h1 className="mt-4 text-xl font-black">{text("تعذّر فتح القائمة", "We couldn’t open the menu")}</h1>
            <p className="mt-2 text-sm leading-6 text-[#6e7770]">{text("تحقق من اتصالك وامسح رمز الطاولة مرة أخرى.", "Check your connection and scan the table code again.")}</p>
            <Button onClick={() => menuQ.refetch()} className="mt-5 rounded-xl bg-[#174b43] text-white hover:bg-[#103b35]" data-testid="button-qr-retry">
              {text("إعادة المحاولة", "Try again")}
            </Button>
          </section>
        ) : (
          <>
            <section className="relative mb-6 overflow-hidden rounded-[1.75rem] bg-[#174b43] px-5 py-6 text-[#fbf8ed] sm:px-8 sm:py-8">
              <div className="absolute -end-8 -top-12 size-48 rounded-full border-[1px] border-[#efcf8d]/20" />
              <div className="absolute -end-2 -top-6 size-32 rounded-full border-[1px] border-[#efcf8d]/15" />
              <div className="relative flex items-end justify-between gap-4">
                <div className="max-w-2xl">
                  <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[#e6c882]">
                    <ChefHat className="size-4" />{text("طازج من مطبخنا", "Fresh from our kitchen")}
                  </p>
                  <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-4xl">{text("وش تشتهي اليوم؟", "What sounds good today?")}</h1>
                  <p className="mt-2 max-w-lg text-sm leading-6 text-[#e4ece2]/80">
                    {text("اختر أطباقك وسنجهّزها لطاولتك. الدفع نقداً عند الاستلام.", "Choose your dishes and we’ll bring them to your table. Pay cash when you collect.")}
                  </p>
                </div>
                <div className="hidden size-20 shrink-0 rotate-3 items-center justify-center rounded-[1.6rem] border border-[#e6c882]/30 bg-[#f5e9c9]/10 text-[#e6c882] sm:flex">
                  <Utensils className="size-9" />
                </div>
              </div>
              <div className="relative mt-5 flex flex-wrap items-center gap-2 text-xs font-bold">
                <span className="rounded-full bg-[#e6c882] px-3 py-1.5 text-[#174b43]">{text("الطاولة", "Table")} · {menuQ.data?.table.nameAr}</span>
                <span className="rounded-full border border-white/20 px-3 py-1.5 text-[#f4f0e3]">{text("الدفع عند الاستلام", "Cash on collection")}</span>
              </div>
            </section>

            {items.length === 0 ? (
              <section className="rounded-[1.5rem] border border-dashed border-[#cbd8cc] bg-[#fffef9] px-6 py-14 text-center">
                <ShoppingBag className="mx-auto size-8 text-[#7f9a8d]" />
                <h2 className="mt-3 font-black">{text("لا توجد أصناف في هذه الفئة", "No items in this category")}</h2>
                <p className="mt-1 text-sm text-[#718078]">{text("اختر فئة أخرى أو عد لاحقاً.", "Choose another category or check back later.")}</p>
                {categoryId !== null && <Button variant="outline" onClick={() => setCategoryId(null)} className="mt-4 rounded-xl" data-testid="button-show-all-menu">{text("عرض القائمة كاملة", "Show full menu")}</Button>}
              </section>
            ) : (
              <>
                <nav className="mb-5 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0" aria-label={text("فئات القائمة", "Menu categories")}>
                  <button type="button" onClick={() => setCategoryId(null)} aria-pressed={categoryId === null}
                    className={`shrink-0 rounded-full px-4 py-2.5 text-sm font-extrabold transition ${categoryId === null ? "bg-[#174b43] text-white" : "border border-[#d8e2d7] bg-[#fffef9] text-[#587166]"}`}
                    data-testid="button-qr-category-all">{text("الكل", "All")}</button>
                  {categories.map(category => <button key={category.id} type="button" onClick={() => setCategoryId(category.id)} aria-pressed={categoryId === category.id}
                    className={`shrink-0 rounded-full px-4 py-2.5 text-sm font-extrabold transition ${categoryId === category.id ? "bg-[#174b43] text-white" : "border border-[#d8e2d7] bg-[#fffef9] text-[#587166]"}`}
                    data-testid={`button-qr-category-${category.id}`}>{categoryName(category)}</button>)}
                </nav>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((item, index) => (
                    <article key={item.id} className="group flex min-h-[145px] overflow-hidden rounded-[1.4rem] border border-[#dfe6db] bg-[#fffef9] shadow-[0_4px_16px_-12px_rgba(23,59,54,.28)] transition hover:border-[#adc4b2] hover:shadow-[0_10px_24px_-16px_rgba(23,59,54,.5)]"
                      data-testid={`card-qr-menu-item-${item.id}`}>
                      <div className="flex min-w-0 flex-1 flex-col p-4">
                        <div className="flex-1">
                          <h2 className="font-black leading-6">{itemName(item)}</h2>
                          {item.description && <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#728077]">{item.description}</p>}
                        </div>
                        <div className="mt-4 flex items-center justify-between gap-2">
                          <span className="font-mono text-sm font-black text-[#a66d28]" data-testid={`text-qr-item-price-${item.id}`}>{money(Number(item.price) || 0)}</span>
                          <button type="button" onClick={() => item.modifierGroups?.length ? setModifierItem(item) : addItem(item)}
                            aria-label={`${text("إضافة", "Add")} ${itemName(item)}`}
                            className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#eaf0e6] text-[#174b43] transition hover:bg-[#174b43] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#174b43]"
                            data-testid={`button-add-qr-item-${item.id}`}><Plus className="size-5" /></button>
                        </div>
                      </div>
                      <div className="relative w-[88px] shrink-0 overflow-hidden bg-[#e8eee3] sm:w-[104px]">
                        {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-full w-full object-cover" loading={index < 3 ? "eager" : "lazy"} />
                          : <div className="grid h-full place-items-center text-[#8da194]"><Utensils className="size-7" /></div>}
                      </div>
                    </article>
                  ))}
                </div>
                {(menuQ.data?.items ?? []).length === 0 && (
                  <section className="mt-6 rounded-[1.5rem] border border-dashed border-[#cbd8cc] bg-[#fffef9] px-6 py-14 text-center">
                    <ShoppingBag className="mx-auto size-8 text-[#7f9a8d]" />
                    <h2 className="mt-3 font-black">{text("القائمة غير متاحة حالياً", "The menu is not available right now")}</h2>
                    <p className="mt-1 text-sm text-[#718078]">{text("يرجى سؤال فريق المطعم للمساعدة.", "Please ask the restaurant team for help.")}</p>
                  </section>
                )}
              </>
            )}

            <aside className="mt-10 hidden rounded-[1.5rem] border border-[#dce5da] bg-[#fffef9] p-5 text-sm md:block">
              <p className="flex items-center gap-2 font-extrabold"><Check className="size-4 text-[#31715c]" />{text("طلبك آمن وواضح", "Your order is clear and secure")}</p>
              <p className="mt-1 ps-6 text-[#718078]">{text("لن نطلب بيانات بطاقتك. ادفع نقداً عند استلام طلبك.", "We won’t ask for card details. Pay cash when you collect your order.")}</p>
            </aside>
          </>
        )}
      </main>

      {cartCount > 0 && !confirmedOrder && (
        <>
          <aside className="sticky bottom-0 z-20 mx-auto hidden max-w-6xl px-6 pb-5 md:block">
            <div className="flex items-center justify-between gap-4 rounded-2xl bg-[#174b43] px-5 py-4 text-white shadow-[0_12px_32px_-12px_rgba(18,59,51,.6)]">
              <div><p className="text-sm font-bold text-white/75">{cartCount} {text("أصناف", "items")}</p><p className="text-lg font-black">{money(cartTotal)}</p></div>
              <Button onClick={() => setCartOpen(true)} className="h-12 rounded-xl bg-[#e6c882] px-6 font-black text-[#173b36] hover:bg-[#f0d99f]" data-testid="button-open-cart">
                {text("مراجعة الطلب", "Review order")}<ArrowDown className="ms-2 size-4" />
              </Button>
            </div>
          </aside>
          <button type="button" onClick={() => setCartOpen(true)} data-testid="button-mobile-open-cart"
            className="fixed inset-x-3 bottom-3 z-30 flex min-h-14 items-center justify-between rounded-2xl bg-[#174b43] px-4 text-white shadow-[0_12px_32px_-12px_rgba(18,59,51,.65)] md:hidden">
            <span className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-white/10"><ShoppingBag className="size-4" /></span><span className="text-start"><span className="block text-xs font-bold text-white/75">{cartCount} {text("أصناف", "items")}</span><span className="block font-black">{text("عرض الطلب", "View order")}</span></span></span>
            <span className="font-mono text-sm font-black">{money(cartTotal)}</span>
          </button>
        </>
      )}

      <Dialog open={cartOpen} onOpenChange={setCartOpen}>
        <DialogContent dir={dir} lang={language} className="max-h-[90dvh] w-[calc(100%-1rem)] max-w-lg overflow-hidden rounded-[1.5rem] border-[#dce5da] bg-[#fffef9] p-0">
          <DialogHeader className="border-b border-[#e5e9df] px-5 py-4 text-start">
            <DialogTitle className="text-xl font-black">{text("مراجعة الطلب", "Review your order")}</DialogTitle>
            <DialogDescription>{text("تأكد من اختياراتك قبل الإرسال.", "Check your choices before placing the order.")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[48dvh] space-y-3 overflow-y-auto p-4">
            {cart.length === 0 ? <p className="py-8 text-center text-sm text-[#718078]">{text("سلتك فارغة.", "Your cart is empty.")}</p> : cart.map(line => (
              <div key={line.key} className="rounded-2xl border border-[#e2e8de] bg-white p-3" data-testid={`row-cart-item-${line.item.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="font-black">{itemName(line.item)}</p>
                    {line.modifiers.map(group => {
                      const labels = line.item.modifierGroups?.find(entry => entry.id === group.groupId)?.options
                        .filter(option => group.optionIds.includes(option.id))
                        .map(option => isArabic ? option.nameAr : option.nameEn || option.nameAr) ?? [];
                      return <p key={group.groupId} className="mt-1 text-xs text-[#718078]">{labels.join("، ")}</p>;
                    })}
                  </div>
                  <span className="shrink-0 text-sm font-black">{money(line.qty * getLinePrice(line))}</span>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <button type="button" onClick={() => setCart(current => current.filter(entry => entry.key !== line.key))}
                    className="flex items-center gap-1 text-xs font-bold text-[#a34b36]" data-testid={`button-remove-cart-item-${line.item.id}`}><Trash2 className="size-3.5" />{text("إزالة", "Remove")}</button>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => changeQty(line.key, -1)} aria-label={text("تقليل الكمية", "Decrease quantity")} className="grid size-8 place-items-center rounded-lg border border-[#dce5da]" data-testid={`button-cart-qty-minus-${line.item.id}`}><Minus className="size-4" /></button>
                    <span className="min-w-4 text-center font-black" data-testid={`text-cart-qty-${line.item.id}`}>{line.qty}</span>
                    <button type="button" onClick={() => changeQty(line.key, 1)} aria-label={text("زيادة الكمية", "Increase quantity")} className="grid size-8 place-items-center rounded-lg border border-[#dce5da]" data-testid={`button-cart-qty-plus-${line.item.id}`}><Plus className="size-4" /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-[#e5e9df] bg-[#f7f8f1] p-4">
            <div className="mb-3 flex items-center justify-between"><span className="font-bold text-[#64766b]">{text("الإجمالي التقديري", "Estimated total")}</span><span className="text-lg font-black" data-testid="text-cart-total">{money(cartTotal)}</span></div>
            <p className="mb-3 rounded-xl bg-[#e9f0e6] px-3 py-2 text-xs leading-5 text-[#456554]">{text("الدفع نقداً عند استلام الطلب. لن يتم تحصيل أي مبلغ الآن.", "Pay cash when you collect. No payment is taken now.")}</p>
            {placeOrder.isError && <p role="alert" className="mb-3 text-sm font-semibold text-[#a34b36]">{placeOrder.error instanceof Error ? placeOrder.error.message : text("تعذّر إرسال الطلب.", "Could not place the order.")}</p>}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setCartOpen(false)} className="h-12 flex-1 rounded-xl" disabled={placeOrder.isPending} data-testid="button-continue-menu">{text("متابعة القائمة", "Keep browsing")}</Button>
              <Button onClick={() => placeOrder.mutate()} disabled={cart.length === 0 || placeOrder.isPending} className="h-12 flex-1 rounded-xl bg-[#174b43] font-black text-white hover:bg-[#103b35]" data-testid="button-place-qr-order">
                {placeOrder.isPending ? <Loader2 className="me-2 size-4 animate-spin" /> : <Check className="me-2 size-4" />}{text("إرسال الطلب", "Place order")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <RestaurantModifierDialog
        open={Boolean(modifierItem)}
        onOpenChange={open => { if (!open) setModifierItem(null); }}
        item={modifierItem ?? { id: 0, nameAr: "", price: "0" }}
        groups={modifierItem?.modifierGroups ?? []}
        language={language}
        onConfirm={selection => modifierItem && addItem(modifierItem, selection)}
        confirmLabel={text("إضافة إلى الطلب", "Add to order")}
      />

      <Dialog open={Boolean(confirmedOrder)} onOpenChange={open => { if (!open) closeConfirmation(); }}>
        <DialogContent dir={dir} lang={language} className="w-[calc(100%-2rem)] max-w-md rounded-[1.75rem] border-[#dce5da] bg-[#fffef9] p-7 text-center">
          <DialogHeader>
            <span className="mx-auto mb-2 grid size-16 place-items-center rounded-2xl bg-[#e9f0e6] text-[#31715c]"><Check className="size-8" /></span>
            <DialogTitle className="text-2xl font-black">{text("تم استلام طلبك", "Order received")}</DialogTitle>
            <DialogDescription>{text("وصل طلبك إلى الموظف للمراجعة والتأكيد. الدفع نقداً عند الاستلام.", "Your order is waiting for staff review and confirmation. Pay cash when you collect.")}</DialogDescription>
          </DialogHeader>
          <div className="my-5 rounded-2xl bg-[#f2f4ec] px-4 py-4">
            <p className="text-xs font-bold text-[#748176]">{text("رقم الطلب", "Order number")}</p>
            <p className="mt-1 font-mono text-2xl font-black text-[#174b43]" data-testid="text-confirmed-order-number">{confirmedOrder}</p>
          </div>
          <Button onClick={closeConfirmation} className="h-12 w-full rounded-xl bg-[#174b43] font-black text-white hover:bg-[#103b35]" data-testid="button-close-order-confirmation">
            {text("العودة إلى القائمة", "Back to menu")}<X className="ms-2 size-4" />
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
