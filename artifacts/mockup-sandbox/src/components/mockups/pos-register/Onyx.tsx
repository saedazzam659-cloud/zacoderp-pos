import React, { useState, useEffect, act } from "react";
import {
  Search,
  Settings,
  Bell,
  User,
  Clock,
  LogOut,
  Plus,
  Minus,
  Trash2,
  Printer,
  Save,
  PauseCircle,
  FileText,
  CreditCard,
  Banknote,
  Monitor,
  PackageSearch,
  ShoppingCart,
  Zap,
  CarFront,
  PaintBucket,
  Wrench,
  Smartphone,
  Pill,
  ScanBarcode,
  SearchCode,
  Tag,
  Car,
  CircleDollarSign,
  ChevronDown,
  Icon
} from "lucide-react";

export function Onyx() {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const activities = [
    { id: "plumbing", name: "محلات السباكه", icon: Wrench },
    { id: "paint", name: "محلات الدهانات", icon: PaintBucket },
    { id: "auto-parts", name: "محلات قطع غيار السيارات", icon: CarFront },
    { id: "workshops", name: "ورش السيارات", icon: Car },
    { id: "mobile", name: "محلات الموبيلات", icon: Smartphone },
    { id: "pharmacy", name: "الصيدليات", icon: Pill },
  ];

  const activeActivity = "auto-parts";

  const categories = [
    "الكل",
    "فلاتر وزيوت",
    "فرامل",
    "كهرباء وإضاءة",
    "تكييف وتبريد",
    "عفشة",
  ];

  const products = [
    { id: 1, name: "فلتر زيت تايوتا أصلي", price: 35.0, unit: "قطعة" },
    { id: 2, name: "بوجيهات NGK ليزر إريديوم", price: 120.0, unit: "طقم" },
    { id: 3, name: "طقم فحمات فرامل سيراميك", price: 250.0, unit: "طقم" },
    { id: 4, name: "سير مكينة ياباني", price: 85.0, unit: "قطعة" },
    { id: 5, name: "مساحات زجاج بوش الأصلية", price: 45.0, unit: "طقم" },
    { id: 6, name: "بطارية هانكوك 70 أمبير", price: 380.0, unit: "قطعة" },
    { id: 7, name: "زيت محرك كاسترول 5W-30", price: 155.0, unit: "علبة" },
    { id: 8, name: "لمبة هالوجين أوسرام H7", price: 25.0, unit: "قطعة" },
    { id: 9, name: "فلتر هواء مكيف", price: 60.0, unit: "قطعة" },
    { id: 10, name: "ماء رديتر تويوتا أحمر", price: 55.0, unit: "لتر" },
    { id: 11, name: "حساس شكمان ياباني", price: 190.0, unit: "قطعة" },
    { id: 12, name: "طقم مساعدين KYB", price: 420.0, unit: "طقم" },
  ];

  const [cart, setCart] = useState([
    { id: 1, name: "زيت محرك كاسترول 5W-30", qty: 2, unit: "علبة", price: 155.0 },
    { id: 2, name: "فلتر زيت تايوتا أصلي", qty: 2, unit: "قطعة", price: 35.0 },
    { id: 3, name: "طقم فحمات فرامل سيراميك", qty: 1, unit: "طقم", price: 250.0 },
    { id: 4, name: "بطارية هانكوك 70 أمبير", qty: 1, unit: "قطعة", price: 380.0 },
    { id: 5, name: "سير مكينة ياباني", qty: 1, unit: "قطعة", price: 85.0 },
    { id: 6, name: "ماء رديتر تويوتا أحمر", qty: 3, unit: "لتر", price: 55.0 },
  ]);

  const updateQty = (id: number, delta: number) => {
    setCart(cart.map(item => {
      if (item.id === id) {
        const newQty = Math.max(1, item.qty + delta);
        return { ...item, qty: newQty };
      }
      return item;
    }));
  };

  const removeItem = (id: number) => {
    setCart(cart.filter(item => item.id !== id));
  };

  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
  const discount = 0;
  const vatRate = 0.15;
  const vat = (subtotal - discount) * vatRate;
  const total = subtotal - discount + vat;

  return (
    <div dir="rtl" className="flex flex-col h-screen bg-[#0a0a0a] text-slate-200 overflow-hidden font-sans selection:bg-orange-500/30">
      <style dangerouslySetInnerHTML={{__html: `
        @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&display=swap');
        div { font-family: 'Cairo', sans-serif; }
        
        /* Custom scrollbar for dark theme */
        ::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        ::-webkit-scrollbar-track {
          background: #111; 
        }
        ::-webkit-scrollbar-thumb {
          background: #333; 
          border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: #555; 
        }
      `}} />

      {/* HEADER */}
      <header className="flex items-center justify-between px-6 py-3 bg-[#111111] border-b border-zinc-800 shadow-sm z-10 shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center shadow-[0_0_15px_rgba(249,115,22,0.3)]">
              <Zap className="w-5 h-5 text-white" fill="currentColor" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight leading-none">مؤسسة أونيكس للسيارات</h1>
              <p className="text-xs text-orange-400 font-medium mt-1">فرع الرياض الرئيسي</p>
            </div>
          </div>
          
          <div className="h-8 w-px bg-zinc-800 mx-2"></div>
          
          <div className="flex items-center gap-2 bg-[#1a1a1a] px-3 py-1.5 rounded-lg border border-zinc-800">
            <Monitor className="w-4 h-4 text-zinc-400" />
            <span className="text-sm font-medium">كاشير 03</span>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 text-zinc-300 bg-[#1a1a1a] px-4 py-2 rounded-lg border border-zinc-800">
            <Clock className="w-4 h-4 text-orange-500" />
            <span className="text-sm font-semibold tracking-wider font-mono" dir="ltr">
              {currentTime.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>

          <div className="h-8 w-px bg-zinc-800"></div>

          <button className="flex items-center gap-3 bg-zinc-800/50 hover:bg-zinc-800 px-4 py-2 rounded-lg transition-colors border border-zinc-700">
            <div className="bg-zinc-700 p-1 rounded-md">
              <User className="w-4 h-4 text-zinc-300" />
            </div>
            <div className="text-right">
              <div className="text-sm font-bold text-white">عميل نقدي</div>
              <div className="text-[10px] text-zinc-400">اختيار عميل (F4)</div>
            </div>
            <ChevronDown className="w-4 h-4 text-zinc-500 mr-2" />
          </button>

          <div className="flex items-center gap-2">
            <button className="w-10 h-10 rounded-lg flex items-center justify-center bg-zinc-800/50 hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors border border-zinc-800">
              <Settings className="w-5 h-5" />
            </button>
            <button className="w-10 h-10 rounded-lg flex items-center justify-center bg-red-500/10 hover:bg-red-500/20 text-red-500 transition-colors border border-red-500/20">
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* ACTIVITIES CHIPS */}
      <div className="px-6 py-3 bg-[#0d0d0d] border-b border-zinc-800/60 overflow-x-auto shrink-0 hide-scrollbar flex items-center gap-3">
        {activities.map((act) => {
          const isActive = act.id === activeActivity;
          const Icon = act.icon;
          return (
            <button
              key={act.id}
              className={`flex items-center gap-2 px-4 py-2 rounded-full whitespace-nowrap transition-all duration-200 border ${
                isActive 
                ? 'bg-orange-500/10 border-orange-500/50 text-orange-400 shadow-[0_0_10px_rgba(249,115,22,0.1)]' 
                : 'bg-[#151515] border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-orange-500' : 'text-zinc-500'}`} />
              <span className="text-sm font-semibold">{act.name}</span>
            </button>
          );
        })}
      </div>

      {/* MAIN LAYOUT */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* LEFT REGION: PRODUCTS (FLEX-1) */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#0a0a0a]">
          {/* Categories */}
          <div className="p-4 shrink-0 flex items-center gap-2 overflow-x-auto hide-scrollbar">
            {categories.map((cat, idx) => (
              <button 
                key={idx}
                className={`px-5 py-2 rounded-lg text-sm font-bold whitespace-nowrap transition-colors border ${
                  idx === 0 
                  ? 'bg-zinc-100 text-zinc-900 border-zinc-200' 
                  : 'bg-[#151515] text-zinc-300 border-zinc-800 hover:border-zinc-600 hover:bg-[#1f1f1f]'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Product Grid */}
          <div className="flex-1 overflow-y-auto p-4 pt-0 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 align-content-start">
            {products.map((p) => (
              <button 
                key={p.id}
                className="group flex flex-col bg-[#131313] border border-zinc-800/80 hover:border-orange-500/50 rounded-xl overflow-hidden text-right transition-all duration-200 hover:shadow-[0_4px_20px_rgba(249,115,22,0.08)] hover:-translate-y-0.5"
              >
                <div className="p-4 flex-1">
                  <div className="flex justify-between items-start mb-2">
                    <div className="w-10 h-10 rounded-lg bg-zinc-800/50 flex items-center justify-center text-zinc-500 group-hover:text-orange-400 group-hover:bg-orange-500/10 transition-colors">
                      <PackageSearch className="w-5 h-5" />
                    </div>
                    <span className="text-xs font-medium text-zinc-500 bg-zinc-900 px-2 py-1 rounded border border-zinc-800">{p.unit}</span>
                  </div>
                  <h3 className="text-[15px] font-bold text-zinc-200 leading-tight mb-3 line-clamp-2">{p.name}</h3>
                </div>
                <div className="bg-[#0f0f0f] border-t border-zinc-800/50 px-4 py-3 flex items-center justify-between mt-auto group-hover:bg-[#1a110a] transition-colors">
                  <span className="text-xs text-zinc-400 group-hover:text-orange-300">السعر</span>
                  <div className="flex items-baseline gap-1 text-orange-500">
                    <span className="text-lg font-bold font-mono">{p.price.toFixed(2)}</span>
                    <span className="text-[10px] font-medium">ر.س</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* RIGHT REGION: INVOICE (W-400px - W-500px) */}
        <div className="w-[480px] bg-[#111111] border-r border-zinc-800 flex flex-col shrink-0 shadow-2xl relative z-20">
          
          {/* Fast Entry Row */}
          <div className="p-4 border-b border-zinc-800 bg-[#151515] shrink-0">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <ShoppingCart className="w-5 h-5 text-orange-500" />
                الفاتورة الحالية
              </h2>
              <span className="text-xs font-mono text-zinc-500 bg-zinc-900 px-2 py-1 rounded-md border border-zinc-800">#INV-290041</span>
            </div>
            
            <div className="flex gap-2">
              <div className="relative flex-1">
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                  <ScanBarcode className="h-5 w-5 text-orange-500" />
                </div>
                <input 
                  type="text" 
                  placeholder="باركود / بحث صنف (F2)"
                  className="w-full bg-[#0a0a0a] border border-zinc-700 text-white rounded-lg py-2.5 pr-10 pl-3 focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500 transition-all shadow-inner placeholder:text-zinc-600 text-sm font-medium"
                />
              </div>
              <input 
                type="number" 
                defaultValue={1}
                className="w-16 bg-[#0a0a0a] border border-zinc-700 text-white text-center rounded-lg py-2 focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500 font-mono font-bold"
              />
              <button className="bg-orange-500 hover:bg-orange-600 text-white p-2.5 rounded-lg transition-colors shadow-lg shadow-orange-500/20 flex items-center justify-center">
                <Plus className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Line Items Table */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Table Header */}
            <div className="flex items-center px-4 py-2 bg-[#0d0d0d] border-b border-zinc-800/80 text-[11px] font-bold text-zinc-400 shrink-0">
              <div className="w-[45%]">الصنف</div>
              <div className="w-[15%] text-center">الكمية</div>
              <div className="w-[12%] text-center">الوحدة</div>
              <div className="w-[13%] text-center">السعر</div>
              <div className="w-[15%] text-left">الإجمالي</div>
            </div>

            {/* Table Body */}
            <div className="flex-1 overflow-y-auto bg-[#111]">
              {cart.map((item, idx) => (
                <div 
                  key={item.id} 
                  className={`flex items-center px-4 py-3 border-b border-zinc-800/40 hover:bg-[#1a1a1a] transition-colors group ${idx % 2 === 0 ? 'bg-[#111]' : 'bg-[#131313]'}`}
                >
                  {/* (1) الصنف */}
                  <div className="w-[45%] pr-1">
                    <div className="text-sm font-bold text-zinc-200 line-clamp-2 leading-tight">{item.name}</div>
                  </div>
                  
                  {/* (2) الكمية */}
                  <div className="w-[15%] flex justify-center">
                    <div className="flex items-center bg-[#0a0a0a] border border-zinc-700 rounded-md overflow-hidden">
                      <button 
                        onClick={() => updateQty(item.id, -1)}
                        className="w-6 h-6 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <div className="w-6 text-center text-sm font-bold font-mono text-orange-400">
                        {item.qty}
                      </div>
                      <button 
                        onClick={() => updateQty(item.id, 1)}
                        className="w-6 h-6 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* (3) الوحدة */}
                  <div className="w-[12%] text-center text-xs font-medium text-zinc-500">
                    {item.unit}
                  </div>

                  {/* (4) السعر */}
                  <div className="w-[13%] text-center text-sm font-mono font-semibold text-zinc-300">
                    {item.price}
                  </div>

                  {/* (5) الإجمالي */}
                  <div className="w-[15%] text-left flex items-center justify-end gap-2">
                    <div className="text-[15px] font-bold font-mono text-white">
                      {(item.price * item.qty).toFixed(2)}
                    </div>
                    <button 
                      onClick={() => removeItem(item.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 text-red-500 hover:bg-red-500/20 rounded transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Totals Panel */}
          <div className="bg-[#151515] p-5 border-t border-zinc-800 shrink-0">
            <div className="space-y-2 mb-4">
              <div className="flex justify-between items-center text-sm">
                <span className="text-zinc-400 font-medium">الإجمالي قبل الضريبة</span>
                <span className="font-mono font-semibold text-zinc-200">{subtotal.toFixed(2)} ر.س</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-zinc-400 font-medium text-red-400/80">الخصم</span>
                <span className="font-mono font-semibold text-red-400/80">0.00 ر.س</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-zinc-400 font-medium">ضريبة القيمة المضافة (15%)</span>
                <span className="font-mono font-semibold text-zinc-200">{vat.toFixed(2)} ر.س</span>
              </div>
            </div>

            <div className="bg-gradient-to-r from-orange-500/10 to-transparent p-4 rounded-xl border border-orange-500/20 mb-5 flex justify-between items-center">
              <span className="text-lg font-black text-white">الإجمالي النهائي</span>
              <div className="flex items-baseline gap-1 text-orange-500">
                <span className="text-3xl font-black font-mono tracking-tight">{total.toFixed(2)}</span>
                <span className="text-sm font-bold">ر.س</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-5">
              <div className="bg-[#0a0a0a] border border-zinc-800 rounded-lg p-3">
                <div className="text-xs text-zinc-500 font-medium mb-1">المدفوع</div>
                <div className="text-lg font-bold font-mono text-zinc-200">0.00</div>
              </div>
              <div className="bg-[#0a0a0a] border border-zinc-800 rounded-lg p-3">
                <div className="text-xs text-zinc-500 font-medium mb-1">الباقي</div>
                <div className="text-lg font-bold font-mono text-zinc-200">{total.toFixed(2)}</div>
              </div>
            </div>

            {/* Payment Methods */}
            <div className="grid grid-cols-3 gap-2 mb-4">
              <button className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-lg border-2 border-orange-500 bg-orange-500/10 text-orange-500 hover:bg-orange-500 hover:text-white transition-all font-bold">
                <Banknote className="w-6 h-6" />
                <span className="text-sm">نقدي (F8)</span>
              </button>
              <button className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-lg border border-zinc-700 bg-[#111] text-zinc-300 hover:bg-zinc-800 hover:border-zinc-500 transition-all font-bold">
                <CreditCard className="w-6 h-6" />
                <span className="text-sm">شبكة (F9)</span>
              </button>
              <button className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-lg border border-zinc-700 bg-[#111] text-zinc-300 hover:bg-zinc-800 hover:border-zinc-500 transition-all font-bold">
                <CircleDollarSign className="w-6 h-6" />
                <span className="text-sm">آجل (F10)</span>
              </button>
            </div>

            {/* Actions */}
            <div className="grid grid-cols-4 gap-2">
              <button className="col-span-2 bg-orange-500 hover:bg-orange-600 text-white font-bold text-lg py-3 rounded-lg flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(249,115,22,0.4)] transition-all hover:scale-[1.02]">
                <Save className="w-5 h-5" />
                دفع وحفظ (End)
              </button>
              <button className="bg-[#111] hover:bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold text-sm py-3 rounded-lg flex flex-col items-center justify-center transition-all">
                <Printer className="w-4 h-4 mb-1" />
                <span>طباعة</span>
              </button>
              <button className="bg-[#111] hover:bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold text-sm py-3 rounded-lg flex flex-col items-center justify-center transition-all">
                <PauseCircle className="w-4 h-4 mb-1" />
                <span>تعليق</span>
              </button>
            </div>
            
          </div>
        </div>
      </div>
    </div>
  );
}
