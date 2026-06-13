import React, { useState, useEffect, act } from 'react';
import { 
  Search, Plus, Minus, Trash2, CreditCard, Banknote, Clock, Save, Printer, 
  FileText, User, ShoppingCart, CalendarClock, ChevronDown, 
  Wrench, Droplet, PaintBucket, Car, Smartphone, Pill, ScanLine, X, UserPlus
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

// --- Types ---
type Product = {
  id: string;
  name: string;
  price: number;
  unit: string;
  color: string;
  icon: React.ReactNode;
};

type CartItem = Product & {
  cartId: string;
  quantity: number;
};

// --- Sample Data ---
const ACTIVITIES = [
  { id: 'plumbing', name: 'محلات السباكه', icon: <Droplet className="w-4 h-4" /> },
  { id: 'paint', name: 'محلات الدهانات', icon: <PaintBucket className="w-4 h-4" /> },
  { id: 'autoparts', name: 'محلات قطع غيار السيارات', icon: <Wrench className="w-4 h-4" /> },
  { id: 'garage', name: 'ورش السيارات', icon: <Car className="w-4 h-4" /> },
  { id: 'mobile', name: 'محلات الموبيلات', icon: <Smartphone className="w-4 h-4" /> },
  { id: 'pharmacy', name: 'الصيدليات', icon: <Pill className="w-4 h-4" /> },
];

const CATEGORIES = ['الكل', 'أنابيب وتوصيلات', 'محابس وخلاطات', 'عوازل ولوازم', 'أدوات صحية'];

const PLUMBING_PRODUCTS: Product[] = [
  { id: 'p1', name: 'محبس نحاس 1/2 بوصة', price: 15.50, unit: 'قطعة', color: 'bg-teal-50', icon: <Wrench className="w-8 h-8 text-teal-600" /> },
  { id: 'p2', name: 'كوع PPR 20مم', price: 2.25, unit: 'قطعة', color: 'bg-emerald-50', icon: <Droplet className="w-8 h-8 text-emerald-600" /> },
  { id: 'p3', name: 'تيفلون أبيض أصلي', price: 1.50, unit: 'علبة', color: 'bg-blue-50', icon: <Wrench className="w-8 h-8 text-blue-600" /> },
  { id: 'p4', name: 'خرطوم مرن 60 سم', price: 12.00, unit: 'قطعة', color: 'bg-indigo-50', icon: <Wrench className="w-8 h-8 text-indigo-600" /> },
  { id: 'p5', name: 'صفاية مجلى ستيل', price: 25.00, unit: 'قطعة', color: 'bg-teal-50', icon: <Droplet className="w-8 h-8 text-teal-600" /> },
  { id: 'p6', name: 'سيفون كرسي ضغط', price: 45.00, unit: 'قطعة', color: 'bg-emerald-50', icon: <Wrench className="w-8 h-8 text-emerald-600" /> },
  { id: 'p7', name: 'شريط لحام قوي', price: 5.00, unit: 'حبة', color: 'bg-blue-50', icon: <Wrench className="w-8 h-8 text-blue-600" /> },
  { id: 'p8', name: 'خلاط مطبخ جداري', price: 120.00, unit: 'قطعة', color: 'bg-indigo-50', icon: <Droplet className="w-8 h-8 text-indigo-600" /> },
  { id: 'p9', name: 'ماسورة PVC 4 بوصة', price: 35.00, unit: 'متر', color: 'bg-teal-50', icon: <Wrench className="w-8 h-8 text-teal-600" /> },
  { id: 'p10', name: 'غراء مواسير حار', price: 18.00, unit: 'علبة', color: 'bg-emerald-50', icon: <Droplet className="w-8 h-8 text-emerald-600" /> },
  { id: 'p11', name: 'رداد مجاري 4 بوصة', price: 55.00, unit: 'قطعة', color: 'bg-blue-50', icon: <Wrench className="w-8 h-8 text-blue-600" /> },
  { id: 'p12', name: 'لي سخان إيطالي', price: 22.00, unit: 'قطعة', color: 'bg-indigo-50', icon: <Wrench className="w-8 h-8 text-indigo-600" /> },
];

const INITIAL_CART: CartItem[] = [
  { ...PLUMBING_PRODUCTS[0], cartId: 'c1', quantity: 4 },
  { ...PLUMBING_PRODUCTS[8], cartId: 'c2', quantity: 10 },
  { ...PLUMBING_PRODUCTS[2], cartId: 'c3', quantity: 5 },
  { ...PLUMBING_PRODUCTS[5], cartId: 'c4', quantity: 1 },
  { ...PLUMBING_PRODUCTS[1], cartId: 'c5', quantity: 20 },
  { ...PLUMBING_PRODUCTS[9], cartId: 'c6', quantity: 2 },
];

export function Aurora() {
  const [cart, setCart] = useState<CartItem[]>(INITIAL_CART);
  const [activeCategory, setActiveCategory] = useState('الكل');
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const addToCart = (product: Product) => {
    setCart(prev => {
      const existing = prev.find(item => item.id === product.id);
      if (existing) {
        return prev.map(item => item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      }
      return [{ ...product, cartId: Math.random().toString(), quantity: 1 }, ...prev];
    });
  };

  const updateQuantity = (cartId: string, delta: number) => {
    setCart(prev => prev.map(item => {
      if (item.cartId === cartId) {
        const newQ = Math.max(1, item.quantity + delta);
        return { ...item, quantity: newQ };
      }
      return item;
    }));
  };

  const removeItem = (cartId: string) => {
    setCart(prev => prev.filter(item => item.cartId !== cartId));
  };

  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const discount = 0;
  const vat = subtotal * 0.15;
  const total = subtotal - discount + vat;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@300;400;500;700;800&display=swap');
        .font-tajawal { font-family: 'Tajawal', sans-serif; }
        .aurora-glass {
          background: rgba(255, 255, 255, 0.7);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.5);
        }
        .aurora-gradient {
          background: linear-gradient(135deg, #f0fdfa 0%, #e0f2fe 100%);
        }
        /* Custom scrollbar for webkit */
        ::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: #cbd5e1;
          border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: #94a3b8;
        }
      `}</style>

      <div dir="rtl" className="font-tajawal flex flex-col h-screen w-full bg-slate-50 text-slate-800 overflow-hidden aurora-gradient">
        
        {/* TOP HEADER BAR */}
        <header className="flex-none h-16 aurora-glass border-b border-slate-200/60 shadow-sm flex items-center justify-between px-6 z-10">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-teal-600 flex items-center justify-center text-white shadow-md shadow-teal-600/20">
                <ShoppingCart className="w-5 h-5" />
              </div>
              <div>
                <h1 className="font-bold text-lg text-slate-800 leading-tight">مؤسسة الأفق المشرق للتجارة</h1>
                <p className="text-xs text-slate-500">فرع التخصصي · محطة #01</p>
              </div>
            </div>
            
            <Separator orientation="vertical" className="h-8" />
            
            <div className="flex flex-col">
              <span className="text-xs text-slate-500 flex items-center gap-1">
                <User className="w-3 h-3" /> الكاشير
              </span>
              <span className="text-sm font-semibold text-slate-700">أحمد عبدالله</span>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex flex-col items-end">
              <span className="text-sm font-bold text-slate-800 tracking-wider">
                {currentTime.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span className="text-xs text-slate-500 flex items-center gap-1">
                <CalendarClock className="w-3 h-3" /> {currentTime.toLocaleDateString('ar-SA')}
              </span>
            </div>
            
            <Button variant="outline" className="bg-white/80 border-slate-200 hover:bg-white rounded-full px-4 h-10 shadow-sm gap-2">
              <UserPlus className="w-4 h-4 text-teal-600" />
              <span className="font-medium">عميل نقدي</span>
              <ChevronDown className="w-4 h-4 text-slate-400" />
            </Button>
          </div>
        </header>

        {/* ACTIVITY CHIPS */}
        <div className="flex-none px-6 py-3 flex items-center gap-2 overflow-x-auto aurora-glass border-b border-white/50 z-10">
          {ACTIVITIES.map((act) => (
            <button
              key={act.id}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-all duration-200 whitespace-nowrap ${
                act.id === 'plumbing' 
                  ? 'bg-teal-600 text-white shadow-md shadow-teal-600/20' 
                  : 'bg-white/60 text-slate-600 hover:bg-white border border-slate-200/50 hover:shadow-sm'
              }`}
            >
              {act.icon}
              {act.name}
            </button>
          ))}
        </div>

        {/* MAIN LAYOUT */}
        <main className="flex-1 flex overflow-hidden p-4 gap-4">
          
          {/* LEFT REGION: PRODUCTS */}
          <section className="flex-1 flex flex-col overflow-hidden bg-white/40 backdrop-blur-md rounded-3xl border border-white/60 shadow-sm">
            <div className="flex-none p-4 flex items-center justify-between border-b border-slate-200/50">
              <div className="relative w-64">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input 
                  placeholder="بحث في المنتجات..." 
                  className="pr-9 bg-white/80 border-slate-200 focus-visible:ring-teal-500 rounded-2xl h-10 font-medium"
                />
              </div>
              <div className="flex gap-2 overflow-x-auto px-1">
                {CATEGORIES.map(cat => (
                  <Badge 
                    key={cat} 
                    variant={cat === activeCategory ? 'default' : 'secondary'}
                    className={`px-4 py-1.5 cursor-pointer rounded-xl text-sm ${
                      cat === activeCategory ? 'bg-slate-800 hover:bg-slate-700 text-white' : 'bg-white hover:bg-slate-100 text-slate-600 border border-slate-200'
                    }`}
                    onClick={() => setActiveCategory(cat)}
                  >
                    {cat}
                  </Badge>
                ))}
              </div>
            </div>

            <ScrollArea className="flex-1 p-4">
              <div className="grid grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4 pb-20">
                {PLUMBING_PRODUCTS.map(product => (
                  <button 
                    key={product.id}
                    onClick={() => addToCart(product)}
                    className="group relative flex flex-col bg-white rounded-2xl p-3 border border-slate-100 shadow-sm hover:shadow-md hover:border-teal-200 transition-all duration-200 text-right text-start active:scale-95"
                  >
                    <div className={`w-full aspect-square ${product.color} rounded-xl flex items-center justify-center mb-3 group-hover:scale-105 transition-transform duration-300`}>
                      {product.icon}
                    </div>
                    <h3 className="font-bold text-slate-800 leading-tight mb-1 text-sm">{product.name}</h3>
                    <div className="flex items-center justify-between mt-auto w-full pt-2">
                      <span className="text-teal-600 font-bold">{product.price.toFixed(2)} <span className="text-[10px] text-teal-600/70">ريال</span></span>
                      <span className="text-[10px] text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{product.unit}</span>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </section>

          {/* RIGHT REGION: INVOICE */}
          <section className="w-[450px] xl:w-[500px] flex-none flex flex-col bg-white rounded-3xl shadow-xl border border-slate-200/60 overflow-hidden relative">
            
            {/* Invoice Header */}
            <div className="flex-none p-4 bg-slate-800 text-white flex items-center justify-between">
              <div>
                <h2 className="font-bold text-lg">الفاتورة الحالية</h2>
                <p className="text-xs text-slate-300 mt-0.5">رقم: INV-2023-8942</p>
              </div>
              <div className="flex gap-2">
                <Button size="icon" variant="ghost" className="text-white hover:bg-slate-700 hover:text-white rounded-full h-9 w-9">
                  <ScanLine className="w-5 h-5" />
                </Button>
                <Button size="icon" variant="ghost" className="text-white hover:bg-slate-700 hover:text-white rounded-full h-9 w-9">
                  <FileText className="w-5 h-5" />
                </Button>
              </div>
            </div>

            {/* Fast Entry Row */}
            <div className="flex-none p-3 border-b border-slate-100 bg-slate-50/50 flex gap-2">
              <div className="relative flex-1">
                <ScanLine className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input placeholder="باركود أو اسم الصنف" className="pr-9 bg-white border-slate-200 h-10 font-medium" />
              </div>
              <Input type="number" defaultValue="1" className="w-16 bg-white border-slate-200 h-10 text-center font-bold" />
              <Button className="bg-teal-600 hover:bg-teal-700 text-white h-10 px-4 rounded-xl shadow-sm">
                إضافة
              </Button>
            </div>

            {/* Line Items Table Header */}
            <div className="flex-none px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center text-xs font-bold text-slate-500">
              <div className="flex-[3]">الصنف</div>
              <div className="w-20 text-center">الكمية</div>
              <div className="w-14 text-center">الوحدة</div>
              <div className="w-16 text-center">السعر</div>
              <div className="w-20 text-left">الإجمالي</div>
              <div className="w-8"></div>
            </div>

            {/* Line Items Table Body */}
            <ScrollArea className="flex-1 bg-white">
              <div className="flex flex-col">
                {cart.map((item, idx) => (
                  <div key={item.cartId} className={`flex items-center px-4 py-3 border-b border-slate-50 hover:bg-slate-50/80 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                    <div className="flex-[3] flex flex-col">
                      <span className="font-bold text-sm text-slate-800 line-clamp-2 leading-tight">{item.name}</span>
                    </div>
                    
                    <div className="w-20 flex items-center justify-center">
                      <div className="flex items-center bg-slate-100 rounded-lg border border-slate-200 p-0.5">
                        <button onClick={() => updateQuantity(item.cartId, -1)} className="p-1 hover:bg-white rounded-md text-slate-600 transition-colors">
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className="w-6 text-center font-bold text-sm text-teal-700">{item.quantity}</span>
                        <button onClick={() => updateQuantity(item.cartId, 1)} className="p-1 hover:bg-white rounded-md text-slate-600 transition-colors">
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    
                    <div className="w-14 text-center text-xs font-medium text-slate-500">{item.unit}</div>
                    
                    <div className="w-16 text-center font-semibold text-sm text-slate-700">{item.price.toFixed(2)}</div>
                    
                    <div className="w-20 text-left font-bold text-sm text-teal-700">{(item.price * item.quantity).toFixed(2)}</div>
                    
                    <div className="w-8 flex justify-end">
                      <button onClick={() => removeItem(item.cartId)} className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>

            {/* Totals Panel */}
            <div className="flex-none bg-slate-50 p-4 border-t border-slate-200">
              <div className="space-y-1.5 mb-4">
                <div className="flex justify-between text-sm text-slate-600">
                  <span>الإجمالي قبل الضريبة</span>
                  <span className="font-semibold">{subtotal.toFixed(2)} ريال</span>
                </div>
                <div className="flex justify-between text-sm text-slate-600">
                  <span>الخصم</span>
                  <span className="font-semibold text-red-500">{discount.toFixed(2)} ريال</span>
                </div>
                <div className="flex justify-between text-sm text-slate-600">
                  <span>ضريبة القيمة المضافة (15%)</span>
                  <span className="font-semibold">{vat.toFixed(2)} ريال</span>
                </div>
                <div className="pt-2 mt-2 border-t border-slate-200 border-dashed flex justify-between items-center">
                  <span className="font-bold text-lg text-slate-800">الإجمالي النهائي</span>
                  <span className="font-extrabold text-2xl text-teal-700">{total.toFixed(2)} <span className="text-sm text-teal-600/70 font-medium">ريال</span></span>
                </div>
              </div>

              {/* Payment Methods */}
              <div className="grid grid-cols-3 gap-2 mb-4">
                <Button variant="outline" className="h-12 bg-white border-slate-200 hover:border-teal-500 hover:text-teal-600 hover:bg-teal-50 flex flex-col gap-1 rounded-xl">
                  <Banknote className="w-4 h-4" />
                  <span className="text-xs font-bold">نقدي</span>
                </Button>
                <Button variant="outline" className="h-12 bg-teal-50 border-teal-200 text-teal-700 flex flex-col gap-1 rounded-xl ring-1 ring-teal-500 shadow-sm">
                  <CreditCard className="w-4 h-4" />
                  <span className="text-xs font-bold">شبكة</span>
                </Button>
                <Button variant="outline" className="h-12 bg-white border-slate-200 hover:border-teal-500 hover:text-teal-600 hover:bg-teal-50 flex flex-col gap-1 rounded-xl">
                  <Clock className="w-4 h-4" />
                  <span className="text-xs font-bold">آجل</span>
                </Button>
              </div>

              {/* Action Bar */}
              <div className="flex gap-2">
                <div className="grid grid-cols-2 gap-2 flex-1">
                  <Button variant="outline" className="h-12 bg-white rounded-xl text-slate-600 font-bold border-slate-200 hover:bg-slate-100">
                    <FileText className="w-4 h-4 ml-2" /> فاتورة جديدة
                  </Button>
                  <Button variant="outline" className="h-12 bg-white rounded-xl text-slate-600 font-bold border-slate-200 hover:bg-slate-100">
                    <Clock className="w-4 h-4 ml-2" /> تعليق
                  </Button>
                </div>
                <Button className="h-12 flex-[1.5] bg-teal-600 hover:bg-teal-700 text-white rounded-xl font-bold text-lg shadow-lg shadow-teal-600/30">
                  <Save className="w-5 h-5 ml-2" /> حفظ وطباعة
                </Button>
              </div>
            </div>

          </section>
        </main>
      </div>
    </>
  );
}
