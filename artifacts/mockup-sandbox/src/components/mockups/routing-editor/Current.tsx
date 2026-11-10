import "./_group.css";
import { GitBranch, Plus, Search, Settings2, X } from "lucide-react";

const field =
  "h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 shadow-sm outline-none placeholder:text-slate-400";

export function Current() {
  return (
    <main
      dir="rtl"
      lang="ar"
      className="flex min-h-screen items-center justify-center bg-slate-900/25 p-4 font-sans text-foreground"
    >
      <section className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h1 className="text-lg font-bold text-slate-900">مسار إنتاج جديد</h1>
            <p className="mt-1 text-xs text-slate-500">إعداد مراحل المنتج وربطها بموارد الورشة.</p>
          </div>
          <button className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100" aria-label="إغلاق">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 overflow-y-auto p-5">
          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
              <span>المنتج المرتبط</span>
              <span className={`${field} flex items-center justify-between font-normal`}>
                <span className="text-slate-400">اختر المنتج...</span>
                <Search className="h-4 w-4 text-slate-400" />
              </span>
            </label>
            <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
              <span>اسم المسار</span>
              <span className={`${field} flex items-center font-normal text-slate-700`}>
                خط إنتاج المعجنات
              </span>
            </label>
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 pt-4">
            <h2 className="text-sm font-bold text-slate-800">مراحل الإنتاج بالترتيب</h2>
            <span className="text-xs text-slate-500">تظهر الأرقام ترتيب التنفيذ المقترح</span>
          </div>

          <article className="rounded-xl border border-violet-200 bg-violet-50/40 p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 place-items-center rounded-full border-2 border-violet-300 bg-violet-100 text-sm font-bold text-violet-800">
                  1
                </span>
                <div>
                  <span className="block text-[11px] font-bold text-slate-500">المرحلة 1</span>
                  <span className="text-sm font-semibold text-slate-800">الخلط والتشغيل</span>
                </div>
              </div>
              <button className="rounded-md p-2 text-rose-500 hover:bg-rose-50" aria-label="حذف المرحلة">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(140px,1fr)]">
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                <span>اسم المرحلة</span>
                <span className={field}>الخلط والتشغيل</span>
              </label>
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                <span>المدة المتوقعة (دقيقة)</span>
                <span className={`${field} text-left`} dir="ltr">45</span>
              </label>
            </div>

            <div className="mt-3 space-y-1.5">
              <label className="text-xs font-medium text-slate-600">مواد المرحلة</label>
              <div className="grid gap-1 rounded-md border border-slate-200 bg-white/80 p-2 sm:grid-cols-2">
                {["دقيق فاخر", "سكر أبيض", "زبدة طبيعية", "خميرة"].map((item, index) => (
                  <span key={item} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-700">
                    <span className={`grid h-4 w-4 place-items-center rounded border ${index < 2 ? "border-violet-600 bg-violet-600 text-white" : "border-slate-300 bg-white"}`}>
                      {index < 2 ? <span className="text-[10px]">✓</span> : null}
                    </span>
                    {item}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                <span>مركز العمل</span>
                <span className={`${field} flex items-center justify-between font-normal`}>
                  <span>خط المعجنات</span><span className="text-slate-400">⌄</span>
                </span>
              </label>
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                <span>موارد المرحلة</span>
                <span className={`${field} flex items-center justify-between font-normal`}>
                  <span>آلة + عمالة</span><span className="text-slate-400">⌄</span>
                </span>
              </label>
            </div>

            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-slate-600">آلة المرحلة</label>
                <button className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold text-violet-700 hover:bg-violet-50">
                  <Plus className="h-3.5 w-3.5" /> إضافة آلة وقدرة
                </button>
              </div>
              <span className={`${field} flex items-center justify-between font-normal`}>
                <span>خلاط صناعي M-04 — 7.5 kW</span><span className="text-slate-400">⌄</span>
              </span>
              <p className="text-[11px] leading-5 text-amber-800">
                قدرة الآلة المحفوظة: 7.5 kW. تُنسخ الآلة وقدرتها تلقائيًا إلى أمر التصنيع.
              </p>
              <button className="text-xs font-medium text-violet-700 hover:underline">
                إعداد قدرة هذه الآلة
              </button>
            </div>
          </article>

          <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <Plus className="h-4 w-4" /> إضافة مرحلة جديدة
          </button>
        </div>

        <footer className="border-t border-slate-100 bg-white p-4">
          <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm">
            <Settings2 className="h-4 w-4" /> حفظ المسار
          </button>
        </footer>
      </section>
    </main>
  );
}
